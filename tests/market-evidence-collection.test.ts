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
import { hashCanonical } from "../src/domain/identity/canonical-serialization.js";
import { fixedClock, type UtcTimestamp } from "../src/domain/shared/time.js";
import { DecimalValue } from "../src/domain/shared/decimal.js";

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

function decimal(value: string): DecimalValue {
  const parsed = DecimalValue.fromString(value);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("invalid decimal fixture");
  return parsed.value;
}

function readerFor(
  exchangeTimes: readonly UtcTimestamp[],
  options: {
    readonly fundingInterval?: number;
    readonly failMarketReads?: boolean;
    readonly failExchangeTimeReads?: readonly number[];
    readonly tickerObservedAt?: UtcTimestamp;
  } = {},
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
      if (options.failExchangeTimeReads?.includes(timeReads)) {
        throw new Error("fixture exchange-time failure");
      }
      return times.shift() ?? exchangeTimes.at(-1)!;
    },
    async readInstrument(symbol) {
      calls.push(`instrument:${symbol}`);
      if (options.failMarketReads) throw new Error("fixture market failure");
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
          priceTickSize: decimal("0.01"),
          quantityStep: decimal("1"),
          minQuantity: decimal("1"),
        },
        fundingInterval: options.fundingInterval ?? 480,
      };
    },
    async readTicker(symbol) {
      calls.push(`ticker:${symbol}`);
      if (options.failMarketReads) throw new Error("fixture market failure");
      return {
        observedAt: options.tickerObservedAt ?? exchangeTimes[0]!,
        bid: decimal("100"),
        ask: decimal("101"),
        last: decimal("100.5"),
      };
    },
    async readOhlcv(symbol, interval, count, exchangeTime) {
      calls.push(`ohlcv:${symbol}:${interval}`);
      if (options.failMarketReads) throw new Error("fixture market failure");
      const step = intervalMs[interval];
      const end = Date.parse(exchangeTime) - step;
      return Array.from({ length: count }, (_, index) => ({
        timestamp: timestamp(end - (count - 1 - index) * step),
        open: decimal("99"),
        high: decimal("102"),
        low: decimal("98"),
        close: decimal("100"),
        volume: decimal("10"),
        turnover: decimal("1000"),
        closed: true,
      }));
    },
    async readFunding(symbol, count) {
      calls.push(`funding:${symbol}`);
      if (options.failMarketReads) throw new Error("fixture market failure");
      const end = Date.parse(exchangeTimes[0]!) - 8 * 60 * 60 * 1_000;
      return Array.from({ length: count }, (_, index) => ({
        timestamp: timestamp(end - (count - 1 - index) * 8 * 60 * 60 * 1_000),
        rate: decimal("0.001"),
      }));
    },
    async readOpenInterest(symbol, interval, count) {
      calls.push(`oi:${symbol}:${interval}`);
      if (options.failMarketReads) throw new Error("fixture market failure");
      const step = intervalMs[interval];
      const end = Date.parse(exchangeTimes[0]!) - step;
      return Array.from({ length: count }, (_, index) => ({
        timestamp: timestamp(end - (count - 1 - index) * step),
        openInterest: decimal("100"),
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
  const contentHash = hashCanonical({
    runId: result.value.runId,
    schemaVersion: result.value.schemaVersion,
    producer: result.value.producer,
    universeVersion: result.value.universeVersion,
    universe: result.value.universe,
    collectionStartedAt: result.value.collectionStartedAt,
    collectionEndedAt: result.value.collectionEndedAt,
    bundleCutoff: result.value.bundleCutoff,
    source: result.value.source,
    status: result.value.status,
    symbols: result.value.symbols,
    diagnostics: result.value.diagnostics,
  });
  assert.equal(contentHash.ok, true);
  if (contentHash.ok) {
    assert.equal(result.value.evidence[0]?.contentHash, contentHash.value);
  }
});

test("local clock skew does not invalidate an exchange-time cutoff", async () => {
  const initial = "2026-09-22T10:00:01.000Z" as UtcTimestamp;
  const candidate = "2026-09-22T10:00:02.000Z" as UtcTimestamp;
  const clock = fixedClock("2026-09-22T10:00:10.000Z");
  assert.equal(clock.ok, true);
  if (!clock.ok) return;
  const result = await collectMarketEvidence(
    { runId: "run-clock-skew" },
    { reader: readerFor([initial, candidate]), clock: clock.value },
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.status, "complete");
});

test("exchange-time failures fail closed without inventing a third read", async () => {
  const clock = fixedClock("2026-09-22T10:00:00.000Z");
  assert.equal(clock.ok, true);
  if (!clock.ok) return;

  const initialFailureReader = readerFor(
    ["2026-09-22T10:00:01.000Z" as UtcTimestamp],
    { failExchangeTimeReads: [1] },
  );
  const initialFailure = await collectMarketEvidence(
    { runId: "run-initial-time-failure" },
    { reader: initialFailureReader, clock: clock.value },
  );
  assert.equal(initialFailure.ok, false);
  assert.equal(initialFailureReader.timeReads, 1);

  const candidateFailureReader = readerFor(
    ["2026-09-22T10:00:01.000Z", "2026-09-22T10:00:02.000Z"] as UtcTimestamp[],
    { failExchangeTimeReads: [2] },
  );
  const candidateFailure = await collectMarketEvidence(
    { runId: "run-candidate-time-failure" },
    { reader: candidateFailureReader, clock: clock.value },
  );
  assert.equal(candidateFailure.ok, true);
  if (candidateFailure.ok) {
    assert.equal(candidateFailure.value.status, "incomplete");
    assert.equal(
      candidateFailure.value.symbols[0]?.diagnostics[0]?.code,
      "exchange-time-failed",
    );
  }
  assert.equal(candidateFailureReader.timeReads, 2);
});

test("final cutoff failure and non-monotonic exchange time remain incomplete", async () => {
  const clock = fixedClock("2026-09-22T10:59:58.000Z");
  assert.equal(clock.ok, true);
  if (!clock.ok) return;

  const finalFailureReader = readerFor(
    [
      "2026-09-22T10:59:59.000Z",
      "2026-09-22T11:00:01.000Z",
      "2026-09-22T11:00:02.000Z",
    ] as UtcTimestamp[],
    { failExchangeTimeReads: [3] },
  );
  const finalFailure = await collectMarketEvidence(
    { runId: "run-final-time-failure" },
    { reader: finalFailureReader, clock: clock.value },
  );
  assert.equal(finalFailure.ok, true);
  if (finalFailure.ok) {
    assert.equal(finalFailure.value.status, "incomplete");
    assert.equal(
      finalFailure.value.symbols[0]?.diagnostics.some(
        (diagnostic) => diagnostic.code === "exchange-time-failed",
      ),
      true,
    );
  }
  assert.equal(finalFailureReader.timeReads, 3);

  const nonMonotonicReader = readerFor([
    "2026-09-22T10:00:02.000Z",
    "2026-09-22T10:00:01.000Z",
  ] as UtcTimestamp[]);
  const nonMonotonic = await collectMarketEvidence(
    { runId: "run-non-monotonic-time" },
    { reader: nonMonotonicReader, clock: clock.value },
  );
  assert.equal(nonMonotonic.ok, true);
  if (nonMonotonic.ok) {
    assert.equal(nonMonotonic.value.status, "incomplete");
    assert.equal(
      nonMonotonic.value.symbols[0]?.diagnostics.some(
        (diagnostic) => diagnostic.code === "non-monotonic-time",
      ),
      true,
    );
  }
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

test("a ticker newer than the selected cutoff remains incomplete evidence", async () => {
  const initial = "2026-09-22T10:00:01.000Z" as UtcTimestamp;
  const candidate = "2026-09-22T10:00:02.000Z" as UtcTimestamp;
  const futureTicker = "2026-09-22T10:00:03.000Z" as UtcTimestamp;
  const clock = fixedClock("2026-09-22T10:00:00.000Z");
  assert.equal(clock.ok, true);
  if (!clock.ok) return;
  const reader = readerFor([initial, candidate], {
    tickerObservedAt: futureTicker,
  });
  const result = await collectMarketEvidence(
    { runId: "run-future-ticker" },
    { reader, clock: clock.value },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.status, "incomplete");
  assert.equal(result.value.symbols[0]?.ticker, undefined);
  assert.equal(
    result.value.symbols[0]?.diagnostics.some(
      (diagnostic) => diagnostic.code === "future-observation",
    ),
    true,
  );
});

test("a collection with no usable market evidence returns a failed result", async () => {
  const initial = "2026-09-22T10:00:01.000Z" as UtcTimestamp;
  const candidate = "2026-09-22T10:00:02.000Z" as UtcTimestamp;
  const clock = fixedClock("2026-09-22T10:00:00.000Z");
  assert.equal(clock.ok, true);
  if (!clock.ok) return;
  const reader = readerFor([initial, candidate], { failMarketReads: true });
  const result = await collectMarketEvidence(
    { runId: "run-no-evidence" },
    { reader, clock: clock.value },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "UNRESOLVED_STATE");
  assert.equal(reader.timeReads, 2);
  assert.equal(reader.calls.length, MARKET_EVIDENCE_SYMBOLS.length * 10);
});
