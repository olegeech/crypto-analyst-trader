import assert from "node:assert/strict";
import test from "node:test";

import { createProvisionalM1Composition } from "../src/application/policies/provisional-m1.js";
import { createAnalyticsEvidenceBundle } from "../src/domain/analytics/analytics-evidence-bundle.js";
import { createShadowMarketIntelligence } from "../src/domain/analytics/shadow-market-intelligence.js";
import { createShadowQualityAssessment } from "../src/domain/quality/shadow-quality-assessment.js";
import { hashCanonical } from "../src/domain/identity/canonical-serialization.js";
import { RoundingMode } from "../src/domain/shared/decimal.js";
import {
  dailyPrepareLiquidationV3,
  dailyPrepareMarket,
} from "./fixtures/daily-prepare-fixtures.js";
import { requireDailyFixture as requireFixture } from "./fixtures/daily-planning-evidence-fixtures.js";
import {
  fixtureDecimal,
  marketFixture,
} from "./fixtures/data-quality-fixtures.js";

function shadowFixture(
  input: {
    readonly liquidationMode?:
      "complete" | "zero" | "missing" | "invalid-response";
    readonly removeTicker?: boolean;
    readonly equalQuotes?: boolean;
    readonly omitFeature?: string;
  } = {},
) {
  let market = dailyPrepareMarket();
  if (input.equalQuotes) {
    market = marketFixture({
      ...market,
      symbols: market.symbols.map((item) =>
        item.symbol === "BTCUSDT" && item.ticker !== undefined
          ? {
              ...item,
              ticker: { ...item.ticker, ask: item.ticker.bid },
            }
          : item,
      ),
    });
  }
  if (input.removeTicker) {
    market = marketFixture({
      ...market,
      status: "incomplete",
      symbols: market.symbols.map((item) => {
        if (item.symbol !== "BTCUSDT") return item;
        const { ticker: _ticker, ...withoutTicker } = item;
        void _ticker;
        return withoutTicker;
      }),
    });
  }
  const composition = requireFixture(
    createProvisionalM1Composition({ symbol: "BTCUSDT", allocation: "100" }),
  );
  const liquidation = dailyPrepareLiquidationV3(
    market,
    composition.selectedAsset,
    input.liquidationMode,
  ).bundle;
  const analytics = requireFixture(
    createAnalyticsEvidenceBundle({
      market,
      liquidation,
      profile:
        input.omitFeature === undefined
          ? composition.analyticsProfile
          : {
              ...composition.analyticsProfile,
              features: composition.analyticsProfile.features.filter(
                (feature) => feature.id !== input.omitFeature,
              ),
            },
      featuresVersion: composition.analyticsFeaturesVersion,
    }),
  );
  return {
    market,
    liquidation,
    analytics,
    symbol: "BTCUSDT",
    evaluationTime: new Date(
      Date.parse(market.bundleCutoff) + 3_000,
    ).toISOString(),
  };
}

test("shadow bundle records supported facts without claiming a model assessment", () => {
  const result = createShadowMarketIntelligence(shadowFixture());

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.value.schemaVersion, "shadow-market-intelligence/v1");
  assert.equal(result.value.modelVersion, "existing-evidence-shadow/v1");
  assert.equal(
    result.value.contentHash,
    "sha256:2092b4e3ea4b698ec2c26c84a661d20b088ff11d4d8bd086c8c7252f30c55a66",
  );
  // Changes to this calculation need a new model version and a retained v1
  // replay path so saved prepared-daily-plan/v3 artifacts remain readable.
  assert.deepEqual(
    result.value.families.map((family) => [family.family, family.status]),
    [
      ["market-regime-score", "partial"],
      ["early-warning-risk", "partial"],
      ["liquidity-stress", "partial"],
      ["trap", "partial"],
    ],
  );
  assert.ok(
    result.value.families.every(
      (family) => family.assessmentStatus === "unavailable",
    ),
  );
  assert.deepEqual(
    result.value.observations.map((observation) => observation.id),
    [
      "atr-4h",
      "funding-current",
      "liquidation-12h-imbalance",
      "liquidation-12h-long-usd",
      "liquidation-12h-short-usd",
      "liquidation-12h-total-usd",
      "oi-relative-24h",
      "quote-relative-spread",
      "quote-spread",
      "return-24h",
      "return-3d",
    ],
  );
  assert.equal(
    result.value.observations
      .find((observation) => observation.id === "quote-spread")
      ?.value.toString(),
    "0.1",
  );
  assert.equal(
    result.value.observations.find(
      (observation) => observation.id === "quote-relative-spread",
    )?.unit,
    "ratio",
  );
  assert.equal(
    result.value.observations.find((item) => item.id === "quote-spread")
      ?.unitLabel,
    "USDT per BTC",
  );
  assert.equal(
    result.value.observations.find((item) => item.id === "atr-4h")?.window
      ?.interval,
    "4h",
  );
  assert.equal(
    result.value.observations.find((item) => item.id === "oi-relative-24h")
      ?.window?.interval,
    "1h",
  );
  const relativeExpected = requireFixture(
    fixtureDecimal("0.2").divide(
      fixtureDecimal("204.1"),
      18,
      RoundingMode.HALF_EVEN,
    ),
  );
  assert.equal(
    result.value.observations
      .find((item) => item.id === "quote-relative-spread")
      ?.value.toString(),
    relativeExpected.toString(),
  );
  assert.ok(result.value.validForMs > 0 && result.value.validForMs <= 300_000);
  assert.equal(result.value.asOf, result.value.cutoff);
  assert.ok(
    result.value.observations.every(
      (observation) =>
        observation.sourceId.length > 0 &&
        observation.sourceHash.startsWith("sha256:") &&
        observation.observedAt.length > 0 &&
        observation.unit.length > 0,
    ),
  );
  for (const forbidden of [
    "score",
    "confidence",
    "probability",
    "likelihood",
  ]) {
    assert.equal(Object.hasOwn(result.value, forbidden), false);
    assert.equal(
      result.value.observations.some((observation) =>
        Object.hasOwn(observation, forbidden),
      ),
      false,
    );
  }
});

test("missing ticker removes only ticker-derived facts and makes liquidity unavailable", () => {
  const result = createShadowMarketIntelligence(
    shadowFixture({ removeTicker: true }),
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  const observationIds = result.value.observations.map((item) => item.id);
  assert.ok(observationIds.includes("return-24h"));
  assert.ok(observationIds.includes("oi-relative-24h"));
  assert.equal(observationIds.includes("funding-current"), false);
  assert.equal(observationIds.includes("quote-spread"), false);
  assert.equal(
    result.value.families.find((item) => item.family === "liquidity-stress")
      ?.status,
    "unavailable",
  );
  assert.deepEqual(
    result.value.families.find((item) => item.family === "early-warning-risk")
      ?.missingSourceInputs,
    ["funding-current"],
  );
});

test("missing optional liquidation source is explicit in provenance and family inputs", () => {
  const market = dailyPrepareMarket();
  const composition = requireFixture(
    createProvisionalM1Composition({ symbol: "BTCUSDT", allocation: "100" }),
  );
  const profile = {
    ...composition.analyticsProfile,
    features: composition.analyticsProfile.features.filter(
      (feature) => feature.kind !== "liquidation-window",
    ),
  };
  const analytics = requireFixture(
    createAnalyticsEvidenceBundle({
      market,
      profile,
      featuresVersion: composition.analyticsFeaturesVersion,
    }),
  );
  const result = createShadowMarketIntelligence({
    market,
    analytics,
    symbol: "BTCUSDT",
    evaluationTime: new Date(
      Date.parse(market.bundleCutoff) + 3_000,
    ).toISOString(),
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(
    Object.hasOwn(result.value.sourceManifest, "liquidation"),
    false,
  );
  assert.equal(
    result.value.observations.some((item) =>
      item.id.startsWith("liquidation-12h-"),
    ),
    false,
  );
  for (const family of ["early-warning-risk", "trap"] as const)
    assert.deepEqual(
      result.value.families.find((item) => item.family === family)
        ?.missingSourceInputs,
      [
        "liquidation-12h-long-usd",
        "liquidation-12h-short-usd",
        "liquidation-12h-total-usd",
      ],
    );

  const assessment = createShadowQualityAssessment({
    market,
    analytics,
    evaluationTime: result.value.evaluationTime,
    shadow: result.value,
  });
  assert.equal(assessment.ok, true);
  if (!assessment.ok) return;
  assert.equal(
    assessment.value.sourceDispositions.find(
      (item) => item.role === "liquidation",
    )?.disposition,
    "missing",
  );
});

test("equal positive quotes produce exact zero spread", () => {
  const result = createShadowMarketIntelligence(
    shadowFixture({ equalQuotes: true }),
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(
    result.value.observations
      .find((item) => item.id === "quote-spread")
      ?.value.toString(),
    "0",
  );
  assert.equal(
    result.value.observations
      .find((item) => item.id === "quote-relative-spread")
      ?.value.toString(),
    "0",
  );
});

test("an omitted native outcome stays missing without changing unrelated observations", () => {
  const result = createShadowMarketIntelligence(
    shadowFixture({ omitFeature: "return-24h" }),
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(
    result.value.observations.some((item) => item.id === "return-24h"),
    false,
  );
  assert.equal(
    result.value.observations.some((item) => item.id === "return-3d"),
    true,
  );
  assert.ok(
    result.value.families
      .filter((item) => item.family !== "liquidity-stress")
      .every((item) => item.missingSourceInputs.includes("return-24h")),
  );
});

test("zero liquidation has no fabricated imbalance and missing buckets remain explicit", () => {
  const zero = createShadowMarketIntelligence(
    shadowFixture({ liquidationMode: "zero" }),
  );
  assert.equal(zero.ok, true);
  if (!zero.ok) return;
  assert.equal(
    zero.value.observations
      .find((item) => item.id === "liquidation-12h-total-usd")
      ?.value.toString(),
    "0",
  );
  assert.equal(
    zero.value.observations.some(
      (item) => item.id === "liquidation-12h-imbalance",
    ),
    false,
  );

  const missing = createShadowMarketIntelligence(
    shadowFixture({ liquidationMode: "missing" }),
  );
  assert.equal(missing.ok, true);
  if (!missing.ok) return;
  const total = missing.value.observations.find(
    (item) => item.id === "liquidation-12h-total-usd",
  );
  assert.ok(total);
  assert.equal(total.sourceStatus, "partial");
  assert.equal(total.window?.complete, false);
  assert.ok(
    (total.window?.observedConstituentBuckets ?? 0) <
      (total.window?.expectedConstituentBuckets ?? 0),
  );
});

test("source identity and timestamp are bound; equivalent calls hash deterministically", () => {
  const fixture = shadowFixture();
  const first = createShadowMarketIntelligence(fixture);
  const second = createShadowMarketIntelligence(fixture);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(first.value.contentHash, second.value.contentHash);
  assert.deepEqual(
    first.value.observations.map((item) => item.id),
    [...first.value.observations.map((item) => item.id)].sort(),
  );

  const wrongSymbol = createShadowMarketIntelligence({
    ...fixture,
    symbol: "ETHUSDT",
  });
  assert.equal(wrongSymbol.ok, false);

  const wrongRun = dailyPrepareMarket("different-run");
  const mismatched = createShadowMarketIntelligence({
    ...fixture,
    market: wrongRun,
  });
  assert.equal(mismatched.ok, false);

  const changedQuoteMarket = marketFixture({
    ...fixture.market,
    symbols: fixture.market.symbols.map((item) =>
      item.symbol === "BTCUSDT" && item.ticker !== undefined
        ? {
            ...item,
            ticker: { ...item.ticker, ask: fixtureDecimal("102.2") },
          }
        : item,
    ),
  });
  const changedLiquidation = dailyPrepareLiquidationV3(
    changedQuoteMarket,
    "BTC",
  ).bundle;
  const composition = requireFixture(
    createProvisionalM1Composition({ symbol: "BTCUSDT", allocation: "100" }),
  );
  const changedAnalytics = requireFixture(
    createAnalyticsEvidenceBundle({
      market: changedQuoteMarket,
      liquidation: changedLiquidation,
      profile: composition.analyticsProfile,
      featuresVersion: composition.analyticsFeaturesVersion,
    }),
  );
  const changed = createShadowMarketIntelligence({
    ...fixture,
    market: changedQuoteMarket,
    liquidation: changedLiquidation,
    analytics: changedAnalytics,
  });
  assert.equal(changed.ok, true);
  if (!changed.ok) return;
  assert.notEqual(first.value.contentHash, changed.value.contentHash);

  const { contentHash: _contentHash, ...analyticsPayload } = fixture.analytics;
  void _contentHash;
  const wrongHash = createShadowMarketIntelligence({
    ...fixture,
    analytics: {
      ...analyticsPayload,
      contentHash: `sha256:${"0".repeat(64)}`,
    },
  });
  assert.equal(wrongHash.ok, false);

  const badUnitAnalytics = {
    ...fixture.analytics,
    priceFeatures: fixture.analytics.priceFeatures.map((outcome) =>
      outcome.requestId === "return-24h" &&
      outcome.value?.type === "close-return"
        ? {
            ...outcome,
            value: { ...outcome.value, unit: "USD" },
          }
        : outcome,
    ),
  };
  const { contentHash: _badAnalyticsHash, ...badAnalyticsPayload } =
    badUnitAnalytics;
  void _badAnalyticsHash;
  const badAnalyticsHash = hashCanonical(badAnalyticsPayload);
  assert.equal(badAnalyticsHash.ok, true);
  if (!badAnalyticsHash.ok) return;
  const badUnit = createShadowMarketIntelligence({
    ...fixture,
    analytics: {
      ...badAnalyticsPayload,
      contentHash: badAnalyticsHash.value,
    },
  });
  assert.equal(badUnit.ok, false);

  const unknownLegacyPayload = createShadowMarketIntelligence({
    ...fixture,
    historicalCews: { score: 50 },
  });
  assert.equal(unknownLegacyPayload.ok, false);
  const { contentHash, ...bundlePayload } = first.value;
  const recomputed = hashCanonical(bundlePayload);
  assert.equal(recomputed.ok, true);
  if (recomputed.ok) assert.equal(contentHash, recomputed.value);
});
