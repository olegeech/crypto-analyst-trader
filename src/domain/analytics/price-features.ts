import type { AnalyticsOutputOutcome } from "./analytics-sufficiency.js";
import type {
  AnalyticsFeatureRequest,
  AnalyticsProfile,
} from "./analytics-profile.js";
import {
  normalizeAnalyticsReasonCodes,
  type AnalyticsReasonCode,
} from "./analytics-diagnostics.js";
import { type DecimalValue as Decimal } from "../shared/decimal.js";
import { marketIntervalMilliseconds } from "../market/market-evidence-windows.js";
import type {
  MarketEvidenceBundle,
  MarketSeriesInterval,
  OhlcvObservation,
} from "../market/market-evidence-bundle.js";
import {
  ANALYTICS_FEATURE_OUTPUT_SCALE,
  ANALYTICS_FEATURE_ROUNDING,
  analyticsDecimalConstant as decimalConstant,
} from "./analytics-numeric-policy.js";

const ONE = decimalConstant("1");
const HUNDRED = decimalConstant("100");

export type PriceFeatureKind =
  | "close-return"
  | "maximum-drawdown"
  | "atr"
  | "realized-volatility"
  | "volatility-comparison";

export interface PriceFeatureWindow {
  readonly from: OhlcvObservation["timestamp"];
  readonly to: OhlcvObservation["timestamp"];
  readonly observationCount: number;
}

export type PriceFeatureValue =
  | {
      readonly type: "close-return";
      readonly percent: Decimal;
      readonly unit: "percent";
    }
  | {
      readonly type: "maximum-drawdown";
      readonly percent: Decimal;
      readonly unit: "percent";
    }
  | {
      readonly type: "atr";
      readonly atr: Decimal;
      readonly normalizedPercent: Decimal;
      readonly unit: "price";
    }
  | {
      readonly type: "realized-volatility";
      readonly percent: Decimal;
      readonly unit: "percent";
    }
  | {
      readonly type: "volatility-comparison";
      readonly recentPercent: Decimal;
      readonly referencePercent: Decimal;
      readonly ratio: Decimal;
      readonly relation: "expansion" | "compression" | "unchanged";
    };

export interface PriceFeatureOutcome extends AnalyticsOutputOutcome {
  readonly kind: PriceFeatureKind;
  readonly symbol: string;
  readonly interval: MarketSeriesInterval;
  readonly window?: PriceFeatureWindow;
  readonly value?: PriceFeatureValue;
}

type PriceRequest = Extract<
  AnalyticsFeatureRequest,
  { readonly kind: PriceFeatureKind }
>;

type WindowSelection =
  | { readonly ok: true; readonly observations: readonly OhlcvObservation[] }
  | { readonly ok: false; readonly reason: AnalyticsReasonCode };

function isPositivePrice(value: Decimal): boolean {
  return value.isPositive();
}

function validateWindow(
  observations: readonly OhlcvObservation[],
  interval: MarketSeriesInterval,
): AnalyticsReasonCode | undefined {
  const stepMs = marketIntervalMilliseconds(interval);
  for (let index = 0; index < observations.length; index += 1) {
    const current = observations[index];
    const previous = observations[index - 1];
    if (current === undefined) return "INSUFFICIENT_WINDOW";
    if (
      !isPositivePrice(current.open) ||
      !isPositivePrice(current.high) ||
      !isPositivePrice(current.low) ||
      !isPositivePrice(current.close)
    ) {
      return "INVALID_MARKET_PRICE";
    }
    if (
      current.high.compare(current.low) < 0 ||
      current.high.compare(current.open) < 0 ||
      current.high.compare(current.close) < 0 ||
      current.low.compare(current.open) > 0 ||
      current.low.compare(current.close) > 0
    ) {
      return "INVALID_MARKET_PRICE";
    }
    if (
      previous !== undefined &&
      Date.parse(current.timestamp) - Date.parse(previous.timestamp) !== stepMs
    ) {
      return "INSUFFICIENT_WINDOW";
    }
  }
  return undefined;
}

function selectTrailingWindow(
  observations: readonly OhlcvObservation[],
  count: number,
  interval: MarketSeriesInterval,
): WindowSelection {
  if (observations.length < count)
    return { ok: false, reason: "INSUFFICIENT_WINDOW" };
  const selected = observations.slice(observations.length - count);
  const reason = validateWindow(selected, interval);
  return reason === undefined
    ? { ok: true, observations: selected }
    : { ok: false, reason };
}

function sourceWindow(
  observations: readonly OhlcvObservation[],
): PriceFeatureWindow {
  const first = observations[0];
  const last = observations[observations.length - 1];
  if (first === undefined || last === undefined) {
    throw new Error("a complete analytics window cannot be empty");
  }
  return Object.freeze({
    from: first.timestamp,
    to: last.timestamp,
    observationCount: observations.length,
  });
}

function makeUnavailable(
  request: PriceRequest,
  reason: AnalyticsReasonCode,
): PriceFeatureOutcome {
  return Object.freeze({
    requestId: request.id,
    status: "unavailable",
    reasonCodes: normalizeAnalyticsReasonCodes([reason]),
    kind: request.kind,
    symbol: request.symbol,
    interval: request.interval,
  });
}

function makeComplete(
  request: PriceRequest,
  observations: readonly OhlcvObservation[],
  value: PriceFeatureValue,
): PriceFeatureOutcome {
  return Object.freeze({
    requestId: request.id,
    status: "complete",
    reasonCodes: normalizeAnalyticsReasonCodes([]),
    kind: request.kind,
    symbol: request.symbol,
    interval: request.interval,
    window: sourceWindow(observations),
    value: Object.freeze(value),
  });
}

function closeFraction(
  current: Decimal,
  previous: Decimal,
): Decimal | undefined {
  if (!current.isPositive() || !previous.isPositive()) return undefined;
  const ratio = current.divide(
    previous,
    ANALYTICS_FEATURE_OUTPUT_SCALE,
    ANALYTICS_FEATURE_ROUNDING,
  );
  return ratio.ok ? ratio.value.subtract(ONE) : undefined;
}

function realizedVolatility(
  observations: readonly OhlcvObservation[],
): Decimal | undefined {
  let sumSquares = decimalConstant("0");
  for (let index = 1; index < observations.length; index += 1) {
    const current = observations[index];
    const previous = observations[index - 1];
    if (current === undefined || previous === undefined) return undefined;
    const fraction = closeFraction(current.close, previous.close);
    if (fraction === undefined) return undefined;
    sumSquares = sumSquares.add(fraction.multiply(fraction));
  }
  const root = sumSquares.squareRoot(
    ANALYTICS_FEATURE_OUTPUT_SCALE,
    ANALYTICS_FEATURE_ROUNDING,
  );
  return root.ok ? root.value.multiply(HUNDRED) : undefined;
}

function trueRange(current: OhlcvObservation, previousClose: Decimal): Decimal {
  const highLow = current.high.subtract(current.low);
  const highGap = absolute(current.high.subtract(previousClose));
  const lowGap = absolute(current.low.subtract(previousClose));
  return maximum(highLow, highGap, lowGap);
}

function absolute(value: Decimal): Decimal {
  return value.isNegative() ? value.multiply(decimalConstant("-1")) : value;
}

function maximum(...values: readonly Decimal[]): Decimal {
  let result = values[0];
  if (result === undefined) throw new Error("maximum requires a value");
  for (const value of values.slice(1)) {
    if (value.compare(result) > 0) result = value;
  }
  return result;
}

function computeAtr(
  observations: readonly OhlcvObservation[],
  period: number,
): Decimal | undefined {
  if (observations.length < period + 1) return undefined;
  const ranges: Decimal[] = [];
  for (let index = 1; index < observations.length; index += 1) {
    const current = observations[index];
    const previous = observations[index - 1];
    if (current === undefined || previous === undefined) return undefined;
    ranges.push(trueRange(current, previous.close));
  }
  if (ranges.length < period) return undefined;
  const periodValue = decimalConstant(String(period));
  let seed = decimalConstant("0");
  for (const range of ranges.slice(0, period)) seed = seed.add(range);
  const seeded = seed.divide(
    periodValue,
    ANALYTICS_FEATURE_OUTPUT_SCALE,
    ANALYTICS_FEATURE_ROUNDING,
  );
  if (!seeded.ok) return undefined;
  let atr = seeded.value;
  const previousWeight = decimalConstant(String(period - 1));
  for (const range of ranges.slice(period)) {
    const smoothed = atr
      .multiply(previousWeight)
      .add(range)
      .divide(
        periodValue,
        ANALYTICS_FEATURE_OUTPUT_SCALE,
        ANALYTICS_FEATURE_ROUNDING,
      );
    if (!smoothed.ok) return undefined;
    atr = smoothed.value;
  }
  return atr;
}

function asPercent(value: Decimal, denominator: Decimal): Decimal | undefined {
  if (!denominator.isPositive()) return undefined;
  const ratio = value.divide(
    denominator,
    ANALYTICS_FEATURE_OUTPUT_SCALE,
    ANALYTICS_FEATURE_ROUNDING,
  );
  return ratio.ok ? ratio.value.multiply(HUNDRED) : undefined;
}

function computeOne(
  request: PriceRequest,
  observations: readonly OhlcvObservation[],
): PriceFeatureOutcome {
  if (request.kind === "close-return") {
    const selection = selectTrailingWindow(
      observations,
      request.periods + 1,
      request.interval,
    );
    if (!selection.ok) return makeUnavailable(request, selection.reason);
    const selected = selection.observations;
    const previous = selected[0];
    const current = selected[selected.length - 1];
    if (previous === undefined || current === undefined) {
      return makeUnavailable(request, "INSUFFICIENT_WINDOW");
    }
    const fraction = closeFraction(current.close, previous.close);
    if (fraction === undefined)
      return makeUnavailable(request, "INVALID_MARKET_PRICE");
    return makeComplete(request, selected, {
      type: "close-return",
      percent: fraction.multiply(HUNDRED),
      unit: "percent",
    });
  }

  if (request.kind === "maximum-drawdown") {
    const selection = selectTrailingWindow(
      observations,
      request.observationCount,
      request.interval,
    );
    if (!selection.ok) return makeUnavailable(request, selection.reason);
    const selected = selection.observations;
    let peak = selected[0]?.close;
    if (peak === undefined)
      return makeUnavailable(request, "INSUFFICIENT_WINDOW");
    let maximumDrawdown = decimalConstant("0");
    for (const observation of selected) {
      if (observation.close.compare(peak) > 0) peak = observation.close;
      const drawdown = asPercent(peak.subtract(observation.close), peak);
      if (drawdown === undefined) {
        return makeUnavailable(request, "INVALID_MARKET_PRICE");
      }
      if (drawdown.compare(maximumDrawdown) > 0) maximumDrawdown = drawdown;
    }
    return makeComplete(request, selected, {
      type: "maximum-drawdown",
      percent: maximumDrawdown,
      unit: "percent",
    });
  }

  if (request.kind === "atr") {
    const reason = validateWindow(observations, request.interval);
    if (reason !== undefined) return makeUnavailable(request, reason);
    const atr = computeAtr(observations, request.period);
    const latest = observations[observations.length - 1];
    if (atr === undefined || latest === undefined) {
      return makeUnavailable(request, "INSUFFICIENT_WINDOW");
    }
    const normalizedPercent = asPercent(atr, latest.close);
    if (normalizedPercent === undefined) {
      return makeUnavailable(request, "INVALID_MARKET_PRICE");
    }
    return makeComplete(request, observations, {
      type: "atr",
      atr,
      normalizedPercent,
      unit: "price",
    });
  }

  if (request.kind === "realized-volatility") {
    const selection = selectTrailingWindow(
      observations,
      request.observationCount + 1,
      request.interval,
    );
    if (!selection.ok) return makeUnavailable(request, selection.reason);
    const volatility = realizedVolatility(selection.observations);
    if (volatility === undefined) {
      return makeUnavailable(request, "INVALID_MARKET_PRICE");
    }
    return makeComplete(request, selection.observations, {
      type: "realized-volatility",
      percent: volatility,
      unit: "percent",
    });
  }

  const returnIntervals =
    request.recentObservationCount + request.referenceObservationCount;
  const selection = selectTrailingWindow(
    observations,
    returnIntervals + 1,
    request.interval,
  );
  if (!selection.ok) return makeUnavailable(request, selection.reason);
  const candles = selection.observations;
  const splitIndex = request.referenceObservationCount + 1;
  const reference = realizedVolatility(candles.slice(0, splitIndex));
  const recent = realizedVolatility(candles.slice(splitIndex - 1));
  if (reference === undefined || recent === undefined) {
    return makeUnavailable(request, "INVALID_MARKET_PRICE");
  }
  if (reference.isZero()) {
    return makeUnavailable(request, "ZERO_VOLATILITY_REFERENCE");
  }
  const ratio = recent.divide(
    reference,
    ANALYTICS_FEATURE_OUTPUT_SCALE,
    ANALYTICS_FEATURE_ROUNDING,
  );
  if (!ratio.ok) return makeUnavailable(request, "ZERO_VOLATILITY_REFERENCE");
  const relation =
    recent.compare(reference) > 0
      ? "expansion"
      : recent.compare(reference) < 0
        ? "compression"
        : "unchanged";
  return makeComplete(request, candles, {
    type: "volatility-comparison",
    recentPercent: recent,
    referencePercent: reference,
    ratio: ratio.value,
    relation,
  });
}

function isPriceRequest(
  request: AnalyticsFeatureRequest,
): request is PriceRequest {
  return (
    request.kind === "close-return" ||
    request.kind === "maximum-drawdown" ||
    request.kind === "atr" ||
    request.kind === "realized-volatility" ||
    request.kind === "volatility-comparison"
  );
}

export function computePriceFeatures(
  market: MarketEvidenceBundle,
  profile: AnalyticsProfile,
): readonly PriceFeatureOutcome[] {
  const seriesBySymbol = new Map<
    string,
    Map<MarketSeriesInterval, readonly OhlcvObservation[]>
  >();
  const closedBySymbol = new Map<
    string,
    Map<MarketSeriesInterval, readonly OhlcvObservation[]>
  >();
  for (const symbol of market.symbols) {
    const series = new Map<MarketSeriesInterval, readonly OhlcvObservation[]>();
    for (const item of symbol.ohlcv)
      series.set(item.interval, item.observations);
    seriesBySymbol.set(symbol.symbol, series);
  }
  const outcomes = profile.features.flatMap((request) => {
    if (!isPriceRequest(request)) return [];
    const source = seriesBySymbol.get(request.symbol)?.get(request.interval);
    if (source === undefined) {
      return [makeUnavailable(request, "INSUFFICIENT_WINDOW")];
    }
    let closed = closedBySymbol.get(request.symbol);
    if (closed === undefined) {
      closed = new Map();
      closedBySymbol.set(request.symbol, closed);
    }
    let observations = closed.get(request.interval);
    if (observations === undefined) {
      observations = source.filter((observation) => observation.closed);
      closed.set(request.interval, observations);
    }
    return [computeOne(request, observations)];
  });
  return Object.freeze(outcomes);
}
