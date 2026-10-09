import assert from "node:assert/strict";
import test from "node:test";
import {
  createDailyDecisionPlan,
  rehydrateDailyDecisionPlan,
} from "../src/domain/planning/daily-decision-plan.js";
import { dailyDecisionInputFixture } from "./fixtures/daily-planning-policy-fixtures.js";
import {
  dailyQualityProfileFixture,
  requireDailyFixture,
} from "./fixtures/daily-planning-evidence-fixtures.js";
import {
  encodeCanonicalArtifact,
  rehydrateArtifact,
} from "../src/domain/identity/canonical-artifact.js";
import { assessDataQuality } from "../src/domain/quality/assess-data-quality.js";
import { createQualityProfile } from "../src/domain/quality/quality-profile.js";
import { createExecutionPlan } from "../src/domain/planning/execution-plan.js";
import { hashCanonical } from "../src/domain/identity/canonical-serialization.js";
import { createPlanningPolicy } from "../src/domain/planning/planning-policy.js";
import { analyticsFixture } from "./fixtures/data-quality-fixtures.js";
import { dailyPrepareLiquidationV2 } from "./fixtures/daily-prepare-fixtures.js";

test("multilevel canonical artifact replay retains every leg and intent identity", () => {
  const raw = dailyDecisionInputFixture();
  // Non-calibrated test policy, not a runtime trading preset.
  const planningPolicy = requireDailyFixture(
    createPlanningPolicy({
      ...raw.planningPolicy,
      levels: [
        {
          atrOffset: "0.25",
          allocationWeight: "0.3",
          takeProfitAtrDistance: "0.75",
        },
        {
          atrOffset: "1.25",
          allocationWeight: "0.7",
          takeProfitAtrDistance: "1.5",
        },
      ],
    }),
  );
  const input = { ...raw, planningPolicy };
  const plan = requireDailyFixture(createDailyDecisionPlan(input));
  assert.equal(plan.decision.recommendation, "ADD_LONG");
  assert.ok(plan.candidateLegs);
  assert.ok(plan.orderIntents);
  assert.equal(plan.candidateLegs.length, 2);
  assert.equal(plan.orderIntents.length, 2);
  assert.deepEqual(
    plan.orderIntents,
    plan.candidateLegs.map((leg) => leg.intent),
  );
  assert.equal(new Set(plan.candidateLegs.map((leg) => leg.legId)).size, 2);
  assert.equal(
    new Set(plan.orderIntents.map((intent) => intent.intentId)).size,
    2,
  );
  assert.deepEqual(requireDailyFixture(createDailyDecisionPlan(input)), plan);
  const envelope = requireDailyFixture(
    encodeCanonicalArtifact("daily-decision-plan", plan),
  );
  const restored = requireDailyFixture(
    rehydrateArtifact("daily-decision-plan", envelope),
  );
  assert.deepEqual(restored, plan);
  const replayed = requireDailyFixture(rehydrateDailyDecisionPlan(restored));
  assert.deepEqual(replayed.candidateLegs, plan.candidateLegs);
  assert.deepEqual(replayed.orderIntents, plan.orderIntents);
  assert.equal(replayed.orderIntents?.length, 2);
});

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

test("daily decision plan canonical artifact roundtrips nested liquidation v2", () => {
  const raw = dailyDecisionInputFixture();
  const liquidationEvidence = dailyPrepareLiquidationV2(raw.market);
  const liquidation = liquidationEvidence.bundle;
  const analytics = analyticsFixture(raw.market, {
    profile: raw.analytics.profile,
    liquidation,
  });
  const qualityProfileInput = dailyQualityProfileFixture();
  qualityProfileInput.roles = [
    ...qualityProfileInput.roles,
    { id: "liquidation", required: true, maxAgeMs: 86_400_000 },
  ];
  const profile = requireDailyFixture(
    createQualityProfile(qualityProfileInput),
  );
  const assessment = requireDailyFixture(
    assessDataQuality({
      profile,
      sources: [
        { role: "market", value: raw.market },
        { role: "analytics", value: analytics },
        {
          role: "liquidation",
          value: liquidation,
          evidenceRef: liquidationEvidence.evidence,
        },
      ],
      bundleCutoff: raw.market.bundleCutoff,
      evaluationTime: raw.market.bundleCutoff,
    }),
  );
  assert.equal(assessment.qualityGate, "OK", JSON.stringify(assessment));
  const plan = requireDailyFixture(
    createDailyDecisionPlan({ ...raw, analytics, liquidation, assessment }),
  );
  assert.equal(
    (plan.inputs.liquidation as { readonly schemaVersion: string })
      .schemaVersion,
    "liquidation-evidence/v2",
  );

  const envelope = requireDailyFixture(
    encodeCanonicalArtifact("daily-decision-plan", plan),
  );
  const restored = requireDailyFixture(
    rehydrateArtifact("daily-decision-plan", envelope),
  );
  assert.deepEqual(restored, plan);
  assert.deepEqual(rehydrateDailyDecisionPlan(restored), {
    ok: true,
    value: plan,
  });
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

test("rehashing forged long-only/grid payloads cannot bypass canonical replay", () => {
  const plan = requireDailyFixture(
    createDailyDecisionPlan(dailyDecisionInputFixture()),
  );
  assert.equal(plan.decision.recommendation, "ADD_LONG");
  if (plan.decision.recommendation !== "ADD_LONG" || !plan.candidateLegs)
    return;
  const leg = plan.candidateLegs[0]!;
  for (const intent of [
    { ...leg.intent, side: "sell" },
    { ...leg.intent, protection: {} },
    {
      ...leg.intent,
      protection: { ...leg.intent.protection, stopLoss: leg.intent.price },
    },
    { ...leg.intent, intentId: "forged-intent" },
  ]) {
    const { contentHash: _hash, ...payload } = plan;
    void _hash;
    const forged: Record<string, unknown> = {
      ...payload,
      candidateLegs: [{ ...leg, intent }],
      orderIntents: [intent],
    };
    const withHash = {
      ...forged,
      contentHash: requireDailyFixture(hashCanonical(forged)),
    };
    const envelope = requireDailyFixture(
      encodeCanonicalArtifact("daily-decision-plan", withHash),
    );
    assert.equal(rehydrateArtifact("daily-decision-plan", envelope).ok, false);
  }
});

test("allocation and semantic policy changes alter plan/intent identities without cycles", () => {
  const input = dailyDecisionInputFixture();
  const plan = requireDailyFixture(createDailyDecisionPlan(input));
  const changed = requireDailyFixture(
    createDailyDecisionPlan({ ...input, allocation: "101" }),
  );
  assert.notEqual(plan.inputSeed, changed.inputSeed);
  assert.notEqual(plan.planId, changed.planId);
  assert.notEqual(plan.decisionId, changed.decisionId);
  assert.notEqual(plan.contentHash, changed.contentHash);
  const changedPolicy = requireDailyFixture(
    createDailyDecisionPlan({
      ...input,
      decisionPolicy: { ...input.decisionPolicy, reductionFraction: "0.5" },
    }),
  );
  assert.notEqual(plan.inputSeed, changedPolicy.inputSeed);
});

test("invalid runtime preparation input returns failure without reading accessors", () => {
  for (const input of [null, undefined, 1]) {
    assert.equal(
      createDailyDecisionPlan(
        input as unknown as Parameters<typeof createDailyDecisionPlan>[0],
      ).ok,
      false,
    );
  }
  const input = dailyDecisionInputFixture();
  Object.defineProperty(input, "market", {
    get: () => {
      throw new Error("accessor must not execute");
    },
  });
  assert.equal(createDailyDecisionPlan(input).ok, false);
});
