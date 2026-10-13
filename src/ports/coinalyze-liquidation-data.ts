import type { LiquidationEvidenceDiagnosticInput } from "../domain/liquidation/liquidation-evidence-bundle.js";
import type { LiquidationCatalogueMarket } from "../domain/liquidation/liquidation-evidence-v3.js";

export type CoinalyzeMarket = LiquidationCatalogueMarket;

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
  /** Safe unique rows for legacy consumers. */
  readonly markets: readonly CoinalyzeMarket[];
  /**
   * All individually valid normalized rows, including duplicate identities.
   * Decision v3 hashes this snapshot and independently excludes ambiguity.
   */
  readonly catalogueSnapshot?: readonly CoinalyzeMarket[];
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
