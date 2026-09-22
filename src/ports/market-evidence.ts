export {
  MARKET_EVIDENCE_PRODUCER,
  MARKET_EVIDENCE_SCHEMA_VERSION,
  MARKET_EVIDENCE_SYMBOLS,
  MARKET_EVIDENCE_UNIVERSE_VERSION,
  createMarketEvidenceBundle,
  isCompleteMarketEvidenceBundle,
  type FundingObservation,
  type MarketEvidenceBundle,
  type MarketEvidenceSource,
  type MarketEvidenceStatus,
  type MarketEvidenceSymbol,
  type MarketInstrumentEvidence,
  type MarketInstrumentStatus,
  type MarketSeriesInterval,
  type MarketSymbolEvidence,
  type MarketTickerEvidence,
  type OhlcvObservation,
  type OhlcvSeries,
  type OpenInterestInterval,
  type OpenInterestObservation,
  type OpenInterestSeries,
} from "../domain/market/market-evidence-bundle.js";
import type { MarketEvidenceBundle } from "../domain/market/market-evidence-bundle.js";
import type { Result } from "../domain/shared/result.js";

export interface MarketEvidenceCollectionRequest {
  readonly runId: string;
}

export interface MarketEvidencePort {
  collect(
    request: MarketEvidenceCollectionRequest,
  ): Promise<Result<MarketEvidenceBundle>>;
}
export {
  createMarketEvidenceDiagnostic,
  parseMarketEvidenceDiagnostics,
  type MarketEvidenceBudgetState,
  type MarketEvidenceDiagnostic,
  type MarketEvidenceDiagnosticCode,
} from "../domain/market/market-evidence-diagnostics.js";
