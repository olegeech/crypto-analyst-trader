import assert from "node:assert/strict";
import test from "node:test";
import {
  createDataQualityAssessment,
  rehydrateDataQualityAssessment,
  type DataQualityAssessmentPayload,
} from "../src/domain/quality/data-quality-assessment.js";
import {
  encodeCanonicalArtifact,
  rehydrateArtifact,
} from "../src/domain/identity/canonical-artifact.js";
import {
  hashCanonical,
  type PlanHash,
} from "../src/domain/identity/canonical-serialization.js";
import { parseDecimal } from "../src/domain/shared/decimal.js";
import { parseUtcTimestamp } from "../src/domain/shared/time.js";
import type { Result } from "../src/domain/shared/result.js";
import {
  assessDataQuality,
  issueQualityAdmission,
} from "../src/domain/quality/assess-data-quality.js";
import { createQualityProfile } from "../src/domain/quality/quality-profile.js";
import {
  marketFixture,
  analyticsFixture,
  externalEvidenceFixture,
} from "./fixtures/data-quality-fixtures.js";

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
const hash = `sha256:${"a".repeat(64)}` as PlanHash;
function payload(): DataQualityAssessmentPayload {
  return {
    schemaVersion: "data-quality-assessment/v1",
    qualityGate: "OK",
    profileVersion: "quality:v1",
    profileHash: hash,
    evaluationTime: value(parseUtcTimestamp("2026-10-02T01:00:00Z")),
    bundleCutoff: value(parseUtcTimestamp("2026-10-02T00:00:00Z")),
    findings: [
      {
        role: "external:regime",
        reasonCode: "PARTIAL_ANALYTICS",
        blocking: false,
        confidenceImpactGroup: "regime",
      },
    ],
    dispositions: [
      {
        role: "external:regime",
        disposition: "accepted",
        contentHash: hash,
        admission: { issuer: "research", artifactHash: hash },
      },
    ],
    appliedPenalties: [
      {
        confidenceImpactGroup: "regime",
        penalty: value(parseDecimal("12.25")),
      },
    ],
    evidenceConfidence: value(parseDecimal("87.75")),
  };
}
function signed(input: Record<string, unknown>) {
  return { ...input, contentHash: value(hashCanonical(input)) };
}
test("assessment registry roundtrips exact decimals, identity and historical admission", () => {
  const assessment = value(createDataQualityAssessment(payload()));
  const envelope = value(
    encodeCanonicalArtifact("data-quality-assessment", assessment),
  );
  const restored = value(
    rehydrateArtifact("data-quality-assessment", envelope),
  );
  assert.deepEqual(restored, assessment);
  assert.equal(restored.evidenceConfidence?.toString(), "87.75");
  assert.notEqual(
    restored.dispositions[0]?.admission,
    assessment.dispositions[0]?.admission,
  );
  assert.ok(Object.isFrozen(restored.dispositions[0]?.admission));
  assert.deepEqual(
    value(
      rehydrateDataQualityAssessment(JSON.parse(JSON.stringify(assessment))),
    ),
    assessment,
  );
  assert.deepEqual(
    value(rehydrateDataQualityAssessment(assessment)),
    assessment,
  );
});
test("assessment rehydration rejects changed content and registry envelope tampering", () => {
  const assessment = value(createDataQualityAssessment(payload()));
  assert.equal(
    rehydrateDataQualityAssessment({ ...assessment, profileVersion: "other" })
      .ok,
    false,
  );
  const envelope = value(
    encodeCanonicalArtifact("data-quality-assessment", assessment),
  );
  assert.equal(
    rehydrateArtifact("data-quality-assessment", {
      ...envelope,
      canonicalJson: envelope.canonicalJson.replace("87.75", "99"),
    }).ok,
    false,
  );
});
test("runtime validation rejects invalid payloads even with recomputed hashes", () => {
  const base = payload();
  const variants: Record<string, unknown>[] = [
    { ...base, schemaVersion: "data-quality-assessment/v2" },
    { ...base, profileVersion: "" },
    { ...base, profileHash: "bad" },
    { ...base, evaluationTime: "2026-02-30T00:00:00Z" },
    { ...base, bundleCutoff: "2026-10-03T00:00:00.000Z" },
    { ...base, qualityGate: "BLOCK" },
    { ...base, qualityGate: "REVIEW" },
    { ...base, evidenceConfidence: "100.000000000000000001" },
    { ...base, evidenceConfidence: "-0.000000000000000001" },
    { ...base, evidenceConfidence: 87 },
    { ...base, evidenceConfidence: "88" },
    { ...base, raw: {} },
    {
      ...base,
      findings: [
        { role: "external:regime", reasonCode: "UNKNOWN", blocking: false },
      ],
    },
    { ...base, findings: [...base.findings, ...base.findings] },
    {
      ...base,
      findings: [{ ...base.findings[0], role: "z" }, ...base.findings],
    },
    { ...base, findings: [{ ...base.findings[0], raw: {} }] },
    {
      ...base,
      findings: [
        {
          role: "external:regime",
          reasonCode: "HASH_MISMATCH",
          blocking: false,
          confidenceImpactGroup: "regime",
        },
      ],
    },
    { ...base, findings: [{ ...base.findings[0], blocking: true }] },
    { ...base, dispositions: [...base.dispositions, ...base.dispositions] },
    {
      ...base,
      dispositions: [
        { role: "z", disposition: "missing" },
        ...base.dispositions,
      ],
    },
    { ...base, dispositions: [{ ...base.dispositions[0], raw: {} }] },
    {
      ...base,
      dispositions: [
        {
          ...base.dispositions[0],
          admission: {
            issuer: "research",
            artifactHash: `sha256:${"b".repeat(64)}`,
          },
        },
      ],
    },
    {
      ...base,
      dispositions: [
        {
          ...base.dispositions[0],
          admission: { issuer: "", artifactHash: hash },
        },
      ],
    },
    {
      ...base,
      dispositions: [
        {
          ...base.dispositions[0],
          admission: { issuer: "research", artifactHash: hash, trusted: true },
        },
      ],
    },
    {
      ...base,
      dispositions: [{ ...base.dispositions[0], disposition: "rejected" }],
    },
    { ...base, appliedPenalties: [] },
    {
      ...base,
      appliedPenalties: [...base.appliedPenalties, ...base.appliedPenalties],
    },
    {
      ...base,
      appliedPenalties: [{ confidenceImpactGroup: "other", penalty: "12.25" }],
    },
    {
      ...base,
      appliedPenalties: [{ confidenceImpactGroup: "regime", penalty: "-1" }],
    },
    {
      ...base,
      appliedPenalties: [
        { confidenceImpactGroup: "regime", penalty: "100.000000000000000001" },
      ],
    },
    {
      ...base,
      appliedPenalties: [
        { confidenceImpactGroup: "regime", penalty: "12.25", raw: {} },
      ],
    },
  ];
  for (const input of variants) {
    assert.equal(
      createDataQualityAssessment(
        input as unknown as DataQualityAssessmentPayload,
      ).ok,
      false,
      JSON.stringify(input),
    );
    const restored = rehydrateDataQualityAssessment(signed(input));
    assert.equal(restored.ok, false, JSON.stringify(input));
    const envelope = encodeCanonicalArtifact(
      "data-quality-assessment",
      signed(input),
    );
    if (envelope.ok)
      assert.equal(
        rehydrateArtifact("data-quality-assessment", envelope.value).ok,
        false,
      );
  }
});
test("confidence rejects floating point and remains exact at both bounds and the sum clamp", () => {
  assert.equal(
    createDataQualityAssessment({
      ...payload(),
      evidenceConfidence: 87.75,
    } as unknown as DataQualityAssessmentPayload).ok,
    false,
  );
  for (const penalty of ["0", "100"]) {
    const confidence = penalty === "0" ? "100" : "0";
    const assessment = value(
      createDataQualityAssessment({
        ...payload(),
        appliedPenalties: [
          {
            confidenceImpactGroup: "regime",
            penalty: value(parseDecimal(penalty)),
          },
        ],
        evidenceConfidence: value(parseDecimal(confidence)),
      }),
    );
    assert.equal(
      value(
        rehydrateArtifact(
          "data-quality-assessment",
          value(encodeCanonicalArtifact("data-quality-assessment", assessment)),
        ),
      ).evidenceConfidence?.toString(),
      confidence,
    );
  }
  const base = payload();
  const assessment = value(
    createDataQualityAssessment({
      ...base,
      findings: [
        ...base.findings,
        {
          role: "optional",
          reasonCode: "PARTIAL_ANALYTICS",
          blocking: false,
          confidenceImpactGroup: "second",
        },
      ],
      dispositions: [
        ...base.dispositions,
        { role: "optional", disposition: "rejected" },
      ],
      appliedPenalties: [
        { confidenceImpactGroup: "regime", penalty: value(parseDecimal("70")) },
        { confidenceImpactGroup: "second", penalty: value(parseDecimal("70")) },
      ],
      evidenceConfidence: value(parseDecimal("0")),
    }),
  );
  assert.equal(assessment.qualityGate, "OK");
  assert.equal(assessment.evidenceConfidence?.toString(), "0");
});
test("blocking assessments and absent confidence remain representable", () => {
  const base = payload();
  const { evidenceConfidence: _confidence, ...withoutConfidence } = base;
  void _confidence;
  assert.equal(createDataQualityAssessment(withoutConfidence).ok, true);
  assert.equal(
    createDataQualityAssessment({
      ...withoutConfidence,
      qualityGate: "BLOCK",
      findings: [
        {
          role: "external:regime",
          reasonCode: "MISSING_EVIDENCE",
          blocking: true,
        },
      ],
      dispositions: [{ role: "external:regime", disposition: "missing" }],
      appliedPenalties: [],
    }).ok,
    true,
  );
});
test("future authoritative cutoff remains an explicit blocking assessment", () => {
  const base = payload();
  const assessment = value(
    createDataQualityAssessment({
      ...base,
      bundleCutoff: value(parseUtcTimestamp("2026-10-03T00:00:00Z")),
      qualityGate: "BLOCK",
      findings: [
        {
          role: "external:regime",
          reasonCode: "FUTURE_INFORMATION",
          blocking: true,
        },
      ],
      dispositions: [
        { role: "external:regime", disposition: "rejected", contentHash: hash },
      ],
      appliedPenalties: [],
      evidenceConfidence: value(parseDecimal("100")),
    }),
  );
  assert.deepEqual(
    value(
      rehydrateArtifact(
        "data-quality-assessment",
        value(encodeCanonicalArtifact("data-quality-assessment", assessment)),
      ),
    ),
    assessment,
  );
});
test("assessor future cutoff blocks with assessment metadata and roundtrips canonically", () => {
  const market = marketFixture();
  const profile = value(
    createQualityProfile({
      schemaVersion: "quality-profile/v1",
      profileVersion: "future-cutoff-test-v1",
      roles: [{ id: "market", required: true, maxAgeMs: 60_000 }],
      metadataSkewMs: 1_000,
      trust: [],
      penalties: [],
    }),
  );
  const result = assessDataQuality({
    profile,
    sources: [{ role: "market", value: market }],
    bundleCutoff: market.bundleCutoff,
    evaluationTime: new Date(Date.parse(market.bundleCutoff) - 1).toISOString(),
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  const assessment = value(result);
  assert.equal(assessment.qualityGate, "BLOCK");
  assert.ok(
    assessment.findings.some(
      (finding) =>
        finding.role === "assessment" &&
        finding.reasonCode === "FUTURE_INFORMATION" &&
        finding.blocking,
    ),
  );
  assert.deepEqual(
    assessment.dispositions.map((row) => row.role),
    ["market"],
  );
  assert.deepEqual(
    value(
      rehydrateArtifact(
        "data-quality-assessment",
        value(encodeCanonicalArtifact("data-quality-assessment", assessment)),
      ),
    ),
    assessment,
  );
});
test("only blocking assessment future-information may omit a disposition", () => {
  const base = payload();
  const variants: DataQualityAssessmentPayload[] = [
    { ...base, dispositions: [] },
    ...(
      [
        { role: "market", reasonCode: "FUTURE_INFORMATION", blocking: true },
        { role: "assessment", reasonCode: "MISSING_EVIDENCE", blocking: true },
        {
          role: "assessment",
          reasonCode: "FUTURE_INFORMATION",
          blocking: false,
        },
      ] as const
    ).map((finding) => ({
      ...base,
      qualityGate: finding.blocking ? ("BLOCK" as const) : ("OK" as const),
      findings: [finding],
      dispositions: [],
      appliedPenalties: [],
      evidenceConfidence: value(parseDecimal("100")),
    })),
    {
      ...base,
      qualityGate: "BLOCK",
      findings: [
        {
          role: "assessment",
          reasonCode: "FUTURE_INFORMATION",
          blocking: true,
        },
      ],
      dispositions: [
        { role: "assessment", disposition: "accepted", contentHash: hash },
      ],
      appliedPenalties: [],
      evidenceConfidence: value(parseDecimal("100")),
    },
  ];
  for (const input of variants) {
    assert.equal(
      createDataQualityAssessment(input).ok,
      false,
      JSON.stringify(input),
    );
    assert.equal(
      rehydrateDataQualityAssessment(signed({ ...input })).ok,
      false,
    );
  }
});
test("reducer assessments roundtrip and persisted admissions cannot grant producer trust", () => {
  const market = marketFixture();
  const external = externalEvidenceFixture("market-regime-score", market);
  const analytics = analyticsFixture(market, {
    profile: {
      schemaVersion: "analytics-profile/v1",
      features: [],
      externalEvidence: [{ family: external.family, required: true }],
    },
    externalEvidence: { [external.family]: external },
  });
  const profile = value(
    createQualityProfile({
      schemaVersion: "quality-profile/v1",
      profileVersion: "artifact-test-v1",
      roles: [
        { id: `external:${external.family}`, required: true, maxAgeMs: 60_000 },
      ],
      metadataSkewMs: 1_000,
      trust: [
        {
          issuer: "fixture-issuer",
          family: external.family,
          producer: external.provenance.producer,
          schemaVersion: external.schemaVersion,
          modelVersion: external.modelVersion,
        },
      ],
      penalties: [],
    }),
  );
  const input = {
    profile,
    sources: [{ role: "analytics" as const, value: analytics }],
    bundleCutoff: market.bundleCutoff,
    evaluationTime: market.bundleCutoff,
  };
  const accepted = value(
    assessDataQuality({
      ...input,
      externalAdmissions: [
        issueQualityAdmission("fixture-issuer", external.contentHash),
      ],
    }),
  );
  assert.equal(accepted.qualityGate, "OK");
  const restored = value(
    rehydrateArtifact(
      "data-quality-assessment",
      value(encodeCanonicalArtifact("data-quality-assessment", accepted)),
    ),
  );
  assert.deepEqual(restored, accepted);
  const admission = restored.dispositions.find(
    (row) => row.admission,
  )?.admission;
  assert.ok(admission);
  const replayed = value(
    assessDataQuality({ ...input, externalAdmissions: [admission] }),
  );
  assert.equal(replayed.qualityGate, "BLOCK");
  assert.ok(
    replayed.findings.some(
      (finding) =>
        finding.reasonCode === "UNTRUSTED_EVIDENCE" && finding.blocking,
    ),
  );
  assert.deepEqual(
    value(
      rehydrateArtifact(
        "data-quality-assessment",
        value(encodeCanonicalArtifact("data-quality-assessment", replayed)),
      ),
    ),
    replayed,
  );
});
