import assert from "node:assert/strict";
import test from "node:test";

import type { CoinalyzeTransportPort } from "../src/adapters/coinalyze/coinalyze-client.js";
import {
  CoinalyzeTransportError,
  type CoinalyzeHistoryRequest,
} from "../src/adapters/coinalyze/coinalyze-transport.js";
import type { MarketEvidenceCollectionReader } from "../src/application/market-evidence-collection.js";
import { DecimalValue } from "../src/domain/shared/decimal.js";
import { fixedClock, type UtcTimestamp } from "../src/domain/shared/time.js";
import type { SecretProvider } from "../src/ports/secret-provider.js";
import { runCoinalyzeDecisionSmoke } from "../scripts/coinalyze-liquidation-decision-smoke.js";

const API_KEY = "decision-smoke-secret-sentinel";
const EXCHANGE_TIME = "2026-09-26T12:30:00.000Z" as UtcTimestamp;
const intervalMs = {
  "1h": 60 * 60 * 1_000,
  "4h": 4 * 60 * 60 * 1_000,
  "1d": 24 * 60 * 60 * 1_000,
  "1w": 7 * 24 * 60 * 60 * 1_000,
} as const;

function decimal(value: string): DecimalValue {
  const result = DecimalValue.fromString(value);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("invalid decimal fixture");
  return result.value;
}

function timestamp(epoch: number): UtcTimestamp {
  return new Date(epoch).toISOString() as UtcTimestamp;
}

function marketEvidenceReader(): MarketEvidenceCollectionReader {
  return {
    async readExchangeTime() {
      return EXCHANGE_TIME;
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
  return [
    ...["BINANCE", "BYBIT"].map((venue) => ({
      symbol: `BTCUSDT_PERP.${venue}`,
      exchange: venue,
      symbol_on_exchange: "BTCUSDT",
      base_asset: "BTC",
      quote_asset: "USDT",
      is_perpetual: true,
      margined: "STABLE",
      expire_at: "0",
      oi_lq_vol_denominated_in: "USD",
    })),
    {
      symbol: "ETHUSDT_PERP.BINANCE",
      exchange: "BINANCE",
      symbol_on_exchange: "ETHUSDT",
      base_asset: "ETH",
      quote_asset: "USDT",
      is_perpetual: true,
      margined: "STABLE",
      expire_at: "0",
      oi_lq_vol_denominated_in: "USD",
    },
  ];
}

function clock() {
  const result = fixedClock(EXCHANGE_TIME);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("invalid smoke clock fixture");
  return result.value;
}

test("decision smoke is live-gated before market, credential, or provider access", async () => {
  let accessed = false;
  const secrets: SecretProvider = {
    async read() {
      accessed = true;
      return { kind: "available", secret: API_KEY };
    },
  };
  await assert.rejects(
    runCoinalyzeDecisionSmoke({
      liveConfirmed: false,
      secrets,
      marketEvidenceReader: {
        ...marketEvidenceReader(),
        async readExchangeTime() {
          accessed = true;
          return EXCHANGE_TIME;
        },
      },
      coinalyzeTransport: {
        async getFutureMarkets() {
          accessed = true;
          return [];
        },
        async getLiquidationHistory() {
          accessed = true;
          return [];
        },
      },
    }),
    /Explicit live confirmation/u,
  );
  assert.equal(accessed, false);
});

test("decision smoke verifies one trusted v3 asset without exposing provider symbols", async () => {
  const batchSizes: number[] = [];
  const transport: CoinalyzeTransportPort = {
    async getFutureMarkets(apiKey) {
      assert.equal(apiKey, API_KEY);
      return catalogue();
    },
    async getLiquidationHistory(apiKey, request: CoinalyzeHistoryRequest) {
      assert.equal(apiKey, API_KEY);
      batchSizes.push(request.symbols.length);
      return request.symbols.map((symbol) => ({
        symbol,
        history: Array.from({ length: 24 }, (_, index) => ({
          t: String(request.from + index * 60 * 60),
          l: "0",
          s: "0",
        })),
      }));
    },
  };
  const secrets: SecretProvider = {
    async read() {
      return { kind: "available", secret: API_KEY };
    },
  };
  const summary = await runCoinalyzeDecisionSmoke({
    liveConfirmed: true,
    environment: { TRADER_ENV: "public-mainnet" },
    secrets,
    marketEvidenceReader: marketEvidenceReader(),
    coinalyzeTransport: transport,
    clock: clock(),
  });

  assert.equal(summary.mode, "decision-v3-verification");
  assert.equal(summary.selectedAsset, "BTC");
  assert.equal(summary.schemaVersion, "liquidation-evidence/v3");
  assert.equal(summary.status, "complete", JSON.stringify(summary));
  assert.equal(summary.coverageProof, "complete");
  assert.equal(summary.historyProof, "complete");
  assert.equal(summary.catalogueMarketCount, 3);
  assert.equal(summary.selectedMarketCount, 2);
  assert.equal(summary.excludedMarketCount, 1);
  assert.equal(summary.historyRequestSymbols, 2);
  assert.deepEqual(batchSizes, [2]);
  assert.equal(summary.providerExplicitBuckets, 48);
  assert.equal(summary.providerExplicitZeroBuckets, 48);
  assert.equal(summary.providerImpliedZeroBuckets, 0);
  assert.equal(summary.unresolvedRequestedBuckets, 0);
  assert.match(summary.catalogueHash, /^sha256:[0-9a-f]{64}$/u);
  assert.match(summary.selectedSetHash, /^sha256:[0-9a-f]{64}$/u);
  assert.match(summary.canonicalHash, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(JSON.stringify(summary).includes(API_KEY), false);
  assert.equal(JSON.stringify(summary).includes("BTCUSDT"), false);
});

test("a failed later selected-history batch prevents sparse-zero reconstruction globally", async () => {
  let historyCalls = 0;
  const selectedCatalogue = Array.from({ length: 21 }, (_, index) => {
    const venue = `VENUE${index + 1}`;
    return {
      symbol: `BTCUSDT_PERP.${venue}`,
      exchange: venue,
      symbol_on_exchange: `BTCUSDT-${index + 1}`,
      base_asset: "BTC",
      quote_asset: "USDT",
      is_perpetual: true,
      margined: "STABLE",
      expire_at: "0",
      oi_lq_vol_denominated_in: "USD",
    };
  });
  const transport: CoinalyzeTransportPort = {
    async getFutureMarkets() {
      return selectedCatalogue;
    },
    async getLiquidationHistory(_apiKey, request) {
      historyCalls += 1;
      if (historyCalls === 2) {
        throw new CoinalyzeTransportError("http-failed", "safe", {
          httpStatus: 500,
        });
      }
      return request.symbols.map((symbol) => ({ symbol, history: [] }));
    },
  };
  const secrets: SecretProvider = {
    async read() {
      return { kind: "available", secret: API_KEY };
    },
  };

  const summary = await runCoinalyzeDecisionSmoke({
    liveConfirmed: true,
    environment: { TRADER_ENV: "public-mainnet" },
    secrets,
    marketEvidenceReader: marketEvidenceReader(),
    coinalyzeTransport: transport,
    clock: clock(),
  });

  assert.equal(historyCalls, 2);
  assert.equal(summary.status, "incomplete");
  assert.equal(summary.coverageProof, "complete");
  assert.equal(summary.historyProof, "incomplete");
  assert.equal(summary.selectedMarketCount, 21);
  assert.equal(summary.maximumSymbolsPerHistoryRequest, 20);
  assert.equal(summary.providerImpliedZeroBuckets, 0);
  assert.equal(summary.unresolvedRequestedBuckets, 21 * 24);
  assert.ok(summary.diagnostics.includes("history-unavailable"));
  assert.equal(JSON.stringify(summary).includes(API_KEY), false);
});
