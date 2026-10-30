import {
  canonicalSerialize,
  hashCanonical,
} from "../domain/identity/canonical-serialization.js";
import { domainError } from "../domain/shared/errors.js";
import { fail, ok, type Result } from "../domain/shared/result.js";
import type { HistoryAccountingScope } from "../domain/accounting/accounting-scope.js";
import type { UtcTimestamp } from "../domain/shared/time.js";
import type { HistoryAccountingWalletAnchor } from "../ports/history-accounting-anchor-store.js";
import type {
  HistoryConflictSummary,
  HistoryCheckpoint,
  HistoryStoreScope,
  HistoryStoredObservation,
} from "../ports/history-store.js";
import type { OperatorMainnetTestSnapshot } from "../ports/operator-mainnet-test-persistence.js";
import type { HistoryAccountingReportRecord } from "../ports/history-accounting-report-store.js";
import type { PreparedLegRunSnapshot } from "../ports/persistence.js";
import { HISTORY_READ_SOURCES } from "../ports/history-read.js";
import {
  attributeHistoryObservations,
  type HistoryAttributionProjection,
} from "./history-attribution.js";
import { indexHistoryObservationsByIdentity } from "./history-accounting-normalization.js";
import {
  projectHistoryAccountingEpoch,
  type HistoryAccountingEpochProjection,
  type HistoryAccountingEpochProjectionV2,
} from "./history-accounting-epoch.js";
import {
  projectHistoryAccountingPerformance,
  type HistoryAccountingPerformanceProjection,
  type HistoryPositionUplEvidence,
  type VerifiedSettlementCurrency,
} from "./history-accounting-performance.js";
import {
  normalizeHistoryTransaction,
  selectCanonicalHistoryEvidence,
  type CanonicalHistoryEvidence,
  type NormalizedHistoryTransaction,
} from "./history-accounting-normalization.js";
import {
  failure,
  recordWithKeys,
  isNullableString,
  isTimestamp,
  isNullableDecimal,
  isStringArray,
  isScope,
  sameScopeValue,
  isCurrencyBridge,
  isPerformanceProjection,
  overlapsRange,
} from "./history-accounting-report-common.js";
import {
  createScopedHistoryAccountingReport,
  decodeScopedHistoryAccountingReport,
  isScopedReportDomainValue,
} from "./history-accounting-report-v2.js";

export interface HistoryAccountingReportTransaction extends NormalizedHistoryTransaction {
  readonly providerEventTime: UtcTimestamp;
  readonly transactionType: string | null;
  readonly transactionSubType: string | null;
}

export interface HistoryAccountingReconciliationReportV1 {
  readonly schemaVersion: "history-accounting-reconciliation-report/v1";
  readonly reportId: string;
  readonly scope: HistoryStoreScope;
  readonly evaluatedAt: UtcTimestamp;
  readonly status: "ACCOUNTING_READY" | "NOT_READY";
  readonly dependencyHash: string;
  readonly contentHash: string;
  readonly epoch: HistoryAccountingEpochProjection;
  readonly performance: HistoryAccountingPerformanceProjection;
  readonly transactions: readonly HistoryAccountingReportTransaction[];
  readonly accountUnrealizedPnlUsd: {
    readonly asOf: UtcTimestamp;
    readonly amount: string | null;
    readonly status: "known" | "unknown";
    readonly allocation: "account-wide-unallocated";
  };
  readonly preEpochHistory: "UNKNOWN";
}

export interface HistoryAccountingCoverageWitness {
  readonly source: (typeof HISTORY_READ_SOURCES)[number];
  readonly requiredWindow: { readonly fromMs: number; readonly toMs: number };
  readonly normalizedQueryFilterIdentity: string;
  readonly mergedCoveredIntervals: readonly {
    readonly fromMs: number;
    readonly toMs: number;
  }[];
  readonly terminalComplete: boolean;
  readonly conflictLocationsValid: boolean;
  readonly relevantConflicts: readonly {
    readonly conflictId: string;
    readonly source: string;
    readonly eventIdentity: string;
    readonly existingHash: string;
    readonly incomingHash: string;
    readonly reason: string;
  }[];
}

export interface HistoryAccountingReportDependenciesV2 {
  readonly schemaVersion: "history-accounting-dependencies/v2";
  readonly scope: HistoryStoreScope;
  readonly accountingScope: HistoryAccountingScope;
  readonly accountingScopeHash: string;
  readonly epoch: HistoryAccountingEpochProjectionV2["epoch"];
  readonly anchors: {
    readonly opening: {
      readonly anchorId: string;
      readonly contentHash: string;
    };
    readonly closing: {
      readonly anchorId: string;
      readonly contentHash: string;
    };
  };
  readonly sourceDependencies: readonly {
    readonly observationId: string;
    readonly source: string;
    readonly eventIdentity: string;
    readonly contentHash: string;
  }[];
  readonly coverageWitness: readonly HistoryAccountingCoverageWitness[];
  readonly conflictDependencies: readonly unknown[];
  readonly lineageDependencies: readonly {
    readonly sourceKind: "operator-mainnet-test" | "prepared-leg";
    readonly sourceId: string;
    readonly contentHash: string;
  }[];
  readonly settlementCurrencyBySymbol: Readonly<
    Record<string, VerifiedSettlementCurrency>
  >;
  readonly positionUplEvidence: HistoryPositionUplEvidence | null;
  readonly performanceSelectionConflicts: readonly unknown[];
}

export interface HistoryAccountingReconciliationReportV2 {
  readonly schemaVersion: "history-accounting-reconciliation-report/v2";
  readonly reportId: string;
  readonly scope: HistoryStoreScope;
  readonly accountingScope: HistoryAccountingScope;
  readonly accountingScopeHash: string;
  readonly evaluatedAt: UtcTimestamp;
  readonly status: "ACCOUNTING_READY" | "NOT_READY";
  readonly dependencyHash: string;
  readonly contentHash: string;
  readonly dependencies: HistoryAccountingReportDependenciesV2;
  readonly epoch: HistoryAccountingEpochProjectionV2;
  readonly performance: HistoryAccountingPerformanceProjection;
  readonly transactions: readonly HistoryAccountingReportTransaction[];
  readonly accountUnrealizedPnlUsd: {
    readonly asOf: UtcTimestamp;
    readonly amount: string | null;
    readonly status: "known" | "unknown";
    readonly allocation: "account-wide-unallocated";
  };
  readonly preEpochHistory: "UNKNOWN";
}

export type HistoryAccountingReconciliationReport =
  | HistoryAccountingReconciliationReportV1
  | HistoryAccountingReconciliationReportV2;

export interface CreateHistoryAccountingReportInput {
  readonly scope: HistoryStoreScope;
  readonly opening: HistoryAccountingWalletAnchor;
  readonly closing: HistoryAccountingWalletAnchor;
  readonly observations: readonly HistoryStoredObservation[];
  readonly conflicts: readonly HistoryConflictSummary[];
  readonly coverage: readonly HistoryCheckpoint[];
  readonly operatorSources: readonly OperatorMainnetTestSnapshot[];
  readonly preparedSources: readonly PreparedLegRunSnapshot[];
  readonly settlementCurrencyBySymbol?: Readonly<
    Record<string, VerifiedSettlementCurrency>
  >;
  readonly positionUplEvidence?: HistoryPositionUplEvidence;
  /** Selecting a known policy opts into the explicitly scoped v2 contract. */
  readonly accountingScope?: HistoryAccountingScope;
}

export interface HistoryAccountingReportDependencies {
  readonly sourceDependencies: readonly {
    readonly observationId: string;
    readonly source: string;
    readonly eventIdentity: string;
    readonly contentHash: string;
    readonly canonicalHash: string;
  }[];
  readonly coverageDependencies: readonly unknown[];
  readonly conflictDependencies: readonly unknown[];
  readonly lineageDependencies: readonly {
    readonly sourceKind: "operator-mainnet-test" | "prepared-leg";
    readonly sourceId: string;
    readonly contentHash: string;
  }[];
}

export function encodeHistoryAccountingReport(
  report: HistoryAccountingReconciliationReport,
): Result<HistoryAccountingReportRecord> {
  if (
    report.schemaVersion === "history-accounting-reconciliation-report/v2" &&
    !isScopedReportDomainValue(report)
  )
    return failure("scoped history accounting report is invalid");
  const canonicalJson = canonicalSerialize(report);
  if (!canonicalJson.ok) return canonicalJson;
  return ok({
    reportId: report.reportId,
    scope: report.scope,
    evaluatedAt: report.evaluatedAt,
    openingAnchorId: report.epoch.epoch.openingAnchorId,
    closingAnchorId: report.epoch.epoch.closingAnchorId,
    status: report.status,
    dependencyHash: report.dependencyHash,
    contentHash: report.contentHash,
    canonicalJson: canonicalJson.value,
  });
}

export function decodeHistoryAccountingReport(
  record: HistoryAccountingReportRecord,
): Result<HistoryAccountingReconciliationReport> {
  try {
    const decoded: unknown = JSON.parse(record.canonicalJson);
    if (
      decoded === null ||
      typeof decoded !== "object" ||
      Array.isArray(decoded) ||
      Object.getPrototypeOf(decoded) !== Object.prototype
    )
      return failure("stored accounting report is malformed");
    const value = decoded as Record<string, unknown>;
    if (
      value.reportId !== record.reportId ||
      value.status !== record.status ||
      value.dependencyHash !== record.dependencyHash ||
      value.evaluatedAt !== record.evaluatedAt ||
      value.contentHash !== record.contentHash ||
      value.scope === null ||
      typeof value.scope !== "object" ||
      value.epoch === null ||
      typeof value.epoch !== "object" ||
      Array.isArray(value.epoch)
    )
      return failure("stored accounting report metadata does not match");
    if (value.schemaVersion === "history-accounting-reconciliation-report/v2")
      return decodeScopedHistoryAccountingReport(
        record,
        value as unknown as HistoryAccountingReconciliationReportV2,
      );
    if (value.schemaVersion !== "history-accounting-reconciliation-report/v1")
      return failure("stored accounting report version is unsupported");
    const epoch = value.epoch as Record<string, unknown>;
    if (
      epoch.epoch === null ||
      typeof epoch.epoch !== "object" ||
      Array.isArray(epoch.epoch)
    )
      return failure("stored accounting report epoch is malformed");
    const epochIdentity = epoch.epoch as Record<string, unknown>;
    if (
      epochIdentity.openingAnchorId !== record.openingAnchorId ||
      epochIdentity.closingAnchorId !== record.closingAnchorId
    )
      return failure("stored accounting report anchor metadata does not match");
    const storedScopeHash = hashCanonical(value.scope);
    const recordScopeHash = hashCanonical(record.scope);
    const { contentHash, ...payload } = value;
    const computed = hashCanonical(payload);
    const identity = hashCanonical({
      schemaVersion: value.schemaVersion,
      scope: value.scope,
      dependencyHash: value.dependencyHash,
    });
    if (
      !computed.ok ||
      computed.value !== contentHash ||
      !storedScopeHash.ok ||
      !recordScopeHash.ok ||
      storedScopeHash.value !== recordScopeHash.value ||
      !identity.ok ||
      value.reportId !== `history-accounting-report:${identity.value.slice(7)}`
    )
      return failure("stored accounting report hash does not match");
    const canonical = canonicalSerialize(value);
    if (!canonical.ok || canonical.value !== record.canonicalJson)
      return failure("stored accounting report is not canonical");
    if (!isReportDomainValue(value))
      return failure("stored accounting report payload is invalid");
    return ok(value);
  } catch {
    return failure("stored accounting report could not be decoded");
  }
}

function isEpochProjection(
  value: unknown,
  scope: unknown,
): value is HistoryAccountingEpochProjection {
  if (
    !recordWithKeys(value, [
      "schemaVersion",
      "status",
      "readiness",
      "scope",
      "epoch",
      "sourceCoverage",
      "currencies",
      "selectedTransactionCount",
      "reasonCodes",
    ]) ||
    value.schemaVersion !== "history-accounting-epoch-projection/v1" ||
    (value.status !== "RECONCILED" && value.status !== "NOT_READY") ||
    (value.readiness !== "ACCOUNTING_READY" &&
      value.readiness !== "NOT_READY") ||
    !sameScopeValue(value.scope, scope) ||
    !recordWithKeys(value.epoch, [
      "openingAnchorId",
      "closingAnchorId",
      "openingBoundary",
      "closingBoundary",
      "transactionWindow",
    ]) ||
    typeof value.epoch.openingAnchorId !== "string" ||
    value.epoch.openingAnchorId.length === 0 ||
    typeof value.epoch.closingAnchorId !== "string" ||
    value.epoch.closingAnchorId.length === 0 ||
    !isTimestamp(value.epoch.openingBoundary) ||
    !isTimestamp(value.epoch.closingBoundary) ||
    Date.parse(value.epoch.openingBoundary) >=
      Date.parse(value.epoch.closingBoundary) ||
    value.epoch.transactionWindow !== "(opening, closing]" ||
    !Array.isArray(value.sourceCoverage) ||
    !Array.isArray(value.currencies) ||
    !Number.isSafeInteger(value.selectedTransactionCount) ||
    (value.selectedTransactionCount as number) < 0 ||
    !isStringArray(value.reasonCodes)
  )
    return false;

  const coverageSources = new Set<string>();
  for (const row of value.sourceCoverage) {
    if (
      !recordWithKeys(row, ["source", "covered", "gaps"]) ||
      !HISTORY_READ_SOURCES.includes(
        row.source as (typeof HISTORY_READ_SOURCES)[number],
      ) ||
      coverageSources.has(String(row.source)) ||
      typeof row.covered !== "boolean" ||
      !Array.isArray(row.gaps)
    )
      return false;
    coverageSources.add(String(row.source));
    for (const gap of row.gaps) {
      if (
        !recordWithKeys(gap, ["fromMs", "toMs"]) ||
        !Number.isSafeInteger(gap.fromMs) ||
        !Number.isSafeInteger(gap.toMs) ||
        (gap.fromMs as number) < 0 ||
        (gap.toMs as number) < (gap.fromMs as number)
      )
        return false;
    }
    if (row.covered !== (row.gaps.length === 0)) return false;
  }
  if (coverageSources.size !== HISTORY_READ_SOURCES.length) return false;
  if (!value.currencies.every(isCurrencyBridge)) return false;
  if (
    (value.status === "RECONCILED") !== (value.reasonCodes.length === 0) ||
    (value.status === "RECONCILED") !== (value.readiness === "ACCOUNTING_READY")
  )
    return false;
  if (value.readiness === "ACCOUNTING_READY") {
    if (
      value.sourceCoverage.some((row) => row.covered !== true) ||
      value.currencies.length === 0 ||
      value.currencies.some(
        (row) =>
          row.currency !== "USDT" ||
          row.openingBalance === null ||
          row.transactionChange === null ||
          row.transferChange === null ||
          row.expectedClosingBalance === null ||
          row.closingBalance === null ||
          row.unexplainedDrift !== "0",
      )
    )
      return false;
  }
  return true;
}

function isReportDomainValue(
  value: unknown,
): value is HistoryAccountingReconciliationReportV1 {
  if (
    !recordWithKeys(value, [
      "schemaVersion",
      "reportId",
      "scope",
      "evaluatedAt",
      "status",
      "dependencyHash",
      "contentHash",
      "epoch",
      "performance",
      "transactions",
      "accountUnrealizedPnlUsd",
      "preEpochHistory",
    ]) ||
    value.schemaVersion !== "history-accounting-reconciliation-report/v1" ||
    typeof value.reportId !== "string" ||
    value.reportId.length === 0 ||
    !isScope(value.scope) ||
    !isTimestamp(value.evaluatedAt) ||
    (value.status !== "ACCOUNTING_READY" && value.status !== "NOT_READY") ||
    typeof value.dependencyHash !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(value.dependencyHash) ||
    typeof value.contentHash !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(value.contentHash) ||
    value.preEpochHistory !== "UNKNOWN" ||
    !isEpochProjection(value.epoch, value.scope) ||
    !isPerformanceProjection(value.performance, value.scope) ||
    !Array.isArray(value.transactions) ||
    !recordWithKeys(value.accountUnrealizedPnlUsd, [
      "asOf",
      "amount",
      "status",
      "allocation",
    ])
  )
    return false;

  if (
    (value.status === "ACCOUNTING_READY") !==
      (value.epoch.readiness === "ACCOUNTING_READY") ||
    !isTimestamp(value.accountUnrealizedPnlUsd.asOf) ||
    !isNullableDecimal(value.accountUnrealizedPnlUsd.amount) ||
    value.accountUnrealizedPnlUsd.status !==
      (value.accountUnrealizedPnlUsd.amount === null ? "unknown" : "known") ||
    value.accountUnrealizedPnlUsd.allocation !== "account-wide-unallocated"
  )
    return false;
  return value.transactions.every(
    (transaction: unknown) =>
      recordWithKeys(transaction, [
        "observationId",
        "transactionId",
        "category",
        "movementKind",
        "currency",
        "change",
        "cashFlow",
        "funding",
        "fee",
        "bonusChange",
        "cashBalance",
        "expectedChange",
        "componentCheck",
        "strategyDisposition",
        "providerEventTime",
        "transactionType",
        "transactionSubType",
      ]) &&
      typeof transaction.observationId === "string" &&
      typeof transaction.transactionId === "string" &&
      isNullableString(transaction.category) &&
      ["trade", "funding", "transfer", "unknown"].includes(
        String(transaction.movementKind),
      ) &&
      isNullableString(transaction.currency) &&
      [
        transaction.change,
        transaction.cashFlow,
        transaction.funding,
        transaction.fee,
        transaction.bonusChange,
        transaction.cashBalance,
        transaction.expectedChange,
      ].every(isNullableDecimal) &&
      ["matched", "mismatched", "incomplete"].includes(
        String(transaction.componentCheck),
      ) &&
      ["corroboration-only", "account-movement-only"].includes(
        String(transaction.strategyDisposition),
      ) &&
      isTimestamp(transaction.providerEventTime) &&
      isNullableString(transaction.transactionType) &&
      isNullableString(transaction.transactionSubType),
  );
}

function inEpoch(time: string, opening: string, closing: string): boolean {
  const value = Date.parse(time);
  return value > Date.parse(opening) && value <= Date.parse(closing);
}

function dependencySet(
  input: CreateHistoryAccountingReportInput,
  canonical: CanonicalHistoryEvidence,
  attribution: HistoryAttributionProjection,
): Result<HistoryAccountingReportDependencies> {
  const opening = Date.parse(input.opening.capture.providerResponseTime);
  const closing = Date.parse(input.closing.capture.providerResponseTime);
  const openingCaptureStart = Date.parse(
    input.opening.capture.providerTimeBefore,
  );
  const closingCaptureEnd = Date.parse(input.closing.capture.providerTimeAfter);
  const coverageStart = Number.isSafeInteger(openingCaptureStart)
    ? Math.min(openingCaptureStart, opening + 1)
    : opening + 1;
  const coverageEnd = Number.isSafeInteger(closingCaptureEnd)
    ? Math.max(closingCaptureEnd, closing)
    : closing;
  const relevantClosedPnl = canonical.observations.filter(
    ({ fact, providerEventTime }) =>
      fact.factKind === "closed-pnl" &&
      inEpoch(
        providerEventTime,
        input.opening.capture.providerResponseTime,
        input.closing.capture.providerResponseTime,
      ),
  );
  const relevantTransactionRows = canonical.observations.filter(
    ({ fact, providerEventTime }) =>
      fact.factKind === "transaction" &&
      inEpoch(
        providerEventTime,
        input.opening.capture.providerResponseTime,
        input.closing.capture.providerResponseTime,
      ),
  );
  const relevantClosedIds = new Set(
    relevantClosedPnl.map(({ observationId }) => observationId),
  );
  const exactReferences = new Set<string>();
  const relevantLineageIds = new Set<string>();
  for (const row of attribution.observations) {
    if (!relevantClosedIds.has(row.observation.observationId)) continue;
    if (row.ownership.status === "matched") {
      relevantLineageIds.add(
        `${row.ownership.source.kind}\u0000${row.ownership.source.sourceId}`,
      );
      for (const evidence of row.ownership.evidence)
        if (evidence.observationId) exactReferences.add(evidence.observationId);
    } else if (row.ownership.status === "ambiguous") {
      for (const candidate of row.ownership.candidates)
        relevantLineageIds.add(`${candidate.kind}\u0000${candidate.sourceId}`);
      for (const evidence of row.ownership.evidence)
        if (evidence.observationId) exactReferences.add(evidence.observationId);
    }
  }
  const selectedIds = new Set([
    ...relevantClosedPnl.map(({ observationId }) => observationId),
    ...relevantTransactionRows.map(({ observationId }) => observationId),
    ...exactReferences,
  ]);
  const sourceDependencies = canonical.observations
    .filter(({ observationId }) => selectedIds.has(observationId))
    .map(
      ({
        observationId,
        source,
        eventIdentity,
        contentHash,
        canonicalHash,
      }) => ({
        observationId,
        source,
        eventIdentity,
        contentHash,
        canonicalHash,
      }),
    )
    .sort((left, right) =>
      left.observationId.localeCompare(right.observationId),
    );

  const observationsByIdentity = indexHistoryObservationsByIdentity(
    input.observations,
  );
  const conflicts = input.conflicts
    .filter((conflict) => {
      const sameIdentity =
        observationsByIdentity
          .get(conflict.source)
          ?.get(conflict.eventIdentity) ?? [];
      return (
        sameIdentity.length === 0 ||
        sameIdentity.some(
          (row) =>
            inEpoch(
              row.providerEventTime,
              input.opening.capture.providerResponseTime,
              input.closing.capture.providerResponseTime,
            ) || exactReferences.has(row.observationId),
        )
      );
    })
    .map(
      ({
        conflictId,
        source,
        eventIdentity,
        existingHash,
        incomingHash,
        reason,
      }) => ({
        conflictId,
        source,
        eventIdentity,
        existingHash,
        incomingHash,
        reason,
      }),
    )
    .sort((left, right) => left.conflictId.localeCompare(right.conflictId));

  const coverageDependencies = input.coverage
    .filter(({ window }) => overlapsRange(window, coverageStart, coverageEnd))
    .map((checkpoint) => ({
      scope: checkpoint.scope,
      source: checkpoint.source,
      filters: checkpoint.filters,
      window: checkpoint.window,
      filterHash: checkpoint.filterHash,
      cursor: checkpoint.cursor,
      status: checkpoint.status,
      rowCount: checkpoint.rowCount,
      conflictCount: checkpoint.conflictCount,
      reasonCode: checkpoint.reasonCode,
      revision: checkpoint.revision,
      updatedAt: checkpoint.updatedAt,
    }))
    .sort(
      (left, right) =>
        left.source.localeCompare(right.source) ||
        left.window.fromMs - right.window.fromMs ||
        left.window.toMs - right.window.toMs ||
        left.filterHash.localeCompare(right.filterHash),
    );

  const lineageDependencies: Array<
    HistoryAccountingReportDependencies["lineageDependencies"][number]
  > = [];
  for (const snapshot of input.operatorSources) {
    if (
      !relevantLineageIds.has(
        `operator-mainnet-test\u0000${snapshot.source.sourceId}`,
      )
    )
      continue;
    const contentHash = hashCanonical(snapshot);
    if (!contentHash.ok) return contentHash;
    lineageDependencies.push({
      sourceKind: "operator-mainnet-test",
      sourceId: snapshot.source.sourceId,
      contentHash: contentHash.value,
    });
  }
  for (const snapshot of input.preparedSources) {
    if (
      !relevantLineageIds.has(`prepared-leg\u0000${snapshot.lineage.sourceId}`)
    )
      continue;
    const contentHash = hashCanonical(snapshot);
    if (!contentHash.ok) return contentHash;
    lineageDependencies.push({
      sourceKind: "prepared-leg",
      sourceId: snapshot.lineage.sourceId,
      contentHash: contentHash.value,
    });
  }
  lineageDependencies.sort(
    (left, right) =>
      left.sourceKind.localeCompare(right.sourceKind) ||
      left.sourceId.localeCompare(right.sourceId),
  );

  return ok({
    sourceDependencies,
    coverageDependencies,
    conflictDependencies: conflicts,
    lineageDependencies,
  });
}

function createHistoryAccountingReportV1(
  input: CreateHistoryAccountingReportInput,
): Result<HistoryAccountingReconciliationReport> {
  try {
    if (
      input.scope.exchange !== "bybit" ||
      input.opening.scope.accountId !== input.scope.accountId ||
      input.closing.scope.accountId !== input.scope.accountId ||
      input.opening.scope.environment !== input.scope.environment ||
      input.closing.scope.environment !== input.scope.environment
    )
      return failure("history report scope or anchor identity is inconsistent");

    const canonical = selectCanonicalHistoryEvidence({
      scope: input.scope,
      observations: input.observations,
      conflicts: input.conflicts,
    });
    if (!canonical.ok) return canonical;
    const attribution = attributeHistoryObservations({
      observations: canonical.value.observations,
      operatorSources: input.operatorSources,
      preparedSources: input.preparedSources,
    });
    if (!attribution.ok) return attribution;
    const epoch = projectHistoryAccountingEpoch({
      scope: input.scope,
      opening: input.opening,
      closing: input.closing,
      observations: input.observations,
      conflicts: input.conflicts,
      coverage: input.coverage,
    });
    if (!epoch.ok) return epoch;

    const relevantClosedIds = new Set(
      canonical.value.observations
        .filter(
          ({ fact, providerEventTime }) =>
            fact.factKind === "closed-pnl" &&
            inEpoch(
              providerEventTime,
              input.opening.capture.providerResponseTime,
              input.closing.capture.providerResponseTime,
            ),
        )
        .map(({ observationId }) => observationId),
    );
    const performanceAttribution: HistoryAttributionProjection = {
      schemaVersion: "history-attribution-projection/v1",
      observations: attribution.value.observations.filter((row) =>
        relevantClosedIds.has(row.observation.observationId),
      ),
    };
    const performance = projectHistoryAccountingPerformance({
      scope: input.scope,
      attribution: performanceAttribution,
      sourceConflicts: [],
      settlementCurrencyBySymbol: input.settlementCurrencyBySymbol ?? {},
      ...(input.positionUplEvidence === undefined
        ? {}
        : { positionUplEvidence: input.positionUplEvidence }),
    });
    if (!performance.ok) return performance;

    const transactions: HistoryAccountingReportTransaction[] = [];
    for (const observation of canonical.value.observations) {
      if (
        observation.fact.factKind !== "transaction" ||
        !inEpoch(
          observation.providerEventTime,
          input.opening.capture.providerResponseTime,
          input.closing.capture.providerResponseTime,
        )
      )
        continue;
      const normalized = normalizeHistoryTransaction(observation);
      if (!normalized.ok) return normalized;
      transactions.push({
        ...normalized.value,
        providerEventTime: observation.providerEventTime,
        transactionType: observation.fact.type,
        transactionSubType: observation.fact.transSubType,
      });
    }
    transactions.sort(
      (left, right) =>
        left.providerEventTime.localeCompare(right.providerEventTime) ||
        left.transactionId.localeCompare(right.transactionId),
    );

    const dependencies = dependencySet(
      input,
      canonical.value,
      attribution.value,
    );
    if (!dependencies.ok) return dependencies;
    const dependencyMaterial = {
      schemaVersion: "history-accounting-dependencies/v1",
      scope: input.scope,
      epoch: epoch.value.epoch,
      anchors: {
        opening: {
          anchorId: input.opening.anchorId,
          contentHash: input.opening.contentHash,
        },
        closing: {
          anchorId: input.closing.anchorId,
          contentHash: input.closing.contentHash,
        },
      },
      sourceDependencies: dependencies.value.sourceDependencies,
      coverageDependencies: dependencies.value.coverageDependencies,
      conflictDependencies: dependencies.value.conflictDependencies,
      lineageDependencies: dependencies.value.lineageDependencies,
      settlementCurrencyBySymbol: input.settlementCurrencyBySymbol ?? {},
      positionUplEvidence: input.positionUplEvidence ?? null,
      performanceSelectionConflicts: performance.value.selectionConflicts,
    };
    const dependencyHash = hashCanonical(dependencyMaterial);
    if (!dependencyHash.ok) return dependencyHash;
    const evaluatedAt = input.closing.capture
      .providerResponseTime as UtcTimestamp;
    const totalPerpUpl = input.closing.totals.totalPerpUPL;
    const amount =
      totalPerpUpl.state === "known" ? totalPerpUpl.value.toString() : null;
    const withoutId = {
      schemaVersion: "history-accounting-reconciliation-report/v1" as const,
      scope: input.scope,
      evaluatedAt,
      status: epoch.value.readiness,
      dependencyHash: dependencyHash.value,
      epoch: epoch.value,
      performance: performance.value,
      transactions,
      accountUnrealizedPnlUsd: {
        asOf: evaluatedAt,
        amount,
        status: amount === null ? ("unknown" as const) : ("known" as const),
        allocation: "account-wide-unallocated" as const,
      },
      preEpochHistory: "UNKNOWN" as const,
    };
    const reportIdentityHash = hashCanonical({
      schemaVersion: withoutId.schemaVersion,
      scope: withoutId.scope,
      dependencyHash: withoutId.dependencyHash,
    });
    if (!reportIdentityHash.ok) return reportIdentityHash;
    const reportId = `history-accounting-report:${reportIdentityHash.value.slice(7)}`;
    const contentHash = hashCanonical({ reportId, ...withoutId });
    if (!contentHash.ok) return contentHash;
    return ok({ reportId, ...withoutId, contentHash: contentHash.value });
  } catch {
    return fail(
      domainError(
        "INVALID_ACCOUNTING",
        "history accounting report could not be calculated",
      ),
    );
  }
}

export function createHistoryAccountingReport(
  input: CreateHistoryAccountingReportInput,
): Result<HistoryAccountingReconciliationReport> {
  return input.accountingScope === undefined
    ? createHistoryAccountingReportV1(input)
    : createScopedHistoryAccountingReport(input);
}
