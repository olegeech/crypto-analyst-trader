import type {
  AccountEvidenceEnvironment,
  AccountPositionEvidence,
} from "../domain/account/account-evidence-bundle.js";
import type { AccountReadEnvelope } from "./account-evidence.js";
import type { ExchangeCredentials } from "./credential-provider.js";
import type { UtcTimestamp } from "../domain/shared/time.js";

export interface PortfolioRiskPositionObservation {
  readonly rows: readonly AccountPositionEvidence[];
  readonly observedAt: UtcTimestamp;
}

/** Narrow read-only seam for fresh, target-symbol leverage evidence. */
export interface PortfolioRiskEvidenceReadPort {
  readonly environment: AccountEvidenceEnvironment;
  readonly origin: string;
  readIdentity(): Promise<AccountReadEnvelope>;
  readTargetPositions(
    symbol: string,
  ): Promise<PortfolioRiskPositionObservation>;
  readExchangeTime(): Promise<UtcTimestamp>;
  requestCount(): number;
}

export interface PortfolioRiskEvidenceReaderFactoryInput {
  readonly environment: AccountEvidenceEnvironment;
  readonly credentials: Readonly<ExchangeCredentials>;
}

export type PortfolioRiskEvidenceReaderFactory = (
  input: PortfolioRiskEvidenceReaderFactoryInput,
) => PortfolioRiskEvidenceReadPort;
