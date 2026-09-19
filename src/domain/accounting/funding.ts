import { DecimalValue } from "../shared/decimal.js";
import { domainError } from "../shared/errors.js";
import { parseUtcTimestamp, type UtcTimestamp } from "../shared/time.js";
import { fail, ok, type Result } from "../shared/result.js";
import {
  isRecord,
  requireIdentifier,
  requireSafeText,
} from "../shared/validation.js";

export interface Funding {
  readonly fundingId: string;
  readonly amount: DecimalValue;
  readonly currency: string;
  readonly occurredAt: UtcTimestamp;
  readonly source: string;
}

export function createFunding(input: unknown): Result<Funding> {
  if (!isRecord(input))
    return fail(domainError("INVALID_ACCOUNTING", "funding must be an object"));
  const fundingId = requireIdentifier(input.fundingId, "fundingId");
  const amount = DecimalValue.fromString(input.amount);
  const currency = requireIdentifier(input.currency, "currency");
  const occurredAt = parseUtcTimestamp(input.occurredAt);
  const source = requireSafeText(input.source, "source");
  if (
    !fundingId.ok ||
    !amount.ok ||
    !currency.ok ||
    !occurredAt.ok ||
    !source.ok
  ) {
    return fail(
      domainError("INVALID_ACCOUNTING", "funding contains an invalid field"),
    );
  }
  return ok(
    Object.freeze({
      fundingId: fundingId.value,
      amount: amount.value,
      currency: currency.value,
      occurredAt: occurredAt.value,
      source: source.value,
    }),
  );
}
