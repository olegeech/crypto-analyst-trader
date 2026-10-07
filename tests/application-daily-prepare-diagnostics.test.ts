import assert from "node:assert/strict";
import test from "node:test";
import { createAnalyticsProfile } from "../src/domain/analytics/analytics-profile.js";
import {
  createLiquidationEvidenceBundle,
  type LiquidationEvidenceBundle,
} from "../src/domain/liquidation/liquidation-evidence-bundle.js";
import { liquidationHistoryWindow } from "../src/domain/liquidation/liquidation-evidence-windows.js";
import { createProvisionalM1Composition } from "../src/application/policies/provisional-m1.js";
import {
  MAX_REQUIRED_LIQUIDATION_VENUE_GROUPS,
  summarizeRequiredLiquidationWindows,
} from "../src/application/daily-prepare-diagnostics.js";
import {
  DAILY_PREPARE_RUN_ID,
  dailyPrepareLiquidation,
  dailyPrepareMarket,
} from "./fixtures/daily-prepare-fixtures.js";

function requireValue<T>(result: { ok: true; value: T } | { ok: false }): T {
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("fixture is invalid");
  return result.value;
}

function productionProfile(symbol = "BTCUSDT") {
  return requireValue(
    createProvisionalM1Composition({ symbol, allocation: "10" }),
  ).analyticsProfile;
}

function rehydrateInput(bundle: LiquidationEvidenceBundle) {
  return {
    ...bundle,
    targets: bundle.targets.map((target) => ({
      asset: target.asset,
      constituents: target.constituents.map((constituent) => ({
        providerSymbol: constituent.providerSymbol,
        exchange: constituent.exchange,
        symbolOnExchange: constituent.symbolOnExchange,
        baseAsset: constituent.baseAsset,
        quoteAsset: constituent.quoteAsset,
        isPerpetual: constituent.isPerpetual,
        marginType: constituent.marginType,
        expireAt: constituent.expireAt,
        notionalDenominatedIn: constituent.notionalDenominatedIn,
        observations: constituent.observations.map((row) => ({
          timestamp: row.timestamp,
          longUsd: row.longUsd.toString(),
          shortUsd: row.shortUsd.toString(),
        })),
      })),
    })),
  };
}

test("diagnostics use selected asset/window and keep unavailable counts unknown", () => {
  const market = dailyPrepareMarket(DAILY_PREPARE_RUN_ID);
  const liquidation = dailyPrepareLiquidation(market).bundle;
  const ethFourHourProfile = requireValue(
    createAnalyticsProfile({
      schemaVersion: "analytics-profile/v1",
      features: [
        {
          id: "eth-liquidation-4h",
          kind: "liquidation-window",
          asset: "ETH",
          windowHours: 4,
          required: true,
        },
      ],
      externalEvidence: [],
    }),
  );
  assert.deepEqual(
    summarizeRequiredLiquidationWindows(
      ethFourHourProfile,
      market,
      liquidation,
    ),
    [
      {
        requestId: "eth-liquidation-4h",
        asset: "ETH",
        hours: 4,
        completeness: "complete",
        observedConstituentBuckets: 4,
        expectedConstituentBuckets: 4,
        missingByVenue: [],
        omittedVenueGroupCount: 0,
        omittedMissingConstituentBuckets: 0,
      },
    ],
  );
  const unknown = summarizeRequiredLiquidationWindows(
    productionProfile(),
    market,
    undefined,
  )[0];
  assert.equal(unknown?.completeness, "unknown");
  assert.equal(unknown?.observedConstituentBuckets, null);
  assert.equal(unknown?.expectedConstituentBuckets, null);
  assert.equal(unknown?.missingByVenue, null);
});

test("diagnostics do not infer counts from an incompatible source identity", () => {
  const sourceMarket = dailyPrepareMarket(DAILY_PREPARE_RUN_ID);
  const otherRunMarket = dailyPrepareMarket("unrelated-market-run");
  const liquidation = dailyPrepareLiquidation(sourceMarket).bundle;
  const diagnostic = summarizeRequiredLiquidationWindows(
    productionProfile(),
    otherRunMarket,
    liquidation,
  )[0];
  assert.equal(diagnostic?.completeness, "unknown");
  assert.equal(diagnostic?.observedConstituentBuckets, null);
  assert.equal(diagnostic?.expectedConstituentBuckets, null);
  assert.equal(diagnostic?.missingByVenue, null);
});

test("full observed counts remain incomplete when source history response was invalid", () => {
  const market = dailyPrepareMarket(DAILY_PREPARE_RUN_ID);
  const complete = dailyPrepareLiquidation(market).bundle;
  const invalidResponse = requireValue(
    createLiquidationEvidenceBundle({
      ...rehydrateInput(complete),
      status: "incomplete",
      historyProof: "incomplete",
      diagnostics: [
        {
          code: "history-incomplete",
          operation: "fetch-liquidation-history",
        },
      ],
    }),
  );
  const diagnostic = summarizeRequiredLiquidationWindows(
    productionProfile(),
    market,
    invalidResponse,
  )[0];
  assert.equal(diagnostic?.completeness, "incomplete");
  assert.equal(diagnostic?.observedConstituentBuckets, 12);
  assert.equal(diagnostic?.expectedConstituentBuckets, 12);
  assert.deepEqual(diagnostic?.missingByVenue, []);
});

test("venue diagnostics are sorted, capped at 20, and retain omitted totals", () => {
  const market = dailyPrepareMarket(DAILY_PREPARE_RUN_ID);
  const base = dailyPrepareLiquidation(market).bundle;
  const expectedBuckets = liquidationHistoryWindow(
    Date.parse(base.bundleCutoff),
  ).epochs;
  const missingBucket = expectedBuckets.at(-2)!;
  const btcConstituents = Array.from({ length: 22 }, (_, index) => ({
    providerSymbol: `BTC-PERP-${index}`,
    exchange: `Venue-${String(index).padStart(2, "0")}`,
    symbolOnExchange: `BTC${String(index).padStart(2, "0")}USDT`,
    baseAsset: "BTC" as const,
    quoteAsset: "USDT",
    isPerpetual: true as const,
    marginType: "STABLE",
    expireAt: 0,
    notionalDenominatedIn: "USD",
    observations: expectedBuckets
      .filter((bucket) => bucket !== missingBucket)
      .map((bucket) => ({
        timestamp: new Date(bucket).toISOString(),
        longUsd: "10",
        shortUsd: "20",
      })),
  }));
  const targets = rehydrateInput(base).targets.map((target) =>
    target.asset === "BTC"
      ? { asset: target.asset, constituents: btcConstituents }
      : target,
  );
  const input = {
    ...rehydrateInput(base),
    status: "incomplete" as const,
    historyProof: "incomplete" as const,
    targets,
    diagnostics: btcConstituents.map((constituent) => ({
      code: "missing-bucket" as const,
      operation: "fetch-liquidation-history" as const,
      asset: "BTC",
      providerSymbol: constituent.providerSymbol,
      bucketTimestamp: new Date(missingBucket).toISOString(),
    })),
  };
  const liquidation = requireValue(createLiquidationEvidenceBundle(input));
  const diagnostic = summarizeRequiredLiquidationWindows(
    productionProfile(),
    market,
    liquidation,
  )[0];
  assert.equal(diagnostic?.completeness, "incomplete");
  assert.equal(diagnostic?.expectedConstituentBuckets, 22 * 12);
  assert.equal(diagnostic?.observedConstituentBuckets, 22 * 11);
  assert.equal(
    diagnostic?.missingByVenue?.length,
    MAX_REQUIRED_LIQUIDATION_VENUE_GROUPS,
  );
  assert.deepEqual(
    diagnostic?.missingByVenue?.map((group) => group.venue),
    Array.from(
      { length: MAX_REQUIRED_LIQUIDATION_VENUE_GROUPS },
      (_, index) => `Venue-${String(index).padStart(2, "0")}`,
    ),
  );
  assert.equal(diagnostic?.omittedVenueGroupCount, 2);
  assert.equal(diagnostic?.omittedMissingConstituentBuckets, 2);
});
