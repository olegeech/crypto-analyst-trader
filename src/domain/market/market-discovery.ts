import { DecimalValue, RoundingMode } from "../shared/decimal.js";
import type { UtcTimestamp } from "../shared/time.js";

export interface MarketDiscoveryInstrument {
  readonly symbol?: string;
  readonly status?: string;
  readonly contractType?: string;
  readonly quoteCoin?: string;
  readonly settleCoin?: string;
}

export interface MarketDiscoveryTicker {
  readonly symbol?: string;
  readonly turnover24h?: DecimalValue;
  readonly bid?: DecimalValue;
  readonly ask?: DecimalValue;
  readonly priceChange24h?: DecimalValue;
  readonly highPrice24h?: DecimalValue;
  readonly lowPrice24h?: DecimalValue;
}

export interface MarketDiscoverySnapshot {
  readonly asOf: UtcTimestamp;
  readonly instruments: readonly MarketDiscoveryInstrument[];
  readonly tickers: readonly MarketDiscoveryTicker[];
  readonly requestCount: number;
}

export type MarketDiscoveryExclusionReason =
  | "MISSING_SYMBOL"
  | "INSTRUMENT_NOT_TRADING"
  | "NOT_LINEAR_PERPETUAL"
  | "NON_USDT_QUOTE"
  | "NON_USDT_SETTLEMENT"
  | "MISSING_TICKER"
  | "MISSING_TURNOVER"
  | "NON_POSITIVE_TURNOVER"
  | "MISSING_QUOTES"
  | "NON_POSITIVE_QUOTES"
  | "CROSSED_QUOTES"
  | "INSTRUMENT_NOT_FOUND";

export interface MarketDiscoveryCandidate {
  readonly symbol: string;
  readonly turnover24h: DecimalValue;
  readonly bid: DecimalValue;
  readonly ask: DecimalValue;
  /** Relative spread as a fraction: (ask - bid) / midpoint. */
  readonly relativeSpread: DecimalValue;
  readonly priceChange24h?: DecimalValue;
  readonly highPrice24h?: DecimalValue;
  readonly lowPrice24h?: DecimalValue;
  readonly reasons: readonly string[];
}

export interface MarketDiscoveryAnalysis {
  readonly status: "READY" | "NO_CANDIDATES";
  readonly candidates: readonly MarketDiscoveryCandidate[];
  readonly matchedCount: number;
  readonly eligibleCount: number;
  readonly exclusionCounts: Readonly<
    Partial<Record<MarketDiscoveryExclusionReason, number>>
  >;
  readonly target?: {
    readonly symbol: string;
    readonly candidate?: MarketDiscoveryCandidate;
    readonly reasons?: readonly MarketDiscoveryExclusionReason[];
  };
}

export interface MarketDiscoveryOptions {
  readonly symbol?: string;
  readonly resultLimit?: number;
}

export const DEFAULT_MARKET_DISCOVERY_RESULT_LIMIT = 5;
export const MAX_MARKET_DISCOVERY_RESULT_LIMIT = 100;

interface EligibleMarketRow {
  readonly symbol: string;
  readonly turnover24h: DecimalValue;
  readonly bid: DecimalValue;
  readonly ask: DecimalValue;
  readonly priceChange24h?: DecimalValue;
  readonly highPrice24h?: DecimalValue;
  readonly lowPrice24h?: DecimalValue;
}

function constant(value: string): DecimalValue {
  const parsed = DecimalValue.fromString(value);
  if (!parsed.ok)
    throw new Error("Market discovery decimal constant is invalid.");
  return parsed.value;
}

const TWO = constant("2");
const ONE_HUNDRED = constant("100");

function assessEligibility(
  instrument: MarketDiscoveryInstrument,
  ticker: MarketDiscoveryTicker | undefined,
):
  | { readonly eligible: EligibleMarketRow }
  | { readonly reasons: readonly MarketDiscoveryExclusionReason[] } {
  const reasons: MarketDiscoveryExclusionReason[] = [];
  const symbol = instrument.symbol;
  if (symbol === undefined || symbol.length === 0)
    return { reasons: ["MISSING_SYMBOL"] };
  if (instrument.status !== "Trading") reasons.push("INSTRUMENT_NOT_TRADING");
  if (instrument.contractType !== "LinearPerpetual")
    reasons.push("NOT_LINEAR_PERPETUAL");
  if (instrument.quoteCoin !== "USDT") reasons.push("NON_USDT_QUOTE");
  if (instrument.settleCoin !== "USDT") reasons.push("NON_USDT_SETTLEMENT");
  if (reasons.length > 0) return { reasons };
  if (ticker === undefined) return { reasons: ["MISSING_TICKER"] };
  if (ticker.turnover24h === undefined)
    return { reasons: ["MISSING_TURNOVER"] };
  if (!ticker.turnover24h.isPositive())
    return { reasons: ["NON_POSITIVE_TURNOVER"] };
  if (ticker.bid === undefined || ticker.ask === undefined)
    return { reasons: ["MISSING_QUOTES"] };
  if (!ticker.bid.isPositive() || !ticker.ask.isPositive())
    return { reasons: ["NON_POSITIVE_QUOTES"] };
  if (ticker.bid.compare(ticker.ask) > 0)
    return { reasons: ["CROSSED_QUOTES"] };
  return {
    eligible: {
      symbol,
      turnover24h: ticker.turnover24h,
      bid: ticker.bid,
      ask: ticker.ask,
      ...(ticker.priceChange24h === undefined
        ? {}
        : { priceChange24h: ticker.priceChange24h }),
      ...(ticker.highPrice24h === undefined
        ? {}
        : { highPrice24h: ticker.highPrice24h }),
      ...(ticker.lowPrice24h === undefined
        ? {}
        : { lowPrice24h: ticker.lowPrice24h }),
    },
  };
}

function candidateFor(row: EligibleMarketRow): MarketDiscoveryCandidate {
  const spreadNumerator = row.ask.subtract(row.bid).multiply(TWO);
  const spreadDenominator = row.ask.add(row.bid);
  const spread = spreadNumerator.divide(
    spreadDenominator,
    18,
    RoundingMode.HALF_UP,
  );
  if (!spread.ok)
    throw new Error("Market discovery spread could not be computed.");
  const percentage = spread.value
    .multiply(ONE_HUNDRED)
    .roundToScale(4, RoundingMode.HALF_UP)
    .toString();

  const candidate: MarketDiscoveryCandidate = Object.freeze({
    symbol: row.symbol,
    turnover24h: row.turnover24h,
    bid: row.bid,
    ask: row.ask,
    relativeSpread: spread.value,
    ...(row.priceChange24h === undefined
      ? {}
      : { priceChange24h: row.priceChange24h }),
    ...(row.highPrice24h === undefined
      ? {}
      : { highPrice24h: row.highPrice24h }),
    ...(row.lowPrice24h === undefined ? {} : { lowPrice24h: row.lowPrice24h }),
    reasons: Object.freeze([
      `relative spread ${percentage}%`,
      `24h turnover ${row.turnover24h.toString()} USDT`,
    ]),
  });
  return candidate;
}

function compareRelativeSpread(
  left: EligibleMarketRow,
  right: EligibleMarketRow,
): number {
  const leftWidth = left.ask.subtract(left.bid);
  const rightWidth = right.ask.subtract(right.bid);
  return leftWidth
    .multiply(right.ask.add(right.bid))
    .compare(rightWidth.multiply(left.ask.add(left.bid)));
}

function compareTurnoverSpreadSymbol(
  left: EligibleMarketRow,
  right: EligibleMarketRow,
): number {
  return (
    right.turnover24h.compare(left.turnover24h) ||
    compareRelativeSpread(left, right) ||
    (left.symbol < right.symbol ? -1 : left.symbol > right.symbol ? 1 : 0)
  );
}

function countReasons(
  counts: Partial<Record<MarketDiscoveryExclusionReason, number>>,
  reasons: readonly MarketDiscoveryExclusionReason[],
): void {
  for (const reason of reasons) counts[reason] = (counts[reason] ?? 0) + 1;
}

/** Pure eligibility and deterministic ranking for dynamic linear candidates. */
export function rankMarketDiscovery(
  snapshot: MarketDiscoverySnapshot,
  options: MarketDiscoveryOptions = {},
): MarketDiscoveryAnalysis {
  if (
    options.resultLimit !== undefined &&
    (!Number.isInteger(options.resultLimit) ||
      options.resultLimit < 1 ||
      options.resultLimit > MAX_MARKET_DISCOVERY_RESULT_LIMIT)
  ) {
    throw new RangeError("resultLimit must be an integer from 1 to 100");
  }
  if (options.symbol !== undefined && options.symbol.length === 0) {
    throw new TypeError("symbol must not be empty");
  }

  const tickerBySymbol = new Map<string, MarketDiscoveryTicker>();
  for (const ticker of snapshot.tickers) {
    if (ticker.symbol !== undefined) tickerBySymbol.set(ticker.symbol, ticker);
  }

  const instruments =
    options.symbol === undefined
      ? snapshot.instruments
      : snapshot.instruments.filter(
          (instrument) => instrument.symbol === options.symbol,
        );
  const exclusionCounts: Partial<
    Record<MarketDiscoveryExclusionReason, number>
  > = {};
  const eligible: EligibleMarketRow[] = [];
  let matchedCount = 0;
  let targetExclusionReasons:
    readonly MarketDiscoveryExclusionReason[] | undefined;

  for (const instrument of instruments) {
    const ticker =
      instrument.symbol === undefined
        ? undefined
        : tickerBySymbol.get(instrument.symbol);
    if (ticker !== undefined) matchedCount += 1;
    const assessment = assessEligibility(instrument, ticker);
    if ("reasons" in assessment) {
      countReasons(exclusionCounts, assessment.reasons);
      if (
        options.symbol !== undefined &&
        instrument.symbol === options.symbol &&
        targetExclusionReasons === undefined
      ) {
        targetExclusionReasons = assessment.reasons;
      }
      continue;
    }
    eligible.push(assessment.eligible);
  }

  let target: MarketDiscoveryAnalysis["target"] | undefined;
  let targetCandidate: MarketDiscoveryCandidate | undefined;
  if (options.symbol !== undefined) {
    const found = instruments.length > 0;
    const row = eligible[0];
    targetCandidate = row === undefined ? undefined : candidateFor(row);
    if (!found) {
      countReasons(exclusionCounts, ["INSTRUMENT_NOT_FOUND"]);
      targetExclusionReasons = ["INSTRUMENT_NOT_FOUND"];
    }
    target = {
      symbol: options.symbol,
      ...(targetCandidate === undefined ? {} : { candidate: targetCandidate }),
      ...(row === undefined
        ? {
            reasons: Object.freeze(
              targetExclusionReasons ?? ["INSTRUMENT_NOT_FOUND"],
            ),
          }
        : {}),
    };
  }

  let candidates: readonly MarketDiscoveryCandidate[];
  if (options.symbol !== undefined) {
    candidates = targetCandidate === undefined ? [] : [targetCandidate];
  } else {
    const topRows = [...eligible]
      .sort(compareTurnoverSpreadSymbol)
      .slice(0, options.resultLimit ?? DEFAULT_MARKET_DISCOVERY_RESULT_LIMIT);
    candidates = Object.freeze(topRows.map(candidateFor));
  }

  return Object.freeze({
    status: candidates.length > 0 ? "READY" : "NO_CANDIDATES",
    candidates,
    matchedCount,
    eligibleCount: eligible.length,
    exclusionCounts: Object.freeze({ ...exclusionCounts }),
    ...(target === undefined ? {} : { target }),
  });
}
