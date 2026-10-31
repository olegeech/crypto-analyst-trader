import {
  canonicalSerialize,
  hashCanonical,
  type PlanHash,
} from "../identity/canonical-serialization.js";
import {
  MARKET_EVIDENCE_SYMBOLS,
  type MarketEvidenceSymbol,
} from "../market/market-evidence-bundle.js";
import { DecimalValue } from "../shared/decimal.js";
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
import {
  createOperatorMainnetTestPlan,
  deriveOperatorMainnetTestSourceId,
  OPERATOR_MAINNET_APPROVAL_TTL_MS,
  OPERATOR_MAINNET_TRADE_COMMAND_PLAN_SCHEMA_VERSION,
  OPERATOR_MAINNET_TRADE_COMMAND_POLICY_VERSION,
  rehydrateOperatorMainnetTestPlan,
  type OperatorMainnetQuote,
  type OperatorMainnetTestPlan,
} from "./operator-mainnet-test-plan.js";

export const OPERATOR_MAINNET_TRADE_COMMAND_RECEIPT_SCHEMA_VERSION =
  "operator-mainnet-trade-command-receipt/v1" as const;
export const OPERATOR_MAINNET_TRADE_COMMAND_BINDING_SCHEMA_VERSION =
  "operator-mainnet-trade-command-binding/v1" as const;
export const OPERATOR_MAINNET_TRADE_COMMAND_CHANNEL =
  "local-owner-cli/v1" as const;

const PRICE_DERIVATION_POLICY = "initial-best-bid-floor-to-tick/v1" as const;
const QUANTITY_DERIVATION_POLICY =
  "budget-over-limit-price-floor-to-step/v1" as const;
const FIXED_TP_PERCENT = "0.20";
const RECEIPT_FIELDS = [
  "schemaVersion",
  "commandId",
  "actorIdentityHash",
  "channel",
  "accountIdentityHash",
  "environment",
  "category",
  "symbol",
  "side",
  "allocation",
  "grossNotionalCap",
  "maxDeviationBps",
  "leverage",
  "priceDerivationPolicy",
  "quantityDerivationPolicy",
  "takeProfitPolicy",
  "stopLoss",
  "acceptedAt",
  "expiresAt",
  "contentHash",
] as const;
const RECEIPT_INPUT_FIELDS = [
  "commandId",
  "actorIdentityHash",
  "accountIdentityHash",
  "symbol",
  "allocation",
  "grossNotionalCap",
  "maxDeviationBps",
  "acceptedAt",
] as const;
const TP_POLICY_FIELDS = [
  "grossTargetPercent",
  "tpslMode",
  "orderType",
  "triggerBy",
] as const;
const PLAN_INPUT_FIELDS = [
  "receipt",
  "quote",
  "warningCodes",
  "constraints",
  "preparedAt",
] as const;
const BINDING_FIELDS = [
  "schemaVersion",
  "commandId",
  "receiptHash",
  "planHash",
  "planArtifactHash",
  "sourceId",
  "clientOrderId",
  "createPayloadHash",
  "acceptedAt",
  "expiresAt",
  "boundAt",
  "executionAuthority",
  "replayInputs",
  "contentHash",
] as const;

export interface OperatorMainnetTradeCommandReceipt {
  readonly schemaVersion: typeof OPERATOR_MAINNET_TRADE_COMMAND_RECEIPT_SCHEMA_VERSION;
  readonly commandId: string;
  readonly actorIdentityHash: PlanHash;
  readonly channel: typeof OPERATOR_MAINNET_TRADE_COMMAND_CHANNEL;
  readonly accountIdentityHash: PlanHash;
  readonly environment: "mainnet";
  readonly category: "linear";
  readonly symbol: MarketEvidenceSymbol;
  readonly side: "Buy";
  readonly allocation: DecimalValue;
  readonly grossNotionalCap: DecimalValue;
  readonly maxDeviationBps: DecimalValue;
  readonly leverage: "1";
  readonly priceDerivationPolicy: typeof PRICE_DERIVATION_POLICY;
  readonly quantityDerivationPolicy: typeof QUANTITY_DERIVATION_POLICY;
  readonly takeProfitPolicy: {
    readonly grossTargetPercent: DecimalValue;
    readonly tpslMode: "Partial";
    readonly orderType: "Market";
    readonly triggerBy: "LastPrice";
  };
  readonly stopLoss: "none";
  readonly acceptedAt: UtcTimestamp;
  readonly expiresAt: UtcTimestamp;
  readonly contentHash: PlanHash;
}

export interface OperatorMainnetTradeCommandPlan extends Omit<
  OperatorMainnetTestPlan,
  "tradeCommandReceipt"
> {
  readonly schemaVersion: typeof OPERATOR_MAINNET_TRADE_COMMAND_PLAN_SCHEMA_VERSION;
  readonly policyVersion: typeof OPERATOR_MAINNET_TRADE_COMMAND_POLICY_VERSION;
  readonly commandId: string;
  readonly commandReceiptHash: PlanHash;
  readonly commandAcceptedAt: UtcTimestamp;
  readonly commandExpiresAt: UtcTimestamp;
  readonly tradeCommandReceipt: OperatorMainnetTradeCommandReceipt;
}

export interface OperatorMainnetTradeCommandBinding {
  readonly schemaVersion: typeof OPERATOR_MAINNET_TRADE_COMMAND_BINDING_SCHEMA_VERSION;
  readonly commandId: string;
  readonly receiptHash: PlanHash;
  readonly planHash: PlanHash;
  readonly planArtifactHash: PlanHash;
  readonly sourceId: string;
  readonly clientOrderId: string;
  readonly createPayloadHash: PlanHash;
  readonly acceptedAt: UtcTimestamp;
  readonly expiresAt: UtcTimestamp;
  readonly boundAt: UtcTimestamp;
  /** Evidence only. This value is never a transport capability. */
  readonly executionAuthority: "none";
  readonly replayInputs: {
    readonly receipt: OperatorMainnetTradeCommandReceipt;
    readonly plan: OperatorMainnetTradeCommandPlan;
  };
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

function invalidReceipt(message = "operator trade-command receipt is invalid") {
  return fail(domainError("INVALID_VALUE", message));
}

function invalidBinding(message = "operator trade-command binding is invalid") {
  return fail(domainError("INVALID_VALUE", message));
}

function positiveDecimal(value: unknown, field: string): Result<DecimalValue> {
  const parsed =
    value instanceof DecimalValue
      ? ok(value)
      : typeof value === "string"
        ? DecimalValue.fromString(value)
        : fail(domainError("INVALID_DECIMAL", `${field} must be a decimal`));
  if (!parsed.ok || !parsed.value.isPositive())
    return fail(domainError("INVALID_DECIMAL", `${field} must be positive`));
  return parsed;
}

function normalizeReceipt(
  input: unknown,
): Result<OperatorMainnetTradeCommandReceipt> {
  if (
    !exactRecord(input, RECEIPT_FIELDS) ||
    !exactRecord(input.takeProfitPolicy, TP_POLICY_FIELDS)
  )
    return invalidReceipt();
  const commandId = requireIdentifier(input.commandId, "commandId");
  const actorIdentityHash = requireHash(
    input.actorIdentityHash,
    "actorIdentityHash",
  );
  const accountIdentityHash = requireHash(
    input.accountIdentityHash,
    "accountIdentityHash",
  );
  const acceptedAt = parseUtcTimestamp(input.acceptedAt);
  const expiresAt = parseUtcTimestamp(input.expiresAt);
  const allocation = positiveDecimal(input.allocation, "allocation");
  const grossNotionalCap = positiveDecimal(
    input.grossNotionalCap,
    "grossNotionalCap",
  );
  const maxDeviationBps = positiveDecimal(
    input.maxDeviationBps,
    "maxDeviationBps",
  );
  const grossTargetPercent = positiveDecimal(
    input.takeProfitPolicy.grossTargetPercent,
    "takeProfitPolicy.grossTargetPercent",
  );
  const contentHash = requireHash(input.contentHash, "contentHash");
  const expectedExpiry = acceptedAt.ok
    ? (new Date(
        timestampToEpochMs(acceptedAt.value) + OPERATOR_MAINNET_APPROVAL_TTL_MS,
      ).toISOString() as UtcTimestamp)
    : undefined;
  const symbol = input.symbol;
  const deviationLimit = DecimalValue.fromString("10000");
  if (
    !commandId.ok ||
    !actorIdentityHash.ok ||
    !accountIdentityHash.ok ||
    !acceptedAt.ok ||
    !expiresAt.ok ||
    !allocation.ok ||
    !grossNotionalCap.ok ||
    !maxDeviationBps.ok ||
    !grossTargetPercent.ok ||
    !contentHash.ok ||
    !deviationLimit.ok ||
    grossTargetPercent.value.toString() !== "0.2" ||
    maxDeviationBps.value.compare(deviationLimit.value) >= 0 ||
    expiresAt.value !== expectedExpiry ||
    typeof symbol !== "string" ||
    !MARKET_EVIDENCE_SYMBOLS.includes(symbol as MarketEvidenceSymbol) ||
    input.schemaVersion !==
      OPERATOR_MAINNET_TRADE_COMMAND_RECEIPT_SCHEMA_VERSION ||
    input.channel !== OPERATOR_MAINNET_TRADE_COMMAND_CHANNEL ||
    input.environment !== "mainnet" ||
    input.category !== "linear" ||
    input.side !== "Buy" ||
    input.leverage !== "1" ||
    input.priceDerivationPolicy !== PRICE_DERIVATION_POLICY ||
    input.quantityDerivationPolicy !== QUANTITY_DERIVATION_POLICY ||
    input.stopLoss !== "none" ||
    input.takeProfitPolicy.tpslMode !== "Partial" ||
    input.takeProfitPolicy.orderType !== "Market" ||
    input.takeProfitPolicy.triggerBy !== "LastPrice"
  )
    return invalidReceipt("receipt scope or fixed trade policy is invalid");

  const payload = {
    schemaVersion: OPERATOR_MAINNET_TRADE_COMMAND_RECEIPT_SCHEMA_VERSION,
    commandId: commandId.value,
    actorIdentityHash: actorIdentityHash.value as PlanHash,
    channel: OPERATOR_MAINNET_TRADE_COMMAND_CHANNEL,
    accountIdentityHash: accountIdentityHash.value as PlanHash,
    environment: "mainnet" as const,
    category: "linear" as const,
    symbol: symbol as MarketEvidenceSymbol,
    side: "Buy" as const,
    allocation: allocation.value,
    grossNotionalCap: grossNotionalCap.value,
    maxDeviationBps: maxDeviationBps.value,
    leverage: "1" as const,
    priceDerivationPolicy: PRICE_DERIVATION_POLICY,
    quantityDerivationPolicy: QUANTITY_DERIVATION_POLICY,
    takeProfitPolicy: {
      grossTargetPercent: grossTargetPercent.value,
      tpslMode: "Partial" as const,
      orderType: "Market" as const,
      triggerBy: "LastPrice" as const,
    },
    stopLoss: "none" as const,
    acceptedAt: acceptedAt.value,
    expiresAt: expiresAt.value,
  };
  const expectedHash = hashCanonical(payload);
  if (!expectedHash.ok || expectedHash.value !== contentHash.value)
    return invalidReceipt("receipt identity differs from its bound fields");
  const normalized = { ...payload, contentHash: contentHash.value };
  const actualCanonical = canonicalSerialize(input);
  const expectedCanonical = canonicalSerialize(normalized);
  return actualCanonical.ok &&
    expectedCanonical.ok &&
    actualCanonical.value === expectedCanonical.value
    ? ok(deepFreeze(normalized) as OperatorMainnetTradeCommandReceipt)
    : invalidReceipt("receipt differs from deterministic replay");
}

function canonicalizeReceipt(
  input: unknown,
): Result<OperatorMainnetTradeCommandReceipt> {
  if (!exactRecord(input, RECEIPT_INPUT_FIELDS)) return invalidReceipt();
  const commandId = requireIdentifier(input.commandId, "commandId");
  const actorIdentityHash = requireHash(
    input.actorIdentityHash,
    "actorIdentityHash",
  );
  const accountIdentityHash = requireHash(
    input.accountIdentityHash,
    "accountIdentityHash",
  );
  const acceptedAt = parseUtcTimestamp(input.acceptedAt);
  const allocation = positiveDecimal(input.allocation, "allocation");
  const grossNotionalCap = positiveDecimal(
    input.grossNotionalCap,
    "grossNotionalCap",
  );
  const maxDeviationBps = positiveDecimal(
    input.maxDeviationBps,
    "maxDeviationBps",
  );
  const deviationLimit = DecimalValue.fromString("10000");
  if (
    !commandId.ok ||
    !actorIdentityHash.ok ||
    !accountIdentityHash.ok ||
    !acceptedAt.ok ||
    !allocation.ok ||
    !grossNotionalCap.ok ||
    !maxDeviationBps.ok ||
    !deviationLimit.ok ||
    maxDeviationBps.value.compare(deviationLimit.value) >= 0 ||
    typeof input.symbol !== "string" ||
    !MARKET_EVIDENCE_SYMBOLS.includes(input.symbol as MarketEvidenceSymbol)
  )
    return invalidReceipt(
      "receipt requires a valid local actor, account and trade scope",
    );
  const target = DecimalValue.fromString(FIXED_TP_PERCENT);
  if (!target.ok) return invalidReceipt("fixed take-profit policy is invalid");
  const expiresAt = new Date(
    timestampToEpochMs(acceptedAt.value) + OPERATOR_MAINNET_APPROVAL_TTL_MS,
  ).toISOString() as UtcTimestamp;
  const payload = {
    schemaVersion: OPERATOR_MAINNET_TRADE_COMMAND_RECEIPT_SCHEMA_VERSION,
    commandId: commandId.value,
    actorIdentityHash: actorIdentityHash.value as PlanHash,
    channel: OPERATOR_MAINNET_TRADE_COMMAND_CHANNEL,
    accountIdentityHash: accountIdentityHash.value as PlanHash,
    environment: "mainnet" as const,
    category: "linear" as const,
    symbol: input.symbol as MarketEvidenceSymbol,
    side: "Buy" as const,
    allocation: allocation.value,
    grossNotionalCap: grossNotionalCap.value,
    maxDeviationBps: maxDeviationBps.value,
    leverage: "1" as const,
    priceDerivationPolicy: PRICE_DERIVATION_POLICY,
    quantityDerivationPolicy: QUANTITY_DERIVATION_POLICY,
    takeProfitPolicy: {
      grossTargetPercent: target.value,
      tpslMode: "Partial" as const,
      orderType: "Market" as const,
      triggerBy: "LastPrice" as const,
    },
    stopLoss: "none" as const,
    acceptedAt: acceptedAt.value,
    expiresAt,
  };
  const contentHash = hashCanonical(payload);
  return contentHash.ok
    ? ok(deepFreeze({ ...payload, contentHash: contentHash.value }))
    : contentHash;
}

export function createOperatorMainnetTradeCommandReceipt(
  input: unknown,
): Result<OperatorMainnetTradeCommandReceipt> {
  return canonicalizeReceipt(input);
}

export function rehydrateOperatorMainnetTradeCommandReceipt(
  input: unknown,
): Result<OperatorMainnetTradeCommandReceipt> {
  return normalizeReceipt(input);
}

export function createOperatorMainnetTradeCommandPlan(
  input: unknown,
): Result<OperatorMainnetTradeCommandPlan> {
  if (!exactRecord(input, PLAN_INPUT_FIELDS))
    return fail(
      domainError("INVALID_PLAN", "direct-command plan input is invalid"),
    );
  const receipt = rehydrateOperatorMainnetTradeCommandReceipt(input.receipt);
  const preparedAt = parseUtcTimestamp(input.preparedAt);
  if (!receipt.ok || !preparedAt.ok)
    return fail(
      domainError(
        "INVALID_PLAN",
        "a valid receipt and preparation time are required",
      ),
    );
  if (
    timestampToEpochMs(preparedAt.value) <
      timestampToEpochMs(receipt.value.acceptedAt) ||
    timestampToEpochMs(preparedAt.value) >=
      timestampToEpochMs(receipt.value.expiresAt)
  )
    return fail(
      domainError("PLAN_EXPIRED", "command expired before plan derivation"),
    );
  const base = createOperatorMainnetTestPlan({
    accountIdentityHash: receipt.value.accountIdentityHash,
    symbol: receipt.value.symbol,
    nonce: receipt.value.commandId,
    allocation: receipt.value.allocation,
    grossNotionalCap: receipt.value.grossNotionalCap,
    maxDeviationBps: receipt.value.maxDeviationBps,
    quote: input.quote,
    warningCodes: input.warningCodes,
    constraints: input.constraints,
    preparedAt: preparedAt.value,
  });
  if (!base.ok) return base as Result<OperatorMainnetTradeCommandPlan>;
  const {
    contentHash: _baseHash,
    schemaVersion: _schema,
    policyVersion: _policy,
    ...basePayload
  } = base.value;
  const payload = {
    ...basePayload,
    schemaVersion: OPERATOR_MAINNET_TRADE_COMMAND_PLAN_SCHEMA_VERSION,
    policyVersion: OPERATOR_MAINNET_TRADE_COMMAND_POLICY_VERSION,
    commandId: receipt.value.commandId,
    commandReceiptHash: receipt.value.contentHash,
    commandAcceptedAt: receipt.value.acceptedAt,
    commandExpiresAt: receipt.value.expiresAt,
    tradeCommandReceipt: receipt.value,
  };
  const contentHash = hashCanonical(payload);
  if (!contentHash.ok) return contentHash;
  const plan = rehydrateOperatorMainnetTestPlan({
    ...payload,
    contentHash: contentHash.value,
  });
  return plan.ok
    ? ok(plan.value as unknown as OperatorMainnetTradeCommandPlan)
    : (plan as Result<OperatorMainnetTradeCommandPlan>);
}

export function rehydrateOperatorMainnetTradeCommandPlan(
  input: unknown,
): Result<OperatorMainnetTradeCommandPlan> {
  const plan = rehydrateOperatorMainnetTestPlan(input);
  return plan.ok &&
    plan.value.schemaVersion ===
      OPERATOR_MAINNET_TRADE_COMMAND_PLAN_SCHEMA_VERSION
    ? ok(plan.value as unknown as OperatorMainnetTradeCommandPlan)
    : fail(
        domainError(
          "INVALID_PLAN",
          "a valid v3 direct-command plan is required",
        ),
      );
}

function canonicalizeBinding(
  input: unknown,
): Result<OperatorMainnetTradeCommandBinding> {
  const inputFields = [
    "receipt",
    "plan",
    "createPayloadHash",
    "boundAt",
  ] as const;
  if (!exactRecord(input, inputFields)) return invalidBinding();
  const receipt = rehydrateOperatorMainnetTradeCommandReceipt(input.receipt);
  const plan = rehydrateOperatorMainnetTradeCommandPlan(input.plan);
  const createPayloadHash = requireHash(
    input.createPayloadHash,
    "createPayloadHash",
  );
  const boundAt = parseUtcTimestamp(input.boundAt);
  if (!receipt.ok || !plan.ok || !createPayloadHash.ok || !boundAt.ok)
    return invalidBinding(
      "binding requires a valid receipt, v3 plan, payload hash and time",
    );
  if (
    receipt.value.contentHash !== plan.value.commandReceiptHash ||
    receipt.value.commandId !== plan.value.commandId ||
    timestampToEpochMs(plan.value.preparedAt) >
      timestampToEpochMs(boundAt.value) ||
    timestampToEpochMs(boundAt.value) <
      timestampToEpochMs(receipt.value.acceptedAt) ||
    timestampToEpochMs(boundAt.value) >=
      timestampToEpochMs(receipt.value.expiresAt)
  )
    return invalidBinding(
      "binding does not match its receipt or validity window",
    );
  const planHash = plan.value.contentHash;
  const planArtifactHash = hashCanonical(plan.value);
  const sourceId = deriveOperatorMainnetTestSourceId(planHash);
  if (!planArtifactHash.ok || !sourceId.ok)
    return invalidBinding("plan identity could not be derived");
  const payload = {
    schemaVersion: OPERATOR_MAINNET_TRADE_COMMAND_BINDING_SCHEMA_VERSION,
    commandId: receipt.value.commandId,
    receiptHash: receipt.value.contentHash,
    planHash,
    planArtifactHash: planArtifactHash.value,
    sourceId: sourceId.value,
    clientOrderId: plan.value.clientOrderId,
    createPayloadHash: createPayloadHash.value as PlanHash,
    acceptedAt: receipt.value.acceptedAt,
    expiresAt: receipt.value.expiresAt,
    boundAt: boundAt.value,
    executionAuthority: "none" as const,
    replayInputs: { receipt: receipt.value, plan: plan.value },
  };
  const contentHash = hashCanonical(payload);
  return contentHash.ok
    ? ok(deepFreeze({ ...payload, contentHash: contentHash.value }))
    : contentHash;
}

export function createOperatorMainnetTradeCommandBinding(
  input: unknown,
): Result<OperatorMainnetTradeCommandBinding> {
  return canonicalizeBinding(input);
}

export function rehydrateOperatorMainnetTradeCommandBinding(
  input: unknown,
): Result<OperatorMainnetTradeCommandBinding> {
  if (
    !exactRecord(input, BINDING_FIELDS) ||
    !exactRecord(input.replayInputs, ["receipt", "plan"])
  )
    return invalidBinding();
  const replayed = canonicalizeBinding({
    receipt: input.replayInputs.receipt,
    plan: input.replayInputs.plan,
    createPayloadHash: input.createPayloadHash,
    boundAt: input.boundAt,
  });
  const contentHash = requireHash(input.contentHash, "contentHash");
  if (
    !replayed.ok ||
    !contentHash.ok ||
    replayed.value.contentHash !== contentHash.value
  )
    return invalidBinding("binding identity differs from deterministic replay");
  const actualCanonical = canonicalSerialize(input);
  const expectedCanonical = canonicalSerialize(replayed.value);
  return actualCanonical.ok &&
    expectedCanonical.ok &&
    actualCanonical.value === expectedCanonical.value
    ? replayed
    : invalidBinding("binding differs from deterministic replay");
}

/** Validate one prospective submission; artifact lookup/replay remains valid after expiry. */
export function validateOperatorMainnetTradeCommandBinding(
  receiptInput: unknown,
  bindingInput: unknown,
  nowInput: unknown,
  expectedCreatePayloadHash?: unknown,
): Result<OperatorMainnetTradeCommandBinding> {
  const receipt = rehydrateOperatorMainnetTradeCommandReceipt(receiptInput);
  const binding = rehydrateOperatorMainnetTradeCommandBinding(bindingInput);
  const now = parseUtcTimestamp(nowInput);
  const expectedPayloadHash =
    expectedCreatePayloadHash === undefined
      ? undefined
      : requireHash(expectedCreatePayloadHash, "expectedCreatePayloadHash");
  if (
    !receipt.ok ||
    !binding.ok ||
    !now.ok ||
    (expectedPayloadHash !== undefined && !expectedPayloadHash.ok)
  )
    return invalidBinding("current receipt, binding and time are required");
  if (
    receipt.value.contentHash !== binding.value.receiptHash ||
    receipt.value.commandId !== binding.value.commandId ||
    (expectedPayloadHash !== undefined &&
      expectedPayloadHash.ok &&
      expectedPayloadHash.value !== binding.value.createPayloadHash)
  )
    return invalidBinding(
      "binding does not match the current receipt or CREATE payload",
    );
  if (
    timestampToEpochMs(now.value) < timestampToEpochMs(binding.value.boundAt) ||
    timestampToEpochMs(now.value) <
      timestampToEpochMs(receipt.value.acceptedAt) ||
    timestampToEpochMs(now.value) >= timestampToEpochMs(receipt.value.expiresAt)
  )
    return fail(
      domainError(
        "PLAN_EXPIRED",
        "direct-command binding is outside its submission window",
      ),
    );
  return binding;
}
