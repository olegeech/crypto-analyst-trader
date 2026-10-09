import { DecimalValue } from "../shared/decimal.js";
import { domainError } from "../shared/errors.js";
import { parseUtcTimestamp, type UtcTimestamp } from "../shared/time.js";
import { fail, ok, type Result } from "../shared/result.js";
import {
  isRecord,
  requireIdentifier,
  requireSafeText,
} from "../shared/validation.js";
import { markExchangeOrder } from "./exchange-order-proof.js";

export type ExchangeOrderStatus =
  "open" | "filled" | "partially-filled" | "cancelled" | "rejected";
export type ExchangeOrderCategory = "linear" | "inverse" | "spot" | "option";
export type ExchangeOrderType = "limit" | "market";
export type ExchangeTimeInForce = "GTC" | "IOC" | "FOK" | "PostOnly";

export type ExchangeProtectionType =
  "take-profit" | "stop-loss" | "trailing-stop" | "other";

export interface ExchangeOrderObservation {
  readonly exchangeOrderId: string;
  readonly clientOrderId: string;
  readonly instrument: string;
  readonly side: "buy" | "sell";
  readonly requestedQuantity: DecimalValue;
  readonly filledQuantity: DecimalValue;
  readonly status: ExchangeOrderStatus;
  readonly observedAt: UtcTimestamp;
  readonly source: string;
  readonly parentOrderLinkId?: string;
  readonly averagePrice?: DecimalValue;
  readonly protectionType?: ExchangeProtectionType;
  readonly category?: ExchangeOrderCategory;
  readonly orderType?: ExchangeOrderType;
  readonly price?: DecimalValue;
  readonly timeInForce?: ExchangeTimeInForce;
  readonly takeProfit?: DecimalValue | null;
  readonly stopLoss?: DecimalValue | null;
  readonly reduceOnly?: boolean;
  readonly positionIdx?: 0 | 1 | 2;
}

function parseDecimal(value: unknown, field: string): Result<DecimalValue> {
  const result = DecimalValue.fromString(value);
  if (!result.ok) return result;
  if (result.value.isNegative()) {
    return fail(
      domainError("INVALID_VALUE", `${field} must not be negative`, { field }),
    );
  }
  return result;
}

export function createExchangeOrder(
  input: unknown,
): Result<ExchangeOrderObservation> {
  if (!isRecord(input)) {
    return fail(
      domainError("INVALID_VALUE", "exchange order must be an object"),
    );
  }
  const exchangeOrderId = requireIdentifier(
    input.exchangeOrderId,
    "exchangeOrderId",
  );
  const clientOrderId = requireIdentifier(input.clientOrderId, "clientOrderId");
  const instrument = requireIdentifier(input.instrument, "instrument");
  const source = requireSafeText(input.source, "source");
  const observedAt = parseUtcTimestamp(input.observedAt);
  const parentOrderLinkId =
    input.parentOrderLinkId === undefined
      ? { ok: true as const, value: undefined }
      : requireIdentifier(input.parentOrderLinkId, "parentOrderLinkId");
  const requestedQuantity = DecimalValue.fromString(input.requestedQuantity);
  const filledQuantity = parseDecimal(input.filledQuantity, "filledQuantity");
  if (
    !exchangeOrderId.ok ||
    !clientOrderId.ok ||
    !instrument.ok ||
    !source.ok ||
    !observedAt.ok ||
    !parentOrderLinkId.ok ||
    !requestedQuantity.ok ||
    !filledQuantity.ok ||
    !requestedQuantity.value.isPositive() ||
    filledQuantity.value.compare(requestedQuantity.value) > 0 ||
    (input.side !== "buy" && input.side !== "sell") ||
    (input.status !== "open" &&
      input.status !== "filled" &&
      input.status !== "partially-filled" &&
      input.status !== "cancelled" &&
      input.status !== "rejected")
  ) {
    return fail(
      domainError("INVALID_VALUE", "exchange order contains an invalid field"),
    );
  }
  if (input.status === "filled" && !filledQuantity.value.isPositive()) {
    return fail(
      domainError("INVALID_VALUE", "filled order must have a fill quantity"),
    );
  }
  let averagePrice: DecimalValue | undefined;
  if (input.averagePrice !== undefined) {
    const parsed = DecimalValue.fromString(input.averagePrice);
    if (!parsed.ok || !parsed.value.isPositive()) {
      return fail(
        domainError("INVALID_VALUE", "averagePrice must be positive"),
      );
    }
    averagePrice = parsed.value;
  }
  let protectionType: ExchangeProtectionType | undefined;
  if (input.protectionType !== undefined) {
    if (
      input.protectionType !== "take-profit" &&
      input.protectionType !== "stop-loss" &&
      input.protectionType !== "trailing-stop" &&
      input.protectionType !== "other"
    ) {
      return fail(domainError("INVALID_VALUE", "protectionType is invalid"));
    }
    protectionType = input.protectionType;
  }
  const category =
    input.category === undefined
      ? undefined
      : input.category === "linear" ||
          input.category === "inverse" ||
          input.category === "spot" ||
          input.category === "option"
        ? input.category
        : null;
  const orderType =
    input.orderType === undefined
      ? undefined
      : input.orderType === "limit" || input.orderType === "market"
        ? input.orderType
        : null;
  const timeInForce =
    input.timeInForce === undefined
      ? undefined
      : input.timeInForce === "GTC" ||
          input.timeInForce === "IOC" ||
          input.timeInForce === "FOK" ||
          input.timeInForce === "PostOnly"
        ? input.timeInForce
        : null;
  const price =
    input.price === undefined
      ? undefined
      : DecimalValue.fromString(input.price);
  const takeProfit = parseOptionalProtectionPrice(input, "takeProfit");
  const stopLoss = parseOptionalProtectionPrice(input, "stopLoss");
  const positionIdx =
    input.positionIdx === undefined
      ? undefined
      : input.positionIdx === 0 ||
          input.positionIdx === 1 ||
          input.positionIdx === 2
        ? input.positionIdx
        : null;
  const order: {
    exchangeOrderId: string;
    clientOrderId: string;
    instrument: string;
    side: "buy" | "sell";
    requestedQuantity: DecimalValue;
    filledQuantity: DecimalValue;
    status: ExchangeOrderStatus;
    observedAt: UtcTimestamp;
    source: string;
    parentOrderLinkId?: string;
    averagePrice?: DecimalValue;
    protectionType?: ExchangeProtectionType;
    category?: ExchangeOrderCategory;
    orderType?: ExchangeOrderType;
    price?: DecimalValue;
    timeInForce?: ExchangeTimeInForce;
    takeProfit?: DecimalValue | null;
    stopLoss?: DecimalValue | null;
    reduceOnly?: boolean;
    positionIdx?: 0 | 1 | 2;
  } = {
    exchangeOrderId: exchangeOrderId.value,
    clientOrderId: clientOrderId.value,
    instrument: instrument.value,
    side: input.side,
    requestedQuantity: requestedQuantity.value,
    filledQuantity: filledQuantity.value,
    status: input.status,
    observedAt: observedAt.value,
    source: source.value,
    ...(parentOrderLinkId.value === undefined
      ? {}
      : { parentOrderLinkId: parentOrderLinkId.value }),
  };
  if (
    category === null ||
    orderType === null ||
    timeInForce === null ||
    (price !== undefined && (!price.ok || !price.value.isPositive())) ||
    !takeProfit.ok ||
    !stopLoss.ok ||
    (input.reduceOnly !== undefined && typeof input.reduceOnly !== "boolean") ||
    positionIdx === null
  )
    return fail(
      domainError("INVALID_VALUE", "exchange order terms are invalid"),
    );
  if (averagePrice !== undefined) order.averagePrice = averagePrice;
  if (protectionType !== undefined) order.protectionType = protectionType;
  if (category !== undefined) order.category = category;
  if (orderType !== undefined) order.orderType = orderType;
  if (price !== undefined) order.price = price.value;
  if (timeInForce !== undefined) order.timeInForce = timeInForce;
  if (takeProfit.value !== undefined) order.takeProfit = takeProfit.value;
  if (stopLoss.value !== undefined) order.stopLoss = stopLoss.value;
  if (input.reduceOnly !== undefined) order.reduceOnly = input.reduceOnly;
  if (positionIdx !== undefined) order.positionIdx = positionIdx;
  return ok(markExchangeOrder(Object.freeze(order)));
}

function parseOptionalProtectionPrice(
  input: Record<string, unknown>,
  field: "takeProfit" | "stopLoss",
): Result<DecimalValue | null | undefined> {
  if (!Object.hasOwn(input, field) || input[field] === undefined)
    return ok(undefined);
  if (input[field] === null) return ok(null);
  const value = DecimalValue.fromString(input[field]);
  return value.ok && value.value.isPositive()
    ? value
    : fail(domainError("INVALID_VALUE", `${field} must be positive or null`));
}
