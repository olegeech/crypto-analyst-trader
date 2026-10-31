import type { PlanHash } from "../domain/identity/canonical-serialization.js";
import type { UtcTimestamp } from "../domain/shared/time.js";

interface OperatorMainnetTestCreateAuthorizationBindingBase {
  readonly kind: "approval" | "trade-command";
  readonly operation: "CREATE";
  readonly environment: "mainnet";
  readonly planHash: PlanHash;
  readonly sourceId: string;
  readonly accountIdentityHash: string;
  readonly symbol: string;
  readonly clientOrderId: string;
  readonly exactPayloadHash: PlanHash;
  readonly runId: string;
  readonly expiresAt: UtcTimestamp;
}

export type OperatorMainnetTestCreateAuthorizationBinding =
  | (OperatorMainnetTestCreateAuthorizationBindingBase & {
      readonly kind: "approval";
      readonly approvalHash: PlanHash;
      readonly commandId?: never;
      readonly receiptHash?: never;
      readonly commandBindingHash?: never;
    })
  | (OperatorMainnetTestCreateAuthorizationBindingBase & {
      readonly kind: "trade-command";
      readonly approvalHash?: never;
      readonly commandId: string;
      readonly receiptHash: PlanHash;
      readonly commandBindingHash: PlanHash;
    });

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
