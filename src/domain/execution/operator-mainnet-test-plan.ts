import {
  canonicalSerialize,
  hashCanonical,
  type PlanHash,
} from "../identity/canonical-serialization.js";
import {
  MARKET_EVIDENCE_SYMBOLS,
  type MarketEvidenceSymbol,
} from "../market/market-evidence-bundle.js";
import {
  createInstrumentConstraints,
  type InstrumentConstraints,
} from "../market/instrument-constraints.js";
import {
  DecimalValue,
  RoundingMode,
  isDecimalValue,
} from "../shared/decimal.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { domainError } from "../shared/errors.js";
import { fail, ok, type Result } from "../shared/result.js";
import {
  parseUtcTimestamp,
  timestampToEpochMs,
  type UtcTimestamp,
} from "../shared/time.js";
import {
  isRecord,
  requireHash,
  requireIdentifier,
} from "../shared/validation.js";
import { closedRecord } from "../planning/planning-validation.js";

export const OPERATOR_MAINNET_QUOTE_SCHEMA_VERSION =
  "bybit-linear-operator-quote/v1" as const;
export const OPERATOR_MAINNET_TEST_PLAN_SCHEMA_VERSION =
  "operator-mainnet-execution-test/v1" as const;
export const OPERATOR_MAINNET_TEST_APPROVAL_SCHEMA_VERSION =
  "operator-mainnet-execution-approval/v1" as const;
export const OPERATOR_MAINNET_TEST_POLICY_VERSION =
  "operator-mainnet-test/v1" as const;
export const OPERATOR_MAINNET_QUOTE_FRESHNESS_MS = 5_000 as const;
export const OPERATOR_MAINNET_APPROVAL_TTL_MS = 900_000 as const;

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
const PLAN_FIELDS = [
  "schemaVersion",
  "policyVersion",
  "environment",
  "accountIdentityHash",
  "symbol",
  "nonce",
  "clientOrderId",
  "quote",
  "warningCodes",
  "constraints",
  "allocation",
  "grossNotionalCap",
  "maxDeviationBps",
  "quoteBidRange",
  "entry",
  "effectiveGrossNotional",
  "effectiveBudget",
  "preparedAt",
  "quoteFreshnessMs",
  "approvalTtlMs",
  "contentHash",
] as const;
const OPERATOR_WARNING_CODES = ["API_KEY_IP_UNBOUND"] as const;
const APPROVAL_FIELDS = [
  "schemaVersion",
  "approvalId",
  "contentHash",
  "planHash",
  "planArtifactHash",
  "sourceId",
  "clientOrderId",
  "actor",
  "consent",
  "approvedAt",
  "expiresAt",
  "policyVersion",
  "executionAuthority",
  "replayInputs",
] as const;
const CONSTRAINT_FIELDS = [
  "instrument",
  "version",
  "priceTickSize",
  "quantityStep",
  "minQuantity",
  "minNotional",
  "minPrice",
  "maxPrice",
  "maxLimitQuantity",
] as const;

export interface OperatorMainnetQuote {
  readonly schemaVersion: typeof OPERATOR_MAINNET_QUOTE_SCHEMA_VERSION;
  readonly exchange: "bybit";
  readonly environment: "mainnet";
  readonly category: "linear";
  readonly origin: "https://api.bybit.com";
  readonly symbol: MarketEvidenceSymbol;
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

export interface OperatorMainnetQuoteBidRange {
  readonly lower: DecimalValue;
  readonly upper: DecimalValue;
}

export interface OperatorMainnetTestEntry {
  readonly side: "Buy";
  readonly orderType: "Limit";
  readonly timeInForce: "GTC";
  readonly limitPrice: DecimalValue;
  readonly quantity: DecimalValue;
  readonly takeProfit: {
    readonly tpslMode: "Partial";
    readonly orderType: "Market";
    readonly triggerBy: "LastPrice";
    readonly triggerPrice: DecimalValue;
    readonly grossTargetPercent: DecimalValue;
  };
  readonly stopLoss: "none";
}

export interface OperatorMainnetTestPlan {
  readonly schemaVersion: typeof OPERATOR_MAINNET_TEST_PLAN_SCHEMA_VERSION;
  readonly policyVersion: typeof OPERATOR_MAINNET_TEST_POLICY_VERSION;
  readonly environment: "mainnet";
  readonly accountIdentityHash: string;
  readonly symbol: MarketEvidenceSymbol;
  readonly nonce: string;
  readonly clientOrderId: string;
  readonly quote: OperatorMainnetQuote;
  readonly warningCodes: readonly (typeof OPERATOR_WARNING_CODES)[number][];
  readonly constraints: InstrumentConstraints;
  readonly allocation: DecimalValue;
  readonly grossNotionalCap: DecimalValue;
  readonly maxDeviationBps: DecimalValue;
  readonly quoteBidRange: OperatorMainnetQuoteBidRange;
  readonly entry: OperatorMainnetTestEntry;
  readonly effectiveGrossNotional: DecimalValue;
  readonly effectiveBudget: DecimalValue;
  readonly preparedAt: UtcTimestamp;
  readonly quoteFreshnessMs: typeof OPERATOR_MAINNET_QUOTE_FRESHNESS_MS;
  readonly approvalTtlMs: typeof OPERATOR_MAINNET_APPROVAL_TTL_MS;
  readonly contentHash: PlanHash;
}

export interface OperatorMainnetTestApproval {
  readonly schemaVersion: typeof OPERATOR_MAINNET_TEST_APPROVAL_SCHEMA_VERSION;
  readonly approvalId: string;
  readonly contentHash: PlanHash;
  readonly planHash: PlanHash;
  readonly planArtifactHash: PlanHash;
  readonly sourceId: string;
  readonly clientOrderId: string;
  readonly actor: string;
  readonly consent: true;
  readonly approvedAt: UtcTimestamp;
  readonly expiresAt: UtcTimestamp;
  readonly policyVersion: typeof OPERATOR_MAINNET_TEST_POLICY_VERSION;
  readonly executionAuthority: "none";
  readonly replayInputs: { readonly plan: OperatorMainnetTestPlan };
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

function closedConstraintRecord(value: unknown): boolean {
  return (
    closedRecord(value, CONSTRAINT_FIELDS) &&
    [
      "instrument",
      "version",
      "priceTickSize",
      "quantityStep",
      "minQuantity",
    ].every((key) => Object.hasOwn(value, key))
  );
}

function invalidPlan(message = "operator Mainnet test plan is invalid") {
  return fail(domainError("INVALID_PLAN", message));
}

function invalidQuote(message = "operator Mainnet quote is invalid") {
  return fail(domainError("INVALID_EVIDENCE", message));
}

function invalidApproval(
  message = "operator Mainnet test approval is invalid",
) {
  return fail(domainError("INVALID_APPROVAL", message));
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
  readonly symbol: MarketEvidenceSymbol;
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
    !MARKET_EVIDENCE_SYMBOLS.includes(input.symbol as MarketEvidenceSymbol)
  )
    return invalidQuote(
      "quote source or symbol is outside the Bybit M1 linear scope",
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
    symbol: input.symbol as MarketEvidenceSymbol,
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

function derivedClientOrderId(
  accountIdentityHash: string,
  symbol: MarketEvidenceSymbol,
  nonce: string,
): Result<string> {
  const digest = hashCanonical({
    identityVersion: "operator-mainnet-client-order/v1",
    exchange: "bybit",
    environment: "mainnet",
    category: "linear",
    accountIdentityHash,
    symbol,
    nonce,
  });
  if (!digest.ok) return digest;
  return ok(`omt-${digest.value.slice(7, 39)}`);
}

export function deriveOperatorMainnetTestSourceId(
  planHashInput: unknown,
): Result<string> {
  const planHash = requireHash(planHashInput, "planHash");
  if (!planHash.ok) return planHash;
  const digest = hashCanonical({
    identityVersion: "operator-mainnet-source/v1",
    planHash: planHash.value,
  });
  return digest.ok
    ? ok(`operator-mainnet-test:${digest.value.slice(7, 47)}`)
    : digest;
}

function canonicalizePlanInput(
  input: unknown,
): Result<OperatorMainnetTestPlan> {
  const inputFields = [
    "accountIdentityHash",
    "symbol",
    "nonce",
    "allocation",
    "grossNotionalCap",
    "maxDeviationBps",
    "quote",
    "warningCodes",
    "constraints",
    "preparedAt",
  ] as const;
  if (!exactRecord(input, inputFields)) return invalidPlan();
  const accountIdentityHash = requireHash(
    input.accountIdentityHash,
    "accountIdentityHash",
  );
  const nonce = requireIdentifier(input.nonce, "nonce");
  const preparedAt = parseUtcTimestamp(input.preparedAt);
  const allocation = positiveDecimal(input.allocation, "allocation");
  const grossNotionalCap = positiveDecimal(
    input.grossNotionalCap,
    "grossNotionalCap",
  );
  const maxDeviationBps = positiveDecimal(
    input.maxDeviationBps,
    "maxDeviationBps",
  );
  const quote = rehydrateOperatorMainnetQuote(input.quote);
  const constraints = closedConstraintRecord(input.constraints)
    ? createInstrumentConstraints(input.constraints)
    : invalidPlan("instrument constraints contain unknown or accessor fields");
  if (
    !accountIdentityHash.ok ||
    !nonce.ok ||
    !preparedAt.ok ||
    !allocation.ok ||
    !grossNotionalCap.ok ||
    !maxDeviationBps.ok ||
    !quote.ok ||
    !constraints.ok ||
    typeof input.symbol !== "string" ||
    !MARKET_EVIDENCE_SYMBOLS.includes(input.symbol as MarketEvidenceSymbol)
  )
    return invalidPlan(
      "plan requires a valid account, symbol, quote, constraints and explicit budget",
    );
  const symbol = input.symbol as MarketEvidenceSymbol;
  if (
    !Array.isArray(input.warningCodes) ||
    input.warningCodes.length > OPERATOR_WARNING_CODES.length ||
    Reflect.ownKeys(input.warningCodes).length !==
      input.warningCodes.length + 1 ||
    !Object.values(Object.getOwnPropertyDescriptors(input.warningCodes)).every(
      (d) => Object.hasOwn(d, "value"),
    ) ||
    input.warningCodes.some(
      (warning) =>
        !OPERATOR_WARNING_CODES.includes(
          warning as (typeof OPERATOR_WARNING_CODES)[number],
        ),
    ) ||
    new Set(input.warningCodes).size !== input.warningCodes.length
  )
    return invalidPlan("readiness warning codes are invalid");
  const warningCodes = [...input.warningCodes].sort();
  const deviationLimit = DecimalValue.fromString("10000");
  if (
    !deviationLimit.ok ||
    maxDeviationBps.value.compare(deviationLimit.value) >= 0
  )
    return invalidPlan(
      "maximum quote deviation must be positive and below 10000 bps",
    );
  if (
    quote.value.symbol !== symbol ||
    constraints.value.instrument !== symbol ||
    constraints.value.minNotional === undefined ||
    constraints.value.minPrice === undefined ||
    constraints.value.maxPrice === undefined ||
    constraints.value.maxLimitQuantity === undefined
  )
    return fail(
      domainError(
        "INVALID_PLAN",
        "quote, symbol and complete venue min/max/notional constraints must match",
        { reasonCode: "INSTRUMENT_CONSTRAINTS_INCOMPLETE_OR_MISMATCHED" },
      ),
    );
  const freshnessAge =
    timestampToEpochMs(preparedAt.value) -
    timestampToEpochMs(quote.value.observedAt);
  if (
    freshnessAge < 0 ||
    freshnessAge > OPERATOR_MAINNET_QUOTE_FRESHNESS_MS ||
    timestampToEpochMs(quote.value.collectionCompletedAt) >
      timestampToEpochMs(preparedAt.value)
  )
    return fail(
      domainError(
        "STALE_EVIDENCE",
        "Bybit quote is not fresh at preparation time",
      ),
    );

  const limitPriceResult = quote.value.bid.floorToStep(
    constraints.value.priceTickSize,
  );
  if (!limitPriceResult.ok || !limitPriceResult.value.isPositive())
    return invalidPlan("best bid rounds below the venue price tick");
  const limitPrice = limitPriceResult.value;
  if (
    (constraints.value.minPrice &&
      limitPrice.compare(constraints.value.minPrice) < 0) ||
    (constraints.value.maxPrice &&
      limitPrice.compare(constraints.value.maxPrice) > 0)
  )
    return fail(
      domainError(
        "CONSTRAINT_VIOLATION",
        "rounded entry price is outside venue bounds",
      ),
    );

  const effectiveBudget =
    allocation.value.compare(grossNotionalCap.value) <= 0
      ? allocation.value
      : grossNotionalCap.value;
  const rawQuantity = effectiveBudget.divide(
    limitPrice,
    1000,
    RoundingMode.DOWN,
  );
  if (!rawQuantity.ok) return rawQuantity;
  const quantityResult = rawQuantity.value.floorToStep(
    constraints.value.quantityStep,
  );
  if (!quantityResult.ok) return quantityResult;
  const quantity = quantityResult.value;
  if (!quantity.isPositive())
    return fail(
      domainError(
        "QUANTITY_TOO_SMALL",
        "operator budget floors below one venue quantity step",
      ),
    );
  if (quantity.compare(constraints.value.minQuantity) < 0)
    return fail(
      domainError(
        "QUANTITY_TOO_SMALL",
        "effective quantity is below the venue minimum",
      ),
    );
  if (
    constraints.value.maxLimitQuantity &&
    quantity.compare(constraints.value.maxLimitQuantity) > 0
  )
    return fail(
      domainError(
        "CONSTRAINT_VIOLATION",
        "effective quantity exceeds the venue limit maximum",
      ),
    );
  const effectiveGrossNotional = limitPrice.multiply(quantity);
  if (effectiveGrossNotional.compare(effectiveBudget) > 0)
    return fail(
      domainError(
        "CONSTRAINT_VIOLATION",
        "effective gross notional exceeds the operator budget",
      ),
    );
  if (
    constraints.value.minNotional &&
    effectiveGrossNotional.compare(constraints.value.minNotional) < 0
  )
    return fail(
      domainError(
        "NOTIONAL_TOO_SMALL",
        "effective gross notional is below the venue minimum",
      ),
    );

  const takeProfitMultiplier = DecimalValue.fromString("1.002");
  const percentageMultiplier = DecimalValue.fromString("100");
  const deviationDivisor = DecimalValue.fromString("10000");
  if (
    !takeProfitMultiplier.ok ||
    !percentageMultiplier.ok ||
    !deviationDivisor.ok
  )
    return invalidPlan("internal exact-decimal policy constants are invalid");
  const takeProfitPrice = limitPrice
    .multiply(takeProfitMultiplier.value)
    .ceilToStep(constraints.value.priceTickSize);
  if (!takeProfitPrice.ok || takeProfitPrice.value.compare(limitPrice) <= 0)
    return fail(
      domainError(
        "CONSTRAINT_VIOLATION",
        "rounded take-profit trigger must exceed the entry price",
      ),
    );
  if (
    (constraints.value.minPrice &&
      takeProfitPrice.value.compare(constraints.value.minPrice) < 0) ||
    (constraints.value.maxPrice &&
      takeProfitPrice.value.compare(constraints.value.maxPrice) > 0)
  )
    return fail(
      domainError(
        "CONSTRAINT_VIOLATION",
        "take-profit trigger is outside venue price bounds",
      ),
    );
  const grossTargetFraction = takeProfitPrice.value
    .subtract(limitPrice)
    .divide(limitPrice, 24, RoundingMode.DOWN);
  if (!grossTargetFraction.ok) return grossTargetFraction;
  const grossTargetPercent = grossTargetFraction.value.multiply(
    percentageMultiplier.value,
  );

  const deviationFraction = maxDeviationBps.value.divide(
    deviationDivisor.value,
    132,
    RoundingMode.DOWN,
  );
  if (!deviationFraction.ok) return deviationFraction;
  const one = DecimalValue.fromString("1");
  if (!one.ok) return invalidPlan("internal exact-decimal constant is invalid");
  const quoteBidRange = {
    lower: quote.value.bid.multiply(
      one.value.subtract(deviationFraction.value),
    ),
    upper: quote.value.bid.multiply(one.value.add(deviationFraction.value)),
  };
  const clientOrderId = derivedClientOrderId(
    accountIdentityHash.value,
    symbol,
    nonce.value,
  );
  if (!clientOrderId.ok) return clientOrderId;

  const payload = {
    schemaVersion: OPERATOR_MAINNET_TEST_PLAN_SCHEMA_VERSION,
    policyVersion: OPERATOR_MAINNET_TEST_POLICY_VERSION,
    environment: "mainnet" as const,
    accountIdentityHash: accountIdentityHash.value,
    symbol,
    nonce: nonce.value,
    clientOrderId: clientOrderId.value,
    quote: quote.value,
    warningCodes,
    constraints: constraints.value,
    allocation: allocation.value,
    grossNotionalCap: grossNotionalCap.value,
    maxDeviationBps: maxDeviationBps.value,
    quoteBidRange,
    entry: {
      side: "Buy" as const,
      orderType: "Limit" as const,
      timeInForce: "GTC" as const,
      limitPrice,
      quantity,
      takeProfit: {
        tpslMode: "Partial" as const,
        orderType: "Market" as const,
        triggerBy: "LastPrice" as const,
        triggerPrice: takeProfitPrice.value,
        grossTargetPercent,
      },
      stopLoss: "none" as const,
    },
    effectiveGrossNotional,
    effectiveBudget,
    preparedAt: preparedAt.value,
    quoteFreshnessMs: OPERATOR_MAINNET_QUOTE_FRESHNESS_MS,
    approvalTtlMs: OPERATOR_MAINNET_APPROVAL_TTL_MS,
  };
  const contentHash = hashCanonical(payload);
  if (!contentHash.ok) return contentHash;
  return ok(deepFreeze({ ...payload, contentHash: contentHash.value }));
}

export function createOperatorMainnetTestPlan(
  input: unknown,
): Result<OperatorMainnetTestPlan> {
  return canonicalizePlanInput(input);
}

export function rehydrateOperatorMainnetTestPlan(
  input: unknown,
): Result<OperatorMainnetTestPlan> {
  if (!exactRecord(input, PLAN_FIELDS)) return invalidPlan();
  const replayed = canonicalizePlanInput({
    accountIdentityHash: input.accountIdentityHash,
    symbol: input.symbol,
    nonce: input.nonce,
    allocation: input.allocation,
    grossNotionalCap: input.grossNotionalCap,
    maxDeviationBps: input.maxDeviationBps,
    quote: input.quote,
    warningCodes: input.warningCodes,
    constraints: input.constraints,
    preparedAt: input.preparedAt,
  });
  const contentHash = requireHash(input.contentHash, "contentHash");
  if (
    !replayed.ok ||
    !contentHash.ok ||
    replayed.value.contentHash !== contentHash.value ||
    replayed.value.clientOrderId !== input.clientOrderId
  )
    return invalidPlan(
      "operator plan identity differs from deterministic replay",
    );
  const actual = canonicalSerialize(input);
  const expected = canonicalSerialize(replayed.value);
  return actual.ok && expected.ok && actual.value === expected.value
    ? replayed
    : invalidPlan("operator plan differs from deterministic replay");
}

export function validateOperatorMainnetQuoteForPlan(
  planInput: unknown,
  quoteInput: unknown,
  now: unknown,
): Result<OperatorMainnetQuote> {
  const plan = rehydrateOperatorMainnetTestPlan(planInput);
  const quote = rehydrateOperatorMainnetQuote(quoteInput);
  const at = parseUtcTimestamp(now);
  if (!plan.ok || !quote.ok || !at.ok)
    return invalidQuote(
      "exact plan, quote and provider evaluation time are required",
    );
  if (
    quote.value.symbol !== plan.value.symbol ||
    quote.value.exchange !== "bybit" ||
    quote.value.environment !== "mainnet" ||
    quote.value.category !== "linear" ||
    quote.value.origin !== "https://api.bybit.com"
  )
    return invalidQuote(
      "fresh quote does not match the approved Bybit linear scope",
    );
  const age =
    timestampToEpochMs(at.value) - timestampToEpochMs(quote.value.observedAt);
  if (
    age < 0 ||
    age > plan.value.quoteFreshnessMs ||
    timestampToEpochMs(quote.value.collectionCompletedAt) >
      timestampToEpochMs(at.value)
  )
    return fail(
      domainError("STALE_EVIDENCE", "fresh quote is stale or future dated"),
    );
  if (
    quote.value.bid.compare(plan.value.quoteBidRange.lower) < 0 ||
    quote.value.bid.compare(plan.value.quoteBidRange.upper) > 0
  )
    return fail(
      domainError(
        "CONSTRAINT_VIOLATION",
        "fresh Bybit best bid is outside the approved quote deviation range",
      ),
    );
  return quote;
}

function canonicalizeApproval(
  input: unknown,
): Result<OperatorMainnetTestApproval> {
  const inputFields = [
    "plan",
    "planHash",
    "actor",
    "consent",
    "approvedAt",
  ] as const;
  if (!exactRecord(input, inputFields) || input.consent !== true)
    return invalidApproval(
      "explicit consent for an exact operator plan is required",
    );
  const plan = rehydrateOperatorMainnetTestPlan(input.plan);
  const planHash = requireHash(input.planHash, "planHash");
  const actor = requireIdentifier(input.actor, "actor");
  const approvedAt = parseUtcTimestamp(input.approvedAt);
  if (
    !plan.ok ||
    !planHash.ok ||
    !actor.ok ||
    !approvedAt.ok ||
    plan.value.contentHash !== planHash.value ||
    timestampToEpochMs(approvedAt.value) <
      timestampToEpochMs(plan.value.preparedAt)
  )
    return invalidApproval(
      "approval must bind the exact plan and follow its preparation",
    );
  const expiresAt = new Date(
    timestampToEpochMs(approvedAt.value) + OPERATOR_MAINNET_APPROVAL_TTL_MS,
  ).toISOString() as UtcTimestamp;
  const planArtifactHash = hashCanonical(plan.value);
  if (!planArtifactHash.ok) return planArtifactHash;
  const sourceId = deriveOperatorMainnetTestSourceId(plan.value.contentHash);
  if (!sourceId.ok) return sourceId;
  const payload = {
    schemaVersion: OPERATOR_MAINNET_TEST_APPROVAL_SCHEMA_VERSION,
    planHash: plan.value.contentHash,
    planArtifactHash: planArtifactHash.value,
    sourceId: sourceId.value,
    clientOrderId: plan.value.clientOrderId,
    actor: actor.value,
    consent: true as const,
    approvedAt: approvedAt.value,
    expiresAt,
    policyVersion: OPERATOR_MAINNET_TEST_POLICY_VERSION,
    executionAuthority: "none" as const,
    replayInputs: { plan: plan.value },
  };
  const approvalIdHash = hashCanonical(payload);
  if (!approvalIdHash.ok) return approvalIdHash;
  const identified = {
    ...payload,
    approvalId: `operator-mainnet-test-approval:${approvalIdHash.value.slice(7, 47)}`,
  };
  const contentHash = hashCanonical(identified);
  if (!contentHash.ok) return contentHash;
  return ok(deepFreeze({ ...identified, contentHash: contentHash.value }));
}

export function createOperatorMainnetTestApproval(
  input: unknown,
): Result<OperatorMainnetTestApproval> {
  return canonicalizeApproval(input);
}

export function rehydrateOperatorMainnetTestApproval(
  input: unknown,
): Result<OperatorMainnetTestApproval> {
  if (
    !exactRecord(input, APPROVAL_FIELDS) ||
    !exactRecord(input.replayInputs, ["plan"])
  )
    return invalidApproval();
  const replayed = canonicalizeApproval({
    plan: input.replayInputs.plan,
    planHash: input.planHash,
    actor: input.actor,
    consent: input.consent,
    approvedAt: input.approvedAt,
  });
  const contentHash = requireHash(input.contentHash, "contentHash");
  if (
    !replayed.ok ||
    !contentHash.ok ||
    replayed.value.contentHash !== contentHash.value
  )
    return invalidApproval(
      "approval identity differs from deterministic replay",
    );
  const actual = canonicalSerialize(input);
  const expected = canonicalSerialize(replayed.value);
  return actual.ok && expected.ok && actual.value === expected.value
    ? replayed
    : invalidApproval("approval differs from deterministic replay");
}

export function validateOperatorMainnetTestApproval(
  approvalInput: unknown,
  planInput: unknown,
  approvalHashInput: unknown,
  now: unknown,
): Result<OperatorMainnetTestApproval> {
  const approval = rehydrateOperatorMainnetTestApproval(approvalInput);
  const plan = rehydrateOperatorMainnetTestPlan(planInput);
  const approvalHash = requireHash(approvalHashInput, "approvalHash");
  const at = parseUtcTimestamp(now);
  if (!approval.ok || !plan.ok || !approvalHash.ok || !at.ok)
    return invalidApproval("exact approval and plan identity are required");
  const sourceId = deriveOperatorMainnetTestSourceId(plan.value.contentHash);
  if (
    !sourceId.ok ||
    approval.value.contentHash !== approvalHash.value ||
    approval.value.planHash !== plan.value.contentHash ||
    approval.value.sourceId !== sourceId.value ||
    approval.value.clientOrderId !== plan.value.clientOrderId
  )
    return invalidApproval("exact approval and plan identity are required");
  if (
    timestampToEpochMs(at.value) <
      timestampToEpochMs(approval.value.approvedAt) ||
    timestampToEpochMs(at.value) >= timestampToEpochMs(approval.value.expiresAt)
  )
    return fail(
      domainError("PLAN_EXPIRED", "operator approval is not currently valid"),
    );
  return approval;
}
