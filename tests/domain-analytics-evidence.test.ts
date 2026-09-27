import assert from "node:assert/strict";
import test from "node:test";

import {
  createAnalyticsEvidenceBundle,
  rehydrateAnalyticsEvidenceBundle,
} from "../src/domain/analytics/analytics-evidence-bundle.js";
import {
  decodeCanonicalArtifact,
  encodeCanonicalArtifact,
  rehydrateArtifact,
} from "../src/domain/identity/canonical-artifact.js";
import { ANALYTICS_EVIDENCE_SCHEMA_VERSION as PUBLIC_ANALYTICS_EVIDENCE_SCHEMA_VERSION } from "../src/domain/index.js";
import {
  EXTERNAL_EVIDENCE_MODEL_VERSIONS,
  EXTERNAL_EVIDENCE_SCHEMA_VERSIONS,
  hashExternalInputManifest,
} from "../src/domain/analytics/external-regime-evidence.js";
import {
  LIQUIDATION_EVIDENCE_ASSETS,
  LIQUIDATION_EVIDENCE_POLICY_VERSION,
  LIQUIDATION_EVIDENCE_SCHEMA_VERSION,
  createLiquidationEvidenceBundle,
} from "../src/domain/liquidation/liquidation-evidence-bundle.js";
import { deriveLiquidationWindows } from "../src/domain/liquidation/liquidation-evidence-windows.js";
import {
  MARKET_EVIDENCE_SCHEMA_VERSION,
  MARKET_EVIDENCE_SYMBOLS,
  MARKET_EVIDENCE_UNIVERSE_VERSION,
  createMarketEvidenceBundle,
  marketEvidenceContentHash,
} from "../src/domain/market/market-evidence-bundle.js";
import { hashCanonical } from "../src/domain/identity/canonical-serialization.js";
import { DecimalValue } from "../src/domain/shared/decimal.js";
import { parseUtcTimestamp } from "../src/domain/shared/time.js";

const CUTOFF = "2026-09-24T14:00:00.000Z";

function decimal(value: string) {
  const result = DecimalValue.fromString(value);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("decimal fixture is invalid");
  return result.value;
}

function canonicalHash(value: unknown): string {
  const result = hashCanonical(value);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("canonical fixture hash is invalid");
  return result.value;
}

function marketBundle(runId = "analytics-run-1") {
  const result = createMarketEvidenceBundle({
    runId,
    schemaVersion: MARKET_EVIDENCE_SCHEMA_VERSION,
    producer: "fixture/market-evidence",
    universeVersion: MARKET_EVIDENCE_UNIVERSE_VERSION,
    universe: [...MARKET_EVIDENCE_SYMBOLS],
    collectionStartedAt: "2026-09-24T13:00:00.000Z",
    collectionEndedAt: "2026-09-24T13:01:00.000Z",
    bundleCutoff: CUTOFF,
    source: {
      exchange: "bybit",
      environment: "mainnet",
      origin: "https://api.bybit.com",
      category: "linear",
    },
    status: "incomplete",
    symbols: MARKET_EVIDENCE_SYMBOLS.map((symbol) => ({
      symbol,
      ohlcv:
        symbol === "BTCUSDT"
          ? [
              {
                interval: "1h" as const,
                observations: [
                  {
                    timestamp: "2026-09-24T12:00:00.000Z",
                    open: decimal("100"),
                    high: decimal("101"),
                    low: decimal("99"),
                    close: decimal("100"),
                    volume: decimal("1"),
                    turnover: decimal("100"),
                    closed: true,
                  },
                  {
                    timestamp: "2026-09-24T13:00:00.000Z",
                    open: decimal("100"),
                    high: decimal("103"),
                    low: decimal("99"),
                    close: decimal("102"),
                    volume: decimal("2"),
                    turnover: decimal("204"),
                    closed: true,
                  },
                ],
              },
            ]
          : [],
      instrument:
        symbol === "BTCUSDT"
          ? {
              symbol,
              status: "trading" as const,
              contractType: "LinearPerpetual" as const,
              baseCoin: "BTC",
              quoteCoin: "USDT" as const,
              settleCoin: "USDT" as const,
              constraints: {
                instrument: symbol,
                version: "instrument-constraints/v1",
                priceTickSize: "0.01",
                quantityStep: "1",
                minQuantity: "1",
                minNotional: "5",
              },
              fundingInterval: 60,
              sourceTimestamp: "2026-09-24T13:00:00.000Z",
            }
          : undefined,
      funding:
        symbol === "BTCUSDT"
          ? [
              {
                timestamp: "2026-09-24T12:00:00.000Z",
                rate: decimal("0.001"),
              },
              {
                timestamp: "2026-09-24T13:00:00.000Z",
                rate: decimal("0.002"),
              },
            ]
          : [],
      openInterest:
        symbol === "BTCUSDT"
          ? [
              {
                interval: "1h" as const,
                observations: [
                  {
                    timestamp: "2026-09-24T12:00:00.000Z",
                    openInterest: decimal("100"),
                  },
                  {
                    timestamp: "2026-09-24T13:00:00.000Z",
                    openInterest: decimal("120"),
                  },
                ],
              },
            ]
          : [],
      diagnostics: [],
    })),
    diagnostics: [],
    evidence: [
      {
        kind: "market-snapshot",
        schemaVersion: "market-snapshot/v1",
        producer: "fixture/market-evidence",
        sourceId: runId,
        asOf: "2026-09-24T13:00:00.000Z",
        validForMs: 60_000,
        contentHash: `sha256:${"a".repeat(64)}`,
      },
    ],
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("market fixture is invalid");
  return result.value;
}

function liquidationBundle(
  market: ReturnType<typeof marketBundle>,
  runId = market.runId,
) {
  const marketHash = marketEvidenceContentHash(market);
  assert.equal(marketHash.ok, true);
  if (!marketHash.ok) throw new Error("market bundle hash is invalid");
  const cutoff = parseUtcTimestamp(CUTOFF);
  assert.equal(cutoff.ok, true);
  if (!cutoff.ok) throw new Error("cutoff fixture is invalid");
  const windows = deriveLiquidationWindows([], cutoff.value);
  const result = createLiquidationEvidenceBundle({
    runId,
    schemaVersion: LIQUIDATION_EVIDENCE_SCHEMA_VERSION,
    producer: "fixture/liquidation-evidence",
    policyVersion: LIQUIDATION_EVIDENCE_POLICY_VERSION,
    provider: "coinalyze",
    collectionStartedAt: "2026-09-24T13:00:00.000Z",
    collectionEndedAt: "2026-09-24T13:01:00.000Z",
    bundleCutoff: CUTOFF,
    marketEvidence: {
      runId,
      universeVersion: market.universeVersion,
      bundleCutoff: CUTOFF,
      contentHash: marketHash.value,
    },
    coverageProof: "complete",
    historyProof: "incomplete",
    status: "failed",
    targets: LIQUIDATION_EVIDENCE_ASSETS.map((asset) => ({
      asset,
      constituents: [],
      hourlyAggregates: windows.hourlyAggregates,
      windows: windows.windows,
    })),
    diagnostics: [
      { code: "provider-unavailable", operation: "fetch-liquidation-history" },
    ],
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("liquidation fixture is invalid");
  return result.value;
}

function profile(
  features: readonly Record<string, unknown>[],
  externalEvidence: readonly Record<string, unknown>[] = [],
) {
  return {
    schemaVersion: "analytics-profile/v1",
    features,
    externalEvidence,
  };
}

function closeReturnProfile() {
  return profile([
    {
      id: "btc-hourly-return",
      kind: "close-return",
      symbol: "BTCUSDT",
      interval: "1h",
      periods: 1,
      required: true,
    },
  ]);
}

function macroEvidence(contentHash = `sha256:${"b".repeat(64)}`) {
  const refs = [
    {
      kind: "research-artifact",
      schemaVersion: "macro-input/v1",
      producer: "fixture/macro-provider",
      sourceId: "macro-2026-09-24",
      contentHash,
    },
  ];
  const manifest = hashExternalInputManifest(refs);
  assert.equal(manifest.ok, true);
  if (!manifest.ok) throw new Error("external manifest fixture is invalid");
  const payload = {
    family: "market-regime-score",
    schemaVersion: EXTERNAL_EVIDENCE_SCHEMA_VERSIONS["market-regime-score"],
    modelVersion: EXTERNAL_EVIDENCE_MODEL_VERSIONS["market-regime-score"],
    direction: "higher-is-healthier",
    score: decimal("61"),
    confidence: decimal("72"),
    provenance: {
      producer: "fixture/regime-model",
      sourceId: "regime-run-1",
      modelName: "fixture-model",
    },
    inputManifestHash: manifest.value,
    inputEvidenceRefs: refs,
    asOf: "2026-09-24T13:00:00.000Z",
    generatedAt: "2026-09-24T14:05:00.000Z",
    validForMs: 60_000,
  };
  return { ...payload, contentHash: canonicalHash(payload) };
}

function trapEvidence() {
  const refs = [
    {
      kind: "research-artifact",
      schemaVersion: "trap-input/v1",
      producer: "fixture/trap-provider",
      sourceId: "trap-run-1",
      contentHash: `sha256:${"d".repeat(64)}`,
    },
  ];
  const manifest = hashExternalInputManifest(refs);
  assert.equal(manifest.ok, true);
  if (!manifest.ok) throw new Error("trap manifest fixture is invalid");
  const subscores = JSON.parse('{"__proto__":"50"}') as Record<string, unknown>;
  Object.defineProperty(subscores, "__proto__", {
    value: decimal("50"),
    enumerable: true,
    configurable: true,
    writable: true,
  });
  const payload = {
    family: "trap",
    schemaVersion: EXTERNAL_EVIDENCE_SCHEMA_VERSIONS.trap,
    modelVersion: EXTERNAL_EVIDENCE_MODEL_VERSIONS.trap,
    trapType: "liquidity-sweep",
    reasons: ["rapid liquidation expansion"],
    subscores,
    scenarioProbabilities: {
      continuation: decimal("0.4"),
      reversal: decimal("0.3"),
      squeeze: decimal("0.2"),
      range: decimal("0.1"),
    },
    horizon: "4h",
    confirmationSignals: ["follow-through"],
    invalidationSignals: ["range reclaim"],
    confidence: decimal("70"),
    provenance: {
      producer: "fixture/trap-model",
      sourceId: "trap-run-1",
      modelName: "fixture-model",
    },
    inputManifestHash: manifest.value,
    inputEvidenceRefs: refs,
    asOf: "2026-09-24T13:00:00.000Z",
    generatedAt: "2026-09-24T14:05:00.000Z",
    validForMs: 60_000,
  };
  return { ...payload, contentHash: canonicalHash(payload) };
}

test("analytics evidence is deterministic, immutable, and bound to full source identities", () => {
  const market = marketBundle();
  const liquidation = liquidationBundle(market);
  const input = { market, liquidation, profile: closeReturnProfile() };
  const first = createAnalyticsEvidenceBundle(input);
  const second = createAnalyticsEvidenceBundle(input);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;

  assert.equal(first.value.sufficiency.status, "complete");
  assert.equal(first.value.profileHash.length > 0, true);
  assert.equal(first.value.inputIdentity.marketBundleHash.length > 0, true);
  assert.equal(first.value.inputIdentity.liquidationBundleHash?.length, 71);
  assert.equal(first.value.contentHash, second.value.contentHash);
  assert.equal(first.value.priceFeatures[0]?.status, "complete");
  assert.equal(Object.isFrozen(first.value), true);
  assert.equal(Object.isFrozen(first.value.priceFeatures), true);

  const rehydrated = rehydrateAnalyticsEvidenceBundle(first.value);
  assert.equal(rehydrated.ok, true);
  if (rehydrated.ok)
    assert.equal(rehydrated.value.contentHash, first.value.contentHash);
});

test("derivative cadence windows survive domain and artifact rehydration", () => {
  const derivativeProfile = profile([
    {
      id: "btc-funding-change",
      kind: "funding-change",
      symbol: "BTCUSDT",
      observationCount: 2,
      required: true,
    },
    {
      id: "btc-open-interest-change",
      kind: "open-interest-absolute-change",
      symbol: "BTCUSDT",
      interval: "1h",
      observationCount: 2,
      required: true,
    },
  ]);
  const created = createAnalyticsEvidenceBundle({
    market: marketBundle(),
    profile: derivativeProfile,
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.deepEqual(
    created.value.derivativeFeatures.map((feature) => feature.status),
    ["complete", "complete"],
  );
  assert.equal(rehydrateAnalyticsEvidenceBundle(created.value).ok, true);
  const encoded = encodeCanonicalArtifact(
    "analytics-evidence-bundle",
    created.value,
  );
  assert.equal(encoded.ok, true);
  if (!encoded.ok) return;
  assert.equal(
    rehydrateArtifact("analytics-evidence-bundle", encoded.value).ok,
    true,
  );
});

test("full liquidation content and accepted external lineage change analytics identity", () => {
  const market = marketBundle();
  const base = liquidationBundle(market);
  const laterRead = createLiquidationEvidenceBundle({
    ...base,
    collectionEndedAt: "2026-09-24T13:02:00.000Z",
  });
  assert.equal(laterRead.ok, true);
  if (!laterRead.ok) return;

  const profileWithExternal = profile(
    closeReturnProfile().features as Record<string, unknown>[],
    [{ family: "market-regime-score", required: false }],
  );
  const external = macroEvidence();
  const first = createAnalyticsEvidenceBundle({
    market,
    liquidation: base,
    profile: profileWithExternal,
    externalEvidence: { "market-regime-score": external },
  });
  const changedSource = createAnalyticsEvidenceBundle({
    market,
    liquidation: laterRead.value,
    profile: profileWithExternal,
    externalEvidence: { "market-regime-score": external },
  });
  const changedGeneratedAtPayload: Record<string, unknown> = {
    ...external,
    generatedAt: "2026-09-24T14:06:00.000Z",
  };
  delete changedGeneratedAtPayload.contentHash;
  const changedExternal = {
    ...changedGeneratedAtPayload,
    contentHash: canonicalHash(changedGeneratedAtPayload),
  };
  const changedManifest = createAnalyticsEvidenceBundle({
    market,
    liquidation: base,
    profile: profileWithExternal,
    externalEvidence: {
      "market-regime-score": macroEvidence(`sha256:${"c".repeat(64)}`),
    },
  });
  const changedTime = createAnalyticsEvidenceBundle({
    market,
    liquidation: base,
    profile: profileWithExternal,
    externalEvidence: { "market-regime-score": changedExternal },
  });
  assert.equal(first.ok, true);
  assert.equal(changedSource.ok, true);
  assert.equal(changedManifest.ok, true);
  assert.equal(changedTime.ok, true);
  if (!first.ok || !changedSource.ok || !changedManifest.ok || !changedTime.ok)
    return;
  assert.notEqual(
    first.value.inputIdentity.liquidationBundleHash,
    changedSource.value.inputIdentity.liquidationBundleHash,
  );
  assert.notEqual(first.value.contentHash, changedSource.value.contentHash);
  assert.equal(
    first.value.externalEvidence[0]?.generatedAt,
    "2026-09-24T14:05:00.000Z",
  );
  assert.notEqual(first.value.contentHash, changedManifest.value.contentHash);
  assert.notEqual(first.value.contentHash, changedTime.value.contentHash);
});

test("mismatched market and liquidation lineage preserves local features but claims no joined result", () => {
  const market = marketBundle();
  const mismatched = liquidationBundle(market, "different-run");
  const combinedProfile = profile([
    ...(closeReturnProfile().features as Record<string, unknown>[]),
    {
      id: "btc-liquidation-1h",
      kind: "liquidation-window",
      asset: "BTC",
      windowHours: 1,
      required: true,
    },
  ]);
  const result = createAnalyticsEvidenceBundle({
    market,
    liquidation: mismatched,
    profile: combinedProfile,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.priceFeatures[0]?.status, "complete");
  assert.equal(result.value.derivativeFeatures[0]?.status, "unavailable");
  assert.deepEqual(result.value.sufficiency.reasonCodes, [
    "INPUT_IDENTITY_MISMATCH",
  ]);
  assert.equal(result.value.sufficiency.status, "insufficient");
});

test("external evidence is family scoped and failed validation stays as a reason outcome", () => {
  const market = marketBundle();
  const requested = profile(
    closeReturnProfile().features as Record<string, unknown>[],
    [{ family: "market-regime-score", required: true }],
  );
  const invalidExternal = { ...macroEvidence(), direction: "higher-is-risk" };
  const result = createAnalyticsEvidenceBundle({
    market,
    profile: requested,
    externalEvidence: { "market-regime-score": invalidExternal },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.externalEvidence.length, 0);
  assert.deepEqual(result.value.externalOutcomes[0]?.reasonCodes, [
    "SCORE_DIRECTION_MISMATCH",
  ]);
  assert.equal(result.value.sufficiency.status, "partial");
  assert.equal(
    result.value.sufficiency.reasonCodes.includes("SCORE_DIRECTION_MISMATCH"),
    true,
  );

  const unrequested = createAnalyticsEvidenceBundle({
    market,
    profile: closeReturnProfile(),
    externalEvidence: { "liquidity-stress": macroEvidence() },
  });
  assert.equal(unrequested.ok, false);
});

test("Trap subscores safely preserve a proto-named key", () => {
  const requested = profile(
    closeReturnProfile().features as Record<string, unknown>[],
    [{ family: "trap", required: true }],
  );
  const result = createAnalyticsEvidenceBundle({
    market: marketBundle(),
    profile: requested,
    externalEvidence: { trap: trapEvidence() },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const trap = result.value.externalEvidence[0];
  assert.ok(trap !== undefined && trap.family === "trap");
  if (trap === undefined || trap.family !== "trap") return;
  assert.ok(trap.subscores !== undefined);
  if (trap.subscores === undefined) return;
  assert.equal(Object.getPrototypeOf(trap.subscores), null);
  assert.equal(Object.hasOwn(trap.subscores, "__proto__"), true);
  assert.equal(trap.subscores?.["__proto__"]?.toString(), "50");
});

test("rehydration rejects changed content hashes and unsupported bundle versions", () => {
  const created = createAnalyticsEvidenceBundle({
    market: marketBundle(),
    profile: closeReturnProfile(),
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const changed = rehydrateAnalyticsEvidenceBundle({
    ...created.value,
    contentHash: `sha256:${"0".repeat(64)}`,
  });
  assert.equal(changed.ok, false);
  const unsupported = rehydrateAnalyticsEvidenceBundle({
    ...created.value,
    schemaVersion: "analytics-evidence/v2",
  });
  assert.equal(unsupported.ok, false);
});

test("rehydration rejects unknown external evidence families without throwing", () => {
  const created = createAnalyticsEvidenceBundle({
    market: marketBundle(),
    profile: closeReturnProfile(),
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.doesNotThrow(() =>
    rehydrateAnalyticsEvidenceBundle({
      ...created.value,
      externalEvidence: [{ ...macroEvidence(), family: "unknown-family" }],
    }),
  );
  assert.equal(
    rehydrateAnalyticsEvidenceBundle({
      ...created.value,
      externalEvidence: [{ ...macroEvidence(), family: "unknown-family" }],
    }).ok,
    false,
  );
});

test("artifact/v1 registers analytics evidence and round-trips its stable identity", () => {
  assert.equal(
    PUBLIC_ANALYTICS_EVIDENCE_SCHEMA_VERSION,
    "analytics-evidence/v1",
  );
  const created = createAnalyticsEvidenceBundle({
    market: marketBundle(),
    profile: closeReturnProfile(),
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const encoded = encodeCanonicalArtifact(
    "analytics-evidence-bundle",
    created.value,
  );
  assert.equal(encoded.ok, true);
  if (!encoded.ok) return;
  assert.equal(encoded.value.schemaVersion, "artifact/v1");
  assert.equal(encoded.value.artifactKind, "analytics-evidence-bundle");

  const decoded = decodeCanonicalArtifact(
    encoded.value,
    "analytics-evidence-bundle",
  );
  assert.equal(decoded.ok, true);
  const rehydrated = rehydrateArtifact(
    "analytics-evidence-bundle",
    encoded.value,
  );
  assert.equal(rehydrated.ok, true);
  if (rehydrated.ok) {
    assert.equal(rehydrated.value.contentHash, created.value.contentHash);
    assert.equal(rehydrated.value.sufficiency.status, "complete");
  }

  const tampered = decodeCanonicalArtifact(
    {
      ...encoded.value,
      canonicalJson: encoded.value.canonicalJson.replace(
        created.value.contentHash,
        `sha256:${"0".repeat(64)}`,
      ),
    },
    "analytics-evidence-bundle",
  );
  assert.equal(tampered.ok, false);

  const futureDomainSchema = encodeCanonicalArtifact(
    "analytics-evidence-bundle",
    { ...created.value, schemaVersion: "analytics-evidence/v2" },
  );
  assert.equal(futureDomainSchema.ok, true);
  if (futureDomainSchema.ok) {
    assert.equal(
      rehydrateArtifact("analytics-evidence-bundle", futureDomainSchema.value)
        .ok,
      false,
    );
  }
});
