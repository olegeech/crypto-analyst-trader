import type { AccountEvidenceEnvironment } from "../domain/account/account-evidence-bundle.js";
import type { PortfolioRiskEvidence } from "../domain/risk/portfolio-risk-evidence.js";
import type { Result } from "../domain/shared/result.js";

export interface SupplementalRiskEvidenceRequest {
  readonly environment: AccountEvidenceEnvironment;
  readonly accountIdentityHash: string;
  readonly accountEvidenceHash: string;
  readonly symbol: string;
}

/** Authenticated, read-only provider boundary for explicit missing risk facts. */
export interface RiskEvidencePort {
  readTargetLeverage(
    request: SupplementalRiskEvidenceRequest,
  ): Promise<Result<PortfolioRiskEvidence>>;
}
