import assert from "node:assert/strict";
import test from "node:test";
import { createProvisionalM1Composition } from "../src/application/policies/provisional-m1.js";
import { createPreparedDailyPlan } from "../src/domain/review/prepared-daily-plan.js";
import { evaluatePortfolioRiskPreflight } from "../src/domain/risk/portfolio-risk-preflight.js";
import { createDailyDecisionPlan } from "../src/domain/planning/daily-decision-plan.js";
import { assessDataQuality } from "../src/domain/quality/assess-data-quality.js";
import { createQualityProfile } from "../src/domain/quality/quality-profile.js";
import { createAnalyticsEvidenceBundle } from "../src/domain/analytics/analytics-evidence-bundle.js";
import {
  MARKET_OHLCV_WINDOWS,
  MARKET_OPEN_INTEREST_WINDOWS,
  MARKET_FUNDING_WINDOW,
  marketIntervalMilliseconds,
} from "../src/domain/market/market-evidence-windows.js";
import {
  type MarketSeriesInterval,
  type OpenInterestInterval,
} from "../src/domain/market/market-evidence-bundle.js";
import {
  marketFixture,
  fixtureDecimal,
} from "./fixtures/data-quality-fixtures.js";
import { parseUtcTimestamp } from "../src/domain/shared/time.js";
import { decimal, known, withCounts } from "./account-evidence-fixture.js";
import {
  portfolioRiskAccountInput,
  portfolioRiskPosition,
  portfolioRiskOrder,
  portfolioRiskPolicyInput,
} from "./fixtures/portfolio-risk-fixtures.js";
import { portfolioRiskPlanningFixture } from "./fixtures/portfolio-risk-planning-fixtures.js";
import { requireDailyFixture as value } from "./fixtures/daily-planning-evidence-fixtures.js";

function shifted(input: unknown): unknown {
  if (typeof input === "string" && /^\d{4}-\d\d-\d\dT.*Z$/.test(input))
    return new Date(
      Date.parse(input) +
        Date.parse("2026-09-24T14:00:00Z") -
        Date.parse("2026-10-02T12:00:00Z"),
    ).toISOString();
  if (Array.isArray(input)) return input.map(shifted);
  if (input !== null && typeof input === "object")
    return Object.fromEntries(
      Object.entries(input).map(([k, v]) => [k, shifted(v)]),
    );
  return input;
}

function input(
  options: {
    recommendation?: "ADD_LONG" | "HOLD_LONG" | "REDUCE_LONG";
    positions?: unknown[];
    orders?: unknown[];
    complete?: boolean;
    incomplete?: boolean;
    stale?: boolean;
    degraded?: boolean;
  } = {},
) {
  const f = portfolioRiskPlanningFixture({
    recommendation: options.recommendation ?? "ADD_LONG",
    fundingRate: "0",
  });
  // The small upstream fixture is deliberately incomplete. Build real complete
  // native windows for the READY proof, rather than deleting its quality finding.
  const timestamp = (offset: number) =>
    value(
      parseUtcTimestamp(
        new Date(Date.parse(f.market.bundleCutoff) - offset).toISOString(),
      ),
    );
  const market = options.complete
    ? marketFixture({
        ...f.market,
        evidence: undefined,
        status: "complete",
        diagnostics: [],
        symbols: f.market.symbols.map((s) => ({
          ...s,
          diagnostics: [],
          ticker: {
            ...f.market.symbols[0]!.ticker!,
            observedAt: f.market.bundleCutoff,
          },
          ohlcv: (
            Object.keys(MARKET_OHLCV_WINDOWS) as MarketSeriesInterval[]
          ).map((interval) => ({
            interval,
            observations: Array.from(
              { length: MARKET_OHLCV_WINDOWS[interval] },
              (_, i) => ({
                timestamp: timestamp(
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
          })),
          funding: Array.from({ length: MARKET_FUNDING_WINDOW }, (_, i) => ({
            timestamp: timestamp((MARKET_FUNDING_WINDOW - 1 - i) * 480 * 60000),
            rate: fixtureDecimal("0"),
          })),
          openInterest: (
            Object.keys(MARKET_OPEN_INTEREST_WINDOWS) as OpenInterestInterval[]
          ).map((interval) => ({
            interval,
            observations: Array.from(
              { length: MARKET_OPEN_INTEREST_WINDOWS[interval] },
              (_, i) => ({
                timestamp: timestamp(
                  (MARKET_OPEN_INTEREST_WINDOWS[interval] - 1 - i) *
                    marketIntervalMilliseconds(interval),
                ),
                openInterest: fixtureDecimal("100"),
              }),
            ),
          })),
        })),
      } as Parameters<typeof marketFixture>[0])
    : f.market;
  const analytics = options.complete
    ? value(
        createAnalyticsEvidenceBundle({ market, profile: f.analytics.profile }),
      )
    : f.analytics;
  const qualityProfile = options.degraded
    ? value(
        createQualityProfile({
          ...f.qualityProfile,
          roles: [
            ...f.qualityProfile.roles,
            { id: "external:trap", required: false, maxAgeMs: 60000 },
          ],
          penalties: [
            ...f.qualityProfile.penalties,
            {
              reasonCode: "MISSING_EVIDENCE",
              confidenceImpactGroup: "optional",
              penalty: "5",
            },
          ],
        }),
      )
    : f.qualityProfile;
  const assessment = value(
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
  const dailyPlan = value(
    createDailyDecisionPlan({
      ...f.dailyPlan.inputs,
      market,
      analytics,
      assessment,
    }),
  );
  const source = portfolioRiskAccountInput({
    positions: (options.positions ?? [portfolioRiskPosition()]) as ReturnType<
      typeof portfolioRiskPosition
    >[],
    orders: (options.orders ?? []) as ReturnType<typeof portfolioRiskOrder>[],
  });
  const funded = {
    ...source,
    runId: dailyPlan.inputIdentity.runId,
    criticalPasses: {
      A: {
        ...source.criticalPasses.A,
        totals: {
          ...source.criticalPasses.A.totals,
          totalAvailableBalance: decimal("1000"),
        },
      },
      B: {
        ...source.criticalPasses.B,
        totals: {
          ...source.criticalPasses.B.totals,
          totalAvailableBalance: decimal("1000"),
        },
      },
    },
  };
  const counted = withCounts(funded);
  const unknownSize = options.positions?.some(
    (p) =>
      (p as ReturnType<typeof portfolioRiskPosition>).size.state !== "known",
  );
  const account = {
    ...counted,
    collectionStatus:
      options.incomplete || unknownSize ? "incomplete" : "complete",
    coverage: counted.coverage.map((entry) =>
      options.incomplete &&
      entry.partition.pass === "B" &&
      entry.partition.endpoint === "open-orders" &&
      entry.partition.category === "spot"
        ? {
            ...entry,
            status: "failed",
            reasonCodes: ["TRANSPORT_FAILED"],
            startedAt: null,
            endedAt: null,
            pages: 0,
            rows: 0,
          }
        : entry,
    ),
  };
  const preflight = value(
    evaluatePortfolioRiskPreflight({
      dailyPlan,
      account: shifted(account),
      policy: portfolioRiskPolicyInput(),
      qualityProfile,
      evaluationTime: options.stale
        ? "2026-09-24T14:01:03.000Z"
        : "2026-09-24T14:00:02.000Z",
    }),
  );
  const policy = value(
    createProvisionalM1Composition({ symbol: "BTCUSDT", allocation: "10" }),
  );
  return {
    preflight,
    reviewPolicy: policy.reviewPolicy,
    approvalPolicy: policy.approvalPolicy,
    externalAvailability: policy.externalAvailability,
  };
}

test("clean ADD PASS stays ready with informational provisional/optional metadata", () => {
  const source = input({ complete: true });
  const result = value(createPreparedDailyPlan(source));
  assert.equal(source.preflight.verdict, "PASS");
  assert.equal(result.state, "READY_FOR_APPROVAL");
  assert.equal(result.noteRequired, false);
  assert.equal(result.executionAuthority, "none");
  assert.equal(result.summary.targetGate.status, "clean");
  assert.deepEqual(result.summary.informationalCodes, ["PROVISIONAL_POLICY"]);
  assert.deepEqual(
    result.summary.externalAvailability,
    source.externalAvailability,
  );
  assert.deepEqual(result.replayInputs.preflight, source.preflight);
  assert.ok(result.summary.decision.groups.length > 0);
  assert.ok(result.summary.grid.length > 0);
  assert.ok(result.summary.nativeAvailability.length > 0);
  assert.equal(result.summary.risk.verdict, "PASS");
});

test("existing target exposure blocks even when #17 passes", () => {
  const source = input({
    positions: [
      portfolioRiskPosition({
        side: "Buy",
        size: decimal("1", "contracts"),
        positionValue: decimal("100"),
      }),
    ],
  });
  assert.equal(source.preflight.verdict, "PASS");
  const result = value(createPreparedDailyPlan(source));
  assert.equal(result.state, "BLOCKED");
  assert.ok(result.reasonCodes.includes("BLOCKED_BY_CREATE_ONLY_SCOPE"));
  assert.equal(result.summary.targetGate.status, "conflict");
});

test("target orders in every collected category block ADD regardless of protective purpose", () => {
  for (const category of ["linear", "spot", "inverse", "option"]) {
    const order = portfolioRiskOrder({ category, reduceOnly: known(true) });
    const unit = category === "spot" ? "base-coin" : "contracts";
    const source = input({
      orders: [
        {
          ...order,
          qty: { state: "known", value: "1", unit },
          cumExecQty: { state: "known", value: "0", unit },
          leavesQty: { state: "known", value: "1", unit },
        } as ReturnType<typeof portfolioRiskOrder>,
      ],
    });
    const result = value(createPreparedDailyPlan(source));
    assert.equal(result.state, "BLOCKED");
    assert.ok(result.reasonCodes.includes("BLOCKED_BY_CREATE_ONLY_SCOPE"));
  }
});

test("failed relevant coverage or unknown target size cannot prove clean", () => {
  for (const source of [
    input({ incomplete: true }),
    input({
      positions: [
        {
          ...portfolioRiskPosition(),
          size: {
            state: "unavailable",
            reason: "not-returned",
            unit: "contracts",
          },
        },
      ],
    }),
  ]) {
    const result = value(createPreparedDailyPlan(source));
    assert.equal(result.state, "BLOCKED");
    assert.equal(result.summary.targetGate.status, "unknown");
    assert.ok(result.reasonCodes.includes("TARGET_STATE_UNKNOWN"));
  }
});

test("unrelated supported holdings are left to #17", () => {
  const result = value(
    createPreparedDailyPlan(
      input({
        positions: [
          portfolioRiskPosition(),
          portfolioRiskPosition({
            symbol: "ETHUSDT",
            side: "Buy",
            size: decimal("1", "contracts"),
            positionValue: decimal("100"),
          }),
        ],
      }),
    ),
  );
  assert.notEqual(result.state, "BLOCKED");
  assert.equal(result.summary.targetGate.status, "clean");
});

test("HOLD, REDUCE no-op and quantity-only reduction confer no execution authority", () => {
  const hold = value(
    createPreparedDailyPlan(
      input({ recommendation: "HOLD_LONG", orders: [portfolioRiskOrder()] }),
    ),
  );
  assert.notEqual(hold.state, "BLOCKED");
  assert.equal(hold.summary.targetGate.status, "not-applicable");
  assert.deepEqual(hold.summary.action, { kind: "hold-no-action" });
  const noOp = value(
    createPreparedDailyPlan(
      input({ recommendation: "REDUCE_LONG", positions: [] }),
    ),
  );
  assert.deepEqual(noOp.summary.action, {
    kind: "reduction-no-op",
    reasonCode: "NO_REDUCIBLE_LONG",
  });
  const reduce = value(
    createPreparedDailyPlan(
      input({
        recommendation: "REDUCE_LONG",
        positions: [
          portfolioRiskPosition({
            side: "Buy",
            size: decimal("1", "contracts"),
            positionValue: decimal("100"),
          }),
        ],
      }),
    ),
  );
  assert.equal(reduce.summary.action.kind, "close-long-quantity");
  for (const result of [hold, noOp, reduce]) {
    assert.equal(result.executionAuthority, "none");
    assert.deepEqual(result.summary.grid, []);
    assert.equal("orderIntents" in result, false);
  }
});

test("real quality degradation or explicit exceptional policy warning requires review, never softens BLOCK", () => {
  const degraded = value(createPreparedDailyPlan(input({ degraded: true })));
  assert.equal(degraded.state, "REVIEW");
  assert.equal(degraded.noteRequired, true);
  assert.ok(degraded.summary.quality.findings.some((f) => !f.blocking));
  const source = input();
  const exceptional = value(
    createPreparedDailyPlan({
      ...source,
      reviewPolicy: {
        ...source.reviewPolicy,
        policyVersion: "exceptional-v1",
        exceptionalWarnings: ["EXPERIMENTAL_CONFIGURATION"],
      },
    }),
  );
  assert.equal(exceptional.state, "REVIEW");
  assert.equal(exceptional.noteRequired, true);
  const blocked = value(
    createPreparedDailyPlan(input({ degraded: true, stale: true })),
  );
  assert.equal(blocked.state, "BLOCKED");
  assert.ok(blocked.reasonCodes.includes("ACCOUNT_EVIDENCE_STALE"));
});

test("safe material summary has no raw balance, UID or order identifiers", () => {
  const result = value(
    createPreparedDailyPlan(input({ orders: [portfolioRiskOrder()] })),
  );
  const output = JSON.stringify(result.summary);
  for (const forbidden of [
    "walletBalance",
    "availableBalance",
    "totalEquity",
    "orderId",
    "orderLinkId",
    "manual-1",
    "accountIdentityHash",
    '"uid"',
    "orderIntents",
  ])
    assert.equal(output.includes(forbidden), false, forbidden);
});
