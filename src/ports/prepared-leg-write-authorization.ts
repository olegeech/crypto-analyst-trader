import type { PlanHash } from "../domain/identity/canonical-serialization.js";
import type { UtcTimestamp } from "../domain/shared/time.js";

export type PreparedLegWriteOperation = "create" | "cancel";

/** Opaque runtime object; structural/serialized lookalikes are not admitted. */
export type PreparedLegWriteCapability = object;

export interface PreparedLegWriteAuthorizationBinding {
  readonly operation: PreparedLegWriteOperation;
  readonly environment: "mainnet";
  readonly accountIdentityHash: string;
  readonly preparedHash: PlanHash;
  readonly approvalHash?: PlanHash;
  readonly sourceId: string;
  readonly symbol: string;
  readonly legId: string;
  readonly leaseOwnerRunId: string;
  readonly leaseEpoch: number;
  readonly clientOrderId: string;
  readonly exchangeOrderId?: string;
  readonly zeroFillProofHash?: PlanHash;
  readonly proofObservedAt?: UtcTimestamp;
}

export interface PreparedLegWriteAuthorizationPort {
  authorize(
    binding: PreparedLegWriteAuthorizationBinding,
  ): Promise<PreparedLegWriteCapability | undefined>;
  isAdmitted(
    capability: PreparedLegWriteCapability,
    binding: PreparedLegWriteAuthorizationBinding,
  ): boolean;
}
