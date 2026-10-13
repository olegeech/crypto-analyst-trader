import assert from "node:assert/strict";
import test from "node:test";

import {
  createLiquidationEvidenceBundle,
  createLiquidationEvidenceBundleV2,
  createLiquidationEvidenceRef,
  LIQUIDATION_EVIDENCE_ASSETS,
  LIQUIDATION_EVIDENCE_SCHEMA_VERSION,
  LIQUIDATION_EVIDENCE_POLICY_VERSION,
  LIQUIDATION_EVIDENCE_V2_PROVIDER_SEMANTIC_IDENTITY,
  LIQUIDATION_EVIDENCE_V2_SCHEMA_VERSION,
  createLiquidationEvidenceBundleV3,
  LIQUIDATION_EVIDENCE_V3_SCHEMA_VERSION,
  LIQUIDATION_HISTORY_BUCKETS,
  type LiquidationEvidenceBundleInput,
  type LiquidationEvidenceBundleV2Input,
  type LiquidationObservationProvenance,
  type LiquidationObservationV2Input,
  type LiquidationTargetV2Input,
} from "../src/domain/liquidation/liquidation-evidence-bundle.js";
import {
  encodeCanonicalArtifact,
  rehydrateArtifact,
} from "../src/domain/identity/canonical-artifact.js";
import { createEvidenceRef } from "../src/domain/evidence/evidence-ref.js";
import { DecimalValue } from "../src/domain/shared/decimal.js";
import { selectDecisionLiquidationMarkets } from "../src/application/liquidation-market-selection.js";
import type { LiquidationCatalogueMarket } from "../src/domain/liquidation/liquidation-evidence-v3.js";
import {
  LIQUIDATION_EVIDENCE_V1_GOLDEN_HASH,
  liquidationEvidenceV1GoldenInput,
} from "./fixtures/liquidation-evidence-v1-golden.js";
import {
  LIQUIDATION_EVIDENCE_V2_GOLDEN_HASH,
  liquidationEvidenceV2GoldenInput,
} from "./fixtures/liquidation-evidence-v2-golden.js";

const HOUR_MS = 60 * 60 * 1_000;
const CUTOFF = "2026-09-24T12:30:00.000Z";
const LAST_CLOSED_START = Date.parse("2026-09-24T11:00:00.000Z");
const MARKET_HASH = `sha256:${"a".repeat(64)}`;

function bucketTime(index: number): string {
  return new Date(LAST_CLOSED_START - (23 - index) * HOUR_MS).toISOString();
}

function history(options: { missingIndex?: number; firstZero?: boolean } = {}) {
  return Array.from({ length: 24 }, (_, index) => {
    if (index === options.missingIndex) return undefined;
    return {
      timestamp: bucketTime(index),
      longUsd: options.firstZero && index === 0 ? "0" : String(index + 1),
      shortUsd:
        options.firstZero && index === 0 ? "0" : String((index + 1) * 2),
    };
  }).filter((item) => item !== undefined);
}

function market(
  asset: (typeof LIQUIDATION_EVIDENCE_ASSETS)[number],
  exchange: string,
  options: { missingIndex?: number; firstZero?: boolean } = {},
) {
  return {
    providerSymbol: `${asset}USDT_PERP.${exchange.toUpperCase()}`,
    exchange,
    symbolOnExchange: `${asset}USDT`,
    baseAsset: asset,
    quoteAsset: "USDT",
    isPerpetual: true as const,
    marginType: "STABLE",
    expireAt: 0,
    notionalDenominatedIn: "USD",
    observations: history(options),
  };
}

function targets(
  options: {
    missingAsset?: (typeof LIQUIDATION_EVIDENCE_ASSETS)[number];
    firstZero?: boolean;
    perAssetCount?: number;
  } = {},
) {
  return LIQUIDATION_EVIDENCE_ASSETS.map((asset) => ({
    asset,
    constituents: Array.from({ length: options.perAssetCount ?? 1 }, (_, i) =>
      market(asset, `venue-${i + 1}`, {
        ...(options.missingAsset === asset ? { missingIndex: 8 } : {}),
        ...(options.firstZero ? { firstZero: true } : {}),
      }),
    ),
  }));
}

function input(
  overrides: Partial<LiquidationEvidenceBundleInput> = {},
): LiquidationEvidenceBundleInput {
  return {
    runId: "run-45-1",
    schemaVersion: LIQUIDATION_EVIDENCE_SCHEMA_VERSION,
    producer: "crypto-analyst-trader/coinalyze-liquidation",
    policyVersion: LIQUIDATION_EVIDENCE_POLICY_VERSION,
    provider: "coinalyze",
    collectionStartedAt: "2026-09-24T12:00:00.000Z",
    collectionEndedAt: "2026-09-24T12:01:00.000Z",
    bundleCutoff: CUTOFF,
    marketEvidence: {
      runId: "run-45-1",
      universeVersion: "m1-universe/v1",
      bundleCutoff: CUTOFF,
      contentHash: MARKET_HASH,
    },
    coverageProof: "complete",
    historyProof: "complete",
    status: "complete",
    targets: targets(),
    diagnostics: [],
    ...overrides,
  };
}

function inputV2(
  overrides: Partial<LiquidationEvidenceBundleV2Input> = {},
  perAssetCount = 1,
): LiquidationEvidenceBundleV2Input {
  const legacy = input({ targets: targets({ perAssetCount }) });
  return {
    ...legacy,
    schemaVersion: LIQUIDATION_EVIDENCE_V2_SCHEMA_VERSION,
    providerSemanticIdentity:
      LIQUIDATION_EVIDENCE_V2_PROVIDER_SEMANTIC_IDENTITY,
    targets: legacy.targets.map((target) => ({
      ...target,
      constituents: target.constituents.map((constituent) => ({
        ...constituent,
        observations: constituent.observations.map((observation) => ({
          ...observation,
          provenance: "provider-explicit" as const,
        })),
      })),
    })),
    ...overrides,
  };
}

function inputV3(overrides: Record<string, unknown> = {}) {
  const selectedCatalogueMarket = {
    symbol: "BTCUSDT_PERP.BYBIT",
    exchange: "bybit",
    symbolOnExchange: "BTCUSDT",
    baseAsset: "BTC",
    quoteAsset: "USDT",
    isPerpetual: true,
    marginType: "STABLE",
    expireAt: 0,
    notionalDenominatedIn: "USD",
  };
  const selected = selectDecisionLiquidationMarkets({
    asset: "BTC",
    markets: [selectedCatalogueMarket],
    catalogueComplete: true,
    cutoffMs: Date.parse(CUTOFF),
  });
  assert.equal(selected.ok, true);
  if (!selected.ok) throw new Error("invalid v3 selection fixture");
  const selectedMarket = market("BTC", "bybit");
  const selectedSet = [
    {
      providerSymbol: selectedMarket.providerSymbol,
      exchange: selectedMarket.exchange,
      symbolOnExchange: selectedMarket.symbolOnExchange,
      baseAsset: selectedMarket.baseAsset,
      quoteAsset: selectedMarket.quoteAsset,
      isPerpetual: selectedMarket.isPerpetual,
      marginType: selectedMarket.marginType,
      expireAt: selectedMarket.expireAt,
      notionalDenominatedIn: selectedMarket.notionalDenominatedIn,
      observations: history().map((observation) => ({
        ...observation,
        provenance: "provider-explicit" as const,
      })),
    },
  ];
  return {
    runId: "run-45-1",
    schemaVersion: LIQUIDATION_EVIDENCE_V3_SCHEMA_VERSION,
    providerSemanticIdentity: "coinalyze-sparse-zero/v1",
    producer: "crypto-analyst-trader/coinalyze-liquidation",
    provider: "coinalyze",
    policyVersion: "liquidation-market-aggregate/v2",
    collectionStartedAt: "2026-09-24T12:00:00.000Z",
    collectionEndedAt: "2026-09-24T12:01:00.000Z",
    bundleCutoff: CUTOFF,
    marketEvidence: {
      runId: "run-45-1",
      universeVersion: "m1-universe/v1",
      bundleCutoff: CUTOFF,
      contentHash: MARKET_HASH,
    },
    selection: {
      coveragePolicyVersion: selected.value.coveragePolicyVersion,
      selectedAsset: selected.value.selectedAsset,
      cutoff: selected.value.cutoff,
      catalogueComplete: selected.value.catalogueComplete,
      catalogueMarkets: selected.value.catalogueMarkets,
      catalogueHash: selected.value.catalogueHash,
      exclusions: selected.value.exclusions,
      selectedSetHash: selected.value.selectedSetHash,
      reasonCodes: selected.value.reasonCodes,
    },
    coverageProof: selected.value.coverageProof,
    historyProof: "complete",
    status: "complete",
    targets: [{ asset: "BTC", constituents: selectedSet }],
    diagnostics: [],
    ...overrides,
  };
}

function withFirstV2Observation(
  targets: readonly LiquidationTargetV2Input[],
  overrides: Partial<LiquidationObservationV2Input>,
): readonly LiquidationTargetV2Input[] {
  return targets.map((target, targetIndex) =>
    targetIndex !== 0
      ? target
      : {
          ...target,
          constituents: target.constituents.map((constituent, index) =>
            index !== 0
              ? constituent
              : {
                  ...constituent,
                  observations: constituent.observations.map(
                    (observation, observationIndex) =>
                      observationIndex === 0
                        ? { ...observation, ...overrides }
                        : observation,
                  ),
                },
          ),
        },
  );
}

test("complete liquidation evidence validates exact aligned facts and derived windows", () => {
  const result = createLiquidationEvidenceBundle(input());
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.value.status, "complete");
  assert.equal(result.value.targets.length, 4);
  const bitcoin = result.value.targets[0];
  assert.equal(bitcoin?.asset, "BTC");
  assert.equal(bitcoin?.constituents[0]?.observations.length, 24);
  assert.equal(bitcoin?.hourlyAggregates.length, 24);
  assert.equal(bitcoin?.hourlyAggregates[0]?.longUsd.toString(), "1");
  assert.equal(bitcoin?.hourlyAggregates[0]?.shortUsd.toString(), "2");
  assert.equal(bitcoin?.hourlyAggregates[0]?.totalUsd.toString(), "3");
  assert.equal(bitcoin?.hourlyAggregates[0]?.complete, true);
  assert.deepEqual(
    bitcoin?.windows.map((window) => window.hours),
    [1, 4, 12, 24],
  );
  assert.equal(bitcoin?.windows[3]?.longUsd.toString(), "300");
  assert.equal(bitcoin?.windows[3]?.shortUsd.toString(), "600");
  assert.equal(bitcoin?.windows[3]?.complete, true);
  assert.equal(Object.isFrozen(result.value), true);
  assert.equal(Object.isFrozen(result.value.marketEvidence), true);
  assert.equal(Object.isFrozen(result.value.targets), true);
  assert.equal(Object.isFrozen(bitcoin), true);
  assert.equal(Object.isFrozen(bitcoin?.constituents), true);
  assert.equal(Object.isFrozen(bitcoin?.constituents[0]), true);
  assert.equal(Object.isFrozen(bitcoin?.constituents[0]?.observations), true);
  assert.equal(
    Object.isFrozen(bitcoin?.constituents[0]?.observations[0]),
    true,
  );
  assert.equal(Object.isFrozen(bitcoin?.hourlyAggregates), true);
  assert.equal(Object.isFrozen(bitcoin?.hourlyAggregates[0]), true);
  assert.equal(Object.isFrozen(bitcoin?.windows), true);
  assert.equal(Object.isFrozen(bitcoin?.windows[0]), true);
  assert.equal(Object.isFrozen(result.value.diagnostics), true);
});

test("incomplete coverage preserves all trustworthy discovered constituents", () => {
  const allTargets = targets({ perAssetCount: 5 });
  const partial = createLiquidationEvidenceBundle(
    input({
      coverageProof: "incomplete",
      status: "incomplete",
      targets: allTargets.map((target) => ({
        ...target,
        constituents: target.constituents.slice(
          0,
          target.asset === "BTC" ? 2 : 5,
        ),
      })),
      diagnostics: [
        { code: "catalogue-incomplete", operation: "discover-markets" },
      ],
    }),
  );

  assert.equal(partial.ok, true);
  if (!partial.ok) return;
  assert.equal(partial.value.status, "incomplete");
  assert.equal(partial.value.coverageProof, "incomplete");
  assert.equal(
    partial.value.targets.reduce(
      (count, target) => count + target.constituents.length,
      0,
    ),
    17,
  );
  assert.equal(partial.value.targets[0]?.constituents.length, 2);
});

test("complete catalogue with a selected market missing history remains selected and incomplete", () => {
  const incomplete = createLiquidationEvidenceBundle(
    input({
      historyProof: "incomplete",
      status: "incomplete",
      targets: targets({ missingAsset: "BTC" }),
      diagnostics: [
        {
          code: "missing-bucket",
          operation: "fetch-liquidation-history",
          asset: "BTC",
          providerSymbol: "BTCUSDT_PERP.VENUE-1",
          bucketTimestamp: bucketTime(8),
        },
      ],
    }),
  );

  assert.equal(incomplete.ok, true);
  if (!incomplete.ok) return;
  assert.equal(incomplete.value.coverageProof, "complete");
  assert.equal(incomplete.value.historyProof, "incomplete");
  assert.equal(incomplete.value.targets[0]?.constituents.length, 1);
  assert.equal(
    incomplete.value.targets[0]?.constituents[0]?.observations.length,
    23,
  );
  assert.equal(incomplete.value.targets[0]?.windows[3]?.complete, false);
  assert.equal(
    incomplete.value.targets[0]?.windows[3]?.observedConstituentBuckets,
    23,
  );
});

test("explicit zero remains zero and an omitted hour remains missing", () => {
  const evidence = createLiquidationEvidenceBundle(
    input({
      historyProof: "incomplete",
      status: "incomplete",
      targets: targets({ firstZero: true, missingAsset: "ETH" }),
      diagnostics: [
        {
          code: "missing-bucket",
          operation: "fetch-liquidation-history",
          asset: "ETH",
          providerSymbol: "ETHUSDT_PERP.VENUE-1",
          bucketTimestamp: bucketTime(8),
        },
      ],
    }),
  );

  assert.equal(evidence.ok, true);
  if (!evidence.ok) return;
  assert.equal(
    evidence.value.targets[0]?.hourlyAggregates[0]?.longUsd.toString(),
    "0",
  );
  assert.equal(
    evidence.value.targets[0]?.hourlyAggregates[0]?.shortUsd.toString(),
    "0",
  );
  assert.equal(
    evidence.value.targets[1]?.hourlyAggregates.some(
      (aggregate) => aggregate.timestamp === bucketTime(8),
    ),
    false,
  );
  assert.equal(evidence.value.targets[1]?.windows[3]?.complete, false);
});

test("failed collection contains no untrusted market facts and requires a diagnostic", () => {
  const failed = createLiquidationEvidenceBundle(
    input({
      coverageProof: "incomplete",
      historyProof: "incomplete",
      status: "failed",
      targets: LIQUIDATION_EVIDENCE_ASSETS.map((asset) => ({
        asset,
        constituents: [],
      })),
      diagnostics: [
        { code: "catalogue-unavailable", operation: "discover-markets" },
      ],
    }),
  );
  assert.equal(failed.ok, true);
  if (!failed.ok) return;
  assert.equal(failed.value.status, "failed");
  assert.equal(
    failed.value.targets.every((target) => target.constituents.length === 0),
    true,
  );

  const noReason = createLiquidationEvidenceBundle(
    input({
      coverageProof: "incomplete",
      historyProof: "incomplete",
      status: "failed",
      targets: LIQUIDATION_EVIDENCE_ASSETS.map((asset) => ({
        asset,
        constituents: [],
      })),
      diagnostics: [],
    }),
  );
  assert.equal(noReason.ok, false);
});

test("a full catalogue with no eligible target market can fail with coverage still proven", () => {
  const failed = createLiquidationEvidenceBundle(
    input({
      coverageProof: "complete",
      historyProof: "incomplete",
      status: "failed",
      targets: LIQUIDATION_EVIDENCE_ASSETS.map((asset) => ({
        asset,
        constituents: [],
      })),
      diagnostics: [
        { code: "no-eligible-markets", operation: "discover-markets" },
      ],
    }),
  );

  assert.equal(failed.ok, true);
  if (failed.ok) {
    assert.equal(failed.value.coverageProof, "complete");
    assert.equal(failed.value.historyProof, "incomplete");
    assert.equal(failed.value.status, "failed");
  }
});

test("v3 rejects discovery-failure diagnostics alongside complete catalogue proofs", () => {
  const complete = createLiquidationEvidenceBundleV3(inputV3());
  assert.equal(complete.ok, true);
  if (!complete.ok) return;
  const constituent = complete.value.targets[0]?.constituents[0];
  assert.ok(constituent);
  if (constituent === undefined) return;

  const contradictory = {
    ...complete.value,
    status: "incomplete" as const,
    diagnostics: [
      {
        code: "catalogue-incomplete" as const,
        operation: "discover-markets" as const,
      },
    ],
    targets: [
      {
        asset: "BTC" as const,
        constituents: [
          {
            ...constituent,
            observations: constituent.observations.map((observation, index) =>
              index === 0
                ? {
                    ...observation,
                    longUsd: "0",
                    shortUsd: "0",
                    provenance: "provider-implied-zero" as const,
                  }
                : observation,
            ),
          },
        ],
      },
    ],
  };

  assert.equal(createLiquidationEvidenceBundleV3(contradictory).ok, false);
  assert.equal(
    encodeCanonicalArtifact("liquidation-evidence-bundle", contradictory).ok,
    false,
  );
});

test("v3 rejects unknown fields in supplied derived rows", () => {
  const valid = createLiquidationEvidenceBundleV3(inputV3());
  assert.equal(valid.ok, true);
  if (!valid.ok) return;
  const target = valid.value.targets[0];
  assert.ok(target);
  if (target === undefined) return;

  const aggregateWithUnknown = {
    ...valid.value,
    targets: [
      {
        ...target,
        hourlyAggregates: target.hourlyAggregates.map((row, index) =>
          index === 0 ? { ...row, unexpectedProof: true } : row,
        ),
      },
    ],
  };
  const windowWithUnknown = {
    ...valid.value,
    targets: [
      {
        ...target,
        windows: target.windows.map((row, index) =>
          index === 0 ? { ...row, unexpectedProof: true } : row,
        ),
      },
    ],
  };

  for (const malformed of [aggregateWithUnknown, windowWithUnknown]) {
    assert.equal(createLiquidationEvidenceBundleV3(malformed).ok, false);
    assert.equal(
      encodeCanonicalArtifact("liquidation-evidence-bundle", malformed).ok,
      false,
    );
  }
});

test("bundle rejects post-cutoff observations, duplicate market identities and fabricated zero fill", () => {
  const afterCutoff = targets();
  const firstMarket = afterCutoff[0]?.constituents[0];
  assert.ok(firstMarket);
  firstMarket.observations.push({
    timestamp: CUTOFF,
    longUsd: "0",
    shortUsd: "0",
  });
  const futureResult = createLiquidationEvidenceBundle(
    input({
      targets: afterCutoff,
      historyProof: "incomplete",
      status: "incomplete",
    }),
  );
  assert.equal(futureResult.ok, false);

  const duplicateTargets = targets();
  const duplicate = duplicateTargets[1]?.constituents[0];
  const bitcoin = duplicateTargets[0]?.constituents[0];
  assert.ok(duplicate);
  assert.ok(bitcoin);
  duplicate.providerSymbol = bitcoin.providerSymbol;
  const duplicateResult = createLiquidationEvidenceBundle(
    input({ targets: duplicateTargets }),
  );
  assert.equal(duplicateResult.ok, false);

  const conflictingContract = targets();
  const firstBitcoin = conflictingContract[0]?.constituents[0];
  assert.ok(firstBitcoin);
  conflictingContract[0]?.constituents.push({
    ...firstBitcoin,
    providerSymbol: "BTCUSDT_PERP.BINANCE_ALT",
    marginType: "COIN",
    expireAt: 1_800_000_000,
  });
  const conflictingResult = createLiquidationEvidenceBundle(
    input({ targets: conflictingContract }),
  );
  assert.equal(conflictingResult.ok, false);

  const missingObservation = targets();
  const marketWithGap = missingObservation[0]?.constituents[0];
  assert.ok(marketWithGap);
  marketWithGap.observations = history({ missingIndex: 10 });
  const fabricatedComplete = createLiquidationEvidenceBundle(
    input({ targets: missingObservation }),
  );
  assert.equal(fabricatedComplete.ok, false);
});

test("canonical artifact hash is deterministic and rehydrates liquidation evidence", () => {
  const first = createLiquidationEvidenceBundle(
    input({ targets: targets({ perAssetCount: 2 }) }),
  );
  const reorderedTargets = [...targets({ perAssetCount: 2 })]
    .reverse()
    .map((target) => ({
      ...target,
      constituents: [...target.constituents].reverse(),
    }));
  const reordered = createLiquidationEvidenceBundle(
    input({ targets: reorderedTargets }),
  );
  assert.equal(first.ok, true);
  assert.equal(reordered.ok, true);
  if (!first.ok || !reordered.ok) return;

  const envelope = encodeCanonicalArtifact(
    "liquidation-evidence-bundle",
    first.value,
  );
  const reorderedEnvelope = encodeCanonicalArtifact(
    "liquidation-evidence-bundle",
    reordered.value,
  );
  assert.equal(envelope.ok, true);
  assert.equal(reorderedEnvelope.ok, true);
  if (!envelope.ok || !reorderedEnvelope.ok) return;
  assert.equal(
    envelope.value.canonicalHash,
    reorderedEnvelope.value.canonicalHash,
  );

  const ref = createEvidenceRef({
    kind: "liquidation-evidence-bundle",
    schemaVersion: first.value.schemaVersion,
    producer: first.value.producer,
    sourceId: first.value.runId,
    asOf: first.value.bundleCutoff,
    validForMs: 60_000,
    contentHash: envelope.value.canonicalHash,
  });
  assert.equal(ref.ok, true);

  const rehydrated = rehydrateArtifact(
    "liquidation-evidence-bundle",
    envelope.value,
  );
  assert.equal(rehydrated.ok, true);
  if (rehydrated.ok) {
    assert.equal(rehydrated.value.status, "complete");
    assert.equal(
      rehydrated.value.targets[0]?.windows[3]?.totalUsd.toString(),
      "1800",
    );
  }

  const forgedValue = DecimalValue.fromString("999");
  assert.equal(forgedValue.ok, true);
  if (!forgedValue.ok) return;
  const corruptedBundle = {
    ...first.value,
    targets: first.value.targets.map((target, index) =>
      index === 0
        ? {
            ...target,
            hourlyAggregates: target.hourlyAggregates.map(
              (aggregate, bucketIndex) =>
                bucketIndex === 0
                  ? { ...aggregate, longUsd: forgedValue.value }
                  : aggregate,
            ),
          }
        : target,
    ),
  };
  const corruptedEnvelope = encodeCanonicalArtifact(
    "liquidation-evidence-bundle",
    corruptedBundle,
  );
  assert.equal(corruptedEnvelope.ok, true);
  if (!corruptedEnvelope.ok) return;
  assert.equal(
    rehydrateArtifact("liquidation-evidence-bundle", corruptedEnvelope.value)
      .ok,
    false,
  );

  const corruptedWindows = {
    ...first.value,
    targets: first.value.targets.map((target, index) =>
      index === 0
        ? {
            ...target,
            windows: target.windows.map((window, windowIndex) =>
              windowIndex === 0 ? { ...window, longUsd: "999" } : window,
            ),
          }
        : target,
    ),
  };
  const corruptedWindowsEnvelope = encodeCanonicalArtifact(
    "liquidation-evidence-bundle",
    corruptedWindows,
  );
  assert.equal(corruptedWindowsEnvelope.ok, true);
  if (!corruptedWindowsEnvelope.ok) return;
  assert.equal(
    rehydrateArtifact(
      "liquidation-evidence-bundle",
      corruptedWindowsEnvelope.value,
    ).ok,
    false,
  );
});

test("persisted v1 golden artifact keeps its canonical hash and meaning", () => {
  const bundle = createLiquidationEvidenceBundle(
    liquidationEvidenceV1GoldenInput(),
  );
  assert.equal(bundle.ok, true);
  if (!bundle.ok) return;

  const envelope = encodeCanonicalArtifact(
    "liquidation-evidence-bundle",
    bundle.value,
  );
  assert.equal(envelope.ok, true);
  if (!envelope.ok) return;
  assert.equal(envelope.value.schemaVersion, "artifact/v1");
  assert.equal(
    envelope.value.canonicalHash,
    LIQUIDATION_EVIDENCE_V1_GOLDEN_HASH,
  );

  const rehydrated = rehydrateArtifact(
    "liquidation-evidence-bundle",
    envelope.value,
  );
  assert.equal(rehydrated.ok, true);
  if (!rehydrated.ok) return;
  assert.equal(rehydrated.value.schemaVersion, "liquidation-evidence/v1");
  assert.equal(rehydrated.value.status, "complete");
  assert.equal(
    rehydrated.value.targets[0]?.constituents[0]?.observations[0]?.longUsd.toString(),
    "1",
  );
  const firstObservation =
    rehydrated.value.targets[0]?.constituents[0]?.observations[0];
  assert.ok(firstObservation);
  assert.equal("provenance" in firstObservation, false);
});

test("persisted v2 golden artifact keeps its canonical hash and meaning", () => {
  const bundle = createLiquidationEvidenceBundleV2(
    liquidationEvidenceV2GoldenInput(),
  );
  assert.equal(bundle.ok, true);
  if (!bundle.ok) return;
  const envelope = encodeCanonicalArtifact(
    "liquidation-evidence-bundle",
    bundle.value,
  );
  assert.equal(envelope.ok, true);
  if (!envelope.ok) return;
  assert.equal(
    envelope.value.canonicalHash,
    LIQUIDATION_EVIDENCE_V2_GOLDEN_HASH,
  );
  const rehydrated = rehydrateArtifact(
    "liquidation-evidence-bundle",
    envelope.value,
  );
  assert.equal(rehydrated.ok, true);
  if (!rehydrated.ok) return;
  assert.equal(
    rehydrated.value.schemaVersion,
    LIQUIDATION_EVIDENCE_V2_SCHEMA_VERSION,
  );
  const reencoded = encodeCanonicalArtifact(
    "liquidation-evidence-bundle",
    rehydrated.value,
  );
  assert.equal(reencoded.ok, true);
  if (!reencoded.ok) return;
  assert.equal(
    reencoded.value.canonicalHash,
    LIQUIDATION_EVIDENCE_V2_GOLDEN_HASH,
  );
});

test("v3 has one selected-asset target and rehydrates through its exact schema", () => {
  const bundle = createLiquidationEvidenceBundleV3(inputV3());
  assert.equal(bundle.ok, true);
  if (!bundle.ok) return;
  assert.equal(
    bundle.value.schemaVersion,
    LIQUIDATION_EVIDENCE_V3_SCHEMA_VERSION,
  );
  assert.equal(bundle.value.policyVersion, "liquidation-market-aggregate/v2");
  assert.equal(bundle.value.targets.length, 1);
  assert.equal(bundle.value.targets[0]?.asset, "BTC");
  assert.equal(bundle.value.targets[0]?.constituents.length, 1);
  const envelope = encodeCanonicalArtifact(
    "liquidation-evidence-bundle",
    bundle.value,
  );
  assert.equal(envelope.ok, true);
  if (!envelope.ok) return;
  const rehydrated = rehydrateArtifact(
    "liquidation-evidence-bundle",
    envelope.value,
  );
  assert.equal(rehydrated.ok, true);
  if (!rehydrated.ok) return;
  assert.equal(
    rehydrated.value.schemaVersion,
    LIQUIDATION_EVIDENCE_V3_SCHEMA_VERSION,
  );
  const reencoded = encodeCanonicalArtifact(
    "liquidation-evidence-bundle",
    rehydrated.value,
  );
  assert.equal(reencoded.ok, true);
  if (!reencoded.ok) return;
  assert.equal(reencoded.value.canonicalHash, envelope.value.canonicalHash);
});

test("catalogue membership and expiry changes recompute v3 selection identity", () => {
  const cutoffMs = Date.parse(CUTOFF);
  const expiringMarket: LiquidationCatalogueMarket = {
    symbol: "BTCUSDT_PERP.BYBIT",
    exchange: "bybit",
    symbolOnExchange: "BTCUSDT",
    baseAsset: "BTC",
    quoteAsset: "USDT",
    isPerpetual: true,
    marginType: "STABLE",
    expireAt: Math.floor(cutoffMs / 1_000) + 3_600,
    notionalDenominatedIn: "USD",
  };
  const initial = selectDecisionLiquidationMarkets({
    asset: "BTC",
    markets: [expiringMarket],
    catalogueComplete: true,
    cutoffMs,
  });
  const expanded = selectDecisionLiquidationMarkets({
    asset: "BTC",
    markets: [
      expiringMarket,
      {
        ...expiringMarket,
        symbol: "BTCUSDT_PERP.BINANCE",
        exchange: "binance",
        symbolOnExchange: "BTCUSDT",
        expireAt: 0,
      },
    ],
    catalogueComplete: true,
    cutoffMs,
  });
  const afterExpiry = selectDecisionLiquidationMarkets({
    asset: "BTC",
    markets: [expiringMarket],
    catalogueComplete: true,
    cutoffMs: cutoffMs + 3_600_000,
  });

  assert.equal(initial.ok, true);
  assert.equal(expanded.ok, true);
  assert.equal(afterExpiry.ok, true);
  if (!initial.ok || !expanded.ok || !afterExpiry.ok) return;
  assert.equal(initial.value.coveragePolicyVersion, "decision-coverage/v1");
  assert.equal(expanded.value.coveragePolicyVersion, "decision-coverage/v1");
  assert.notEqual(initial.value.catalogueHash, expanded.value.catalogueHash);
  assert.notEqual(
    initial.value.selectedSetHash,
    expanded.value.selectedSetHash,
  );
  assert.equal(afterExpiry.value.selectedMarkets.length, 0);
  assert.equal(afterExpiry.value.exclusions[0]?.reason, "expired");
  assert.notEqual(
    initial.value.selectedSetHash,
    afterExpiry.value.selectedSetHash,
  );
});

test("failed v3 with an empty selected set carries negative proofs, never vacuous completeness", () => {
  const emptySelection = selectDecisionLiquidationMarkets({
    asset: "BTC",
    markets: [],
    catalogueComplete: false,
    cutoffMs: Date.parse(CUTOFF),
  });
  assert.equal(emptySelection.ok, true);
  if (!emptySelection.ok) return;
  const input = inputV3({
    selection: {
      coveragePolicyVersion: emptySelection.value.coveragePolicyVersion,
      selectedAsset: emptySelection.value.selectedAsset,
      cutoff: emptySelection.value.cutoff,
      catalogueComplete: emptySelection.value.catalogueComplete,
      catalogueMarkets: emptySelection.value.catalogueMarkets,
      catalogueHash: emptySelection.value.catalogueHash,
      exclusions: emptySelection.value.exclusions,
      selectedSetHash: emptySelection.value.selectedSetHash,
      reasonCodes: emptySelection.value.reasonCodes,
    },
    coverageProof: "incomplete",
    historyProof: "incomplete",
    status: "failed",
    targets: [{ asset: "BTC", constituents: [] }],
    diagnostics: [
      { code: "catalogue-unavailable", operation: "discover-markets" },
    ],
  });
  const bundle = createLiquidationEvidenceBundleV3(input);
  assert.equal(bundle.ok, true);
  if (bundle.ok) {
    assert.equal(bundle.value.status, "failed");
    assert.equal(bundle.value.coverageProof, "incomplete");
    assert.equal(bundle.value.historyProof, "incomplete");
    assert.equal(bundle.value.targets.length, 1);
    assert.equal(bundle.value.targets[0]?.constituents.length, 0);
  }
  assert.equal(
    createLiquidationEvidenceBundleV3({
      ...input,
      coverageProof: "complete",
      historyProof: "complete",
      status: "complete",
      diagnostics: [],
    }).ok,
    false,
  );
});

test("v3 does not infer catalogue completeness from a matching digest or full history counts", () => {
  const complete = inputV3();
  const completeSelection = complete.selection as {
    readonly catalogueMarkets: readonly LiquidationCatalogueMarket[];
    readonly catalogueHash: string;
  };
  const incompleteSelection = selectDecisionLiquidationMarkets({
    asset: "BTC",
    markets: completeSelection.catalogueMarkets,
    catalogueComplete: false,
    cutoffMs: Date.parse(CUTOFF),
  });
  assert.equal(incompleteSelection.ok, true);
  if (!incompleteSelection.ok) return;
  assert.equal(
    incompleteSelection.value.catalogueHash,
    completeSelection.catalogueHash,
  );
  const completeConstituent = complete.targets[0]?.constituents[0];
  assert.ok(completeConstituent);
  if (completeConstituent === undefined) return;
  const tamperedClaim = {
    ...complete,
    selection: {
      coveragePolicyVersion: incompleteSelection.value.coveragePolicyVersion,
      selectedAsset: incompleteSelection.value.selectedAsset,
      cutoff: incompleteSelection.value.cutoff,
      catalogueComplete: incompleteSelection.value.catalogueComplete,
      catalogueMarkets: incompleteSelection.value.catalogueMarkets,
      catalogueHash: incompleteSelection.value.catalogueHash,
      exclusions: incompleteSelection.value.exclusions,
      selectedSetHash: incompleteSelection.value.selectedSetHash,
      reasonCodes: incompleteSelection.value.reasonCodes,
    },
    coverageProof: "complete",
  };
  assert.equal(createLiquidationEvidenceBundleV3(tamperedClaim).ok, false);

  const impliedUnderIncompleteCatalogue = {
    ...complete,
    selection: tamperedClaim.selection,
    coverageProof: "incomplete",
    historyProof: "complete",
    status: "incomplete",
    diagnostics: [
      { code: "catalogue-incomplete", operation: "discover-markets" },
    ],
    targets: [
      {
        asset: "BTC",
        constituents: [
          {
            ...completeConstituent,
            observations: completeConstituent.observations.map(
              (observation, index) =>
                index === 0
                  ? {
                      ...observation,
                      longUsd: "0",
                      shortUsd: "0",
                      provenance: "provider-implied-zero",
                    }
                  : observation,
            ),
          },
        ],
      },
    ],
  };
  assert.equal(
    createLiquidationEvidenceBundleV3(impliedUnderIncompleteCatalogue).ok,
    false,
  );

  const malformedProvider = createLiquidationEvidenceBundleV3(
    inputV3({
      historyProof: "incomplete",
      status: "incomplete",
      diagnostics: [
        { code: "invalid-observation", operation: "fetch-liquidation-history" },
      ],
    }),
  );
  assert.equal(malformedProvider.ok, true);
  if (malformedProvider.ok) {
    assert.equal(malformedProvider.value.status, "incomplete");
    assert.equal(malformedProvider.value.historyProof, "incomplete");
    assert.equal(
      malformedProvider.value.targets[0]?.constituents[0]?.observations.length,
      LIQUIDATION_HISTORY_BUCKETS,
    );
  }
});

test("v2 provenance is canonical identity and survives deterministic rehydration", () => {
  const base = inputV2({}, 2);
  const explicitInput = {
    ...base,
    targets: withFirstV2Observation(base.targets, {
      longUsd: "0",
      shortUsd: "0",
      provenance: "provider-explicit",
    }),
  };
  const impliedInput = {
    ...base,
    targets: withFirstV2Observation(base.targets, {
      longUsd: "0",
      shortUsd: "0",
      provenance: "provider-implied-zero",
    }),
  };
  const reorderedInput = {
    ...impliedInput,
    targets: [...impliedInput.targets].reverse().map((target) => ({
      ...target,
      constituents: [...target.constituents].reverse(),
    })),
  };

  const explicit = createLiquidationEvidenceBundleV2(explicitInput);
  const implied = createLiquidationEvidenceBundleV2(impliedInput);
  const reordered = createLiquidationEvidenceBundleV2(reorderedInput);
  assert.equal(explicit.ok, true);
  assert.equal(implied.ok, true);
  assert.equal(reordered.ok, true);
  if (!explicit.ok || !implied.ok || !reordered.ok) return;

  const explicitEnvelope = encodeCanonicalArtifact(
    "liquidation-evidence-bundle",
    explicit.value,
  );
  const impliedEnvelope = encodeCanonicalArtifact(
    "liquidation-evidence-bundle",
    implied.value,
  );
  const reorderedEnvelope = encodeCanonicalArtifact(
    "liquidation-evidence-bundle",
    reordered.value,
  );
  assert.equal(explicitEnvelope.ok, true);
  assert.equal(impliedEnvelope.ok, true);
  assert.equal(reorderedEnvelope.ok, true);
  if (!explicitEnvelope.ok || !impliedEnvelope.ok || !reorderedEnvelope.ok) {
    return;
  }
  assert.equal(impliedEnvelope.value.schemaVersion, "artifact/v1");
  assert.notEqual(
    explicitEnvelope.value.canonicalHash,
    impliedEnvelope.value.canonicalHash,
  );
  assert.equal(
    impliedEnvelope.value.canonicalHash,
    reorderedEnvelope.value.canonicalHash,
  );

  const rehydrated = rehydrateArtifact(
    "liquidation-evidence-bundle",
    impliedEnvelope.value,
  );
  assert.equal(rehydrated.ok, true);
  if (!rehydrated.ok) return;
  assert.equal(
    rehydrated.value.schemaVersion,
    LIQUIDATION_EVIDENCE_V2_SCHEMA_VERSION,
  );
  if (
    rehydrated.value.schemaVersion !== LIQUIDATION_EVIDENCE_V2_SCHEMA_VERSION
  ) {
    return;
  }
  assert.equal(
    rehydrated.value.providerSemanticIdentity,
    LIQUIDATION_EVIDENCE_V2_PROVIDER_SEMANTIC_IDENTITY,
  );
  assert.equal(
    rehydrated.value.targets[0]?.constituents[0]?.observations[0]?.provenance,
    "provider-implied-zero",
  );
  assert.equal(
    rehydrated.value.targets[0]?.constituents[0]?.observations[0]?.longUsd.toString(),
    "0",
  );
  assert.equal(Object.isFrozen(rehydrated.value), true);
  assert.equal(
    Object.isFrozen(
      rehydrated.value.targets[0]?.constituents[0]?.observations[0],
    ),
    true,
  );

  const reencoded = encodeCanonicalArtifact(
    "liquidation-evidence-bundle",
    rehydrated.value,
  );
  assert.equal(reencoded.ok, true);
  if (!reencoded.ok) return;
  assert.equal(
    reencoded.value.canonicalJson,
    impliedEnvelope.value.canonicalJson,
  );
  assert.equal(
    reencoded.value.canonicalHash,
    impliedEnvelope.value.canonicalHash,
  );

  const reference = createLiquidationEvidenceRef(
    rehydrated.value,
    reencoded.value.canonicalHash,
    60_000,
  );
  assert.equal(reference.ok, true);
  if (reference.ok) {
    assert.equal(
      reference.value.schemaVersion,
      LIQUIDATION_EVIDENCE_V2_SCHEMA_VERSION,
    );
    const referenceEnvelope = encodeCanonicalArtifact(
      "evidence-ref",
      reference.value,
    );
    assert.equal(referenceEnvelope.ok, true);
    if (referenceEnvelope.ok) {
      const decodedReference = rehydrateArtifact(
        "evidence-ref",
        referenceEnvelope.value,
      );
      assert.equal(decodedReference.ok, true);
      if (
        decodedReference.ok &&
        "kind" in decodedReference.value &&
        decodedReference.value.kind === "liquidation-evidence-bundle"
      ) {
        assert.equal(
          decodedReference.value.schemaVersion,
          LIQUIDATION_EVIDENCE_V2_SCHEMA_VERSION,
        );
      }
    }
  }
});

test("v2 rejects nonzero implied observations and unknown semantics or provenance", () => {
  const base = inputV2();
  const nonzeroImplied = {
    ...base,
    targets: withFirstV2Observation(base.targets, {
      provenance: "provider-implied-zero",
    }),
  };
  assert.equal(createLiquidationEvidenceBundleV2(nonzeroImplied).ok, false);

  assert.equal(
    createLiquidationEvidenceBundleV2({
      ...base,
      coverageProof: "incomplete",
      historyProof: "incomplete",
      status: "incomplete",
      diagnostics: [
        {
          code: "catalogue-incomplete",
          operation: "discover-markets",
        },
      ],
      targets: withFirstV2Observation(base.targets, {
        longUsd: "0",
        shortUsd: "0",
        provenance: "provider-implied-zero",
      }),
    }).ok,
    false,
  );

  assert.equal(
    createLiquidationEvidenceBundleV2({
      ...base,
      providerSemanticIdentity: "coinalyze-sparse-zero/v2",
    }).ok,
    false,
  );
  assert.equal(
    encodeCanonicalArtifact("liquidation-evidence-bundle", {
      ...base,
      providerSemanticIdentity: "coinalyze-sparse-zero/v2",
    }).ok,
    false,
  );

  const unknownProvenance = {
    ...base,
    targets: withFirstV2Observation(base.targets, {
      provenance: "provider-inferred-zero" as LiquidationObservationProvenance,
    }),
  };
  assert.equal(createLiquidationEvidenceBundleV2(unknownProvenance).ok, false);
  assert.equal(
    encodeCanonicalArtifact("liquidation-evidence-bundle", unknownProvenance)
      .ok,
    false,
  );
});
