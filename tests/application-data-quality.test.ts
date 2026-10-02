import assert from "node:assert/strict";
import test from "node:test";
import { createDataQualityBoundary } from "../src/application/data-quality-assessment.js";
import { assessDataQuality } from "../src/domain/quality/assess-data-quality.js";
import { createQualityProfile } from "../src/domain/quality/quality-profile.js";
import {
  encodeCanonicalArtifact,
  rehydrateArtifact,
} from "../src/domain/identity/canonical-artifact.js";
import {
  marketFixture,
  analyticsFixture,
  externalEvidenceFixture,
} from "./fixtures/data-quality-fixtures.js";

function fixture(required = true) {
  const market = marketFixture();
  const external = externalEvidenceFixture("market-regime-score", market);
  const analytics = analyticsFixture(market, {
    profile: {
      schemaVersion: "analytics-profile/v1",
      features: [],
      externalEvidence: [{ family: "market-regime-score", required }],
    },
    externalEvidence: { "market-regime-score": external },
  });
  return {
    market,
    external,
    analytics,
    profile: {
      schemaVersion: "quality-profile/v1",
      profileVersion: "m1-v1",
      metadataSkewMs: 1000,
      roles: [
        { id: "external:market-regime-score", required, maxAgeMs: 60_000 },
      ],
      trust: [
        {
          issuer: "controlled-ingestion",
          family: "market-regime-score",
          producer: external.provenance.producer,
          schemaVersion: external.schemaVersion,
          modelVersion: external.modelVersion,
        },
      ],
      penalties: [
        {
          reasonCode: "UNTRUSTED_EVIDENCE",
          confidenceImpactGroup: "regime",
          penalty: "8",
        },
      ],
    },
  };
}
test("external claims and admission-shaped JSON do not grant trust", () => {
  const f = fixture();
  const boundary = createDataQualityBoundary({
    qualityProfile: f.profile,
    issuer: "controlled-ingestion",
  });
  assert.ok(boundary.ok);
  const result = boundary.value.assess({
    sources: [{ role: "analytics", value: f.analytics }],
    bundleCutoff: f.market.bundleCutoff,
    evaluationTime: f.market.bundleCutoff,
  });
  assert.ok(result.ok);
  assert.equal(result.value.qualityGate, "BLOCK");
  assert.ok(
    result.value.findings.some((v) => v.reasonCode === "UNTRUSTED_EVIDENCE"),
  );
});
test("controlled ingestion binds exact external artifact and fixed profile", () => {
  const f = fixture();
  const boundary = createDataQualityBoundary({
    qualityProfile: f.profile,
    issuer: "controlled-ingestion",
    ingestExternal: () => f.external,
  });
  assert.ok(boundary.ok);
  const input = {
    sources: [{ role: "analytics" as const, value: f.analytics }],
    bundleCutoff: f.market.bundleCutoff,
    evaluationTime: f.market.bundleCutoff,
  };
  const result = boundary.value.assess(input);
  assert.ok(result.ok);
  assert.equal(result.value.qualityGate, "OK");
  assert.equal(
    result.value.dispositions.find((d) => d.role.startsWith("external:"))
      ?.admission?.issuer,
    "controlled-ingestion",
  );
  f.profile.profileVersion = "changed-after-selection";
  assert.deepEqual(boundary.value.assess(input), result);
});
test("optional unadmitted evidence is rejected with confidence penalty, not block", () => {
  const f = fixture(false);
  const boundary = createDataQualityBoundary({
    qualityProfile: f.profile,
    issuer: "controlled-ingestion",
  });
  assert.ok(boundary.ok);
  const result = boundary.value.assess({
    sources: [{ role: "analytics", value: f.analytics }],
    bundleCutoff: f.market.bundleCutoff,
    evaluationTime: f.market.bundleCutoff,
  });
  assert.ok(result.ok);
  assert.equal(result.value.qualityGate, "OK");
  assert.equal(result.value.evidenceConfidence?.toString(), "92");
  assert.equal(
    result.value.dispositions.find((d) => d.role.startsWith("external:"))
      ?.disposition,
    "rejected",
  );
});

test("copied admission data cannot become fresh authority in the pure evaluator", () => {
  const f = fixture();
  const profile = createQualityProfile(f.profile);
  assert.ok(profile.ok);
  const result = assessDataQuality({
    profile: profile.value,
    sources: [{ role: "analytics", value: f.analytics }],
    bundleCutoff: f.market.bundleCutoff,
    evaluationTime: f.market.bundleCutoff,
    externalAdmissions: [
      { issuer: "controlled-ingestion", artifactHash: f.external.contentHash },
    ],
  });
  assert.ok(result.ok);
  assert.equal(result.value.qualityGate, "BLOCK");
});

test("controlled ingestion of a different valid artifact cannot admit the supplied one", () => {
  const f = fixture();
  const other = externalEvidenceFixture("market-regime-score", f.market, {
    validForMs: 30_000,
  });
  const boundary = createDataQualityBoundary({
    qualityProfile: f.profile,
    issuer: "controlled-ingestion",
    ingestExternal: () => other,
  });
  assert.ok(boundary.ok);
  const result = boundary.value.assess({
    sources: [{ role: "analytics", value: f.analytics }],
    bundleCutoff: f.market.bundleCutoff,
    evaluationTime: f.market.bundleCutoff,
  });
  assert.ok(result.ok);
  assert.equal(result.value.qualityGate, "BLOCK");
});

test("required admitted evidence at maxAgeMs produces a canonical BLOCK artifact", () => {
  const f = fixture();
  const boundary = createDataQualityBoundary({
    qualityProfile: f.profile,
    issuer: "controlled-ingestion",
    ingestExternal: () => f.external,
  });
  assert.ok(boundary.ok);
  const input = {
    sources: [{ role: "analytics" as const, value: f.analytics }],
    bundleCutoff: f.market.bundleCutoff,
    evaluationTime: new Date(
      Date.parse(f.market.bundleCutoff) + 59_999,
    ).toISOString(),
  };
  const fresh = boundary.value.assess(input);
  assert.ok(fresh.ok);
  assert.equal(fresh.value.qualityGate, "OK");
  assert.equal(
    fresh.value.dispositions.find(
      (d) => d.role === "external:market-regime-score",
    )?.admission?.artifactHash,
    f.external.contentHash,
  );
  const result = boundary.value.assess({
    ...input,
    evaluationTime: new Date(
      Date.parse(f.market.bundleCutoff) + 60_000,
    ).toISOString(),
  });
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.value.qualityGate, "BLOCK");
  assert.deepEqual(result.value.findings, [
    {
      role: "external:market-regime-score",
      reasonCode: "STALE_EVIDENCE",
      blocking: true,
    },
  ]);
  assert.deepEqual(
    result.value.dispositions.find(
      (d) => d.role === "external:market-regime-score",
    ),
    {
      role: "external:market-regime-score",
      disposition: "rejected",
      contentHash: f.external.contentHash,
    },
  );
  const canonical = encodeCanonicalArtifact(
    "data-quality-assessment",
    result.value,
  );
  assert.ok(canonical.ok);
  const restored = rehydrateArtifact(
    "data-quality-assessment",
    canonical.value,
  );
  assert.ok(restored.ok);
  assert.deepEqual(restored.value, result.value);
  assert.deepEqual(
    encodeCanonicalArtifact("data-quality-assessment", restored.value),
    canonical,
  );
});

for (const required of [true, false]) {
  for (const field of [
    "issuer",
    "family",
    "producer",
    "schemaVersion",
    "modelVersion",
  ] as const) {
    test(`controlled admission with ${field} policy mismatch: required=${required}`, () => {
      const f = fixture(required);
      f.profile.trust[0]![field] += "-mismatch";
      let calls = 0;
      const boundary = createDataQualityBoundary({
        qualityProfile: f.profile,
        issuer: "controlled-ingestion",
        ingestExternal: (family) => {
          assert.equal(family, f.external.family);
          calls++;
          return f.external;
        },
      });
      assert.ok(boundary.ok);
      const result = boundary.value.assess({
        sources: [{ role: "analytics", value: f.analytics }],
        bundleCutoff: f.market.bundleCutoff,
        evaluationTime: f.market.bundleCutoff,
      });
      assert.equal(calls, 1);
      assert.ok(result.ok);
      assert.equal(result.value.qualityGate, required ? "BLOCK" : "OK");
      assert.equal(
        result.value.evidenceConfidence?.toString(),
        required ? "100" : "92",
      );
      assert.deepEqual(result.value.findings, [
        {
          role: "external:market-regime-score",
          reasonCode: "UNTRUSTED_EVIDENCE",
          blocking: required,
          ...(!required ? { confidenceImpactGroup: "regime" } : {}),
        },
      ]);
      assert.deepEqual(
        result.value.dispositions.find(
          (d) => d.role === "external:market-regime-score",
        ),
        {
          role: "external:market-regime-score",
          disposition: "rejected",
          contentHash: f.external.contentHash,
        },
      );
    });
  }
  for (const failure of ["throwing", "malformed"] as const) {
    test(`${failure} controlled ingestion: required=${required}`, () => {
      const f = fixture(required);
      let calls = 0;
      const boundary = createDataQualityBoundary({
        qualityProfile: f.profile,
        issuer: "controlled-ingestion",
        ingestExternal: () => {
          calls++;
          if (failure === "throwing") throw new Error("ingestion failed");
          return { ...f.external, contentHash: "invalid" };
        },
      });
      assert.ok(boundary.ok);
      const result = boundary.value.assess({
        sources: [{ role: "analytics", value: f.analytics }],
        bundleCutoff: f.market.bundleCutoff,
        evaluationTime: f.market.bundleCutoff,
      });
      assert.equal(calls, 1);
      assert.ok(result.ok);
      assert.equal(result.value.qualityGate, required ? "BLOCK" : "OK");
      assert.equal(
        result.value.evidenceConfidence?.toString(),
        required ? "100" : "92",
      );
      assert.deepEqual(result.value.findings, [
        {
          role: "external:market-regime-score",
          reasonCode: "UNTRUSTED_EVIDENCE",
          blocking: required,
          ...(!required ? { confidenceImpactGroup: "regime" } : {}),
        },
      ]);
      assert.deepEqual(
        result.value.dispositions.find(
          (d) => d.role === "external:market-regime-score",
        ),
        {
          role: "external:market-regime-score",
          disposition: "rejected",
          contentHash: f.external.contentHash,
        },
      );
    });
  }
}
