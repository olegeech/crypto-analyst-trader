import assert from "node:assert/strict";
import test from "node:test";

import {
  createAnalyticsEvidenceBundle,
  rehydrateAnalyticsEvidenceBundle,
} from "../src/domain/analytics/analytics-evidence-bundle.js";
import { createAnalyticsInputIdentity } from "../src/domain/analytics/analytics-inputs.js";
import { computeDerivativeFeatures } from "../src/domain/analytics/derivatives-features.js";
import { createAnalyticsProfile } from "../src/domain/analytics/analytics-profile.js";
import { reduceAnalyticsSufficiency } from "../src/domain/analytics/analytics-sufficiency.js";
import {
  LIQUIDATION_EVIDENCE_ASSETS,
  LIQUIDATION_EVIDENCE_POLICY_VERSION,
  LIQUIDATION_EVIDENCE_SCHEMA_VERSION,
  createLiquidationEvidenceBundle,
  type LiquidationTargetAsset,
} from "../src/domain/liquidation/liquidation-evidence-bundle.js";
import { liquidationHistoryWindow } from "../src/domain/liquidation/liquidation-evidence-windows.js";
import {
  MARKET_EVIDENCE_SCHEMA_VERSION,
  MARKET_EVIDENCE_SYMBOLS,
  MARKET_EVIDENCE_UNIVERSE_VERSION,
  createMarketEvidenceBundle,
  marketEvidenceContentHash,
  type FundingObservation,
  type MarketEvidenceBundle,
  type OpenInterestObservation,
} from "../src/domain/market/market-evidence-bundle.js";
import { DecimalValue } from "../src/domain/shared/decimal.js";
import { hashCanonical } from "../src/domain/identity/canonical-serialization.js";

const CUTOFF = "2026-09-24T12:30:00.000Z";
const HOUR_MS = 60 * 60 * 1_000;

function decimal(value: string): DecimalValue {
  const result = DecimalValue.fromString(value);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("decimal fixture is invalid");
  return result.value;
}

function timestamp(epoch: number): string {
  return new Date(epoch).toISOString();
}

function profile(features: readonly Record<string, unknown>[]) {
  const result = createAnalyticsProfile({
    schemaVersion: "analytics-profile/v1",
    features,
    externalEvidence: [],
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("analytics profile fixture is invalid");
  return result.value;
}

function marketBundle(
  options: {
    readonly funding?: readonly FundingObservation[];
    readonly fundingInterval?: number;
    readonly openInterest?: readonly OpenInterestObservation[];
  } = {},
): MarketEvidenceBundle {
  const result = createMarketEvidenceBundle({
    runId: "analytics-derivatives-run",
    schemaVersion: MARKET_EVIDENCE_SCHEMA_VERSION,
    producer: "fixture/market-evidence",
    universeVersion: MARKET_EVIDENCE_UNIVERSE_VERSION,
    universe: [...MARKET_EVIDENCE_SYMBOLS],
    collectionStartedAt: "2026-09-24T12:00:00.000Z",
    collectionEndedAt: "2026-09-24T12:01:00.000Z",
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
      ...(symbol === "BTCUSDT"
        ? {
            instrument: {
              symbol,
              status: "trading",
              contractType: "LinearPerpetual",
              baseCoin: "BTC",
              quoteCoin: "USDT",
              settleCoin: "USDT",
              constraints: {
                instrument: symbol,
                priceTickSize: "0.1",
                quantityStep: "0.001",
                minQuantity: "0.001",
                minNotional: "5",
              },
              fundingInterval: options.fundingInterval ?? 480,
            },
            funding: options.funding ?? [],
            openInterest: options.openInterest
              ? [
                  {
                    interval: "1h",
                    observations: options.openInterest,
                  },
                ]
              : [],
          }
        : { funding: [], openInterest: [] }),
      ohlcv: [],
      diagnostics: [],
    })),
    diagnostics: [],
    evidence: [
      {
        kind: "market-snapshot",
        schemaVersion: "market-snapshot/v1",
        producer: "fixture/market-evidence",
        sourceId: "analytics-derivatives-run",
        asOf: "2026-09-24T12:00:00.000Z",
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
  market: MarketEvidenceBundle,
  options: {
    readonly coverageProof?: "complete" | "incomplete";
    readonly historyProof?: "complete" | "incomplete";
    readonly status?: "complete" | "incomplete" | "failed";
    readonly rows?: readonly {
      readonly timestamp: string;
      readonly longUsd: string;
      readonly shortUsd: string;
    }[];
    readonly allAssets?: boolean;
    readonly marketHash?: string;
  } = {},
) {
  const contentHash = marketEvidenceContentHash(market);
  assert.equal(contentHash.ok, true);
  if (!contentHash.ok) throw new Error("market content hash is invalid");
  const rows = options.rows ?? [];
  const hasRows = rows.length > 0;
  const fullHistory = options.historyProof === "complete";
  const result = createLiquidationEvidenceBundle({
    runId: market.runId,
    schemaVersion: LIQUIDATION_EVIDENCE_SCHEMA_VERSION,
    producer: "fixture/liquidation-evidence",
    policyVersion: LIQUIDATION_EVIDENCE_POLICY_VERSION,
    provider: "coinalyze",
    collectionStartedAt: "2026-09-24T12:00:00.000Z",
    collectionEndedAt: "2026-09-24T12:01:00.000Z",
    bundleCutoff: market.bundleCutoff,
    marketEvidence: {
      runId: market.runId,
      universeVersion: market.universeVersion,
      bundleCutoff: market.bundleCutoff,
      contentHash: options.marketHash ?? contentHash.value,
    },
    coverageProof: options.coverageProof ?? "complete",
    historyProof: options.historyProof ?? "incomplete",
    status: options.status ?? (hasRows ? "incomplete" : "failed"),
    targets: LIQUIDATION_EVIDENCE_ASSETS.map((asset) => ({
      asset,
      constituents:
        (asset === "BTC" || options.allAssets) && (fullHistory || hasRows)
          ? [
              {
                providerSymbol: `${asset}USDT_PERP.A`,
                exchange: "Bybit",
                symbolOnExchange: `${asset}USDT`,
                baseAsset: asset as LiquidationTargetAsset,
                quoteAsset: "USDT",
                isPerpetual: true,
                marginType: "USDT",
                expireAt: 0,
                notionalDenominatedIn: "USD",
                observations: fullHistory
                  ? liquidationHistoryWindow(
                      Date.parse(market.bundleCutoff),
                    ).epochs.map((epoch) => ({
                      timestamp: timestamp(epoch),
                      longUsd: rows[0]?.longUsd ?? "1",
                      shortUsd: rows[0]?.shortUsd ?? "1",
                    }))
                  : asset === "BTC"
                    ? rows
                    : [],
              },
            ]
          : [],
    })),
    diagnostics:
      (options.status ?? (hasRows ? "incomplete" : "failed")) === "complete"
        ? []
        : [
            {
              code: "provider-unavailable",
              operation: "fetch-liquidation-history",
            },
          ],
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("liquidation fixture is invalid");
  return result.value;
}

function hourlyRow(hourOffset: number, longUsd: string, shortUsd: string) {
  const latestClosed =
    Math.floor(Date.parse(CUTOFF) / HOUR_MS) * HOUR_MS - HOUR_MS;
  return {
    timestamp: timestamp(latestClosed - hourOffset * HOUR_MS),
    longUsd,
    shortUsd,
  };
}

test("funding delta uses the exact consecutive instrument cadence across zero", () => {
  const market = marketBundle({
    funding: [
      {
        timestamp:
          "2026-09-23T20:30:00.000Z" as FundingObservation["timestamp"],
        rate: decimal("-0.0001"),
      },
      {
        timestamp:
          "2026-09-24T04:30:00.000Z" as FundingObservation["timestamp"],
        rate: decimal("0.0002"),
      },
      {
        timestamp:
          "2026-09-24T12:30:00.000Z" as FundingObservation["timestamp"],
        rate: decimal("0.0005"),
      },
    ],
  });
  const result = computeDerivativeFeatures(
    market,
    undefined,
    profile([
      {
        id: "btc-funding-change",
        kind: "funding-change",
        symbol: "BTCUSDT",
        observationCount: 3,
        required: true,
      },
    ]),
  );

  assert.equal(result[0]?.status, "complete");
  assert.equal(result[0]?.kind, "funding-change");
  if (result[0]?.window !== undefined && "cadenceMs" in result[0].window) {
    assert.equal(result[0].window.cadenceMs, 8 * HOUR_MS);
  }
  if (result[0]?.value?.type === "funding-change") {
    assert.equal(result[0].value.change.toString(), "0.0006");
    assert.equal(result[0].value.unit, "funding-rate");
  } else {
    assert.fail("funding delta should be available");
  }
});

test("funding cadence mismatch makes only that output unavailable", () => {
  const market = marketBundle({
    funding: [
      {
        timestamp:
          "2026-09-23T20:30:00.000Z" as FundingObservation["timestamp"],
        rate: decimal("-0.0001"),
      },
      {
        timestamp:
          "2026-09-24T04:00:00.000Z" as FundingObservation["timestamp"],
        rate: decimal("0.0002"),
      },
      {
        timestamp:
          "2026-09-24T12:00:00.000Z" as FundingObservation["timestamp"],
        rate: decimal("0.0005"),
      },
    ],
  });
  const result = computeDerivativeFeatures(
    market,
    undefined,
    profile([
      {
        id: "btc-funding-change",
        kind: "funding-change",
        symbol: "BTCUSDT",
        observationCount: 3,
        required: true,
      },
    ]),
  );

  assert.equal(result[0]?.status, "unavailable");
  assert.deepEqual(result[0]?.reasonCodes, ["INSUFFICIENT_WINDOW"]);
});

test("open-interest changes use one ordered source-unit pair", () => {
  const market = marketBundle({
    openInterest: [
      {
        timestamp:
          "2026-09-24T10:00:00.000Z" as OpenInterestObservation["timestamp"],
        openInterest: decimal("100"),
      },
      {
        timestamp:
          "2026-09-24T11:00:00.000Z" as OpenInterestObservation["timestamp"],
        openInterest: decimal("125"),
      },
    ],
  });
  const result = computeDerivativeFeatures(
    market,
    undefined,
    profile([
      {
        id: "btc-oi-absolute",
        kind: "open-interest-absolute-change",
        symbol: "BTCUSDT",
        interval: "1h",
        observationCount: 2,
        required: true,
      },
      {
        id: "btc-oi-relative",
        kind: "open-interest-relative-change",
        symbol: "BTCUSDT",
        interval: "1h",
        observationCount: 2,
        required: true,
      },
    ]),
  );

  assert.deepEqual(
    result.map((item) => item.status),
    ["complete", "complete"],
  );
  const absolute = result.find(
    (item) => item.kind === "open-interest-absolute-change",
  );
  const relative = result.find(
    (item) => item.kind === "open-interest-relative-change",
  );
  assert.equal(absolute?.value?.type, "open-interest-absolute-change");
  if (absolute?.value?.type === "open-interest-absolute-change") {
    assert.equal(absolute.value.change.toString(), "25");
    assert.equal(absolute.value.unit, "source-open-interest");
  }
  assert.equal(relative?.value?.type, "open-interest-relative-change");
  if (relative?.value?.type === "open-interest-relative-change") {
    assert.equal(relative.value.percent.toString(), "25");
    assert.equal(relative.value.unit, "percent");
  }
});

test("zero initial open interest preserves absolute change only", () => {
  const market = marketBundle({
    openInterest: [
      {
        timestamp:
          "2026-09-24T10:00:00.000Z" as OpenInterestObservation["timestamp"],
        openInterest: decimal("0"),
      },
      {
        timestamp:
          "2026-09-24T11:00:00.000Z" as OpenInterestObservation["timestamp"],
        openInterest: decimal("100"),
      },
    ],
  });
  const result = computeDerivativeFeatures(
    market,
    undefined,
    profile([
      {
        id: "btc-oi-absolute",
        kind: "open-interest-absolute-change",
        symbol: "BTCUSDT",
        interval: "1h",
        observationCount: 2,
        required: true,
      },
      {
        id: "btc-oi-relative",
        kind: "open-interest-relative-change",
        symbol: "BTCUSDT",
        interval: "1h",
        observationCount: 2,
        required: true,
      },
    ]),
  );

  assert.equal(result[0]?.status, "complete");
  assert.equal(result[1]?.status, "unavailable");
  assert.deepEqual(result[1]?.reasonCodes, ["ZERO_OPEN_INTEREST_REFERENCE"]);
  if (result[0]?.value?.type === "open-interest-absolute-change") {
    assert.equal(result[0].value.change.toString(), "100");
  }
});

test("open-interest gap does not silently compare a longer interval", () => {
  const market = marketBundle({
    openInterest: [
      {
        timestamp:
          "2026-09-24T09:00:00.000Z" as OpenInterestObservation["timestamp"],
        openInterest: decimal("100"),
      },
      {
        timestamp:
          "2026-09-24T11:00:00.000Z" as OpenInterestObservation["timestamp"],
        openInterest: decimal("125"),
      },
    ],
  });
  const result = computeDerivativeFeatures(
    market,
    undefined,
    profile([
      {
        id: "btc-oi-absolute",
        kind: "open-interest-absolute-change",
        symbol: "BTCUSDT",
        interval: "1h",
        observationCount: 2,
        required: true,
      },
    ]),
  );

  assert.equal(result[0]?.status, "unavailable");
  assert.deepEqual(result[0]?.reasonCodes, ["INSUFFICIENT_WINDOW"]);
});

test("liquidation imbalance keeps USD sides separate and reverses with swapped sides", () => {
  const market = marketBundle();
  const profileValue = profile([
    {
      id: "btc-liquidation-24h",
      kind: "liquidation-window",
      asset: "BTC",
      windowHours: 24,
      required: true,
    },
  ]);
  const longDominant = computeDerivativeFeatures(
    market,
    liquidationBundle(market, {
      coverageProof: "complete",
      historyProof: "complete",
      status: "complete",
      allAssets: true,
      rows: [{ timestamp: CUTOFF, longUsd: "1", shortUsd: "3" }],
    }),
    profileValue,
  )[0];
  const shortDominant = computeDerivativeFeatures(
    market,
    liquidationBundle(market, {
      coverageProof: "complete",
      historyProof: "complete",
      status: "complete",
      allAssets: true,
      rows: [{ timestamp: CUTOFF, longUsd: "3", shortUsd: "1" }],
    }),
    profileValue,
  )[0];

  assert.equal(longDominant?.status, "complete");
  assert.equal(shortDominant?.status, "complete");
  if (longDominant?.value?.type === "liquidation-window") {
    assert.equal(longDominant.value.longUsd.toString(), "24");
    assert.equal(longDominant.value.shortUsd.toString(), "72");
    assert.equal(longDominant.value.totalUsd.toString(), "96");
    assert.equal(longDominant.value.imbalance?.toString(), "0.5");
  }
  if (shortDominant?.value?.type === "liquidation-window") {
    assert.equal(shortDominant.value.longUsd.toString(), "72");
    assert.equal(shortDominant.value.shortUsd.toString(), "24");
    assert.equal(shortDominant.value.imbalance?.toString(), "-0.5");
  }
});

test("zero liquidation totals remain explicit while imbalance is unavailable", () => {
  const market = marketBundle();
  const result = computeDerivativeFeatures(
    market,
    liquidationBundle(market, {
      coverageProof: "incomplete",
      historyProof: "incomplete",
      status: "incomplete",
      rows: [hourlyRow(0, "0", "0")],
    }),
    profile([
      {
        id: "btc-liquidation-1h",
        kind: "liquidation-window",
        asset: "BTC",
        windowHours: 1,
        required: true,
      },
    ]),
  )[0];

  assert.equal(result?.status, "partial");
  assert.deepEqual(result?.reasonCodes, [
    "INCOMPLETE_LIQUIDATION_COVERAGE",
    "INCOMPLETE_LIQUIDATION_HISTORY",
    "ZERO_LIQUIDATION_NOTIONAL",
  ]);
  if (result?.value?.type === "liquidation-window") {
    assert.equal(result.value.longUsd.toString(), "0");
    assert.equal(result.value.shortUsd.toString(), "0");
    assert.equal(result.value.totalUsd.toString(), "0");
    assert.equal(result.value.imbalance, undefined);
  }
});

test("a fully proven explicit-zero liquidation window remains complete", () => {
  const market = marketBundle();
  const liquidation = liquidationBundle(market, {
    coverageProof: "complete",
    historyProof: "complete",
    status: "complete",
    allAssets: true,
    rows: [hourlyRow(0, "0", "0")],
  });
  const requested = profile([
    {
      id: "btc-liquidation-1h",
      kind: "liquidation-window",
      asset: "BTC",
      windowHours: 1,
      required: true,
    },
  ]);
  const result = computeDerivativeFeatures(market, liquidation, requested)[0];
  const bundle = createAnalyticsEvidenceBundle({
    market,
    liquidation,
    profile: requested,
  });

  assert.equal(bundle.ok, true);
  if (bundle.ok) {
    assert.equal(bundle.value.sufficiency.status, "complete");
    assert.deepEqual(rehydrateAnalyticsEvidenceBundle(bundle.value), bundle);
  }
  assert.equal(result?.status, "complete");
  assert.deepEqual(result?.reasonCodes, ["ZERO_LIQUIDATION_NOTIONAL"]);
  if (result?.window !== undefined && "complete" in result.window) {
    assert.equal(result.window.complete, true);
  }
  if (result?.value?.type === "liquidation-window") {
    assert.equal(result.value.longUsd.toString(), "0");
    assert.equal(result.value.shortUsd.toString(), "0");
    assert.equal(result.value.totalUsd.toString(), "0");
    assert.equal(result.value.imbalance, undefined);
  }
});

test("liquidation proof states stay distinct and no-fact results retain missingness", () => {
  const market = marketBundle();
  const request = profile([
    {
      id: "btc-liquidation-1h",
      kind: "liquidation-window",
      asset: "BTC",
      windowHours: 1,
      required: true,
    },
  ]);
  const historyIncomplete = computeDerivativeFeatures(
    market,
    liquidationBundle(market, {
      coverageProof: "complete",
      historyProof: "incomplete",
      status: "incomplete",
      rows: [hourlyRow(0, "2", "5")],
    }),
    request,
  )[0];
  const coverageIncomplete = computeDerivativeFeatures(
    market,
    liquidationBundle(market, {
      coverageProof: "incomplete",
      historyProof: "complete",
      status: "incomplete",
      allAssets: true,
      rows: [{ timestamp: CUTOFF, longUsd: "2", shortUsd: "5" }],
    }),
    request,
  )[0];
  const noFacts = computeDerivativeFeatures(
    market,
    liquidationBundle(market, {
      coverageProof: "incomplete",
      historyProof: "incomplete",
      status: "failed",
    }),
    request,
  )[0];

  assert.equal(historyIncomplete?.status, "partial");
  assert.deepEqual(historyIncomplete?.reasonCodes, [
    "INCOMPLETE_LIQUIDATION_HISTORY",
  ]);
  if (historyIncomplete !== undefined) {
    const reduced = reduceAnalyticsSufficiency(request, [historyIncomplete]);
    assert.equal(reduced.ok, true);
    if (reduced.ok) assert.equal(reduced.value.status, "insufficient");
  }
  assert.equal(coverageIncomplete?.status, "partial");
  assert.deepEqual(coverageIncomplete?.reasonCodes, [
    "INCOMPLETE_LIQUIDATION_COVERAGE",
  ]);
  if (coverageIncomplete !== undefined) {
    const reduced = reduceAnalyticsSufficiency(request, [coverageIncomplete]);
    assert.equal(reduced.ok, true);
    if (reduced.ok) assert.equal(reduced.value.status, "insufficient");
  }
  assert.equal(noFacts?.status, "unavailable");
  assert.deepEqual(noFacts?.reasonCodes, [
    "MISSING_LIQUIDATION_EVIDENCE",
    "INCOMPLETE_LIQUIDATION_COVERAGE",
    "INCOMPLETE_LIQUIDATION_HISTORY",
  ]);
  if (
    noFacts?.window !== undefined &&
    "observedConstituentBuckets" in noFacts.window
  ) {
    assert.equal(noFacts.window.observedConstituentBuckets, 0);
    assert.equal(noFacts.window.expectedConstituentBuckets, 0);
  }
  if (noFacts !== undefined) {
    const reduced = reduceAnalyticsSufficiency(request, [noFacts]);
    assert.equal(reduced.ok, true);
    if (reduced.ok) {
      assert.equal(reduced.value.status, "insufficient");
      assert.deepEqual(reduced.value.reasonCodes, noFacts.reasonCodes);
    }
  }
});

test("liquidation facts with conflicting market identity are not joined", () => {
  const market = marketBundle();
  const result = computeDerivativeFeatures(
    market,
    liquidationBundle(market, {
      coverageProof: "complete",
      historyProof: "complete",
      status: "complete",
      allAssets: true,
      rows: [{ timestamp: CUTOFF, longUsd: "2", shortUsd: "5" }],
      marketHash: `sha256:${"b".repeat(64)}`,
    }),
    profile([
      {
        id: "btc-liquidation-1h",
        kind: "liquidation-window",
        asset: "BTC",
        windowHours: 1,
        required: true,
      },
    ]),
  )[0];

  assert.equal(result?.status, "unavailable");
  assert.deepEqual(result?.reasonCodes, ["INPUT_IDENTITY_MISMATCH"]);
  assert.equal(result?.value, undefined);
});

test("the public derivative helper cannot reuse a stale liquidation identity", () => {
  const originalMarket = marketBundle();
  const liquidation = liquidationBundle(originalMarket, {
    coverageProof: "complete",
    historyProof: "complete",
    status: "complete",
    allAssets: true,
    rows: [{ timestamp: CUTOFF, longUsd: "2", shortUsd: "5" }],
  });
  const staleIdentity = createAnalyticsInputIdentity(
    originalMarket,
    liquidation,
  );
  assert.equal(staleIdentity.ok, true);
  if (!staleIdentity.ok) return;

  const differentMarket = marketBundle({
    funding: [
      {
        timestamp: CUTOFF as FundingObservation["timestamp"],
        rate: decimal("0.001"),
      },
    ],
  });
  const requested = profile([
    {
      id: "btc-liquidation-1h",
      kind: "liquidation-window",
      asset: "BTC",
      windowHours: 1,
      required: true,
    },
  ]);

  assert.equal(computeDerivativeFeatures.length, 3);
  const result = Reflect.apply(computeDerivativeFeatures, undefined, [
    differentMarket,
    liquidation,
    requested,
    staleIdentity.value,
  ])[0];

  assert.equal(result?.status, "unavailable");
  assert.deepEqual(result?.reasonCodes, ["INPUT_IDENTITY_MISMATCH"]);
});

test("rehydration rejects complete liquidation outcomes without complete proofs", () => {
  const market = marketBundle();
  const liquidation = liquidationBundle(market, {
    coverageProof: "complete",
    historyProof: "complete",
    status: "complete",
    allAssets: true,
    rows: [{ timestamp: CUTOFF, longUsd: "2", shortUsd: "5" }],
  });
  const created = createAnalyticsEvidenceBundle({
    market,
    liquidation,
    profile: profile([
      {
        id: "btc-liquidation-1h",
        kind: "liquidation-window",
        asset: "BTC",
        windowHours: 1,
        required: true,
      },
    ]),
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const outcome = created.value.derivativeFeatures[0];
  assert.ok(outcome !== undefined && outcome.kind === "liquidation-window");
  if (outcome === undefined || outcome.kind !== "liquidation-window") return;
  assert.equal(outcome.status, "complete");

  const alteredOutcomes = [
    { ...outcome, coverageProof: "incomplete" },
    (() => {
      const withoutHistoryProof: Record<string, unknown> = { ...outcome };
      delete withoutHistoryProof.historyProof;
      return withoutHistoryProof;
    })(),
    { ...outcome, window: { ...outcome.window, complete: false } },
  ];

  for (const alteredOutcome of alteredOutcomes) {
    const alteredBundle: Record<string, unknown> = {
      ...created.value,
      derivativeFeatures: [alteredOutcome],
    };
    const payload = { ...alteredBundle };
    delete payload.contentHash;
    const recomputedHash = hashCanonical(payload);
    assert.equal(recomputedHash.ok, true);
    if (!recomputedHash.ok) continue;
    assert.equal(
      rehydrateAnalyticsEvidenceBundle({
        ...payload,
        contentHash: recomputedHash.value,
      }).ok,
      false,
    );
  }
});
