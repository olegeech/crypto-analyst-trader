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
import {
  OPERATOR_MAINNET_APPROVAL_TTL_MS,
  OPERATOR_MAINNET_TRADE_COMMAND_RECEIPT_V1_SCHEMA_VERSION,
  operatorMainnetTradeCommandTakeProfit,
  rehydrateOperatorMainnetTradeCommandReceipt,
} from "./operator-mainnet-trade-command-receipt.js";
import {
  OPERATOR_MAINNET_QUOTE_FRESHNESS_MS,
  rehydrateOperatorMainnetQuote,
  type OperatorMainnetQuote,
} from "./operator-mainnet-quote.js";

export {
  OPERATOR_MAINNET_QUOTE_FRESHNESS_MS,
  OPERATOR_MAINNET_QUOTE_SCHEMA_VERSION,
  createOperatorMainnetQuote,
  rehydrateOperatorMainnetQuote,
} from "./operator-mainnet-quote.js";
export type { OperatorMainnetQuote } from "./operator-mainnet-quote.js";

export { OPERATOR_MAINNET_APPROVAL_TTL_MS } from "./operator-mainnet-trade-command-receipt.js";

export const OPERATOR_MAINNET_TEST_PLAN_SCHEMA_VERSION =
  "operator-mainnet-execution-test/v1" as const;
export const OPERATOR_MAINNET_RECOVERY_TEST_PLAN_SCHEMA_VERSION =
  "operator-mainnet-execution-test/v2" as const;
export const OPERATOR_MAINNET_TRADE_COMMAND_PLAN_SCHEMA_VERSION =
  "operator-mainnet-execution-test/v3" as const;
export const OPERATOR_MAINNET_TEST_APPROVAL_SCHEMA_VERSION =
  "operator-mainnet-execution-approval/v1" as const;
export const OPERATOR_MAINNET_TEST_POLICY_VERSION =
  "operator-mainnet-test/v1" as const;
export const OPERATOR_MAINNET_TRADE_COMMAND_POLICY_VERSION =
  "operator-mainnet-direct-command/v1" as const;
const PLAN_V1_FIELDS = [
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
const PLAN_V2_FIELDS = [
  ...PLAN_V1_FIELDS.slice(0, -1),
  "recoveryAttestationHash",
  "contentHash",
] as const;
const PLAN_V3_FIELDS = [
  ...PLAN_V1_FIELDS.slice(0, -1),
  "commandId",
  "commandReceiptHash",
  "commandAcceptedAt",
  "commandExpiresAt",
  "tradeCommandReceipt",
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
  readonly schemaVersion:
    | typeof OPERATOR_MAINNET_TEST_PLAN_SCHEMA_VERSION
    | typeof OPERATOR_MAINNET_RECOVERY_TEST_PLAN_SCHEMA_VERSION
    | typeof OPERATOR_MAINNET_TRADE_COMMAND_PLAN_SCHEMA_VERSION;
  readonly policyVersion:
    | typeof OPERATOR_MAINNET_TEST_POLICY_VERSION
    | typeof OPERATOR_MAINNET_TRADE_COMMAND_POLICY_VERSION;
  readonly environment: "mainnet";
  readonly accountIdentityHash: string;
  readonly symbol: string;
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
  readonly recoveryAttestationHash?: PlanHash;
  readonly commandId?: string;
  readonly commandReceiptHash?: PlanHash;
  readonly commandAcceptedAt?: UtcTimestamp;
  readonly commandExpiresAt?: UtcTimestamp;
  readonly tradeCommandReceipt?: Readonly<Record<string, unknown>>;
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

function invalidQuote(
  message = "operator Mainnet quote is invalid",
  details: Readonly<Record<string, string | number | boolean | null>> = {},
) {
  return fail(domainError("INVALID_EVIDENCE", message, details));
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

function derivedClientOrderId(
  accountIdentityHash: string,
  symbol: string,
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
  options: {
    readonly directCommand?: boolean;
    readonly takeProfit?: {
      readonly mode: "percent" | "price";
      readonly value: DecimalValue;
    };
    readonly legacyDirectPolicy?: boolean;
  } = {},
): Result<OperatorMainnetTestPlan> {
  const baseFields = [
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
  const hasRecoveryAttestation =
    typeof input === "object" &&
    input !== null &&
    Object.hasOwn(input, "recoveryAttestationHash");
  const inputFields = hasRecoveryAttestation
    ? [...baseFields, "recoveryAttestationHash"]
    : baseFields;
  if (!exactRecord(input, inputFields)) return invalidPlan();
  const accountIdentityHash = requireHash(
    input.accountIdentityHash,
    "accountIdentityHash",
  );
  const nonce = requireIdentifier(input.nonce, "nonce");
  const preparedAt = parseUtcTimestamp(input.preparedAt);
  const recoveryAttestationHash = hasRecoveryAttestation
    ? requireHash(input.recoveryAttestationHash, "recoveryAttestationHash")
    : undefined;
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
    (recoveryAttestationHash !== undefined && !recoveryAttestationHash.ok) ||
    typeof input.symbol !== "string" ||
    (options.directCommand === true
      ? !/^[A-Z0-9]{1,26}USDT$/u.test(input.symbol)
      : !MARKET_EVIDENCE_SYMBOLS.includes(input.symbol as MarketEvidenceSymbol))
  )
    return invalidPlan(
      "plan requires a valid account, symbol, quote, constraints and explicit budget",
    );
  const symbol = input.symbol;
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

  const oneForTp = DecimalValue.fromString("1");
  const legacyFixedTp = DecimalValue.fromString("0.20");
  const percentageMultiplier = DecimalValue.fromString("100");
  const deviationDivisor = DecimalValue.fromString("10000");
  if (
    !oneForTp.ok ||
    !legacyFixedTp.ok ||
    !percentageMultiplier.ok ||
    !deviationDivisor.ok
  )
    return invalidPlan("internal exact-decimal policy constants are invalid");
  const takeProfitPercent =
    options.takeProfit?.mode === "percent"
      ? options.takeProfit.value
      : legacyFixedTp.value;
  const targetPrice =
    options.takeProfit?.mode === "price"
      ? options.takeProfit.value
      : options.directCommand === true
        ? (() => {
            const percentFraction = takeProfitPercent.divide(
              percentageMultiplier.value,
              132,
              RoundingMode.DOWN,
            );
            return percentFraction.ok
              ? limitPrice.multiply(oneForTp.value.add(percentFraction.value))
              : undefined;
          })()
        : (() => {
            const legacyMultiplier = DecimalValue.fromString("1.002");
            return legacyMultiplier.ok
              ? limitPrice.multiply(legacyMultiplier.value)
              : undefined;
          })();
  if (!targetPrice)
    return invalidPlan("take-profit target could not be calculated exactly");
  const takeProfitPrice = targetPrice.ceilToStep(
    constraints.value.priceTickSize,
  );
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
    .divide(
      limitPrice,
      options.directCommand === true && options.legacyDirectPolicy !== true
        ? 132
        : 24,
      RoundingMode.DOWN,
    );
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
    schemaVersion:
      recoveryAttestationHash === undefined
        ? OPERATOR_MAINNET_TEST_PLAN_SCHEMA_VERSION
        : OPERATOR_MAINNET_RECOVERY_TEST_PLAN_SCHEMA_VERSION,
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
    ...(recoveryAttestationHash === undefined
      ? {}
      : {
          recoveryAttestationHash: recoveryAttestationHash.value as PlanHash,
        }),
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

/** Canonical base-plan constructor used only by the versioned direct-command path. */
export function createOperatorMainnetDirectTradeBasePlan(
  input: unknown,
  takeProfit: {
    readonly mode: "percent" | "price";
    readonly value: DecimalValue;
    readonly legacyDirectPolicy?: boolean;
  },
): Result<OperatorMainnetTestPlan> {
  return canonicalizePlanInput(input, {
    directCommand: true,
    takeProfit,
    legacyDirectPolicy: takeProfit.legacyDirectPolicy === true,
  });
}

export function rehydrateOperatorMainnetTestPlan(
  input: unknown,
): Result<OperatorMainnetTestPlan> {
  if (!isRecord(input)) return invalidPlan();
  if (
    input.schemaVersion === OPERATOR_MAINNET_TRADE_COMMAND_PLAN_SCHEMA_VERSION
  ) {
    if (!exactRecord(input, PLAN_V3_FIELDS)) return invalidPlan();
    const receipt = rehydrateOperatorMainnetTradeCommandReceipt(
      input.tradeCommandReceipt,
    );
    const commandId = requireIdentifier(input.commandId, "commandId");
    const commandReceiptHash = requireHash(
      input.commandReceiptHash,
      "commandReceiptHash",
    );
    const commandAcceptedAt = parseUtcTimestamp(input.commandAcceptedAt);
    const commandExpiresAt = parseUtcTimestamp(input.commandExpiresAt);
    if (!receipt.ok) return invalidPlan("direct-command receipt is invalid");
    const takeProfit = operatorMainnetTradeCommandTakeProfit(receipt.value);
    const replayed = canonicalizePlanInput(
      {
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
      },
      {
        directCommand: true,
        takeProfit: { mode: takeProfit.mode, value: takeProfit.value },
        legacyDirectPolicy:
          receipt.value.schemaVersion ===
          OPERATOR_MAINNET_TRADE_COMMAND_RECEIPT_V1_SCHEMA_VERSION,
      },
    );
    const contentHash = requireHash(input.contentHash, "contentHash");
    if (
      !commandId.ok ||
      !commandReceiptHash.ok ||
      !commandAcceptedAt.ok ||
      !commandExpiresAt.ok ||
      !replayed.ok ||
      !contentHash.ok ||
      input.policyVersion !== OPERATOR_MAINNET_TRADE_COMMAND_POLICY_VERSION ||
      input.nonce !== commandId.value ||
      commandReceiptHash.value !== receipt.value.contentHash ||
      commandId.value !== receipt.value.commandId ||
      commandAcceptedAt.value !== receipt.value.acceptedAt ||
      commandExpiresAt.value !== receipt.value.expiresAt ||
      replayed.value.accountIdentityHash !==
        receipt.value.accountIdentityHash ||
      replayed.value.symbol !== receipt.value.symbol ||
      replayed.value.allocation.compare(
        receipt.value.allocation as DecimalValue,
      ) !== 0 ||
      replayed.value.grossNotionalCap.compare(
        receipt.value.grossNotionalCap as DecimalValue,
      ) !== 0 ||
      replayed.value.maxDeviationBps.compare(
        receipt.value.maxDeviationBps as DecimalValue,
      ) !== 0 ||
      timestampToEpochMs(replayed.value.preparedAt) >=
        timestampToEpochMs(commandExpiresAt.value)
    )
      return invalidPlan(
        "direct-command plan differs from its receipt or validity window",
      );

    const {
      contentHash: _legacyHash,
      schemaVersion: _legacySchemaVersion,
      policyVersion: _legacyPolicyVersion,
      ...legacyPayload
    } = replayed.value;
    void _legacyHash;
    void _legacySchemaVersion;
    void _legacyPolicyVersion;
    const payload = {
      ...legacyPayload,
      schemaVersion: OPERATOR_MAINNET_TRADE_COMMAND_PLAN_SCHEMA_VERSION,
      policyVersion: OPERATOR_MAINNET_TRADE_COMMAND_POLICY_VERSION,
      commandId: commandId.value,
      commandReceiptHash: commandReceiptHash.value,
      commandAcceptedAt: commandAcceptedAt.value,
      commandExpiresAt: commandExpiresAt.value,
      tradeCommandReceipt: receipt.value,
    };
    const expectedHash = hashCanonical(payload);
    if (!expectedHash.ok || expectedHash.value !== contentHash.value)
      return invalidPlan(
        "direct-command plan identity differs from deterministic replay",
      );
    const expected = { ...payload, contentHash: contentHash.value };
    const actualCanonical = canonicalSerialize(input);
    const expectedCanonical = canonicalSerialize(expected);
    return actualCanonical.ok &&
      expectedCanonical.ok &&
      actualCanonical.value === expectedCanonical.value
      ? ok(deepFreeze(expected) as unknown as OperatorMainnetTestPlan)
      : invalidPlan("direct-command plan differs from deterministic replay");
  }
  const planFields =
    input.schemaVersion === OPERATOR_MAINNET_TEST_PLAN_SCHEMA_VERSION
      ? PLAN_V1_FIELDS
      : input.schemaVersion ===
          OPERATOR_MAINNET_RECOVERY_TEST_PLAN_SCHEMA_VERSION
        ? PLAN_V2_FIELDS
        : undefined;
  if (!planFields || !exactRecord(input, planFields)) return invalidPlan();
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
    ...(input.schemaVersion ===
    OPERATOR_MAINNET_RECOVERY_TEST_PLAN_SCHEMA_VERSION
      ? { recoveryAttestationHash: input.recoveryAttestationHash }
      : {}),
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
      { source: "quote", causeCode: "QUOTE_SCOPE_MISMATCH" },
    );
  const evaluatedAtMs = timestampToEpochMs(at.value);
  const age = evaluatedAtMs - timestampToEpochMs(quote.value.observedAt);
  const collectionFutureByMs =
    timestampToEpochMs(quote.value.collectionCompletedAt) - evaluatedAtMs;
  if (age < 0 || age > plan.value.quoteFreshnessMs || collectionFutureByMs > 0)
    return fail(
      domainError("STALE_EVIDENCE", "fresh quote is stale or future dated", {
        source: "quote",
        ...(age < 0 ? { futureByMs: -age } : { ageMs: age }),
        limitMs: plan.value.quoteFreshnessMs,
        ...(collectionFutureByMs > 0 ? { collectionFutureByMs } : {}),
        quoteObservedAt: quote.value.observedAt,
      }),
    );
  if (
    (plan.value.schemaVersion !==
      OPERATOR_MAINNET_TRADE_COMMAND_PLAN_SCHEMA_VERSION &&
      quote.value.bid.compare(plan.value.quoteBidRange.lower) < 0) ||
    quote.value.bid.compare(plan.value.quoteBidRange.upper) > 0
  )
    return fail(
      domainError(
        "CONSTRAINT_VIOLATION",
        "fresh Bybit best bid is outside the approved quote deviation range",
        {
          source: "quote",
          quoteBid: quote.value.bid.toString(),
          approvedBidLower: plan.value.quoteBidRange.lower.toString(),
          approvedBidUpper: plan.value.quoteBidRange.upper.toString(),
          quoteObservedAt: quote.value.observedAt,
          allowedDeviationBps: plan.value.maxDeviationBps.toString(),
        },
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
  if (
    plan.value.schemaVersion !== OPERATOR_MAINNET_TEST_PLAN_SCHEMA_VERSION &&
    plan.value.schemaVersion !==
      OPERATOR_MAINNET_RECOVERY_TEST_PLAN_SCHEMA_VERSION
  )
    return invalidApproval("legacy approval cannot authorize a direct command");
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
  if (
    plan.value.schemaVersion !== OPERATOR_MAINNET_TEST_PLAN_SCHEMA_VERSION &&
    plan.value.schemaVersion !==
      OPERATOR_MAINNET_RECOVERY_TEST_PLAN_SCHEMA_VERSION
  )
    return invalidApproval("legacy approval cannot authorize a direct command");
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
