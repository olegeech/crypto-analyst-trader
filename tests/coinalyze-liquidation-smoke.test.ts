import assert from "node:assert/strict";
import test from "node:test";

import { runCoinalyzeLiquidationSmoke } from "../scripts/coinalyze-liquidation-smoke.js";
import type {
  CoinalyzeCatalogueResult,
  CoinalyzeHistoryResult,
  CoinalyzeLiquidationDataPort,
} from "../src/ports/coinalyze-liquidation-data.js";
import type { SecretProvider } from "../src/ports/secret-provider.js";

const secret = "smoke-secret-sentinel";
const fixedNow = Date.UTC(2026, 8, 26, 12, 30);
const latestClosedBucket =
  Math.floor(fixedNow / (60 * 60 * 1_000)) * (60 * 60 * 1_000) -
  60 * 60 * 1_000;

function market(symbol: string, baseAsset: string) {
  return Object.freeze({
    symbol,
    exchange: "sample",
    symbolOnExchange: symbol,
    baseAsset,
    quoteAsset: "USDT",
    isPerpetual: true,
    marginType: "USDT",
    expireAt: 0,
    notionalDenominatedIn: "USD",
  });
}

function completeCatalogue(): CoinalyzeCatalogueResult {
  return Object.freeze({
    markets: Object.freeze([
      Object.freeze({ ...market("BTC-EXPIRED", "BTC"), expireAt: 1 }),
      market("BTC-PERP", "BTC"),
      market("ETH-PERP", "ETH"),
      market("SOL-PERP", "SOL"),
      market("DOGE-PERP", "DOGE"),
    ]),
    complete: true,
    diagnostics: Object.freeze([]),
  });
}

function secretProvider(): SecretProvider {
  return Object.freeze({
    async read() {
      return Object.freeze({ kind: "available" as const, secret });
    },
  });
}

function historyFor(symbols: readonly string[]): CoinalyzeHistoryResult {
  return Object.freeze({
    histories: Object.freeze(
      symbols.map((symbol, index) =>
        Object.freeze({
          symbol,
          observations: Object.freeze([
            Object.freeze({
              timestamp: new Date(
                latestClosedBucket - 60 * 60 * 1_000,
              ).toISOString(),
              longUsd: "0",
              shortUsd: "0",
            }),
            ...(index === 0
              ? [
                  Object.freeze({
                    timestamp: new Date(latestClosedBucket).toISOString(),
                    longUsd: "12.5",
                    shortUsd: "0",
                  }),
                ]
              : []),
          ]),
        }),
      ),
    ),
    responseValid: true,
    diagnostics: Object.freeze([]),
  });
}

test("live smoke requires its explicit opt-in before reading secrets or network", async () => {
  let secretReads = 0;
  let providerCalls = 0;
  const secrets: SecretProvider = {
    async read() {
      secretReads += 1;
      return { kind: "unavailable", reason: "missing" };
    },
  };
  const marketData: CoinalyzeLiquidationDataPort = {
    async fetchFutureMarkets() {
      providerCalls += 1;
      return completeCatalogue();
    },
    async fetchLiquidationHistory() {
      providerCalls += 1;
      return historyFor([]);
    },
  };

  await assert.rejects(
    runCoinalyzeLiquidationSmoke({
      liveConfirmed: false,
      secrets,
      marketData,
    }),
    /Explicit live confirmation/u,
  );
  assert.equal(secretReads, 0);
  assert.equal(providerCalls, 0);
});

test("smoke reports only sanitized counts and distinguishes explicit zeros from omitted hours", async () => {
  const calls: Array<{
    apiKey: string;
    symbols: readonly string[];
    from: number;
    to: number;
  }> = [];
  const marketData: CoinalyzeLiquidationDataPort = {
    async fetchFutureMarkets(apiKey) {
      assert.equal(apiKey, secret);
      return completeCatalogue();
    },
    async fetchLiquidationHistory(apiKey, symbols, from, to) {
      assert.equal(apiKey, secret);
      calls.push({ apiKey, symbols, from, to });
      return historyFor(symbols);
    },
  };

  const summary = await runCoinalyzeLiquidationSmoke({
    liveConfirmed: true,
    secrets: secretProvider(),
    marketData,
    now: () => fixedNow,
  });

  assert.equal(summary.status, "observed");
  assert.equal(summary.catalogueProof, "complete");
  assert.equal(summary.eligiblePerpetualMarkets, 4);
  assert.equal(summary.sampledMarkets, 4);
  assert.equal(summary.validHistoryResponses, 4);
  assert.equal(summary.observedBuckets, 5);
  assert.equal(summary.explicitZeroBuckets, 4);
  assert.equal(summary.omittedBuckets, 91);
  assert.equal(summary.runScopedEvidence, false);
  assert.deepEqual(calls[0]?.symbols, [
    "BTC-PERP",
    "ETH-PERP",
    "SOL-PERP",
    "DOGE-PERP",
  ]);
  assert.equal(calls[0]?.to - (calls[0]?.from ?? 0), 23 * 60 * 60);
  assert.equal(JSON.stringify(summary).includes(secret), false);
  assert.equal(JSON.stringify(summary).includes("BTC-PERP"), false);
});

test("missing secret is a stable sanitized failure without provider access", async () => {
  let providerCalls = 0;
  const secrets: SecretProvider = {
    async read() {
      return { kind: "unavailable", reason: "missing" };
    },
  };
  const marketData: CoinalyzeLiquidationDataPort = {
    async fetchFutureMarkets() {
      providerCalls += 1;
      return completeCatalogue();
    },
    async fetchLiquidationHistory() {
      providerCalls += 1;
      return historyFor([]);
    },
  };

  const summary = await runCoinalyzeLiquidationSmoke({
    liveConfirmed: true,
    secrets,
    marketData,
    now: () => fixedNow,
  });

  assert.equal(summary.status, "failed");
  assert.deepEqual(summary.diagnostics, ["secret-unavailable"]);
  assert.equal(providerCalls, 0);
});
