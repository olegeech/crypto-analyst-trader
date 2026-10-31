import {
  canonicalSerialize,
  hashCanonical,
  type PlanHash,
} from "../identity/canonical-serialization.js";
import {
  MARKET_EVIDENCE_SYMBOLS,
  type MarketEvidenceSymbol,
} from "../market/market-evidence-bundle.js";
import { closedRecord } from "../planning/planning-validation.js";
import { DecimalValue } from "../shared/decimal.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { domainError } from "../shared/errors.js";
import { fail, ok, type Result } from "../shared/result.js";
import {
  parseUtcTimestamp,
  timestampToEpochMs,
  type UtcTimestamp,
} from "../shared/time.js";
import { requireHash, requireIdentifier } from "../shared/validation.js";

export const OPERATOR_MAINNET_TRADE_COMMAND_RECEIPT_SCHEMA_VERSION =
  "operator-mainnet-trade-command-receipt/v1" as const;
export const OPERATOR_MAINNET_TRADE_COMMAND_CHANNEL =
  "local-owner-cli/v1" as const;
export const OPERATOR_MAINNET_APPROVAL_TTL_MS = 900_000 as const;

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

function exactRecord(
  value: unknown,
  fields: readonly string[],
): value is Record<string, unknown> {
  return (
    closedRecord(value, fields) &&
    Reflect.ownKeys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  );
}

function invalidReceipt(message = "operator trade-command receipt is invalid") {
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
