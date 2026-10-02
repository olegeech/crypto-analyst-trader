import assert from "node:assert/strict";
import test from "node:test";
import { prepareDailyPlanningInputs } from "../src/domain/planning/daily-planning-inputs.js";
import { dailyInputFixture } from "./fixtures/daily-planning-policy-fixtures.js";
export { dailyInputFixture } from "./fixtures/daily-planning-policy-fixtures.js";
import { createDataQualityAssessment } from "../src/domain/quality/data-quality-assessment.js";

test("daily inputs select only exact assessed source and output identities", () => {
  const raw = dailyInputFixture();
  const result = prepareDailyPlanningInputs(raw);
  assert.ok(result.ok, result.ok ? "" : result.error.message);
  assert.equal(result.value.evidenceConfidence.toString(), "85");
  assert.equal(result.value.atr.toString(), "4");
  assert.equal(result.value.selectors[0]?.value?.toString(), "2");
  assert.ok(Object.isFrozen(result.value));
  assert.ok(result.value.constraints.maxPrice);
});
test("swapped evidence, rejected outputs and missing mandatory ATR fail closed", () => {
  const raw = dailyInputFixture();
  for (const altered of [
    { ...raw, market: { ...raw.market, runId: "swapped" } },
    { ...raw, assessment: { ...raw.assessment, contentHash: "a".repeat(64) } },
    { ...raw, analytics: { ...raw.analytics, contentHash: "a".repeat(64) } },
    {
      ...raw,
      planningPolicy: {
        ...raw.planningPolicy,
        atrSelector: {
          ...raw.planningPolicy.atrSelector,
          requestId: "missing",
        },
      },
    },
    { ...raw, symbol: "ETHUSDT" },
  ])
    assert.equal(prepareDailyPlanningInputs(altered).ok, false);
});

test("accepted parent cannot override rejected output, and absent confidence is not defaulted", () => {
  const raw = dailyInputFixture();
  const { contentHash: _hash, ...payload } = raw.assessment;
  void _hash;
  const rejected = createDataQualityAssessment({
    ...payload,
    dispositions: payload.dispositions.map((row) =>
      row.role === "analytics:return"
        ? { ...row, disposition: "rejected" as const }
        : row,
    ),
  });
  assert.ok(rejected.ok);
  assert.equal(
    prepareDailyPlanningInputs({ ...raw, assessment: rejected.value }).ok,
    false,
  );
  const { evidenceConfidence: _confidence, ...noConfidence } = payload;
  void _confidence;
  const missing = createDataQualityAssessment(noConfidence);
  assert.ok(missing.ok);
  const result = prepareDailyPlanningInputs({
    ...raw,
    assessment: missing.value,
  });
  assert.ok(!result.ok);
  assert.equal(result.error.message, "MISSING_EVIDENCE_CONFIDENCE");
});

test("optional absent and rejected selectors remain unavailable rather than zero", () => {
  const raw = dailyInputFixture();
  const decisionPolicy = {
    ...raw.decisionPolicy,
    selectors: [
      {
        ...raw.decisionPolicy.selectors[0]!,
        requestId: "absent",
        required: false,
      },
    ],
  };
  const result = prepareDailyPlanningInputs({ ...raw, decisionPolicy });
  assert.ok(result.ok);
  assert.equal(result.value.selectors[0]?.status, "unavailable");
  assert.equal(result.value.selectors[0]?.value, undefined);
  // Static upper bounds are needed only at ADD compilation, not evidence selection.
  assert.ok(prepareDailyPlanningInputs(dailyInputFixture(false)).ok);
});
