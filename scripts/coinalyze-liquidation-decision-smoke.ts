import { randomUUID } from "node:crypto";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { CoinalyzeClient } from "../src/adapters/coinalyze/coinalyze-client.js";
import {
  CoinalyzeTransport,
  COINALYZE_HISTORY_SYMBOL_LIMIT,
  type CoinalyzeHistoryRequest,
} from "../src/adapters/coinalyze/coinalyze-transport.js";
import type { CoinalyzeTransportPort } from "../src/adapters/coinalyze/coinalyze-client.js";
import { createMacOSKeychainSecretProvider } from "../src/adapters/macos-keychain-secret-provider.js";
import { BybitPublicMarketClient } from "../src/adapters/bybit-v5/public-market-client.js";
import {
  createBybitPublicTransport,
  type BybitPublicTransport,
} from "../src/adapters/bybit-v5/public-transport.js";
import { createProvisionalM1Composition } from "../src/application/policies/provisional-m1.js";
import {
  collectLiquidationEvidence,
  type LiquidationEvidenceCollectionOptions,
} from "../src/application/liquidation-evidence-collection.js";
import {
  collectMarketEvidence,
  type MarketEvidenceCollectionReader,
} from "../src/application/market-evidence-collection.js";
import {
  LIQUIDATION_EVIDENCE_V3_SCHEMA_VERSION,
  type LiquidationEvidenceBundleV3,
} from "../src/domain/liquidation/liquidation-evidence-bundle.js";
import { summarizeLiquidationEvidenceBuckets } from "../src/domain/liquidation/liquidation-evidence-summary.js";
import { systemClock, type Clock } from "../src/domain/shared/time.js";
import type { SecretProvider } from "../src/ports/secret-provider.js";
import { publicMarketConfig } from "./public-market-smoke.js";

const DECISION_SMOKE_SYMBOL = "BTCUSDT";
const SAFE_DIAGNOSTICS = new Set([
  "catalogue-incomplete",
  "catalogue-unavailable",
  "duplicate-market",
  "history-incomplete",
  "history-unavailable",
  "incompatible-metadata",
  "invalid-catalogue",
  "invalid-observation",
  "missing-bucket",
  "no-eligible-markets",
  "provider-unavailable",
  "rate-limited",
  "response-budget-exhausted",
  "secret-unavailable",
]);

export interface CoinalyzeDecisionSmokeSummary {
  readonly provider: "coinalyze";
  readonly mode: "decision-v3-verification";
  readonly environment: "public-mainnet";
  readonly selectedAsset: string;
  readonly schemaVersion: typeof LIQUIDATION_EVIDENCE_V3_SCHEMA_VERSION;
  readonly policyVersion: string;
  readonly coveragePolicyVersion: string;
  readonly status: LiquidationEvidenceBundleV3["status"];
  readonly coverageProof: LiquidationEvidenceBundleV3["coverageProof"];
  readonly historyProof: LiquidationEvidenceBundleV3["historyProof"];
  readonly catalogueMarketCount: number;
  readonly selectedMarketCount: number;
  readonly excludedMarketCount: number;
  readonly catalogueHash: string;
  readonly selectedSetHash: string;
  readonly canonicalHash: string;
  readonly constituentsWithProviderRows: number;
  readonly constituentsWithResolvedGrid: number;
  readonly expectedHourlyBuckets: number;
  readonly resolvedHourlyBuckets: number;
  readonly providerExplicitBuckets: number;
  readonly providerExplicitZeroBuckets: number;
  readonly providerImpliedZeroBuckets: number;
  readonly unresolvedRequestedBuckets: number;
  readonly historyRequestCount: number;
  readonly historyRequestSymbols: number;
  readonly maximumSymbolsPerHistoryRequest: number;
  readonly diagnostics: readonly string[];
}

export interface CoinalyzeDecisionSmokeOptions {
  readonly liveConfirmed: boolean;
  readonly environment?: Record<string, string | undefined>;
  readonly request?: typeof fetch;
  readonly secrets?: SecretProvider;
  readonly marketEvidenceReader?: MarketEvidenceCollectionReader;
  readonly coinalyzeTransport?: CoinalyzeTransportPort;
  readonly clock?: Clock;
}

interface HistoryBatchMetrics {
  requestCount: number;
  requestSymbols: number;
  maximumSymbolsPerRequest: number;
}

function observeHistoryBatches(
  transport: CoinalyzeTransportPort,
  metrics: HistoryBatchMetrics,
): CoinalyzeTransportPort {
  return Object.freeze({
    getFutureMarkets: (apiKey: string) => transport.getFutureMarkets(apiKey),
    getLiquidationHistory: (
      apiKey: string,
      request: CoinalyzeHistoryRequest,
    ) => {
      metrics.requestCount += 1;
      metrics.requestSymbols += request.symbols.length;
      metrics.maximumSymbolsPerRequest = Math.max(
        metrics.maximumSymbolsPerRequest,
        request.symbols.length,
      );
      return transport.getLiquidationHistory(apiKey, request);
    },
  });
}

function publicMarketReader(
  request: typeof fetch,
): MarketEvidenceCollectionReader {
  const transport: BybitPublicTransport = createBybitPublicTransport({
    request,
  });
  return new BybitPublicMarketClient({ transport });
}

function sanitizedDiagnostics(bundle: LiquidationEvidenceBundleV3): string[] {
  return [
    ...new Set(
      bundle.diagnostics.map(({ code }) =>
        SAFE_DIAGNOSTICS.has(code) ? code : "provider-unavailable",
      ),
    ),
  ].sort();
}

export async function runCoinalyzeDecisionSmoke({
  liveConfirmed,
  environment = process.env,
  request = fetch,
  secrets = createMacOSKeychainSecretProvider(),
  marketEvidenceReader,
  coinalyzeTransport,
  clock = systemClock,
}: CoinalyzeDecisionSmokeOptions): Promise<CoinalyzeDecisionSmokeSummary> {
  if (!liveConfirmed) {
    throw new Error("Explicit live confirmation is required (--live).");
  }
  publicMarketConfig(environment);
  const composition = createProvisionalM1Composition({
    symbol: DECISION_SMOKE_SYMBOL,
    allocation: "10",
  });
  if (!composition.ok) {
    throw new Error("Trusted provisional M1 smoke composition is unavailable.");
  }

  const marketResult = await collectMarketEvidence(
    { runId: `coinalyze-decision-${randomUUID()}` },
    {
      reader: marketEvidenceReader ?? publicMarketReader(request),
      clock,
    },
  );
  if (!marketResult.ok || marketResult.value.status !== "complete") {
    throw new Error(
      "Decision smoke requires complete exchange-cutoff #11 market evidence.",
    );
  }

  const metrics: HistoryBatchMetrics = {
    requestCount: 0,
    requestSymbols: 0,
    maximumSymbolsPerRequest: 0,
  };
  const marketData = new CoinalyzeClient({
    transport: observeHistoryBatches(
      coinalyzeTransport ?? new CoinalyzeTransport(),
      metrics,
    ),
  });
  const collectionOptions: LiquidationEvidenceCollectionOptions = {
    marketData,
    secrets,
    clock,
  };
  const collected = await collectLiquidationEvidence(
    {
      scope: "decision",
      selectedAsset: composition.value.selectedAsset,
      marketEvidence: marketResult.value,
    },
    collectionOptions,
  );
  if (!collected.ok) {
    throw new Error(
      "Decision-scoped collector could not create its v3 artifact.",
    );
  }
  const bundle = collected.value.bundle;
  if (bundle.schemaVersion !== LIQUIDATION_EVIDENCE_V3_SCHEMA_VERSION) {
    throw new Error("Decision smoke requires liquidation-evidence/v3.");
  }
  const counts = summarizeLiquidationEvidenceBuckets(bundle);
  const summary: CoinalyzeDecisionSmokeSummary = Object.freeze({
    provider: "coinalyze",
    mode: "decision-v3-verification",
    environment: "public-mainnet",
    selectedAsset: bundle.selection.selectedAsset,
    schemaVersion: bundle.schemaVersion,
    policyVersion: bundle.policyVersion,
    coveragePolicyVersion: bundle.selection.coveragePolicyVersion,
    status: bundle.status,
    coverageProof: bundle.coverageProof,
    historyProof: bundle.historyProof,
    catalogueMarketCount: bundle.selection.catalogueMarkets.length,
    selectedMarketCount: bundle.targets[0]?.constituents.length ?? 0,
    excludedMarketCount: bundle.selection.exclusions.length,
    catalogueHash: bundle.selection.catalogueHash,
    selectedSetHash: bundle.selection.selectedSetHash,
    canonicalHash: collected.value.artifact.canonicalHash,
    constituentsWithProviderRows: counts.constituentsWithProviderRows,
    constituentsWithResolvedGrid: counts.constituentsWithResolvedGrid,
    expectedHourlyBuckets: counts.expectedHourlyBuckets,
    resolvedHourlyBuckets: counts.resolvedHourlyBuckets,
    providerExplicitBuckets: counts.providerExplicitBuckets,
    providerExplicitZeroBuckets: counts.providerExplicitZeroBuckets,
    providerImpliedZeroBuckets: counts.providerImpliedZeroBuckets,
    unresolvedRequestedBuckets: counts.unresolvedRequestedBuckets,
    historyRequestCount: metrics.requestCount,
    historyRequestSymbols: metrics.requestSymbols,
    maximumSymbolsPerHistoryRequest: metrics.maximumSymbolsPerRequest,
    diagnostics: Object.freeze(sanitizedDiagnostics(bundle)),
  });
  if (
    summary.maximumSymbolsPerHistoryRequest > COINALYZE_HISTORY_SYMBOL_LIMIT
  ) {
    throw new Error("Decision smoke could not prove bounded history batching.");
  }
  return summary;
}

const args = process.argv.slice(2);
const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  try {
    if (args.length !== 1 || args[0] !== "--live") {
      throw new Error(
        "Usage: npm run coinalyze:liquidation:decision-smoke -- --live",
      );
    }
    const summary = await runCoinalyzeDecisionSmoke({ liveConfirmed: true });
    console.log(JSON.stringify(summary, null, 2));
    if (summary.status !== "complete") process.exitCode = 1;
  } catch (error) {
    console.error(
      `Coinalyze decision smoke failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    process.exitCode = 1;
  }
}
