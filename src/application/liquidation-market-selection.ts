import {
  LIQUIDATION_EVIDENCE_ASSETS,
  type LiquidationTargetAsset,
} from "../domain/liquidation/liquidation-evidence-bundle.js";
import type { CoinalyzeMarket } from "../ports/coinalyze-liquidation-data.js";

export interface SelectedLiquidationMarket extends CoinalyzeMarket {
  readonly asset: LiquidationTargetAsset;
}

export function selectEligibleLiquidationMarkets(
  markets: readonly CoinalyzeMarket[],
  cutoffMs: number,
): readonly SelectedLiquidationMarket[] {
  const cutoffSeconds = Math.floor(cutoffMs / 1_000);
  return Object.freeze(
    markets
      .filter(
        (market) =>
          market.isPerpetual &&
          LIQUIDATION_EVIDENCE_ASSETS.some(
            (asset) => asset === market.baseAsset,
          ) &&
          (market.expireAt === 0 || market.expireAt > cutoffSeconds),
      )
      .map((market) =>
        Object.freeze({
          ...market,
          asset: market.baseAsset as LiquidationTargetAsset,
        }),
      )
      .sort((left, right) => left.symbol.localeCompare(right.symbol)),
  );
}

export function sampleLiquidationMarkets(
  eligibleMarkets: readonly SelectedLiquidationMarket[],
): readonly SelectedLiquidationMarket[] {
  const firstByAsset = new Map<
    LiquidationTargetAsset,
    SelectedLiquidationMarket
  >();
  for (const market of eligibleMarkets) {
    if (!firstByAsset.has(market.asset)) firstByAsset.set(market.asset, market);
  }
  return Object.freeze(
    LIQUIDATION_EVIDENCE_ASSETS.flatMap((asset) => {
      const market = firstByAsset.get(asset);
      return market === undefined ? [] : [market];
    }),
  );
}
