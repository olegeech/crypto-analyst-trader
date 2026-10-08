import {
  createExchangeOrder,
  type ExchangeOrderObservation,
} from "./exchange-order.js";
import type { PreparedLegSourceIdentity } from "./prepared-leg-execution.js";
import { closedRecord } from "../planning/planning-validation.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { domainError } from "../shared/errors.js";
import { fail, ok, type Result } from "../shared/result.js";
import { isProducedExchangeOrder } from "./exchange-order-proof.js";

const produced = new WeakSet<object>();

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
  "timeInForce",
  "takeProfit",
  "stopLoss",
  "reduceOnly",
  "positionIdx",
  "observedAt",
  "source",
  "parentOrderLinkId",
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
    proof.reduceOnly === false &&
    proof.positionIdx === 0
  );
}
