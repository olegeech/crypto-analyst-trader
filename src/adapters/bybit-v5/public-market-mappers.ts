import { responseList, type BybitPublicResponse } from "./public-response.js";
import {
  MARKET_EVIDENCE_SYMBOLS,
  type FundingObservation,
  type MarketEvidenceSymbol,
  type MarketInstrumentEvidence,
  type MarketSeriesInterval,
  type MarketTickerEvidence,
  type OhlcvObservation,
  type OpenInterestInterval,
  type OpenInterestObservation,
} from "../../domain/market/market-evidence-bundle.js";
import { createInstrumentConstraints } from "../../domain/market/instrument-constraints.js";
import { marketIntervalMilliseconds } from "../../domain/market/market-evidence-windows.js";
import { DecimalValue } from "../../domain/shared/decimal.js";
import {
  timestampFromEpochMs,
  type UtcTimestamp,
} from "../../domain/shared/time.js";

type JsonObject = Record<string, unknown>;

export type PublicMarketMappingFailureKind =
  | "invalid-response"
  | "precondition"
  | "missing-data"
  | "duplicate-observation"
  | "page-budget-exhausted"
  | "row-budget-exhausted";

export class BybitPublicMarketMappingError extends Error {
  readonly kind: PublicMarketMappingFailureKind;

  constructor(kind: PublicMarketMappingFailureKind, message: string) {
    super(message);
    this.name = "BybitPublicMarketMappingError";
    this.kind = kind;
  }
}

function invalid(message: string): never {
  throw new BybitPublicMarketMappingError("invalid-response", message);
}

function precondition(message: string): never {
  throw new BybitPublicMarketMappingError("precondition", message);
}

function missing(message: string): never {
  throw new BybitPublicMarketMappingError("missing-data", message);
}

function object(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(`Bybit ${label} response contains an invalid record.`);
  }
  return value as JsonObject;
}

function text(record: JsonObject, field: string, label: string): string {
  const value = record[field];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    /[\u0000-\u001f\u007f\r\n]/u.test(value)
  ) {
    invalid(`Bybit ${label} response has an invalid ${field}.`);
  }
  return value;
}

function decimal(
  value: unknown,
  field: string,
  label: string,
  mode: "positive" | "non-negative" | "any" = "any",
): DecimalValue {
  if (typeof value !== "string") {
    invalid(`Bybit ${label} response has an invalid ${field}.`);
  }
  const parsed = DecimalValue.fromString(value);
  if (
    !parsed.ok ||
    (mode === "positive" && !parsed.value.isPositive()) ||
    (mode === "non-negative" && parsed.value.isNegative())
  ) {
    invalid(`Bybit ${label} response has an invalid ${field}.`);
  }
  return parsed.value;
}

function optionalDecimal(
  record: JsonObject,
  field: string,
  label: string,
  mode: "positive" | "non-negative" | "any" = "any",
): DecimalValue | undefined {
  if (
    !(field in record) ||
    record[field] === undefined ||
    record[field] === ""
  ) {
    return undefined;
  }
  return decimal(record[field], field, label, mode);
}

function epochMs(value: unknown, field: string, label: string): number {
  const parsed =
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? value
      : typeof value === "string" && /^\d+$/u.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    invalid(`Bybit ${label} response has an invalid ${field}.`);
  }
  return parsed;
}

function timestamp(value: unknown, field: string, label: string): UtcTimestamp {
  const parsed = timestampFromEpochMs(epochMs(value, field, label));
  if (!parsed.ok) invalid(`Bybit ${label} response has an invalid ${field}.`);
  return parsed.value;
}

function envelopeTime(
  response: BybitPublicResponse,
  label: string,
): UtcTimestamp {
  if (response.time === undefined) {
    missing(`Bybit ${label} response has no exchange envelope time.`);
  }
  return timestamp(response.time, "time", label);
}

function configuredSymbol(value: string): MarketEvidenceSymbol {
  if (!MARKET_EVIDENCE_SYMBOLS.includes(value as MarketEvidenceSymbol)) {
    precondition(
      `Bybit public response returned an unsupported symbol (${value}).`,
    );
  }
  return value as MarketEvidenceSymbol;
}

function records(
  response: BybitPublicResponse,
  label: string,
): readonly JsonObject[] {
  const list = responseList(response);
  if (list === undefined)
    invalid(`Bybit ${label} response did not contain a valid list.`);
  return list;
}

function normalizeStatus(value: string): "trading" | "non-trading" {
  return value === "Trading" ? "trading" : "non-trading";
}

function parsePositiveInteger(
  value: unknown,
  field: string,
  label: string,
): number {
  const parsed =
    typeof value === "number" && Number.isSafeInteger(value)
      ? value
      : typeof value === "string" && /^\d+$/u.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    invalid(`Bybit ${label} response has an invalid ${field}.`);
  }
  return parsed;
}

export function mapInstrumentInfo(
  response: BybitPublicResponse,
  expectedSymbol: string,
): MarketInstrumentEvidence {
  const symbol = configuredSymbol(expectedSymbol);
  const list = records(response, "instruments-info");
  const matches = list.filter((item) => item.symbol === symbol);
  if (matches.length === 0)
    missing(`Bybit did not return instrument ${symbol}.`);
  if (matches.length > 1)
    precondition(`Bybit returned duplicate instrument ${symbol}.`);
  const record = object(matches[0], "instruments-info");
  const status = normalizeStatus(text(record, "status", "instruments-info"));
  const contractType = text(record, "contractType", "instruments-info");
  const quoteCoin = text(record, "quoteCoin", "instruments-info");
  const settleCoin = text(record, "settleCoin", "instruments-info");
  if (
    contractType !== "LinearPerpetual" ||
    quoteCoin !== "USDT" ||
    settleCoin !== "USDT"
  ) {
    precondition(
      `Bybit instrument ${symbol} is not the intended USDT linear perpetual.`,
    );
  }
  const baseCoin = text(record, "baseCoin", "instruments-info");
  const priceFilter = object(
    record.priceFilter,
    "instruments-info.priceFilter",
  );
  const lotSizeFilter = object(
    record.lotSizeFilter,
    "instruments-info.lotSizeFilter",
  );
  const constraintsResult = createInstrumentConstraints({
    instrument: symbol,
    version: "bybit-v5:public-instrument/v1",
    priceTickSize: priceFilter.tickSize,
    quantityStep: lotSizeFilter.qtyStep,
    minQuantity: lotSizeFilter.minOrderQty,
    minNotional: lotSizeFilter.minNotionalValue,
  });
  if (!constraintsResult.ok)
    invalid(`Bybit instrument ${symbol} constraints are invalid.`);
  const fundingInterval = parsePositiveInteger(
    record.fundingInterval,
    "fundingInterval",
    "instruments-info",
  );
  const mapped: MarketInstrumentEvidence = {
    symbol,
    status,
    contractType: "LinearPerpetual",
    baseCoin,
    quoteCoin: "USDT",
    settleCoin: "USDT",
    constraints: constraintsResult.value,
    fundingInterval,
    ...(response.time === undefined
      ? {}
      : { sourceTimestamp: envelopeTime(response, "instruments-info") }),
  };
  return Object.freeze(mapped);
}

export function mapTicker(
  response: BybitPublicResponse,
  expectedSymbol: string,
): MarketTickerEvidence {
  const symbol = configuredSymbol(expectedSymbol);
  const list = records(response, "tickers");
  const matches = list.filter((item) => item.symbol === symbol);
  if (matches.length === 0) missing(`Bybit did not return ticker ${symbol}.`);
  if (matches.length > 1)
    precondition(`Bybit returned duplicate ticker ${symbol}.`);
  const record = object(matches[0], "tickers");
  const observedAt = envelopeTime(response, "tickers");
  const bid = decimal(record.bid1Price, "bid1Price", "tickers", "positive");
  const ask = decimal(record.ask1Price, "ask1Price", "tickers", "positive");
  if (bid.compare(ask) > 0)
    precondition(`Bybit ticker ${symbol} has bid above ask.`);
  const value: {
    observedAt: UtcTimestamp;
    bid: DecimalValue;
    ask: DecimalValue;
    last: DecimalValue;
    markPrice?: DecimalValue;
    indexPrice?: DecimalValue;
    fundingRate?: DecimalValue;
    openInterest?: DecimalValue;
    volume24h?: DecimalValue;
    turnover24h?: DecimalValue;
  } = {
    observedAt,
    bid,
    ask,
    last: decimal(record.lastPrice, "lastPrice", "tickers", "positive"),
  };
  const markPrice = optionalDecimal(record, "markPrice", "tickers", "positive");
  const indexPrice = optionalDecimal(
    record,
    "indexPrice",
    "tickers",
    "positive",
  );
  const fundingRate = optionalDecimal(record, "fundingRate", "tickers", "any");
  const openInterest = optionalDecimal(
    record,
    "openInterest",
    "tickers",
    "non-negative",
  );
  const volume24h = optionalDecimal(
    record,
    "volume24h",
    "tickers",
    "non-negative",
  );
  const turnover24h = optionalDecimal(
    record,
    "turnover24h",
    "tickers",
    "non-negative",
  );
  return Object.freeze({
    ...value,
    ...(markPrice === undefined ? {} : { markPrice }),
    ...(indexPrice === undefined ? {} : { indexPrice }),
    ...(fundingRate === undefined ? {} : { fundingRate }),
    ...(openInterest === undefined ? {} : { openInterest }),
    ...(volume24h === undefined ? {} : { volume24h }),
    ...(turnover24h === undefined ? {} : { turnover24h }),
  });
}

export function mapKline(
  response: BybitPublicResponse,
  expectedSymbol: string,
  interval: MarketSeriesInterval,
  exchangeTime: UtcTimestamp,
): readonly OhlcvObservation[] {
  const symbol = configuredSymbol(expectedSymbol);
  if (text(response.result, "symbol", "kline") !== symbol) {
    precondition(
      `Bybit kline response returned the wrong symbol for ${symbol}.`,
    );
  }
  if (text(response.result, "category", "kline") !== "linear") {
    precondition("Bybit kline response returned the wrong category.");
  }
  const list = response.result.list;
  if (!Array.isArray(list))
    invalid("Bybit kline response did not contain a list.");
  const mapped: OhlcvObservation[] = list.map((raw) => {
    if (!Array.isArray(raw) || raw.length < 7)
      invalid("Bybit kline row is malformed.");
    const start = epochMs(raw[0], "startTime", "kline");
    const value: OhlcvObservation = {
      timestamp: timestamp(start, "startTime", "kline"),
      open: decimal(raw[1], "open", "kline", "positive"),
      high: decimal(raw[2], "high", "kline", "positive"),
      low: decimal(raw[3], "low", "kline", "positive"),
      close: decimal(raw[4], "close", "kline", "positive"),
      volume: decimal(raw[5], "volume", "kline", "non-negative"),
      turnover: decimal(raw[6], "turnover", "kline", "non-negative"),
      closed:
        start + marketIntervalMilliseconds(interval) <=
        Date.parse(exchangeTime),
    };
    if (
      value.high.compare(value.low) < 0 ||
      value.high.compare(value.open) < 0 ||
      value.high.compare(value.close) < 0 ||
      value.low.compare(value.open) > 0 ||
      value.low.compare(value.close) > 0
    )
      invalid("Bybit kline row violates price bounds.");
    return Object.freeze(value);
  });
  return sortChronological(mapped, "kline");
}

export function mapFundingHistory(
  response: BybitPublicResponse,
  expectedSymbol: string,
): readonly FundingObservation[] {
  const symbol = configuredSymbol(expectedSymbol);
  const mapped = records(response, "funding-rate").map((record) => {
    if (text(record, "symbol", "funding-rate") !== symbol) {
      precondition(
        `Bybit funding response returned the wrong symbol for ${symbol}.`,
      );
    }
    return Object.freeze({
      timestamp: timestamp(
        record.fundingRateTimestamp,
        "fundingRateTimestamp",
        "funding-rate",
      ),
      rate: decimal(record.fundingRate, "fundingRate", "funding-rate", "any"),
    });
  });
  return sortChronological(mapped, "funding-rate");
}

export function mapOpenInterest(
  response: BybitPublicResponse,
  expectedSymbol: string,
  interval: OpenInterestInterval,
): readonly OpenInterestObservation[] {
  const label = `open-interest-${interval}`;
  const symbol = configuredSymbol(expectedSymbol);
  const responseSymbol = text(response.result, "symbol", label);
  if (responseSymbol !== symbol) {
    precondition(
      `Bybit open-interest response returned the wrong symbol for ${symbol}.`,
    );
  }
  const mapped = records(response, label).map((record) => {
    if (
      record.symbol !== undefined &&
      text(record, "symbol", label) !== symbol
    ) {
      precondition(
        `Bybit open-interest response returned the wrong symbol for ${symbol}.`,
      );
    }
    return Object.freeze({
      timestamp: timestamp(record.timestamp, "timestamp", label),
      openInterest: decimal(
        record.openInterest,
        "openInterest",
        label,
        "non-negative",
      ),
    });
  });
  return sortChronological(mapped, label);
}

export function sortChronological<T extends { timestamp: UtcTimestamp }>(
  values: readonly T[],
  label: string,
): readonly T[] {
  const sorted = [...values].sort(
    (left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp),
  );
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (previous === undefined || current === undefined) continue;
    if (previous.timestamp === current.timestamp) {
      precondition(`Bybit ${label} response contains duplicate timestamps.`);
    }
  }
  return Object.freeze(sorted);
}
