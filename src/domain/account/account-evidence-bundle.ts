import { domainError } from "../shared/errors.js";
import { DecimalValue, isDecimalValue } from "../shared/decimal.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { fail, ok, type Result } from "../shared/result.js";
import { parseUtcTimestamp, type UtcTimestamp } from "../shared/time.js";
import {
  isRecord,
  requireHash,
  requireIdentifier,
  requireFiniteInteger,
} from "../shared/validation.js";
import {
  canonicalSerialize,
  hashCanonical,
} from "../identity/canonical-serialization.js";
import {
  ACCOUNT_EVIDENCE_POLICY_VERSION,
  accountEvidencePolicyHash,
  type AccountEvidencePartition,
} from "./account-evidence-policy.js";
import {
  parseAccountEvidenceDiagnostics,
  parseAccountEvidenceFailureCodes,
  type AccountEvidenceFailureCode,
} from "./account-evidence-diagnostics.js";
import {
  evaluateAccountEvidenceConsistency,
  type AccountEvidenceConsistency,
} from "./account-evidence-consistency.js";

export const ACCOUNT_EVIDENCE_SCHEMA_VERSION =
  "account-evidence-bundle/v1" as const;
export type AccountEvidenceEnvironment = "demo" | "testnet" | "mainnet";
export type AccountEvidenceCollectionStatus =
  "complete" | "incomplete" | "failed";
export type AccountEvidenceFact<T> =
  | { readonly state: "known"; readonly value: T }
  | {
      readonly state: "unavailable";
      readonly reason:
        | "not-returned"
        | "unsupported"
        | "invalid"
        | "permission-denied"
        | "collection-failed";
    }
  | { readonly state: "not-applicable" };
export type AccountEvidenceDecimalFact = AccountEvidenceFact<DecimalValue> & {
  readonly unit: "coin" | "USD" | "rate" | "contracts" | "price";
};

// Small closed-schema parsers keep validation uniform at every nesting level.
type Parser<T> = (value: unknown) => Result<T>;
type Parsed<P> = P extends Parser<infer T> ? T : never;
function invalid(): Result<never> {
  return fail(
    domainError("INVALID_VALUE", "account evidence payload is invalid"),
  );
}
function shape<S extends Record<string, Parser<unknown>>>(
  fields: S,
): Parser<{ readonly [K in keyof S]: Parsed<S[K]> }> {
  return (input) => {
    if (
      !isRecord(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
      Reflect.ownKeys(input).length !== Object.keys(fields).length ||
      Reflect.ownKeys(input).some(
        (key) => typeof key !== "string" || !Object.hasOwn(fields, key),
      ) ||
      Object.values(Object.getOwnPropertyDescriptors(input)).some(
        (descriptor) => !Object.hasOwn(descriptor, "value"),
      )
    )
      return invalid();
    const output: Record<string, unknown> = {};
    for (const [key, parser] of Object.entries(fields)) {
      if (!Object.hasOwn(input, key)) return invalid();
      const value = parser(input[key]);
      if (!value.ok) return invalid();
      output[key] = value.value;
    }
    return ok(output as { readonly [K in keyof S]: Parsed<S[K]> });
  };
}
const oneOf =
  <const T extends readonly (string | number | boolean)[]>(
    ...values: T
  ): Parser<T[number]> =>
  (input) =>
    values.includes(input as T[number]) ? ok(input as T[number]) : invalid();
const identifier: Parser<string> = (input) =>
  requireIdentifier(input, "identifier");
const hash: Parser<string> = (input) => requireHash(input, "hash");
const integer: Parser<number> = (input) => requireFiniteInteger(input, "count");
const boolean: Parser<boolean> = (input) =>
  typeof input === "boolean" ? ok(input) : invalid();
const timestamp: Parser<UtcTimestamp> = parseUtcTimestamp;
const nullable =
  <T>(parser: Parser<T>): Parser<T | null> =>
  (value) =>
    value === null ? ok(null) : parser(value);
function list<T>(
  parser: Parser<T>,
  key?: (value: T) => string,
  sortKey = key,
): Parser<readonly T[]> {
  return (input) => {
    if (
      !Array.isArray(input) ||
      input.length > 10_000 ||
      Object.values(Object.getOwnPropertyDescriptors(input)).some(
        (d) => !Object.hasOwn(d, "value"),
      )
    )
      return invalid();
    const output: T[] = [];
    const seen = new Map<string, string>();
    for (const item of input) {
      const value = parser(item);
      if (!value.ok) return invalid();
      if (key) {
        const identity = key(value.value),
          serialized = canonicalSerialize(value.value);
        if (!serialized.ok) return invalid();
        const previous = seen.get(identity);
        if (previous !== undefined) {
          if (previous !== serialized.value) return invalid();
          else continue;
        }
        seen.set(identity, serialized.value);
      }
      output.push(value.value);
    }
    if (sortKey)
      output.sort((a, b) => {
        const left = sortKey(a),
          right = sortKey(b);
        return left < right ? -1 : left > right ? 1 : 0;
      });
    return ok(output);
  };
}
function fact<T>(parser: Parser<T>): Parser<AccountEvidenceFact<T>> {
  return (input) => {
    if (
      !isRecord(input) ||
      Object.values(Object.getOwnPropertyDescriptors(input)).some(
        (d) => !Object.hasOwn(d, "value"),
      )
    )
      return invalid();
    if (input.state === "known")
      return shape({ state: oneOf("known"), value: parser })(input);
    if (input.state === "unavailable")
      return shape({
        state: oneOf("unavailable"),
        reason: oneOf(
          "not-returned",
          "unsupported",
          "invalid",
          "permission-denied",
          "collection-failed",
        ),
      })(input);
    return shape({ state: oneOf("not-applicable") })(input);
  };
}
function decimalFact<U extends AccountEvidenceDecimalFact["unit"]>(
  unit: U,
  nonNegative = false,
): Parser<AccountEvidenceFact<DecimalValue> & { readonly unit: U }> {
  return (input) => {
    if (
      !isRecord(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
      Object.values(Object.getOwnPropertyDescriptors(input)).some(
        (d) => !Object.hasOwn(d, "value"),
      ) ||
      input.unit !== unit
    )
      return invalid();
    // Do not spread untrusted objects or copy unknown fields into evidence.
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (
      Reflect.ownKeys(input).some(
        (key) =>
          typeof key !== "string" ||
          !["state", "unit", "value", "reason"].includes(key),
      ) ||
      Object.values(descriptors).some((d) => !Object.hasOwn(d, "value"))
    )
      return invalid();
    const withoutUnit: Record<string, unknown> = {};
    for (const key of Object.keys(descriptors))
      if (key !== "unit") withoutUnit[key] = descriptors[key]?.value;
    const result = fact<DecimalValue>((value) => {
      const parsed = isDecimalValue(value)
        ? ok(value)
        : DecimalValue.fromString(value);
      return parsed.ok && (!nonNegative || !parsed.value.isNegative())
        ? parsed
        : invalid();
    })(withoutUnit);
    return result.ok ? ok({ ...result.value, unit }) : result;
  };
}
const coin = decimalFact("coin");
const quantity = decimalFact("contracts", true);
const usd = decimalFact("USD");
const positionAmount: Parser<AccountEvidenceDecimalFact> = (input) =>
  isRecord(input) && input.unit === "coin" ? coin(input) : usd(input);
const price = decimalFact("price", true);
const rate = decimalFact("rate");
const booleanFact = fact(boolean),
  textFact = fact(identifier),
  integerFact = fact(integer),
  timeFact = fact(timestamp);
const category = oneOf("linear", "inverse", "spot", "option");
const environment = oneOf("demo", "testnet", "mainnet");

const credentialPostureSchema = shape({
  readOnly: boolean,
  permissions: shape({
    contractOrder: boolean,
    contractPosition: boolean,
    spotTrade: boolean,
    walletTransfer: boolean,
    withdraw: oneOf(false),
  }),
  ipBound: boolean,
  // Null means unavailable, never an assertion that this key cannot expire.
  expiresAt: nullable(timestamp),
  warnings: list(oneOf("API_KEY_IP_UNBOUND"), (value) => value),
});
export type AccountCredentialPosture = Parsed<typeof credentialPostureSchema>;
export function createAccountCredentialPosture(
  input: unknown,
): Result<AccountCredentialPosture> {
  const parsed = credentialPostureSchema(input);
  if (
    !parsed.ok ||
    parsed.value.warnings.length !== (parsed.value.ipBound ? 0 : 1)
  )
    return invalid();
  return ok(deepFreeze(parsed.value));
}

const bindingSchema = shape({
  exchange: oneOf("bybit"),
  environment,
  origin: oneOf(
    "https://api-demo.bybit.com",
    "https://api-testnet.bybit.com",
    "https://api.bybit.com",
  ),
  accountIdentityHash: hash,
  authenticatedAt: timestamp,
  identityVerified: oneOf(true),
});
export type AccountBinding = Parsed<typeof bindingSchema>;
export function createAccountBinding(input: unknown): Result<AccountBinding> {
  const parsed = bindingSchema(input);
  if (!parsed.ok) return invalid();
  const origins = {
    demo: "https://api-demo.bybit.com",
    testnet: "https://api-testnet.bybit.com",
    mainnet: "https://api.bybit.com",
  };
  return parsed.value.origin === origins[parsed.value.environment]
    ? ok(deepFreeze(parsed.value))
    : invalid();
}
const assetSchema = shape({
  coin: identifier,
  walletBalance: coin,
  equity: coin,
  usdValue: usd,
  usdEquity: usd,
  locked: coin,
  bonus: coin,
  borrowAmount: coin,
  spotBorrow: coin,
  accruedInterest: coin,
  totalOrderIM: usd,
  totalPositionIM: usd,
  totalPositionMM: usd,
  unrealisedPnl: coin,
  collateralEligible: booleanFact,
  collateralSwitch: booleanFact,
  restricted: booleanFact,
});
export type AccountAssetEvidence = Parsed<typeof assetSchema>;
const totalsSchema = shape({
  totalEquity: usd,
  totalWalletBalance: usd,
  totalMarginBalance: usd,
  totalPerpUPL: usd,
  totalAvailableBalance: usd,
  totalInitialMargin: usd,
  totalMaintenanceMargin: usd,
  accountIMRate: rate,
  accountMMRate: rate,
  equityBasis: oneOf("usd-equity", "unestablished"),
});
export type AccountTotalsEvidence = Parsed<typeof totalsSchema>;
const collateralSchema = shape({
  coin: identifier,
  collateralEligible: booleanFact,
  collateralSwitch: booleanFact,
  restricted: booleanFact,
  borrowable: booleanFact,
  borrowAmount: coin,
  otherBorrowAmount: coin,
  maxBorrowingAmount: coin,
  hourlyBorrowRate: rate,
});
export type AccountCollateralEvidence = Parsed<typeof collateralSchema>;
const accountSchema = shape({
  utaStatus: integerFact,
  marginMode: textFact,
  spotHedging: booleanFact,
});
export type AccountModeEvidence = Parsed<typeof accountSchema>;
const positionShape = shape({
  category: identifier,
  symbol: identifier,
  positionIdx: integer,
  side: identifier,
  size: quantity,
  avgPrice: price,
  markPrice: price,
  positionValue: positionAmount,
  unrealisedPnl: positionAmount,
  positionIM: positionAmount,
  positionMM: positionAmount,
  leverage: rate,
  riskId: integerFact,
  tradeMode: integerFact,
  isReduceOnly: booleanFact,
  seq: textFact,
  createdAt: timeFact,
  updatedAt: timeFact,
  takeProfit: price,
  stopLoss: price,
  trailingStop: price,
});
function positionSchema(input: unknown): Result<Parsed<typeof positionShape>> {
  const parsed = positionShape(input);
  if (!parsed.ok) return parsed;
  const unit = parsed.value.category === "inverse" ? "coin" : "USD";
  return [
    parsed.value.positionValue,
    parsed.value.unrealisedPnl,
    parsed.value.positionIM,
    parsed.value.positionMM,
  ].every((fact) => fact.unit === unit)
    ? parsed
    : invalid();
}
export type AccountPositionEvidence = Parsed<typeof positionSchema>;
const orderSchema = shape({
  category: identifier,
  symbol: identifier,
  orderId: identifier,
  orderLinkId: nullable(identifier),
  status: identifier,
  side: identifier,
  orderType: identifier,
  price,
  qty: quantity,
  cumExecQty: quantity,
  leavesQty: quantity,
  positionIdx: integerFact,
  reduceOnly: booleanFact,
  closeOnTrigger: booleanFact,
  triggerPrice: price,
  triggerDirection: integerFact,
  triggerBy: textFact,
  stopOrderType: textFact,
  takeProfit: price,
  stopLoss: price,
  tpslMode: textFact,
  timeInForce: textFact,
  orderFilter: textFact,
  createdAt: timeFact,
  updatedAt: timeFact,
});
export type AccountOrderEvidence = Parsed<typeof orderSchema>;
const executionExtraFeeSchema = shape({
  feeCoin: textFact,
  feeType: textFact,
  subFeeType: textFact,
  feeRate: rate,
  fee: coin,
});
const executionSchema = shape({
  category: identifier,
  symbol: identifier,
  execId: identifier,
  orderId: identifier,
  orderLinkId: nullable(identifier),
  execType: identifier,
  side: identifier,
  execTime: timestamp,
  price,
  qty: quantity,
  fee: coin,
  feeCurrency: textFact,
  feeRate: rate,
  execFeeV2: coin,
  extraFees: fact(list(executionExtraFeeSchema)),
});
export type AccountExecutionEvidence = Parsed<typeof executionSchema>;
const tierSchema = shape({
  coin: identifier,
  minQty: decimalFact("coin", true),
  maxQty: nullable(decimalFact("coin", true)),
  collateralRatio: rate,
  boundSemantics: oneOf("provider-unspecified"),
});
export type AccountCollateralTierEvidence = Parsed<typeof tierSchema>;
const partitionSchema = shape({
  endpoint: oneOf(
    "account-info",
    "wallet",
    "collateral",
    "tiers",
    "settlement-discovery",
    "option-base-discovery",
    "instrument-metadata",
    "positions",
    "mode-probe",
    "open-orders",
    "order-history",
    "executions",
  ),
  pass: oneOf("A", "B", "auxiliary"),
  category: nullable(category),
  settleCoin: nullable(identifier),
  baseCoin: nullable(identifier),
  symbol: nullable(identifier),
});
const observationSchema = shape({
  partition: partitionSchema,
  startedAt: timestamp,
  endedAt: timestamp,
  exchangeResponseTime: timestamp,
  nativeRowTimes: list(timestamp, (value) => value),
});
export type AccountEndpointObservation = Parsed<typeof observationSchema>;
const probeSchema = shape({
  symbol: identifier,
  positionIndices: list(integer, (value) => String(value)),
});
export type AccountPositionModeProbe = Parsed<typeof probeSchema>;
const positionKey = (value: AccountPositionEvidence) =>
  JSON.stringify([value.category, value.symbol, value.positionIdx]);
const orderKey = (value: AccountOrderEvidence) =>
  JSON.stringify([value.category, value.orderId]);
const passSchema = shape({
  account: accountSchema,
  totals: totalsSchema,
  assets: list(assetSchema, (value) => value.coin),
  collateral: list(collateralSchema, (value) => value.coin),
  positions: list(positionSchema, positionKey),
  orders: list(orderSchema, orderKey),
  modeProbes: list(probeSchema, (value) => value.symbol),
  observations: list(observationSchema, (value) =>
    JSON.stringify(value.partition),
  ),
});
export type AccountCriticalPass = Parsed<typeof passSchema>;
const discoverySchema = shape({
  settlementCoins: list(identifier, (value) => value),
  optionBaseCoins: list(identifier, (value) => value),
  exposureOptionBaseCoins: list(identifier, (value) => value),
  passBSettlementCoins: list(identifier, (value) => value),
  passBOptionBaseCoins: list(identifier, (value) => value),
  uncoveredScopes: boolean,
  upgradeOverlap: boolean,
  separateInverseWallet: boolean,
});
const coverageEntrySchema = shape({
  partition: partitionSchema,
  status: oneOf("traversed", "failed", "unavailable"),
  pages: integer,
  rows: integer,
  startedAt: nullable(timestamp),
  endedAt: nullable(timestamp),
  reasonCodes: parseAccountEvidenceFailureCodes,
});
export type AccountEvidenceCoverageEntry = Parsed<typeof coverageEntrySchema>;
const budgetSchema = shape({
  monotonicDurationMs: integer,
  httpAttempts: integer,
  retainedRows: integer,
  maxObservedResponseBytes: integer,
});
const referenceSchema = shape({
  kind: oneOf("account-evidence-bundle"),
  schemaVersion: oneOf(ACCOUNT_EVIDENCE_SCHEMA_VERSION),
  producer: identifier,
  sourceId: identifier,
  asOf: timestamp,
  validForMs: integer,
  contentHash: hash,
});
const payloadSchema = shape({
  schemaVersion: oneOf(ACCOUNT_EVIDENCE_SCHEMA_VERSION),
  runId: identifier,
  producer: identifier,
  accountBinding: createAccountBinding,
  credentialPosture: createAccountCredentialPosture,
  policyVersion: oneOf(ACCOUNT_EVIDENCE_POLICY_VERSION),
  policyHash: hash,
  startedAt: timestamp,
  endedAt: timestamp,
  collectionStartedAt: nullable(timestamp),
  collectionEndedAt: nullable(timestamp),
  bundleCutoff: nullable(timestamp),
  historyWindow: nullable(
    shape({
      startedAt: timestamp,
      endedAt: timestamp,
      selectionClock: oneOf("provider-native"),
    }),
  ),
  collectionStatus: oneOf("complete", "incomplete", "failed"),
  configuredM1Symbols: list(identifier, (value) => value),
  discovery: nullable(discoverySchema),
  criticalPasses: shape({ A: nullable(passSchema), B: nullable(passSchema) }),
  auxiliary: shape({
    tiers: list(tierSchema, (value) =>
      JSON.stringify([
        value.coin,
        value.minQty.state === "known"
          ? value.minQty.value.toString()
          : value.minQty.state,
      ]),
    ),
    orders: list(orderSchema, orderKey),
    executions: list(
      executionSchema,
      (value) => JSON.stringify([value.category, value.execId]),
      (value) =>
        `${value.execTime}:${JSON.stringify([value.category, value.execId])}`,
    ),
    observations: list(observationSchema, (value) =>
      JSON.stringify(value.partition),
    ),
  }),
  expectedPartitions: list(partitionSchema, (value) => JSON.stringify(value)),
  coverage: list(coverageEntrySchema, (value) =>
    JSON.stringify(value.partition),
  ),
  budget: budgetSchema,
  diagnostics: parseAccountEvidenceDiagnostics,
  evidence: list(referenceSchema, (value) => value.contentHash),
});
export type AccountEvidencePayload = Parsed<typeof payloadSchema>;
export type AccountEvidenceBundle = AccountEvidencePayload & {
  readonly consistency: AccountEvidenceConsistency;
};

/** Accepts fresh payloads and rehydrated payloads. Binding claims never perform new authentication. */
export function createAccountEvidenceBundle(
  input: unknown,
): Result<AccountEvidenceBundle> {
  if (
    !isRecord(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    return invalid();
  // Check descriptors before reading input; getters must never be invoked.
  if (
    Object.values(Object.getOwnPropertyDescriptors(input)).some(
      (d) => !Object.hasOwn(d, "value"),
    )
  )
    return invalid();
  const raw: Record<string, unknown> = {};
  for (const key of Object.getOwnPropertyNames(input))
    if (key !== "consistency") raw[key] = input[key];
  if (Reflect.ownKeys(input).some((key) => typeof key !== "string"))
    return invalid();
  const parsed = payloadSchema(raw);
  if (!parsed.ok) return parsed;
  const payload = parsed.value,
    policyHash = accountEvidencePolicyHash();
  if (
    !policyHash.ok ||
    payload.policyHash !== policyHash.value ||
    Date.parse(payload.startedAt) > Date.parse(payload.endedAt) ||
    Date.parse(payload.accountBinding.authenticatedAt) <
      Date.parse(payload.startedAt) ||
    Date.parse(payload.accountBinding.authenticatedAt) >
      Date.parse(payload.endedAt)
  )
    return invalid();
  const consistency = evaluateAccountEvidenceConsistency(payload);
  if (payload.collectionStatus === "complete" && !consistency.complete)
    return invalid();
  if (
    payload.collectionStatus !== "complete" &&
    payload.diagnostics.length === 0 &&
    consistency.reasonCodes.length === 0
  )
    return invalid();
  if (Object.hasOwn(input, "consistency")) {
    const supplied = canonicalSerialize(input.consistency),
      derived = canonicalSerialize(consistency);
    if (!supplied.ok || !derived.ok || supplied.value !== derived.value)
      return invalid();
  }
  const bundle = deepFreeze({ ...payload, consistency });
  const contentHash = accountEvidenceContentHash(bundle);
  if (!contentHash.ok) return invalid();
  if (
    bundle.evidence.some(
      (ref) =>
        ref.contentHash !== contentHash.value ||
        ref.sourceId !== bundle.runId ||
        ref.producer !== bundle.producer ||
        ref.asOf !== bundle.bundleCutoff,
    )
  )
    return invalid();
  return ok(bundle);
}
export function accountEvidenceContentHash(
  bundle: AccountEvidenceBundle,
): Result<string> {
  const { evidence: _evidence, ...payload } = bundle;
  void _evidence;
  return hashCanonical(payload);
}
export interface AccountEvidencePreAuthFailure {
  readonly kind: "pre-auth-failure";
  readonly environment: AccountEvidenceEnvironment;
  readonly runId: string;
  readonly policyVersion: typeof ACCOUNT_EVIDENCE_POLICY_VERSION;
  readonly reasonCodes: readonly AccountEvidenceFailureCode[];
  readonly startedAt: UtcTimestamp;
  readonly endedAt: UtcTimestamp;
  readonly bundle?: never;
  readonly bundleHash?: never;
  readonly accountBinding?: never;
}
export type AccountEvidenceCollectionResult =
  | AccountEvidencePreAuthFailure
  | {
      readonly kind: "account-evidence";
      readonly bundle: AccountEvidenceBundle;
    };
export function createAccountEvidenceCollectionResult(
  input: unknown,
): Result<AccountEvidenceCollectionResult> {
  if (
    !isRecord(input) ||
    Object.values(Object.getOwnPropertyDescriptors(input)).some(
      (d) => !Object.hasOwn(d, "value"),
    )
  )
    return invalid();
  if (input.kind === "account-evidence") {
    const parsed = shape({
      kind: oneOf("account-evidence"),
      bundle: createAccountEvidenceBundle,
    })(input);
    return parsed.ok ? ok(deepFreeze(parsed.value)) : parsed;
  }
  const parsed = shape({
    kind: oneOf("pre-auth-failure"),
    environment,
    runId: identifier,
    policyVersion: oneOf(ACCOUNT_EVIDENCE_POLICY_VERSION),
    reasonCodes: parseAccountEvidenceFailureCodes,
    startedAt: timestamp,
    endedAt: timestamp,
  })(input);
  if (
    !parsed.ok ||
    parsed.value.reasonCodes.length === 0 ||
    Date.parse(parsed.value.startedAt) > Date.parse(parsed.value.endedAt)
  )
    return invalid();
  return ok(deepFreeze(parsed.value));
}

// Mapper constructors share the exact same nested schemas used by bundle validation.
export const createAccountAssetEvidence = (
  input: unknown,
): Result<AccountAssetEvidence> => {
  const result = assetSchema(input);
  return result.ok ? ok(deepFreeze(result.value)) : result;
};
export const createAccountPositionEvidence = (
  input: unknown,
): Result<AccountPositionEvidence> => {
  const result = positionSchema(input);
  return result.ok ? ok(deepFreeze(result.value)) : result;
};
export const createAccountOrderEvidence = (
  input: unknown,
): Result<AccountOrderEvidence> => {
  const result = orderSchema(input);
  return result.ok ? ok(deepFreeze(result.value)) : result;
};
export const createAccountExecutionEvidence = (
  input: unknown,
): Result<AccountExecutionEvidence> => {
  const result = executionSchema(input);
  return result.ok ? ok(deepFreeze(result.value)) : result;
};
export const createAccountCriticalPass = (
  input: unknown,
): Result<AccountCriticalPass> => {
  const result = passSchema(input);
  return result.ok ? ok(deepFreeze(result.value)) : result;
};
export const createAccountCollateralTierEvidence = (
  input: unknown,
): Result<AccountCollateralTierEvidence> => {
  const result = tierSchema(input);
  return result.ok ? ok(deepFreeze(result.value)) : result;
};
export type { AccountEvidencePartition };
