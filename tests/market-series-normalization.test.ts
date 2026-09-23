import assert from "node:assert/strict";
import test from "node:test";

import {
  fundingBoundaryCrossed,
  intervalBoundaryCrossed,
  normalizeFundingObservations,
  normalizeOhlcvSeries,
  normalizeOpenInterestSeries,
} from "../src/domain/market/market-series-normalization.js";
import type {
  FundingObservation,
  OhlcvObservation,
  OpenInterestObservation,
} from "../src/domain/market/market-evidence-bundle.js";
import type { UtcTimestamp } from "../src/domain/shared/time.js";
import { DecimalValue } from "../src/domain/shared/decimal.js";

function decimal(value: string) {
  const result = DecimalValue.fromString(value);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("fixture");
  return result.value;
}

function candle(timestamp: string, closed = true): OhlcvObservation {
  return {
    timestamp: timestamp as UtcTimestamp,
    open: decimal("10"),
    high: decimal("11"),
    low: decimal("9"),
    close: decimal("10"),
    volume: decimal("1"),
    turnover: decimal("10"),
    closed,
  };
}

test("normalization filters unfinished/future candles and preserves chronological windows", () => {
  const result = normalizeOhlcvSeries(
    "1h",
    [
      candle("2026-09-22T10:00:00Z"),
      candle("2026-09-22T11:00:00Z", false),
      candle("2026-09-22T12:00:00Z"),
    ],
    "2026-09-22T12:30:00.000Z" as UtcTimestamp,
    2,
  );
  assert.equal(result.complete, false);
  assert.equal(result.reason, "unfinished");
  assert.deepEqual(
    result.value.observations.map((item) => item.timestamp),
    ["2026-09-22T10:00:00Z"],
  );
});

test("funding and OI normalization accept delayed latest observations at a common cutoff", () => {
  const funding: FundingObservation[] = [
    {
      timestamp: "2026-09-22T08:00:00.000Z" as UtcTimestamp,
      rate: decimal("0.001"),
    },
    {
      timestamp: "2026-09-22T09:00:00.000Z" as UtcTimestamp,
      rate: decimal("0.002"),
    },
  ];
  const oi: OpenInterestObservation[] = [
    {
      timestamp: "2026-09-22T08:00:00.000Z" as UtcTimestamp,
      openInterest: decimal("10"),
    },
    {
      timestamp: "2026-09-22T09:00:00.000Z" as UtcTimestamp,
      openInterest: decimal("11"),
    },
  ];
  const fundingResult = normalizeFundingObservations(
    funding,
    "2026-09-22T10:00:00.000Z" as UtcTimestamp,
    2,
  );
  const oiResult = normalizeOpenInterestSeries(
    "1h",
    oi,
    "2026-09-22T10:00:00.000Z" as UtcTimestamp,
    2,
  );
  assert.equal(fundingResult.complete, true);
  assert.equal(oiResult.complete, true);
  assert.equal(oiResult.latestTimestamp, "2026-09-22T09:00:00.000Z");
});

test("normalization rejects cadence gaps even when the row count is full", () => {
  const candles = [
    candle("2026-09-22T06:00:00.000Z"),
    candle("2026-09-22T08:00:00.000Z"),
  ];
  const result = normalizeOhlcvSeries(
    "1h",
    candles,
    "2026-09-22T10:00:00.000Z" as UtcTimestamp,
    2,
  );
  assert.equal(result.complete, false);
  assert.equal(result.reason, "gap");

  const fundingResult = normalizeFundingObservations(
    [
      {
        timestamp: "2026-09-22T00:00:00.000Z" as UtcTimestamp,
        rate: decimal("0.001"),
      },
      {
        timestamp: "2026-09-22T16:00:00.000Z" as UtcTimestamp,
        rate: decimal("0.002"),
      },
    ],
    "2026-09-22T20:00:00.000Z" as UtcTimestamp,
    2,
    480,
  );
  assert.equal(fundingResult.complete, false);
  assert.equal(fundingResult.reason, "gap");
});

test("boundary detection is cadence-specific and deterministic", () => {
  assert.equal(
    intervalBoundaryCrossed(
      "2026-09-22T10:59:59.000Z" as UtcTimestamp,
      "2026-09-22T11:00:01.000Z" as UtcTimestamp,
      "1h",
    ),
    true,
  );
  assert.equal(
    intervalBoundaryCrossed(
      "2026-09-22T10:01:00.000Z" as UtcTimestamp,
      "2026-09-22T10:30:00.000Z" as UtcTimestamp,
      "1h",
    ),
    false,
  );
  assert.equal(
    intervalBoundaryCrossed(
      "2026-09-20T23:59:59.000Z" as UtcTimestamp,
      "2026-09-21T00:00:01.000Z" as UtcTimestamp,
      "1w",
    ),
    true,
  );
  assert.equal(
    fundingBoundaryCrossed(
      "2026-09-22T07:59:59.000Z" as UtcTimestamp,
      "2026-09-22T08:00:01.000Z" as UtcTimestamp,
      480,
    ),
    true,
  );
});
