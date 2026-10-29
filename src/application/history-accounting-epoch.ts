import {
  indexHistoryObservationsByIdentity,
  normalizeHistoryTransaction,
  selectCanonicalHistoryEvidence,
  type HistoryAccountingSelectionConflict,
} from "./history-accounting-normalization.js";
import { DecimalValue } from "../domain/shared/decimal.js";
import type { HistoryAccountingWalletAnchor } from "../ports/history-accounting-anchor-store.js";
import type {
  HistoryCheckpoint,
  HistoryConflictSummary,
  HistoryStoredObservation,
  HistoryStoreScope,
} from "../ports/history-store.js";
import {
  HISTORY_READ_LIMITS,
  HISTORY_READ_SOURCES,
} from "../ports/history-read.js";
import { ok, type Result } from "../domain/shared/result.js";
import { parseUtcTimestamp } from "../domain/shared/time.js";
import {
  createAccountBinding,
  createAccountCredentialPosture,
} from "../domain/account/account-evidence-bundle.js";
import { hashCanonical } from "../domain/identity/canonical-serialization.js";
import { isAuthenticatedWalletAnchorCapture } from "../ports/history-accounting-anchor-capture-provenance.js";
import type {
  ClosedPnlHistorySourceFact,
  ExecutionHistorySourceFact,
  TransactionHistorySourceFact,
} from "../domain/accounting/history-source-fact.js";

export type HistoryAccountingEpochReasonCode =
  | "INVALID_INPUT"
  | "ANCHOR_KIND_MISMATCH"
  | "ANCHOR_SCOPE_MISMATCH"
  | "ANCHOR_CAPTURE_INVALID"
  | "ANCHOR_TIME_INVALID"
  | "ANCHOR_EPOCH_INVALID"
  | "HISTORY_SCOPE_MISMATCH"
  | "INVALID_HISTORY_EVIDENCE"
  | "HISTORY_COVERAGE_GAP"
  | "HISTORY_COVERAGE_FILTER_INCOMPATIBLE"
  | "HISTORY_COVERAGE_CONFLICT"
  | "HISTORY_SOURCE_CONFLICT"
  | "TRANSACTION_IDENTITY_CONFLICT"
  | "CLOSED_PNL_REVISION_CONFLICT"
  | "ANCHOR_BOUNDARY_EVENT_AMBIGUOUS"
  | "UNKNOWN_TRANSACTION_TYPE"
  | "UNKNOWN_TRANSACTION_CURRENCY"
  | "UNKNOWN_TRANSACTION_CHANGE"
  | "UNSUPPORTED_TRANSACTION_CATEGORY"
  | "TRANSACTION_COMPONENTS_INCOMPLETE"
  | "TRANSACTION_COMPONENT_MISMATCH"
  | "TRANSACTION_EXECUTION_MISMATCH"
  | "CLOSED_PNL_EXECUTION_MISMATCH"
  | "UNSUPPORTED_CURRENCY"
  | "UNSUPPORTED_BONUS_MOVEMENT"
  | "UNSUPPORTED_BALANCE_SEMANTICS"
  | "MISSING_COIN_BALANCE"
  | "DUPLICATE_COIN_BALANCE"
  | "UNEXPLAINED_DRIFT";

export interface HistoryAccountingEpochGap {
  readonly fromMs: number;
  readonly toMs: number;
}

export interface HistoryAccountingEpochSourceCoverage {
  readonly source: (typeof HISTORY_READ_SOURCES)[number];
  readonly covered: boolean;
  readonly gaps: readonly HistoryAccountingEpochGap[];
}

export interface HistoryAccountingEpochCurrencyBridge {
  readonly currency: string;
  readonly openingBalance: string | null;
  /** Sum of unique observed native UTA changes; null means it is incomplete. */
  readonly transactionChange: string | null;
  /** Transfers are included above and separately visible; never strategy profit. */
  readonly transferChange: string | null;
  readonly expectedClosingBalance: string | null;
  readonly closingBalance: string | null;
  /** Closing minus (opening plus transaction change); null when not computable. */
  readonly unexplainedDrift: string | null;
}

export interface HistoryAccountingEpochProjection {
  readonly schemaVersion: "history-accounting-epoch-projection/v1";
  readonly status: "RECONCILED" | "NOT_READY";
  readonly readiness: "ACCOUNTING_READY" | "NOT_READY";
  readonly scope: HistoryStoreScope;
  readonly epoch: {
    readonly openingAnchorId: string;
    readonly closingAnchorId: string;
    readonly openingBoundary: string;
    readonly closingBoundary: string;
    readonly transactionWindow: "(opening, closing]";
  };
  readonly sourceCoverage: readonly HistoryAccountingEpochSourceCoverage[];
  readonly currencies: readonly HistoryAccountingEpochCurrencyBridge[];
  readonly selectedTransactionCount: number;
  readonly reasonCodes: readonly HistoryAccountingEpochReasonCode[];
}

export interface ProjectHistoryAccountingEpochInput {
  readonly scope: HistoryStoreScope;
  readonly opening: HistoryAccountingWalletAnchor;
  readonly closing: HistoryAccountingWalletAnchor;
  readonly observations: readonly HistoryStoredObservation[];
  readonly conflicts: readonly HistoryConflictSummary[];
  readonly coverage: readonly HistoryCheckpoint[];
}

interface BalanceIndex {
  readonly values: Map<string, DecimalValue | null>;
}

interface NormalizedRow {
  readonly category: string | null;
  readonly movementKind: "trade" | "funding" | "transfer" | "unknown";
  readonly currency: string | null;
  readonly change: DecimalValue | null;
  readonly bonusChange: DecimalValue | null;
  readonly componentCheck: "matched" | "mismatched" | "incomplete";
}

const ORIGINS: Readonly<Record<string, string>> = {
  demo: "https://api-demo.bybit.com",
  testnet: "https://api-testnet.bybit.com",
  mainnet: "https://api.bybit.com",
};
const SHA256 = /^sha256:[a-f0-9]{64}$/u;

function plainRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every((d) =>
      Object.hasOwn(d, "value"),
    )
  );
}

function sameScope(left: HistoryStoreScope, right: HistoryStoreScope): boolean {
  return (
    left.exchange === right.exchange &&
    left.environment === right.environment &&
    left.accountId === right.accountId
  );
}

function timestampMs(value: unknown): number | undefined {
  const parsed = parseUtcTimestamp(value);
  if (!parsed.ok) return undefined;
  const epoch = Date.parse(parsed.value);
  return Number.isSafeInteger(epoch) ? epoch : undefined;
}

function addReason(
  reasons: Set<HistoryAccountingEpochReasonCode>,
  reason: HistoryAccountingEpochReasonCode,
): void {
  reasons.add(reason);
}

function validateAnchor(
  value: HistoryAccountingWalletAnchor,
  expectedKind: "opening" | "closing",
  scope: HistoryStoreScope,
  reasons: Set<HistoryAccountingEpochReasonCode>,
): number | undefined {
  if (
    !plainRecord(value) ||
    value.schemaVersion !== "history-accounting-wallet-anchor/v1" ||
    !isAuthenticatedWalletAnchorCapture(value)
  ) {
    addReason(reasons, "ANCHOR_CAPTURE_INVALID");
    return undefined;
  }
  if (!plainRecord(value.capture) || !plainRecord(value.scope)) {
    addReason(reasons, "ANCHOR_CAPTURE_INVALID");
    return undefined;
  }
  if (value.kind !== expectedKind) addReason(reasons, "ANCHOR_KIND_MISMATCH");
  if (!sameScope(value.scope, scope))
    addReason(reasons, "ANCHOR_SCOPE_MISMATCH");
  const binding = createAccountBinding(value.accountBinding);
  const posture = createAccountCredentialPosture(value.credentialPosture);
  if (
    !binding.ok ||
    !posture.ok ||
    !plainRecord(scope) ||
    scope.exchange !== "bybit" ||
    !Object.hasOwn(ORIGINS, scope.environment) ||
    !SHA256.test(scope.accountId) ||
    (binding.ok &&
      (binding.value.exchange !== "bybit" ||
        binding.value.environment !== scope.environment ||
        binding.value.origin !== ORIGINS[scope.environment] ||
        binding.value.accountIdentityHash !== scope.accountId ||
        binding.value.identityVerified !== true))
  )
    addReason(reasons, "ANCHOR_SCOPE_MISMATCH");
  if (
    typeof value.contentHash !== "string" ||
    !SHA256.test(value.contentHash) ||
    typeof value.anchorId !== "string" ||
    value.anchorId.length === 0 ||
    value.capture.identityEndpoint !== "/v5/user/query-api" ||
    value.capture.walletEndpoint !== "/v5/account/wallet-balance" ||
    value.capture.accountType !== "UNIFIED"
  )
    addReason(reasons, "ANCHOR_CAPTURE_INVALID");

  const before = timestampMs(value.capture.providerTimeBefore);
  const boundary = timestampMs(value.capture.providerResponseTime);
  const after = timestampMs(value.capture.providerTimeAfter);
  const collectionStarted = timestampMs(value.capture.collectionStartedAt);
  const identityAt = timestampMs(value.capture.identityObservedAt);
  const collectionEnded = timestampMs(value.capture.collectionEndedAt);
  const authenticatedAt = timestampMs(value.accountBinding.authenticatedAt);
  const recordedAt = timestampMs(value.recordedAt);
  if (
    before === undefined ||
    boundary === undefined ||
    after === undefined ||
    collectionStarted === undefined ||
    identityAt === undefined ||
    collectionEnded === undefined ||
    authenticatedAt === undefined ||
    recordedAt === undefined ||
    before > boundary ||
    before > identityAt ||
    identityAt > boundary ||
    boundary > after ||
    before > collectionStarted ||
    collectionStarted > identityAt ||
    collectionEnded < boundary ||
    collectionEnded > after ||
    boundary > collectionEnded ||
    recordedAt < collectionEnded
  ) {
    addReason(reasons, "ANCHOR_TIME_INVALID");
    return undefined;
  }
  return boundary;
}

function readBalances(
  anchor: HistoryAccountingWalletAnchor,
  reasons: Set<HistoryAccountingEpochReasonCode>,
): BalanceIndex {
  const values = new Map<string, DecimalValue | null>();
  if (!plainRecord(anchor) || !Array.isArray(anchor.assets)) {
    addReason(reasons, "ANCHOR_CAPTURE_INVALID");
    addReason(reasons, "MISSING_COIN_BALANCE");
    return { values };
  }
  for (const rawAsset of anchor.assets) {
    if (
      !plainRecord(rawAsset) ||
      typeof rawAsset.coin !== "string" ||
      rawAsset.coin.length === 0
    ) {
      addReason(reasons, "ANCHOR_CAPTURE_INVALID");
      continue;
    }
    const coin = rawAsset.coin;
    if (values.has(coin)) {
      values.set(coin, null);
      addReason(reasons, "DUPLICATE_COIN_BALANCE");
      continue;
    }
    const balance = rawAsset.walletBalance;
    const parsedBalance =
      plainRecord(balance) &&
      balance.state === "known" &&
      balance.unit === "coin" &&
      balance.value instanceof DecimalValue &&
      !balance.value.isNegative()
        ? balance.value
        : null;
    values.set(coin, parsedBalance);
    if (parsedBalance === null) addReason(reasons, "MISSING_COIN_BALANCE");
    if (coin !== "USDT") addReason(reasons, "UNSUPPORTED_CURRENCY");

    for (const key of [
      "bonus",
      "borrowAmount",
      "spotBorrow",
      "accruedInterest",
    ] as const) {
      const fact = rawAsset[key];
      if (
        plainRecord(fact) &&
        fact.state === "known" &&
        fact.unit === "coin" &&
        fact.value instanceof DecimalValue
      ) {
        if (!fact.value.isZero())
          addReason(reasons, "UNSUPPORTED_BALANCE_SEMANTICS");
      } else {
        addReason(reasons, "UNSUPPORTED_BALANCE_SEMANTICS");
      }
    }
  }
  if (!values.has("USDT")) addReason(reasons, "MISSING_COIN_BALANCE");
  return { values };
}

function compatibleFilters(checkpoint: HistoryCheckpoint): boolean {
  if (!plainRecord(checkpoint.filters)) return false;
  const filter = checkpoint.filters;
  const required =
    checkpoint.source === "transaction-log" ? "accountType" : "category";
  const expected =
    checkpoint.source === "transaction-log" ? "UNIFIED" : "linear";
  const allowedMetadata = new Set([
    "purpose",
    "rangeStartMs",
    "rangeEndMs",
    "replayId",
  ]);
  const purposes = new Set(["backfill", "recent-refresh", "explicit-replay"]);
  if (
    filter[required] !== expected ||
    !purposes.has(String(filter.purpose)) ||
    !Number.isSafeInteger(filter.rangeStartMs) ||
    !Number.isSafeInteger(filter.rangeEndMs) ||
    typeof checkpoint.filterHash !== "string"
  )
    return false;
  for (const key of Object.keys(filter))
    if (key !== required && !allowedMetadata.has(key)) return false;
  if (filter.rangeStartMs !== checkpoint.window.fromMs) return false;
  if (filter.rangeEndMs !== checkpoint.window.toMs) return false;
  const expectedHash = hashCanonical(filter);
  return expectedHash.ok && expectedHash.value === checkpoint.filterHash;
}

function projectSourceCoverage(
  source: (typeof HISTORY_READ_SOURCES)[number],
  checkpoints: readonly HistoryCheckpoint[],
  scope: HistoryStoreScope,
  from: number,
  to: number,
  reasons: Set<HistoryAccountingEpochReasonCode>,
): HistoryAccountingEpochSourceCoverage {
  const intervals: { from: number; to: number }[] = [];
  for (const checkpoint of checkpoints) {
    if (checkpoint.source !== source) continue;
    const start = checkpoint.window?.fromMs;
    const end = checkpoint.window?.toMs;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end <= start
    ) {
      addReason(reasons, "HISTORY_COVERAGE_FILTER_INCOMPATIBLE");
      continue;
    }
    if (end < from || start > to) continue;
    if (end - start > HISTORY_READ_LIMITS.maxWindowMs) {
      addReason(reasons, "HISTORY_COVERAGE_FILTER_INCOMPATIBLE");
      continue;
    }
    if (!sameScope(checkpoint.scope, scope)) {
      addReason(reasons, "HISTORY_SCOPE_MISMATCH");
      continue;
    }
    if (!compatibleFilters(checkpoint)) {
      addReason(reasons, "HISTORY_COVERAGE_FILTER_INCOMPATIBLE");
      continue;
    }
    if (
      checkpoint.status !== "traversed" ||
      checkpoint.cursor !== null ||
      checkpoint.reasonCode !== null
    ) {
      continue;
    }
    if (
      !Number.isSafeInteger(checkpoint.conflictCount) ||
      checkpoint.conflictCount < 0
    ) {
      addReason(reasons, "HISTORY_COVERAGE_FILTER_INCOMPATIBLE");
      continue;
    }
    const clippedFrom = Math.max(from, start);
    const clippedTo = Math.min(to, end);
    if (clippedFrom <= clippedTo)
      intervals.push({ from: clippedFrom, to: clippedTo });
  }
  intervals.sort((left, right) => left.from - right.from || left.to - right.to);
  const gaps: HistoryAccountingEpochGap[] = [];
  let coveredThrough = from - 1;
  for (const interval of intervals) {
    if (interval.from > coveredThrough + 1) {
      gaps.push({ fromMs: coveredThrough + 1, toMs: interval.from - 1 });
    }
    coveredThrough = Math.max(coveredThrough, interval.to);
  }
  if (coveredThrough < to) gaps.push({ fromMs: coveredThrough + 1, toMs: to });
  if (gaps.length > 0) addReason(reasons, "HISTORY_COVERAGE_GAP");
  return Object.freeze({
    source,
    covered: gaps.length === 0,
    gaps: Object.freeze(gaps),
  });
}

function checkpointConflictCountsAreLocated(
  checkpoints: readonly HistoryCheckpoint[],
  conflicts: readonly HistoryConflictSummary[],
  scope: HistoryStoreScope,
  from: number,
  to: number,
  reasons: Set<HistoryAccountingEpochReasonCode>,
): void {
  for (const checkpoint of checkpoints) {
    if (
      !sameScope(checkpoint.scope, scope) ||
      !Number.isSafeInteger(checkpoint.window?.fromMs) ||
      !Number.isSafeInteger(checkpoint.window?.toMs) ||
      checkpoint.window.toMs < from ||
      checkpoint.window.fromMs > to ||
      !compatibleFilters(checkpoint)
    )
      continue;
    if (
      !Number.isSafeInteger(checkpoint.conflictCount) ||
      checkpoint.conflictCount < 0
    ) {
      addReason(reasons, "HISTORY_COVERAGE_FILTER_INCOMPATIBLE");
      continue;
    }
    const associated = conflicts.filter(
      (conflict) =>
        conflict.source === checkpoint.source &&
        conflict.windows?.some(
          ({ filterHash, window }) =>
            filterHash === checkpoint.filterHash &&
            window.fromMs === checkpoint.window.fromMs &&
            window.toMs === checkpoint.window.toMs,
        ),
    );
    if (associated.length !== checkpoint.conflictCount)
      addReason(reasons, "HISTORY_COVERAGE_CONFLICT");
  }
}

function inRange(time: number, from: number, to: number): boolean {
  return time > from && time <= to;
}

function anchorBracketContains(
  time: number,
  anchor: HistoryAccountingWalletAnchor,
): boolean {
  const before = timestampMs(anchor.capture.providerTimeBefore);
  const after = timestampMs(anchor.capture.providerTimeAfter);
  return (
    before !== undefined &&
    after !== undefined &&
    time >= before &&
    time <= after
  );
}

function emptyCurrencyRow(currency: string) {
  return {
    currency,
    openingBalance: null as string | null,
    transactionChange: null as string | null,
    transferChange: null as string | null,
    expectedClosingBalance: null as string | null,
    closingBalance: null as string | null,
    unexplainedDrift: null as string | null,
  };
}

function projectCurrencies(
  opening: BalanceIndex,
  closing: BalanceIndex,
  transactions: readonly NormalizedRow[],
  reasons: Set<HistoryAccountingEpochReasonCode>,
): readonly HistoryAccountingEpochCurrencyBridge[] {
  const currencies = new Set<string>([
    ...opening.values.keys(),
    ...closing.values.keys(),
  ]);
  for (const transaction of transactions)
    if (transaction.currency !== null) currencies.add(transaction.currency);

  const rows = [...currencies].sort().map((currency) => {
    const row = emptyCurrencyRow(currency);
    const openingBalance = opening.values.get(currency);
    const closingBalance = closing.values.get(currency);
    if (
      openingBalance === undefined ||
      closingBalance === undefined ||
      openingBalance === null ||
      closingBalance === null
    ) {
      addReason(reasons, "MISSING_COIN_BALANCE");
    } else {
      row.openingBalance = openingBalance.toString();
      row.closingBalance = closingBalance.toString();
    }

    const matching = transactions.filter(
      (transaction) => transaction.currency === currency,
    );
    const unknownChange = matching.some(
      (transaction) => transaction.change === null,
    );
    const knownChanges = matching.flatMap((transaction) =>
      transaction.change === null ? [] : [transaction.change],
    );
    const transferRows = matching.filter(
      (transaction) => transaction.movementKind === "transfer",
    );
    const unknownTransfer =
      transferRows.some((transaction) => transaction.change === null) ||
      matching.some((transaction) => transaction.movementKind === "unknown");
    if (!unknownChange) {
      const total = knownChanges.reduce(
        (sum, change) => sum.add(change),
        decimalZero(),
      );
      row.transactionChange = total.toString();
      if (!unknownTransfer) {
        row.transferChange = transferRows
          .reduce(
            (sum, transaction) => sum.add(transaction.change ?? decimalZero()),
            decimalZero(),
          )
          .toString();
      }
      if (row.openingBalance !== null && row.closingBalance !== null) {
        const expected = openingBalance!.add(total);
        row.expectedClosingBalance = expected.toString();
        const drift = closingBalance!.subtract(expected);
        row.unexplainedDrift = drift.toString();
        if (!drift.isZero()) addReason(reasons, "UNEXPLAINED_DRIFT");
      }
    }
    if (currency !== "USDT") addReason(reasons, "UNSUPPORTED_CURRENCY");
    return Object.freeze(row);
  });

  if (transactions.some((transaction) => transaction.currency === null)) {
    addReason(reasons, "UNKNOWN_TRANSACTION_CURRENCY");
  }
  return Object.freeze(rows);
}

function decimalZero(): DecimalValue {
  const result = DecimalValue.fromString("0");
  if (!result.ok) throw new Error("decimal zero constant unavailable");
  return result.value;
}

function exactDecimalMatch(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return false;
  const leftValue = DecimalValue.fromString(left);
  const rightValue = DecimalValue.fromString(right);
  return (
    leftValue.ok &&
    rightValue.ok &&
    leftValue.value.compare(rightValue.value) === 0
  );
}

function isTradeTransaction(fact: TransactionHistorySourceFact): boolean {
  const type = (fact.type ?? "").trim().toUpperCase();
  return type === "TRADE" || type === "TRADE_REBATE";
}

function executionMatchesTransaction(
  execution: ExecutionHistorySourceFact,
  transaction: TransactionHistorySourceFact,
): boolean {
  // Bybit documents transaction `qty` as the per-trade quantity; `size` is
  // the remaining position after the trade. It also names the two IDs
  // differently (`tradeId` vs `execId`), so pair only on a unique exact
  // order/fill/economics tuple instead of assuming those IDs are aliases.
  return (
    execution.execType === "Trade" &&
    transaction.orderId !== null &&
    transaction.orderId === execution.orderId &&
    transaction.category === execution.category &&
    transaction.symbol === execution.symbol &&
    transaction.side === execution.side &&
    exactDecimalMatch(transaction.qty, execution.execQty) &&
    exactDecimalMatch(transaction.tradePrice, execution.execPrice) &&
    transaction.currency !== null &&
    transaction.currency === execution.feeCurrency &&
    exactDecimalMatch(transaction.fee, execution.execFee) &&
    (execution.execFeeV2 === null ||
      exactDecimalMatch(execution.execFeeV2, "0")) &&
    execution.extraFees === null
  );
}

function verifyExecutionAndCloseEvidence(
  transactions: readonly TransactionHistorySourceFact[],
  epochExecutions: readonly ExecutionHistorySourceFact[],
  supportingExecutions: readonly ExecutionHistorySourceFact[],
  closedPnlRows: readonly ClosedPnlHistorySourceFact[],
  reasons: Set<HistoryAccountingEpochReasonCode>,
): void {
  const tradeTransactions = transactions.filter(isTradeTransaction);
  const tradeExecutions = epochExecutions.filter(
    (execution) => execution.execType === "Trade",
  );

  if (epochExecutions.some((execution) => execution.execType !== "Trade"))
    addReason(reasons, "TRANSACTION_EXECUTION_MISMATCH");
  for (const execution of tradeExecutions) {
    const matchingTransactions = tradeTransactions.filter((transaction) =>
      executionMatchesTransaction(execution, transaction),
    );
    if (matchingTransactions.length !== 1)
      addReason(reasons, "TRANSACTION_EXECUTION_MISMATCH");
  }
  for (const transaction of tradeTransactions) {
    const matchingExecutions = tradeExecutions.filter((execution) =>
      executionMatchesTransaction(execution, transaction),
    );
    if (matchingExecutions.length !== 1)
      addReason(reasons, "TRANSACTION_EXECUTION_MISMATCH");
  }

  for (const closedPnl of closedPnlRows) {
    const closeExecutions = supportingExecutions.filter(
      (execution) =>
        execution.execType === "Trade" &&
        execution.orderId === closedPnl.orderId &&
        execution.category === closedPnl.category &&
        execution.symbol === closedPnl.symbol,
    );
    if (
      closeExecutions.length === 0 ||
      closedPnl.closeFee === null ||
      closedPnl.fillCount === null ||
      !/^\d+$/u.test(closedPnl.fillCount) ||
      Number(closedPnl.fillCount) !== closeExecutions.length ||
      closeExecutions.some((execution) => execution.execFee === null)
    ) {
      addReason(reasons, "CLOSED_PNL_EXECUTION_MISMATCH");
      continue;
    }
    const closeExecutionFee = closeExecutions
      .map((execution) => DecimalValue.fromString(execution.execFee!))
      .reduce<Result<DecimalValue>>((sum, fee) => {
        if (!sum.ok) return sum;
        if (!fee.ok) return fee;
        return ok(sum.value.add(fee.value));
      }, ok(decimalZero()));
    if (
      !closeExecutionFee.ok ||
      !exactDecimalMatch(closeExecutionFee.value.toString(), closedPnl.closeFee)
    )
      addReason(reasons, "CLOSED_PNL_EXECUTION_MISMATCH");
  }
}

function conflictIsInEpoch(
  conflict: HistoryConflictSummary,
  observationsByIdentity: ReturnType<typeof indexHistoryObservationsByIdentity>,
  opening: number,
  closing: number,
  openingAnchor: HistoryAccountingWalletAnchor,
  closingAnchor: HistoryAccountingWalletAnchor,
): boolean {
  const matched =
    observationsByIdentity.get(conflict.source)?.get(conflict.eventIdentity) ??
    [];
  if (matched.length === 0) {
    if (!conflict.windows || conflict.windows.length === 0) return true;
    return conflict.windows.some(
      ({ window }) => window.fromMs <= closing && window.toMs >= opening,
    );
  }
  return matched.some((observation) => {
    return observationIsInEpochOrBoundary(
      observation,
      opening,
      closing,
      openingAnchor,
      closingAnchor,
    );
  });
}

function observationIsInEpochOrBoundary(
  observation: HistoryStoredObservation,
  opening: number,
  closing: number,
  openingAnchor: HistoryAccountingWalletAnchor,
  closingAnchor: HistoryAccountingWalletAnchor,
): boolean {
  const time = timestampMs(observation.providerEventTime);
  if (time === undefined) return true;
  return (
    inRange(time, opening, closing) ||
    time === opening ||
    time === closing ||
    anchorBracketContains(time, openingAnchor) ||
    anchorBracketContains(time, closingAnchor)
  );
}

function selectionConflictIsInEpoch(
  conflict: HistoryAccountingSelectionConflict,
  observations: readonly HistoryStoredObservation[],
  opening: number,
  closing: number,
  openingAnchor: HistoryAccountingWalletAnchor,
  closingAnchor: HistoryAccountingWalletAnchor,
): boolean {
  const relevantIds = new Set(conflict.observationIds);
  if (relevantIds.size === 0) return true;
  const matched = observations.filter((observation) =>
    relevantIds.has(observation.observationId),
  );
  if (matched.length === 0) return true;
  return matched.some((observation) =>
    observationIsInEpochOrBoundary(
      observation,
      opening,
      closing,
      openingAnchor,
      closingAnchor,
    ),
  );
}

function invalidProjection(
  scope: HistoryStoreScope | undefined,
): HistoryAccountingEpochProjection {
  const safeScope =
    scope &&
    typeof scope.exchange === "string" &&
    typeof scope.environment === "string" &&
    typeof scope.accountId === "string"
      ? Object.freeze({ ...scope })
      : Object.freeze({
          exchange: "unknown",
          environment: "mainnet" as const,
          accountId: "unknown",
        });
  return Object.freeze({
    schemaVersion: "history-accounting-epoch-projection/v1",
    status: "NOT_READY",
    readiness: "NOT_READY",
    scope: safeScope,
    epoch: Object.freeze({
      openingAnchorId: "unknown",
      closingAnchorId: "unknown",
      openingBoundary: "unknown",
      closingBoundary: "unknown",
      transactionWindow: "(opening, closing]" as const,
    }),
    sourceCoverage: Object.freeze([]),
    currencies: Object.freeze([]),
    selectedTransactionCount: 0,
    reasonCodes: Object.freeze(["INVALID_INPUT"] as const),
  });
}

function anchorId(anchor: HistoryAccountingWalletAnchor): string {
  return plainRecord(anchor) && typeof anchor.anchorId === "string"
    ? anchor.anchorId
    : "unknown";
}

function anchorBoundary(anchor: HistoryAccountingWalletAnchor): string {
  if (!plainRecord(anchor) || !plainRecord(anchor.capture)) return "unknown";
  const value = anchor.capture.providerResponseTime;
  return timestampMs(value) === undefined ? "unknown" : String(value);
}

function project(
  input: ProjectHistoryAccountingEpochInput,
): Result<HistoryAccountingEpochProjection> {
  if (
    !plainRecord(input) ||
    !plainRecord(input.scope) ||
    !Array.isArray(input.observations) ||
    !Array.isArray(input.conflicts) ||
    !Array.isArray(input.coverage)
  )
    return ok(invalidProjection(undefined));

  const reasons = new Set<HistoryAccountingEpochReasonCode>();
  const opening = validateAnchor(
    input.opening,
    "opening",
    input.scope,
    reasons,
  );
  const closing = validateAnchor(
    input.closing,
    "closing",
    input.scope,
    reasons,
  );
  const validEpoch =
    opening !== undefined && closing !== undefined && opening < closing;
  if (!validEpoch) {
    addReason(reasons, "ANCHOR_EPOCH_INVALID");
  }
  const epochStart = opening ?? 0;
  const epochEnd = closing ?? epochStart;
  const transactionStart = epochStart + 1;
  const openingCaptureStart =
    plainRecord(input.opening) && plainRecord(input.opening.capture)
      ? timestampMs(input.opening.capture.providerTimeBefore)
      : undefined;
  const closingCaptureEnd =
    plainRecord(input.closing) && plainRecord(input.closing.capture)
      ? timestampMs(input.closing.capture.providerTimeAfter)
      : undefined;
  const coverageStart = validEpoch
    ? Math.min(openingCaptureStart ?? transactionStart, transactionStart)
    : transactionStart;
  const coverageEnd = validEpoch
    ? Math.max(closingCaptureEnd ?? epochEnd, epochEnd)
    : epochEnd;
  const sourceCoverage = validEpoch
    ? HISTORY_READ_SOURCES.map((source) =>
        projectSourceCoverage(
          source,
          input.coverage,
          input.scope,
          coverageStart,
          coverageEnd,
          reasons,
        ),
      )
    : HISTORY_READ_SOURCES.map((source) =>
        Object.freeze({ source, covered: false, gaps: Object.freeze([]) }),
      );
  if (!validEpoch) addReason(reasons, "HISTORY_COVERAGE_GAP");

  for (const observation of input.observations) {
    if (!sameScope(observation.scope, input.scope))
      addReason(reasons, "HISTORY_SCOPE_MISMATCH");
  }

  const relevantObservations = validEpoch
    ? input.observations.filter((observation) =>
        observationIsInEpochOrBoundary(
          observation,
          epochStart,
          epochEnd,
          input.opening,
          input.closing,
        ),
      )
    : [];
  const relevantObservationSet = new Set(relevantObservations);
  const observationsByIdentity = indexHistoryObservationsByIdentity(
    input.observations,
  );
  const relevantTransactionIds = new Set(
    relevantObservations.flatMap((observation) =>
      observation.fact.factKind === "transaction"
        ? [observation.fact.transactionId]
        : [],
    ),
  );
  const inEpochClosedOrderIds = new Set(
    relevantObservations.flatMap((observation) => {
      const fact = observation.fact;
      return fact.factKind === "closed-pnl" &&
        inRange(
          timestampMs(observation.providerEventTime) ?? Number.NaN,
          epochStart,
          epochEnd,
        )
        ? [fact.orderId]
        : [];
    }),
  );
  const selectionObservations =
    relevantTransactionIds.size === 0 && inEpochClosedOrderIds.size === 0
      ? relevantObservations
      : input.observations.filter(
          (observation) =>
            relevantObservationSet.has(observation) ||
            (observation.fact.factKind === "transaction" &&
              relevantTransactionIds.has(observation.fact.transactionId)) ||
            (observation.fact.factKind === "execution" &&
              inEpochClosedOrderIds.has(observation.fact.orderId)),
        );
  const relevantConflicts = validEpoch
    ? input.conflicts.filter((conflict) =>
        conflictIsInEpoch(
          conflict,
          observationsByIdentity,
          epochStart,
          epochEnd,
          input.opening,
          input.closing,
        ),
      )
    : [];
  if (validEpoch)
    checkpointConflictCountsAreLocated(
      input.coverage,
      input.conflicts,
      input.scope,
      coverageStart,
      coverageEnd,
      reasons,
    );
  const selected = selectCanonicalHistoryEvidence({
    scope: input.scope,
    observations: selectionObservations,
    conflicts: relevantConflicts,
  });
  if (!selected.ok) addReason(reasons, "INVALID_HISTORY_EVIDENCE");

  for (const conflict of relevantConflicts) {
    addReason(
      reasons,
      conflict.source === "transaction-log"
        ? "TRANSACTION_IDENTITY_CONFLICT"
        : "HISTORY_SOURCE_CONFLICT",
    );
  }

  const selectedTransactions: NormalizedRow[] = [];
  const selectedTradeTransactions: TransactionHistorySourceFact[] = [];
  const selectedEpochExecutions: ExecutionHistorySourceFact[] = [];
  const selectedExecutions: ExecutionHistorySourceFact[] = [];
  const selectedClosedPnlRows: ClosedPnlHistorySourceFact[] = [];
  if (selected.ok) {
    for (const conflict of selected.value.conflicts) {
      if (
        !selectionConflictIsInEpoch(
          conflict,
          selectionObservations,
          epochStart,
          epochEnd,
          input.opening,
          input.closing,
        )
      )
        continue;
      addReason(
        reasons,
        conflict.kind === "transaction-identity-conflict"
          ? "TRANSACTION_IDENTITY_CONFLICT"
          : "CLOSED_PNL_REVISION_CONFLICT",
      );
    }
    for (const observation of selected.value.observations) {
      const time = timestampMs(observation.providerEventTime);
      if (time === undefined) {
        addReason(reasons, "INVALID_HISTORY_EVIDENCE");
        continue;
      }
      const fact = observation.fact;
      if (
        (fact.factKind === "execution" || fact.factKind === "closed-pnl") &&
        (time === epochStart ||
          time === epochEnd ||
          anchorBracketContains(time, input.opening) ||
          anchorBracketContains(time, input.closing))
      )
        addReason(reasons, "ANCHOR_BOUNDARY_EVENT_AMBIGUOUS");
      if (fact.factKind === "execution") {
        selectedExecutions.push(fact);
        if (inRange(time, epochStart, epochEnd))
          selectedEpochExecutions.push(fact);
        continue;
      }
      if (fact.factKind === "closed-pnl") {
        if (inRange(time, epochStart, epochEnd))
          selectedClosedPnlRows.push(fact);
        continue;
      }
      if (fact.factKind === "transaction") {
        if (
          time === epochStart ||
          time === epochEnd ||
          anchorBracketContains(time, input.opening) ||
          anchorBracketContains(time, input.closing)
        ) {
          addReason(reasons, "ANCHOR_BOUNDARY_EVENT_AMBIGUOUS");
        }
        if (!inRange(time, epochStart, epochEnd)) continue;
        if (isTradeTransaction(fact)) selectedTradeTransactions.push(fact);
        const normalized = normalizeHistoryTransaction(observation);
        if (!normalized.ok) {
          addReason(reasons, "INVALID_HISTORY_EVIDENCE");
          continue;
        }
        const change =
          normalized.value.change === null
            ? null
            : DecimalValue.fromString(normalized.value.change);
        const bonusChange =
          normalized.value.bonusChange === null
            ? null
            : DecimalValue.fromString(normalized.value.bonusChange);
        if (change !== null && !change.ok)
          addReason(reasons, "INVALID_HISTORY_EVIDENCE");
        if (bonusChange !== null && !bonusChange.ok)
          addReason(reasons, "INVALID_HISTORY_EVIDENCE");
        const normalizedRow: NormalizedRow = {
          category: normalized.value.category,
          movementKind: normalized.value.movementKind,
          currency: normalized.value.currency,
          change: change === null ? null : change.ok ? change.value : null,
          bonusChange:
            bonusChange === null
              ? null
              : bonusChange.ok
                ? bonusChange.value
                : null,
          componentCheck: normalized.value.componentCheck,
        };
        if (normalizedRow.movementKind === "unknown")
          addReason(reasons, "UNKNOWN_TRANSACTION_TYPE");
        // The period bridge currently supports linear-contract movements and
        // account-level transfers. Spot, inverse, option and unclassified
        // trading flows need a supported bridge before full-account equality.
        if (
          normalizedRow.movementKind !== "transfer" &&
          normalizedRow.category !== "linear"
        )
          addReason(reasons, "UNSUPPORTED_TRANSACTION_CATEGORY");
        if (normalizedRow.currency === null)
          addReason(reasons, "UNKNOWN_TRANSACTION_CURRENCY");
        if (normalizedRow.change === null)
          addReason(reasons, "UNKNOWN_TRANSACTION_CHANGE");
        if (normalizedRow.componentCheck === "incomplete")
          addReason(reasons, "TRANSACTION_COMPONENTS_INCOMPLETE");
        if (normalizedRow.componentCheck === "mismatched")
          addReason(reasons, "TRANSACTION_COMPONENT_MISMATCH");
        if (
          normalizedRow.currency !== null &&
          normalizedRow.currency !== "USDT"
        )
          addReason(reasons, "UNSUPPORTED_CURRENCY");
        if (
          normalizedRow.bonusChange !== null &&
          !normalizedRow.bonusChange.isZero()
        )
          addReason(reasons, "UNSUPPORTED_BONUS_MOVEMENT");
        selectedTransactions.push(normalizedRow);
      }
    }
  }
  verifyExecutionAndCloseEvidence(
    selectedTradeTransactions,
    selectedEpochExecutions,
    selectedExecutions,
    selectedClosedPnlRows,
    reasons,
  );

  const openingBalances = readBalances(input.opening, reasons);
  const closingBalances = readBalances(input.closing, reasons);
  const currencies = projectCurrencies(
    openingBalances,
    closingBalances,
    selectedTransactions,
    reasons,
  );
  const reasonCodes = Object.freeze([...reasons].sort());
  const status = reasonCodes.length === 0 ? "RECONCILED" : "NOT_READY";
  return ok(
    Object.freeze({
      schemaVersion: "history-accounting-epoch-projection/v1",
      status,
      readiness: status === "RECONCILED" ? "ACCOUNTING_READY" : "NOT_READY",
      scope: Object.freeze({ ...input.scope }),
      epoch: Object.freeze({
        openingAnchorId: anchorId(input.opening),
        closingAnchorId: anchorId(input.closing),
        openingBoundary: anchorBoundary(input.opening),
        closingBoundary: anchorBoundary(input.closing),
        transactionWindow: "(opening, closing]",
      }),
      sourceCoverage: Object.freeze(sourceCoverage),
      currencies,
      selectedTransactionCount: selectedTransactions.length,
      reasonCodes,
    }),
  );
}

export function projectHistoryAccountingEpoch(
  input: ProjectHistoryAccountingEpochInput,
): Result<HistoryAccountingEpochProjection> {
  try {
    return project(input);
  } catch {
    return ok(
      invalidProjection(
        plainRecord(input) && plainRecord(input.scope)
          ? (input.scope as unknown as HistoryStoreScope)
          : undefined,
      ),
    );
  }
}
