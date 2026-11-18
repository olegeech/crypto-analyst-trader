import { DecimalValue, RoundingMode } from "../shared/decimal.js";
import type { UtcTimestamp } from "../shared/time.js";

export interface MarketDiscoveryInstrument {
  readonly symbol?: string;
  readonly status?: string;
  readonly contractType?: string;
  readonly quoteCoin?: string;
  readonly settleCoin?: string;
  readonly baseCoin?: string;
  readonly symbolType?: string;
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
  | "CROSSED_QUOTES";

export interface MarketDiscoveryCandidate {
  readonly symbol: string;
  readonly exposureGroup: string;
  readonly referenceSession: string;
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
  readonly duplicateCount: number;
  readonly representativeRule: string;
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
  readonly baseCoin?: string;
  readonly symbolType?: string;
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
      ...(instrument.baseCoin === undefined
        ? {}
        : { baseCoin: instrument.baseCoin }),
      ...(instrument.symbolType === undefined
        ? {}
        : { symbolType: instrument.symbolType }),
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

function exposureGroupFor(row: EligibleMarketRow): string {
  const base = row.baseCoin;
  if (base === undefined || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(base))
    return `symbol:${row.symbol}`;
  return ["XAU", "PAXG", "XAUT"].includes(base) ? "GOLD" : `base:${base}`;
}

function candidateFor(
  row: EligibleMarketRow,
  asOf: UtcTimestamp,
): MarketDiscoveryCandidate {
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

  const exposureGroup = exposureGroupFor(row);
  const candidate: MarketDiscoveryCandidate = Object.freeze({
    symbol: row.symbol,
    exposureGroup,
    referenceSession:
      [0, 6].includes(new Date(asOf).getUTCDay()) &&
      (exposureGroup === "GOLD" ||
        ["commodity", "stock", "forex", "ETF", "xstocks", "mstocks"].includes(
          row.symbolType ?? "",
        ))
        ? "possible reference closure (usual weekend)"
        : "session unknown",
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
    const row = eligible[0];
    targetCandidate =
      row === undefined ? undefined : candidateFor(row, snapshot.asOf);
    target = {
      symbol: options.symbol,
      ...(targetCandidate === undefined ? {} : { candidate: targetCandidate }),
      ...(row === undefined && targetExclusionReasons !== undefined
        ? { reasons: Object.freeze(targetExclusionReasons) }
        : {}),
    };
  }

  let candidates: readonly MarketDiscoveryCandidate[];
  let duplicateCount = 0;
  if (options.symbol !== undefined) {
    candidates = targetCandidate === undefined ? [] : [targetCandidate];
  } else {
    const representatives = new Map<string, EligibleMarketRow>();
    for (const row of [...eligible].sort(compareTurnoverSpreadSymbol)) {
      const group = exposureGroupFor(row);
      if (!representatives.has(group)) representatives.set(group, row);
    }
    duplicateCount = eligible.length - representatives.size;
    const topRows = [...representatives.values()].slice(
      0,
      options.resultLimit ?? DEFAULT_MARKET_DISCOVERY_RESULT_LIMIT,
    );
    candidates = Object.freeze(
      topRows.map((row) => candidateFor(row, snapshot.asOf)),
    );
  }

  return Object.freeze({
    status: candidates.length > 0 ? "READY" : "NO_CANDIDATES",
    candidates,
    matchedCount,
    eligibleCount: eligible.length,
    duplicateCount,
    representativeRule:
      "highest 24h turnover per known exposure; relative spread then symbol break ties",
    exclusionCounts: Object.freeze({ ...exclusionCounts }),
    ...(target === undefined ? {} : { target }),
  });
}

export interface MarketDiscoveryOrderbook {
  readonly asOf: UtcTimestamp;
  readonly bids: readonly (readonly [DecimalValue, DecimalValue])[];
  readonly asks: readonly (readonly [DecimalValue, DecimalValue])[];
}

export type MarketDiscoveryBookEstimate =
  | { readonly status: "unavailable" }
  | {
      readonly status: "insufficient";
      readonly asOf: UtcTimestamp;
      readonly availableAskNotional: DecimalValue;
    }
  | {
      readonly status: "available";
      readonly asOf: UtcTimestamp;
      readonly availableAskNotional: DecimalValue;
      readonly estimatedBuyCostBps: DecimalValue;
    };

function validBookSide(
  levels: readonly (readonly [DecimalValue, DecimalValue])[],
  direction: "ascending" | "descending",
): boolean {
  return (
    levels.length > 0 &&
    levels.every(([price, size], index) => {
      if (!price.isPositive() || !size.isPositive()) return false;
      const previous = levels[index - 1];
      return (
        previous === undefined ||
        (direction === "ascending"
          ? price.compare(previous[0]) > 0
          : price.compare(previous[0]) < 0)
      );
    })
  );
}

/** Point-in-time 100-USDT buy estimate, excluding fees and RPI liquidity. */
export function estimateMarketDiscoveryBuyCost(
  book: MarketDiscoveryOrderbook,
): MarketDiscoveryBookEstimate {
  if (
    !validBookSide(book.asks, "ascending") ||
    !validBookSide(book.bids, "descending") ||
    book.bids[0]![0].compare(book.asks[0]![0]) > 0
  )
    return { status: "unavailable" };

  const zero = constant("0");
  const availableAskNotional = book.asks.reduce(
    (sum, [price, size]) => sum.add(price.multiply(size)),
    zero,
  );
  const context = { asOf: book.asOf, availableAskNotional };
  if (availableAskNotional.compare(ONE_HUNDRED) < 0)
    return { status: "insufficient", ...context };

  let remaining = ONE_HUNDRED;
  let acquired = zero;
  for (const [price, size] of book.asks) {
    const levelNotional = price.multiply(size);
    if (levelNotional.compare(remaining) <= 0) {
      acquired = acquired.add(size);
      remaining = remaining.subtract(levelNotional);
    } else {
      const partialSize = remaining.divide(price, 36, RoundingMode.DOWN);
      if (!partialSize.ok) return { status: "unavailable" };
      acquired = acquired.add(partialSize.value);
      remaining = zero;
    }
    if (remaining.isZero()) break;
  }
  const vwap = ONE_HUNDRED.divide(acquired, 36, RoundingMode.HALF_UP);
  const midpoint = book.bids[0]![0].add(book.asks[0]![0]).divide(
    TWO,
    36,
    RoundingMode.HALF_UP,
  );
  if (!vwap.ok || !midpoint.ok) return { status: "unavailable" };
  const relativeCost = vwap.value
    .subtract(midpoint.value)
    .divide(midpoint.value, 36, RoundingMode.HALF_UP);
  if (!relativeCost.ok) return { status: "unavailable" };
  return {
    status: "available",
    ...context,
    estimatedBuyCostBps: relativeCost.value.multiply(constant("10000")),
  };
}
