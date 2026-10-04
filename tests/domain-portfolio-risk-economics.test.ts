import assert from "node:assert/strict";
import test from "node:test";

import { evaluatePortfolioRiskEconomics } from "../src/domain/risk/portfolio-risk-economics.js";
import { requireDailyFixture } from "./fixtures/daily-planning-evidence-fixtures.js";
import { portfolioRiskPolicyInput } from "./fixtures/portfolio-risk-fixtures.js";
import { portfolioRiskPlanningFixture } from "./fixtures/portfolio-risk-planning-fixtures.js";

const cutoff = "2026-09-24T14:00:00.000Z";
const evaluationTime = "2026-09-24T14:00:02.000Z";

function economics(
  options: {
    readonly recommendation?: "ADD_LONG" | "REDUCE_LONG" | "HOLD_LONG";
    readonly fundingRate?: string;
    readonly tickerObservedAt?: string;
    readonly marketMaxAgeMs?: number;
    readonly evaluationTime?: string;
    readonly policy?: Record<string, unknown>;
    readonly planningLevels?: readonly {
      readonly atrOffset: string;
      readonly allocationWeight: string;
      readonly takeProfitAtrDistance: string;
    }[];
  } = {},
) {
  const fixtures = portfolioRiskPlanningFixture(options);
  const result = evaluatePortfolioRiskEconomics({
    dailyPlan: fixtures.dailyPlan,
    qualityProfile: fixtures.qualityProfile,
    policy: portfolioRiskPolicyInput(options.policy),
    evaluationTime: options.evaluationTime ?? evaluationTime,
  });
  return requireDailyFixture(result);
}

test("per-leg economics retain the exact approved plan and calculate every cost", () => {
  const result = economics({
    fundingRate: "0.05",
    policy: {
      entryFeeRate: "0.01",
      exitFeeRate: "0.02",
      slippageBufferRate: "0.03",
      minimumNetEdgeRate: "0.04",
    },
  });
  assert.equal(result.outcome, "block");
  assert.equal(result.legs.length, 1);
  const leg = result.legs[0]!;
  const originalPlan = portfolioRiskPlanningFixture({
    fundingRate: "0.05",
  }).dailyPlan;
  assert.ok("orderIntents" in originalPlan);
  const original = originalPlan.orderIntents[0]!;
  assert.equal(leg.entryPrice.toString(), original.price.toString());
  assert.equal(leg.quantity.toString(), original.quantity.toString());
  assert.equal(
    leg.takeProfit.toString(),
    original.protection?.takeProfit?.toString(),
  );
  assert.equal(leg.entryNotional.toString(), "99.96");
  assert.equal(leg.exitNotional.toString(), "103.88");
  assert.equal(leg.grossProfit.toString(), "3.92");
  assert.equal(leg.entryFee.toString(), "0.9996");
  assert.equal(leg.exitFee.toString(), "2.0776");
  assert.equal(leg.slippageBuffer.toString(), "2.9988");
  assert.equal(leg.minimumEdge.toString(), "3.9984");
  assert.equal(leg.fundingCost.state, "known");
  assert.equal(leg.requiredProfit.state, "known");
  assert.equal(leg.netAfterModeledCosts.state, "known");
  if (
    leg.fundingCost.state !== "known" ||
    leg.requiredProfit.state !== "known" ||
    leg.netAfterModeledCosts.state !== "known"
  )
    return;
  assert.equal(leg.fundingCost.value.toString(), "4.998");
  assert.equal(leg.requiredProfit.value.toString(), "15.0724");
  assert.equal(leg.netAfterModeledCosts.value.toString(), "-7.154");
  assert.ok(leg.reasonCodes.includes("ECONOMICS_INSUFFICIENT"));
});

test("gross profit equal to exact required profit passes inclusively", () => {
  const result = economics({
    fundingRate: "0",
    planningLevels: [
      { atrOffset: "0", allocationWeight: "1", takeProfitAtrDistance: "25.5" },
    ],
    policy: {
      entryFeeRate: "0",
      exitFeeRate: "0",
      slippageBufferRate: "0",
      minimumNetEdgeRate: "1",
    },
  });
  assert.equal(result.outcome, "pass");
  const leg = result.legs[0]!;
  assert.equal(leg.requiredProfit.state, "known");
  if (leg.requiredProfit.state !== "known") return;
  assert.equal(leg.grossProfit.toString(), leg.requiredProfit.value.toString());
  assert.equal(leg.status, "pass");
});

test("positive funding charges one interval while zero and negative rates add no benefit", () => {
  const positive = economics({ fundingRate: "0.01" });
  const positiveLeg = positive.legs[0]!;
  assert.equal(positiveLeg.fundingCost.state, "known");
  if (positiveLeg.fundingCost.state !== "known") return;
  assert.equal(positiveLeg.fundingCost.value.toString(), "0.9996");
  assert.equal(positiveLeg.fundingIntervals, 1);

  for (const rate of ["0", "-0.01"]) {
    const result = economics({ fundingRate: rate });
    assert.equal(result.legs[0]!.fundingCost.state, "known");
    if (result.legs[0]!.fundingCost.state !== "known") return;
    assert.equal(result.legs[0]!.fundingCost.value.toString(), "0");
    assert.equal(result.legs[0]!.fundingIntervals, 1);
  }
});

test("funding must exist and market cutoff freshness expires at the exact profile boundary", () => {
  const missing = economics();
  assert.equal(missing.outcome, "block");
  assert.equal(missing.fundingEvidence.status, "unavailable");
  assert.ok(missing.reasonCodes.includes("ECONOMICS_INPUT_UNKNOWN"));

  const before = economics({
    fundingRate: "0",
    evaluationTime: "2026-09-24T14:00:59.999Z",
  });
  assert.equal(before.fundingEvidence.status, "fresh");

  const boundary = economics({
    fundingRate: "0",
    evaluationTime: "2026-09-24T14:01:00.000Z",
  });
  assert.equal(boundary.fundingEvidence.status, "stale");
  assert.ok(boundary.reasonCodes.includes("ECONOMICS_INPUT_UNKNOWN"));
});

test("an old ticker observation is checked against cutoff, not independently aged", () => {
  const result = economics({
    fundingRate: "0",
    tickerObservedAt: "2026-09-24T13:00:00.000Z",
  });
  assert.equal(result.fundingEvidence.status, "fresh");
  assert.equal(
    result.fundingEvidence.tickerObservedAt,
    "2026-09-24T13:00:00.000Z",
  );
});

test("one failing ADD leg blocks the full original grid without dropping legs", () => {
  const result = economics({
    fundingRate: "0",
    planningLevels: [
      { atrOffset: "0", allocationWeight: "0.5", takeProfitAtrDistance: "1" },
      {
        atrOffset: "0.25",
        allocationWeight: "0.5",
        takeProfitAtrDistance: "0.1",
      },
    ],
    policy: {
      entryFeeRate: "0",
      exitFeeRate: "0",
      slippageBufferRate: "0",
      minimumNetEdgeRate: "0.02",
    },
  });
  assert.equal(result.legs.length, 2);
  assert.equal(result.outcome, "block");
  assert.deepEqual(
    result.legs.map((leg) => leg.status),
    ["pass", "block"],
  );
  assert.ok(result.reasonCodes.includes("ECONOMICS_INSUFFICIENT"));
});

test("HOLD and REDUCE leave entry economics unevaluated", () => {
  for (const recommendation of ["HOLD_LONG", "REDUCE_LONG"] as const) {
    const result = economics({ recommendation });
    assert.equal(result.outcome, "not-evaluated");
    assert.equal(result.fundingEvidence.status, "not-evaluated");
    assert.deepEqual(result.legs, []);
  }
});

test("original quality profile hash and version are mandatory replay inputs", () => {
  const fixtures = portfolioRiskPlanningFixture({ fundingRate: "0" });
  const mismatched = evaluatePortfolioRiskEconomics({
    dailyPlan: fixtures.dailyPlan,
    qualityProfile: {
      ...fixtures.qualityProfile,
      profileVersion: "softer-replacement",
    },
    policy: portfolioRiskPolicyInput(),
    evaluationTime,
  });
  assert.equal(mismatched.ok, false);

  const stale = economics({
    fundingRate: "0",
    marketMaxAgeMs: 1,
    evaluationTime: "2026-09-24T14:00:00.001Z",
  });
  assert.equal(stale.fundingEvidence.status, "stale");
  assert.ok(stale.reasonCodes.includes("ECONOMICS_INPUT_UNKNOWN"));
});

test("a caller cannot use an evaluation time before the bound market cutoff", () => {
  const result = economics({
    fundingRate: "0",
    evaluationTime: "2026-09-24T13:59:59.999Z",
  });
  assert.equal(result.outcome, "block");
  assert.equal(result.fundingEvidence.status, "inconsistent");
  assert.ok(result.reasonCodes.includes("ECONOMICS_INPUT_UNKNOWN"));
  assert.equal(cutoff, "2026-09-24T14:00:00.000Z");
});
