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
  readonly averagePrice?: DecimalValue;
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
  const requestedQuantity = DecimalValue.fromString(input.requestedQuantity);
  const filledQuantity = parseDecimal(input.filledQuantity, "filledQuantity");
  if (
    !exchangeOrderId.ok ||
    !clientOrderId.ok ||
    !instrument.ok ||
    !source.ok ||
    !observedAt.ok ||
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
    averagePrice?: DecimalValue;
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
  };
  if (averagePrice !== undefined) order.averagePrice = averagePrice;
  return ok(markExchangeOrder(Object.freeze(order)));
}
