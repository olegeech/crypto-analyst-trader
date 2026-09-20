import { DecimalValue } from "../shared/decimal.js";
import { domainError } from "../shared/errors.js";
import { parseUtcTimestamp, type UtcTimestamp } from "../shared/time.js";
import { fail, ok, type Result } from "../shared/result.js";
import {
  isRecord,
  requireIdentifier,
  requireSafeText,
} from "../shared/validation.js";

export type FeeKind = "trading" | "settlement";

export interface Fee {
  readonly feeId: string;
  readonly amount: DecimalValue;
  readonly currency: string;
  readonly kind: FeeKind;
  readonly chargedAt: UtcTimestamp;
  readonly source: string;
}

export function createFee(input: unknown): Result<Fee> {
  if (!isRecord(input))
    return fail(domainError("INVALID_ACCOUNTING", "fee must be an object"));
  const feeId = requireIdentifier(input.feeId, "feeId");
  const amount = DecimalValue.fromString(input.amount);
  const currency = requireIdentifier(input.currency, "currency");
  const chargedAt = parseUtcTimestamp(input.chargedAt);
  const source = requireSafeText(input.source, "source");
  if (
    !feeId.ok ||
    !amount.ok ||
    !currency.ok ||
    !chargedAt.ok ||
    !source.ok ||
    amount.value.isNegative() ||
    (input.kind !== "trading" && input.kind !== "settlement")
  ) {
    return fail(
      domainError("INVALID_ACCOUNTING", "fee contains an invalid field"),
    );
  }
  return ok(
    Object.freeze({
      feeId: feeId.value,
      amount: amount.value,
      currency: currency.value,
      kind: input.kind,
      chargedAt: chargedAt.value,
      source: source.value,
    }),
  );
}
