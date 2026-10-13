export const LIQUIDATION_EVIDENCE_ASSETS = Object.freeze([
  "BTC",
  "ETH",
  "SOL",
  "DOGE",
] as const);

export type LiquidationTargetAsset =
  (typeof LIQUIDATION_EVIDENCE_ASSETS)[number];

export function isLiquidationTargetAsset(
  value: unknown,
): value is LiquidationTargetAsset {
  return (
    typeof value === "string" &&
    LIQUIDATION_EVIDENCE_ASSETS.some((asset) => asset === value)
  );
}

export const LIQUIDATION_EVIDENCE_PRODUCER =
  "crypto-analyst-trader/coinalyze-liquidation" as const;
export const LIQUIDATION_EVIDENCE_V2_PROVIDER_SEMANTIC_IDENTITY =
  "coinalyze-sparse-zero/v1" as const;
