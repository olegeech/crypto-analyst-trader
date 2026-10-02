import assert from "node:assert/strict";
import test from "node:test";
import { evaluateDailyDecision } from "../src/domain/planning/daily-decision.js";
import {
  prepareDailyPlanningInputs,
  type DailyPlanningInputs,
} from "../src/domain/planning/daily-planning-inputs.js";
import {
  createDecisionPolicy,
  type NumericComparison,
} from "../src/domain/planning/decision-policy.js";
import { DecimalValue } from "../src/domain/shared/decimal.js";
import { createDataQualityAssessment } from "../src/domain/quality/data-quality-assessment.js";
import { dailyDecisionInputFixture } from "./fixtures/daily-planning-policy-fixtures.js";

function decimal(value: string) {
  const parsed = DecimalValue.fromString(value);
  assert.ok(parsed.ok);
  return parsed.value;
}
function inputs() {
  const prepared = prepareDailyPlanningInputs(dailyDecisionInputFixture());
  assert.ok(prepared.ok, prepared.ok ? "" : prepared.error.message);
  return prepared.value;
}
function configured(
  rows: readonly (readonly [string, string, string, string?])[],
  threshold = "30",
  quorum = 1,
  confidence = "100",
) {
  const base = inputs();
  const policy = createDecisionPolicy({
    ...base.decisionPolicy,
    groups: rows.map(([weight, add, reduce, hold], i) => ({
      id: `g${i}`,
      weight,
      rules: [
        ["ADD_LONG", add],
        ["REDUCE_LONG", reduce],
        ...(hold === undefined ? [] : [["HOLD_LONG", hold]]),
      ].map(([target, support], j) => ({
        id: `r${i}-${j}`,
        target,
        support,
        conditions: [
          { selectorId: "return", comparison: "gte", threshold: "0" },
        ],
      })),
    })),
    addLong: { supportThreshold: threshold, minAgreeingGroups: quorum },
    reduceLong: { supportThreshold: threshold, minAgreeingGroups: quorum },
  });
  assert.ok(policy.ok);
  return {
    ...base,
    decisionPolicy: policy.value,
    evidenceConfidence: decimal(confidence),
  };
}
function evaluate(input: DailyPlanningInputs) {
  const result = evaluateDailyDecision(input);
  assert.ok(result.ok, result.ok ? "" : result.error.message);
  return result.value;
}

test("one qualified direction wins; both and neither HOLD with stable reasons", () => {
  for (const [add, reduce, expected] of [
    ["82", "0", "ADD_LONG"],
    ["0", "82", "REDUCE_LONG"],
    ["1", "2", "HOLD_LONG"],
  ]) {
    const decision = evaluate(
      configured([["1", add!, reduce!]], "30", 1, "68"),
    );
    assert.equal(decision.recommendation, expected);
    assert.equal(
      decision.decisionConfidence.toString(),
      expected === "HOLD_LONG" ? "0" : "68",
    );
    if (expected === "HOLD_LONG")
      assert.ok(
        decision.reasons.includes("INSUFFICIENT_DIRECTIONAL_AGREEMENT"),
      );
  }
  const conflict = evaluate(
    configured([
      ["0.5", "90", "0", "80"],
      ["0.5", "0", "90", "100"],
    ]),
  );
  assert.equal(conflict.recommendation, "HOLD_LONG");
  assert.ok(conflict.reasons.includes("DIRECTIONAL_CONFLICT"));
  assert.equal(conflict.decisionSupport.toString(), "90");
});
test("threshold and quorum equality qualify, and each alone is insufficient", () => {
  assert.equal(
    evaluate(configured([["1", "30", "0"]])).recommendation,
    "ADD_LONG",
  );
  assert.equal(
    evaluate(
      configured(
        [
          ["0.5", "60", "0"],
          ["0.5", "0", "0"],
        ],
        "30",
        2,
      ),
    ).recommendation,
    "HOLD_LONG",
  );
  assert.equal(
    evaluate(configured([["1", "29.999", "0"]])).recommendation,
    "HOLD_LONG",
  );
  assert.equal(
    evaluate(configured([["1", "0", "30"]])).recommendation,
    "REDUCE_LONG",
  );
  assert.equal(
    evaluate(
      configured(
        [
          ["0.5", "0", "60"],
          ["0.5", "0", "0"],
        ],
        "30",
        2,
      ),
    ).recommendation,
    "HOLD_LONG",
  );
  assert.equal(
    evaluate(configured([["1", "0", "29.999"]])).recommendation,
    "HOLD_LONG",
  );
});
test("group preference is strict and positive; weighted support remains independent", () => {
  for (const support of ["0", "90"]) {
    const result = evaluate(configured([["1", support, support]]));
    assert.equal(result.addAgreeingGroupCount, 0);
    assert.equal(result.reduceAgreeingGroupCount, 0);
    assert.equal(result.addWeightedSupport.toString(), support);
    assert.equal(result.reduceWeightedSupport.toString(), support);
  }
  const result = evaluate(configured([["1", "1", "90"]]));
  assert.equal(result.addAgreeingGroupCount, 0);
  assert.equal(result.reduceAgreeingGroupCount, 1);
  assert.equal(result.addWeightedSupport.toString(), "1");
  assert.equal(result.reduceWeightedSupport.toString(), "90");
});
test("100/0, 1/90, 1/90 cannot create ADD quorum from weak matches", () => {
  const result = evaluate(
    configured(
      [
        ["0.34", "100", "0"],
        ["0.33", "1", "90"],
        ["0.33", "1", "90"],
      ],
      "30",
      3,
    ),
  );
  assert.equal(result.addWeightedSupport.toString(), "34.66");
  assert.equal(result.reduceWeightedSupport.toString(), "59.4");
  assert.equal(result.addAgreeingGroupCount, 1);
  assert.equal(result.reduceAgreeingGroupCount, 2);
  assert.equal(result.recommendation, "HOLD_LONG");
  assert.deepEqual(result.reasons, ["INSUFFICIENT_DIRECTIONAL_AGREEMENT"]);
});
test("correlated rules use a maximum; AND conditions trace all operands and OR alternatives match", () => {
  const base = configured([["1", "40", "0"]]);
  const rule = base.decisionPolicy.groups[0]!.rules[0]!;
  const parsed = createDecisionPolicy({
    ...base.decisionPolicy,
    selectors: [
      ...base.decisionPolicy.selectors,
      { ...base.decisionPolicy.selectors[0]!, id: "optional" },
    ],
    groups: [
      {
        id: "trend",
        weight: "1",
        rules: [
          rule,
          { ...rule, id: "strong", support: "82" },
          {
            ...rule,
            id: "unavailable",
            support: "100",
            conditions: [
              { selectorId: "return", comparison: "lt", threshold: "0" },
              { selectorId: "optional", comparison: "eq", threshold: "0" },
            ],
          },
        ],
      },
    ],
  });
  assert.ok(parsed.ok);
  for (const status of ["unavailable", "absent"] as const) {
    const result = evaluate({
      ...base,
      decisionPolicy: parsed.value,
      selectors: [...base.selectors, { selectorId: "optional", status }],
    });
    assert.equal(result.decisionSupport.toString(), "82");
    const unavailable = result.groups[0]!.rules.find(
      (r) => r.ruleId === "unavailable",
    )!;
    assert.equal(unavailable.matched, false);
    assert.equal(unavailable.conditions.length, 2);
    const present = unavailable.conditions.find(
      (c) => c.selectorId === "return",
    )!;
    const missing = unavailable.conditions.find(
      (c) => c.selectorId === "optional",
    )!;
    assert.equal(present.status, "unmatched");
    assert.equal(present.value!.toString(), "2");
    assert.equal(present.threshold.toString(), "0");
    assert.equal(missing.status, status);
    assert.equal(missing.value, undefined);
  }
});
test("all five comparisons use exact decimals and retain unmatched conditions", () => {
  for (const [comparison, threshold, matched] of [
    ["lt", "2.0001", true],
    ["lt", "2", false],
    ["lte", "2", true],
    ["eq", "2", true],
    ["eq", "2.0001", false],
    ["gte", "2", true],
    ["gt", "1.9999", true],
    ["gt", "2", false],
  ] as const) {
    const base = configured([["1", "82", "0"]]);
    const parsed = createDecisionPolicy({
      ...base.decisionPolicy,
      groups: [
        {
          id: "g",
          weight: "1",
          rules: [
            {
              id: "r",
              target: "ADD_LONG",
              support: "82",
              conditions: [
                {
                  selectorId: "return",
                  comparison: comparison satisfies NumericComparison,
                  threshold,
                },
              ],
            },
          ],
        },
      ],
    });
    assert.ok(parsed.ok);
    assert.equal(
      evaluate({ ...base, decisionPolicy: parsed.value }).groups[0]!.rules[0]!
        .matched,
      matched,
    );
  }
});
test("HOLD support is only explicit HOLD support, confidence is exact minimum at boundaries", () => {
  for (const confidence of ["0", "68", "100"]) {
    const hold = evaluate(
      configured([["1", "90", "90", "100"]], "30", 1, confidence),
    );
    assert.equal(hold.decisionConfidence.toString(), confidence);
    assert.equal(hold.decisionSupport.toString(), "100");
    assert.equal(
      evaluate(
        configured([["1", "90", "90"]], "30", 1, confidence),
      ).decisionSupport.toString(),
      "0",
    );
    assert.equal(
      evaluate(
        configured([["1", "82", "0"]], "30", 1, confidence),
      ).decisionConfidence.toString(),
      confidence === "100" ? "82" : confidence,
    );
  }
});
test("explicit zero is available, absent operands are never fabricated, negative operands stay usable", () => {
  const base = configured([["1", "82", "0"]]);
  const zero = evaluate({
    ...base,
    selectors: [
      { selectorId: "return", status: "available", value: decimal("0") },
    ],
  });
  assert.equal(zero.recommendation, "ADD_LONG");
  assert.equal(zero.groups[0]!.rules[0]!.conditions[0]!.status, "matched");
  const absent = evaluate({
    ...base,
    selectors: [{ selectorId: "return", status: "absent" }],
  });
  assert.equal(absent.recommendation, "HOLD_LONG");
  assert.equal(absent.addWeightedSupport.toString(), "0");
  const negative = evaluate({
    ...base,
    selectors: [
      { selectorId: "return", status: "available", value: decimal("-0.01") },
    ],
  });
  assert.equal(negative.recommendation, "HOLD_LONG");
  assert.equal(
    negative.groups[0]!.rules[0]!.conditions[0]!.value!.toString(),
    "-0.01",
  );
});
test("repeated calls and equivalent policy orderings preserve immutable explanations", () => {
  const base = configured([
    ["0.5", "82", "0"],
    ["0.5", "90", "0"],
  ]);
  const result = evaluate(base);
  const reordered = {
    ...base,
    decisionPolicy: {
      ...base.decisionPolicy,
      groups: [...base.decisionPolicy.groups]
        .reverse()
        .map((g) => ({ ...g, rules: [...g.rules].reverse() })),
    },
    selectors: [...base.selectors].reverse(),
  };
  assert.deepEqual(evaluate(base), result);
  assert.deepEqual(evaluate(reordered), result);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.groups[0]!.rules[0]!.conditions));
});
test("rejected optional output cannot influence evaluation through an accepted parent", () => {
  const raw = dailyDecisionInputFixture();
  const { contentHash: _hash, ...payload } = raw.assessment;
  void _hash;
  const rejected = createDataQualityAssessment({
    ...payload,
    dispositions: payload.dispositions.map((r) =>
      r.role === "analytics:return" ? { ...r, disposition: "rejected" } : r,
    ),
  });
  assert.ok(rejected.ok);
  const prepared = prepareDailyPlanningInputs({
    ...raw,
    assessment: rejected.value,
  });
  assert.ok(prepared.ok);
  const result = evaluate(prepared.value);
  assert.equal(result.recommendation, "HOLD_LONG");
  assert.equal(result.addWeightedSupport.toString(), "0");
  assert.equal(
    result.groups[0]!.rules[0]!.conditions[0]!.status,
    "unavailable",
  );
});
test("public boundary rejects malformed observations, confidence, policy and SHORT targets", () => {
  const base = inputs();
  const invalid: unknown[] = [
    null,
    {},
    { ...base, evidenceConfidence: decimal("-1") },
    { ...base, evidenceConfidence: decimal("100.01") },
    { ...base, evidenceConfidence: "85" },
    { ...base, selectors: [] },
    { ...base, selectors: [...base.selectors, ...base.selectors] },
    {
      ...base,
      selectors: [
        { selectorId: "unknown", status: "available", value: decimal("2") },
      ],
    },
    {
      ...base,
      selectors: [{ selectorId: "return", status: "available", value: "2" }],
    },
    {
      ...base,
      selectors: [
        { selectorId: "return", status: "unavailable", value: decimal("0") },
      ],
    },
    { ...base, selectors: [{ selectorId: "return", status: "invalid" }] },
    {
      ...base,
      decisionPolicy: {
        ...base.decisionPolicy,
        selectors: [
          {
            id: "return",
            source: "external",
            family: "market-regime-score",
            field: "score",
            direction: "higher-is-warning",
            required: false,
            applicability: { scope: "symbol", symbol: "BTCUSDT" },
          },
        ],
      },
    },
    {
      ...base,
      decisionPolicy: {
        ...base.decisionPolicy,
        groups: [
          {
            ...base.decisionPolicy.groups[0]!,
            rules: [
              {
                ...base.decisionPolicy.groups[0]!.rules[0]!,
                target: "ADD_SHORT",
              },
            ],
          },
        ],
      },
    },
    {
      ...base,
      decisionPolicy: {
        ...base.decisionPolicy,
        selectors: [
          { ...base.decisionPolicy.selectors[0]!, kind: "unsupported" },
        ],
      },
    },
  ];
  for (const value of invalid) {
    // Model a caller bypassing the public TypeScript signature.
    assert.equal(evaluateDailyDecision(value as DailyPlanningInputs).ok, false);
  }
});
