import type {
  LiquidationEvidenceBundleInput,
  LiquidationTargetAsset,
} from "../../src/domain/liquidation/liquidation-evidence-bundle.js";

export const LIQUIDATION_EVIDENCE_V1_GOLDEN_HASH =
  "sha256:b7d554ff6f4be6a60c2df70bb35d59200708a1c5dae7f72e86118b31d756bdbe" as const;

const ASSETS = [
  "BTC",
  "ETH",
  "SOL",
  "DOGE",
] as const satisfies readonly LiquidationTargetAsset[];
const HOUR_MS = 60 * 60 * 1_000;
const BUNDLE_CUTOFF = "2026-09-24T12:30:00.000Z";
const LAST_CLOSED_START = Date.parse("2026-09-24T11:00:00.000Z");

function observationTime(index: number): string {
  return new Date(LAST_CLOSED_START - (23 - index) * HOUR_MS).toISOString();
}

export function liquidationEvidenceV1GoldenInput(): LiquidationEvidenceBundleInput {
  return {
    runId: "run-45-1",
    schemaVersion: "liquidation-evidence/v1",
    producer: "crypto-analyst-trader/coinalyze-liquidation",
    provider: "coinalyze",
    policyVersion: "liquidation-market-aggregate/v1",
    collectionStartedAt: "2026-09-24T12:00:00.000Z",
    collectionEndedAt: "2026-09-24T12:01:00.000Z",
    bundleCutoff: BUNDLE_CUTOFF,
    marketEvidence: {
      runId: "run-45-1",
      universeVersion: "m1-universe/v1",
      bundleCutoff: BUNDLE_CUTOFF,
      contentHash: `sha256:${"a".repeat(64)}`,
    },
    coverageProof: "complete",
    historyProof: "complete",
    status: "complete",
    targets: ASSETS.map((asset) => ({
      asset,
      constituents: [
        {
          providerSymbol: `${asset}USDT_PERP.VENUE-1`,
          exchange: "venue-1",
          symbolOnExchange: `${asset}USDT`,
          baseAsset: asset,
          quoteAsset: "USDT",
          isPerpetual: true,
          marginType: "STABLE",
          expireAt: 0,
          notionalDenominatedIn: "USD",
          observations: Array.from({ length: 24 }, (_, index) => ({
            timestamp: observationTime(index),
            longUsd: String(index + 1),
            shortUsd: String((index + 1) * 2),
          })),
        },
      ],
    })),
    diagnostics: [],
  };
}
