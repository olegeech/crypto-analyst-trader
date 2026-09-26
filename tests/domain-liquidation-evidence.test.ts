import assert from "node:assert/strict";
import test from "node:test";

import {
  createLiquidationEvidenceBundle,
  LIQUIDATION_EVIDENCE_ASSETS,
  LIQUIDATION_EVIDENCE_SCHEMA_VERSION,
  LIQUIDATION_EVIDENCE_POLICY_VERSION,
  type LiquidationEvidenceBundleInput,
} from "../src/domain/liquidation/liquidation-evidence-bundle.js";
import {
  encodeCanonicalArtifact,
  rehydrateArtifact,
} from "../src/domain/identity/canonical-artifact.js";
import { createEvidenceRef } from "../src/domain/evidence/evidence-ref.js";
import { DecimalValue } from "../src/domain/shared/decimal.js";

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
