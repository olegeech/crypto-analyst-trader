import assert from "node:assert/strict";
import test from "node:test";
import { prepareDailyPlanningInputs } from "../src/domain/planning/daily-planning-inputs.js";
import { dailyEvidenceFixture } from "./fixtures/daily-planning-evidence-fixtures.js";
import { createDataQualityAssessment } from "../src/domain/quality/data-quality-assessment.js";

function policies() {
  return {
    decisionPolicy: {
      schemaVersion: "decision-policy/v1",
      policyVersion: "fixture-v1",
      symbolApplicability: ["BTCUSDT"],
      selectors: [
        {
          id: "return",
          source: "native",
          requestId: "return",
          kind: "close-return",
          field: "percent",
          symbol: "BTCUSDT",
          required: true,
        },
      ],
      groups: [
        {
          id: "trend",
          weight: "1",
          rules: [
            {
              id: "add",
              target: "ADD_LONG",
              support: "90",
              conditions: [
                { selectorId: "return", comparison: "gte", threshold: "0" },
              ],
            },
          ],
        },
      ],
      addLong: { supportThreshold: "80", minAgreeingGroups: 1 },
      reduceLong: { supportThreshold: "80", minAgreeingGroups: 1 },
      reductionFraction: "0.25",
    },
    planningPolicy: {
      schemaVersion: "planning-policy/v1",
      policyVersion: "fixture-v1",
      atrSelector: {
        source: "native",
        requestId: "atr",
        kind: "atr",
        field: "atr",
        symbol: "BTCUSDT",
        required: true,
      },
      anchor: "bid-capped-below-ask/v1",
      entryRounding: "floor",
      quantityRounding: "floor",
      takeProfitRounding: "ceil",
      timeInForce: "GTC",
      levels: [
        { atrOffset: "0", allocationWeight: "1", takeProfitAtrDistance: "1" },
      ],
    },
  };
}
export function dailyInputFixture(bounds = true) {
  const f = dailyEvidenceFixture(bounds);
  return { ...f, ...policies(), symbol: "BTCUSDT", allocation: "100" };
}
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
