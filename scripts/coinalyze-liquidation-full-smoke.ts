import { randomUUID } from "node:crypto";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  collectLiquidationEvidence,
  type LiquidationEvidenceCollectionOptions,
} from "../src/application/liquidation-evidence-collection.js";
import {
  collectMarketEvidence,
  type MarketEvidenceCollectionReader,
} from "../src/application/market-evidence-collection.js";
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
import type { LiquidationEvidenceBundle } from "../src/domain/liquidation/liquidation-evidence-bundle.js";
import { LIQUIDATION_HISTORY_BUCKETS } from "../src/domain/liquidation/liquidation-evidence-bundle.js";
import type { MarketEvidenceBundle } from "../src/domain/market/market-evidence-bundle.js";
import { systemClock, type Clock } from "../src/domain/shared/time.js";
import type { SecretProvider } from "../src/ports/secret-provider.js";
import { publicMarketConfig } from "./public-market-smoke.js";

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

export interface CoinalyzeLiquidationFullSmokeSummary {
  readonly provider: "coinalyze";
  readonly mode: "full-collector";
  readonly environment: "public-mainnet";
  readonly status: LiquidationEvidenceBundle["status"];
  readonly coverageProof: LiquidationEvidenceBundle["coverageProof"];
  readonly historyProof: LiquidationEvidenceBundle["historyProof"];
  readonly eligibleConstituents: number;
  readonly constituentsWithHistory: number;
  readonly expectedHourlyBuckets: number;
  readonly observedHourlyBuckets: number;
  readonly historyRequestCount: number;
  readonly historyRequestSymbols: number;
  readonly maximumSymbolsPerHistoryRequest: number;
  readonly canonicalHash: string;
  readonly diagnostics: readonly string[];
}

export interface CoinalyzeLiquidationFullSmokeOptions {
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

function counts(bundle: LiquidationEvidenceBundle) {
  const constituents = bundle.targets.flatMap((target) => target.constituents);
  return {
    eligibleConstituents: constituents.length,
    constituentsWithHistory: constituents.filter(
      ({ observations }) => observations.length > 0,
    ).length,
    observedHourlyBuckets: constituents.reduce(
      (total, { observations }) => total + observations.length,
      0,
    ),
  };
}

function diagnosticCodes(bundle: LiquidationEvidenceBundle): string[] {
  return [
    ...new Set(
      bundle.diagnostics.map(({ code }) =>
        SAFE_DIAGNOSTICS.has(code) ? code : "provider-unavailable",
      ),
    ),
  ].sort();
}

function publicMarketReader(
  request: typeof fetch,
): MarketEvidenceCollectionReader {
  const transport: BybitPublicTransport = createBybitPublicTransport({
    request,
  });
  return new BybitPublicMarketClient({ transport });
}

export async function runCoinalyzeLiquidationFullSmoke({
  liveConfirmed,
  environment = process.env,
  request = fetch,
  secrets = createMacOSKeychainSecretProvider(),
  marketEvidenceReader,
  coinalyzeTransport,
  clock = systemClock,
}: CoinalyzeLiquidationFullSmokeOptions): Promise<CoinalyzeLiquidationFullSmokeSummary> {
  if (!liveConfirmed) {
    throw new Error("Explicit live confirmation is required (--live).");
  }
  publicMarketConfig(environment);

  const marketEvidenceResult = await collectMarketEvidence(
    { runId: `coinalyze-live-${randomUUID()}` },
    {
      reader: marketEvidenceReader ?? publicMarketReader(request),
      clock,
    },
  );
  if (
    !marketEvidenceResult.ok ||
    marketEvidenceResult.value.status !== "complete"
  ) {
    throw new Error(
      "Full Coinalyze smoke requires a complete, exchange-cutoff #11 market-evidence bundle.",
    );
  }
  const marketEvidence: MarketEvidenceBundle = marketEvidenceResult.value;

  const metrics: HistoryBatchMetrics = {
    requestCount: 0,
    requestSymbols: 0,
    maximumSymbolsPerRequest: 0,
  };
  const baseTransport = coinalyzeTransport ?? new CoinalyzeTransport();
  const marketData = new CoinalyzeClient({
    transport: observeHistoryBatches(baseTransport, metrics),
  });
  const collectionOptions: LiquidationEvidenceCollectionOptions = {
    marketData,
    secrets,
    clock,
  };
  const result = await collectLiquidationEvidence(
    { marketEvidence },
    collectionOptions,
  );
  if (!result.ok) {
    throw new Error(
      "Full Coinalyze collector could not create a run-bound canonical bundle.",
    );
  }

  const bundle = result.value.bundle;
  const bundleCounts = counts(bundle);
  const summary: CoinalyzeLiquidationFullSmokeSummary = Object.freeze({
    provider: "coinalyze",
    mode: "full-collector",
    environment: "public-mainnet",
    status: bundle.status,
    coverageProof: bundle.coverageProof,
    historyProof: bundle.historyProof,
    ...bundleCounts,
    expectedHourlyBuckets:
      bundleCounts.eligibleConstituents * LIQUIDATION_HISTORY_BUCKETS,
    observedHourlyBuckets: bundleCounts.observedHourlyBuckets,
    historyRequestCount: metrics.requestCount,
    historyRequestSymbols: metrics.requestSymbols,
    maximumSymbolsPerHistoryRequest: metrics.maximumSymbolsPerRequest,
    canonicalHash: result.value.artifact.canonicalHash,
    diagnostics: Object.freeze(diagnosticCodes(bundle)),
  });

  if (
    summary.maximumSymbolsPerHistoryRequest > COINALYZE_HISTORY_SYMBOL_LIMIT ||
    (summary.eligibleConstituents > 0 &&
      summary.historyRequestSymbols < summary.eligibleConstituents)
  ) {
    throw new Error(
      "Full Coinalyze smoke could not prove bounded history batching.",
    );
  }
  return summary;
}

const args = process.argv.slice(2);
const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  try {
    if (args.length !== 1 || args[0] !== "--live") {
      throw new Error(
        "Usage: npm run coinalyze:liquidation:full-smoke -- --live",
      );
    }
    const summary = await runCoinalyzeLiquidationFullSmoke({
      liveConfirmed: true,
    });
    console.log(JSON.stringify(summary, null, 2));
    if (summary.status !== "complete") process.exitCode = 1;
  } catch (error) {
    console.error(
      `Full Coinalyze smoke failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    process.exitCode = 1;
  }
}
