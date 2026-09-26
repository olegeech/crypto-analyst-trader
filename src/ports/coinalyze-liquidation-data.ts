import type { LiquidationEvidenceDiagnosticInput } from "../domain/liquidation/liquidation-evidence-bundle.js";

export interface CoinalyzeMarket {
  readonly symbol: string;
  readonly exchange: string;
  readonly symbolOnExchange: string;
  readonly baseAsset: string;
  readonly quoteAsset: string;
  readonly isPerpetual: boolean;
  readonly marginType: string;
  readonly expireAt: number;
  readonly notionalDenominatedIn: string;
}

export interface CoinalyzeLiquidationObservation {
  readonly timestamp: string;
  readonly longUsd: string;
  readonly shortUsd: string;
}

export interface CoinalyzeMarketHistory {
  readonly symbol: string;
  readonly observations: readonly CoinalyzeLiquidationObservation[];
}

export interface CoinalyzeCatalogueResult {
  readonly markets: readonly CoinalyzeMarket[];
  readonly complete: boolean;
  readonly diagnostics: readonly LiquidationEvidenceDiagnosticInput[];
}

export interface CoinalyzeHistoryResult {
  readonly histories: readonly CoinalyzeMarketHistory[];
  /** Shape and identity validation only; required bucket completeness is separate. */
  readonly responseValid: boolean;
  readonly diagnostics: readonly LiquidationEvidenceDiagnosticInput[];
}

export interface CoinalyzeHistoryRequest {
  readonly symbols: readonly string[];
  readonly from: number;
  readonly to: number;
}

export interface CoinalyzeLiquidationDataPort {
  fetchFutureMarkets(apiKey: string): Promise<CoinalyzeCatalogueResult>;
  fetchLiquidationHistory(
    apiKey: string,
    symbols: readonly string[],
    from: number,
    to: number,
  ): Promise<CoinalyzeHistoryResult>;
}
