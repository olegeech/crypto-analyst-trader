import assert from "node:assert/strict";
import test from "node:test";
import { createDailyPlanningBoundary } from "../src/application/daily-decision-planning.js";
import { rehydrateDailyDecisionPlan } from "../src/domain/planning/daily-decision-plan.js";
import { dailyInputFixture } from "./fixtures/daily-planning-policy-fixtures.js";
import { requireDailyFixture } from "./fixtures/daily-planning-evidence-fixtures.js";

for (const target of ["ADD_LONG", "REDUCE_LONG", "HOLD_LONG"] as const) {
  for (const bounds of [true, false]) {
    test(`operator sanity ${target}, static bounds ${bounds}`, (t) => {
      const f = dailyInputFixture(bounds);
      // Keep real analytics facts; only non-calibrated fixture rule targets vary.
      const decisionPolicy = {
        ...f.decisionPolicy,
        groups: f.decisionPolicy.groups.map((group) => ({
          ...group,
          rules: group.rules.map((rule) => ({ ...rule, target })),
        })),
      };
      const boundary = requireDailyFixture(
        createDailyPlanningBoundary({
          qualityBoundary: f.boundary,
          decisionPolicy,
          planningPolicy: f.planningPolicy,
        }),
      );
      const input = {
        sources: f.sources,
        symbol: f.symbol,
        allocation: f.allocation,
        bundleCutoff: f.market.bundleCutoff,
        evaluationTime: f.market.bundleCutoff,
      };
      const result = boundary.prepare(input);
      assert.deepEqual(boundary.prepare(input), result);
      if (!bounds && target === "ADD_LONG") {
        assert.equal(result.status, "blocked");
        if (result.status !== "blocked") throw new Error("expected BLOCK");
        assert.deepEqual(
          result.reasons.map((reason) => reason.code),
          ["MISSING_STATIC_BOUNDS"],
        );
        assert.ok(!("plan" in result));
        t.diagnostic("BLOCK reason=MISSING_STATIC_BOUNDS");
        return;
      }
      assert.equal(result.status, "prepared");
      if (result.status !== "prepared")
        throw new Error("expected prepared plan");
      const plan = result.plan;
      assert.equal(plan.decision.recommendation, target);
      assert.equal(plan.decision.decisionSupport.toString(), "90");
      assert.equal(plan.decision.decisionConfidence.toString(), "85");
      assert.ok(Object.isFrozen(plan));
      assert.ok(Object.isFrozen(plan.decision));
      const replay = requireDailyFixture(rehydrateDailyDecisionPlan(plan));
      assert.equal(replay.contentHash, plan.contentHash);
      assert.equal(replay.inputSeed, plan.inputSeed);
      assert.equal(replay.decisionId, plan.decisionId);
      let legs = "none";
      if (plan.decision.recommendation === "ADD_LONG") {
        assert.equal(plan.candidateLegs?.length, 1);
        const leg = plan.candidateLegs?.[0];
        assert.ok(leg);
        const intent = leg.intent;
        assert.equal(leg.timeInForce, "GTC");
        assert.equal(intent.orderType, "limit");
        assert.equal(intent.side, "buy");
        assert.equal(intent.positionEffect, "open");
        assert.equal(intent.price?.toString(), "102");
        assert.equal(intent.quantity.toString(), "0.98");
        assert.equal(intent.notional.toString(), "99.96");
        assert.equal(intent.protection?.takeProfit?.toString(), "106");
        assert.equal(intent.protection?.stopLoss, undefined);
        assert.deepEqual(plan.orderIntents, [intent]);
        assert.equal(replay.candidateLegs?.[0]?.legId, leg.legId);
        assert.equal(replay.orderIntents?.[0]?.intentId, intent.intentId);
        legs = `GTC buy/open price=${intent.price} qty=${intent.quantity} notional=${intent.notional} TP=${intent.protection?.takeProfit}`;
      } else {
        assert.ok(!("candidateLegs" in plan));
        assert.ok(!("orderIntents" in plan));
        if (target === "REDUCE_LONG")
          assert.equal(plan.reductionFraction?.toString(), "0.25");
        else assert.ok(!("reductionFraction" in plan));
      }
      // Allowlisted output only; no source dumps or account/exchange order IDs.
      t.diagnostic(
        `${target} bounds=${bounds} support=${plan.decision.decisionSupport} confidence=${plan.decision.decisionConfidence} reduction=${plan.reductionFraction ?? "none"} legs=${legs} seed=${plan.inputSeed} hash=${plan.contentHash}`,
      );
    });
  }
}

test("operator sanity real quality BLOCK has no plan or recommendation", (t) => {
  const f = dailyInputFixture();
  const boundary = requireDailyFixture(
    createDailyPlanningBoundary({
      qualityBoundary: f.boundary,
      decisionPolicy: f.decisionPolicy,
      planningPolicy: f.planningPolicy,
    }),
  );
  const input = {
    sources: f.sources.filter((source) => source.role !== "analytics"),
    symbol: f.symbol,
    allocation: f.allocation,
    bundleCutoff: f.market.bundleCutoff,
    evaluationTime: f.market.bundleCutoff,
  };
  const result = boundary.prepare(input);
  assert.deepEqual(boundary.prepare(input), result);
  assert.equal(result.status, "blocked");
  if (result.status !== "blocked") throw new Error("expected quality BLOCK");
  assert.deepEqual(
    result.reasons.map((reason) => reason.code),
    ["QUALITY_BLOCKED"],
  );
  for (const field of ["plan", "decision", "orderIntents"])
    assert.ok(!(field in result));
  t.diagnostic("BLOCK reason=QUALITY_BLOCKED plan=absent");
});
