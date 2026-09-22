import assert from "node:assert/strict";
import test from "node:test";

import {
  collectMarketEvidence,
  type MarketEvidenceCollectionReader,
} from "../src/application/market-evidence-collection.js";
import {
  MARKET_EVIDENCE_SYMBOLS,
  type MarketSeriesInterval,
  type OpenInterestInterval,
} from "../src/domain/market/market-evidence-bundle.js";
import {
  MARKET_OHLCV_WINDOWS,
  MARKET_OPEN_INTEREST_WINDOWS,
} from "../src/domain/market/market-series-normalization.js";
import { fixedClock, type UtcTimestamp } from "../src/domain/shared/time.js";

const intervalMs: Record<MarketSeriesInterval | OpenInterestInterval, number> =
  {
    "1h": 60 * 60 * 1_000,
    "4h": 4 * 60 * 60 * 1_000,
    "1d": 24 * 60 * 60 * 1_000,
    "1w": 7 * 24 * 60 * 60 * 1_000,
  };

function timestamp(epoch: number): UtcTimestamp {
  return new Date(epoch).toISOString() as UtcTimestamp;
}

function decimal(value: string) {
  return value;
}

function readerFor(
  exchangeTimes: readonly UtcTimestamp[],
  options: { readonly fundingInterval?: number } = {},
): MarketEvidenceCollectionReader & {
  readonly calls: string[];
  readonly timeReads: number;
} {
  const times = [...exchangeTimes];
  const calls: string[] = [];
  let timeReads = 0;
  const reader: MarketEvidenceCollectionReader & {
    readonly calls: string[];
    readonly timeReads: number;
  } = {
    calls,
    get timeReads() {
      return timeReads;
    },
    async readExchangeTime() {
      timeReads += 1;
      return times.shift() ?? exchangeTimes.at(-1)!;
    },
    async readInstrument(symbol) {
      calls.push(`instrument:${symbol}`);
      return {
        symbol,
        status: "trading",
        contractType: "LinearPerpetual",
        baseCoin: symbol.replace("USDT", ""),
        quoteCoin: "USDT",
        settleCoin: "USDT",
        constraints: {
          instrument: symbol,
          version: "instrument-constraints/v1",
          priceTickSize: decimal("0.01") as never,
          quantityStep: decimal("1") as never,
          minQuantity: decimal("1") as never,
        },
        fundingInterval: options.fundingInterval ?? 480,
      } as never;
    },
    async readTicker(symbol) {
      calls.push(`ticker:${symbol}`);
      return {
        observedAt: exchangeTimes[0]!,
        bid: decimal("100") as never,
        ask: decimal("101") as never,
        last: decimal("100.5") as never,
      } as never;
    },
    async readOhlcv(symbol, interval, count, exchangeTime) {
      calls.push(`ohlcv:${symbol}:${interval}`);
      const step = intervalMs[interval];
      const end = Date.parse(exchangeTime) - step;
      return Array.from({ length: count }, (_, index) => ({
        timestamp: timestamp(end - (count - 1 - index) * step),
        open: decimal("99") as never,
        high: decimal("102") as never,
        low: decimal("98") as never,
        close: decimal("100") as never,
        volume: decimal("10") as never,
        turnover: decimal("1000") as never,
        closed: true,
      }));
    },
    async readFunding(symbol, count) {
      calls.push(`funding:${symbol}`);
      const end = Date.parse(exchangeTimes[0]!) - 8 * 60 * 60 * 1_000;
      return Array.from({ length: count }, (_, index) => ({
        timestamp: timestamp(end - (count - 1 - index) * 8 * 60 * 60 * 1_000),
        rate: decimal("0.001") as never,
      }));
    },
    async readOpenInterest(symbol, interval, count) {
      calls.push(`oi:${symbol}:${interval}`);
      const step = intervalMs[interval];
      const end = Date.parse(exchangeTimes[0]!) - step;
      return Array.from({ length: count }, (_, index) => ({
        timestamp: timestamp(end - (count - 1 - index) * step),
        openInterest: decimal("100") as never,
      }));
    },
  };
  return reader;
}

test("happy path uses candidate exchange time without an unconditional third time read", async () => {
  const initial = "2026-09-22T10:00:01.000Z" as UtcTimestamp;
  const candidate = "2026-09-22T10:00:02.000Z" as UtcTimestamp;
  const clock = fixedClock("2026-09-22T10:00:00.000Z");
  assert.equal(clock.ok, true);
  if (!clock.ok) return;
  const reader = readerFor([initial, candidate]);
  const result = await collectMarketEvidence(
    { runId: "run-happy" },
    { reader, clock: clock.value },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.status, "complete");
  assert.equal(result.value.bundleCutoff, candidate);
  assert.equal(reader.timeReads, 2);
  assert.deepEqual(result.value.universe, [...MARKET_EVIDENCE_SYMBOLS]);
  assert.equal(
    result.value.symbols[0]?.openInterest[0]?.observations.length,
    MARKET_OPEN_INTEREST_WINDOWS["1h"],
  );
});

test("crossing an OHLCV boundary rereads affected series once and reads one final cutoff", async () => {
  const initial = "2026-09-22T10:59:59.000Z" as UtcTimestamp;
  const candidate = "2026-09-22T11:00:01.000Z" as UtcTimestamp;
  const final = "2026-09-22T11:00:02.000Z" as UtcTimestamp;
  const clock = fixedClock("2026-09-22T10:59:58.000Z");
  assert.equal(clock.ok, true);
  if (!clock.ok) return;
  const reader = readerFor([initial, candidate, final]);
  const result = await collectMarketEvidence(
    { runId: "run-boundary" },
    { reader, clock: clock.value },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.status, "complete");
  assert.equal(reader.timeReads, 3);
  assert.equal(
    reader.calls.filter((call) => call.startsWith("ohlcv:")).length,
    20,
  );
  assert.equal(
    reader.calls.filter((call) => call.startsWith("oi:")).length,
    MARKET_EVIDENCE_SYMBOLS.length * 3,
  );
});

test("OI provider lag remains valid freshness input when the bounded requested window is present", async () => {
  const initial = "2026-09-22T10:00:01.000Z" as UtcTimestamp;
  const candidate = "2026-09-22T10:00:02.000Z" as UtcTimestamp;
  const clock = fixedClock("2026-09-22T10:00:00.000Z");
  assert.equal(clock.ok, true);
  if (!clock.ok) return;
  const reader = readerFor([initial, candidate]);
  const result = await collectMarketEvidence(
    { runId: "run-oi-lag" },
    { reader, clock: clock.value },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.status, "complete");
  assert.equal(reader.timeReads, 2);
  assert.equal(
    result.value.symbols[0]?.ohlcv[0]?.observations.length,
    MARKET_OHLCV_WINDOWS["1h"],
  );
});
