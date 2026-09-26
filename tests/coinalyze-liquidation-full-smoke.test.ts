import assert from "node:assert/strict";
import test from "node:test";

import { runCoinalyzeLiquidationFullSmoke } from "../scripts/coinalyze-liquidation-full-smoke.js";
import type { CoinalyzeTransportPort } from "../src/adapters/coinalyze/coinalyze-client.js";
import type { MarketEvidenceCollectionReader } from "../src/application/market-evidence-collection.js";
import {
  type MarketSeriesInterval,
  type OpenInterestInterval,
} from "../src/domain/market/market-evidence-bundle.js";
import { LIQUIDATION_HISTORY_BUCKETS } from "../src/domain/liquidation/liquidation-evidence-bundle.js";
import { DecimalValue } from "../src/domain/shared/decimal.js";
import { fixedClock, type UtcTimestamp } from "../src/domain/shared/time.js";
import type { CoinalyzeHistoryRequest } from "../src/ports/coinalyze-liquidation-data.js";
import type { SecretProvider } from "../src/ports/secret-provider.js";

const API_KEY = "full-smoke-secret-sentinel";
const EXCHANGE_TIME = "2026-09-26T12:30:00.000Z" as UtcTimestamp;
const intervalMs: Record<MarketSeriesInterval | OpenInterestInterval, number> =
  {
    "1h": 60 * 60 * 1_000,
    "4h": 4 * 60 * 60 * 1_000,
    "1d": 24 * 60 * 60 * 1_000,
    "1w": 7 * 24 * 60 * 60 * 1_000,
  };

function decimal(value: string): DecimalValue {
  const parsed = DecimalValue.fromString(value);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("invalid decimal fixture");
  return parsed.value;
}

function timestamp(epoch: number): UtcTimestamp {
  return new Date(epoch).toISOString() as UtcTimestamp;
}

function marketEvidenceReader(): MarketEvidenceCollectionReader {
  const timeReads = [EXCHANGE_TIME, EXCHANGE_TIME];
  return {
    async readExchangeTime() {
      return timeReads.shift() ?? EXCHANGE_TIME;
    },
    async readInstrument(symbol) {
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
        fundingInterval: 480,
      };
    },
    async readTicker() {
      return {
        observedAt: EXCHANGE_TIME,
        bid: decimal("100"),
        ask: decimal("101"),
        last: decimal("100.5"),
      };
    },
    async readOhlcv(_symbol, interval, count, exchangeTime) {
      const step = intervalMs[interval];
      const end = Date.parse(exchangeTime) - step;
      return Array.from({ length: count }, (_, index) => ({
        timestamp: timestamp(end - (count - index - 1) * step),
        open: decimal("99"),
        high: decimal("102"),
        low: decimal("98"),
        close: decimal("100"),
        volume: decimal("10"),
        turnover: decimal("1000"),
        closed: true,
      }));
    },
    async readFunding(_symbol, count) {
      const step = 8 * 60 * 60 * 1_000;
      const end = Date.parse(EXCHANGE_TIME) - step;
      return Array.from({ length: count }, (_, index) => ({
        timestamp: timestamp(end - (count - index - 1) * step),
        rate: decimal("0.001"),
      }));
    },
    async readOpenInterest(_symbol, interval, count) {
      const step = intervalMs[interval];
      const end = Date.parse(EXCHANGE_TIME) - step;
      return Array.from({ length: count }, (_, index) => ({
        timestamp: timestamp(end - (count - index - 1) * step),
        openInterest: decimal("100"),
      }));
    },
  };
}

function catalogue(): readonly Record<string, unknown>[] {
  return ["BTC", "ETH", "SOL", "DOGE"].flatMap((asset) =>
    Array.from({ length: 6 }, (_, index) => ({
      symbol: `${asset}USDT_PERP.MOCK${index}`,
      exchange: `MOCK${index}`,
      symbol_on_exchange: `${asset}USDT`,
      base_asset: asset,
      quote_asset: "USDT",
      is_perpetual: true,
      margined: "STABLE",
      expire_at: "0",
      oi_lq_vol_denominated_in: "USD",
    })),
  );
}

function transportFor(
  batchSizes: number[],
  omitLastBucket = false,
): CoinalyzeTransportPort {
  return {
    async getFutureMarkets(apiKey) {
      assert.equal(apiKey, API_KEY);
      return catalogue();
    },
    async getLiquidationHistory(apiKey, request: CoinalyzeHistoryRequest) {
      assert.equal(apiKey, API_KEY);
      batchSizes.push(request.symbols.length);
      return request.symbols.map((symbol) => ({
        symbol,
        history: Array.from(
          {
            length: LIQUIDATION_HISTORY_BUCKETS - (omitLastBucket ? 1 : 0),
          },
          (_, index) => ({
            t: String(request.from + index * 60 * 60),
            l: "0",
            s: "0",
          }),
        ),
      }));
    },
  };
}

function secretProvider(reads: number[]): SecretProvider {
  return {
    async read() {
      reads[0] = (reads[0] ?? 0) + 1;
      return { kind: "available", secret: API_KEY };
    },
  };
}

function smokeClock() {
  const result = fixedClock(EXCHANGE_TIME);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("invalid smoke clock fixture");
  return result.value;
}

test("full live smoke requires explicit opt-in before #11, Keychain, or provider access", async () => {
  const secretReads = [0];
  const batchSizes: number[] = [];
  let exchangeTimeReads = 0;
  const reader = marketEvidenceReader();
  const guardedReader: MarketEvidenceCollectionReader = {
    ...reader,
    async readExchangeTime() {
      exchangeTimeReads += 1;
      return EXCHANGE_TIME;
    },
  };

  await assert.rejects(
    runCoinalyzeLiquidationFullSmoke({
      liveConfirmed: false,
      environment: { TRADER_ENV: "public-mainnet" },
      secrets: secretProvider(secretReads),
      marketEvidenceReader: guardedReader,
      coinalyzeTransport: transportFor(batchSizes),
      clock: smokeClock(),
    }),
    /Explicit live confirmation/u,
  );
  assert.equal(exchangeTimeReads, 0);
  assert.equal(secretReads[0], 0);
  assert.deepEqual(batchSizes, []);
});

test("full live smoke runs all eligible constituents through the canonical collector and reports bounded batches", async () => {
  const secretReads = [0];
  const batchSizes: number[] = [];
  const summary = await runCoinalyzeLiquidationFullSmoke({
    liveConfirmed: true,
    environment: { TRADER_ENV: "public-mainnet" },
    secrets: secretProvider(secretReads),
    marketEvidenceReader: marketEvidenceReader(),
    coinalyzeTransport: transportFor(batchSizes),
    clock: smokeClock(),
  });

  assert.equal(summary.status, "complete", JSON.stringify(summary));
  assert.equal(summary.coverageProof, "complete");
  assert.equal(summary.historyProof, "complete");
  assert.equal(summary.eligibleConstituents, 24);
  assert.equal(summary.constituentsWithHistory, 24);
  assert.equal(summary.expectedHourlyBuckets, 24 * LIQUIDATION_HISTORY_BUCKETS);
  assert.equal(summary.observedHourlyBuckets, 24 * LIQUIDATION_HISTORY_BUCKETS);
  assert.equal(summary.explicitZeroBuckets, 24 * LIQUIDATION_HISTORY_BUCKETS);
  assert.equal(summary.omittedBuckets, 0);
  assert.equal(summary.historyRequestCount, 2);
  assert.equal(summary.historyRequestSymbols, 24);
  assert.equal(summary.maximumSymbolsPerHistoryRequest, 20);
  assert.deepEqual(batchSizes, [20, 4]);
  assert.match(summary.canonicalHash, /^sha256:[0-9a-f]{64}$/u);
  assert.deepEqual(summary.diagnostics, []);
  assert.equal(secretReads[0], 1);
  assert.equal(JSON.stringify(summary).includes(API_KEY), false);
  assert.equal(JSON.stringify(summary).includes("BTCUSDT"), false);
});

test("full smoke counts explicit zero buckets separately from omitted hours", async () => {
  const batchSizes: number[] = [];
  const summary = await runCoinalyzeLiquidationFullSmoke({
    liveConfirmed: true,
    environment: { TRADER_ENV: "public-mainnet" },
    secrets: secretProvider([0]),
    marketEvidenceReader: marketEvidenceReader(),
    coinalyzeTransport: transportFor(batchSizes, true),
    clock: smokeClock(),
  });

  assert.equal(summary.status, "incomplete");
  assert.equal(summary.coverageProof, "complete");
  assert.equal(summary.historyProof, "incomplete");
  assert.equal(
    summary.observedHourlyBuckets,
    24 * (LIQUIDATION_HISTORY_BUCKETS - 1),
  );
  assert.equal(summary.explicitZeroBuckets, summary.observedHourlyBuckets);
  assert.equal(summary.omittedBuckets, 24);
  assert.deepEqual(batchSizes, [20, 4]);
});

test("full smoke stops before Coinalyze when exchange-time market evidence is incomplete", async () => {
  const secretReads = [0];
  const batchSizes: number[] = [];
  const brokenReader: MarketEvidenceCollectionReader = {
    ...marketEvidenceReader(),
    async readExchangeTime() {
      throw new Error("exchange-time unavailable");
    },
  };

  await assert.rejects(
    runCoinalyzeLiquidationFullSmoke({
      liveConfirmed: true,
      environment: { TRADER_ENV: "public-mainnet" },
      secrets: secretProvider(secretReads),
      marketEvidenceReader: brokenReader,
      coinalyzeTransport: transportFor(batchSizes),
      clock: smokeClock(),
    }),
    /complete, exchange-cutoff #11/u,
  );
  assert.equal(secretReads[0], 0);
  assert.deepEqual(batchSizes, []);
});
