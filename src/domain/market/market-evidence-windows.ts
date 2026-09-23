import type {
  MarketSeriesInterval,
  OpenInterestInterval,
} from "./market-evidence-bundle.js";

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

export function marketIntervalMilliseconds(
  interval: MarketSeriesInterval | OpenInterestInterval,
): number {
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

export function fundingIntervalMilliseconds(minutes: number): number {
  return minutes * 60 * 1_000;
}
