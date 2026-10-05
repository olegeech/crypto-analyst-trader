import { createProvisionalM1Composition } from "../../src/application/policies/provisional-m1.js";
import { createPreparedDailyPlan } from "../../src/domain/review/prepared-daily-plan.js";
import { evaluatePortfolioRiskPreflight } from "../../src/domain/risk/portfolio-risk-preflight.js";
import {
  portfolioRiskAccountInput,
  portfolioRiskPolicyInput,
  type portfolioRiskPosition,
} from "./portfolio-risk-fixtures.js";
import { portfolioRiskPlanningFixture } from "./portfolio-risk-planning-fixtures.js";
import { requireDailyFixture as value } from "./daily-planning-evidence-fixtures.js";
import { createAnalyticsEvidenceBundle } from "../../src/domain/analytics/analytics-evidence-bundle.js";
import { createDailyDecisionPlan } from "../../src/domain/planning/daily-decision-plan.js";
import { assessDataQuality } from "../../src/domain/quality/assess-data-quality.js";
import {
  MARKET_OHLCV_WINDOWS,
  MARKET_OPEN_INTEREST_WINDOWS,
  MARKET_FUNDING_WINDOW,
  marketIntervalMilliseconds,
} from "../../src/domain/market/market-evidence-windows.js";
import type {
  MarketEvidenceBundle,
  MarketSeriesInterval,
  OpenInterestInterval,
} from "../../src/domain/market/market-evidence-bundle.js";
import { parseUtcTimestamp } from "../../src/domain/shared/time.js";
import { fixtureDecimal, marketFixture } from "./data-quality-fixtures.js";

/** Full native cadence, never a production fallback. */
export function completeMarketFixture(
  base: MarketEvidenceBundle,
): MarketEvidenceBundle {
  const at = (offset: number) =>
    value(
      parseUtcTimestamp(
        new Date(Date.parse(base.bundleCutoff) - offset).toISOString(),
      ),
    );
  return marketFixture({
    ...base,
    status: "complete",
    diagnostics: [],
    symbols: base.symbols.map((s) => ({
      ...s,
      diagnostics: [],
      ticker: { ...base.symbols[0]!.ticker!, observedAt: base.bundleCutoff },
      ohlcv: (Object.keys(MARKET_OHLCV_WINDOWS) as MarketSeriesInterval[]).map(
        (interval) => ({
          interval,
          observations: Array.from(
            { length: MARKET_OHLCV_WINDOWS[interval] },
            (_, i) => ({
              timestamp: at(
                (MARKET_OHLCV_WINDOWS[interval] - i) *
                  marketIntervalMilliseconds(interval),
              ),
              open: fixtureDecimal("100"),
              high: fixtureDecimal("103"),
              low: fixtureDecimal("99"),
              close: fixtureDecimal(
                i === MARKET_OHLCV_WINDOWS[interval] - 1 ? "102" : "100",
              ),
              volume: fixtureDecimal("2"),
              turnover: fixtureDecimal("204"),
              closed: true,
            }),
          ),
        }),
      ),
      funding: Array.from({ length: MARKET_FUNDING_WINDOW }, (_, i) => ({
        timestamp: at((MARKET_FUNDING_WINDOW - 1 - i) * 480 * 60000),
        rate: fixtureDecimal("0"),
      })),
      openInterest: (
        Object.keys(MARKET_OPEN_INTEREST_WINDOWS) as OpenInterestInterval[]
      ).map((interval) => ({
        interval,
        observations: Array.from(
          { length: MARKET_OPEN_INTEREST_WINDOWS[interval] },
          (_, i) => ({
            timestamp: at(
              (MARKET_OPEN_INTEREST_WINDOWS[interval] - 1 - i) *
                marketIntervalMilliseconds(interval),
            ),
            openInterest: fixtureDecimal("100"),
          }),
        ),
      })),
    })),
  });
}

export function shiftAccountTimes(input: unknown): unknown {
  if (typeof input === "string" && /^\d{4}-\d\d-\d\dT.*Z$/.test(input))
    return new Date(
      Date.parse(input) +
        Date.parse("2026-09-24T14:00:00Z") -
        Date.parse("2026-10-02T12:00:00Z"),
    ).toISOString();
  if (Array.isArray(input)) return input.map(shiftAccountTimes);
  if (input !== null && typeof input === "object")
    return Object.fromEntries(
      Object.entries(input).map(([key, child]) => [
        key,
        shiftAccountTimes(child),
      ]),
    );
  return input;
}

export function preparedPlanFixture(
  state: "ready" | "review" | "blocked" = "ready",
  options: {
    recommendation?: "ADD_LONG" | "HOLD_LONG" | "REDUCE_LONG";
    positions?: readonly ReturnType<typeof portfolioRiskPosition>[];
  } = {},
) {
  const p = portfolioRiskPlanningFixture({
    recommendation: options.recommendation ?? "HOLD_LONG",
  });
  const market = state === "ready" ? completeMarketFixture(p.market) : p.market;
  const analytics = value(
    createAnalyticsEvidenceBundle({ market, profile: p.analytics.profile }),
  );
  const assessment = value(
    assessDataQuality({
      profile: p.qualityProfile,
      sources: [
        { role: "market", value: market },
        { role: "analytics", value: analytics },
      ],
      bundleCutoff: market.bundleCutoff,
      evaluationTime: market.bundleCutoff,
    }),
  );
  const dailyPlan = value(
    createDailyDecisionPlan({
      ...p.dailyPlan.inputs,
      market,
      analytics,
      assessment,
    }),
  );
  const account = {
    ...portfolioRiskAccountInput({ positions: options.positions ?? [] }),
    runId: p.dailyPlan.inputIdentity.runId,
  };
  const preflight = value(
    evaluatePortfolioRiskPreflight({
      dailyPlan,
      account: shiftAccountTimes(account),
      policy: portfolioRiskPolicyInput(),
      qualityProfile: p.qualityProfile,
      evaluationTime:
        state === "blocked"
          ? "2026-09-24T14:01:03.000Z"
          : "2026-09-24T14:00:02.000Z",
    }),
  );
  const c = value(
    createProvisionalM1Composition({ symbol: "BTCUSDT", allocation: "10" }),
  );
  return value(
    createPreparedDailyPlan({
      preflight,
      reviewPolicy: {
        ...c.reviewPolicy,
        exceptionalWarnings: state === "review" ? ["EXCEPTIONAL_CONTEXT"] : [],
      },
      approvalPolicy: c.approvalPolicy,
      externalAvailability: c.externalAvailability,
    }),
  );
}
