import process from "node:process";
import { pathToFileURL } from "node:url";

import { COINALYZE_HISTORY_MAX_RANGE_SECONDS } from "../src/adapters/coinalyze/coinalyze-transport.js";
import { CoinalyzeClient } from "../src/adapters/coinalyze/coinalyze-client.js";
import { createMacOSKeychainSecretProvider } from "../src/adapters/macos-keychain-secret-provider.js";
import {
  LIQUIDATION_EVIDENCE_ASSETS,
  liquidationHistoryWindow,
  type LiquidationEvidenceDiagnosticInput,
  type LiquidationTargetAsset,
} from "../src/domain/liquidation/liquidation-evidence-bundle.js";
import {
  sampleLiquidationMarkets,
  selectEligibleLiquidationMarkets,
} from "../src/application/liquidation-market-selection.js";
import type { CoinalyzeLiquidationDataPort } from "../src/ports/coinalyze-liquidation-data.js";
import type { SecretProvider } from "../src/ports/secret-provider.js";

const SECRET_IDENTITY = Object.freeze({
  provider: "coinalyze",
  credential: "api-key",
});
const SAFE_DIAGNOSTICS = new Set([
  "catalogue-incomplete",
  "catalogue-unavailable",
  "duplicate-market",
  "history-incomplete",
  "history-unavailable",
  "invalid-catalogue",
  "invalid-observation",
  "missing-bucket",
  "no-eligible-markets",
  "provider-unavailable",
  "rate-limited",
  "response-budget-exhausted",
  "secret-unavailable",
]);

export interface CoinalyzeLiquidationSmokeSummary {
  readonly provider: "coinalyze";
  readonly mode: "adapter-characterization";
  readonly status: "observed" | "incomplete" | "failed";
  readonly configuredAssets: readonly LiquidationTargetAsset[];
  readonly catalogueProof: "complete" | "incomplete";
  readonly eligiblePerpetualMarkets: number;
  readonly sampledMarkets: number;
  readonly validHistoryResponses: number;
  readonly observedBuckets: number;
  readonly explicitZeroBuckets: number;
  readonly omittedBuckets: number;
  readonly diagnostics: readonly string[];
  readonly runScopedEvidence: false;
}

export interface CoinalyzeLiquidationSmokeOptions {
  readonly liveConfirmed: boolean;
  readonly secrets?: SecretProvider;
  readonly marketData?: CoinalyzeLiquidationDataPort;
  readonly now?: () => number;
}

function diagnosticCodes(
  diagnostics: readonly LiquidationEvidenceDiagnosticInput[],
): string[] {
  return diagnostics.map(({ code }) =>
    SAFE_DIAGNOSTICS.has(code) ? code : "provider-unavailable",
  );
}

function failedSummary(
  diagnostics: readonly LiquidationEvidenceDiagnosticInput[],
  catalogueProof: "complete" | "incomplete" = "incomplete",
): CoinalyzeLiquidationSmokeSummary {
  return Object.freeze({
    provider: "coinalyze",
    mode: "adapter-characterization",
    status: "failed",
    configuredAssets: LIQUIDATION_EVIDENCE_ASSETS,
    catalogueProof,
    eligiblePerpetualMarkets: 0,
    sampledMarkets: 0,
    validHistoryResponses: 0,
    observedBuckets: 0,
    explicitZeroBuckets: 0,
    omittedBuckets: 0,
    diagnostics: Object.freeze(diagnosticCodes(diagnostics)),
    runScopedEvidence: false,
  });
}

/**
 * Bounded adapter characterization only. Its local-time request range is not
 * planner evidence and this function never creates or returns a run bundle.
 */
export async function runCoinalyzeLiquidationSmoke({
  liveConfirmed,
  secrets = createMacOSKeychainSecretProvider(),
  marketData = new CoinalyzeClient(),
  now = Date.now,
}: CoinalyzeLiquidationSmokeOptions): Promise<CoinalyzeLiquidationSmokeSummary> {
  if (!liveConfirmed) {
    throw new Error("Explicit live confirmation is required (--live).");
  }
  const nowMs = now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    return failedSummary([
      { code: "provider-unavailable", operation: "fetch-liquidation-history" },
    ]);
  }

  const secretResult = await secrets.read(SECRET_IDENTITY).catch(() => null);
  const apiKey =
    secretResult?.kind === "available" &&
    secretResult.secret.length > 0 &&
    !/[\u0000-\u001f\u007f]/u.test(secretResult.secret)
      ? secretResult.secret
      : undefined;
  if (apiKey === undefined) {
    return failedSummary([
      { code: "secret-unavailable", operation: "discover-markets" },
    ]);
  }

  let catalogue;
  try {
    catalogue = await marketData.fetchFutureMarkets(apiKey);
  } catch {
    return failedSummary([
      { code: "catalogue-unavailable", operation: "discover-markets" },
    ]);
  }
  if (!Array.isArray(catalogue.markets)) {
    return failedSummary([
      { code: "invalid-catalogue", operation: "discover-markets" },
    ]);
  }

  const diagnostics = [...catalogue.diagnostics];
  const eligibleMarkets = selectEligibleLiquidationMarkets(
    catalogue.markets,
    nowMs,
  );
  const samples = sampleLiquidationMarkets(eligibleMarkets);
  const eligiblePerpetualMarkets = eligibleMarkets.length;
  if (samples.length < LIQUIDATION_EVIDENCE_ASSETS.length) {
    for (const asset of LIQUIDATION_EVIDENCE_ASSETS) {
      if (samples.some((market) => market.baseAsset === asset)) continue;
      diagnostics.push({
        code: "no-eligible-markets",
        operation: "discover-markets",
        asset,
      });
    }
  }

  if (samples.length === 0) {
    const hasTrustworthyCatalogue = catalogue.markets.length > 0;
    return Object.freeze({
      ...failedSummary(
        diagnostics.length > 0
          ? diagnostics
          : [
              {
                code: "catalogue-incomplete",
                operation: "discover-markets",
              },
            ],
        catalogue.complete ? "complete" : "incomplete",
      ),
      eligiblePerpetualMarkets,
      status: hasTrustworthyCatalogue ? "incomplete" : "failed",
    });
  }

  const buckets = liquidationHistoryWindow(nowMs).epochs;
  const fromMs = buckets[0];
  const toMs = buckets.at(-1);
  if (fromMs === undefined || toMs === undefined) {
    return failedSummary(
      [
        {
          code: "provider-unavailable",
          operation: "fetch-liquidation-history",
        },
      ],
      catalogue.complete ? "complete" : "incomplete",
    );
  }
  const from = Math.floor(fromMs / 1_000);
  const to = Math.floor(toMs / 1_000);
  if (to - from > COINALYZE_HISTORY_MAX_RANGE_SECONDS) {
    return failedSummary(
      [
        {
          code: "provider-unavailable",
          operation: "fetch-liquidation-history",
        },
      ],
      catalogue.complete ? "complete" : "incomplete",
    );
  }

  let history;
  try {
    history = await marketData.fetchLiquidationHistory(
      apiKey,
      samples.map(({ symbol }) => symbol),
      from,
      to,
    );
  } catch {
    return Object.freeze({
      ...failedSummary(
        [
          ...diagnostics,
          {
            code: "history-unavailable",
            operation: "fetch-liquidation-history",
          },
        ],
        catalogue.complete ? "complete" : "incomplete",
      ),
      eligiblePerpetualMarkets,
      sampledMarkets: samples.length,
    });
  }

  diagnostics.push(...history.diagnostics);
  const historyBySymbol = new Map(
    history.histories.map((item) => [item.symbol, item] as const),
  );
  let observedBuckets = 0;
  let explicitZeroBuckets = 0;
  let omittedBuckets = 0;
  let validHistoryResponses = 0;
  const expectedTimestamps = new Set(buckets);
  for (const sample of samples) {
    const item = historyBySymbol.get(sample.symbol);
    if (item === undefined) {
      diagnostics.push({
        code: "history-unavailable",
        operation: "fetch-liquidation-history",
        providerSymbol: sample.symbol,
      });
      omittedBuckets += buckets.length;
      continue;
    }
    let sampleHistoryValid = history.responseValid;
    const observed = new Set<number>();
    const validObservations = [] as (typeof item.observations)[number][];
    for (const observation of item.observations) {
      const timestamp = Date.parse(observation.timestamp);
      if (
        !Number.isFinite(timestamp) ||
        !expectedTimestamps.has(timestamp) ||
        observed.has(timestamp)
      ) {
        sampleHistoryValid = false;
        diagnostics.push({
          code: "invalid-observation",
          operation: "fetch-liquidation-history",
        });
        continue;
      }
      observed.add(timestamp);
      validObservations.push(observation);
    }
    observedBuckets += observed.size;
    omittedBuckets += buckets.filter((bucket) => !observed.has(bucket)).length;
    explicitZeroBuckets += validObservations.filter(
      ({ longUsd, shortUsd }) => longUsd === "0" && shortUsd === "0",
    ).length;
    if (sampleHistoryValid) validHistoryResponses += 1;
  }

  const allAssetsSampled =
    samples.length === LIQUIDATION_EVIDENCE_ASSETS.length;
  const status =
    catalogue.complete &&
    allAssetsSampled &&
    validHistoryResponses === samples.length
      ? "observed"
      : "incomplete";
  return Object.freeze({
    provider: "coinalyze",
    mode: "adapter-characterization",
    status,
    configuredAssets: LIQUIDATION_EVIDENCE_ASSETS,
    catalogueProof: catalogue.complete ? "complete" : "incomplete",
    eligiblePerpetualMarkets,
    sampledMarkets: samples.length,
    validHistoryResponses,
    observedBuckets,
    explicitZeroBuckets,
    omittedBuckets,
    diagnostics: Object.freeze(diagnosticCodes(diagnostics)),
    runScopedEvidence: false,
  });
}

function hasLiveFlag(args: readonly string[]): boolean {
  return args.length === 1 && args[0] === "--live";
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  if (!hasLiveFlag(process.argv.slice(2))) {
    console.error(
      "Live provider access is opt-in: npm run coinalyze:liquidation:smoke -- --live",
    );
    process.exitCode = 2;
  } else {
    try {
      const summary = await runCoinalyzeLiquidationSmoke({
        liveConfirmed: true,
      });
      console.log(JSON.stringify(summary, null, 2));
      if (summary.status !== "observed") process.exitCode = 1;
    } catch {
      console.error(
        "Coinalyze liquidation smoke failed (provider-unavailable).",
      );
      process.exitCode = 1;
    }
  }
}
