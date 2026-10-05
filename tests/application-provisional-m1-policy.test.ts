import assert from "node:assert/strict";
import test from "node:test";
import { createProvisionalM1Composition } from "../src/application/policies/provisional-m1.js";
import { hashQualityProfile } from "../src/domain/quality/quality-profile.js";
import { evaluateDailyDecision } from "../src/domain/planning/daily-decision.js";
import {
  prepareDailyPlanningInputs,
  type DailyPlanningInputs,
} from "../src/domain/planning/daily-planning-inputs.js";
import { dailyDecisionInputFixture } from "./fixtures/daily-planning-policy-fixtures.js";
import { fixtureDecimal } from "./fixtures/data-quality-fixtures.js";
import { assessDataQuality } from "../src/domain/quality/assess-data-quality.js";
import { createDecisionPolicy } from "../src/domain/planning/decision-policy.js";

function composition(symbol = "BTCUSDT") {
  const result = createProvisionalM1Composition({ symbol, allocation: "10" });
  assert.ok(result.ok, result.ok ? "" : result.error.message);
  return result.value;
}

test("selected-symbol production policies preserve exact requests and identities", () => {
  for (const symbol of ["BTCUSDT", "ETHUSDT", "SOLUSDT", "DOGEUSDT"]) {
    const c = composition(symbol);
    assert.deepEqual(c.decisionPolicy.symbolApplicability, [symbol]);
    assert.deepEqual(
      c.analyticsProfile.features.map((f) => f.id),
      ["atr-4h", "liquidation-12h", "oi-24h", "return-24h", "return-3d"],
    );
    assert.ok(c.analyticsProfile.features.every((f) => f.required));
    const requests = Object.fromEntries(
      c.analyticsProfile.features.map((f) => [f.id, f]),
    );
    assert.deepEqual(requests["return-24h"], {
      id: "return-24h",
      kind: "close-return",
      symbol,
      interval: "1h",
      periods: 24,
      required: true,
    });
    assert.deepEqual(requests["return-3d"], {
      id: "return-3d",
      kind: "close-return",
      symbol,
      interval: "1d",
      periods: 3,
      required: true,
    });
    assert.deepEqual(requests["oi-24h"], {
      id: "oi-24h",
      kind: "open-interest-relative-change",
      symbol,
      interval: "1h",
      observationCount: 25,
      required: true,
    });
    assert.deepEqual(requests["atr-4h"], {
      id: "atr-4h",
      kind: "atr",
      symbol,
      interval: "4h",
      period: 14,
      required: true,
    });
    assert.equal(c.planningPolicy.atrSelector.required, true);
    assert.equal(c.planningPolicy.atrSelector.requestId, "atr-4h");
    assert.deepEqual(c.analyticsProfile.externalEvidence, []);
    assert.deepEqual(c.externalAdmissions, []);
    assert.deepEqual(c.qualityProfile.penalties, []);
    assert.deepEqual(c.qualityProfile.trust, []);
    assert.ok(
      c.qualityProfile.roles.every((r) => r.required && r.maxAgeMs === 300000),
    );
    assert.equal(c.qualityProfile.metadataSkewMs, 1000);
    assert.deepEqual(hashQualityProfile(c.qualityProfile), {
      ok: true,
      value: c.qualityProfileHash,
    });
    assert.equal(c.qualityProfile.profileVersion, "provisional-m1-v1");
    assert.equal(c.reviewPolicy.provisionalRequiresReview, false);
    assert.equal(c.reviewPolicy.unconfiguredExternalRequiresReview, false);
    assert.equal(c.approvalPolicy.ttlMs, 900000);
    assert.equal(c.externalAvailability.length, 4);
    assert.ok(
      c.externalAvailability.every((f) => f.status === "not-configured"),
    );
    assert.deepEqual(
      c.planningPolicy.levels.map((l) => [
        l.atrOffset.toString(),
        l.allocationWeight.toString(),
        l.takeProfitAtrDistance.toString(),
      ]),
      [
        ["0.5", "0.25", "1"],
        ["1", "0.25", "1"],
        ["1.5", "0.25", "1"],
        ["2", "0.25", "1"],
      ],
    );
    assert.equal(c.riskPolicy.policyVersion, "m1-v1");
    assert.equal(c.riskPolicy.maxAccountEvidenceAgeMs, 60000);
    assert.deepEqual(
      [
        c.riskPolicy.marginReserveRatio,
        c.riskPolicy.maxDerivativesLeverage,
        c.riskPolicy.entryFeeRate,
        c.riskPolicy.exitFeeRate,
        c.riskPolicy.slippageBufferRate,
        c.riskPolicy.minimumNetEdgeRate,
      ].map((d) => d.toString()),
      ["0.1", "1", "0.0002", "0.00055", "0.0005", "0.001"],
    );
    assert.ok(Object.isFrozen(c));
  }
});

test("missing native outcomes including ATR and liquidation remain blocking", () => {
  const c = composition();
  const assessment = assessDataQuality({
    profile: c.qualityProfile,
    sources: [],
    bundleCutoff: "2026-10-04T00:00:00.000Z",
    evaluationTime: "2026-10-04T00:00:00.000Z",
  });
  assert.ok(assessment.ok);
  assert.equal(assessment.value.qualityGate, "BLOCK");
  for (const request of c.analyticsProfile.features) {
    assert.ok(
      assessment.value.findings.some(
        (f) => f.role === `analytics:${request.id}` && f.blocking,
      ),
    );
  }
  assert.ok(
    assessment.value.findings.every((f) => !f.role.startsWith("external:")),
  );
});

test("equal within-group support does not satisfy quorum", () => {
  const c = composition();
  const base = prepareDailyPlanningInputs(dailyDecisionInputFixture());
  assert.ok(base.ok);
  const policy = createDecisionPolicy({
    ...c.decisionPolicy,
    groups: c.decisionPolicy.groups.map((g) => ({
      ...g,
      rules: g.rules.map((r) => ({
        ...r,
        conditions: [
          { selectorId: "return-24h", comparison: "gt", threshold: "0" },
        ],
      })),
    })),
  });
  assert.ok(policy.ok);
  const result = evaluateDailyDecision({
    ...base.value,
    decisionPolicy: policy.value,
    selectors: policy.value.selectors.map((s) => ({
      selectorId: s.id,
      status: "available",
      value: fixtureDecimal("1"),
    })),
  });
  assert.ok(result.ok);
  assert.equal(result.value.recommendation, "HOLD_LONG");
  assert.equal(result.value.addAgreeingGroupCount, 0);
  assert.equal(result.value.reduceAgreeingGroupCount, 0);
});

test("reject unknown symbols, invalid allocation, and caller overrides", () => {
  for (const input of [
    { symbol: "XRPUSDT", allocation: "10" },
    ...["0", "-1", "NaN", 10, undefined].map((allocation) => ({
      symbol: "BTCUSDT",
      allocation,
    })),
    { symbol: "BTCUSDT", allocation: "10", riskPolicy: {} },
  ]) {
    assert.equal(createProvisionalM1Composition(input).ok, false);
  }
});

test("three groups reach 75; zero and mixed derivatives hold; missing required operands fail", () => {
  const base = prepareDailyPlanningInputs(dailyDecisionInputFixture());
  assert.ok(base.ok);
  for (const symbol of ["BTCUSDT", "ETHUSDT", "SOLUSDT", "DOGEUSDT"]) {
    const c = composition(symbol);
    for (const [values, expected, support] of [
      [["1", "1", "1", "1", "1"], "ADD_LONG", "75"],
      [["-1", "-1", "0", "1", "1"], "REDUCE_LONG", "75"],
      [["0", "0", "0", "0", "0"], "HOLD_LONG", "0"],
      [["1", "0", "0", "-1", "1"], "HOLD_LONG", "50"],
    ] as const) {
      const operands = Object.fromEntries(
        ["return-24h", "return-3d", "liquidation-12h", "funding", "oi-24h"].map(
          (id, i) => [id, values[i]],
        ),
      );
      const input: DailyPlanningInputs = {
        ...base.value,
        symbol: c.symbol,
        decisionPolicy: c.decisionPolicy,
        selectors: c.decisionPolicy.selectors.map((s) => ({
          selectorId: s.id,
          status: "available" as const,
          value: fixtureDecimal(operands[s.id]!),
        })),
      };
      const decision = evaluateDailyDecision(input);
      assert.ok(decision.ok);
      assert.equal(decision.value.recommendation, expected);
      if (expected === "ADD_LONG")
        assert.equal(decision.value.addWeightedSupport.toString(), support);
      if (expected === "REDUCE_LONG")
        assert.equal(decision.value.reduceWeightedSupport.toString(), support);
      for (const selector of input.selectors) {
        assert.equal(
          evaluateDailyDecision({
            ...input,
            selectors: input.selectors.map((s) =>
              s === selector
                ? { selectorId: s.selectorId, status: "absent" as const }
                : s,
            ),
          }).ok,
          false,
        );
      }
    }
  }
});
