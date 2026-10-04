import {
  createAnalyticsEvidenceBundle,
  type CreateAnalyticsEvidenceBundleInput,
} from "../../src/domain/analytics/analytics-evidence-bundle.js";
import { createAnalyticsInputIdentity } from "../../src/domain/analytics/analytics-inputs.js";
import {
  EXTERNAL_EVIDENCE_MODEL_VERSIONS,
  EXTERNAL_EVIDENCE_SCHEMA_VERSIONS,
  hashExternalInputManifest,
  normalizeExternalInputEvidenceRefs,
  validateExternalRegimeEvidence,
  type ExternalEvidenceFamily,
  type ExternalInputEvidenceRef,
} from "../../src/domain/analytics/external-regime-evidence.js";
import { createEvidenceRef } from "../../src/domain/evidence/evidence-ref.js";
import { hashCanonical } from "../../src/domain/identity/canonical-serialization.js";
import {
  createLiquidationEvidenceBundle,
  createLiquidationEvidenceRef,
  LIQUIDATION_EVIDENCE_ASSETS,
  LIQUIDATION_EVIDENCE_POLICY_VERSION,
  LIQUIDATION_EVIDENCE_PRODUCER,
  LIQUIDATION_EVIDENCE_SCHEMA_VERSION,
  type LiquidationEvidenceBundle,
  type LiquidationEvidenceBundleInput,
} from "../../src/domain/liquidation/liquidation-evidence-bundle.js";
import {
  createMarketEvidenceBundle,
  marketEvidenceContentHash,
  MARKET_EVIDENCE_PRODUCER,
  MARKET_EVIDENCE_SCHEMA_VERSION,
  MARKET_EVIDENCE_SYMBOLS,
  MARKET_EVIDENCE_UNIVERSE_VERSION,
  MARKET_EVIDENCE_VALID_FOR_MS,
  type MarketEvidenceBundle,
} from "../../src/domain/market/market-evidence-bundle.js";
import { DecimalValue } from "../../src/domain/shared/decimal.js";
import type { Result } from "../../src/domain/shared/result.js";
import { parseUtcTimestamp } from "../../src/domain/shared/time.js";

export const DATA_QUALITY_FIXTURE_CUTOFF = "2026-09-24T14:00:00.000Z";
export const DATA_QUALITY_FIXTURE_RUN_ID = "data-quality-run-1";

function requireFixture<T>(result: Result<T>): T {
  if (!result.ok)
    throw new Error(`Invalid data-quality fixture: ${result.error.message}`);
  return result.value;
}

export function fixtureDecimal(value: string) {
  return requireFixture(DecimalValue.fromString(value));
}

export function fixtureCanonicalHash(value: unknown) {
  return requireFixture(hashCanonical(value));
}

/** Small partial source facts; overrides are validated and the embedded ref is rebuilt. */
export function marketFixture(
  overrides: Partial<Omit<MarketEvidenceBundle, "evidence">> = {},
  validForMs = MARKET_EVIDENCE_VALID_FOR_MS,
): MarketEvidenceBundle {
  const runId = overrides.runId ?? DATA_QUALITY_FIXTURE_RUN_ID;
  const bundleCutoff =
    overrides.bundleCutoff ??
    requireFixture(parseUtcTimestamp(DATA_QUALITY_FIXTURE_CUTOFF));
  const reference = {
    kind: "market-evidence-bundle",
    schemaVersion: MARKET_EVIDENCE_SCHEMA_VERSION,
    producer: MARKET_EVIDENCE_PRODUCER,
    sourceId: `bybit-public:${runId}`,
    asOf: bundleCutoff,
    validForMs,
  };
  const provisional = requireFixture(
    createMarketEvidenceBundle({
      runId,
      schemaVersion: MARKET_EVIDENCE_SCHEMA_VERSION,
      producer: MARKET_EVIDENCE_PRODUCER,
      universeVersion: MARKET_EVIDENCE_UNIVERSE_VERSION,
      universe: MARKET_EVIDENCE_SYMBOLS,
      collectionStartedAt: bundleCutoff,
      collectionEndedAt: bundleCutoff,
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
        ohlcv:
          symbol === "BTCUSDT"
            ? [
                {
                  interval: "1h",
                  observations: [
                    "2026-09-24T12:00:00.000Z",
                    "2026-09-24T13:00:00.000Z",
                  ].map((timestamp, index) => ({
                    timestamp,
                    open: "100",
                    high: "103",
                    low: "99",
                    close: index === 0 ? "100" : "102",
                    volume: "2",
                    turnover: "204",
                    closed: true,
                  })),
                },
              ]
            : [],
        funding: [],
        openInterest: [],
        diagnostics: [],
      })),
      diagnostics: [],
      ...overrides,
      evidence: [
        requireFixture(
          createEvidenceRef({
            ...reference,
            contentHash: fixtureCanonicalHash("provisional-market-fixture"),
          }),
        ),
      ],
    }),
  );
  return requireFixture(
    createMarketEvidenceBundle({
      ...provisional,
      evidence: [
        requireFixture(
          createEvidenceRef({
            ...reference,
            contentHash: requireFixture(marketEvidenceContentHash(provisional)),
          }),
        ),
      ],
    }),
  );
}

/** Separate full-bundle identity, deliberately distinct from the embedded content hash. */
export function marketFixtureHashes(market: MarketEvidenceBundle) {
  return {
    contentHash: requireFixture(marketEvidenceContentHash(market)),
    bundleHash: fixtureCanonicalHash(market),
  };
}

/** One observed contract and bucket; the constructor derives missing windows. */
export function liquidationFixture(
  market: MarketEvidenceBundle = marketFixture(),
  overrides: Partial<LiquidationEvidenceBundleInput> = {},
): LiquidationEvidenceBundle {
  const timestamp = new Date(
    Math.floor(Date.parse(market.bundleCutoff) / 3_600_000) * 3_600_000 -
      3_600_000,
  ).toISOString();
  return requireFixture(
    createLiquidationEvidenceBundle({
      runId: market.runId,
      schemaVersion: LIQUIDATION_EVIDENCE_SCHEMA_VERSION,
      producer: LIQUIDATION_EVIDENCE_PRODUCER,
      provider: "coinalyze",
      policyVersion: LIQUIDATION_EVIDENCE_POLICY_VERSION,
      collectionStartedAt: market.bundleCutoff,
      collectionEndedAt: market.bundleCutoff,
      bundleCutoff: market.bundleCutoff,
      marketEvidence: {
        runId: market.runId,
        universeVersion: market.universeVersion,
        bundleCutoff: market.bundleCutoff,
        contentHash: requireFixture(marketEvidenceContentHash(market)),
      },
      coverageProof: "incomplete",
      historyProof: "incomplete",
      status: "incomplete",
      targets: LIQUIDATION_EVIDENCE_ASSETS.map((asset) => ({
        asset,
        constituents:
          asset === "BTC"
            ? [
                {
                  providerSymbol: "BTCUSDT_PERP.A",
                  exchange: "Bybit",
                  symbolOnExchange: "BTCUSDT",
                  baseAsset: asset,
                  quoteAsset: "USDT",
                  isPerpetual: true,
                  marginType: "linear",
                  expireAt: 0,
                  notionalDenominatedIn: "USD",
                  observations: [{ timestamp, longUsd: "10", shortUsd: "20" }],
                },
              ]
            : [],
      })),
      diagnostics: [
        { code: "history-incomplete", operation: "fetch-liquidation-history" },
      ],
      ...overrides,
    }),
  );
}

export function liquidationFixtureRef(
  bundle: LiquidationEvidenceBundle,
  validForMs = MARKET_EVIDENCE_VALID_FOR_MS,
) {
  return requireFixture(
    createLiquidationEvidenceRef(
      bundle,
      fixtureCanonicalHash(bundle),
      validForMs,
    ),
  );
}

export function analyticsFixture(
  market: MarketEvidenceBundle = marketFixture(),
  overrides: Partial<Omit<CreateAnalyticsEvidenceBundleInput, "market">> = {},
) {
  return requireFixture(
    createAnalyticsEvidenceBundle({
      market,
      profile: {
        schemaVersion: "analytics-profile/v1",
        features: [
          {
            id: "btc-hourly-return",
            kind: "close-return",
            symbol: "BTCUSDT",
            interval: "1h",
            periods: 1,
            required: true,
          },
        ],
        externalEvidence: [],
      },
      ...overrides,
    }),
  );
}

/** #12 manifests use full bundle hashes and runId source IDs, unlike the embedded market ref. */
export function externalSourceFixtureRefs(
  market: MarketEvidenceBundle,
  liquidation?: LiquidationEvidenceBundle,
): readonly ExternalInputEvidenceRef[] {
  const runContext = {
    runId: market.runId,
    universeVersion: market.universeVersion,
    bundleCutoff: market.bundleCutoff,
  };
  return requireFixture(
    normalizeExternalInputEvidenceRefs([
      {
        kind: "market-evidence-bundle",
        schemaVersion: market.schemaVersion,
        producer: market.producer,
        sourceId: market.runId,
        contentHash: fixtureCanonicalHash(market),
        runContext,
      },
      ...(liquidation === undefined
        ? []
        : [
            {
              kind: "liquidation-evidence-bundle",
              schemaVersion: liquidation.schemaVersion,
              producer: liquidation.producer,
              sourceId: liquidation.runId,
              contentHash: fixtureCanonicalHash(liquidation),
              runContext: {
                runId: liquidation.runId,
                universeVersion: liquidation.marketEvidence.universeVersion,
                bundleCutoff: liquidation.bundleCutoff,
              },
            },
          ]),
    ]),
  );
}

/** Macro-only by default; pass declared source refs to exercise joined lineage. */
export function externalEvidenceFixture(
  family: ExternalEvidenceFamily = "market-regime-score",
  market: MarketEvidenceBundle = marketFixture(),
  options: {
    liquidation?: LiquidationEvidenceBundle;
    inputEvidenceRefs?: readonly ExternalInputEvidenceRef[];
    asOf?: string;
    generatedAt?: string;
    validForMs?: number;
  } = {},
) {
  const inputEvidenceRefs = requireFixture(
    normalizeExternalInputEvidenceRefs(
      options.inputEvidenceRefs ?? [
        {
          kind: "research-artifact",
          schemaVersion: "macro-input/v1",
          producer: "fixture/macro-provider",
          sourceId: "macro-fixture-1",
          contentHash: fixtureCanonicalHash({ macro: "neutral" }),
        },
      ],
    ),
  );
  const payload = {
    family,
    schemaVersion: EXTERNAL_EVIDENCE_SCHEMA_VERSIONS[family],
    modelVersion: EXTERNAL_EVIDENCE_MODEL_VERSIONS[family],
    provenance: {
      producer: "fixture/external-model",
      sourceId: "external-fixture-1",
      modelName: "fixture-model",
    },
    inputManifestHash: requireFixture(
      hashExternalInputManifest(inputEvidenceRefs),
    ),
    inputEvidenceRefs,
    ...(inputEvidenceRefs.some((ref) => ref.kind === "market-evidence-bundle")
      ? { marketEvidenceHash: fixtureCanonicalHash(market) }
      : {}),
    ...(inputEvidenceRefs.some(
      (ref) => ref.kind === "liquidation-evidence-bundle",
    ) && options.liquidation !== undefined
      ? { liquidationEvidenceHash: fixtureCanonicalHash(options.liquidation) }
      : {}),
    asOf: options.asOf ?? market.bundleCutoff,
    validForMs: options.validForMs ?? MARKET_EVIDENCE_VALID_FOR_MS,
    ...(options.generatedAt === undefined
      ? {}
      : { generatedAt: options.generatedAt }),
    confidence: fixtureDecimal("80"),
    ...(family === "trap"
      ? {
          trapType: "distribution-trap",
          reasons: ["failed breakout"],
          scenarioLikelihoods: {
            continuation: fixtureDecimal("0.1"),
            reversal: fixtureDecimal("0.3"),
            squeeze: fixtureDecimal("0.2"),
            range: fixtureDecimal("0.4"),
          },
          horizon: "24h",
          confirmationSignals: ["failed reclaim"],
          invalidationSignals: ["close above resistance"],
        }
      : {
          direction:
            family === "market-regime-score"
              ? "higher-is-healthier"
              : family === "early-warning-risk"
                ? "higher-is-warning"
                : "higher-is-stress",
          score: fixtureDecimal("50"),
        }),
  };
  const result = validateExternalRegimeEvidence(
    { ...payload, contentHash: fixtureCanonicalHash(payload) },
    family,
    requireFixture(createAnalyticsInputIdentity(market, options.liquidation)),
  );
  if (result.status !== "complete" || result.evidence === undefined) {
    throw new Error(
      `Invalid external fixture: ${result.reasonCodes.join(", ")}`,
    );
  }
  return result.evidence;
}
