import type {
  FundingObservation,
  MarketSeriesInterval,
  OhlcvObservation,
  OhlcvSeries,
  OpenInterestInterval,
  OpenInterestObservation,
  OpenInterestSeries,
} from "./market-evidence-bundle.js";
import { type UtcTimestamp } from "../shared/time.js";
import {
  fundingIntervalMilliseconds,
  MARKET_FUNDING_WINDOW,
  MARKET_OHLCV_WINDOWS,
  MARKET_OPEN_INTEREST_WINDOWS,
  marketIntervalMilliseconds,
} from "./market-evidence-windows.js";

export {
  MARKET_FUNDING_WINDOW,
  MARKET_OHLCV_WINDOWS,
  MARKET_OPEN_INTEREST_WINDOWS,
} from "./market-evidence-windows.js";

export interface NormalizationResult<T> {
  readonly value: T;
  readonly complete: boolean;
  readonly reason?:
    "underfilled" | "duplicate" | "gap" | "future" | "unfinished";
  readonly latestTimestamp?: UtcTimestamp;
}

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

const BYBIT_WEEK_START_MS = Date.parse("1970-01-05T00:00:00.000Z");

function intervalBucket(
  value: UtcTimestamp,
  interval: MarketSeriesInterval,
): number {
  const timestamp = Date.parse(value);
  const size = marketIntervalMilliseconds(interval);
  return interval === "1w"
    ? Math.floor((timestamp - BYBIT_WEEK_START_MS) / size)
    : Math.floor(timestamp / size);
}

function sortedUnique<T extends { timestamp: UtcTimestamp }>(
  observations: readonly T[],
): { readonly values: readonly T[]; readonly duplicate: boolean } {
  const sorted = [...observations].sort(
    (left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp),
  );
  const values: T[] = [];
  let duplicate = false;
  for (const observation of sorted) {
    const previous = values.at(-1);
    if (
      previous !== undefined &&
      Date.parse(previous.timestamp) === Date.parse(observation.timestamp)
    ) {
      duplicate = true;
      continue;
    }
    values.push(observation);
  }
  return { values: Object.freeze(values), duplicate };
}

export function intervalBoundaryCrossed(
  first: UtcTimestamp,
  second: UtcTimestamp,
  interval: MarketSeriesInterval,
): boolean {
  return intervalBucket(first, interval) !== intervalBucket(second, interval);
}

export function fundingBoundaryCrossed(
  first: UtcTimestamp,
  second: UtcTimestamp,
  fundingIntervalMinutes: number,
): boolean {
  if (
    !Number.isSafeInteger(fundingIntervalMinutes) ||
    fundingIntervalMinutes < 1
  ) {
    return true;
  }
  const size = fundingIntervalMilliseconds(fundingIntervalMinutes);
  return (
    Math.floor(Date.parse(first) / size) !==
    Math.floor(Date.parse(second) / size)
  );
}

export function normalizeOhlcvSeries(
  interval: MarketSeriesInterval,
  observations: readonly OhlcvObservation[],
  cutoff: UtcTimestamp,
  requestedCount = MARKET_OHLCV_WINDOWS[interval],
): NormalizationResult<OhlcvSeries> {
  const cutoffMs = Date.parse(cutoff);
  const filtered = observations.filter((observation) => {
    const start = Date.parse(observation.timestamp);
    return (
      start <= cutoffMs &&
      observation.closed &&
      start + marketIntervalMilliseconds(interval) <= cutoffMs
    );
  });
  const unique = sortedUnique(filtered);
  const selected = unique.values.slice(-requestedCount);
  const latestTimestamp = selected.at(-1)?.timestamp;
  const reason = unique.duplicate
    ? "duplicate"
    : selected.length === requestedCount &&
        !hasExpectedCadence(selected, marketIntervalMilliseconds(interval))
      ? "gap"
      : selected.length < requestedCount
        ? filtered.some((item) => !item.closed) ||
          observations.some(
            (item) => !item.closed && Date.parse(item.timestamp) <= cutoffMs,
          ) ||
          observations.some((item) => Date.parse(item.timestamp) > cutoffMs)
          ? "unfinished"
          : "underfilled"
        : undefined;
  return {
    value: Object.freeze({
      interval,
      observations: Object.freeze(selected),
    }),
    complete:
      !unique.duplicate &&
      selected.length === requestedCount &&
      hasExpectedCadence(selected, marketIntervalMilliseconds(interval)),
    ...(reason === undefined ? {} : { reason }),
    ...(latestTimestamp === undefined ? {} : { latestTimestamp }),
  };
}

export function normalizeFundingObservations(
  observations: readonly FundingObservation[],
  cutoff: UtcTimestamp,
  requestedCount = MARKET_FUNDING_WINDOW,
  fundingIntervalMinutes?: number,
): NormalizationResult<readonly FundingObservation[]> {
  const cutoffMs = Date.parse(cutoff);
  const filtered = observations.filter(
    (observation) => Date.parse(observation.timestamp) <= cutoffMs,
  );
  const unique = sortedUnique(filtered);
  const selected = Object.freeze(unique.values.slice(-requestedCount));
  const latestTimestamp = selected.at(-1)?.timestamp;
  const reason = unique.duplicate
    ? "duplicate"
    : selected.length === requestedCount &&
        fundingIntervalMinutes !== undefined &&
        !hasExpectedCadence(
          selected,
          fundingIntervalMilliseconds(fundingIntervalMinutes),
        )
      ? "gap"
      : selected.length < requestedCount
        ? "underfilled"
        : undefined;
  return {
    value: selected,
    complete:
      !unique.duplicate &&
      selected.length === requestedCount &&
      (fundingIntervalMinutes === undefined ||
        hasExpectedCadence(
          selected,
          fundingIntervalMilliseconds(fundingIntervalMinutes),
        )),
    ...(reason === undefined ? {} : { reason }),
    ...(latestTimestamp === undefined ? {} : { latestTimestamp }),
  };
}

export function normalizeOpenInterestSeries(
  interval: OpenInterestInterval,
  observations: readonly OpenInterestObservation[],
  cutoff: UtcTimestamp,
  requestedCount = MARKET_OPEN_INTEREST_WINDOWS[interval],
): NormalizationResult<OpenInterestSeries> {
  const cutoffMs = Date.parse(cutoff);
  const filtered = observations.filter(
    (observation) => Date.parse(observation.timestamp) <= cutoffMs,
  );
  const unique = sortedUnique(filtered);
  const selected = unique.values.slice(-requestedCount);
  const latestTimestamp = selected.at(-1)?.timestamp;
  const reason = unique.duplicate
    ? "duplicate"
    : selected.length === requestedCount &&
        !hasExpectedCadence(selected, marketIntervalMilliseconds(interval))
      ? "gap"
      : selected.length < requestedCount
        ? "underfilled"
        : undefined;
  return {
    value: Object.freeze({
      interval,
      observations: Object.freeze(selected),
    }),
    complete:
      !unique.duplicate &&
      selected.length === requestedCount &&
      hasExpectedCadence(selected, marketIntervalMilliseconds(interval)),
    ...(reason === undefined ? {} : { reason }),
    ...(latestTimestamp === undefined ? {} : { latestTimestamp }),
  };
}
