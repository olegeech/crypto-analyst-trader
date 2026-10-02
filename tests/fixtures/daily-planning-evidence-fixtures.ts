import {
  marketFixture,
  analyticsFixture,
  fixtureDecimal,
} from "./data-quality-fixtures.js";
import { createInstrumentConstraints } from "../../src/domain/market/instrument-constraints.js";
import { createQualityProfile } from "../../src/domain/quality/quality-profile.js";
import { assessDataQuality } from "../../src/domain/quality/assess-data-quality.js";
import { createDataQualityBoundary } from "../../src/application/data-quality-assessment.js";
import type { Result } from "../../src/domain/shared/result.js";

export function requireDailyFixture<T>(value: Result<T>): T {
  if (!value.ok) throw new Error(value.error.message);
  return value.value;
}

/** Non-calibrated fixture facts, never a runtime trading preset. */
export function dailyMarketFixture(bounds = true) {
  const base = marketFixture();
  const constraints = requireDailyFixture(
    createInstrumentConstraints({
      instrument: "BTCUSDT",
      version: "fixture/static-bounds/v1",
      priceTickSize: "0.1",
      quantityStep: "0.01",
      minQuantity: "0.01",
      minNotional: "1",
      ...(bounds
        ? { minPrice: "0.1", maxPrice: "10000", maxLimitQuantity: "100" }
        : {}),
    }),
  );
  return marketFixture({
    symbols: base.symbols.map((row) =>
      row.symbol !== "BTCUSDT"
        ? row
        : {
            ...row,
            instrument: {
              symbol: "BTCUSDT",
              status: "trading",
              contractType: "LinearPerpetual",
              baseCoin: "BTC",
              quoteCoin: "USDT",
              settleCoin: "USDT",
              constraints,
              fundingInterval: 480,
              sourceTimestamp: base.bundleCutoff,
            },
            ticker: {
              observedAt: base.bundleCutoff,
              bid: fixtureDecimal("102"),
              ask: fixtureDecimal("102.1"),
              last: fixtureDecimal("102"),
            },
          },
    ),
  });
}

export function dailyQualityProfileFixture() {
  return {
    schemaVersion: "quality-profile/v1",
    profileVersion: "fixture-daily-v1",
    roles: [
      { id: "market", required: false, maxAgeMs: 60000 },
      { id: "analytics", required: true, maxAgeMs: 60000 },
      { id: "analytics:atr", required: true, maxAgeMs: 60000 },
      { id: "analytics:return", required: true, maxAgeMs: 60000 },
    ],
    metadataSkewMs: 1000,
    trust: [],
    penalties: [
      {
        reasonCode: "INCOMPLETE_EVIDENCE",
        confidenceImpactGroup: "market",
        penalty: "15",
      },
    ],
  };
}

export function dailyEvidenceFixture(bounds = true) {
  const market = dailyMarketFixture(bounds);
  const analytics = analyticsFixture(market, {
    profile: {
      schemaVersion: "analytics-profile/v1",
      features: [
        {
          id: "atr",
          kind: "atr",
          symbol: "BTCUSDT",
          interval: "1h",
          period: 1,
          required: true,
        },
        {
          id: "return",
          kind: "close-return",
          symbol: "BTCUSDT",
          interval: "1h",
          periods: 1,
          required: true,
        },
      ],
      externalEvidence: [],
    },
  });
  const sources = [
    { role: "market" as const, value: market },
    { role: "analytics" as const, value: analytics },
  ];
  const assessment = requireDailyFixture(
    assessDataQuality({
      profile: requireDailyFixture(
        createQualityProfile(dailyQualityProfileFixture()),
      ),
      sources,
      bundleCutoff: market.bundleCutoff,
      evaluationTime: market.bundleCutoff,
    }),
  );
  const boundary = requireDailyFixture(
    createDataQualityBoundary({
      qualityProfile: dailyQualityProfileFixture(),
      issuer: "fixture-daily",
    }),
  );
  return { market, analytics, sources, assessment, boundary };
}
