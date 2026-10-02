import assert from "node:assert/strict";
import test from "node:test";
import { createDataQualityBoundary } from "../src/application/data-quality-assessment.js";
import { evaluateDailyDecision } from "../src/domain/planning/daily-decision.js";
import { prepareDailyPlanningInputs } from "../src/domain/planning/daily-planning-inputs.js";
import type { ExternalApplicability } from "../src/domain/planning/decision-policy.js";
import type { ExternalEvidenceFamily } from "../src/domain/analytics/external-regime-evidence.js";
import { createDataQualityAssessment } from "../src/domain/quality/data-quality-assessment.js";
import {
  analyticsFixture,
  externalEvidenceFixture,
  externalSourceFixtureRefs,
  fixtureCanonicalHash,
} from "./fixtures/data-quality-fixtures.js";
import { dailyInputFixture } from "./fixtures/daily-planning-policy-fixtures.js";
import {
  dailyQualityProfileFixture,
  requireDailyFixture,
} from "./fixtures/daily-planning-evidence-fixtures.js";

const directions = {
  "market-regime-score": "higher-is-healthier",
  "early-warning-risk": "higher-is-warning",
  "liquidity-stress": "higher-is-stress",
} as const;

function selector(
  family: ExternalEvidenceFamily = "market-regime-score",
  field = "score",
  required = false,
  applicability: ExternalApplicability = { scope: "symbol", symbol: "BTCUSDT" },
) {
  return {
    id: "external",
    source: "external",
    family,
    field,
    required,
    applicability,
    ...(family === "trap" ? {} : { direction: directions[family] }),
  };
}

// All ordinary scenarios obtain #13 authority through controlled ingestion of
// the actual validated #12 artifact, including its full market-bundle lineage.
function fixture(
  family: ExternalEvidenceFamily = "market-regime-score",
  admission:
    "admitted" | "missing" | "rejected" | "different-artifact" = "admitted",
  qualityRequired = false,
) {
  const base = dailyInputFixture();
  const external = externalEvidenceFixture(family, base.market, {
    inputEvidenceRefs: externalSourceFixtureRefs(base.market),
  });
  const analytics = analyticsFixture(base.market, {
    profile: {
      ...base.analytics.profile,
      externalEvidence: [{ family, required: qualityRequired }],
    },
    externalEvidence: { [family]: external },
  });
  const profile = dailyQualityProfileFixture();
  let calls = 0;
  const boundary = requireDailyFixture(
    createDataQualityBoundary({
      qualityProfile: {
        ...profile,
        roles: [
          ...profile.roles,
          {
            id: `external:${family}`,
            required: qualityRequired,
            maxAgeMs: 60000,
          },
        ],
        penalties: [
          ...profile.penalties,
          {
            reasonCode: "UNTRUSTED_EVIDENCE",
            confidenceImpactGroup: "external",
            penalty: "8",
          },
        ],
        trust: [
          {
            issuer: "controlled-ingestion",
            family,
            producer:
              admission === "rejected"
                ? "untrusted-producer"
                : external.provenance.producer,
            schemaVersion: external.schemaVersion,
            modelVersion: external.modelVersion,
          },
        ],
      },
      issuer: "controlled-ingestion",
      ...(admission === "missing"
        ? {}
        : {
            ingestExternal: (requested: ExternalEvidenceFamily) => {
              calls++;
              assert.equal(requested, family);
              return admission === "different-artifact"
                ? externalEvidenceFixture(family, base.market, {
                    inputEvidenceRefs: externalSourceFixtureRefs(base.market),
                    validForMs: 30000,
                  })
                : external;
            },
          }),
    }),
  );
  const assessment = requireDailyFixture(
    boundary.assess({
      sources: [
        { role: "market", value: base.market },
        { role: "analytics", value: analytics },
      ],
      bundleCutoff: base.market.bundleCutoff,
      evaluationTime: base.market.bundleCutoff,
    }),
  );
  assert.equal(calls, admission === "missing" ? 0 : 1);
  return { ...base, analytics, assessment, external };
}

function policy(
  f: ReturnType<typeof fixture>,
  selected: unknown,
  threshold = "50",
) {
  return {
    ...f.decisionPolicy,
    symbolApplicability: ["BTCUSDT", "ETHUSDT"],
    selectors: [selected],
    groups: [
      {
        id: "external-group",
        weight: "1",
        rules: [
          {
            id: "external-rule",
            target: "ADD_LONG",
            support: "90.125",
            conditions: [
              { selectorId: "external", comparison: "eq", threshold },
            ],
          },
        ],
      },
    ],
  };
}

function blocked(
  input: Parameters<typeof prepareDailyPlanningInputs>[0],
  reason: string,
) {
  const result = prepareDailyPlanningInputs(input);
  assert.ok(!result.ok);
  assert.equal(result.error.message, reason);
}

function decision(
  f: ReturnType<typeof fixture>,
  selected: unknown,
  threshold: string,
  available: boolean,
) {
  const prepared = requireDailyFixture(
    prepareDailyPlanningInputs({
      ...f,
      decisionPolicy: policy(f, selected, threshold),
    }),
  );
  assert.deepEqual(
    prepared.selectors.map((row) => ({
      ...row,
      ...(row.value === undefined ? {} : { value: row.value.toString() }),
    })),
    [
      {
        selectorId: "external",
        status: available ? "available" : "unavailable",
        ...(available ? { value: threshold } : {}),
      },
    ],
  );
  const result = requireDailyFixture(evaluateDailyDecision(prepared));
  assert.equal(result.recommendation, available ? "ADD_LONG" : "HOLD_LONG");
  assert.equal(
    result.addWeightedSupport.toString(),
    available ? "90.125" : "0",
  );
  assert.equal(result.decisionSupport.toString(), available ? "90.125" : "0");
  assert.equal(result.decisionConfidence.toString(), available ? "85" : "0");
  assert.equal(result.addAgreeingGroupCount, available ? 1 : 0);
  const rule = result.groups[0]!.rules[0]!;
  assert.equal(rule.matched, available);
  assert.equal(
    rule.conditions[0]!.status,
    available ? "matched" : "unavailable",
  );
  assert.equal(
    rule.conditions[0]!.value?.toString(),
    available ? threshold : undefined,
  );
}

for (const family of [
  "market-regime-score",
  "early-warning-risk",
  "liquidity-stress",
] as const) {
  for (const [field, expected] of [
    ["score", "50"],
    ["confidence", "80"],
  ] as const) {
    test(`controlled ${family} admission extracts exact ${field} and decision support`, () => {
      const f = fixture(family);
      assert.equal(f.assessment.qualityGate, "OK");
      const row = f.assessment.dispositions.find(
        (item) => item.role === `external:${family}`,
      )!;
      assert.equal(row.disposition, "accepted");
      assert.equal(row.contentHash, f.external.contentHash);
      assert.deepEqual(row.admission, {
        issuer: "controlled-ingestion",
        artifactHash: f.external.contentHash,
      });
      decision(f, selector(family, field, true), expected, true);
    });
  }
}

for (const [field, expected] of [
  ["confidence", "80"],
  ["continuation", "0.1"],
  ["reversal", "0.3"],
  ["squeeze", "0.2"],
  ["range", "0.4"],
] as const) {
  test(`controlled trap admission extracts ${field} without confusing confidence and likelihood`, () => {
    const f = fixture("trap");
    assert.equal(
      f.assessment.dispositions.find((row) => row.role === "external:trap")
        ?.admission?.artifactHash,
      f.external.contentHash,
    );
    decision(f, selector("trap", field, true), expected, true);
  });
}

for (const admission of [
  "missing",
  "rejected",
  "different-artifact",
] as const) {
  test(`${admission} admission leaves optional evidence unavailable and contributes no support`, () => {
    const f = fixture("market-regime-score", admission);
    assert.equal(f.assessment.qualityGate, "OK");
    const row = f.assessment.dispositions.find(
      (item) => item.role === "external:market-regime-score",
    )!;
    assert.equal(row.disposition, "rejected");
    assert.equal(row.admission, undefined);
    decision(f, selector(), "50", false);
    blocked(
      {
        ...f,
        decisionPolicy: policy(
          f,
          selector("market-regime-score", "score", true),
        ),
      },
      "MANDATORY_INPUT_UNAVAILABLE",
    );
  });
  test(`${admission} admission for quality-required evidence blocks actual daily preparation`, () => {
    const f = fixture("market-regime-score", admission, true);
    assert.equal(f.assessment.qualityGate, "BLOCK");
    assert.ok(
      f.assessment.findings.some(
        (row) =>
          row.role === "external:market-regime-score" &&
          row.blocking &&
          row.reasonCode === "UNTRUSTED_EVIDENCE",
      ),
    );
    blocked({ ...f, decisionPolicy: policy(f, selector()) }, "QUALITY_BLOCKED");
  });
}

for (const applicability of [
  { scope: "symbol", symbol: "BTCUSDT" },
  { scope: "symbol", symbol: "ETHUSDT" },
  { scope: "global", symbols: ["BTCUSDT", "ETHUSDT"] },
  { scope: "global", symbols: ["ETHUSDT"] },
] satisfies ExternalApplicability[]) {
  test(`external applicability ${JSON.stringify(applicability)} controls contribution and required availability`, () => {
    const f = fixture();
    const applies =
      applicability.scope === "symbol"
        ? applicability.symbol === "BTCUSDT"
        : applicability.symbols.includes("BTCUSDT");
    decision(
      f,
      selector("market-regime-score", "score", false, applicability),
      "50",
      applies,
    );
    const input = {
      ...f,
      decisionPolicy: policy(
        f,
        selector("market-regime-score", "score", true, applicability),
      ),
    };
    if (applies) assert.ok(prepareDailyPlanningInputs(input).ok);
    else blocked(input, "MANDATORY_INPUT_UNAVAILABLE");
  });
}

test("external direction mismatch is rejected by the versioned policy before preparation", () => {
  const f = fixture();
  blocked(
    {
      ...f,
      decisionPolicy: policy(f, {
        ...selector(),
        direction: "higher-is-warning",
      }),
    },
    "INVALID_DECISION_POLICY",
  );
});

test("historical replay with an external disposition bound to a different artifact fails identity checks", () => {
  const f = fixture();
  const other = externalEvidenceFixture("market-regime-score", f.market, {
    validForMs: 30000,
  });
  const { contentHash: _hash, ...payload } = f.assessment;
  void _hash;
  // This constructor models corrupt historical replay only, never live admission.
  const assessment = requireDailyFixture(
    createDataQualityAssessment({
      ...payload,
      dispositions: payload.dispositions.map((row) =>
        row.role === "external:market-regime-score"
          ? {
              ...row,
              contentHash: other.contentHash,
              admission: {
                issuer: "controlled-ingestion",
                artifactHash: other.contentHash,
              },
            }
          : row,
      ),
    }),
  );
  assert.notEqual(assessment.contentHash, f.assessment.contentHash);
  blocked(
    { ...f, assessment, decisionPolicy: policy(f, selector()) },
    "INPUT_IDENTITY_MISMATCH",
  );
});

test("tampering with the admitted external payload cannot survive analytics hash validation", () => {
  const f = fixture();
  const analytics = {
    ...f.analytics,
    externalEvidence: f.analytics.externalEvidence.map((row) => ({
      ...row,
      confidence: f.market.symbols[0]!.ticker!.bid,
    })),
  };
  assert.notEqual(
    fixtureCanonicalHash(analytics),
    fixtureCanonicalHash(f.analytics),
  );
  blocked(
    { ...f, analytics, decisionPolicy: policy(f, selector()) },
    "INPUT_IDENTITY_MISMATCH",
  );
});
