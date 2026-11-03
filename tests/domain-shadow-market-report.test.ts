import assert from "node:assert/strict";
import test from "node:test";
import { createAnalyticsEvidenceBundle } from "../src/domain/analytics/analytics-evidence-bundle.js";
import { createProvisionalM1Composition } from "../src/application/policies/provisional-m1.js";
import { hashCanonical } from "../src/domain/identity/canonical-serialization.js";
import {
  createShadowMarketReportV1,
  createTrustedShadowMarketReportV1,
  rehydrateShadowMarketReport,
} from "../src/domain/review/shadow-market-report.js";
import { createPreparedShadowContextV1 } from "../src/domain/review/prepared-shadow-context.js";
import { requireDailyFixture as value } from "./fixtures/daily-planning-evidence-fixtures.js";
import {
  DAILY_PREPARE_RUN_ID,
  DAILY_PREPARE_TIME,
  dailyPrepareLiquidationV3,
  dailyPrepareMarket,
} from "./fixtures/daily-prepare-fixtures.js";

function reportFixture() {
  const market = dailyPrepareMarket(DAILY_PREPARE_RUN_ID);
  const liquidation = dailyPrepareLiquidationV3(market, "BTC");
  const composition = value(
    createProvisionalM1Composition({ symbol: "BTCUSDT", allocation: "10" }),
  );
  const analytics = value(
    createAnalyticsEvidenceBundle({
      market,
      liquidation: liquidation.bundle,
      profile: composition.analyticsProfile,
      featuresVersion: composition.analyticsFeaturesVersion,
    }),
  );
  return value(
    createShadowMarketReportV1({
      environment: "demo",
      market,
      liquidation: liquidation.bundle,
      analytics,
      symbol: "BTCUSDT",
      evaluationTime: DAILY_PREPARE_TIME,
    }),
  );
}

test("shadow report replays source-bound context and rejects a rehashed false assessment", () => {
  const report = reportFixture();
  assert.equal(report.schemaVersion, "shadow-market-report/v1");
  assert.equal(report.context.status, "recorded");
  assert.equal(rehydrateShadowMarketReport(report).ok, true);

  const forgedPayload = {
    ...report,
    context: {
      ...report.context,
      reasonCodes: ["FABRICATED_SHADOW_REASON"],
    },
  };
  const { contentHash: _oldHash, ...payload } = forgedPayload;
  void _oldHash;
  const forged = { ...payload, contentHash: value(hashCanonical(payload)) };
  assert.equal(rehydrateShadowMarketReport(forged).ok, false);
});

test("shadow-market-report/v1 pins prepared shadow context creation and replay", () => {
  const report = reportFixture();
  const pinnedContext = createPreparedShadowContextV1({
    market: report.sources.market,
    analytics: report.sources.analytics,
    liquidation: report.sources.liquidation,
    symbol: report.symbol,
    evaluationTime: report.evaluationTime,
  });
  assert.equal(pinnedContext.ok, true);
  if (!pinnedContext.ok) return;
  assert.deepEqual(report.context, pinnedContext.value);

  const replayed = rehydrateShadowMarketReport(report);
  assert.equal(replayed.ok, true);
  if (!replayed.ok) return;
  assert.deepEqual(replayed.value.context, pinnedContext.value);
});

test("trusted shadow report creation refuses a non-v1 prepared context", () => {
  const report = reportFixture();
  const result = createTrustedShadowMarketReportV1({
    environment: report.environment,
    market: report.sources.market,
    liquidation: report.sources.liquidation,
    analytics: report.sources.analytics,
    symbol: report.symbol,
    evaluationTime: report.evaluationTime,
    context: {
      ...report.context,
      schemaVersion: "prepared-shadow-context/v2",
    } as unknown as typeof report.context,
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "UNSUPPORTED_CONTRACT");
});

test("a thrown shadow builder becomes an unavailable supplemental context", () => {
  const report = reportFixture();
  const input = {
    market: report.sources.market,
    analytics: report.sources.analytics,
    liquidation: report.sources.liquidation,
    symbol: report.symbol,
    evaluationTime: report.evaluationTime,
  };
  const throwingInput = new Proxy(input, {
    get(target, property, receiver) {
      if (property === "market") throw new Error("simulated shadow failure");
      return Reflect.get(target, property, receiver) as unknown;
    },
  });

  const result = createPreparedShadowContextV1(throwingInput);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.status, "unavailable");
  assert.deepEqual(result.value.reasonCodes, ["SHADOW_CONTEXT_UNAVAILABLE"]);
});

test("persisted shadow reports refuse prepared-context and model identity drift", () => {
  const report = reportFixture();
  const driftedContexts = [
    {
      ...report.context,
      schemaVersion: "prepared-shadow-context/v2",
    },
    {
      ...report.context,
      model: {
        ...report.context.model,
        modelVersion: "existing-evidence-shadow/v2",
      },
    },
  ];

  for (const context of driftedContexts) {
    const { contentHash: _oldHash, ...payload } = { ...report, context };
    void _oldHash;
    const drifted = {
      ...payload,
      contentHash: value(hashCanonical(payload)),
    };
    const replayed = rehydrateShadowMarketReport(drifted);
    assert.equal(replayed.ok, false);
    if (!replayed.ok) assert.equal(replayed.error.code, "UNSUPPORTED_CONTRACT");
  }
});

test("shadow report refuses unknown schema versions before replaying sources", () => {
  const report = reportFixture();
  const { contentHash: _oldHash, ...payload } = {
    ...report,
    schemaVersion: "shadow-market-report/v2",
    futureField: "present in v2",
    sources: { market: null, liquidation: null, analytics: null },
  };
  void _oldHash;
  const unsupported = {
    ...payload,
    contentHash: value(hashCanonical(payload)),
  };

  const replayed = rehydrateShadowMarketReport(unsupported);
  assert.equal(replayed.ok, false);
  if (!replayed.ok) assert.equal(replayed.error.code, "UNSUPPORTED_CONTRACT");
});

test("malformed report and context version identities are invalid", () => {
  const report = reportFixture();
  const malformedPayloads = [
    (() => {
      const { contentHash: _oldHash, ...payload } = {
        ...report,
        schemaVersion: null,
      };
      void _oldHash;
      return { ...payload, contentHash: value(hashCanonical(payload)) };
    })(),
    (() => {
      const { contentHash: _oldHash, ...payload } = {
        ...report,
        context: null,
      };
      void _oldHash;
      return { ...payload, contentHash: value(hashCanonical(payload)) };
    })(),
  ];

  for (const malformed of malformedPayloads) {
    const result = rehydrateShadowMarketReport(malformed);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "INVALID_EVIDENCE");
  }
});

test("shadow report preserves unsupported analytics and liquidation source contracts", () => {
  const report = reportFixture();
  const candidates = [
    {
      ...report,
      sources: {
        ...report.sources,
        analytics: {
          ...report.sources.analytics,
          schemaVersion:
            "analytics-evidence/v2" as typeof report.sources.analytics.schemaVersion,
        },
      },
    },
    {
      ...report,
      sources: {
        ...report.sources,
        liquidation: {
          ...report.sources.liquidation,
          schemaVersion:
            "liquidation-evidence/v4" as typeof report.sources.liquidation.schemaVersion,
        },
      },
    },
    {
      ...report,
      sources: {
        ...report.sources,
        market: {
          ...report.sources.market,
          schemaVersion:
            "market-evidence/v2" as typeof report.sources.market.schemaVersion,
        },
      },
    },
  ];

  for (const candidate of candidates) {
    const { contentHash: _oldHash, ...payload } = candidate;
    void _oldHash;
    const unsupported = {
      ...payload,
      contentHash: value(hashCanonical(payload)),
    };
    const replayed = rehydrateShadowMarketReport(unsupported);
    assert.equal(replayed.ok, false);
    if (!replayed.ok) assert.equal(replayed.error.code, "UNSUPPORTED_CONTRACT");
  }
});

test("malformed nested source versions remain invalid beside unsupported versions", () => {
  const report = reportFixture();
  const candidates: unknown[] = [
    {
      ...report,
      sources: {
        ...report.sources,
        market: { ...report.sources.market, schemaVersion: null },
      },
    },
    {
      ...report,
      sources: {
        ...report.sources,
        liquidation: { ...report.sources.liquidation, schemaVersion: null },
      },
    },
    {
      ...report,
      sources: {
        ...report.sources,
        analytics: { ...report.sources.analytics, schemaVersion: null },
      },
    },
    {
      ...report,
      sources: {
        ...report.sources,
        analytics: { ...report.sources.analytics, featuresVersion: null },
      },
    },
    {
      ...report,
      sources: {
        ...report.sources,
        market: {
          ...report.sources.market,
          schemaVersion: "market-evidence/v2",
        },
        liquidation: { ...report.sources.liquidation, schemaVersion: null },
      },
    },
  ];

  for (const candidate of candidates) {
    const { contentHash: _oldHash, ...payload } = candidate as Record<
      string,
      unknown
    >;
    void _oldHash;
    const malformed = {
      ...payload,
      contentHash: value(hashCanonical(payload)),
    };
    const replayed = rehydrateShadowMarketReport(malformed);
    assert.equal(replayed.ok, false);
    if (!replayed.ok) assert.equal(replayed.error.code, "INVALID_EVIDENCE");
  }
});

test("malformed top-level identities are invalid beside future source versions", () => {
  const report = reportFixture();
  const futureMarket = {
    ...report.sources.market,
    schemaVersion: "market-evidence/v2",
  };
  const candidates: unknown[] = [
    {
      ...report,
      sources: { ...report.sources, market: futureMarket },
      symbol: "",
    },
    {
      ...report,
      sources: { ...report.sources, market: futureMarket },
      evaluationTime: "not-a-timestamp",
    },
  ];

  for (const candidate of candidates) {
    const { contentHash: _oldHash, ...payload } = candidate as Record<
      string,
      unknown
    >;
    void _oldHash;
    const malformed = {
      ...payload,
      contentHash: value(hashCanonical(payload)),
    };
    const replayed = rehydrateShadowMarketReport(malformed);
    assert.equal(replayed.ok, false);
    if (!replayed.ok) assert.equal(replayed.error.code, "INVALID_EVIDENCE");
  }
});

test("unsupported context identity cannot hide invalid source evidence", () => {
  const report = reportFixture();
  const { contentHash: _oldHash, ...payload } = {
    ...report,
    context: {
      ...report.context,
      model: {
        ...report.context.model,
        modelVersion: "existing-evidence-shadow/v2",
      },
    },
    sources: { ...report.sources, market: null },
  };
  void _oldHash;
  const malformed = {
    ...payload,
    contentHash: value(hashCanonical(payload)),
  };

  const replayed = rehydrateShadowMarketReport(malformed);
  assert.equal(replayed.ok, false);
  if (!replayed.ok) assert.equal(replayed.error.code, "INVALID_EVIDENCE");
});

test("future source versions cannot hide a mismatched run or malformed v1 context", () => {
  const report = reportFixture();
  const futureLiquidation = {
    ...report.sources.liquidation,
    schemaVersion: "liquidation-evidence/v4",
  };
  const contextWithoutAssessment = { ...report.context } as Record<
    string,
    unknown
  >;
  delete contextWithoutAssessment.assessment;
  const candidates: unknown[] = [
    {
      ...report,
      runId: "other-run",
      sources: { ...report.sources, liquidation: futureLiquidation },
    },
    {
      ...report,
      sources: { ...report.sources, liquidation: futureLiquidation },
      context: { ...report.context, status: "invalid" },
    },
    {
      ...report,
      sources: { ...report.sources, liquidation: futureLiquidation },
      context: contextWithoutAssessment,
    },
  ];

  for (const candidate of candidates) {
    const { contentHash: _oldHash, ...payload } = candidate as Record<
      string,
      unknown
    >;
    void _oldHash;
    const malformed = {
      ...payload,
      contentHash: value(hashCanonical(payload)),
    };
    const replayed = rehydrateShadowMarketReport(malformed);
    assert.equal(replayed.ok, false);
    if (!replayed.ok) assert.equal(replayed.error.code, "INVALID_EVIDENCE");
  }
});

test("future source versions cannot hide mixed supported sources or context identity drift", () => {
  const report = reportFixture();
  assert.ok(report.context.shadow);
  const otherMarket = dailyPrepareMarket("different-run");
  const otherLiquidation = dailyPrepareLiquidationV3(otherMarket, "BTC");
  const futureAnalyticsPayload = {
    ...report.sources.analytics,
    featuresVersion: "analytics-features/v9",
  };
  const { contentHash: _oldAnalyticsHash, ...analyticsPayload } =
    futureAnalyticsPayload;
  void _oldAnalyticsHash;
  const futureAnalytics = {
    ...analyticsPayload,
    contentHash: value(hashCanonical(analyticsPayload)),
  };
  const candidates: unknown[] = [
    {
      ...report,
      sources: {
        ...report.sources,
        liquidation: otherLiquidation.bundle,
        analytics: futureAnalytics,
      },
    },
    {
      ...report,
      sources: {
        ...report.sources,
        liquidation: {
          ...report.sources.liquidation,
          schemaVersion: "liquidation-evidence/v4",
        },
      },
      context: {
        ...report.context,
        shadow: { ...report.context.shadow, runId: "different-run" },
      },
    },
    {
      ...report,
      runId: "other-run",
      sources: {
        ...report.sources,
        market: {
          ...report.sources.market,
          schemaVersion: "market-evidence/v2",
        },
      },
      context: {
        ...report.context,
        shadow: { ...report.context.shadow, runId: "other-run" },
      },
    },
  ];

  for (const candidate of candidates) {
    const { contentHash: _oldHash, ...payload } = candidate as Record<
      string,
      unknown
    >;
    void _oldHash;
    const malformed = {
      ...payload,
      contentHash: value(hashCanonical(payload)),
    };
    const replayed = rehydrateShadowMarketReport(malformed);
    assert.equal(replayed.ok, false);
    if (!replayed.ok) assert.equal(replayed.error.code, "INVALID_EVIDENCE");
  }
});

test("shadow report rejects mixed public source runs even if its outer hash is recomputed", () => {
  const report = reportFixture();
  const mixedPayload = {
    ...report,
    sources: {
      ...report.sources,
      liquidation: {
        ...report.sources.liquidation,
        runId: "different-run",
      },
    },
  };
  const { contentHash: _oldHash, ...payload } = mixedPayload;
  void _oldHash;
  const mixed = { ...payload, contentHash: value(hashCanonical(payload)) };
  assert.equal(rehydrateShadowMarketReport(mixed).ok, false);
});
