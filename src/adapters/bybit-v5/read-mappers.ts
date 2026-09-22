import { responseList, type BybitResponse } from "./transport.js";
import type { ExchangeOrderStatus } from "../../domain/execution/exchange-order.js";
import {
  createInstrumentConstraints,
  type InstrumentConstraints,
} from "../../domain/market/instrument-constraints.js";
import { DecimalValue } from "../../domain/shared/decimal.js";
import {
  timestampFromEpochMs,
  type UtcTimestamp,
} from "../../domain/shared/time.js";

type JsonObject = Record<string, unknown>;

export type ReadMappingFailureKind = "invalid-response" | "precondition";

export class BybitReadMappingError extends Error {
  readonly kind: ReadMappingFailureKind;

  constructor(kind: ReadMappingFailureKind, message: string) {
    super(message);
    this.name = "BybitReadMappingError";
    this.kind = kind;
  }
}

export interface BybitInstrumentInfo {
  readonly symbol: string;
  readonly status: "Trading";
  readonly contractType: "LinearPerpetual";
  readonly quoteCoin: "USDT";
  readonly settleCoin: "USDT";
  readonly constraints: InstrumentConstraints;
}

export interface BybitTicker {
  readonly symbol: string;
  readonly bid: DecimalValue;
  readonly ask: DecimalValue;
  readonly last: DecimalValue;
}

export interface BybitWalletState {
  readonly accountType: "UNIFIED";
  readonly availableBalance: DecimalValue;
}

export interface BybitAccountKeyMetadata {
  readonly userId: string;
  readonly readOnly: boolean;
  readonly contractTrade: {
    readonly order: boolean;
    readonly position: boolean;
  };
  readonly wallet: {
    readonly withdraw: boolean;
    readonly transfer: boolean;
  };
  readonly ips: readonly string[];
  readonly warningCodes: readonly "API_KEY_IP_UNBOUND"[];
  readonly expiresAt?: UtcTimestamp;
}

export interface BybitPositionState {
  readonly instrument: string;
  readonly side: "long" | "short" | "flat";
  readonly quantity: DecimalValue;
  readonly positionIdx: 0;
  readonly leverage: DecimalValue;
  readonly entryPrice?: DecimalValue;
}

export interface BybitOrderRecord {
  readonly exchangeOrderId: string;
  readonly clientOrderId: string;
  readonly instrument: string;
  readonly side: "buy" | "sell";
  readonly requestedQuantity: DecimalValue;
  readonly filledQuantity: DecimalValue;
  readonly status: ExchangeOrderStatus;
  readonly positionIdx: 0;
  readonly reduceOnly: boolean;
  readonly parentOrderLinkId?: string;
  readonly price?: DecimalValue;
  readonly averagePrice?: DecimalValue;
}

export interface BybitExecutionRecord {
  readonly executionId: string;
  readonly exchangeOrderId: string;
  readonly clientOrderId: string;
  readonly instrument: string;
  readonly side: "buy" | "sell";
  readonly quantity: DecimalValue;
  readonly price: DecimalValue;
  readonly executedAt: UtcTimestamp;
  readonly fee?: DecimalValue;
  readonly feeCurrency?: string;
}

function invalid(message: string): never {
  throw new BybitReadMappingError("invalid-response", message);
}

function precondition(message: string): never {
  throw new BybitReadMappingError("precondition", message);
}

function object(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(`Bybit ${label} response contains an invalid object.`);
  }
  return value as JsonObject;
}

export function responseRecords(
  response: BybitResponse,
  label: string,
): readonly JsonObject[] {
  const list = responseList(response);
  if (list === undefined) {
    invalid(`Bybit ${label} response did not contain a validated list.`);
  }
  return list;
}

function text(
  record: JsonObject,
  field: string,
  label: string,
  allowEmpty = false,
): string {
  const value = record[field];
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    /[\u0000-\u001f\u007f\r\n]/u.test(value)
  ) {
    invalid(`Bybit ${label} response has an invalid ${field}.`);
  }
  return value;
}

function optionalText(
  record: JsonObject,
  field: string,
  label: string,
): string | undefined {
  if (
    !(field in record) ||
    record[field] === undefined ||
    record[field] === ""
  ) {
    return undefined;
  }
  return text(record, field, label);
}

function stringList(
  record: JsonObject,
  field: string,
  label: string,
): readonly string[] {
  const value = record[field];
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    invalid(`Bybit ${label} response has an invalid ${field}.`);
  }
  return value.map((item) => {
    if (
      typeof item !== "string" ||
      item.length === 0 ||
      /[\u0000-\u001f\u007f\r\n]/u.test(item)
    ) {
      invalid(`Bybit ${label} response has an invalid ${field} entry.`);
    }
    return item;
  });
}

function readOnlyFlag(record: JsonObject, label: string): boolean {
  const value = record.readOnly;
  if (value === 0 || value === "0") return false;
  if (value === 1 || value === "1") return true;
  invalid(`Bybit ${label} response has an invalid readOnly flag.`);
}

function optionalExpiry(
  record: JsonObject,
  label: string,
): UtcTimestamp | undefined {
  const raw = [
    record.expiresAt,
    record.expiredAt,
    record.expireAt,
    record.expireTime,
  ].find((value) => value !== undefined && value !== "");
  if (raw === undefined || raw === 0 || raw === "0") return undefined;
  if (typeof raw === "string" && !/^\d+$/u.test(raw)) {
    const parsed = timestampFromEpochMs(Date.parse(raw));
    if (!parsed.ok) invalid(`Bybit ${label} response has an invalid expiry.`);
    return parsed.value;
  }
  const numberValue =
    typeof raw === "number"
      ? raw
      : typeof raw === "string"
        ? Number(raw)
        : undefined;
  if (
    numberValue === undefined ||
    !Number.isSafeInteger(numberValue) ||
    numberValue <= 0
  ) {
    invalid(`Bybit ${label} response has an invalid expiry.`);
  }
  const epochMs =
    numberValue < 1_000_000_000_000 ? numberValue * 1_000 : numberValue;
  const parsed = timestampFromEpochMs(epochMs);
  if (!parsed.ok) invalid(`Bybit ${label} response has an invalid expiry.`);
  return parsed.value;
}

function decimal(
  value: unknown,
  label: string,
  field: string,
  positive: boolean,
): DecimalValue {
  if (typeof value !== "string") {
    invalid(`Bybit ${label} response has an invalid ${field}.`);
  }
  const parsed = DecimalValue.fromString(value);
  if (
    !parsed.ok ||
    (positive ? !parsed.value.isPositive() : parsed.value.isNegative())
  ) {
    invalid(`Bybit ${label} response has an invalid ${field}.`);
  }
  return parsed.value;
}

function positiveDecimal(
  record: JsonObject,
  field: string,
  label: string,
): DecimalValue {
  return decimal(record[field], label, field, true);
}

function nonNegativeDecimal(
  record: JsonObject,
  field: string,
  label: string,
): DecimalValue {
  return decimal(record[field], label, field, false);
}

function optionalPositiveDecimal(
  record: JsonObject,
  field: string,
  label: string,
): DecimalValue | undefined {
  if (
    !(field in record) ||
    record[field] === undefined ||
    record[field] === ""
  ) {
    return undefined;
  }
  const value = record[field];
  if (typeof value !== "string") {
    invalid(`Bybit ${label} response has an invalid ${field}.`);
  }
  const parsed = DecimalValue.fromString(value);
  if (!parsed.ok || parsed.value.isNegative()) {
    invalid(`Bybit ${label} response has an invalid ${field}.`);
  }
  return parsed.value.isZero() ? undefined : parsed.value;
}

function positionIndex(record: JsonObject, label: string): 0 {
  const value = record.positionIdx;
  const parsed =
    typeof value === "number" && Number.isSafeInteger(value)
      ? value
      : typeof value === "string" && /^\d+$/u.test(value)
        ? Number(value)
        : undefined;
  if (parsed !== 0) {
    precondition(
      `Bybit ${label} response is not in one-way position mode for the selected symbol.`,
    );
  }
  return 0;
}

function booleanField(
  record: JsonObject,
  field: string,
  label: string,
): boolean {
  const value = record[field];
  if (typeof value !== "boolean") {
    invalid(`Bybit ${label} response has an invalid ${field}.`);
  }
  return value;
}

function matchingRecord(
  response: BybitResponse,
  symbol: string,
  label: string,
): JsonObject {
  const records = responseRecords(response, label);
  const matches = records.filter((record) => record.symbol === symbol);
  if (matches.length !== 1) {
    invalid(
      `Bybit ${label} response did not return exactly one selected-symbol record.`,
    );
  }
  return matches[0] as JsonObject;
}

function parseMinNotional(
  lotSizeFilter: JsonObject,
  label: string,
): DecimalValue {
  const values = [lotSizeFilter.minNotionalValue, lotSizeFilter.minOrderAmt]
    .filter((value): value is string => typeof value === "string")
    .map((value) => decimal(value, label, "minimum notional", true));
  const first = values[0];
  if (
    first === undefined ||
    values.some((value) => value.compare(first) !== 0)
  ) {
    invalid(`Bybit ${label} response has an ambiguous minimum notional.`);
  }
  return first;
}

export function mapAccountKeyMetadata(
  response: BybitResponse,
  expectedAccountId: string,
): BybitAccountKeyMetadata {
  const item = object(response.result, "user/query-api");
  const userId = text(item, "userID", "user/query-api");
  if (userId !== expectedAccountId) {
    precondition(
      "Bybit Demo authenticated userID does not match the configured account identity.",
    );
  }
  const readOnly = readOnlyFlag(item, "user/query-api");
  if (readOnly) {
    precondition("Bybit Demo API key is read-only; no write is allowed.");
  }
  const permissions = object(item.permissions, "user/query-api");
  const contractTrade = stringList(
    permissions,
    "ContractTrade",
    "user/query-api permissions",
  );
  const wallet = stringList(
    permissions,
    "Wallet",
    "user/query-api permissions",
  );
  const hasOrder = contractTrade.includes("Order");
  const hasPosition = contractTrade.includes("Position");
  if (!hasOrder || !hasPosition) {
    precondition(
      "Bybit Demo API key lacks ContractTrade Order and Position permissions.",
    );
  }
  const hasWithdraw = wallet.includes("Withdraw");
  const hasTransfer = wallet.some((permission) =>
    ["AccountTransfer", "SubMemberTransfer", "SubMemberTransferList"].includes(
      permission,
    ),
  );
  if (hasWithdraw || hasTransfer) {
    precondition(
      "Bybit Demo API key has a prohibited withdrawal or wallet-transfer permission.",
    );
  }
  const ips = stringList(item, "ips", "user/query-api");
  const expiresAt = optionalExpiry(item, "user/query-api");
  return Object.freeze({
    userId,
    readOnly: false,
    contractTrade: Object.freeze({ order: hasOrder, position: hasPosition }),
    wallet: Object.freeze({ withdraw: hasWithdraw, transfer: hasTransfer }),
    ips: Object.freeze([...ips]),
    warningCodes: Object.freeze(
      ips.length === 0 ? (["API_KEY_IP_UNBOUND"] as const) : [],
    ),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  });
}

export function mapInstrumentInfo(
  response: BybitResponse,
  symbol: string,
): BybitInstrumentInfo {
  const item = matchingRecord(response, symbol, "instruments-info");
  const status = text(item, "status", "instruments-info");
  const contractType = text(item, "contractType", "instruments-info");
  const quoteCoin = text(item, "quoteCoin", "instruments-info");
  const settleCoin = text(item, "settleCoin", "instruments-info");
  if (status !== "Trading") {
    precondition(
      `Selected Bybit instrument is ${status}, not Trading; no write is allowed.`,
    );
  }
  if (
    contractType !== "LinearPerpetual" ||
    quoteCoin !== "USDT" ||
    settleCoin !== "USDT"
  ) {
    precondition(
      "Selected Bybit instrument is not a linear USDT-settled perpetual.",
    );
  }
  const priceFilter = object(item.priceFilter, "instruments-info");
  const lotSizeFilter = object(item.lotSizeFilter, "instruments-info");
  const constraintsResult = createInstrumentConstraints({
    instrument: symbol,
    version: `bybit-v5:${symbol}:instrument`,
    priceTickSize: priceFilter.tickSize,
    quantityStep: lotSizeFilter.qtyStep,
    minQuantity: lotSizeFilter.minOrderQty,
    minNotional: parseMinNotional(lotSizeFilter, "instruments-info").toString(),
  });
  if (!constraintsResult.ok) {
    invalid("Bybit instrument constraints are invalid.");
  }
  return {
    symbol,
    status: "Trading",
    contractType: "LinearPerpetual",
    quoteCoin: "USDT",
    settleCoin: "USDT",
    constraints: constraintsResult.value,
  };
}

export function mapTicker(
  response: BybitResponse,
  symbol: string,
): BybitTicker {
  const item = matchingRecord(response, symbol, "tickers");
  const bid = positiveDecimal(item, "bid1Price", "tickers");
  const ask = positiveDecimal(item, "ask1Price", "tickers");
  const last = positiveDecimal(item, "lastPrice", "tickers");
  if (bid.compare(ask) > 0) {
    invalid("Bybit ticker bid is greater than ask.");
  }
  return { symbol, bid, ask, last };
}

export function mapWalletBalance(response: BybitResponse): BybitWalletState {
  const records = responseRecords(response, "wallet-balance");
  const matches = records.filter((record) => record.accountType === "UNIFIED");
  if (matches.length !== 1) {
    invalid(
      "Bybit wallet-balance response did not return one unified account.",
    );
  }
  const item = matches[0] as JsonObject;
  const availableBalance =
    item.totalAvailableBalance !== undefined
      ? nonNegativeDecimal(item, "totalAvailableBalance", "wallet-balance")
      : nonNegativeDecimal(item, "availableToWithdraw", "wallet-balance");
  return { accountType: "UNIFIED", availableBalance };
}

export function mapPosition(
  response: BybitResponse,
  symbol: string,
): BybitPositionState {
  const records = responseRecords(response, "position/list");
  if (records.length !== 1) {
    precondition(
      "Bybit position/list response did not return exactly one one-way selected-symbol record.",
    );
  }
  let selected: BybitPositionState | undefined;
  let flatLeverage: DecimalValue | undefined;
  for (const record of records) {
    if (record.symbol !== symbol) {
      invalid(
        "Bybit position/list response ignored the selected-symbol filter.",
      );
    }
    positionIndex(record, "position/list");
    const quantity = nonNegativeDecimal(record, "size", "position/list");
    const leverage = positiveDecimal(record, "leverage", "position/list");
    const side = record.side;
    if (side !== "" && side !== "None" && side !== "Buy" && side !== "Sell") {
      invalid("Bybit position/list response has an invalid side.");
    }
    if (quantity.isZero()) {
      if (side === "Buy" || side === "Sell") {
        invalid("Bybit position/list response contradicts a flat position.");
      }
      flatLeverage = leverage;
      continue;
    }
    const mappedSide =
      side === "Buy" ? "long" : side === "Sell" ? "short" : undefined;
    if (mappedSide === undefined) {
      invalid("Bybit position/list response has size without a position side.");
    }
    if (selected !== undefined) {
      precondition(
        "Bybit returned multiple non-flat positions for one-way mode.",
      );
    }
    const entryPrice = optionalPositiveDecimal(
      record,
      "avgPrice",
      "position/list",
    );
    selected = {
      instrument: symbol,
      side: mappedSide,
      quantity,
      positionIdx: 0,
      leverage,
      ...(entryPrice === undefined ? {} : { entryPrice }),
    };
  }
  return (
    selected ?? {
      instrument: symbol,
      side: "flat",
      quantity: decimal("0", "position/list", "size", false),
      positionIdx: 0,
      leverage: flatLeverage!,
    }
  );
}

function orderStatus(value: string, label: string): ExchangeOrderStatus {
  switch (value) {
    case "New":
      return "open";
    case "PartiallyFilled":
      return "partially-filled";
    case "Filled":
      return "filled";
    case "Cancelled":
    case "PartiallyFilledCanceled":
    case "Deactivated":
      return "cancelled";
    case "Rejected":
      return "rejected";
    default:
      invalid(`Bybit ${label} response returned an unknown order status.`);
  }
}

export function mapOrderRecords(
  response: BybitResponse,
  symbol: string,
  label = "order/realtime",
): readonly BybitOrderRecord[] {
  return responseRecords(response, label).map((record) => {
    if (record.symbol !== symbol) {
      invalid(`Bybit ${label} response ignored the selected-symbol filter.`);
    }
    const exchangeOrderId = text(record, "orderId", label);
    const clientOrderId = text(record, "orderLinkId", label);
    const positionIdx = positionIndex(record, label);
    const requestedQuantity = positiveDecimal(record, "qty", label);
    const filledQuantity = nonNegativeDecimal(record, "cumExecQty", label);
    if (filledQuantity.compare(requestedQuantity) > 0) {
      invalid(
        `Bybit ${label} response has more execution than requested quantity.`,
      );
    }
    const side = text(record, "side", label);
    if (side !== "Buy" && side !== "Sell") {
      invalid(`Bybit ${label} response has an invalid order side.`);
    }
    const reduceOnly = booleanField(record, "reduceOnly", label);
    const parentOrderLinkId = optionalText(record, "parentOrderLinkId", label);
    const status = orderStatus(text(record, "orderStatus", label), label);
    const price = optionalPositiveDecimal(record, "price", label);
    const averagePrice = optionalPositiveDecimal(record, "avgPrice", label);
    return {
      exchangeOrderId,
      clientOrderId,
      instrument: symbol,
      side: side === "Buy" ? "buy" : "sell",
      requestedQuantity,
      filledQuantity,
      status,
      positionIdx,
      reduceOnly,
      ...(parentOrderLinkId === undefined ? {} : { parentOrderLinkId }),
      ...(price === undefined ? {} : { price }),
      ...(averagePrice === undefined ? {} : { averagePrice }),
    };
  });
}

function epochMilliseconds(
  record: JsonObject,
  field: string,
  label: string,
): UtcTimestamp {
  const value = record[field];
  const epoch =
    typeof value === "number" && Number.isSafeInteger(value)
      ? value
      : typeof value === "string" && /^\d+$/u.test(value)
        ? Number(value)
        : undefined;
  if (epoch === undefined) {
    invalid(`Bybit ${label} response has an invalid ${field}.`);
  }
  const timestamp = timestampFromEpochMs(epoch);
  if (!timestamp.ok) {
    invalid(`Bybit ${label} response has an invalid ${field}.`);
  }
  return timestamp.value;
}

export function mapExecutionRecords(
  response: BybitResponse,
  symbol: string,
  label = "execution/list",
): readonly BybitExecutionRecord[] {
  return responseRecords(response, label).map((record) => {
    if (record.symbol !== symbol) {
      invalid(`Bybit ${label} response ignored the selected-symbol filter.`);
    }
    const executionId = text(record, "execId", label);
    const exchangeOrderId = text(record, "orderId", label);
    const clientOrderId = text(record, "orderLinkId", label);
    const side = text(record, "side", label);
    if (side !== "Buy" && side !== "Sell") {
      invalid(`Bybit ${label} response has an invalid execution side.`);
    }
    const quantity = positiveDecimal(record, "execQty", label);
    const price = positiveDecimal(record, "execPrice", label);
    const executedAt = epochMilliseconds(record, "execTime", label);
    const fee = optionalPositiveDecimal(record, "execFee", label);
    const feeCurrency = optionalText(record, "feeCurrency", label);
    return {
      executionId,
      exchangeOrderId,
      clientOrderId,
      instrument: symbol,
      side: side === "Buy" ? "buy" : "sell",
      quantity,
      price,
      executedAt,
      ...(fee === undefined ? {} : { fee }),
      ...(feeCurrency === undefined ? {} : { feeCurrency }),
    };
  });
}

export function nextPageCursor(
  response: BybitResponse,
  label: string,
): string | undefined {
  const cursor = response.result.nextPageCursor;
  if (cursor === undefined || cursor === "") return undefined;
  if (
    typeof cursor !== "string" ||
    cursor.length > 512 ||
    /[\u0000-\u001f\u007f\r\n]/u.test(cursor)
  ) {
    invalid(`Bybit ${label} response returned an invalid pagination cursor.`);
  }
  return cursor;
}
