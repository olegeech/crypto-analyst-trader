import type { PlanHash } from "../domain/identity/canonical-serialization.js";
import type { UtcTimestamp } from "../domain/shared/time.js";

export interface OperatorMainnetTestCreateAuthorizationBinding {
  readonly operation: "CREATE";
  readonly environment: "mainnet";
  readonly planHash: PlanHash;
  readonly approvalHash: PlanHash;
  readonly sourceId: string;
  readonly accountIdentityHash: string;
  readonly symbol: string;
  readonly clientOrderId: string;
  readonly exactPayloadHash: PlanHash;
  readonly leaseOwnerRunId: string;
  readonly leaseEpoch: number;
  readonly expiresAt: UtcTimestamp;
}

/** Opaque by object identity. A serialized lookalike is never a capability. */
export type OperatorMainnetTestCreateCapability = object;

/** Issued only by the private operator composition; consumed once at dispatch. */
export interface OperatorMainnetTestAuthorizationPort {
  issue(
    binding: OperatorMainnetTestCreateAuthorizationBinding,
  ): Promise<OperatorMainnetTestCreateCapability | undefined>;
  consume(
    capability: OperatorMainnetTestCreateCapability,
    binding: OperatorMainnetTestCreateAuthorizationBinding,
    now: UtcTimestamp,
  ): boolean;
}
