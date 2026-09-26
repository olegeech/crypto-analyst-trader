import type { CanonicalArtifactEnvelope } from "../domain/identity/canonical-artifact.js";
import type { EvidenceRef } from "../domain/evidence/evidence-ref.js";
import type { LiquidationEvidenceBundle } from "../domain/liquidation/liquidation-evidence-bundle.js";
import type { MarketEvidenceBundle } from "../domain/market/market-evidence-bundle.js";
import type { Result } from "../domain/shared/result.js";

export interface LiquidationEvidenceCollectionRequest {
  readonly marketEvidence: MarketEvidenceBundle;
}

export interface LiquidationEvidenceCollectionResult {
  readonly bundle: LiquidationEvidenceBundle;
  readonly artifact: CanonicalArtifactEnvelope;
  readonly evidence: EvidenceRef;
}

export interface LiquidationEvidencePort {
  collect(
    request: LiquidationEvidenceCollectionRequest,
  ): Promise<Result<LiquidationEvidenceCollectionResult>>;
}
