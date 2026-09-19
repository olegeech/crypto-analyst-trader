import { DecimalValue } from "../shared/decimal.js";
import { domainError } from "../shared/errors.js";
import { parseUtcTimestamp, type UtcTimestamp } from "../shared/time.js";
import { fail, ok, type Result } from "../shared/result.js";
import {
  isRecord,
  requireIdentifier,
  requireSafeText,
} from "../shared/validation.js";

export interface Fill {
  readonly fillId: string;
  readonly attemptId: string;
  readonly exchangeOrderId: string;
  readonly instrument: string;
  readonly side: "buy" | "sell";
  readonly quantity: DecimalValue;
  readonly price: DecimalValue;
  readonly executedAt: UtcTimestamp;
  readonly source: string;
}

export function createFill(input: unknown): Result<Fill> {
  if (!isRecord(input))
    return fail(domainError("INVALID_ACCOUNTING", "fill must be an object"));
  const fillId = requireIdentifier(input.fillId, "fillId");
  const attemptId = requireIdentifier(input.attemptId, "attemptId");
  const exchangeOrderId = requireIdentifier(
    input.exchangeOrderId,
    "exchangeOrderId",
  );
  const instrument = requireIdentifier(input.instrument, "instrument");
  const quantity = DecimalValue.fromString(input.quantity);
  const price = DecimalValue.fromString(input.price);
  const executedAt = parseUtcTimestamp(input.executedAt);
  const source = requireSafeText(input.source, "source");
  if (
    !fillId.ok ||
    !attemptId.ok ||
    !exchangeOrderId.ok ||
    !instrument.ok ||
    (input.side !== "buy" && input.side !== "sell") ||
    !quantity.ok ||
    !price.ok ||
    !executedAt.ok ||
    !source.ok ||
    !quantity.value.isPositive() ||
    !price.value.isPositive()
  ) {
    return fail(
      domainError("INVALID_ACCOUNTING", "fill contains an invalid field"),
    );
  }
  return ok(
    Object.freeze({
      fillId: fillId.value,
      attemptId: attemptId.value,
      exchangeOrderId: exchangeOrderId.value,
      instrument: instrument.value,
      side: input.side,
      quantity: quantity.value,
      price: price.value,
      executedAt: executedAt.value,
      source: source.value,
    }),
  );
}
