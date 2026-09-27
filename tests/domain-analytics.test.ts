import assert from "node:assert/strict";
import test from "node:test";

import {
  createAnalyticsInputIdentity,
  type AnalyticsInputIdentity,
} from "../src/domain/analytics/analytics-inputs.js";
import {
  createAnalyticsProfile,
  hashAnalyticsProfile,
  type AnalyticsProfile,
} from "../src/domain/analytics/analytics-profile.js";
import {
  reduceAnalyticsSufficiency,
  type AnalyticsOutputOutcome,
} from "../src/domain/analytics/analytics-sufficiency.js";
import {
  LIQUIDATION_EVIDENCE_ASSETS,
  LIQUIDATION_EVIDENCE_POLICY_VERSION,
  LIQUIDATION_EVIDENCE_SCHEMA_VERSION,
  createLiquidationEvidenceBundle,
  type LiquidationEvidenceBundle,
} from "../src/domain/liquidation/liquidation-evidence-bundle.js";
import { deriveLiquidationWindows } from "../src/domain/liquidation/liquidation-evidence-windows.js";
import {
  MARKET_EVIDENCE_SCHEMA_VERSION,
  MARKET_EVIDENCE_SYMBOLS,
  MARKET_EVIDENCE_UNIVERSE_VERSION,
  createMarketEvidenceBundle,
  marketEvidenceContentHash,
  type MarketEvidenceBundle,
} from "../src/domain/market/market-evidence-bundle.js";
import { parseUtcTimestamp } from "../src/domain/shared/time.js";

const CUTOFF = "2026-09-24T12:30:00.000Z";
const MARKET_HASH = `sha256:${"a".repeat(64)}`;

function marketBundle(
  runId = "analytics-run-1",
  bundleCutoff = CUTOFF,
): MarketEvidenceBundle {
  const result = createMarketEvidenceBundle({
    runId,
    schemaVersion: MARKET_EVIDENCE_SCHEMA_VERSION,
    producer: "fixture/market-evidence",
    universeVersion: MARKET_EVIDENCE_UNIVERSE_VERSION,
    universe: [...MARKET_EVIDENCE_SYMBOLS],
    collectionStartedAt: "2026-09-24T12:00:00.000Z",
    collectionEndedAt: "2026-09-24T12:01:00.000Z",
    bundleCutoff,
    source: {
      exchange: "bybit",
      environment: "mainnet",
      origin: "https://api.bybit.com",
      category: "linear",
    },
    status: "incomplete",
    symbols: MARKET_EVIDENCE_SYMBOLS.map((symbol) => ({
      symbol,
      ohlcv: [],
      funding: [],
      openInterest: [],
      diagnostics: [],
    })),
    diagnostics: [],
    evidence: [
      {
        kind: "market-snapshot",
        schemaVersion: "market-snapshot/v1",
        producer: "fixture/market-evidence",
        sourceId: runId,
        asOf: "2026-09-24T12:00:00.000Z",
        validForMs: 60_000,
        contentHash: MARKET_HASH,
      },
    ],
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("market fixture is invalid");
  return result.value;
}

function liquidationBundle(
  market: MarketEvidenceBundle,
  options: {
    readonly runId?: string;
    readonly universeVersion?: string;
    readonly bundleCutoff?: string;
    readonly marketHash?: string;
  } = {},
): LiquidationEvidenceBundle {
  const runId = options.runId ?? market.runId;
  const bundleCutoff = options.bundleCutoff ?? market.bundleCutoff;
  const contentHashResult = marketEvidenceContentHash(market);
  assert.equal(contentHashResult.ok, true);
  if (!contentHashResult.ok) throw new Error("market hash is invalid");
  const cutoff = parseUtcTimestamp(bundleCutoff);
  assert.equal(cutoff.ok, true);
  if (!cutoff.ok) throw new Error("liquidation cutoff is invalid");
  const derived = deriveLiquidationWindows([], cutoff.value);
  const result = createLiquidationEvidenceBundle({
    runId,
    schemaVersion: LIQUIDATION_EVIDENCE_SCHEMA_VERSION,
    producer: "fixture/liquidation-evidence",
    policyVersion: LIQUIDATION_EVIDENCE_POLICY_VERSION,
    provider: "coinalyze",
    collectionStartedAt: "2026-09-24T12:00:00.000Z",
    collectionEndedAt: "2026-09-24T12:01:00.000Z",
    bundleCutoff,
    marketEvidence: {
      runId,
      universeVersion: options.universeVersion ?? market.universeVersion,
      bundleCutoff,
      contentHash: options.marketHash ?? contentHashResult.value,
    },
    coverageProof: "complete",
    historyProof: "incomplete",
    status: "failed",
    targets: LIQUIDATION_EVIDENCE_ASSETS.map((asset) => ({
      asset,
      constituents: [],
      hourlyAggregates: derived.hourlyAggregates,
      windows: derived.windows,
    })),
    diagnostics: [
      { code: "provider-unavailable", operation: "fetch-liquidation-history" },
    ],
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("liquidation fixture is invalid");
  return result.value;
}

function profileInput(
  features: readonly unknown[] = [
    {
      id: "btc-return-1h",
      kind: "close-return",
      symbol: "BTCUSDT",
      interval: "1h",
      periods: 1,
      required: true,
    },
  ],
  externalEvidence: readonly unknown[] = [],
): Record<string, unknown> {
  return {
    schemaVersion: "analytics-profile/v1",
    features,
    externalEvidence,
  };
}

function requireProfile(input: unknown): AnalyticsProfile {
  const result = createAnalyticsProfile(input);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("analytics profile fixture is invalid");
  return result.value;
}

function outcome(
  requestId: string,
  status: AnalyticsOutputOutcome["status"],
  reasonCodes: AnalyticsOutputOutcome["reasonCodes"] = [],
): AnalyticsOutputOutcome {
  return { requestId, status, reasonCodes };
}

function identityFor(
  market: MarketEvidenceBundle,
  liquidation?: LiquidationEvidenceBundle,
): AnalyticsInputIdentity {
  const result = createAnalyticsInputIdentity(market, liquidation);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("analytics input identity is invalid");
  return result.value;
}

test("analytics profile requires explicit requests and canonicalizes order", () => {
  const request = profileInput([
    {
      id: "btc-return-1h",
      kind: "close-return",
      symbol: "BTCUSDT",
      interval: "1h",
      periods: 1,
      required: true,
    },
    {
      id: "eth-atr-4h",
      kind: "atr",
      symbol: "ETHUSDT",
      interval: "4h",
      period: 14,
      required: false,
    },
  ]);
  const first = createAnalyticsProfile(request);
  const second = createAnalyticsProfile({
    ...request,
    features: [...(request.features as unknown[]).reverse()],
  });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.deepEqual(
    first.value.features.map((item) => item.id),
    ["btc-return-1h", "eth-atr-4h"],
  );
  assert.equal(Object.isFrozen(first.value), true);
  const firstHash = hashAnalyticsProfile(first.value);
  const secondHash = hashAnalyticsProfile(second.value);
  assert.equal(firstHash.ok, true);
  assert.equal(secondHash.ok, true);
  assert.equal(
    firstHash.ok && secondHash.ok
      ? firstHash.value === secondHash.value
      : false,
    true,
  );
});

test("analytics profile rejects empty, malformed, and algorithm-policy overrides", () => {
  for (const invalid of [
    profileInput([], []),
    { ...profileInput(), precision: 8 },
    { ...profileInput(), rounding: "half-even" },
    profileInput([
      {
        id: "bad-volatility-window",
        kind: "volatility-comparison",
        symbol: "BTCUSDT",
        interval: "1h",
        recentObservationCount: 12,
        referenceObservationCount: 48,
        required: true,
      },
    ]),
    profileInput([
      {
        id: "bad-precision-override",
        kind: "close-return",
        symbol: "BTCUSDT",
        interval: "1h",
        periods: 1,
        required: true,
        rounding: "down",
      },
    ]),
  ]) {
    const result = createAnalyticsProfile(invalid);
    assert.equal(result.ok, false);
  }
});

test("analytics profile rejects missing required fields and unsupported requests", () => {
  for (const invalid of [
    profileInput([
      {
        id: "missing-required-flag",
        kind: "close-return",
        symbol: "BTCUSDT",
        interval: "1h",
        periods: 1,
      },
    ]),
    profileInput([
      {
        id: "unsupported-feature",
        kind: "hidden-composite-score",
        required: true,
      },
    ]),
    profileInput([
      {
        id: "zero-period",
        kind: "close-return",
        symbol: "BTCUSDT",
        interval: "1h",
        periods: 0,
        required: true,
      },
    ]),
    profileInput(
      [
        {
          id: "duplicate-id",
          kind: "close-return",
          symbol: "BTCUSDT",
          interval: "1h",
          periods: 1,
          required: true,
        },
        {
          id: "duplicate-id",
          kind: "atr",
          symbol: "BTCUSDT",
          interval: "1h",
          period: 3,
          required: false,
        },
      ],
      [],
    ),
  ]) {
    assert.equal(createAnalyticsProfile(invalid).ok, false);
  }
});

test("analytics profile rejects feature and external request ID collisions", () => {
  const result = createAnalyticsProfile(
    profileInput(
      [
        {
          id: "external:trap",
          kind: "close-return",
          symbol: "BTCUSDT",
          interval: "1h",
          periods: 1,
          required: true,
        },
      ],
      [{ family: "trap", required: true }],
    ),
  );
  assert.equal(result.ok, false);
});

test("input identity hashes both source bundles and accepts exact lineage", () => {
  const market = marketBundle();
  const liquidation = liquidationBundle(market);
  const identity = identityFor(market, liquidation);

  assert.equal(identity.compatibility, "compatible");
  assert.match(identity.marketBundleHash, /^sha256:[0-9a-f]{64}$/u);
  assert.match(identity.marketContentHash, /^sha256:[0-9a-f]{64}$/u);
  assert.match(identity.liquidationBundleHash ?? "", /^sha256:[0-9a-f]{64}$/u);
  assert.deepEqual(identity.reasonCodes, []);
  assert.equal(Object.isFrozen(identity), true);

  const marketOnly = identityFor(market);
  assert.equal(marketOnly.compatibility, "compatible");
  assert.equal(marketOnly.liquidationBundleHash, undefined);
});

test("input identity detects each conflicting run boundary without losing hashes", () => {
  const market = marketBundle();
  const conflicts = [
    liquidationBundle(market, { runId: "other-run" }),
    liquidationBundle(market, { universeVersion: "m1-universe/other" }),
    liquidationBundle(market, { bundleCutoff: "2026-09-24T12:31:00.000Z" }),
    liquidationBundle(market, { marketHash: `sha256:${"b".repeat(64)}` }),
  ];

  for (const liquidation of conflicts) {
    const identity = identityFor(market, liquidation);
    assert.equal(identity.compatibility, "incompatible");
    assert.deepEqual(identity.reasonCodes, ["INPUT_IDENTITY_MISMATCH"]);
    assert.match(identity.marketBundleHash, /^sha256:[0-9a-f]{64}$/u);
    assert.match(
      identity.liquidationBundleHash ?? "",
      /^sha256:[0-9a-f]{64}$/u,
    );
  }
});

test("sufficiency distinguishes complete, partial, and insufficient results", () => {
  const profile = requireProfile(
    profileInput([
      {
        id: "btc-return-1h",
        kind: "close-return",
        symbol: "BTCUSDT",
        interval: "1h",
        periods: 1,
        required: true,
      },
      {
        id: "eth-atr-4h",
        kind: "atr",
        symbol: "ETHUSDT",
        interval: "4h",
        period: 14,
        required: true,
      },
      {
        id: "sol-drawdown",
        kind: "maximum-drawdown",
        symbol: "SOLUSDT",
        interval: "1d",
        observationCount: 20,
        required: false,
      },
    ]),
  );
  const identity = identityFor(marketBundle());

  const complete = reduceAnalyticsSufficiency(
    profile,
    [
      outcome("btc-return-1h", "complete"),
      outcome("eth-atr-4h", "complete"),
      outcome("sol-drawdown", "unavailable", ["INSUFFICIENT_WINDOW"]),
    ],
    identity,
  );
  assert.equal(complete.ok, true);
  if (complete.ok) assert.equal(complete.value.status, "partial");

  const optionalOnlyProfile = requireProfile(
    profileInput([
      {
        id: "optional-btc-return",
        kind: "close-return",
        symbol: "BTCUSDT",
        interval: "1h",
        periods: 1,
        required: false,
      },
    ]),
  );
  const optionalOnlyUnavailable = reduceAnalyticsSufficiency(
    optionalOnlyProfile,
    [outcome("optional-btc-return", "unavailable", ["INSUFFICIENT_WINDOW"])],
    identity,
  );
  assert.equal(optionalOnlyUnavailable.ok, true);
  if (optionalOnlyUnavailable.ok)
    assert.equal(optionalOnlyUnavailable.value.status, "insufficient");

  const partial = reduceAnalyticsSufficiency(
    profile,
    [
      outcome("btc-return-1h", "complete"),
      outcome("eth-atr-4h", "unavailable", ["INSUFFICIENT_WINDOW"]),
      outcome("sol-drawdown", "unavailable", ["INSUFFICIENT_WINDOW"]),
    ],
    identity,
  );
  assert.equal(partial.ok, true);
  if (partial.ok) {
    assert.equal(partial.value.status, "partial");
    assert.deepEqual(partial.value.reasonCodes, ["INSUFFICIENT_WINDOW"]);
  }

  const insufficient = reduceAnalyticsSufficiency(
    profile,
    [
      outcome("btc-return-1h", "unavailable", ["INSUFFICIENT_WINDOW"]),
      outcome("eth-atr-4h", "unavailable", ["INSUFFICIENT_WINDOW"]),
      outcome("sol-drawdown", "unavailable", ["INSUFFICIENT_WINDOW"]),
    ],
    identity,
  );
  assert.equal(insufficient.ok, true);
  if (insufficient.ok) assert.equal(insufficient.value.status, "insufficient");
});

test("lineage conflict prevents a joined sufficiency claim", () => {
  const profile = requireProfile(
    profileInput([
      {
        id: "btc-return-1h",
        kind: "close-return",
        symbol: "BTCUSDT",
        interval: "1h",
        periods: 1,
        required: true,
      },
      {
        id: "btc-liquidation-24h",
        kind: "liquidation-window",
        asset: "BTC",
        windowHours: 24,
        required: true,
      },
    ]),
  );
  const market = marketBundle();
  const identity = identityFor(
    market,
    liquidationBundle(market, { marketHash: `sha256:${"c".repeat(64)}` }),
  );
  const result = reduceAnalyticsSufficiency(
    profile,
    [
      outcome("btc-return-1h", "complete"),
      outcome("btc-liquidation-24h", "partial", [
        "INCOMPLETE_LIQUIDATION_HISTORY",
      ]),
    ],
    identity,
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.status, "insufficient");
    assert.deepEqual(result.value.reasonCodes, [
      "INCOMPLETE_LIQUIDATION_HISTORY",
      "INPUT_IDENTITY_MISMATCH",
    ]);
  }
});
