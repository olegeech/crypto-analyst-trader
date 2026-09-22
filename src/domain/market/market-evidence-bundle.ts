import { domainError } from "../shared/errors.js";
import { DecimalValue, isDecimalValue } from "../shared/decimal.js";
import { fail, ok, type Result } from "../shared/result.js";
import { parseUtcTimestamp, type UtcTimestamp } from "../shared/time.js";
import {
  isRecord,
  requireFiniteInteger,
  requireIdentifier,
  requireSafeText,
} from "../shared/validation.js";
import {
  createEvidenceRef,
  type EvidenceRef,
} from "../evidence/evidence-ref.js";
import {
  createInstrumentConstraints,
  type InstrumentConstraints,
} from "./instrument-constraints.js";
import {
  parseMarketEvidenceDiagnostics,
  type MarketEvidenceDiagnostic,
} from "./market-evidence-diagnostics.js";
import {
  fundingIntervalMilliseconds,
  MARKET_OHLCV_WINDOWS,
  MARKET_FUNDING_WINDOW,
  MARKET_OPEN_INTEREST_WINDOWS,
  marketIntervalMilliseconds,
} from "./market-evidence-windows.js";

export type { MarketEvidenceDiagnostic } from "./market-evidence-diagnostics.js";

export const MARKET_EVIDENCE_SCHEMA_VERSION = "market-evidence/v1" as const;
export const MARKET_EVIDENCE_UNIVERSE_VERSION = "m1-universe/v1" as const;
export const MARKET_EVIDENCE_PRODUCER =
  "crypto-analyst-trader/bybit-public" as const;
export const MARKET_EVIDENCE_SYMBOLS = Object.freeze([
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "DOGEUSDT",
] as const);

export type MarketEvidenceSymbol = (typeof MARKET_EVIDENCE_SYMBOLS)[number];
export type MarketEvidenceStatus = "complete" | "incomplete";
export type MarketInstrumentStatus = "trading" | "non-trading" | "unavailable";
export type MarketSeriesInterval = "1h" | "4h" | "1d" | "1w";
export type OpenInterestInterval = "1h" | "4h" | "1d";

export interface MarketEvidenceSource {
  readonly exchange: "bybit";
  readonly environment: "mainnet";
  readonly origin: "https://api.bybit.com";
  readonly category: "linear";
}

export interface MarketInstrumentEvidence {
  readonly symbol: MarketEvidenceSymbol;
  readonly status: MarketInstrumentStatus;
  readonly contractType: "LinearPerpetual";
  readonly baseCoin: string;
  readonly quoteCoin: "USDT";
  readonly settleCoin: "USDT";
  readonly constraints: InstrumentConstraints;
  readonly fundingInterval: number;
  readonly sourceTimestamp?: UtcTimestamp;
}

export interface MarketTickerEvidence {
  readonly observedAt: UtcTimestamp;
  readonly bid: DecimalValue;
  readonly ask: DecimalValue;
  readonly last: DecimalValue;
  readonly markPrice?: DecimalValue;
  readonly indexPrice?: DecimalValue;
  readonly fundingRate?: DecimalValue;
  readonly openInterest?: DecimalValue;
  readonly volume24h?: DecimalValue;
  readonly turnover24h?: DecimalValue;
}

export interface OhlcvObservation {
  readonly timestamp: UtcTimestamp;
  readonly open: DecimalValue;
  readonly high: DecimalValue;
  readonly low: DecimalValue;
  readonly close: DecimalValue;
  readonly volume: DecimalValue;
  readonly turnover: DecimalValue;
  readonly closed: boolean;
}

export interface OhlcvSeries {
  readonly interval: MarketSeriesInterval;
  readonly observations: readonly OhlcvObservation[];
}

export interface FundingObservation {
  readonly timestamp: UtcTimestamp;
  readonly rate: DecimalValue;
}

export interface OpenInterestObservation {
  readonly timestamp: UtcTimestamp;
  readonly openInterest: DecimalValue;
}

export interface OpenInterestSeries {
  readonly interval: OpenInterestInterval;
  readonly observations: readonly OpenInterestObservation[];
}

export interface MarketSymbolEvidence {
  readonly symbol: MarketEvidenceSymbol;
  readonly instrument?: MarketInstrumentEvidence;
  readonly ticker?: MarketTickerEvidence;
  readonly ohlcv: readonly OhlcvSeries[];
  readonly funding: readonly FundingObservation[];
  readonly openInterest: readonly OpenInterestSeries[];
  readonly diagnostics: readonly MarketEvidenceDiagnostic[];
}

export interface MarketEvidenceBundle {
  readonly runId: string;
  readonly schemaVersion: typeof MARKET_EVIDENCE_SCHEMA_VERSION;
  readonly producer: string;
  readonly universeVersion: typeof MARKET_EVIDENCE_UNIVERSE_VERSION;
  readonly universe: readonly MarketEvidenceSymbol[];
  readonly collectionStartedAt: UtcTimestamp;
  readonly collectionEndedAt: UtcTimestamp;
  readonly bundleCutoff: UtcTimestamp;
  readonly source: MarketEvidenceSource;
  readonly status: MarketEvidenceStatus;
  readonly symbols: readonly MarketSymbolEvidence[];
  readonly diagnostics: readonly MarketEvidenceDiagnostic[];
  readonly evidence: readonly EvidenceRef[];
}

const OHLCTV_INTERVALS = new Set<MarketSeriesInterval>([
  "1h",
  "4h",
  "1d",
  "1w",
]);
const OI_INTERVALS = new Set<OpenInterestInterval>(["1h", "4h", "1d"]);

function hasExpectedCadence(
  observations: readonly { readonly timestamp: UtcTimestamp }[],
  stepMs: number,
): boolean {
  return observations.every((observation, index) => {
    const previous = observations[index - 1];
    return (
      previous === undefined ||
      Date.parse(observation.timestamp) - Date.parse(previous.timestamp) ===
        stepMs
    );
  });
}

function invalid(message: string, field?: string): Result<never> {
  return fail(
    domainError(
      "INVALID_VALUE",
      message,
      field === undefined ? undefined : { field },
    ),
  );
}

function timestamp(value: unknown, field: string): Result<UtcTimestamp> {
  const result = parseUtcTimestamp(value);
  return result.ok
    ? result
    : fail(domainError("INVALID_TIMESTAMP", `${field} is invalid`, { field }));
}

function identifier(value: unknown, field: string): Result<string> {
  return requireIdentifier(value, field);
}

function decimal(
  value: unknown,
  field: string,
  mode: "positive" | "non-negative" | "any" = "any",
): Result<DecimalValue> {
  if (isDecimalValue(value)) {
    if (
      (mode === "positive" && !value.isPositive()) ||
      (mode === "non-negative" && value.isNegative())
    ) {
      return fail(
        domainError("INVALID_VALUE", `${field} is out of range`, { field }),
      );
    }
    return ok(value);
  }
  const result = DecimalValue.fromString(value);
  if (!result.ok) return result;
  if (
    (mode === "positive" && !result.value.isPositive()) ||
    (mode === "non-negative" && result.value.isNegative())
  ) {
    return fail(
      domainError("INVALID_VALUE", `${field} is out of range`, { field }),
    );
  }
  return result;
}

function optionalDecimal(
  value: unknown,
  field: string,
  mode: "positive" | "non-negative" | "any" = "any",
): Result<DecimalValue | undefined> {
  if (value === undefined) return ok(undefined);
  return decimal(value, field, mode);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (
    typeof value !== "object" ||
    value === null ||
    isDecimalValue(value) ||
    seen.has(value)
  ) {
    return value;
  }
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function parseSource(input: unknown): Result<MarketEvidenceSource> {
  if (!isRecord(input)) return invalid("source must be an object", "source");
  if (
    input.exchange !== "bybit" ||
    input.environment !== "mainnet" ||
    input.origin !== "https://api.bybit.com" ||
    input.category !== "linear"
  ) {
    return invalid(
      "source must identify Bybit public mainnet linear data",
      "source",
    );
  }
  return ok(
    Object.freeze({
      exchange: "bybit",
      environment: "mainnet",
      origin: "https://api.bybit.com",
      category: "linear",
    }),
  );
}

function parseInstrument(
  input: unknown,
  symbol: MarketEvidenceSymbol,
): Result<MarketInstrumentEvidence> {
  if (!isRecord(input)) return invalid("instrument evidence must be an object");
  const baseCoin = requireSafeText(input.baseCoin, "baseCoin");
  const constraints = createInstrumentConstraints(input.constraints);
  const fundingInterval = requireFiniteInteger(
    input.fundingInterval,
    "fundingInterval",
    1,
  );
  const sourceTimestamp =
    input.sourceTimestamp === undefined
      ? ok<UtcTimestamp | undefined>(undefined)
      : timestamp(input.sourceTimestamp, "sourceTimestamp");
  const status = input.status;
  if (
    (status !== "trading" &&
      status !== "non-trading" &&
      status !== "unavailable") ||
    input.symbol !== symbol ||
    input.contractType !== "LinearPerpetual" ||
    input.quoteCoin !== "USDT" ||
    input.settleCoin !== "USDT" ||
    !baseCoin.ok ||
    !constraints.ok ||
    !fundingInterval.ok ||
    !sourceTimestamp.ok ||
    constraints.value.instrument !== symbol
  ) {
    return invalid(
      "instrument evidence does not prove the configured contract",
    );
  }
  const value: {
    symbol: MarketEvidenceSymbol;
    status: MarketInstrumentStatus;
    contractType: "LinearPerpetual";
    baseCoin: string;
    quoteCoin: "USDT";
    settleCoin: "USDT";
    constraints: InstrumentConstraints;
    fundingInterval: number;
    sourceTimestamp?: UtcTimestamp;
  } = {
    symbol,
    status,
    contractType: "LinearPerpetual",
    baseCoin: baseCoin.value,
    quoteCoin: "USDT",
    settleCoin: "USDT",
    constraints: constraints.value,
    fundingInterval: fundingInterval.value,
  };
  if (sourceTimestamp.value !== undefined)
    value.sourceTimestamp = sourceTimestamp.value;
  return ok(Object.freeze(value));
}

function parseTicker(input: unknown): Result<MarketTickerEvidence> {
  if (!isRecord(input)) return invalid("ticker evidence must be an object");
  const observedAt = timestamp(input.observedAt, "observedAt");
  const fields = {
    bid: decimal(input.bid, "bid", "positive"),
    ask: decimal(input.ask, "ask", "positive"),
    last: decimal(input.last, "last", "positive"),
    markPrice: optionalDecimal(input.markPrice, "markPrice", "positive"),
    indexPrice: optionalDecimal(input.indexPrice, "indexPrice", "positive"),
    fundingRate: optionalDecimal(input.fundingRate, "fundingRate", "any"),
    openInterest: optionalDecimal(
      input.openInterest,
      "openInterest",
      "non-negative",
    ),
    volume24h: optionalDecimal(input.volume24h, "volume24h", "non-negative"),
    turnover24h: optionalDecimal(
      input.turnover24h,
      "turnover24h",
      "non-negative",
    ),
  };
  if (
    !observedAt.ok ||
    !fields.bid.ok ||
    !fields.ask.ok ||
    !fields.last.ok ||
    !fields.markPrice.ok ||
    !fields.indexPrice.ok ||
    !fields.fundingRate.ok ||
    !fields.openInterest.ok ||
    !fields.volume24h.ok ||
    !fields.turnover24h.ok ||
    fields.bid.value.compare(fields.ask.value) > 0
  ) {
    return invalid("ticker evidence contains an invalid field");
  }
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
    observedAt: observedAt.value,
    bid: fields.bid.value,
    ask: fields.ask.value,
    last: fields.last.value,
  };
  const optionalValues: readonly (readonly [
    (
      | "markPrice"
      | "indexPrice"
      | "fundingRate"
      | "openInterest"
      | "volume24h"
      | "turnover24h"
    ),
    DecimalValue | undefined,
  ])[] = [
    ["markPrice", fields.markPrice.value],
    ["indexPrice", fields.indexPrice.value],
    ["fundingRate", fields.fundingRate.value],
    ["openInterest", fields.openInterest.value],
    ["volume24h", fields.volume24h.value],
    ["turnover24h", fields.turnover24h.value],
  ];
  for (const [field, fieldValue] of optionalValues) {
    if (fieldValue !== undefined) value[field] = fieldValue;
  }
  return ok(Object.freeze(value));
}

function parseObservationTimestamp(
  input: unknown,
  field: string,
): Result<UtcTimestamp> {
  return timestamp(input, field);
}

function parseOhlcvObservation(input: unknown): Result<OhlcvObservation> {
  if (!isRecord(input)) return invalid("OHLCV observation must be an object");
  const fields = {
    timestamp: parseObservationTimestamp(input.timestamp, "timestamp"),
    open: decimal(input.open, "open", "positive"),
    high: decimal(input.high, "high", "positive"),
    low: decimal(input.low, "low", "positive"),
    close: decimal(input.close, "close", "positive"),
    volume: decimal(input.volume, "volume", "non-negative"),
    turnover: decimal(input.turnover, "turnover", "non-negative"),
  };
  if (
    !fields.timestamp.ok ||
    !fields.open.ok ||
    !fields.high.ok ||
    !fields.low.ok ||
    !fields.close.ok ||
    !fields.volume.ok ||
    !fields.turnover.ok ||
    typeof input.closed !== "boolean"
  ) {
    return invalid("OHLCV observation contains an invalid field");
  }
  if (
    fields.high.value.compare(fields.low.value) < 0 ||
    fields.high.value.compare(fields.open.value) < 0 ||
    fields.high.value.compare(fields.close.value) < 0 ||
    fields.low.value.compare(fields.open.value) > 0 ||
    fields.low.value.compare(fields.close.value) > 0
  ) {
    return invalid("OHLCV observation violates price bounds");
  }
  return ok(
    Object.freeze({
      timestamp: fields.timestamp.value,
      open: fields.open.value,
      high: fields.high.value,
      low: fields.low.value,
      close: fields.close.value,
      volume: fields.volume.value,
      turnover: fields.turnover.value,
      closed: input.closed,
    }),
  );
}

function parseSeriesObservations<T extends { timestamp: UtcTimestamp }>(
  input: unknown,
  parser: (value: unknown) => Result<T>,
  label: string,
): Result<readonly T[]> {
  if (!Array.isArray(input))
    return invalid(`${label} observations must be an array`);
  const parsed: T[] = [];
  let previous: UtcTimestamp | undefined;
  for (const item of input) {
    const observation = parser(item);
    if (!observation.ok) return observation;
    if (
      previous !== undefined &&
      Date.parse(observation.value.timestamp) <= Date.parse(previous)
    ) {
      return invalid(`${label} observations must be strictly chronological`);
    }
    previous = observation.value.timestamp;
    parsed.push(observation.value);
  }
  return ok(Object.freeze(parsed));
}

function parseOhlcvSeries(input: unknown): Result<OhlcvSeries> {
  if (
    !isRecord(input) ||
    typeof input.interval !== "string" ||
    !OHLCTV_INTERVALS.has(input.interval as MarketSeriesInterval)
  ) {
    return invalid("OHLCV series has an invalid interval");
  }
  const observations = parseSeriesObservations(
    input.observations,
    parseOhlcvObservation,
    "OHLCV",
  );
  if (!observations.ok) return observations;
  return ok(
    Object.freeze({
      interval: input.interval as MarketSeriesInterval,
      observations: observations.value,
    }),
  );
}

function parseFundingObservation(input: unknown): Result<FundingObservation> {
  if (!isRecord(input)) return invalid("funding observation must be an object");
  const timestampValue = timestamp(input.timestamp, "timestamp");
  const rate = decimal(input.rate, "rate", "any");
  if (!timestampValue.ok) return timestampValue;
  if (!rate.ok) return rate;
  return ok(
    Object.freeze({ timestamp: timestampValue.value, rate: rate.value }),
  );
}

function parseOpenInterestObservation(
  input: unknown,
): Result<OpenInterestObservation> {
  if (!isRecord(input))
    return invalid("open-interest observation must be an object");
  const timestampValue = timestamp(input.timestamp, "timestamp");
  const openInterest = decimal(
    input.openInterest,
    "openInterest",
    "non-negative",
  );
  if (!timestampValue.ok) return timestampValue;
  if (!openInterest.ok) return openInterest;
  return ok(
    Object.freeze({
      timestamp: timestampValue.value,
      openInterest: openInterest.value,
    }),
  );
}

function parseOpenInterestSeries(input: unknown): Result<OpenInterestSeries> {
  if (
    !isRecord(input) ||
    typeof input.interval !== "string" ||
    !OI_INTERVALS.has(input.interval as OpenInterestInterval)
  ) {
    return invalid("open-interest series has an invalid interval");
  }
  const observations = parseSeriesObservations(
    input.observations,
    parseOpenInterestObservation,
    "open-interest",
  );
  if (!observations.ok) return observations;
  return ok(
    Object.freeze({
      interval: input.interval as OpenInterestInterval,
      observations: observations.value,
    }),
  );
}

function parseSymbolEvidence(
  input: unknown,
  cutoff: UtcTimestamp,
): Result<MarketSymbolEvidence> {
  if (!isRecord(input)) return invalid("symbol evidence must be an object");
  const symbol = input.symbol;
  if (
    typeof symbol !== "string" ||
    !MARKET_EVIDENCE_SYMBOLS.includes(symbol as MarketEvidenceSymbol)
  ) {
    return invalid(
      "symbol evidence has an unsupported configured symbol",
      "symbol",
    );
  }
  const instrument =
    input.instrument === undefined
      ? ok<MarketInstrumentEvidence | undefined>(undefined)
      : parseInstrument(input.instrument, symbol as MarketEvidenceSymbol);
  const ticker =
    input.ticker === undefined
      ? ok<MarketTickerEvidence | undefined>(undefined)
      : parseTicker(input.ticker);
  const ohlcvInput = input.ohlcv;
  if (!Array.isArray(ohlcvInput))
    return invalid("symbol OHLCV evidence must be an array");
  const ohlcv: OhlcvSeries[] = [];
  const ohlcvIntervals = new Set<string>();
  for (const series of ohlcvInput) {
    const parsed = parseOhlcvSeries(series);
    if (!parsed.ok) return parsed;
    if (ohlcvIntervals.has(parsed.value.interval))
      return invalid("duplicate OHLCV interval");
    ohlcvIntervals.add(parsed.value.interval);
    ohlcv.push(parsed.value);
  }
  const funding = parseSeriesObservations(
    input.funding,
    parseFundingObservation,
    "funding",
  );
  if (!funding.ok) return funding;
  const openInterestInput = input.openInterest;
  if (!Array.isArray(openInterestInput))
    return invalid("symbol open-interest evidence must be an array");
  const openInterest: OpenInterestSeries[] = [];
  const oiIntervals = new Set<string>();
  for (const series of openInterestInput) {
    const parsed = parseOpenInterestSeries(series);
    if (!parsed.ok) return parsed;
    if (oiIntervals.has(parsed.value.interval))
      return invalid("duplicate open-interest interval");
    oiIntervals.add(parsed.value.interval);
    openInterest.push(parsed.value);
  }
  const diagnostics = parseMarketEvidenceDiagnostics(input.diagnostics);
  if (!instrument.ok || !ticker.ok || !diagnostics.ok)
    return invalid("symbol evidence contains an invalid field");
  if (
    ticker.value !== undefined &&
    Date.parse(ticker.value.observedAt) > Date.parse(cutoff)
  ) {
    return invalid("ticker observation cannot be newer than the bundle cutoff");
  }
  for (const series of ohlcv) {
    for (const item of series.observations) {
      if (Date.parse(item.timestamp) > Date.parse(cutoff))
        return invalid("OHLCV observation is newer than the bundle cutoff");
    }
  }
  for (const item of funding.value) {
    if (Date.parse(item.timestamp) > Date.parse(cutoff))
      return invalid("funding observation is newer than the bundle cutoff");
  }
  for (const series of openInterest) {
    for (const item of series.observations) {
      if (Date.parse(item.timestamp) > Date.parse(cutoff))
        return invalid(
          "open-interest observation is newer than the bundle cutoff",
        );
    }
  }
  return ok(
    Object.freeze({
      symbol: symbol as MarketEvidenceSymbol,
      ...(instrument.value === undefined
        ? {}
        : { instrument: instrument.value }),
      ...(ticker.value === undefined ? {} : { ticker: ticker.value }),
      ohlcv: Object.freeze(ohlcv),
      funding: funding.value,
      openInterest: Object.freeze(openInterest),
      diagnostics: diagnostics.value,
    }),
  );
}

export function createMarketEvidenceBundle(
  input: unknown,
): Result<MarketEvidenceBundle> {
  if (!isRecord(input))
    return invalid("market evidence bundle must be an object");
  const runId = identifier(input.runId, "runId");
  const producer = requireSafeText(input.producer, "producer");
  const collectionStartedAt = timestamp(
    input.collectionStartedAt,
    "collectionStartedAt",
  );
  const collectionEndedAt = timestamp(
    input.collectionEndedAt,
    "collectionEndedAt",
  );
  const bundleCutoff = timestamp(input.bundleCutoff, "bundleCutoff");
  const source = parseSource(input.source);
  const diagnostics = parseMarketEvidenceDiagnostics(input.diagnostics);
  const evidenceInput = input.evidence;
  if (!Array.isArray(evidenceInput) || evidenceInput.length === 0)
    return invalid("bundle evidence must be a non-empty array");
  const evidence: EvidenceRef[] = [];
  for (const item of evidenceInput) {
    const parsed = createEvidenceRef(item);
    if (!parsed.ok) return parsed;
    evidence.push(parsed.value);
  }
  if (
    input.schemaVersion !== MARKET_EVIDENCE_SCHEMA_VERSION ||
    input.universeVersion !== MARKET_EVIDENCE_UNIVERSE_VERSION ||
    !runId.ok ||
    !producer.ok ||
    !collectionStartedAt.ok ||
    !collectionEndedAt.ok ||
    !bundleCutoff.ok ||
    !source.ok ||
    !diagnostics.ok ||
    (input.status !== "complete" && input.status !== "incomplete") ||
    !Array.isArray(input.universe) ||
    !Array.isArray(input.symbols)
  ) {
    return invalid("market evidence bundle identity or status is invalid");
  }
  if (
    Date.parse(collectionEndedAt.value) < Date.parse(collectionStartedAt.value)
  )
    return invalid("collection end precedes collection start");
  // bundleCutoff is exchange time while collectionStartedAt is local metadata;
  // local and exchange clocks are allowed to differ.
  if (
    input.universe.length !== MARKET_EVIDENCE_SYMBOLS.length ||
    input.universe.some(
      (item, index) => item !== MARKET_EVIDENCE_SYMBOLS[index],
    )
  )
    return invalid("bundle universe is not the versioned M1 universe");
  if (input.symbols.length !== MARKET_EVIDENCE_SYMBOLS.length)
    return invalid("bundle must contain one record per configured symbol");
  const symbols = new Set<string>();
  const parsedSymbols: MarketSymbolEvidence[] = [];
  for (const item of input.symbols) {
    const parsed = parseSymbolEvidence(item, bundleCutoff.value);
    if (!parsed.ok) return parsed;
    if (
      parsed.value.instrument?.sourceTimestamp !== undefined &&
      Date.parse(parsed.value.instrument.sourceTimestamp) >
        Date.parse(bundleCutoff.value)
    ) {
      return invalid("instrument evidence is newer than the bundle cutoff");
    }
    if (symbols.has(parsed.value.symbol))
      return invalid("bundle contains a duplicate configured symbol");
    symbols.add(parsed.value.symbol);
    parsedSymbols.push(parsed.value);
  }
  if (MARKET_EVIDENCE_SYMBOLS.some((symbol) => !symbols.has(symbol)))
    return invalid("bundle is missing a configured symbol");
  if (
    evidence.some(
      (item) => Date.parse(item.asOf) > Date.parse(bundleCutoff.value),
    )
  ) {
    return invalid("evidence reference is newer than the bundle cutoff");
  }
  const orderedSymbols = MARKET_EVIDENCE_SYMBOLS.map((symbol) =>
    parsedSymbols.find((item) => item.symbol === symbol)!,
  );
  if (input.status === "complete") {
    for (const symbol of orderedSymbols) {
      if (
        symbol.instrument === undefined ||
        symbol.ticker === undefined ||
        symbol.diagnostics.length > 0 ||
        symbol.ohlcv.length !== Object.keys(MARKET_OHLCV_WINDOWS).length ||
        symbol.funding.length !== MARKET_FUNDING_WINDOW ||
        symbol.openInterest.length !==
          Object.keys(MARKET_OPEN_INTEREST_WINDOWS).length
      )
        return invalid("complete bundle is missing required symbol evidence");
      for (const interval of Object.keys(
        MARKET_OHLCV_WINDOWS,
      ) as MarketSeriesInterval[]) {
        const series = symbol.ohlcv.find((item) => item.interval === interval);
        if (
          series === undefined ||
          series.observations.length !== MARKET_OHLCV_WINDOWS[interval] ||
          !series.observations.every((item) => item.closed) ||
          !hasExpectedCadence(
            series.observations,
            marketIntervalMilliseconds(interval),
          )
        ) {
          return invalid("complete bundle has incomplete OHLCV evidence");
        }
      }
      if (
        !hasExpectedCadence(
          symbol.funding,
          fundingIntervalMilliseconds(symbol.instrument.fundingInterval),
        )
      ) {
        return invalid("complete bundle has gapped funding evidence");
      }
      for (const interval of Object.keys(
        MARKET_OPEN_INTEREST_WINDOWS,
      ) as OpenInterestInterval[]) {
        const series = symbol.openInterest.find(
          (item) => item.interval === interval,
        );
        if (
          series === undefined ||
          series.observations.length !==
            MARKET_OPEN_INTEREST_WINDOWS[interval] ||
          !hasExpectedCadence(
            series.observations,
            marketIntervalMilliseconds(interval),
          )
        ) {
          return invalid(
            "complete bundle has incomplete open-interest evidence",
          );
        }
      }
    }
    if (diagnostics.value.length > 0)
      return invalid("complete bundle has global diagnostics");
  }
  const bundle = {
    runId: runId.value,
    schemaVersion: MARKET_EVIDENCE_SCHEMA_VERSION,
    producer: producer.value,
    universeVersion: MARKET_EVIDENCE_UNIVERSE_VERSION,
    universe: Object.freeze([...MARKET_EVIDENCE_SYMBOLS]),
    collectionStartedAt: collectionStartedAt.value,
    collectionEndedAt: collectionEndedAt.value,
    bundleCutoff: bundleCutoff.value,
    source: source.value,
    status: input.status as MarketEvidenceStatus,
    symbols: Object.freeze(orderedSymbols),
    diagnostics: diagnostics.value,
    evidence: Object.freeze(evidence),
  };
  return ok(deepFreeze(bundle));
}

export function isCompleteMarketEvidenceBundle(
  bundle: MarketEvidenceBundle,
): boolean {
  return bundle.status === "complete";
}
