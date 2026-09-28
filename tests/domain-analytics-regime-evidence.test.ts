import assert from "node:assert/strict";
import test from "node:test";

import { hashCanonical } from "../src/domain/identity/canonical-serialization.js";
import {
  EXTERNAL_EVIDENCE_MODEL_VERSIONS,
  EXTERNAL_EVIDENCE_SCHEMA_VERSIONS,
  hashExternalInputManifest,
  migrateHistoricalCewsEvidence,
  normalizeExternalInputEvidenceRefs,
  validateExternalRegimeEvidence,
  type ExternalEvidenceFamily,
  type ExternalInputEvidenceRef,
} from "../src/domain/analytics/external-regime-evidence.js";
import type { AnalyticsInputIdentity } from "../src/domain/analytics/analytics-inputs.js";
import { DecimalValue } from "../src/domain/shared/decimal.js";
import type { UtcTimestamp } from "../src/domain/shared/time.js";

const CUTOFF = "2026-09-24T12:30:00.000Z" as UtcTimestamp;
const MARKET_HASH = `sha256:${"a".repeat(64)}`;
const LIQUIDATION_HASH = `sha256:${"b".repeat(64)}`;

function decimal(value: string) {
  const result = DecimalValue.fromString(value);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("decimal fixture is invalid");
  return result.value;
}

function hash(value: unknown): string {
  const result = hashCanonical(value);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("canonical hash fixture is invalid");
  return result.value;
}

const macroRef: ExternalInputEvidenceRef = {
  kind: "research-artifact",
  schemaVersion: "macro-input/v1",
  producer: "fixture/macro-provider",
  sourceId: "macro-2026-09-24",
  contentHash: `sha256:${"c".repeat(64)}`,
};

const breadthRef: ExternalInputEvidenceRef = {
  kind: "research-artifact",
  schemaVersion: "breadth-input/v1",
  producer: "fixture/breadth-provider",
  sourceId: "breadth-2026-09-24",
  contentHash: `sha256:${"e".repeat(64)}`,
};

const marketRef: ExternalInputEvidenceRef = {
  kind: "market-evidence-bundle",
  schemaVersion: "market-evidence/v1",
  producer: "crypto-analyst-trader/bybit-public",
  sourceId: "analytics-run-1",
  contentHash: MARKET_HASH,
  runContext: {
    runId: "analytics-run-1",
    universeVersion: "m1-universe/v1",
    bundleCutoff: CUTOFF,
  },
};

const liquidationRef: ExternalInputEvidenceRef = {
  kind: "liquidation-evidence-bundle",
  schemaVersion: "liquidation-evidence/v1",
  producer: "crypto-analyst-trader/coinalyze-liquidation",
  sourceId: "analytics-run-1",
  contentHash: LIQUIDATION_HASH,
  runContext: {
    runId: "analytics-run-1",
    universeVersion: "m1-universe/v1",
    bundleCutoff: CUTOFF,
  },
};

function identity(includeLiquidation = false): AnalyticsInputIdentity {
  return {
    runId: "analytics-run-1",
    universeVersion: "m1-universe/v1",
    bundleCutoff: CUTOFF as AnalyticsInputIdentity["bundleCutoff"],
    marketContentHash: `sha256:${"d".repeat(64)}`,
    marketBundleHash: MARKET_HASH,
    ...(includeLiquidation
      ? {
          liquidationRunId: "analytics-run-1",
          liquidationUniverseVersion: "m1-universe/v1",
          liquidationBundleCutoff:
            CUTOFF as AnalyticsInputIdentity["bundleCutoff"],
          liquidationMarketContentHash: `sha256:${"d".repeat(64)}`,
          liquidationBundleHash: LIQUIDATION_HASH,
        }
      : {}),
    compatibility: "compatible",
    reasonCodes: [],
  };
}

function manifestHash(refs: readonly ExternalInputEvidenceRef[]): string {
  const result = hashExternalInputManifest(refs);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("input manifest fixture is invalid");
  return result.value;
}

function externalScore(
  family: Exclude<ExternalEvidenceFamily, "trap">,
  overrides: Record<string, unknown> = {},
) {
  const inputEvidenceRefs = [macroRef];
  return {
    family,
    schemaVersion: EXTERNAL_EVIDENCE_SCHEMA_VERSIONS[family],
    modelVersion: EXTERNAL_EVIDENCE_MODEL_VERSIONS[family],
    direction:
      family === "market-regime-score"
        ? "higher-is-healthier"
        : family === "early-warning-risk"
          ? "higher-is-warning"
          : "higher-is-stress",
    score: decimal("0"),
    confidence: decimal("100"),
    provenance: {
      producer: "fixture/market-model",
      sourceId: "model-run-2026-09-24",
      modelName: "fixture-model",
    },
    inputManifestHash: manifestHash(inputEvidenceRefs),
    inputEvidenceRefs,
    asOf: "2026-09-24T12:30:00.000Z",
    validForMs: 1,
    ...overrides,
  };
}

function trapEvidence(overrides: Record<string, unknown> = {}) {
  const inputEvidenceRefs = [macroRef];
  return {
    family: "trap",
    schemaVersion: EXTERNAL_EVIDENCE_SCHEMA_VERSIONS.trap,
    modelVersion: EXTERNAL_EVIDENCE_MODEL_VERSIONS.trap,
    trapType: "distribution-trap",
    reasons: ["price rejected the breakout", "spot confirmation weakened"],
    scenarioLikelihoods: {
      continuation: decimal("0.1"),
      reversal: decimal("0.3"),
      squeeze: decimal("0.2"),
      range: decimal("0.1"),
    },
    horizon: "24h",
    confirmationSignals: ["failed reclaim"],
    invalidationSignals: ["daily close above resistance"],
    confidence: decimal("0"),
    provenance: {
      producer: "fixture/trap-model",
      sourceId: "trap-run-2026-09-24",
      modelName: "fixture-trap-model",
    },
    inputManifestHash: manifestHash(inputEvidenceRefs),
    inputEvidenceRefs,
    asOf: "2026-09-24T12:30:00.000Z",
    validForMs: 60_000,
    ...overrides,
  };
}

function withContentHash<T extends Record<string, unknown>>(payload: T) {
  const normalized: Record<string, unknown> = { ...payload };
  if (Array.isArray(payload.inputEvidenceRefs)) {
    const references = normalizeExternalInputEvidenceRefs(
      payload.inputEvidenceRefs,
    );
    assert.equal(references.ok, true);
    if (!references.ok) throw new Error("input references are invalid");
    normalized.inputEvidenceRefs = references.value;
  }
  return { ...normalized, contentHash: hash(normalized) };
}

test("score families enforce inclusive score/confidence bounds and directions", () => {
  const families = [
    "market-regime-score",
    "early-warning-risk",
    "liquidity-stress",
  ] as const;
  for (const family of families) {
    const valid = withContentHash(externalScore(family));
    const result = validateExternalRegimeEvidence(valid, family, identity());
    assert.equal(result.status, "complete");
    assert.deepEqual(result.reasonCodes, []);
    if (result.evidence?.family === family) {
      assert.equal(result.evidence.score.toString(), "0");
      assert.equal(result.evidence.confidence.toString(), "100");
    }

    const otherBoundary = withContentHash(
      externalScore(family, {
        score: decimal("100"),
        confidence: decimal("0"),
      }),
    );
    assert.equal(
      validateExternalRegimeEvidence(otherBoundary, family, identity()).status,
      "complete",
    );

    const outOfRange = withContentHash(
      externalScore(family, { score: decimal("100.1") }),
    );
    const rejected = validateExternalRegimeEvidence(
      outOfRange,
      family,
      identity(),
    );
    assert.equal(rejected.status, "unavailable");
    assert.deepEqual(rejected.reasonCodes, ["INVALID_EXTERNAL_SCORE"]);

    const invalidConfidence = withContentHash(
      externalScore(family, { confidence: decimal("100.1") }),
    );
    assert.deepEqual(
      validateExternalRegimeEvidence(invalidConfidence, family, identity())
        .reasonCodes,
      ["INVALID_EXTERNAL_SCORE"],
    );
  }
});

test("wrong score direction and unsupported schema/model versions fail closed", () => {
  const wrongDirection = withContentHash(
    externalScore("market-regime-score", { direction: "higher-is-risk" }),
  );
  assert.deepEqual(
    validateExternalRegimeEvidence(
      wrongDirection,
      "market-regime-score",
      identity(),
    ).reasonCodes,
    ["SCORE_DIRECTION_MISMATCH"],
  );

  const unknownVersion = withContentHash(
    externalScore("liquidity-stress", { modelVersion: "lsi-v2-unregistered" }),
  );
  assert.deepEqual(
    validateExternalRegimeEvidence(
      unknownVersion,
      "liquidity-stress",
      identity(),
    ).reasonCodes,
    ["INCOMPATIBLE_SCORE_VERSION"],
  );

  const unknownSchema = withContentHash(
    externalScore("market-regime-score", { schemaVersion: "market-score/v2" }),
  );
  assert.deepEqual(
    validateExternalRegimeEvidence(
      unknownSchema,
      "market-regime-score",
      identity(),
    ).reasonCodes,
    ["INCOMPATIBLE_SCORE_VERSION"],
  );
});

test("ambiguous or unversioned CEWS is rejected without inferred semantics", () => {
  for (const cews of [
    { family: "cews", score: "68" },
    {
      ...externalScore("early-warning-risk"),
      family: "cews",
      direction: undefined,
      modelVersion: undefined,
    },
  ]) {
    const result = validateExternalRegimeEvidence(
      cews,
      "early-warning-risk",
      identity(),
    );
    assert.equal(result.status, "unavailable");
    assert.deepEqual(result.reasonCodes, ["AMBIGUOUS_CEWS_DIRECTION"]);
  }
});

test("input manifests canonicalize order and exact duplicates", () => {
  const refs = [macroRef, breadthRef, macroRef] as const;
  assert.equal(manifestHash(refs), manifestHash([breadthRef, macroRef]));

  const evidence = withContentHash(
    externalScore("market-regime-score", {
      inputEvidenceRefs: refs,
      inputManifestHash: manifestHash(refs),
    }),
  );
  const result = validateExternalRegimeEvidence(
    evidence,
    "market-regime-score",
    identity(),
  );
  assert.equal(result.status, "complete");
  assert.equal(result.evidence?.inputEvidenceRefs.length, 2);
});

test("declared #11/#45 inputs require exact full hash and run context", () => {
  const refs = [marketRef, liquidationRef];
  const valid = withContentHash(
    externalScore("early-warning-risk", {
      inputEvidenceRefs: refs,
      inputManifestHash: manifestHash(refs),
      marketEvidenceHash: MARKET_HASH,
      liquidationEvidenceHash: LIQUIDATION_HASH,
    }),
  );
  assert.equal(
    validateExternalRegimeEvidence(valid, "early-warning-risk", identity(true))
      .status,
    "complete",
  );

  const missingClaim = withContentHash(
    externalScore("early-warning-risk", {
      inputEvidenceRefs: [marketRef],
      inputManifestHash: manifestHash([marketRef]),
    }),
  );
  assert.deepEqual(
    validateExternalRegimeEvidence(
      missingClaim,
      "early-warning-risk",
      identity(),
    ).reasonCodes,
    ["INPUT_IDENTITY_MISMATCH"],
  );

  const wrongRunRef = {
    ...marketRef,
    sourceId: "different-run",
    runContext: {
      runId: "different-run",
      universeVersion: "m1-universe/v1",
      bundleCutoff: CUTOFF,
    },
  };
  const wrongRunRefs = [wrongRunRef];
  const wrongRun = withContentHash(
    externalScore("early-warning-risk", {
      inputEvidenceRefs: wrongRunRefs,
      inputManifestHash: manifestHash(wrongRunRefs),
      marketEvidenceHash: MARKET_HASH,
    }),
  );
  assert.deepEqual(
    validateExternalRegimeEvidence(wrongRun, "early-warning-risk", identity())
      .reasonCodes,
    ["INPUT_IDENTITY_MISMATCH"],
  );

  const inventedClaim = withContentHash(
    externalScore("early-warning-risk", {
      marketEvidenceHash: MARKET_HASH,
    }),
  );
  assert.deepEqual(
    validateExternalRegimeEvidence(
      inventedClaim,
      "early-warning-risk",
      identity(),
    ).reasonCodes,
    ["INPUT_IDENTITY_MISMATCH"],
  );
});

test("macro-only evidence is accepted without inferred project-bundle lineage", () => {
  const refs = [macroRef];
  const evidence = withContentHash(
    externalScore("market-regime-score", {
      inputEvidenceRefs: refs,
      inputManifestHash: manifestHash(refs),
    }),
  );
  const result = validateExternalRegimeEvidence(
    evidence,
    "market-regime-score",
    {
      ...identity(true),
      compatibility: "incompatible",
      reasonCodes: ["INPUT_IDENTITY_MISMATCH"],
    },
  );
  assert.equal(result.status, "complete");
  assert.equal(result.evidence?.marketEvidenceHash, undefined);
  assert.equal(result.evidence?.liquidationEvidenceHash, undefined);
});

test("asOf gates information time and generatedAt cannot predate it", () => {
  const lateGenerated = withContentHash(
    externalScore("market-regime-score", {
      generatedAt: "2026-09-24T12:45:00.000Z",
      validForMs: 1,
    }),
  );
  const accepted = validateExternalRegimeEvidence(
    lateGenerated,
    "market-regime-score",
    identity(),
  );
  assert.equal(accepted.status, "complete");
  if (accepted.evidence?.family === "market-regime-score") {
    assert.equal(accepted.evidence.generatedAt, "2026-09-24T12:45:00.000Z");
    assert.equal(accepted.evidence.validForMs, 1);
  }

  const futureAsOf = withContentHash(
    externalScore("market-regime-score", {
      asOf: "2026-09-24T12:30:01.000Z",
    }),
  );
  assert.deepEqual(
    validateExternalRegimeEvidence(
      futureAsOf,
      "market-regime-score",
      identity(),
    ).reasonCodes,
    ["EXTERNAL_EVIDENCE_AFTER_CUTOFF"],
  );

  const generatedBeforeAsOf = withContentHash(
    externalScore("market-regime-score", {
      generatedAt: "2026-09-24T12:29:59.999Z",
    }),
  );
  const invalidChronology = validateExternalRegimeEvidence(
    generatedBeforeAsOf,
    "market-regime-score",
    identity(),
  );
  assert.equal(invalidChronology.status, "unavailable");
  assert.deepEqual(invalidChronology.reasonCodes, ["INVALID_EXTERNAL_SCORE"]);
});

test("Trap requires explainable evidence and independent bounded scenario likelihoods", () => {
  const evidence = withContentHash(trapEvidence());
  const result = validateExternalRegimeEvidence(evidence, "trap", identity());
  assert.equal(result.status, "complete");
  assert.deepEqual(result.reasonCodes, []);
  if (result.evidence?.family === "trap") {
    assert.deepEqual(Object.keys(result.evidence.scenarioLikelihoods).sort(), [
      "continuation",
      "range",
      "reversal",
      "squeeze",
    ]);
    const likelihoodTotal = Object.values(
      result.evidence.scenarioLikelihoods,
    ).reduce((sum, item) => sum.add(item), decimal("0"));
    assert.equal(likelihoodTotal.toString(), "0.7");
  }
  assert.equal(
    validateExternalRegimeEvidence(
      withContentHash(trapEvidence({ confidence: decimal("100") })),
      "trap",
      identity(),
    ).status,
    "complete",
  );

  const invalidCases = [
    trapEvidence({ scenarioLikelihoods: { continuation: decimal("0.1") } }),
    trapEvidence({ scenarioLikelihoods: { continuation: decimal("1.1") } }),
    trapEvidence({ reasons: [], subscores: {} }),
    trapEvidence({ confirmationSignals: [] }),
    trapEvidence({ invalidationSignals: [] }),
    trapEvidence({ horizon: "" }),
    trapEvidence({ confidence: decimal("100.1") }),
  ];
  for (const invalid of invalidCases) {
    const rejected = validateExternalRegimeEvidence(
      withContentHash(invalid),
      "trap",
      identity(),
    );
    assert.equal(rejected.status, "unavailable");
    assert.deepEqual(rejected.reasonCodes, ["INVALID_TRAP_EVIDENCE"]);
  }
});

test("payload and input-manifest hash tampering are rejected independently", () => {
  const changedPayload = withContentHash(externalScore("market-regime-score"));
  const tampered = { ...changedPayload, score: decimal("25") };
  assert.deepEqual(
    validateExternalRegimeEvidence(tampered, "market-regime-score", identity())
      .reasonCodes,
    ["EXTERNAL_EVIDENCE_HASH_MISMATCH"],
  );

  const wrongManifest = withContentHash(
    externalScore("market-regime-score", {
      inputManifestHash: `sha256:${"e".repeat(64)}`,
    }),
  );
  assert.deepEqual(
    validateExternalRegimeEvidence(
      wrongManifest,
      "market-regime-score",
      identity(),
    ).reasonCodes,
    ["EXTERNAL_EVIDENCE_HASH_MISMATCH"],
  );
});

test("only the explicitly versioned historical CEWS fixture migrates", () => {
  const refs = [macroRef];
  const source = withContentHash({
    family: "cews",
    schemaVersion: "cews/v1",
    modelVersion: "cews/2026-06-07-warning-0-100",
    direction: "higher-is-warning",
    score: decimal("73"),
    confidence: decimal("65"),
    provenance: {
      producer: "fixture/historical-cews",
      sourceId: "cews-2026-06-07",
      modelName: "historical-cews",
    },
    inputManifestHash: manifestHash(refs),
    inputEvidenceRefs: refs,
    asOf: "2026-06-07T12:00:00.000Z",
    validForMs: 60_000,
  });
  const migrated = migrateHistoricalCewsEvidence(source, identity());
  assert.equal(migrated.status, "complete");
  if (migrated.evidence?.family === "early-warning-risk") {
    assert.equal(migrated.evidence.score.toString(), "73");
    assert.equal(
      migrated.evidence.provenance.migration?.sourceModelVersion,
      "cews/2026-06-07-warning-0-100",
    );
    assert.equal(migrated.evidence.provenance.sourceId, "cews-2026-06-07");
  }

  const unsupported = {
    ...source,
    modelVersion: "cews/2026-03-16-flipped-0-30",
  };
  assert.deepEqual(
    migrateHistoricalCewsEvidence(unsupported, identity()).reasonCodes,
    ["AMBIGUOUS_CEWS_DIRECTION"],
  );
});
