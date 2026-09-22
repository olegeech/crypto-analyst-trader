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

export const MARKET_OHLCV_WINDOWS: Readonly<
  Record<MarketSeriesInterval, number>
> = Object.freeze({
  "1h": 250,
  "4h": 250,
  "1d": 250,
  "1w": 104,
});

export const MARKET_FUNDING_WINDOW = 30;

export const MARKET_OPEN_INTEREST_WINDOWS: Readonly<
  Record<OpenInterestInterval, number>
> = Object.freeze({
  "1h": 168,
  "4h": 180,
  "1d": 90,
});

export interface NormalizationResult<T> {
  readonly value: T;
  readonly complete: boolean;
  readonly reason?: "underfilled" | "duplicate" | "future" | "unfinished";
  readonly latestTimestamp?: UtcTimestamp;
}

function intervalMilliseconds(interval: MarketSeriesInterval): number {
  switch (interval) {
    case "1h":
      return 60 * 60 * 1_000;
    case "4h":
      return 4 * 60 * 60 * 1_000;
    case "1d":
      return 24 * 60 * 60 * 1_000;
    case "1w":
      return 7 * 24 * 60 * 60 * 1_000;
  }
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
    if (previous?.timestamp === observation.timestamp) {
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
  const size = intervalMilliseconds(interval);
  return (
    Math.floor(Date.parse(first) / size) !==
    Math.floor(Date.parse(second) / size)
  );
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
  const size = fundingIntervalMinutes * 60 * 1_000;
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
      start + intervalMilliseconds(interval) <= cutoffMs
    );
  });
  const unique = sortedUnique(filtered);
  const selected = unique.values.slice(-requestedCount);
  const latestTimestamp = selected.at(-1)?.timestamp;
  const reason = unique.duplicate
    ? "duplicate"
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
    complete: !unique.duplicate && selected.length === requestedCount,
    ...(reason === undefined ? {} : { reason }),
    ...(latestTimestamp === undefined ? {} : { latestTimestamp }),
  };
}

export function normalizeFundingObservations(
  observations: readonly FundingObservation[],
  cutoff: UtcTimestamp,
  requestedCount = MARKET_FUNDING_WINDOW,
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
    : selected.length < requestedCount
      ? "underfilled"
      : undefined;
  return {
    value: selected,
    complete: !unique.duplicate && selected.length === requestedCount,
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
    : selected.length < requestedCount
      ? "underfilled"
      : undefined;
  return {
    value: Object.freeze({
      interval,
      observations: Object.freeze(selected),
    }),
    complete: !unique.duplicate && selected.length === requestedCount,
    ...(reason === undefined ? {} : { reason }),
    ...(latestTimestamp === undefined ? {} : { latestTimestamp }),
  };
}
