import {
  createExchangeOrder,
  type ExchangeOrderObservation,
} from "./exchange-order.js";
import type { PreparedLegSourceIdentity } from "./prepared-leg-execution.js";
import type { ExchangeFillObservation } from "../../ports/exchange-execution.js";
import { closedRecord } from "../planning/planning-validation.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { domainError } from "../shared/errors.js";
import { fail, ok, type Result } from "../shared/result.js";
import { DecimalValue, isDecimalValue } from "../shared/decimal.js";
import { timestampToEpochMs, type UtcTimestamp } from "../shared/time.js";
import {
  isRecord,
  requireIdentifier,
  requireSafeText,
} from "../shared/validation.js";
import { isProducedExchangeOrder } from "./exchange-order-proof.js";

const produced = new WeakSet<object>();

function decimalZero(): DecimalValue {
  const zero = DecimalValue.fromString("0");
  if (!zero.ok) throw new Error("zero decimal constant is invalid");
  return zero.value;
}

export type PreparedLegOrderProof = ExchangeOrderObservation & {
  readonly category: "linear";
  readonly orderType: "limit" | "market";
  readonly price: NonNullable<ExchangeOrderObservation["price"]>;
  readonly timeInForce: NonNullable<ExchangeOrderObservation["timeInForce"]>;
  readonly takeProfit: Exclude<
    ExchangeOrderObservation["takeProfit"],
    undefined
  >;
  readonly stopLoss: Exclude<ExchangeOrderObservation["stopLoss"], undefined>;
  readonly reduceOnly: boolean;
  readonly positionIdx: 0 | 1 | 2;
};

export type PreparedLegProtectionCoverageReason =
  | "PARENT_OBSERVATION_STALE"
  | "ENTRY_FILL_MISMATCH"
  | "EXIT_FILL_MISMATCH"
  | "CHILD_PROOF_INVALID"
  | "CHILD_OBSERVATION_STALE"
  | "CHILD_ORDER_CONFLICT"
  | "CHILD_FILL_MISMATCH"
  | "UNKNOWN_EXIT"
  | "DUPLICATE_EXECUTION_CONFLICT"
  | "NEGATIVE_OUTSTANDING"
  | "COVERAGE_MISMATCH";

export interface PreparedLegProtectionCoverage {
  readonly schemaVersion: "prepared-leg-protection-coverage/v1";
  readonly parentExchangeOrderId: string;
  readonly entryExecutionIds: readonly string[];
  readonly exitExecutionIds: readonly string[];
  readonly childOrderIds: readonly string[];
  readonly executedEntryQuantity: DecimalValue;
  readonly executedExitQuantity: DecimalValue;
  readonly outstandingQuantity: DecimalValue;
  readonly activeRemainingQuantity: DecimalValue;
  readonly covered: boolean;
  readonly reasonCodes: readonly PreparedLegProtectionCoverageReason[];
  readonly observedAt: UtcTimestamp;
}

const ORDER_KEYS = [
  "exchangeOrderId",
  "clientOrderId",
  "instrument",
  "category",
  "side",
  "requestedQuantity",
  "filledQuantity",
  "status",
  "orderType",
  "price",
  "triggerPrice",
  "timeInForce",
  "takeProfit",
  "stopLoss",
  "reduceOnly",
  "positionIdx",
  "observedAt",
  "source",
  "parentOrderLinkId",
  "providerOrderLinkId",
  "providerStopOrderType",
  "providerTpslMode",
  "triggerBy",
  "takeProfitTriggerBy",
  "providerCreatedAt",
  "providerUpdatedAt",
  "averagePrice",
  "protectionType",
] as const;
const REQUIRED_KEYS = [
  "exchangeOrderId",
  "clientOrderId",
  "instrument",
  "category",
  "side",
  "requestedQuantity",
  "filledQuantity",
  "status",
  "orderType",
  "price",
  "timeInForce",
  "takeProfit",
  "stopLoss",
  "reduceOnly",
  "positionIdx",
  "observedAt",
  "source",
] as const;

function invalid(): Result<never> {
  return fail(
    domainError(
      "UNRESOLVED_RECONCILIATION",
      "provider order terms are incomplete or invalid",
    ),
  );
}

/** Strict provider observation. Required order terms are never filled from a request. */
export function createPreparedLegOrderProof(
  input: unknown,
): Result<PreparedLegOrderProof> {
  if (
    !closedRecord(input, ORDER_KEYS) ||
    !REQUIRED_KEYS.every((key) => Object.hasOwn(input, key))
  )
    return invalid();
  // Adapter mappers already return trusted DecimalValue observations. Raw
  // provider-shaped inputs still pass through the ordinary domain parser.
  const observation = isProducedExchangeOrder(input)
    ? ok(input as unknown as ExchangeOrderObservation)
    : createExchangeOrder(input);
  if (
    !observation.ok ||
    observation.value.category !== "linear" ||
    observation.value.orderType === undefined ||
    observation.value.price === undefined ||
    observation.value.timeInForce === undefined ||
    observation.value.takeProfit === undefined ||
    observation.value.stopLoss === undefined ||
    observation.value.reduceOnly === undefined ||
    observation.value.positionIdx === undefined
  )
    return invalid();
  const proof = deepFreeze({ ...observation.value }) as PreparedLegOrderProof;
  produced.add(proof);
  return ok(proof);
}

export function isProducedPreparedLegOrderProof(
  value: unknown,
): value is PreparedLegOrderProof {
  return typeof value === "object" && value !== null && produced.has(value);
}

/** Compares every approved term to actual provider-observed order terms. */
export function matchesPreparedLegOrder(
  proof: PreparedLegOrderProof,
  execution: PreparedLegSourceIdentity,
): boolean {
  if (!isProducedPreparedLegOrderProof(proof)) return false;
  const intent = execution.leg.intent;
  const takeProfit = intent.protection?.takeProfit;
  const takeProfitPolicy = intent.protection?.takeProfitPolicy;
  return (
    takeProfit !== undefined &&
    proof.clientOrderId === execution.clientOrderId &&
    proof.instrument === intent.instrument &&
    proof.category === "linear" &&
    proof.side === "buy" &&
    proof.requestedQuantity.compare(intent.quantity) === 0 &&
    proof.orderType === "limit" &&
    proof.price.compare(intent.price) === 0 &&
    proof.timeInForce === "GTC" &&
    proof.takeProfit !== null &&
    proof.takeProfit.compare(takeProfit) === 0 &&
    proof.stopLoss === null &&
    (takeProfitPolicy === undefined ||
      (proof.providerTpslMode === takeProfitPolicy.tpslMode &&
        proof.takeProfitTriggerBy === takeProfitPolicy.triggerBy)) &&
    proof.reduceOnly === false &&
    proof.positionIdx === 0
  );
}

/** Proves a provider-attached Partial TP child against its approved leg. */
export function matchesPreparedLegTakeProfitChild(
  order: ExchangeOrderObservation,
  execution: PreparedLegSourceIdentity,
): boolean {
  const observed = isProducedExchangeOrder(order)
    ? ok(order)
    : createExchangeOrder(order);
  if (!observed.ok) return false;
  const child = observed.value;
  const intent = execution.leg.intent;
  const takeProfit = intent.protection?.takeProfit;
  const policy = intent.protection?.takeProfitPolicy;
  if (policy !== undefined) {
    const providerCreatedAt = child.providerCreatedAt;
    const providerUpdatedAt = child.providerUpdatedAt;
    const createdAt = providerCreatedAt
      ? timestampToEpochMs(providerCreatedAt)
      : Number.NaN;
    const updatedAt = providerUpdatedAt
      ? timestampToEpochMs(providerUpdatedAt)
      : Number.NaN;
    const observedAt = timestampToEpochMs(child.observedAt);
    const sourceIsBybitOrderRead =
      /^bybit-mainnet\/(?:protection\/)?order\/(?:realtime|history)$/u.test(
        child.source,
      );
    const childIdentityIsConsistent =
      child.providerOrderLinkId === undefined
        ? child.clientOrderId === execution.clientOrderId
        : child.clientOrderId === child.providerOrderLinkId;
    const validStatusAndQuantity =
      (child.status === "open" && child.filledQuantity.isZero()) ||
      (child.status === "partially-filled" &&
        child.filledQuantity.isPositive() &&
        child.filledQuantity.compare(child.requestedQuantity) < 0) ||
      (child.status === "filled" &&
        child.filledQuantity.compare(child.requestedQuantity) === 0) ||
      ((child.status === "cancelled" || child.status === "rejected") &&
        child.filledQuantity.compare(child.requestedQuantity) <= 0);
    return (
      policy.policyVersion === "m1-mainnet-per-leg-tp/v1" &&
      policy.tpslMode === "Partial" &&
      policy.orderType === "Market" &&
      policy.triggerBy === "LastPrice" &&
      takeProfit !== undefined &&
      childIdentityIsConsistent &&
      child.parentOrderLinkId === execution.clientOrderId &&
      child.instrument === intent.instrument &&
      child.category === "linear" &&
      child.protectionType === "take-profit" &&
      child.providerStopOrderType === "PartialTakeProfit" &&
      child.providerTpslMode === "Partial" &&
      child.side === "sell" &&
      child.requestedQuantity.isPositive() &&
      child.requestedQuantity.compare(intent.quantity) <= 0 &&
      validStatusAndQuantity &&
      child.orderType === "market" &&
      child.price === undefined &&
      child.triggerPrice?.compare(takeProfit) === 0 &&
      child.takeProfitTriggerBy === "LastPrice" &&
      (child.triggerBy === undefined || child.triggerBy === "LastPrice") &&
      (child.stopLoss === undefined || child.stopLoss === null) &&
      child.reduceOnly === true &&
      child.positionIdx === 0 &&
      sourceIsBybitOrderRead &&
      Number.isFinite(createdAt) &&
      Number.isFinite(updatedAt) &&
      createdAt <= updatedAt &&
      updatedAt <= observedAt
    );
  }
  return (
    takeProfit !== undefined &&
    child.clientOrderId === execution.clientOrderId &&
    child.parentOrderLinkId === execution.clientOrderId &&
    child.instrument === intent.instrument &&
    child.category === "linear" &&
    child.protectionType === "take-profit" &&
    child.side === "sell" &&
    child.requestedQuantity.compare(intent.quantity) === 0 &&
    child.filledQuantity.isZero() &&
    child.status === "open" &&
    child.orderType === "market" &&
    child.triggerPrice?.compare(takeProfit) === 0 &&
    child.reduceOnly === true &&
    child.positionIdx === 0
  );
}

export function derivePreparedLegProtectionCoverage(input: {
  readonly execution: PreparedLegSourceIdentity;
  readonly parent: PreparedLegOrderProof;
  readonly entryFills: readonly ExchangeFillObservation[];
  readonly exitFills: readonly ExchangeFillObservation[];
  readonly children: readonly ExchangeOrderObservation[];
  readonly observedAt: UtcTimestamp;
  readonly maxAgeMs: number;
}): Result<PreparedLegProtectionCoverage> {
  const invalidCoverage = (message: string) =>
    fail(
      domainError("UNRESOLVED_RECONCILIATION", message, {
        clientOrderId: input.execution.clientOrderId,
      }),
    );
  if (
    !isProducedPreparedLegOrderProof(input.parent) ||
    !Number.isSafeInteger(input.maxAgeMs) ||
    input.maxAgeMs < 0 ||
    !input.execution.leg.intent.protection?.takeProfitPolicy ||
    !matchesPreparedLegOrder(input.parent, input.execution)
  )
    return invalidCoverage("prepared-leg coverage inputs are invalid");

  const now = timestampToEpochMs(input.observedAt);
  const parentObservedAt = timestampToEpochMs(input.parent.observedAt);
  const maxAge = input.maxAgeMs;
  const reasons = new Set<PreparedLegProtectionCoverageReason>();
  if (
    parentObservedAt > now ||
    now - parentObservedAt > maxAge ||
    (input.parent.source !== "bybit-mainnet/realtime" &&
      input.parent.source !== "bybit-mainnet/history" &&
      input.parent.source !== "bybit-mainnet/order-realtime" &&
      input.parent.source !== "bybit-mainnet/order-history")
  )
    reasons.add("PARENT_OBSERVATION_STALE");

  const entryFills = deduplicateFills(input.entryFills, reasons);
  const exitFills = deduplicateFills(input.exitFills, reasons);
  const children = deduplicateChildren(input.children, reasons);
  const executionIdSet = new Set<string>();
  const childById = new Map<string, ExchangeOrderObservation>();
  for (const child of children) {
    if (!matchesPreparedLegTakeProfitChild(child, input.execution)) {
      reasons.add("CHILD_PROOF_INVALID");
      continue;
    }
    if (childById.has(child.exchangeOrderId)) {
      reasons.add("CHILD_ORDER_CONFLICT");
      continue;
    }
    const childObservedAt = timestampToEpochMs(child.observedAt);
    const createdAt = timestampToEpochMs(child.providerCreatedAt!);
    const updatedAt = timestampToEpochMs(child.providerUpdatedAt!);
    if (
      childObservedAt > now ||
      now - childObservedAt > maxAge ||
      Math.abs(childObservedAt - parentObservedAt) > maxAge ||
      createdAt > updatedAt ||
      updatedAt > childObservedAt
    ) {
      reasons.add("CHILD_OBSERVATION_STALE");
      continue;
    }
    if (
      (child.status === "open" || child.status === "partially-filled") &&
      !child.source.endsWith("/order/realtime")
    ) {
      reasons.add("CHILD_OBSERVATION_STALE");
      continue;
    }
    childById.set(child.exchangeOrderId, child);
  }

  let entryQuantity = decimalZero();
  for (const fill of entryFills) {
    if (
      !validFill(fill) ||
      fill.instrument !== input.execution.leg.intent.instrument ||
      fill.exchangeOrderId !== input.parent.exchangeOrderId ||
      fill.clientOrderId !== input.execution.clientOrderId ||
      fill.side !== "buy" ||
      timestampToEpochMs(fill.executedAt) > now ||
      !fill.source.startsWith("bybit-mainnet/execution")
    ) {
      reasons.add("ENTRY_FILL_MISMATCH");
      continue;
    }
    entryQuantity = entryQuantity.add(fill.quantity);
    executionIdSet.add(fill.executionId);
  }
  if (entryQuantity.compare(input.parent.filledQuantity) !== 0)
    reasons.add("ENTRY_FILL_MISMATCH");

  const exitsByChild = new Map<string, DecimalValue>();
  let exitQuantity = decimalZero();
  for (const fill of exitFills) {
    const child = childById.get(fill.exchangeOrderId);
    if (
      !validFill(fill) ||
      !child ||
      fill.instrument !== input.execution.leg.intent.instrument ||
      fill.side !== "sell" ||
      timestampToEpochMs(fill.executedAt) > now ||
      !fill.source.startsWith("bybit-mainnet/execution") ||
      (fill.clientOrderId !== input.execution.clientOrderId &&
        fill.clientOrderId !== child.providerOrderLinkId &&
        fill.clientOrderId !== "")
    ) {
      reasons.add(child ? "EXIT_FILL_MISMATCH" : "UNKNOWN_EXIT");
      continue;
    }
    if (executionIdSet.has(fill.executionId)) {
      reasons.add("DUPLICATE_EXECUTION_CONFLICT");
      continue;
    }
    executionIdSet.add(fill.executionId);
    exitQuantity = exitQuantity.add(fill.quantity);
    exitsByChild.set(
      child.exchangeOrderId,
      (exitsByChild.get(child.exchangeOrderId) ?? decimalZero()).add(
        fill.quantity,
      ),
    );
  }

  let activeRemainingQuantity = decimalZero();
  for (const child of childById.values()) {
    const observedExitQuantity =
      exitsByChild.get(child.exchangeOrderId) ?? decimalZero();
    if (observedExitQuantity.compare(child.filledQuantity) !== 0)
      reasons.add("CHILD_FILL_MISMATCH");
    if (child.status === "open" || child.status === "partially-filled") {
      activeRemainingQuantity = activeRemainingQuantity.add(
        child.requestedQuantity.subtract(child.filledQuantity),
      );
    }
  }

  const outstandingQuantity = entryQuantity.subtract(exitQuantity);
  if (outstandingQuantity.isNegative()) reasons.add("NEGATIVE_OUTSTANDING");
  if (activeRemainingQuantity.compare(outstandingQuantity) !== 0)
    reasons.add("COVERAGE_MISMATCH");
  const reasonCodes = [...reasons].sort();
  const proof: PreparedLegProtectionCoverage = deepFreeze({
    schemaVersion: "prepared-leg-protection-coverage/v1",
    parentExchangeOrderId: input.parent.exchangeOrderId,
    entryExecutionIds: entryFills.map((fill) => fill.executionId).sort(),
    exitExecutionIds: exitFills.map((fill) => fill.executionId).sort(),
    childOrderIds: [...childById.keys()].sort(),
    executedEntryQuantity: entryQuantity,
    executedExitQuantity: exitQuantity,
    outstandingQuantity,
    activeRemainingQuantity,
    covered: reasonCodes.length === 0,
    reasonCodes,
    observedAt: input.observedAt,
  });
  return ok(proof);
}

function validFill(fill: ExchangeFillObservation): boolean {
  return (
    isRecord(fill) &&
    requireIdentifier(fill.executionId, "executionId").ok &&
    requireIdentifier(fill.exchangeOrderId, "exchangeOrderId").ok &&
    typeof fill.clientOrderId === "string" &&
    requireIdentifier(fill.instrument, "instrument").ok &&
    (fill.side === "buy" || fill.side === "sell") &&
    isDecimalValue(fill.quantity) &&
    fill.quantity.isPositive() &&
    isDecimalValue(fill.price) &&
    fill.price.isPositive() &&
    requireSafeText(fill.source, "source").ok &&
    Number.isFinite(timestampToEpochMs(fill.executedAt))
  );
}

function deduplicateFills(
  fills: readonly ExchangeFillObservation[],
  reasons: Set<PreparedLegProtectionCoverageReason>,
): readonly ExchangeFillObservation[] {
  const byId = new Map<string, ExchangeFillObservation>();
  for (const fill of fills) {
    if (!validFill(fill)) {
      reasons.add("EXIT_FILL_MISMATCH");
      continue;
    }
    const previous = byId.get(fill.executionId);
    if (
      previous !== undefined &&
      (previous.exchangeOrderId !== fill.exchangeOrderId ||
        previous.clientOrderId !== fill.clientOrderId ||
        previous.instrument !== fill.instrument ||
        previous.side !== fill.side ||
        previous.quantity.compare(fill.quantity) !== 0 ||
        previous.price.compare(fill.price) !== 0 ||
        previous.executedAt !== fill.executedAt)
    ) {
      reasons.add("DUPLICATE_EXECUTION_CONFLICT");
      continue;
    }
    byId.set(fill.executionId, fill);
  }
  return [...byId.values()];
}

function deduplicateChildren(
  children: readonly ExchangeOrderObservation[],
  reasons: Set<PreparedLegProtectionCoverageReason>,
): readonly ExchangeOrderObservation[] {
  const byId = new Map<string, ExchangeOrderObservation>();
  for (const candidate of children) {
    const parsed = isProducedExchangeOrder(candidate)
      ? ok(candidate)
      : createExchangeOrder(candidate);
    if (!parsed.ok) {
      reasons.add("CHILD_PROOF_INVALID");
      continue;
    }
    const child = parsed.value;
    const previous = byId.get(child.exchangeOrderId);
    if (previous !== undefined && !sameChildProviderEvidence(previous, child)) {
      reasons.add("CHILD_ORDER_CONFLICT");
      continue;
    }
    if (
      previous === undefined ||
      (previous.source.endsWith("/order/history") &&
        child.source.endsWith("/order/realtime"))
    ) {
      byId.set(child.exchangeOrderId, child);
    }
  }
  return [...byId.values()];
}

function sameChildProviderEvidence(
  left: ExchangeOrderObservation,
  right: ExchangeOrderObservation,
): boolean {
  return (
    left.clientOrderId === right.clientOrderId &&
    left.providerOrderLinkId === right.providerOrderLinkId &&
    left.parentOrderLinkId === right.parentOrderLinkId &&
    left.providerStopOrderType === right.providerStopOrderType &&
    left.providerTpslMode === right.providerTpslMode &&
    left.triggerBy === right.triggerBy &&
    left.takeProfitTriggerBy === right.takeProfitTriggerBy &&
    left.providerCreatedAt === right.providerCreatedAt &&
    left.providerUpdatedAt === right.providerUpdatedAt &&
    left.instrument === right.instrument &&
    left.side === right.side &&
    left.requestedQuantity.compare(right.requestedQuantity) === 0 &&
    left.filledQuantity.compare(right.filledQuantity) === 0 &&
    left.status === right.status &&
    left.orderType === right.orderType &&
    left.triggerPrice?.toString() === right.triggerPrice?.toString() &&
    left.protectionType === right.protectionType &&
    left.reduceOnly === right.reduceOnly &&
    left.positionIdx === right.positionIdx
  );
}
