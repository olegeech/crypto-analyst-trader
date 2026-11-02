import assert from "node:assert/strict";
import test from "node:test";

import { createProvisionalM1Composition } from "../src/application/policies/provisional-m1.js";
import { createAnalyticsEvidenceBundle } from "../src/domain/analytics/analytics-evidence-bundle.js";
import {
  createShadowMarketIntelligence,
  type ShadowMarketIntelligenceBundle,
} from "../src/domain/analytics/shadow-market-intelligence.js";
import { hashCanonical } from "../src/domain/identity/canonical-serialization.js";
import { createLiquidationEvidenceRef } from "../src/domain/liquidation/liquidation-evidence-bundle.js";
import {
  createShadowQualityAssessment,
  type ShadowQualityAssessment,
} from "../src/domain/quality/shadow-quality-assessment.js";
import { assessDataQuality } from "../src/domain/quality/assess-data-quality.js";
import {
  dailyPrepareLiquidationV3,
  dailyPrepareMarket,
} from "./fixtures/daily-prepare-fixtures.js";
import { requireDailyFixture as requireFixture } from "./fixtures/daily-planning-evidence-fixtures.js";
import {
  marketFixture,
  fixtureDecimal,
} from "./fixtures/data-quality-fixtures.js";
import { parseUtcTimestamp } from "../src/domain/shared/time.js";

const composition = requireFixture(
  createProvisionalM1Composition({ symbol: "BTCUSDT", allocation: "100" }),
);

function shadowQualityFixture(
  input: {
    readonly evaluationOffsetMs?: number;
    readonly tickerAgeMs?: number;
    readonly marketReferenceValidForMs?: number;
    readonly collectionEndOffsetMs?: number;
    readonly removeTicker?: boolean;
    readonly liquidationMode?: "complete" | "zero" | "missing";
  } = {},
) {
  let market = dailyPrepareMarket();
  const cutoffMs = Date.parse(market.bundleCutoff);
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
  const tickerAgeMs = input.tickerAgeMs;
  if (tickerAgeMs !== undefined) {
    market = marketFixture({
      ...market,
      symbols: market.symbols.map((item) =>
        item.symbol === "BTCUSDT" && item.ticker !== undefined
          ? {
              ...item,
              ticker: {
                ...item.ticker,
                observedAt: requireFixture(
                  parseUtcTimestamp(
                    new Date(cutoffMs - tickerAgeMs).toISOString(),
                  ),
                ),
              },
            }
          : item,
      ),
    });
  }
  if (input.collectionEndOffsetMs !== undefined) {
    market = marketFixture({
      ...market,
      collectionEndedAt: requireFixture(
        parseUtcTimestamp(
          new Date(cutoffMs + input.collectionEndOffsetMs).toISOString(),
        ),
      ),
    });
  }
  if (input.marketReferenceValidForMs !== undefined) {
    const { evidence: _evidence, ...marketWithoutEvidence } = market;
    void _evidence;
    market = marketFixture(
      marketWithoutEvidence,
      input.marketReferenceValidForMs,
    );
  }
  const liquidation = dailyPrepareLiquidationV3(
    market,
    composition.selectedAsset,
    input.liquidationMode,
  ).bundle;
  const analytics = requireFixture(
    createAnalyticsEvidenceBundle({
      market,
      liquidation,
      profile: composition.analyticsProfile,
      featuresVersion: composition.analyticsFeaturesVersion,
    }),
  );
  const evaluationTime = new Date(
    cutoffMs + (input.evaluationOffsetMs ?? 3_000),
  ).toISOString();
  const shadow = requireFixture(
    createShadowMarketIntelligence({
      market,
      liquidation,
      analytics,
      symbol: "BTCUSDT",
      evaluationTime,
    }),
  );
  return { market, liquidation, analytics, evaluationTime, shadow };
}

function assess(
  fixture: ReturnType<typeof shadowQualityFixture>,
  shadow: ShadowMarketIntelligenceBundle = fixture.shadow,
) {
  return createShadowQualityAssessment({
    market: fixture.market,
    analytics: fixture.analytics,
    liquidation: fixture.liquidation,
    evaluationTime: fixture.evaluationTime,
    shadow,
  });
}

function rehashShadow(
  bundle: ShadowMarketIntelligenceBundle,
  update: (
    payload: Omit<ShadowMarketIntelligenceBundle, "contentHash">,
  ) => Omit<ShadowMarketIntelligenceBundle, "contentHash">,
): ShadowMarketIntelligenceBundle {
  const { contentHash: _oldHash, ...payload } = bundle;
  void _oldHash;
  const updated = update(payload);
  return {
    ...updated,
    contentHash: requireFixture(hashCanonical(updated)),
  };
}

function coreQuality(fixture: ReturnType<typeof shadowQualityFixture>) {
  const liquidationHash = requireFixture(hashCanonical(fixture.liquidation));
  const evidenceRef = requireFixture(
    createLiquidationEvidenceRef(fixture.liquidation, liquidationHash, 300_000),
  );
  return assessDataQuality({
    profile: composition.qualityProfile,
    sources: [
      { role: "market", value: fixture.market },
      { role: "analytics", value: fixture.analytics },
      {
        role: "liquidation",
        value: fixture.liquidation,
        evidenceRef,
      },
    ],
    bundleCutoff: fixture.market.bundleCutoff,
    evaluationTime: fixture.evaluationTime,
  });
}

test("valid source facts receive a deterministic versioned shadow assessment", () => {
  const fixture = shadowQualityFixture();
  const first = assess(fixture);
  const second = assess(fixture);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(first.value.schemaVersion, "shadow-quality-assessment/v1");
  assert.equal(first.value.profileVersion, "shadow-quality/v1");
  assert.equal(first.value.status, "accepted");
  assert.equal(first.value.contentHash, second.value.contentHash);
  assert.ok(
    first.value.observationDispositions.every(
      (item) =>
        item.disposition === "accepted" && item.reasonCodes.length === 0,
    ),
  );
  const trap = first.value.familyDispositions.find(
    (item) => item.family === "trap",
  );
  assert.ok(trap);
  assert.deepEqual(
    trap.acceptedObservationIds,
    fixture.shadow.families[3]?.observationIds,
  );
  assert.deepEqual(trap.rejectedObservationIds, []);
  const { contentHash: _hash, ...payload } = first.value;
  void _hash;
  assert.equal(requireFixture(hashCanonical(payload)), first.value.contentHash);
});

test("rehashed false observations and source references are rejected across every family", () => {
  const fixture = shadowQualityFixture();
  const falseObservation = rehashShadow(fixture.shadow, (payload) => ({
    ...payload,
    observations: payload.observations.map((item) =>
      item.id === "quote-spread"
        ? { ...item, value: fixtureDecimal("999") }
        : item,
    ),
  }));
  const falsified = assess(fixture, falseObservation);
  assert.equal(falsified.ok, true);
  if (!falsified.ok) return;
  assert.equal(falsified.value.status, "rejected");
  assert.ok(
    falsified.value.observationDispositions.every(
      (item) =>
        item.disposition === "rejected" &&
        item.reasonCodes.includes("SHADOW_REPLAY_MISMATCH"),
    ),
  );
  assert.ok(
    falsified.value.familyDispositions.every(
      (family) => family.acceptedObservationIds.length === 0,
    ),
  );

  const wrongModel = rehashShadow(fixture.shadow, (payload) => ({
    ...payload,
    modelVersion: "untrusted-model/v9" as typeof payload.modelVersion,
  }));
  const untrusted = assess(fixture, wrongModel);
  assert.equal(untrusted.ok, true);
  if (!untrusted.ok) return;
  assert.ok(
    untrusted.value.observationDispositions.every(
      (item) =>
        item.disposition === "rejected" &&
        item.reasonCodes.includes("UNTRUSTED_EVIDENCE"),
    ),
  );
  const noTickerFixture = shadowQualityFixture({
    removeTicker: true,
    liquidationMode: "missing",
  });
  const noTickerUntrusted = assess(
    noTickerFixture,
    rehashShadow(noTickerFixture.shadow, (payload) => ({
      ...payload,
      modelVersion: "untrusted-model/v9" as typeof payload.modelVersion,
    })),
  );
  assert.equal(noTickerUntrusted.ok, true);
  if (!noTickerUntrusted.ok) return;
  const unavailableLiquidity = noTickerUntrusted.value.familyDispositions.find(
    (item) => item.family === "liquidity-stress",
  );
  assert.equal(unavailableLiquidity?.status, "unavailable");
  assert.ok(unavailableLiquidity?.reasonCodes.includes("UNTRUSTED_EVIDENCE"));
  const wrongProducer = rehashShadow(fixture.shadow, (payload) => ({
    ...payload,
    producer: "untrusted-producer/v1" as typeof payload.producer,
  }));
  const untrustedProducer = assess(fixture, wrongProducer);
  assert.equal(untrustedProducer.ok, true);
  if (!untrustedProducer.ok) return;
  assert.ok(
    untrustedProducer.value.observationDispositions.every((item) =>
      item.reasonCodes.includes("UNTRUSTED_EVIDENCE"),
    ),
  );

  const wrongSourceReference = rehashShadow(fixture.shadow, (payload) => ({
    ...payload,
    sourceManifest: {
      ...payload.sourceManifest,
      market: {
        ...payload.sourceManifest.market,
        bundleHash:
          `sha256:${"0".repeat(64)}` as typeof payload.sourceManifest.market.bundleHash,
      },
    },
  }));
  const wrongSource = assess(fixture, wrongSourceReference);
  assert.equal(wrongSource.ok, true);
  if (!wrongSource.ok) return;
  assert.ok(
    wrongSource.value.observationDispositions.every(
      (item) => item.disposition === "rejected",
    ),
  );

  const differentRun = dailyPrepareMarket("different-shadow-run");
  const mixedRun = createShadowQualityAssessment({
    market: differentRun,
    analytics: fixture.analytics,
    liquidation: fixture.liquidation,
    evaluationTime: fixture.evaluationTime,
    shadow: fixture.shadow,
  });
  assert.equal(mixedRun.ok, false);
});

test("canonical bundle freshness expires at 300000 ms and honors an earlier source ref expiry", () => {
  const fresh = assess(shadowQualityFixture({ evaluationOffsetMs: 299_999 }));
  assert.equal(fresh.ok, true);
  if (!fresh.ok) return;
  assert.equal(fresh.value.status, "accepted");

  const expired = assess(shadowQualityFixture({ evaluationOffsetMs: 300_000 }));
  assert.equal(expired.ok, true);
  if (!expired.ok) return;
  assert.equal(expired.value.status, "rejected");
  assert.ok(
    expired.value.observationDispositions.every((item) =>
      item.reasonCodes.includes("STALE_EVIDENCE"),
    ),
  );

  const earlierFresh = assess(
    shadowQualityFixture({
      evaluationOffsetMs: 99_999,
      marketReferenceValidForMs: 100_000,
    }),
  );
  assert.equal(earlierFresh.ok, true);
  if (!earlierFresh.ok) return;
  assert.equal(earlierFresh.value.status, "accepted");

  const earlierExpired = assess(
    shadowQualityFixture({
      evaluationOffsetMs: 100_000,
      marketReferenceValidForMs: 100_000,
    }),
  );
  assert.equal(earlierExpired.ok, true);
  if (!earlierExpired.ok) return;
  assert.equal(earlierExpired.value.status, "rejected");
  const analyticsSource = earlierExpired.value.sourceDispositions.find(
    (item) => item.role === "analytics",
  );
  assert.equal(analyticsSource?.disposition, "rejected");
  assert.ok(analyticsSource?.reasonCodes.includes("STALE_EVIDENCE"));
});

test("ticker freshness rejects stale quote facts without refreshing them or expiring historical windows", () => {
  const at299999 = assess(
    shadowQualityFixture({ evaluationOffsetMs: 1_000, tickerAgeMs: 298_999 }),
  );
  assert.equal(at299999.ok, true);
  if (!at299999.ok) return;
  assert.equal(
    at299999.value.observationDispositions.find(
      (item) => item.observationId === "quote-spread",
    )?.disposition,
    "accepted",
  );
  assert.equal(
    at299999.value.observationDispositions.find(
      (item) => item.observationId === "return-3d",
    )?.disposition,
    "accepted",
  );

  const at300000Fixture = shadowQualityFixture({
    evaluationOffsetMs: 1_000,
    tickerAgeMs: 299_000,
  });
  const at300000 = assess(at300000Fixture);
  assert.equal(at300000.ok, true);
  if (!at300000.ok) return;
  for (const id of [
    "funding-current",
    "quote-spread",
    "quote-relative-spread",
  ]) {
    const finding:
      ShadowQualityAssessment["observationDispositions"][number] | undefined =
      at300000.value.observationDispositions.find(
        (item) => item.observationId === id,
      );
    assert.equal(finding?.disposition, "rejected");
    assert.ok(finding?.reasonCodes.includes("STALE_EVIDENCE"));
  }
  assert.equal(
    at300000.value.observationDispositions.find(
      (item) => item.observationId === "return-3d",
    )?.disposition,
    "accepted",
  );

  const refreshedWrapper = rehashShadow(at300000Fixture.shadow, (payload) => ({
    ...payload,
    asOf: at300000Fixture.evaluationTime as typeof payload.asOf,
  }));
  const refreshed = assess(at300000Fixture, refreshedWrapper);
  assert.equal(refreshed.ok, true);
  if (!refreshed.ok) return;
  assert.equal(
    refreshed.value.observationDispositions.find(
      (item) => item.observationId === "quote-spread",
    )?.disposition,
    "rejected",
  );
  assert.ok(
    refreshed.value.observationDispositions
      .find((item) => item.observationId === "quote-spread")
      ?.reasonCodes.includes("STALE_EVIDENCE"),
  );
});

test("future cutoff and excessive collection skew are rejected without extending the cutoff", () => {
  const fixture = shadowQualityFixture();
  const futureCutoff = createShadowQualityAssessment({
    market: fixture.market,
    analytics: fixture.analytics,
    liquidation: fixture.liquidation,
    evaluationTime: new Date(
      Date.parse(fixture.market.bundleCutoff) - 1,
    ).toISOString(),
    shadow: fixture.shadow,
  });
  assert.equal(futureCutoff.ok, false);

  const skewed = assess(
    shadowQualityFixture({
      evaluationOffsetMs: 3_000,
      collectionEndOffsetMs: 4_001,
    }),
  );
  assert.equal(skewed.ok, true);
  if (!skewed.ok) return;
  assert.ok(
    skewed.value.observationDispositions.every((item) =>
      item.reasonCodes.includes("METADATA_CLOCK_SKEW"),
    ),
  );
});

test("shadow assessment calls do not alter the core quality result", () => {
  const fixture = shadowQualityFixture();
  const before = coreQuality(fixture);
  assert.equal(before.ok, true);
  if (!before.ok) return;

  const accepted = assess(fixture);
  const rehashedFalse = rehashShadow(fixture.shadow, (payload) => ({
    ...payload,
    observations: payload.observations.map((item) =>
      item.id === "return-24h"
        ? { ...item, value: fixtureDecimal("777") }
        : item,
    ),
  }));
  const rejected = assess(fixture, rehashedFalse);
  assert.equal(accepted.ok, true);
  assert.equal(rejected.ok, true);

  const after = coreQuality(fixture);
  assert.deepEqual(after, before);

  const partialFixture = shadowQualityFixture({
    removeTicker: true,
    liquidationMode: "missing",
  });
  const partialCore = coreQuality(partialFixture);
  assert.equal(partialCore.ok, true);
  if (!partialCore.ok) return;
  const partialShadow = assess(partialFixture);
  assert.equal(partialShadow.ok, true);
  if (!partialShadow.ok) return;
  assert.ok(
    partialShadow.value.familyDispositions.some(
      (item) =>
        item.family === "liquidity-stress" && item.status === "unavailable",
    ),
  );
  assert.ok(
    partialShadow.value.observationDispositions.some(
      (item) =>
        item.observationId === "liquidation-12h-total-usd" &&
        item.disposition === "accepted",
    ),
  );
  assert.deepEqual(coreQuality(partialFixture), partialCore);
});
