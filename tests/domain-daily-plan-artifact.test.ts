import assert from "node:assert/strict";
import test from "node:test";
import {
  createDailyDecisionPlan,
  rehydrateDailyDecisionPlan,
} from "../src/domain/planning/daily-decision-plan.js";
import { dailyDecisionInputFixture } from "./fixtures/daily-planning-policy-fixtures.js";
import { requireDailyFixture } from "./fixtures/daily-planning-evidence-fixtures.js";
import {
  encodeCanonicalArtifact,
  rehydrateArtifact,
} from "../src/domain/identity/canonical-artifact.js";
import { createExecutionPlan } from "../src/domain/planning/execution-plan.js";

test("daily pre-risk identity is deterministic and canonical artifact roundtrips", () => {
  const input = dailyDecisionInputFixture();
  const plan = requireDailyFixture(createDailyDecisionPlan(input));
  assert.equal(plan.decision.recommendation, "ADD_LONG");
  assert.deepEqual(createDailyDecisionPlan(input), { ok: true, value: plan });
  const envelope = requireDailyFixture(
    encodeCanonicalArtifact("daily-decision-plan", plan),
  );
  const restored = requireDailyFixture(
    rehydrateArtifact("daily-decision-plan", envelope),
  );
  assert.deepEqual(restored, plan);
  assert.notEqual(envelope.canonicalHash, plan.contentHash);
  // Deliberately exercise an untrusted runtime caller past the static type boundary.
  assert.equal(
    createExecutionPlan(
      plan as unknown as Parameters<typeof createExecutionPlan>[0],
    ).ok,
    false,
  );
});
test("historical rehydration recomputes semantics and identities, not only the outer hash", () => {
  const plan = requireDailyFixture(
    createDailyDecisionPlan(dailyDecisionInputFixture()),
  );
  assert.equal(
    rehydrateDailyDecisionPlan({ ...plan, decisionId: "forged" }).ok,
    false,
  );
  assert.equal(rehydrateDailyDecisionPlan({ ...plan, approval: {} }).ok, false);
  assert.equal(
    rehydrateDailyDecisionPlan({
      ...plan,
      decision: { ...plan.decision, recommendation: "ADD_SHORT" },
    }).ok,
    false,
  );
  assert.equal(
    rehydrateDailyDecisionPlan({ ...plan, candidateLegs: [] }).ok,
    false,
  );
});
