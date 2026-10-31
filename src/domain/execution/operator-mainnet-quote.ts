import {
  canonicalSerialize,
  hashCanonical,
  type PlanHash,
} from "../identity/canonical-serialization.js";
import { DecimalValue, isDecimalValue } from "../shared/decimal.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { domainError } from "../shared/errors.js";
import { fail, ok, type Result } from "../shared/result.js";
import {
  parseUtcTimestamp,
  timestampToEpochMs,
  type UtcTimestamp,
} from "../shared/time.js";
import { isRecord, requireHash } from "../shared/validation.js";

export const OPERATOR_MAINNET_QUOTE_SCHEMA_VERSION =
  "bybit-linear-operator-quote/v1" as const;
export const OPERATOR_MAINNET_QUOTE_FRESHNESS_MS = 5_000 as const;

const QUOTE_FIELDS = [
  "schemaVersion",
  "exchange",
  "environment",
  "category",
  "origin",
  "symbol",
  "observedAt",
  "collectionStartedAt",
  "collectionCompletedAt",
  "bid",
  "ask",
  "last",
  "contentHash",
] as const;

export interface OperatorMainnetQuote {
  readonly schemaVersion: typeof OPERATOR_MAINNET_QUOTE_SCHEMA_VERSION;
  readonly exchange: "bybit";
  readonly environment: "mainnet";
  readonly category: "linear";
  readonly origin: "https://api.bybit.com";
  readonly symbol: string;
  /** Bybit's response envelope time, not local receipt time. */
  readonly observedAt: UtcTimestamp;
  /** Exchange-time reads bracketing the ticker request. */
  readonly collectionStartedAt: UtcTimestamp;
  readonly collectionCompletedAt: UtcTimestamp;
  readonly bid: DecimalValue;
  readonly ask: DecimalValue;
  readonly last: DecimalValue;
  readonly contentHash: PlanHash;
}

function exactRecord(
  value: unknown,
  fields: readonly string[],
): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null) &&
    Reflect.ownKeys(value).length === fields.length &&
    fields.every(
      (field) =>
        Object.hasOwn(value, field) &&
        Object.hasOwn(Object.getOwnPropertyDescriptor(value, field)!, "value"),
    )
  );
}

function invalidQuote(
  message = "operator Mainnet quote is invalid",
): Result<never> {
  return fail(domainError("INVALID_EVIDENCE", message));
}

function decimalInput(value: unknown, field: string): Result<DecimalValue> {
  if (isDecimalValue(value)) {
    return value.toString().length <= 128
      ? ok(value)
      : fail(
          domainError("INVALID_DECIMAL", `${field} exceeds the decimal limit`, {
            field,
          }),
        );
  }
  if (typeof value !== "string" || value.length > 128) {
    return fail(
      domainError("INVALID_DECIMAL", `${field} must be a bounded decimal`, {
        field,
      }),
    );
  }
  const parsed = DecimalValue.fromString(value);
  return parsed.ok
    ? parsed
    : fail(
        domainError("INVALID_DECIMAL", `${field} is not a decimal`, { field }),
      );
}

function positiveDecimal(value: unknown, field: string): Result<DecimalValue> {
  const parsed = decimalInput(value, field);
  if (!parsed.ok || !parsed.value.isPositive()) {
    return fail(
      domainError("INVALID_DECIMAL", `${field} must be positive`, { field }),
    );
  }
  return parsed;
}

function quotePayload(input: {
  readonly symbol: string;
  readonly observedAt: UtcTimestamp;
  readonly collectionStartedAt: UtcTimestamp;
  readonly collectionCompletedAt: UtcTimestamp;
  readonly bid: DecimalValue;
  readonly ask: DecimalValue;
  readonly last: DecimalValue;
}) {
  return {
    schemaVersion: OPERATOR_MAINNET_QUOTE_SCHEMA_VERSION,
    exchange: "bybit" as const,
    environment: "mainnet" as const,
    category: "linear" as const,
    origin: "https://api.bybit.com" as const,
    symbol: input.symbol,
    observedAt: input.observedAt,
    collectionStartedAt: input.collectionStartedAt,
    collectionCompletedAt: input.collectionCompletedAt,
    bid: input.bid,
    ask: input.ask,
    last: input.last,
  };
}

export function createOperatorMainnetQuote(
  input: unknown,
): Result<OperatorMainnetQuote> {
  const inputFields = [
    "symbol",
    "exchange",
    "environment",
    "category",
    "origin",
    "observedAt",
    "collectionStartedAt",
    "collectionCompletedAt",
    "bid",
    "ask",
    "last",
  ] as const;
  if (!exactRecord(input, inputFields)) return invalidQuote();
  if (
    input.exchange !== "bybit" ||
    input.environment !== "mainnet" ||
    input.category !== "linear" ||
    input.origin !== "https://api.bybit.com" ||
    typeof input.symbol !== "string" ||
    !/^[A-Z0-9]{2,32}$/u.test(input.symbol)
  )
    return invalidQuote(
      "quote source or symbol is outside the Bybit linear scope",
    );
  const observedAt = parseUtcTimestamp(input.observedAt);
  const collectionStartedAt = parseUtcTimestamp(input.collectionStartedAt);
  const collectionCompletedAt = parseUtcTimestamp(input.collectionCompletedAt);
  const bid = positiveDecimal(input.bid, "bid");
  const ask = positiveDecimal(input.ask, "ask");
  const last = positiveDecimal(input.last, "last");
  if (
    !observedAt.ok ||
    !collectionStartedAt.ok ||
    !collectionCompletedAt.ok ||
    !bid.ok ||
    !ask.ok ||
    !last.ok
  )
    return invalidQuote("quote contains malformed provider facts");
  const startedMs = timestampToEpochMs(collectionStartedAt.value);
  const completedMs = timestampToEpochMs(collectionCompletedAt.value);
  const observedMs = timestampToEpochMs(observedAt.value);
  if (
    startedMs > completedMs ||
    completedMs - startedMs > OPERATOR_MAINNET_QUOTE_FRESHNESS_MS ||
    observedMs < startedMs ||
    observedMs > completedMs
  )
    return invalidQuote(
      "provider time is not coherent with quote collection bounds",
    );
  if (bid.value.compare(ask.value) > 0)
    return invalidQuote("quote must contain a positive, non-crossed book");
  const payload = quotePayload({
    symbol: input.symbol,
    observedAt: observedAt.value,
    collectionStartedAt: collectionStartedAt.value,
    collectionCompletedAt: collectionCompletedAt.value,
    bid: bid.value,
    ask: ask.value,
    last: last.value,
  });
  const contentHash = hashCanonical(payload);
  if (!contentHash.ok) return contentHash;
  return ok(deepFreeze({ ...payload, contentHash: contentHash.value }));
}

export function rehydrateOperatorMainnetQuote(
  input: unknown,
): Result<OperatorMainnetQuote> {
  if (!exactRecord(input, QUOTE_FIELDS)) return invalidQuote();
  const parsed = createOperatorMainnetQuote({
    symbol: input.symbol,
    exchange: input.exchange,
    environment: input.environment,
    category: input.category,
    origin: input.origin,
    observedAt: input.observedAt,
    collectionStartedAt: input.collectionStartedAt,
    collectionCompletedAt: input.collectionCompletedAt,
    bid: input.bid,
    ask: input.ask,
    last: input.last,
  });
  const hash = requireHash(input.contentHash, "contentHash");
  if (!parsed.ok || !hash.ok || parsed.value.contentHash !== hash.value)
    return invalidQuote("quote identity does not match its provider facts");
  const actual = canonicalSerialize(input);
  const expected = canonicalSerialize(parsed.value);
  return actual.ok && expected.ok && actual.value === expected.value
    ? parsed
    : invalidQuote("quote differs from deterministic replay");
}
