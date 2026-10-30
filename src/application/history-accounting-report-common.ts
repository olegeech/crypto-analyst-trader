import { domainError } from "../domain/shared/errors.js";
import { fail, type Result } from "../domain/shared/result.js";
import { DecimalValue } from "../domain/shared/decimal.js";
import { parseUtcTimestamp } from "../domain/shared/time.js";

export function failure(message: string): Result<never> {
  return fail(domainError("INVALID_ACCOUNTING", message));
}

export type UnknownRecord = Record<string, unknown>;

export function plainRecord(value: unknown): value is UnknownRecord {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) =>
      Object.hasOwn(descriptor, "value"),
    )
  );
}

export function recordWithKeys(
  value: unknown,
  keys: readonly string[],
): value is UnknownRecord {
  return (
    plainRecord(value) &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function isNullableString(value: unknown): value is string | null {
  return value === null || isString(value);
}

export function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && parseUtcTimestamp(value).ok;
}

export function isDecimal(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = DecimalValue.fromString(value);
  return parsed.ok && parsed.value.toString() === value;
}

export function isNullableDecimal(value: unknown): value is string | null {
  return value === null || isDecimal(value);
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

export function isScope(value: unknown): value is UnknownRecord {
  return (
    recordWithKeys(value, ["exchange", "environment", "accountId"]) &&
    value.exchange === "bybit" &&
    ["demo", "testnet", "mainnet"].includes(String(value.environment)) &&
    typeof value.accountId === "string" &&
    /^sha256:[0-9a-f]{64}$/u.test(value.accountId)
  );
}

export function sameScopeValue(left: unknown, right: unknown): boolean {
  return (
    isScope(left) &&
    isScope(right) &&
    left.exchange === right.exchange &&
    left.environment === right.environment &&
    left.accountId === right.accountId
  );
}

export function isLineageSource(value: unknown): boolean {
  return (
    recordWithKeys(value, ["kind", "sourceId"]) &&
    (value.kind === "operator-mainnet-test" || value.kind === "prepared-leg") &&
    typeof value.sourceId === "string" &&
    value.sourceId.length > 0
  );
}

export function isCurrencyBridge(value: unknown): boolean {
  if (
    !recordWithKeys(value, [
      "currency",
      "openingBalance",
      "transactionChange",
      "transferChange",
      "expectedClosingBalance",
      "closingBalance",
      "unexplainedDrift",
    ]) ||
    typeof value.currency !== "string" ||
    value.currency.length === 0
  )
    return false;
  const amounts = [
    value.openingBalance,
    value.transactionChange,
    value.transferChange,
    value.expectedClosingBalance,
    value.closingBalance,
    value.unexplainedDrift,
  ];
  return amounts.every(isNullableDecimal);
}

export function isPerformanceProjection(
  value: unknown,
  scope: unknown,
): boolean {
  if (
    !recordWithKeys(value, [
      "schemaVersion",
      "scope",
      "ownedClosedPnl",
      "notStrategyPerformance",
      "ownedRunSymbolDays",
      "ownedRunDays",
      "accountDays",
      "positionUpl",
      "selectionConflicts",
    ]) ||
    value.schemaVersion !== "history-accounting-performance-projection/v1" ||
    !sameScopeValue(value.scope, scope) ||
    !Array.isArray(value.ownedClosedPnl) ||
    !Array.isArray(value.notStrategyPerformance) ||
    !Array.isArray(value.ownedRunSymbolDays) ||
    !Array.isArray(value.ownedRunDays) ||
    !Array.isArray(value.accountDays) ||
    !Array.isArray(value.selectionConflicts)
  )
    return false;

  const ownedRowsValid = value.ownedClosedPnl.every(
    (row: unknown) =>
      recordWithKeys(row, [
        "observationId",
        "source",
        "symbol",
        "utcDay",
        "currency",
        "reportedClosedPnl",
        "status",
        "reasonCodes",
        "feeFunding",
      ]) &&
      typeof row.observationId === "string" &&
      isLineageSource(row.source) &&
      typeof row.symbol === "string" &&
      /^\d{4}-\d{2}-\d{2}$/u.test(String(row.utcDay)) &&
      isNullableString(row.currency) &&
      isNullableDecimal(row.reportedClosedPnl) &&
      ["complete", "partial", "unknown"].includes(String(row.status)) &&
      isStringArray(row.reasonCodes) &&
      recordWithKeys(row.feeFunding, [
        "openFee",
        "closeFee",
        "fundingFee",
        "currency",
        "status",
        "includedInReportedClosedPnl",
      ]) &&
      isNullableDecimal(row.feeFunding.openFee) &&
      isNullableDecimal(row.feeFunding.closeFee) &&
      isNullableDecimal(row.feeFunding.fundingFee) &&
      isNullableString(row.feeFunding.currency) &&
      ["complete", "incomplete"].includes(String(row.feeFunding.status)) &&
      row.feeFunding.includedInReportedClosedPnl === false,
  );
  const nonStrategyRowsValid = value.notStrategyPerformance.every(
    (row: unknown) =>
      recordWithKeys(row, [
        "observationId",
        "symbol",
        "utcDay",
        "currency",
        "reportedClosedPnl",
        "ownership",
        "reason",
        "candidates",
      ]) &&
      typeof row.observationId === "string" &&
      typeof row.symbol === "string" &&
      /^\d{4}-\d{2}-\d{2}$/u.test(String(row.utcDay)) &&
      isNullableString(row.currency) &&
      isNullableDecimal(row.reportedClosedPnl) &&
      ["unmatched", "ambiguous"].includes(String(row.ownership)) &&
      ["NO_EXACT_LINEAGE", "MULTIPLE_EXACT_LINEAGES"].includes(
        String(row.reason),
      ) &&
      Array.isArray(row.candidates) &&
      row.candidates.every(isLineageSource),
  );
  const groupsValid = [
    ...value.ownedRunSymbolDays,
    ...value.ownedRunDays,
    ...value.accountDays,
  ].every(
    (row: unknown) =>
      recordWithKeys(row, [
        "level",
        "source",
        "symbol",
        "utcDay",
        "currency",
        "amount",
        "status",
        "reasonCodes",
        "observationIds",
      ]) &&
      ["account-day", "owned-run-day", "owned-run-symbol-day"].includes(
        String(row.level),
      ) &&
      (row.source === null || isLineageSource(row.source)) &&
      isNullableString(row.symbol) &&
      /^\d{4}-\d{2}-\d{2}$/u.test(String(row.utcDay)) &&
      isNullableString(row.currency) &&
      isNullableDecimal(row.amount) &&
      ["complete", "partial", "unknown"].includes(String(row.status)) &&
      isStringArray(row.reasonCodes) &&
      isStringArray(row.observationIds),
  );
  const positionUplValid =
    value.positionUpl === null ||
    (recordWithKeys(value.positionUpl, ["scope", "asOf", "positions"]) &&
      sameScopeValue(value.positionUpl.scope, scope) &&
      isTimestamp(value.positionUpl.asOf) &&
      Array.isArray(value.positionUpl.positions) &&
      value.positionUpl.positions.every(
        (position: unknown) =>
          plainRecord(position) &&
          [
            "positionId",
            "symbol",
            "asOf",
            "unrealizedPnl",
            "currency",
            "status",
            "allocation",
            "executionObservationIds",
          ].every((key) => Object.hasOwn(position, key)) &&
          Object.keys(position).every(
            (key) => key !== "source" || isLineageSource(position.source),
          ) &&
          typeof position.positionId === "string" &&
          typeof position.symbol === "string" &&
          isTimestamp(position.asOf) &&
          isDecimal(position.unrealizedPnl) &&
          isNullableString(position.currency) &&
          ["known", "unknown"].includes(String(position.status)) &&
          ["account-level-unallocated", "owned-run"].includes(
            String(position.allocation),
          ) &&
          isStringArray(position.executionObservationIds),
      ));
  const conflictsValid = value.selectionConflicts.every((conflict: unknown) => {
    if (!plainRecord(conflict) || typeof conflict.kind !== "string")
      return false;
    if (conflict.kind === "transaction-identity-conflict")
      return (
        recordWithKeys(conflict, [
          "kind",
          "transactionId",
          "observationIds",
          "conflictIds",
        ]) &&
        typeof conflict.transactionId === "string" &&
        isStringArray(conflict.observationIds) &&
        isStringArray(conflict.conflictIds)
      );
    return (
      conflict.kind === "closed-pnl-revision-conflict" &&
      recordWithKeys(conflict, ["kind", "groupingKey", "observationIds"]) &&
      plainRecord(conflict.groupingKey) &&
      isStringArray(conflict.observationIds)
    );
  });
  return (
    ownedRowsValid &&
    nonStrategyRowsValid &&
    groupsValid &&
    positionUplValid &&
    conflictsValid
  );
}

export function overlapsRange(
  window: { readonly fromMs: number; readonly toMs: number },
  from: number,
  to: number,
): boolean {
  return window.fromMs <= to && window.toMs >= from;
}
