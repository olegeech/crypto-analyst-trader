import {
  canonicalSerialize,
  hashCanonical,
} from "../domain/identity/canonical-serialization.js";
import { domainError } from "../domain/shared/errors.js";
import { fail, ok, type Result } from "../domain/shared/result.js";
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
import {
  attributeHistoryObservations,
  type HistoryAttributionProjection,
} from "./history-attribution.js";
import { indexHistoryObservationsByIdentity } from "./history-accounting-normalization.js";
import {
  projectHistoryAccountingEpoch,
  type HistoryAccountingEpochProjection,
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

export interface HistoryAccountingReportTransaction extends NormalizedHistoryTransaction {
  readonly providerEventTime: UtcTimestamp;
  readonly transactionType: string | null;
  readonly transactionSubType: string | null;
}

export interface HistoryAccountingReconciliationReport {
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
      value.schemaVersion !== "history-accounting-reconciliation-report/v1" ||
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
    return ok(value as unknown as HistoryAccountingReconciliationReport);
  } catch {
    return failure("stored accounting report could not be decoded");
  }
}

function failure(message: string): Result<never> {
  return fail(domainError("INVALID_ACCOUNTING", message));
}

function inEpoch(time: string, opening: string, closing: string): boolean {
  const value = Date.parse(time);
  return value > Date.parse(opening) && value <= Date.parse(closing);
}

function overlapsEpoch(
  window: { readonly fromMs: number; readonly toMs: number },
  opening: number,
  closing: number,
): boolean {
  return window.fromMs <= closing && window.toMs > opening;
}

function dependencySet(
  input: CreateHistoryAccountingReportInput,
  canonical: CanonicalHistoryEvidence,
  attribution: HistoryAttributionProjection,
): Result<HistoryAccountingReportDependencies> {
  const opening = Date.parse(input.opening.capture.providerResponseTime);
  const closing = Date.parse(input.closing.capture.providerResponseTime);
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
    .filter(({ window }) => overlapsEpoch(window, opening, closing))
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

export function createHistoryAccountingReport(
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
