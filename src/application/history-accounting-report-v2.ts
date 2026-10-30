import {
  canonicalSerialize,
  hashCanonical,
} from "../domain/identity/canonical-serialization.js";
import { domainError } from "../domain/shared/errors.js";
import { fail, ok, type Result } from "../domain/shared/result.js";
import {
  decodeHistoryAccountingScope,
  type HistoryAccountingScope,
} from "../domain/accounting/accounting-scope.js";
import type { UtcTimestamp } from "../domain/shared/time.js";
import type {
  HistoryCheckpoint,
  HistoryStoreScope,
} from "../ports/history-store.js";
import type { HistoryAccountingReportRecord } from "../ports/history-accounting-report-store.js";
import {
  HISTORY_READ_LIMITS,
  HISTORY_READ_SOURCES,
} from "../ports/history-read.js";
import {
  attributeHistoryObservations,
  type HistoryAttributionProjection,
} from "./history-attribution.js";
import {
  projectScopedHistoryAccountingEpochWithSelection,
  type HistoryAccountingEpochProjectionV2,
} from "./history-accounting-epoch.js";
import {
  ignoreProvenIndependentScopedConflicts,
  selectScopedHistoryAccountingEvidence,
  type ScopedHistoryAccountingEvidence,
  type ScopedHistoryAccountingEpochBounds,
} from "./history-accounting-selection.js";
import { projectHistoryAccountingPerformance } from "./history-accounting-performance.js";
import { normalizeHistoryTransaction } from "./history-accounting-normalization.js";
import { resolveHistoryAccountingScope } from "./history-accounting-scope.js";
import {
  failure,
  plainRecord,
  recordWithKeys,
  isNullableString,
  isTimestamp,
  isDecimal,
  isNullableDecimal,
  isStringArray,
  isScope,
  sameScopeValue,
  isCurrencyBridge,
  isPerformanceProjection,
  overlapsRange,
} from "./history-accounting-report-common.js";
import type {
  CreateHistoryAccountingReportInput,
  HistoryAccountingCoverageWitness,
  HistoryAccountingReportDependenciesV2,
  HistoryAccountingReconciliationReport,
  HistoryAccountingReconciliationReportV2,
  HistoryAccountingReportTransaction,
} from "./history-accounting-report.js";

function isScopedEpochProjection(
  value: unknown,
  scope: unknown,
  accountingScope: HistoryAccountingScope,
): value is HistoryAccountingEpochProjectionV2 {
  if (
    !recordWithKeys(value, [
      "schemaVersion",
      "status",
      "readiness",
      "scope",
      "accountingScope",
      "accountingScopeHash",
      "epoch",
      "sourceCoverage",
      "currencies",
      "selectedTransactionCount",
      "selectedEvidenceIdentities",
      "conflictDispositions",
      "exclusions",
      "exclusionCount",
      "exclusionsTruncated",
      "reasonCodes",
    ]) ||
    value.schemaVersion !== "history-accounting-epoch-projection/v2" ||
    (value.status !== "RECONCILED" && value.status !== "NOT_READY") ||
    (value.readiness !== "ACCOUNTING_READY" &&
      value.readiness !== "NOT_READY") ||
    !sameScopeValue(value.scope, scope) ||
    value.accountingScopeHash !== accountingScope.scopeHash ||
    !plainRecord(value.accountingScope) ||
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
    !Array.isArray(value.selectedEvidenceIdentities) ||
    !Array.isArray(value.conflictDispositions) ||
    !Array.isArray(value.exclusions) ||
    !Number.isSafeInteger(value.exclusionCount) ||
    (value.exclusionCount as number) < 0 ||
    typeof value.exclusionsTruncated !== "boolean" ||
    !isStringArray(value.reasonCodes)
  ) {
    return false;
  }

  const decodedScope = decodeHistoryAccountingScope(value.accountingScope);
  const decodedScopeHash = decodedScope.ok
    ? hashCanonical(decodedScope.value)
    : undefined;
  const expectedScopeHash = hashCanonical(accountingScope);
  if (
    !decodedScope.ok ||
    !decodedScopeHash?.ok ||
    !expectedScopeHash.ok ||
    decodedScopeHash.value !== expectedScopeHash.value
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
  const currencyNames = value.currencies.flatMap((row: unknown) =>
    plainRecord(row) && typeof row.currency === "string" ? [row.currency] : [],
  );
  if (
    coverageSources.size !== HISTORY_READ_SOURCES.length ||
    !value.currencies.every(isCurrencyBridge) ||
    new Set(currencyNames).size !== currencyNames.length ||
    currencyNames.some(
      (currency) => !accountingScope.nativeCurrencies.includes(currency),
    ) ||
    (value.readiness === "ACCOUNTING_READY" &&
      (currencyNames.length !== accountingScope.nativeCurrencies.length ||
        accountingScope.nativeCurrencies.some(
          (currency, index) => currencyNames[index] !== currency,
        ))) ||
    value.selectedEvidenceIdentities.some(
      (identity: unknown) =>
        !recordWithKeys(identity, [
          "source",
          "eventIdentity",
          "contentHash",
          "observationId",
        ]) ||
        !HISTORY_READ_SOURCES.includes(
          identity.source as (typeof HISTORY_READ_SOURCES)[number],
        ) ||
        typeof identity.eventIdentity !== "string" ||
        typeof identity.observationId !== "string" ||
        !/^sha256:[0-9a-f]{64}$/u.test(String(identity.contentHash)),
    ) ||
    value.conflictDispositions.some(
      (conflict: unknown) =>
        !recordWithKeys(conflict, [
          "source",
          "eventIdentity",
          "disposition",
          "conflictIds",
          "observationIds",
          "reason",
        ]) ||
        !HISTORY_READ_SOURCES.includes(
          conflict.source as (typeof HISTORY_READ_SOURCES)[number],
        ) ||
        typeof conflict.eventIdentity !== "string" ||
        !["blocking", "independent-excluded"].includes(
          String(conflict.disposition),
        ) ||
        !isStringArray(conflict.conflictIds) ||
        !isStringArray(conflict.observationIds) ||
        ![
          "stored-conflict",
          "transaction-identity-conflict",
          "closed-pnl-revision-conflict",
        ].includes(String(conflict.reason)),
    ) ||
    value.exclusions.some(
      (exclusion: unknown) => !isScopedExclusion(exclusion),
    ) ||
    (value.status === "RECONCILED") !== (value.reasonCodes.length === 0) ||
    (value.status === "RECONCILED") !== (value.readiness === "ACCOUNTING_READY")
  )
    return false;
  if (value.readiness === "ACCOUNTING_READY") {
    if (
      value.sourceCoverage.some(
        (row: unknown) => !plainRecord(row) || row.covered !== true,
      ) ||
      value.currencies.some(
        (row: unknown) =>
          !plainRecord(row) ||
          [
            row.openingBalance,
            row.transactionChange,
            row.transferChange,
            row.expectedClosingBalance,
            row.closingBalance,
          ].some((amount) => amount === null || !isDecimal(amount)) ||
          row.unexplainedDrift !== "0",
      )
    )
      return false;
  }
  return true;
}

function isScopedExclusion(value: unknown): boolean {
  if (!plainRecord(value)) return false;
  if (value.kind === "anchor-balance")
    return (
      recordWithKeys(value, [
        "kind",
        "currency",
        "openingBalance",
        "closingBalance",
      ]) &&
      typeof value.currency === "string" &&
      isNullableDecimal(value.openingBalance) &&
      isNullableDecimal(value.closingBalance)
    );
  return (
    recordWithKeys(value, [
      "kind",
      "source",
      "eventIdentity",
      "observationIds",
      "currency",
      "type",
      "reason",
    ]) &&
    value.kind === "transaction" &&
    value.source === "transaction-log" &&
    typeof value.eventIdentity === "string" &&
    isStringArray(value.observationIds) &&
    typeof value.currency === "string" &&
    typeof value.type === "string" &&
    value.reason === "independent-out-of-scope-transaction"
  );
}

function isReportScopedEpochProjection(
  value: unknown,
  scope: unknown,
  accountingScope: HistoryAccountingScope,
): value is HistoryAccountingEpochProjectionV2 {
  return (
    isScopedEpochProjection(value, scope, accountingScope) &&
    value.exclusions.every(
      (exclusion) =>
        plainRecord(exclusion) && exclusion.kind === "anchor-balance",
    ) &&
    value.exclusionCount >= value.exclusions.length &&
    value.exclusionsTruncated === value.exclusionCount > value.exclusions.length
  );
}

function isCoverageWitness(
  value: unknown,
): value is HistoryAccountingCoverageWitness {
  return (
    recordWithKeys(value, [
      "source",
      "requiredWindow",
      "normalizedQueryFilterIdentity",
      "mergedCoveredIntervals",
      "terminalComplete",
      "conflictLocationsValid",
      "relevantConflicts",
    ]) &&
    HISTORY_READ_SOURCES.includes(
      value.source as (typeof HISTORY_READ_SOURCES)[number],
    ) &&
    recordWithKeys(value.requiredWindow, ["fromMs", "toMs"]) &&
    Number.isSafeInteger(value.requiredWindow.fromMs) &&
    Number.isSafeInteger(value.requiredWindow.toMs) &&
    (value.requiredWindow.fromMs as number) <
      (value.requiredWindow.toMs as number) &&
    typeof value.normalizedQueryFilterIdentity === "string" &&
    /^sha256:[0-9a-f]{64}$/u.test(value.normalizedQueryFilterIdentity) &&
    Array.isArray(value.mergedCoveredIntervals) &&
    value.mergedCoveredIntervals.every(
      (interval: unknown) =>
        recordWithKeys(interval, ["fromMs", "toMs"]) &&
        Number.isSafeInteger(interval.fromMs) &&
        Number.isSafeInteger(interval.toMs) &&
        (interval.fromMs as number) <= (interval.toMs as number),
    ) &&
    typeof value.terminalComplete === "boolean" &&
    typeof value.conflictLocationsValid === "boolean" &&
    Array.isArray(value.relevantConflicts) &&
    value.relevantConflicts.every(
      (conflict: unknown) =>
        recordWithKeys(conflict, [
          "conflictId",
          "source",
          "eventIdentity",
          "existingHash",
          "incomingHash",
          "reason",
        ]) &&
        typeof conflict.conflictId === "string" &&
        typeof conflict.source === "string" &&
        typeof conflict.eventIdentity === "string" &&
        /^sha256:[0-9a-f]{64}$/u.test(String(conflict.existingHash)) &&
        /^sha256:[0-9a-f]{64}$/u.test(String(conflict.incomingHash)) &&
        typeof conflict.reason === "string",
    )
  );
}

function isCoverageWitnessSet(value: readonly unknown[]): boolean {
  const sources = new Set<string>();
  let requiredWindow:
    HistoryAccountingCoverageWitness["requiredWindow"] | undefined;
  for (const candidate of value) {
    if (!isCoverageWitness(candidate) || sources.has(candidate.source))
      return false;
    sources.add(candidate.source);
    if (
      candidate.normalizedQueryFilterIdentity !==
        scopedQueryFilterIdentity(candidate.source) ||
      candidate.relevantConflicts.some(
        (conflict) => conflict.source !== candidate.source,
      )
    )
      return false;
    if (requiredWindow === undefined) requiredWindow = candidate.requiredWindow;
    else if (!canonicalValuesEqual(requiredWindow, candidate.requiredWindow))
      return false;
  }
  return sources.size === HISTORY_READ_SOURCES.length;
}

function isScopedDependencies(
  value: unknown,
): value is HistoryAccountingReportDependenciesV2 {
  if (
    !recordWithKeys(value, [
      "schemaVersion",
      "scope",
      "accountingScope",
      "accountingScopeHash",
      "epoch",
      "anchors",
      "sourceDependencies",
      "coverageWitness",
      "conflictDependencies",
      "lineageDependencies",
      "settlementCurrencyBySymbol",
      "positionUplEvidence",
      "performanceSelectionConflicts",
    ]) ||
    value.schemaVersion !== "history-accounting-dependencies/v2" ||
    !isScope(value.scope) ||
    !recordWithKeys(value.anchors, ["opening", "closing"]) ||
    !recordWithKeys(value.anchors.opening, ["anchorId", "contentHash"]) ||
    !recordWithKeys(value.anchors.closing, ["anchorId", "contentHash"]) ||
    typeof value.anchors.opening.anchorId !== "string" ||
    typeof value.anchors.closing.anchorId !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(String(value.anchors.opening.contentHash)) ||
    !/^sha256:[0-9a-f]{64}$/u.test(String(value.anchors.closing.contentHash)) ||
    value.accountingScopeHash !==
      (value.accountingScope as Record<string, unknown> | null)?.scopeHash ||
    !Array.isArray(value.sourceDependencies) ||
    value.sourceDependencies.some(
      (dependency: unknown) =>
        !recordWithKeys(dependency, [
          "observationId",
          "source",
          "eventIdentity",
          "contentHash",
        ]) ||
        typeof dependency.observationId !== "string" ||
        !HISTORY_READ_SOURCES.includes(
          dependency.source as (typeof HISTORY_READ_SOURCES)[number],
        ) ||
        typeof dependency.eventIdentity !== "string" ||
        !/^sha256:[0-9a-f]{64}$/u.test(String(dependency.contentHash)),
    ) ||
    !Array.isArray(value.coverageWitness) ||
    value.coverageWitness.length !== HISTORY_READ_SOURCES.length ||
    !isCoverageWitnessSet(value.coverageWitness) ||
    !Array.isArray(value.conflictDependencies) ||
    !Array.isArray(value.lineageDependencies) ||
    value.lineageDependencies.some(
      (dependency: unknown) =>
        !recordWithKeys(dependency, [
          "sourceKind",
          "sourceId",
          "contentHash",
        ]) ||
        !["operator-mainnet-test", "prepared-leg"].includes(
          String(dependency.sourceKind),
        ) ||
        typeof dependency.sourceId !== "string" ||
        !/^sha256:[0-9a-f]{64}$/u.test(String(dependency.contentHash)),
    ) ||
    !plainRecord(value.settlementCurrencyBySymbol) ||
    (value.positionUplEvidence !== null &&
      !plainRecord(value.positionUplEvidence)) ||
    !Array.isArray(value.performanceSelectionConflicts)
  )
    return false;
  const scope = decodeHistoryAccountingScope(value.accountingScope);
  return scope.ok && scope.value.scopeHash === value.accountingScopeHash;
}

export function isScopedReportDomainValue(
  value: unknown,
): value is HistoryAccountingReconciliationReportV2 {
  if (
    !recordWithKeys(value, [
      "schemaVersion",
      "reportId",
      "scope",
      "accountingScope",
      "accountingScopeHash",
      "evaluatedAt",
      "status",
      "dependencyHash",
      "contentHash",
      "dependencies",
      "epoch",
      "performance",
      "transactions",
      "accountUnrealizedPnlUsd",
      "preEpochHistory",
    ]) ||
    value.schemaVersion !== "history-accounting-reconciliation-report/v2" ||
    typeof value.reportId !== "string" ||
    value.reportId.length === 0 ||
    !isScope(value.scope) ||
    !isTimestamp(value.evaluatedAt) ||
    (value.status !== "ACCOUNTING_READY" && value.status !== "NOT_READY") ||
    !/^sha256:[0-9a-f]{64}$/u.test(String(value.dependencyHash)) ||
    !/^sha256:[0-9a-f]{64}$/u.test(String(value.contentHash)) ||
    value.preEpochHistory !== "UNKNOWN" ||
    !Array.isArray(value.transactions) ||
    !recordWithKeys(value.accountUnrealizedPnlUsd, [
      "asOf",
      "amount",
      "status",
      "allocation",
    ])
  )
    return false;
  const accountingScope = decodeHistoryAccountingScope(value.accountingScope);
  if (
    !accountingScope.ok ||
    accountingScope.value.scopeHash !== value.accountingScopeHash
  )
    return false;
  const resolved = resolveHistoryAccountingScope(
    accountingScope.value.policyVersion,
  );
  if (
    !resolved.ok ||
    !canonicalValuesEqual(resolved.value, accountingScope.value)
  )
    return false;
  if (
    !isReportScopedEpochProjection(
      value.epoch,
      value.scope,
      accountingScope.value,
    ) ||
    !isPerformanceProjection(value.performance, value.scope) ||
    !isScopedDependencies(value.dependencies)
  )
    return false;
  const scopedEpoch = value.epoch as HistoryAccountingEpochProjectionV2;
  const dependencies =
    value.dependencies as HistoryAccountingReportDependenciesV2;
  if (
    !sameScopeValue(dependencies.scope, value.scope) ||
    dependencies.accountingScopeHash !== value.accountingScopeHash ||
    !canonicalValuesEqual(
      dependencies.accountingScope,
      accountingScope.value,
    ) ||
    !canonicalValuesEqual(dependencies.epoch, scopedEpoch.epoch) ||
    dependencies.anchors.opening.anchorId !==
      scopedEpoch.epoch.openingAnchorId ||
    dependencies.anchors.closing.anchorId !==
      scopedEpoch.epoch.closingAnchorId ||
    dependencies.sourceDependencies.length !==
      scopedEpoch.selectedEvidenceIdentities.length ||
    dependencies.sourceDependencies.some((dependency, index) => {
      const selected = scopedEpoch.selectedEvidenceIdentities[index];
      return (
        selected === undefined ||
        dependency.observationId !== selected.observationId ||
        dependency.source !== selected.source ||
        dependency.eventIdentity !== selected.eventIdentity ||
        dependency.contentHash !== selected.contentHash
      );
    }) ||
    (value.status === "ACCOUNTING_READY") !==
      (scopedEpoch.readiness === "ACCOUNTING_READY") ||
    !isTimestamp(value.accountUnrealizedPnlUsd.asOf) ||
    !isNullableDecimal(value.accountUnrealizedPnlUsd.amount) ||
    value.accountUnrealizedPnlUsd.status !==
      (value.accountUnrealizedPnlUsd.amount === null ? "unknown" : "known") ||
    value.accountUnrealizedPnlUsd.allocation !== "account-wide-unallocated" ||
    value.transactions.some(
      (transaction: unknown) => !isReportTransaction(transaction),
    )
  )
    return false;
  const sourceCoverage = new Map(
    scopedEpoch.sourceCoverage.map((row) => [row.source, row.covered]),
  );
  if (
    dependencies.coverageWitness.some(
      (witness) =>
        witness.terminalComplete !== sourceCoverage.get(witness.source) ||
        (value.status === "ACCOUNTING_READY" &&
          (!witness.terminalComplete || !witness.conflictLocationsValid)),
    )
  )
    return false;
  return true;
}

function isReportTransaction(transaction: unknown): boolean {
  return (
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
    isNullableString(transaction.transactionSubType)
  );
}

export function decodeScopedHistoryAccountingReport(
  record: HistoryAccountingReportRecord,
  value: HistoryAccountingReconciliationReportV2,
): Result<HistoryAccountingReconciliationReport> {
  if (
    value.reportId !== record.reportId ||
    value.status !== record.status ||
    value.dependencyHash !== record.dependencyHash ||
    value.evaluatedAt !== record.evaluatedAt ||
    value.contentHash !== record.contentHash ||
    value.epoch.epoch.openingAnchorId !== record.openingAnchorId ||
    value.epoch.epoch.closingAnchorId !== record.closingAnchorId
  )
    return failure("stored scoped accounting report metadata does not match");
  const storedScopeHash = hashCanonical(value.scope);
  const recordScopeHash = hashCanonical(record.scope);
  const dependency = hashCanonical(value.dependencies);
  const { contentHash, ...payload } = value;
  const calculatedContent = hashCanonical(payload);
  const identity = hashCanonical({
    schemaVersion: value.schemaVersion,
    scope: value.scope,
    accountingScope: value.accountingScope,
    dependencyHash: value.dependencyHash,
  });
  if (
    !storedScopeHash.ok ||
    !recordScopeHash.ok ||
    storedScopeHash.value !== recordScopeHash.value ||
    !dependency.ok ||
    dependency.value !== value.dependencyHash ||
    !calculatedContent.ok ||
    calculatedContent.value !== contentHash ||
    !identity.ok ||
    value.reportId !== `history-accounting-report:${identity.value.slice(7)}`
  )
    return failure("stored scoped accounting report hash does not match");
  const canonical = canonicalSerialize(value);
  if (!canonical.ok || canonical.value !== record.canonicalJson)
    return failure("stored scoped accounting report is not canonical");
  if (!isScopedReportDomainValue(value))
    return failure("stored scoped accounting report payload is invalid");
  return ok(value);
}

function inEpoch(time: string, opening: string, closing: string): boolean {
  const value = Date.parse(time);
  return value > Date.parse(opening) && value <= Date.parse(closing);
}

function canonicalValuesEqual(left: unknown, right: unknown): boolean {
  const a = hashCanonical(left);
  const b = hashCanonical(right);
  return a.ok && b.ok && a.value === b.value;
}

function scopedEpochBounds(
  input: CreateHistoryAccountingReportInput,
): Result<ScopedHistoryAccountingEpochBounds> {
  const opening = Date.parse(input.opening.capture.providerResponseTime);
  const closing = Date.parse(input.closing.capture.providerResponseTime);
  const openingBefore = Date.parse(input.opening.capture.providerTimeBefore);
  const openingAfter = Date.parse(input.opening.capture.providerTimeAfter);
  const closingBefore = Date.parse(input.closing.capture.providerTimeBefore);
  const closingAfter = Date.parse(input.closing.capture.providerTimeAfter);
  if (
    ![
      opening,
      closing,
      openingBefore,
      openingAfter,
      closingBefore,
      closingAfter,
    ].every(Number.isSafeInteger) ||
    opening >= closing ||
    openingBefore > opening ||
    openingAfter < opening ||
    closingBefore > closing ||
    closingAfter < closing
  )
    return failure(
      "scoped report requires valid opening and closing capture times",
    );
  return ok({
    openingBoundary: input.opening.capture.providerResponseTime,
    closingBoundary: input.closing.capture.providerResponseTime,
    openingCaptureBracket: { fromMs: openingBefore, toMs: openingAfter },
    closingCaptureBracket: { fromMs: closingBefore, toMs: closingAfter },
  });
}

function scopedCoverageBounds(input: CreateHistoryAccountingReportInput): {
  readonly fromMs: number;
  readonly toMs: number;
} {
  const opening = Date.parse(input.opening.capture.providerResponseTime);
  const closing = Date.parse(input.closing.capture.providerResponseTime);
  const openingBefore = Date.parse(input.opening.capture.providerTimeBefore);
  const closingAfter = Date.parse(input.closing.capture.providerTimeAfter);
  return {
    fromMs: Math.min(openingBefore, opening + 1),
    toMs: Math.max(closingAfter, closing),
  };
}

function scopedQueryFilterIdentity(
  source: (typeof HISTORY_READ_SOURCES)[number],
): string {
  const filters =
    source === "transaction-log"
      ? { accountType: "UNIFIED" }
      : { category: "linear" };
  const result = hashCanonical({ source, filters });
  if (!result.ok)
    throw new Error("coverage filter identity could not be hashed");
  return result.value;
}

function validScopedCoverageFilter(
  checkpoint: HistoryCheckpoint,
  source: (typeof HISTORY_READ_SOURCES)[number],
  scope: HistoryStoreScope,
): boolean {
  if (
    checkpoint.source !== source ||
    !sameScopeValue(checkpoint.scope, scope) ||
    !plainRecord(checkpoint.filters) ||
    !Number.isSafeInteger(checkpoint.window?.fromMs) ||
    !Number.isSafeInteger(checkpoint.window?.toMs) ||
    checkpoint.window.fromMs < 0 ||
    checkpoint.window.toMs <= checkpoint.window.fromMs ||
    checkpoint.window.toMs - checkpoint.window.fromMs >
      HISTORY_READ_LIMITS.maxWindowMs
  )
    return false;
  const filters = checkpoint.filters;
  const field = source === "transaction-log" ? "accountType" : "category";
  const expected = source === "transaction-log" ? "UNIFIED" : "linear";
  const purposes = new Set(["backfill", "recent-refresh", "explicit-replay"]);
  const metadata = new Set([
    "purpose",
    "rangeStartMs",
    "rangeEndMs",
    "replayId",
  ]);
  if (
    filters[field] !== expected ||
    !purposes.has(String(filters.purpose)) ||
    !Number.isSafeInteger(filters.rangeStartMs) ||
    !Number.isSafeInteger(filters.rangeEndMs) ||
    filters.rangeStartMs !== checkpoint.window.fromMs ||
    filters.rangeEndMs !== checkpoint.window.toMs ||
    Object.keys(filters).some((key) => key !== field && !metadata.has(key))
  )
    return false;
  const filterHash = hashCanonical(filters);
  return filterHash.ok && filterHash.value === checkpoint.filterHash;
}

function mergeCoverageIntervals(
  intervals: readonly { readonly fromMs: number; readonly toMs: number }[],
): readonly { readonly fromMs: number; readonly toMs: number }[] {
  const merged: Array<{ fromMs: number; toMs: number }> = [];
  const sorted = [...intervals].sort(
    (a, b) => a.fromMs - b.fromMs || a.toMs - b.toMs,
  );
  for (const interval of sorted) {
    const previous = merged.at(-1);
    if (!previous || interval.fromMs > previous.toMs + 1) {
      merged.push({ ...interval });
    } else {
      previous.toMs = Math.max(previous.toMs, interval.toMs);
    }
  }
  return merged;
}

function makeCoverageWitnesses(
  input: CreateHistoryAccountingReportInput,
  selection: ScopedHistoryAccountingEvidence,
): readonly HistoryAccountingCoverageWitness[] {
  const requiredWindow = scopedCoverageBounds(input);
  const coverage = ignoreProvenIndependentScopedConflicts(
    input.coverage,
    input.conflicts,
    selection,
  );
  return HISTORY_READ_SOURCES.map((source) => {
    const candidates = coverage
      .filter(
        (checkpoint) =>
          validScopedCoverageFilter(checkpoint, source, input.scope) &&
          overlapsRange(
            checkpoint.window,
            requiredWindow.fromMs,
            requiredWindow.toMs,
          ),
      )
      .sort(
        (a, b) =>
          a.window.fromMs - b.window.fromMs ||
          a.window.toMs - b.window.toMs ||
          a.status.localeCompare(b.status) ||
          String(a.reasonCode ?? "").localeCompare(String(b.reasonCode ?? "")),
      );
    const coveredIntervals = candidates.flatMap((checkpoint) => {
      const terminal =
        checkpoint.status === "traversed" &&
        checkpoint.cursor === null &&
        checkpoint.reasonCode === null;
      return terminal &&
        Number.isSafeInteger(checkpoint.conflictCount) &&
        checkpoint.conflictCount >= 0
        ? [
            {
              fromMs: Math.max(requiredWindow.fromMs, checkpoint.window.fromMs),
              toMs: Math.min(requiredWindow.toMs, checkpoint.window.toMs),
            },
          ]
        : [];
    });
    const mergedCoveredIntervals = mergeCoverageIntervals(coveredIntervals);
    let conflictLocationsValid = true;
    for (const checkpoint of candidates) {
      const located = input.conflicts.filter(
        (conflict) =>
          conflict.source === source &&
          conflict.windows?.some(
            ({ filterHash, window }) =>
              filterHash === checkpoint.filterHash &&
              window.fromMs === checkpoint.window.fromMs &&
              window.toMs === checkpoint.window.toMs,
          ),
      );
      if (
        !Number.isSafeInteger(checkpoint.conflictCount) ||
        checkpoint.conflictCount < 0 ||
        located.length !== checkpoint.conflictCount
      )
        conflictLocationsValid = false;
    }
    const terminalComplete =
      mergedCoveredIntervals.length === 1 &&
      mergedCoveredIntervals[0]?.fromMs === requiredWindow.fromMs &&
      mergedCoveredIntervals[0]?.toMs === requiredWindow.toMs;
    const relevantIds = new Set(
      selection.conflicts
        .filter(
          (conflict) =>
            conflict.source === source && conflict.disposition === "blocking",
        )
        .flatMap((conflict) => conflict.conflictIds),
    );
    const relevantConflicts = input.conflicts
      .filter((conflict) => relevantIds.has(conflict.conflictId))
      .map(
        ({
          conflictId,
          source: conflictSource,
          eventIdentity,
          existingHash,
          incomingHash,
          reason,
        }) => ({
          conflictId,
          source: conflictSource,
          eventIdentity,
          existingHash,
          incomingHash,
          reason,
        }),
      )
      .sort((a, b) => a.conflictId.localeCompare(b.conflictId));
    return {
      source,
      requiredWindow,
      normalizedQueryFilterIdentity: scopedQueryFilterIdentity(source),
      mergedCoveredIntervals,
      terminalComplete,
      conflictLocationsValid,
      relevantConflicts,
    };
  });
}

function makeScopedLineageDependencies(
  input: CreateHistoryAccountingReportInput,
  attribution: HistoryAttributionProjection,
): Result<HistoryAccountingReportDependenciesV2["lineageDependencies"]> {
  const closeTime = input.closing.capture.providerResponseTime;
  const relevantClosed = new Set(
    attribution.observations
      .filter(
        ({ observation }) =>
          observation.fact.factKind === "closed-pnl" &&
          inEpoch(
            observation.providerEventTime,
            input.opening.capture.providerResponseTime,
            closeTime,
          ),
      )
      .map(({ observation }) => observation.observationId),
  );
  const relevantLineage = new Set<string>();
  for (const row of attribution.observations) {
    if (!relevantClosed.has(row.observation.observationId)) continue;
    if (row.ownership.status === "matched")
      relevantLineage.add(
        `${row.ownership.source.kind}\u0000${row.ownership.source.sourceId}`,
      );
    else if (row.ownership.status === "ambiguous")
      for (const candidate of row.ownership.candidates)
        relevantLineage.add(`${candidate.kind}\u0000${candidate.sourceId}`);
  }
  const output: HistoryAccountingReportDependenciesV2["lineageDependencies"][number][] =
    [];
  for (const snapshot of input.operatorSources) {
    if (
      !relevantLineage.has(
        `operator-mainnet-test\u0000${snapshot.source.sourceId}`,
      )
    )
      continue;
    const contentHash = hashCanonical(snapshot);
    if (!contentHash.ok) return contentHash;
    output.push({
      sourceKind: "operator-mainnet-test",
      sourceId: snapshot.source.sourceId,
      contentHash: contentHash.value,
    });
  }
  for (const snapshot of input.preparedSources) {
    if (!relevantLineage.has(`prepared-leg\u0000${snapshot.lineage.sourceId}`))
      continue;
    const contentHash = hashCanonical(snapshot);
    if (!contentHash.ok) return contentHash;
    output.push({
      sourceKind: "prepared-leg",
      sourceId: snapshot.lineage.sourceId,
      contentHash: contentHash.value,
    });
  }
  output.sort(
    (a, b) =>
      a.sourceKind.localeCompare(b.sourceKind) ||
      a.sourceId.localeCompare(b.sourceId),
  );
  return ok(output);
}

function makeScopedConflictDependencies(
  input: CreateHistoryAccountingReportInput,
  selection: ScopedHistoryAccountingEvidence,
): readonly unknown[] {
  const byId = new Map(
    input.conflicts.map((conflict) => [conflict.conflictId, conflict]),
  );
  return selection.conflicts
    .filter((disposition) => disposition.disposition === "blocking")
    .map((disposition) => ({
      ...disposition,
      conflicts: disposition.conflictIds.flatMap((conflictId) => {
        const conflict = byId.get(conflictId);
        return conflict === undefined
          ? []
          : [
              {
                conflictId,
                existingHash: conflict.existingHash,
                incomingHash: conflict.incomingHash,
                reason: conflict.reason,
              },
            ];
      }),
    }))
    .sort(
      (a, b) =>
        a.source.localeCompare(b.source) ||
        a.eventIdentity.localeCompare(b.eventIdentity),
    );
}

export function createScopedHistoryAccountingReport(
  input: CreateHistoryAccountingReportInput,
): Result<HistoryAccountingReconciliationReportV2> {
  try {
    const decodedScope = decodeHistoryAccountingScope(input.accountingScope);
    if (!decodedScope.ok) return decodedScope;
    const resolvedScope = resolveHistoryAccountingScope(
      decodedScope.value.policyVersion,
    );
    if (
      !resolvedScope.ok ||
      !canonicalValuesEqual(resolvedScope.value, decodedScope.value)
    )
      return failure("scoped report policy descriptor is not code-owned");
    if (
      input.scope.exchange !== "bybit" ||
      input.opening.scope.accountId !== input.scope.accountId ||
      input.closing.scope.accountId !== input.scope.accountId ||
      input.opening.scope.environment !== input.scope.environment ||
      input.closing.scope.environment !== input.scope.environment
    )
      return failure("history report scope or anchor identity is inconsistent");

    const calculation = projectScopedHistoryAccountingEpochWithSelection({
      scope: input.scope,
      accountingScope: decodedScope.value,
      opening: input.opening,
      closing: input.closing,
      observations: input.observations,
      conflicts: input.conflicts,
      coverage: input.coverage,
    });
    if (!calculation.ok) return calculation;
    const epoch = calculation.value.projection;
    let selectedEvidence = calculation.value.selection;
    if (!selectedEvidence) {
      const bounds = scopedEpochBounds(input);
      if (!bounds.ok) return bounds;
      const selection = selectScopedHistoryAccountingEvidence({
        scope: input.scope,
        accountingScope: decodedScope.value,
        epoch: bounds.value,
        observations: input.observations,
        conflicts: input.conflicts,
      });
      if (!selection.ok) return selection;
      selectedEvidence = selection.value;
    }
    // The persisted report identifies excluded observed anchor assets. Details
    // of independent outside-currency history remain in the projection used
    // for selection, but do not alter the scoped report snapshot or identity.
    const reportedAnchorExclusions = epoch.exclusions.filter(
      (exclusion) => exclusion.kind === "anchor-balance",
    );
    const anchorExclusionCount =
      epoch.exclusionCount - selectedEvidence.exclusionCount;
    if (
      !Number.isSafeInteger(anchorExclusionCount) ||
      anchorExclusionCount < reportedAnchorExclusions.length
    )
      return failure("scoped report exclusion counts are inconsistent");
    const reportEpoch: HistoryAccountingEpochProjectionV2 = {
      ...epoch,
      conflictDispositions: epoch.conflictDispositions.filter(
        (conflict) => conflict.disposition === "blocking",
      ),
      exclusions: reportedAnchorExclusions,
      exclusionCount: anchorExclusionCount,
      exclusionsTruncated:
        anchorExclusionCount > reportedAnchorExclusions.length,
    };
    if (
      !canonicalValuesEqual(
        selectedEvidence.identities,
        epoch.selectedEvidenceIdentities,
      )
    )
      return failure(
        "scoped report selection differs from its epoch projection",
      );

    const attribution = attributeHistoryObservations({
      observations: selectedEvidence.selectedObservations,
      operatorSources: input.operatorSources,
      preparedSources: input.preparedSources,
    });
    if (!attribution.ok) return attribution;
    const relevantClosedIds = new Set(
      selectedEvidence.selectedObservations
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
    for (const observation of selectedEvidence.selectedObservations) {
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
      (a, b) =>
        a.providerEventTime.localeCompare(b.providerEventTime) ||
        a.transactionId.localeCompare(b.transactionId),
    );

    const lineage = makeScopedLineageDependencies(input, attribution.value);
    if (!lineage.ok) return lineage;
    const dependencies: HistoryAccountingReportDependenciesV2 = {
      schemaVersion: "history-accounting-dependencies/v2",
      scope: input.scope,
      accountingScope: decodedScope.value,
      accountingScopeHash: decodedScope.value.scopeHash,
      epoch: epoch.epoch,
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
      sourceDependencies: selectedEvidence.identities.map(
        ({ observationId, source, eventIdentity, contentHash }) => ({
          observationId,
          source,
          eventIdentity,
          contentHash,
        }),
      ),
      coverageWitness: makeCoverageWitnesses(input, selectedEvidence),
      conflictDependencies: makeScopedConflictDependencies(
        input,
        selectedEvidence,
      ),
      lineageDependencies: lineage.value,
      settlementCurrencyBySymbol: input.settlementCurrencyBySymbol ?? {},
      positionUplEvidence: input.positionUplEvidence ?? null,
      performanceSelectionConflicts: performance.value.selectionConflicts,
    };
    const dependencyHash = hashCanonical(dependencies);
    if (!dependencyHash.ok) return dependencyHash;
    const evaluatedAt = input.closing.capture
      .providerResponseTime as UtcTimestamp;
    const totalPerpUpl = input.closing.totals.totalPerpUPL;
    const amount =
      totalPerpUpl.state === "known" ? totalPerpUpl.value.toString() : null;
    const withoutId = {
      schemaVersion: "history-accounting-reconciliation-report/v2" as const,
      scope: input.scope,
      accountingScope: decodedScope.value,
      accountingScopeHash: decodedScope.value.scopeHash,
      evaluatedAt,
      status: epoch.readiness,
      dependencyHash: dependencyHash.value,
      dependencies,
      epoch: reportEpoch,
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
    const identity = hashCanonical({
      schemaVersion: withoutId.schemaVersion,
      scope: withoutId.scope,
      accountingScope: withoutId.accountingScope,
      dependencyHash: withoutId.dependencyHash,
    });
    if (!identity.ok) return identity;
    const reportId = `history-accounting-report:${identity.value.slice(7)}`;
    const contentHash = hashCanonical({ reportId, ...withoutId });
    if (!contentHash.ok) return contentHash;
    const report = { reportId, ...withoutId, contentHash: contentHash.value };
    return isScopedReportDomainValue(report)
      ? ok(report)
      : failure("scoped report payload failed application validation");
  } catch {
    return fail(
      domainError(
        "INVALID_ACCOUNTING",
        "scoped history accounting report could not be calculated",
      ),
    );
  }
}
