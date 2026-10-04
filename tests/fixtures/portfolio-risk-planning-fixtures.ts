import { createDailyDecisionPlan } from "../../src/domain/planning/daily-decision-plan.js";
import { assessDataQuality } from "../../src/domain/quality/assess-data-quality.js";
import { createQualityProfile } from "../../src/domain/quality/quality-profile.js";
import { parseUtcTimestamp } from "../../src/domain/shared/time.js";
import {
  fixtureDecimal,
  marketFixture,
  analyticsFixture,
} from "./data-quality-fixtures.js";
import {
  dailyQualityProfileFixture,
  requireDailyFixture,
} from "./daily-planning-evidence-fixtures.js";
import { dailyDecisionInputFixture } from "./daily-planning-policy-fixtures.js";
import { portfolioRiskMarketFixture } from "./portfolio-risk-fixtures.js";

export function portfolioRiskPlanningFixture(
  options: {
    readonly recommendation?: "ADD_LONG" | "REDUCE_LONG" | "HOLD_LONG";
    readonly fundingRate?: string;
    readonly tickerObservedAt?: string;
    readonly marketMaxAgeMs?: number;
    readonly planningLevels?: readonly {
      readonly atrOffset: string;
      readonly allocationWeight: string;
      readonly takeProfitAtrDistance: string;
    }[];
  } = {},
) {
  const recommendation = options.recommendation ?? "ADD_LONG";
  const raw = dailyDecisionInputFixture();
  if (options.planningLevels !== undefined)
    raw.planningPolicy = {
      ...raw.planningPolicy,
      levels: options.planningLevels.map((level) => ({ ...level })),
    };
  const originalMarket = portfolioRiskMarketFixture();
  const { evidence: _evidence, ...marketPayload } = originalMarket;
  void _evidence;
  const symbols = originalMarket.symbols.map((row) =>
    row.symbol !== "BTCUSDT" || row.ticker === undefined
      ? row
      : {
          ...row,
          ticker: {
            ...row.ticker,
            ...(options.fundingRate === undefined
              ? {}
              : { fundingRate: fixtureDecimal(options.fundingRate) }),
            ...(options.tickerObservedAt === undefined
              ? {}
              : {
                  observedAt: requireDailyFixture(
                    parseUtcTimestamp(options.tickerObservedAt),
                  ),
                }),
          },
        },
  );
  const market = marketFixture({ ...marketPayload, symbols });
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
  const qualityProfileInput = dailyQualityProfileFixture();
  const marketMaxAgeMs = options.marketMaxAgeMs;
  if (marketMaxAgeMs !== undefined) {
    qualityProfileInput.roles = qualityProfileInput.roles.map((role) =>
      role.id === "market" ? { ...role, maxAgeMs: marketMaxAgeMs } : role,
    );
  }
  const qualityProfile = requireDailyFixture(
    createQualityProfile(qualityProfileInput),
  );
  const assessment = requireDailyFixture(
    assessDataQuality({
      profile: qualityProfile,
      sources: [
        { role: "market", value: market },
        { role: "analytics", value: analytics },
      ],
      bundleCutoff: market.bundleCutoff,
      evaluationTime: market.bundleCutoff,
    }),
  );
  const decisionPolicy = {
    ...raw.decisionPolicy,
    groups: raw.decisionPolicy.groups.map((group) => ({
      ...group,
      rules: group.rules.map((rule) => ({
        ...rule,
        target: recommendation,
        ...(recommendation === "HOLD_LONG"
          ? {
              conditions: rule.conditions.map((condition) => ({
                ...condition,
                threshold: "1000",
              })),
            }
          : {}),
      })),
    })),
  };
  const dailyPlan = requireDailyFixture(
    createDailyDecisionPlan({
      ...raw,
      market,
      analytics,
      assessment,
      decisionPolicy,
    }),
  );
  return { dailyPlan, qualityProfile, market, analytics, assessment };
}
