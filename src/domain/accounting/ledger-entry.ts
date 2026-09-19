import { DecimalValue } from "../shared/decimal.js";
import { domainError } from "../shared/errors.js";
import { parseUtcTimestamp, type UtcTimestamp } from "../shared/time.js";
import { fail, ok, type Result } from "../shared/result.js";
import { isRecord, requireIdentifier } from "../shared/validation.js";

export type LedgerEventKind = "fill" | "fee" | "funding" | "cash-adjustment";

export interface LedgerEntry {
  readonly entryId: string;
  readonly kind: LedgerEventKind;
  readonly amount: DecimalValue;
  readonly currency: string;
  readonly occurredAt: UtcTimestamp;
  readonly source: string;
  readonly referenceId: string;
}

export function createLedgerEntry(input: unknown): Result<LedgerEntry> {
  if (!isRecord(input))
    return fail(
      domainError("INVALID_ACCOUNTING", "ledger event must be an object"),
    );
  const entryId = requireIdentifier(input.entryId, "entryId");
  const kind = input.kind;
  const amount = DecimalValue.fromString(input.amount);
  const currency = requireIdentifier(input.currency, "currency");
  const occurredAt = parseUtcTimestamp(input.occurredAt);
  const source = requireIdentifier(input.source, "source");
  const referenceId = requireIdentifier(input.referenceId, "referenceId");
  if (
    !entryId.ok ||
    !amount.ok ||
    !currency.ok ||
    !occurredAt.ok ||
    !source.ok ||
    !referenceId.ok ||
    (kind !== "fill" &&
      kind !== "fee" &&
      kind !== "funding" &&
      kind !== "cash-adjustment")
  ) {
    return fail(
      domainError(
        "INVALID_ACCOUNTING",
        "ledger event contains an invalid field",
      ),
    );
  }
  return ok(
    Object.freeze({
      entryId: entryId.value,
      kind,
      amount: amount.value,
      currency: currency.value,
      occurredAt: occurredAt.value,
      source: source.value,
      referenceId: referenceId.value,
    }),
  );
}
