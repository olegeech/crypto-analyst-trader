import assert from "node:assert/strict";
import test from "node:test";
import { prepareDailyPlanningInputs } from "../src/domain/planning/daily-planning-inputs.js";
import { dailyInputFixture } from "./fixtures/daily-planning-policy-fixtures.js";
export { dailyInputFixture } from "./fixtures/daily-planning-policy-fixtures.js";
import { createDataQualityAssessment } from "../src/domain/quality/data-quality-assessment.js";
import {
  analyticsFixture,
  liquidationFixture,
  liquidationFixtureRef,
} from "./fixtures/data-quality-fixtures.js";
import {
  requireDailyFixture,
  dailyQualityProfileFixture,
} from "./fixtures/daily-planning-evidence-fixtures.js";
import { createQualityProfile } from "../src/domain/quality/quality-profile.js";
import { assessDataQuality } from "../src/domain/quality/assess-data-quality.js";
import { rehydrateAnalyticsEvidenceBundle } from "../src/domain/analytics/analytics-evidence-bundle.js";

test("daily inputs select only exact assessed source and output identities", () => {
  const raw = dailyInputFixture();
  const result = prepareDailyPlanningInputs(raw);
  assert.ok(result.ok, result.ok ? "" : result.error.message);
  assert.equal(result.value.evidenceConfidence.toString(), "85");
  assert.equal(result.value.atr.toString(), "4");
  assert.equal(result.value.selectors[0]?.value?.toString(), "2");
  assert.ok(Object.isFrozen(result.value));
  assert.ok(result.value.constraints.maxPrice);
});
test("swapped evidence, rejected outputs and missing mandatory ATR fail closed", () => {
  const raw = dailyInputFixture();
  for (const altered of [
    { ...raw, market: { ...raw.market, runId: "swapped" } },
    { ...raw, assessment: { ...raw.assessment, contentHash: "a".repeat(64) } },
    { ...raw, analytics: { ...raw.analytics, contentHash: "a".repeat(64) } },
    {
      ...raw,
      planningPolicy: {
        ...raw.planningPolicy,
        atrSelector: {
          ...raw.planningPolicy.atrSelector,
          requestId: "missing",
        },
      },
    },
    { ...raw, symbol: "ETHUSDT" },
  ])
    assert.equal(prepareDailyPlanningInputs(altered).ok, false);
});

test("accepted parent cannot override rejected output, and absent confidence is not defaulted", () => {
  const raw = dailyInputFixture();
  const { contentHash: _hash, ...payload } = raw.assessment;
  void _hash;
  const rejected = createDataQualityAssessment({
    ...payload,
    dispositions: payload.dispositions.map((row) =>
      row.role === "analytics:return"
        ? { ...row, disposition: "rejected" as const }
        : row,
    ),
  });
  assert.ok(rejected.ok);
  assert.equal(
    prepareDailyPlanningInputs({ ...raw, assessment: rejected.value }).ok,
    false,
  );
  const { evidenceConfidence: _confidence, ...noConfidence } = payload;
  void _confidence;
  const missing = createDataQualityAssessment(noConfidence);
  assert.ok(missing.ok);
  const result = prepareDailyPlanningInputs({
    ...raw,
    assessment: missing.value,
  });
  assert.ok(!result.ok);
  assert.equal(result.error.message, "MISSING_EVIDENCE_CONFIDENCE");
});

test("optional absent and rejected selectors remain unavailable rather than zero", () => {
  const raw = dailyInputFixture();
  const decisionPolicy = {
    ...raw.decisionPolicy,
    selectors: [
      {
        ...raw.decisionPolicy.selectors[0]!,
        requestId: "absent",
        required: false,
      },
    ],
  };
  const result = prepareDailyPlanningInputs({ ...raw, decisionPolicy });
  assert.ok(result.ok);
  assert.equal(result.value.selectors[0]?.status, "unavailable");
  assert.equal(result.value.selectors[0]?.value, undefined);
  // Static upper bounds are needed only at ADD compilation, not evidence selection.
  assert.ok(prepareDailyPlanningInputs(dailyInputFixture(false)).ok);
});

test("proven explicit-zero liquidation remains available but absent imbalance is never fabricated", () => {
  const raw = dailyInputFixture();
  const observations = Array.from({ length: 24 }, (_, index) => ({
    timestamp: new Date(
      Date.parse(raw.market.bundleCutoff) - (24 - index) * 3600000,
    ).toISOString(),
    longUsd: "0",
    shortUsd: "0",
  }));
  const liquidation = liquidationFixture(raw.market, {
    coverageProof: "complete",
    historyProof: "complete",
    status: "complete",
    diagnostics: [],
    targets: (["BTC", "ETH", "SOL", "DOGE"] as const).map((asset) => ({
      asset,
      constituents: [
        {
          providerSymbol: `${asset}-fixture`,
          exchange: "Bybit",
          symbolOnExchange: `${asset}USDT`,
          baseAsset: asset,
          quoteAsset: "USDT",
          isPerpetual: true,
          marginType: "linear",
          expireAt: 0,
          notionalDenominatedIn: "USD",
          observations,
        },
      ],
    })),
  });
  const analytics = analyticsFixture(raw.market, {
    liquidation,
    profile: {
      ...raw.analytics.profile,
      features: [
        ...raw.analytics.profile.features,
        {
          id: "liquidation",
          kind: "liquidation-window",
          asset: "BTC",
          windowHours: 24,
          required: false,
        },
      ],
    },
  });
  const restored = rehydrateAnalyticsEvidenceBundle(analytics);
  assert.ok(restored.ok, restored.ok ? "" : restored.error.message);
  const sources = [
    { role: "market" as const, value: raw.market },
    { role: "analytics" as const, value: analytics },
    {
      role: "liquidation" as const,
      value: liquidation,
      evidenceRef: liquidationFixtureRef(liquidation),
    },
  ];
  const profile = requireDailyFixture(
    createQualityProfile({
      ...dailyQualityProfileFixture(),
      roles: [
        ...dailyQualityProfileFixture().roles,
        { id: "liquidation", required: false, maxAgeMs: 60000 },
        { id: "analytics:liquidation", required: false, maxAgeMs: 60000 },
      ],
    }),
  );
  const assessment = requireDailyFixture(
    assessDataQuality({
      profile,
      sources,
      bundleCutoff: raw.market.bundleCutoff,
      evaluationTime: raw.market.bundleCutoff,
    }),
  );
  assert.equal(
    assessment.qualityGate,
    "OK",
    JSON.stringify(assessment.findings),
  );
  const makePolicy = (field: string) => ({
    ...raw.decisionPolicy,
    selectors: [
      {
        id: "return",
        source: "native",
        requestId: "liquidation",
        kind: "liquidation-window",
        asset: "BTC",
        field,
        required: false,
      },
    ],
  });
  const zero = requireDailyFixture(
    prepareDailyPlanningInputs({
      ...raw,
      liquidation,
      analytics,
      assessment,
      decisionPolicy: makePolicy("totalUsd"),
    }),
  );
  assert.equal(zero.selectors[0]?.status, "available");
  assert.equal(zero.selectors[0]?.value?.toString(), "0");
  const imbalance = requireDailyFixture(
    prepareDailyPlanningInputs({
      ...raw,
      liquidation,
      analytics,
      assessment,
      decisionPolicy: makePolicy("imbalance"),
    }),
  );
  assert.equal(imbalance.selectors[0]?.status, "absent");
  assert.equal(imbalance.selectors[0]?.value, undefined);
});
