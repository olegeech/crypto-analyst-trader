import process from "node:process";
import { pathToFileURL } from "node:url";

import { collectMarketEvidence } from "../src/application/market-evidence-collection.js";
import { encodeCanonicalArtifact } from "../src/domain/identity/canonical-artifact.js";
import { type MarketEvidenceBundle } from "../src/domain/market/market-evidence-bundle.js";
import { BybitPublicMarketClient } from "../src/adapters/bybit-v5/public-market-client.js";
import {
  BYBIT_PUBLIC_ORIGIN,
  createBybitPublicTransport,
} from "../src/adapters/bybit-v5/public-transport.js";

export interface PublicMarketSmokeSummary {
  readonly environment: "public-mainnet";
  readonly status: MarketEvidenceBundle["status"];
  readonly symbols: number;
  readonly ohlcvObservations: number;
  readonly fundingObservations: number;
  readonly openInterestObservations: number;
  readonly canonicalHash: string;
}

export function publicMarketConfig(
  environment: Record<string, string | undefined>,
): URL {
  if (environment.TRADER_ENV !== "public-mainnet") {
    throw new Error("TRADER_ENV must be public-mainnet");
  }
  const baseUrl = environment.BYBIT_API_BASE_URL ?? BYBIT_PUBLIC_ORIGIN;
  const parsed = new URL(baseUrl);
  if (parsed.origin !== BYBIT_PUBLIC_ORIGIN || parsed.pathname !== "/") {
    throw new Error(
      "BYBIT_API_BASE_URL must be the Bybit public mainnet base URL",
    );
  }
  return parsed;
}

function summaryFor(bundle: MarketEvidenceBundle): PublicMarketSmokeSummary {
  const ohlcvObservations = bundle.symbols.reduce(
    (total, symbol) =>
      total +
      symbol.ohlcv.reduce(
        (count, series) => count + series.observations.length,
        0,
      ),
    0,
  );
  const fundingObservations = bundle.symbols.reduce(
    (total, symbol) => total + symbol.funding.length,
    0,
  );
  const openInterestObservations = bundle.symbols.reduce(
    (total, symbol) =>
      total +
      symbol.openInterest.reduce(
        (count, series) => count + series.observations.length,
        0,
      ),
    0,
  );
  const encoded = encodeCanonicalArtifact("market-evidence-bundle", bundle);
  if (!encoded.ok) {
    throw new Error("public market smoke could not hash the validated bundle");
  }
  return Object.freeze({
    environment: "public-mainnet",
    status: bundle.status,
    symbols: bundle.symbols.length,
    ohlcvObservations,
    fundingObservations,
    openInterestObservations,
    canonicalHash: encoded.value.canonicalHash,
  });
}

export async function runPublicMarketSmoke({
  environment = process.env,
  request = fetch,
}: {
  readonly environment?: Record<string, string | undefined>;
  readonly request?: typeof fetch;
} = {}): Promise<PublicMarketSmokeSummary> {
  publicMarketConfig(environment);
  const transport = createBybitPublicTransport({ request });
  const client = new BybitPublicMarketClient({ transport });
  const result = await collectMarketEvidence(
    { runId: `public-smoke-${new Date().toISOString()}` },
    { reader: client },
  );
  if (!result.ok) {
    throw new Error(
      `public market smoke could not establish a coherent bundle (${result.error.code}: ${result.error.message})`,
    );
  }
  const summary = summaryFor(result.value);
  if (summary.status !== "complete") {
    throw new Error("public market smoke returned an incomplete bundle");
  }
  return summary;
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  try {
    const summary = await runPublicMarketSmoke();
    console.log(
      JSON.stringify(
        {
          environment: summary.environment,
          status: summary.status,
          symbols: summary.symbols,
          ohlcvObservations: summary.ohlcvObservations,
          fundingObservations: summary.fundingObservations,
          openInterestObservations: summary.openInterestObservations,
          canonicalHash: summary.canonicalHash,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(
      `Public market smoke failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    process.exitCode = 1;
  }
}
