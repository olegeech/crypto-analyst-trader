import type { CanonicalArtifactEnvelope } from "../domain/identity/canonical-artifact.js";
import type { EvidenceRef } from "../domain/evidence/evidence-ref.js";
import type { VersionedLiquidationEvidenceBundle } from "../domain/liquidation/liquidation-evidence-bundle.js";
import type { LiquidationTargetAsset } from "../domain/liquidation/liquidation-evidence-bundle.js";
import type { MarketEvidenceBundle } from "../domain/market/market-evidence-bundle.js";
import type { Result } from "../domain/shared/result.js";

export type LiquidationEvidenceCollectionRequest =
  | {
      readonly scope: "decision";
      readonly selectedAsset: LiquidationTargetAsset;
      readonly marketEvidence: MarketEvidenceBundle;
    }
  | {
      /** Explicit compatibility path for provider characterization only. */
      readonly scope: "legacy-diagnostic";
      readonly marketEvidence: MarketEvidenceBundle;
    };

export interface LiquidationEvidenceCollectionResult {
  readonly bundle: VersionedLiquidationEvidenceBundle;
  readonly artifact: CanonicalArtifactEnvelope;
  readonly evidence: EvidenceRef;
}

export interface LiquidationEvidencePort {
  collect(
    request: LiquidationEvidenceCollectionRequest,
  ): Promise<Result<LiquidationEvidenceCollectionResult>>;
}
