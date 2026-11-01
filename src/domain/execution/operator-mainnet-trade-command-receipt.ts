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

export const OPERATOR_MAINNET_TRADE_COMMAND_RECEIPT_V1_SCHEMA_VERSION =
  "operator-mainnet-trade-command-receipt/v1" as const;
export const OPERATOR_MAINNET_TRADE_COMMAND_RECEIPT_SCHEMA_VERSION =
  "operator-mainnet-trade-command-receipt/v2" as const;
export const OPERATOR_MAINNET_TRADE_COMMAND_CHANNEL =
  "local-owner-cli/v1" as const;
export const OPERATOR_MAINNET_APPROVAL_TTL_MS = 900_000 as const;

const PRICE_DERIVATION_POLICY = "initial-best-bid-floor-to-tick/v1" as const;
const QUANTITY_DERIVATION_POLICY =
  "budget-over-limit-price-floor-to-step/v1" as const;
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
  "takeProfitMode",
  "takeProfitValue",
  "acceptedAt",
] as const;
const LEGACY_TP_POLICY_FIELDS = [
  "grossTargetPercent",
  "tpslMode",
  "orderType",
  "triggerBy",
] as const;
const TP_POLICY_FIELDS = [
  "mode",
  "value",
  "tpslMode",
  "orderType",
  "triggerBy",
] as const;

export type OperatorMainnetTradeCommandTakeProfit =
  | {
      readonly mode: "percent";
      readonly value: DecimalValue;
      readonly tpslMode: "Partial";
      readonly orderType: "Market";
      readonly triggerBy: "LastPrice";
    }
  | {
      readonly mode: "price";
      readonly value: DecimalValue;
      readonly tpslMode: "Partial";
      readonly orderType: "Market";
      readonly triggerBy: "LastPrice";
    };

interface ReceiptBase {
  readonly commandId: string;
  readonly actorIdentityHash: PlanHash;
  readonly channel: typeof OPERATOR_MAINNET_TRADE_COMMAND_CHANNEL;
  readonly accountIdentityHash: PlanHash;
  readonly environment: "mainnet";
  readonly category: "linear";
  readonly symbol: string;
  readonly side: "Buy";
  readonly allocation: DecimalValue;
  readonly grossNotionalCap: DecimalValue;
  readonly maxDeviationBps: DecimalValue;
  readonly leverage: "1";
  readonly priceDerivationPolicy: typeof PRICE_DERIVATION_POLICY;
  readonly quantityDerivationPolicy: typeof QUANTITY_DERIVATION_POLICY;
  readonly stopLoss: "none";
  readonly acceptedAt: UtcTimestamp;
  readonly expiresAt: UtcTimestamp;
  readonly contentHash: PlanHash;
}

export interface LegacyOperatorMainnetTradeCommandReceipt extends ReceiptBase {
  readonly schemaVersion: typeof OPERATOR_MAINNET_TRADE_COMMAND_RECEIPT_V1_SCHEMA_VERSION;
  readonly symbol: MarketEvidenceSymbol;
  readonly takeProfitPolicy: {
    readonly grossTargetPercent: DecimalValue;
    readonly tpslMode: "Partial";
    readonly orderType: "Market";
    readonly triggerBy: "LastPrice";
  };
}

export interface ConfiguredOperatorMainnetTradeCommandReceipt extends ReceiptBase {
  readonly schemaVersion: typeof OPERATOR_MAINNET_TRADE_COMMAND_RECEIPT_SCHEMA_VERSION;
  readonly takeProfitPolicy: OperatorMainnetTradeCommandTakeProfit;
}

export type OperatorMainnetTradeCommandReceipt =
  | LegacyOperatorMainnetTradeCommandReceipt
  | ConfiguredOperatorMainnetTradeCommandReceipt;
export type AnyOperatorMainnetTradeCommandReceipt =
  OperatorMainnetTradeCommandReceipt;

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

function validatedBase(input: Record<string, unknown>) {
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
  const contentHash = requireHash(input.contentHash, "contentHash");
  const deviationLimit = DecimalValue.fromString("10000");
  const expectedExpiry = acceptedAt.ok
    ? (new Date(
        timestampToEpochMs(acceptedAt.value) + OPERATOR_MAINNET_APPROVAL_TTL_MS,
      ).toISOString() as UtcTimestamp)
    : undefined;
  const symbol = requireIdentifier(input.symbol, "symbol");
  if (
    !commandId.ok ||
    !actorIdentityHash.ok ||
    !accountIdentityHash.ok ||
    !acceptedAt.ok ||
    !expiresAt.ok ||
    !allocation.ok ||
    !grossNotionalCap.ok ||
    !maxDeviationBps.ok ||
    !contentHash.ok ||
    !deviationLimit.ok ||
    !symbol.ok ||
    !/^[A-Z0-9]{1,26}USDT$/u.test(symbol.value) ||
    maxDeviationBps.value.compare(deviationLimit.value) >= 0 ||
    expiresAt.value !== expectedExpiry ||
    input.channel !== OPERATOR_MAINNET_TRADE_COMMAND_CHANNEL ||
    input.environment !== "mainnet" ||
    input.category !== "linear" ||
    input.side !== "Buy" ||
    input.leverage !== "1" ||
    input.priceDerivationPolicy !== PRICE_DERIVATION_POLICY ||
    input.quantityDerivationPolicy !== QUANTITY_DERIVATION_POLICY ||
    input.stopLoss !== "none"
  )
    return undefined;
  return {
    commandId: commandId.value,
    actorIdentityHash: actorIdentityHash.value as PlanHash,
    channel: OPERATOR_MAINNET_TRADE_COMMAND_CHANNEL,
    accountIdentityHash: accountIdentityHash.value as PlanHash,
    environment: "mainnet" as const,
    category: "linear" as const,
    symbol: symbol.value,
    side: "Buy" as const,
    allocation: allocation.value,
    grossNotionalCap: grossNotionalCap.value,
    maxDeviationBps: maxDeviationBps.value,
    leverage: "1" as const,
    priceDerivationPolicy: PRICE_DERIVATION_POLICY,
    quantityDerivationPolicy: QUANTITY_DERIVATION_POLICY,
    stopLoss: "none" as const,
    acceptedAt: acceptedAt.value,
    expiresAt: expiresAt.value,
    contentHash: contentHash.value as PlanHash,
  };
}

function normalizeReceipt(
  input: unknown,
): Result<OperatorMainnetTradeCommandReceipt> {
  if (
    !exactRecord(input, RECEIPT_FIELDS) ||
    typeof input.takeProfitPolicy !== "object" ||
    input.takeProfitPolicy === null ||
    Array.isArray(input.takeProfitPolicy)
  )
    return invalidReceipt();
  const base = validatedBase(input);
  if (!base)
    return invalidReceipt("receipt scope or fixed trade policy is invalid");
  const { contentHash: _storedContentHash, ...basePayload } = base;
  void _storedContentHash;
  const policy = input.takeProfitPolicy as Record<string, unknown>;
  let payload: Record<string, unknown>;
  if (
    input.schemaVersion ===
    OPERATOR_MAINNET_TRADE_COMMAND_RECEIPT_V1_SCHEMA_VERSION
  ) {
    if (!exactRecord(policy, LEGACY_TP_POLICY_FIELDS)) return invalidReceipt();
    const target = positiveDecimal(
      policy.grossTargetPercent,
      "takeProfitPolicy.grossTargetPercent",
    );
    if (
      !target.ok ||
      target.value.toString() !== "0.2" ||
      !MARKET_EVIDENCE_SYMBOLS.includes(base.symbol as MarketEvidenceSymbol) ||
      policy.tpslMode !== "Partial" ||
      policy.orderType !== "Market" ||
      policy.triggerBy !== "LastPrice"
    )
      return invalidReceipt(
        "legacy receipt policy differs from the fixed v1 trade policy",
      );
    payload = {
      schemaVersion: OPERATOR_MAINNET_TRADE_COMMAND_RECEIPT_V1_SCHEMA_VERSION,
      ...basePayload,
      symbol: base.symbol as MarketEvidenceSymbol,
      takeProfitPolicy: {
        grossTargetPercent: target.value,
        tpslMode: "Partial",
        orderType: "Market",
        triggerBy: "LastPrice",
      },
    };
  } else if (
    input.schemaVersion ===
    OPERATOR_MAINNET_TRADE_COMMAND_RECEIPT_SCHEMA_VERSION
  ) {
    if (!exactRecord(policy, TP_POLICY_FIELDS)) return invalidReceipt();
    const target = positiveDecimal(policy.value, "takeProfitPolicy.value");
    if (
      !target.ok ||
      (policy.mode !== "percent" && policy.mode !== "price") ||
      policy.tpslMode !== "Partial" ||
      policy.orderType !== "Market" ||
      policy.triggerBy !== "LastPrice"
    )
      return invalidReceipt("take-profit instruction is invalid");
    payload = {
      schemaVersion: OPERATOR_MAINNET_TRADE_COMMAND_RECEIPT_SCHEMA_VERSION,
      ...basePayload,
      takeProfitPolicy: {
        mode: policy.mode,
        value: target.value,
        tpslMode: "Partial",
        orderType: "Market",
        triggerBy: "LastPrice",
      },
    };
  } else {
    return invalidReceipt("receipt schema is unsupported");
  }
  const expectedHash = hashCanonical(payload);
  if (!expectedHash.ok || expectedHash.value !== base.contentHash)
    return invalidReceipt("receipt identity differs from its bound fields");
  const normalized = { ...payload, contentHash: base.contentHash };
  const actualCanonical = canonicalSerialize(input);
  const expectedCanonical = canonicalSerialize(normalized);
  return actualCanonical.ok &&
    expectedCanonical.ok &&
    actualCanonical.value === expectedCanonical.value
    ? ok(deepFreeze(normalized) as AnyOperatorMainnetTradeCommandReceipt)
    : invalidReceipt("receipt differs from deterministic replay");
}

function canonicalizeReceipt(
  input: unknown,
): Result<ConfiguredOperatorMainnetTradeCommandReceipt> {
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
  const takeProfitValue = positiveDecimal(
    input.takeProfitValue,
    "takeProfitValue",
  );
  const deviationLimit = DecimalValue.fromString("10000");
  const symbol = requireIdentifier(input.symbol, "symbol");
  if (
    !commandId.ok ||
    !actorIdentityHash.ok ||
    !accountIdentityHash.ok ||
    !acceptedAt.ok ||
    !allocation.ok ||
    !grossNotionalCap.ok ||
    !maxDeviationBps.ok ||
    !takeProfitValue.ok ||
    !deviationLimit.ok ||
    !symbol.ok ||
    !/^[A-Z0-9]{1,26}USDT$/u.test(symbol.value) ||
    maxDeviationBps.value.compare(deviationLimit.value) >= 0 ||
    (input.takeProfitMode !== "percent" && input.takeProfitMode !== "price")
  )
    return invalidReceipt(
      "receipt requires valid command identity, bounds and take-profit input",
    );
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
    symbol: symbol.value,
    side: "Buy" as const,
    allocation: allocation.value,
    grossNotionalCap: grossNotionalCap.value,
    maxDeviationBps: maxDeviationBps.value,
    leverage: "1" as const,
    priceDerivationPolicy: PRICE_DERIVATION_POLICY,
    quantityDerivationPolicy: QUANTITY_DERIVATION_POLICY,
    takeProfitPolicy: {
      mode: input.takeProfitMode,
      value: takeProfitValue.value,
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
    ? ok(
        deepFreeze({
          ...payload,
          contentHash: contentHash.value,
        }) as ConfiguredOperatorMainnetTradeCommandReceipt,
      )
    : contentHash;
}

export function createOperatorMainnetTradeCommandReceipt(
  input: unknown,
): Result<ConfiguredOperatorMainnetTradeCommandReceipt> {
  return canonicalizeReceipt(input);
}

export function rehydrateOperatorMainnetTradeCommandReceipt(
  input: unknown,
): Result<OperatorMainnetTradeCommandReceipt> {
  return normalizeReceipt(input);
}

export function operatorMainnetTradeCommandTakeProfit(
  receipt: AnyOperatorMainnetTradeCommandReceipt,
): OperatorMainnetTradeCommandTakeProfit {
  return receipt.schemaVersion ===
    OPERATOR_MAINNET_TRADE_COMMAND_RECEIPT_V1_SCHEMA_VERSION
    ? {
        mode: "percent",
        value: receipt.takeProfitPolicy.grossTargetPercent,
        tpslMode: receipt.takeProfitPolicy.tpslMode,
        orderType: receipt.takeProfitPolicy.orderType,
        triggerBy: receipt.takeProfitPolicy.triggerBy,
      }
    : receipt.takeProfitPolicy;
}
