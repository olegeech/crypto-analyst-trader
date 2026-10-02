import assert from "node:assert/strict";
import test from "node:test";
import { createDailyPlanningBoundary } from "../src/application/daily-decision-planning.js";
import { dailyDecisionInputFixture } from "./fixtures/daily-planning-policy-fixtures.js";
import {
  dailyQualityProfileFixture,
  requireDailyFixture,
} from "./fixtures/daily-planning-evidence-fixtures.js";
import { createDataQualityBoundary } from "../src/application/data-quality-assessment.js";

test("application calls configured quality boundary before producing pre-risk plan", () => {
  const f = dailyDecisionInputFixture();
  const boundary = requireDailyFixture(
    createDailyPlanningBoundary({
      qualityBoundary: f.boundary,
      decisionPolicy: f.decisionPolicy,
      planningPolicy: f.planningPolicy,
    }),
  );
  const result = boundary.prepare({
    sources: f.sources,
    symbol: f.symbol,
    allocation: f.allocation,
    bundleCutoff: f.market.bundleCutoff,
    evaluationTime: f.market.bundleCutoff,
  });
  assert.equal(result.status, "prepared");
  if (result.status === "prepared")
    assert.equal(result.plan.decision.recommendation, "ADD_LONG");
});
test("actual quality BLOCK cannot become HOLD and input JSON cannot override authority", () => {
  const f = dailyDecisionInputFixture();
  const profile = dailyQualityProfileFixture();
  const strict = requireDailyFixture(
    createDataQualityBoundary({
      qualityProfile: {
        ...profile,
        roles: profile.roles.map((r) => ({ ...r, required: true })),
      },
      issuer: "fixture-daily",
    }),
  );
  const boundary = requireDailyFixture(
    createDailyPlanningBoundary({
      qualityBoundary: strict,
      decisionPolicy: f.decisionPolicy,
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
  assert.equal(result.status, "blocked");
  assert.ok(!("plan" in result));
  for (const field of [
    "qualityProfile",
    "issuer",
    "admission",
    "assessment",
    "decisionPolicy",
    "planningPolicy",
  ]) {
    assert.equal(
      boundary.prepare({ ...input, [field]: f.assessment }).status,
      "blocked",
    );
  }
});

test("rehydrated approval claims cannot bypass the fresh configured quality call", () => {
  const f = dailyDecisionInputFixture();
  let calls = 0;
  const boundary = requireDailyFixture(
    createDailyPlanningBoundary({
      qualityBoundary: {
        assess: (input) => {
          calls += 1;
          return f.boundary.assess(input);
        },
      },
      decisionPolicy: f.decisionPolicy,
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
  assert.equal(boundary.prepare(input).status, "prepared");
  assert.equal(calls, 1);
  assert.equal(
    boundary.prepare({ ...input, evaluationTime: "2026-09-24T15:00:00.000Z" })
      .status,
    "blocked",
  );
  assert.equal(calls, 2);
  assert.equal(
    boundary.prepare({ ...input, assessment: f.assessment }).status,
    "blocked",
  );
  assert.equal(calls, 2);
});
