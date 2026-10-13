import assert from "node:assert/strict";
import test from "node:test";

import { selectDecisionLiquidationMarkets } from "../src/application/liquidation-market-selection.js";
import { createProvisionalM1Composition } from "../src/application/policies/provisional-m1.js";
import type { CoinalyzeMarket } from "../src/ports/coinalyze-liquidation-data.js";

const cutoffMs = Date.parse("2026-10-11T12:30:00.000Z");

function market(
  asset: string,
  venue: string,
  overrides: Partial<CoinalyzeMarket> = {},
): CoinalyzeMarket {
  return {
    symbol: `${asset}USDT_PERP.${venue}`,
    exchange: venue,
    symbolOnExchange: `${asset}USDT`,
    baseAsset: asset,
    quoteAsset: "USDT",
    isPerpetual: true,
    marginType: "STABLE",
    expireAt: 0,
    notionalDenominatedIn: "USD",
    ...overrides,
  };
}

test("decision selection is asset-scoped, reproducible, and binds exclusions", () => {
  const rows = [
    market("ETH", "BINANCE"),
    market("BTC", "BYBIT"),
    market("BTC", "SPOT", {
      symbol: "BTCUSDT.SPOT",
      isPerpetual: false,
    }),
    market("BTC", "EXPIRED", {
      symbol: "BTCUSDT_PERP.EXPIRED",
      expireAt: Math.floor(cutoffMs / 1_000) - 1,
    }),
  ];

  const first = selectDecisionLiquidationMarkets({
    asset: "BTC",
    markets: rows,
    catalogueComplete: true,
    cutoffMs,
  });
  const reordered = selectDecisionLiquidationMarkets({
    asset: "BTC",
    markets: [...rows].reverse(),
    catalogueComplete: true,
    cutoffMs,
  });

  assert.equal(first.ok, true);
  assert.equal(reordered.ok, true);
  if (!first.ok || !reordered.ok) return;
  assert.equal(first.value.status, "complete");
  assert.equal(first.value.coverageProof, "complete");
  assert.deepEqual(
    first.value.selectedMarkets.map(({ symbol }) => symbol),
    ["BTCUSDT_PERP.BYBIT"],
  );
  assert.deepEqual(first.value.exclusions.map(({ reason }) => reason).sort(), [
    "asset-mismatch",
    "expired",
    "not-perpetual",
  ]);
  assert.equal(first.value.catalogueHash, reordered.value.catalogueHash);
  assert.equal(first.value.selectedSetHash, reordered.value.selectedSetHash);
  assert.notEqual(first.value.selectedSetHash, first.value.catalogueHash);

  const expanded = selectDecisionLiquidationMarkets({
    asset: "BTC",
    markets: [...rows, market("BTC", "BINANCE")],
    catalogueComplete: true,
    cutoffMs,
  });
  const expired = selectDecisionLiquidationMarkets({
    asset: "BTC",
    markets: [
      market("BTC", "BYBIT", {
        expireAt: Math.floor(cutoffMs / 1_000),
      }),
    ],
    catalogueComplete: true,
    cutoffMs,
  });
  assert.equal(expanded.ok, true);
  assert.equal(expired.ok, true);
  if (!expanded.ok || !expired.ok) return;
  assert.equal(
    expanded.value.coveragePolicyVersion,
    first.value.coveragePolicyVersion,
  );
  assert.notEqual(expanded.value.selectedSetHash, first.value.selectedSetHash);
  assert.notEqual(expired.value.selectedSetHash, first.value.selectedSetHash);
});

test("incomplete discovery and empty selection never prove coverage", () => {
  const partial = selectDecisionLiquidationMarkets({
    asset: "BTC",
    markets: [market("BTC", "BYBIT")],
    catalogueComplete: false,
    cutoffMs,
  });
  const empty = selectDecisionLiquidationMarkets({
    asset: "BTC",
    markets: [market("ETH", "BINANCE")],
    catalogueComplete: true,
    cutoffMs,
  });
  const sameCompleteCatalogue = selectDecisionLiquidationMarkets({
    asset: "BTC",
    markets: [market("BTC", "BYBIT")],
    catalogueComplete: true,
    cutoffMs,
  });

  assert.equal(partial.ok, true);
  assert.equal(empty.ok, true);
  assert.equal(sameCompleteCatalogue.ok, true);
  if (!partial.ok || !empty.ok || !sameCompleteCatalogue.ok) return;
  assert.equal(partial.value.status, "incomplete");
  assert.equal(partial.value.coverageProof, "incomplete");
  assert.equal(
    partial.value.catalogueHash,
    sameCompleteCatalogue.value.catalogueHash,
  );
  assert.notEqual(
    partial.value.selectedSetHash,
    sameCompleteCatalogue.value.selectedSetHash,
  );
  assert.equal(empty.value.status, "failed");
  assert.equal(empty.value.coverageProof, "incomplete");
  assert.deepEqual(empty.value.selectedMarkets, []);
  assert.ok(empty.value.reasonCodes.includes("NO_ELIGIBLE_MARKETS"));
});

test("trusted M1 composition maps each supported symbol to one asset", () => {
  for (const [symbol, expectedAsset] of [
    ["BTCUSDT", "BTC"],
    ["ETHUSDT", "ETH"],
    ["SOLUSDT", "SOL"],
    ["DOGEUSDT", "DOGE"],
  ] as const) {
    const composition = createProvisionalM1Composition({
      symbol,
      allocation: "10",
    });
    assert.equal(composition.ok, true);
    if (composition.ok) {
      assert.equal(composition.value.selectedAsset, expectedAsset);
    }
  }
});

test("conflicting metadata for one venue contract is excluded without first-match wins", () => {
  const result = selectDecisionLiquidationMarkets({
    asset: "BTC",
    markets: [
      market("BTC", "BYBIT"),
      market("BTC", "BYBIT", {
        symbol: "BTCUSD_PERP.BYBIT",
        marginType: "COIN",
        expireAt: 1_800_000_000,
      }),
    ],
    catalogueComplete: true,
    cutoffMs,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.status, "failed");
  assert.equal(result.value.coverageProof, "incomplete");
  assert.deepEqual(result.value.selectedMarkets, []);
  assert.ok(result.value.reasonCodes.includes("CONFLICTING_MARKET_IDENTITY"));
  assert.equal(result.value.catalogueMarkets.length, 2);
});
