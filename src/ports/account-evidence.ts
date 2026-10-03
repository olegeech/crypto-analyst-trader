import type { AccountEvidenceFailureCode } from "../domain/account/account-evidence-diagnostics.js";
import type { AccountEvidencePartition } from "../domain/account/account-evidence-policy.js";
import type {
  AccountEndpointObservation,
  AccountEvidenceCoverageEntry,
} from "../domain/account/account-evidence-bundle.js";

/** Source envelopes stay collection-local. Only mapped allowlisted facts enter artifacts. */
export interface AccountReadEnvelope {
  readonly result: Record<string, unknown>;
  readonly time?: number;
}
export interface AccountPartitionRead {
  readonly responses: readonly AccountReadEnvelope[];
  readonly coverage: AccountEvidenceCoverageEntry;
  readonly observation: AccountEndpointObservation | null;
}
export interface AccountReadWindow {
  readonly from: number;
  readonly to: number;
}
export interface AccountEvidenceReadPort {
  readIdentity(): Promise<AccountReadEnvelope>;
  readExchangeTime(): Promise<number>;
  readPartition(
    partition: AccountEvidencePartition,
    window?: AccountReadWindow,
  ): Promise<AccountPartitionRead>;
  readOptionInstrument(symbol: string): Promise<AccountReadEnvelope>;
}
export interface AccountReadFailure {
  readonly code: AccountEvidenceFailureCode;
}
