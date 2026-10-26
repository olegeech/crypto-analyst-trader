import type {
  OperatorMainnetTestApproval,
  OperatorMainnetTestPlan,
} from "../domain/execution/operator-mainnet-test-plan.js";
import type { PlanHash } from "../domain/identity/canonical-serialization.js";
import type { Result } from "../domain/shared/result.js";
import type { UtcTimestamp } from "../domain/shared/time.js";
import type { HaltState, PersistenceScope } from "./persistence.js";

export type OperatorMainnetTestAttemptOutcome =
  "accepted" | "rejected" | "ambiguous";

export type OperatorMainnetTestLifecycleOutcome =
  | "ENTRY_TP_PROVEN"
  | "TP_LIFECYCLE_PASS"
  | "NOT_EXERCISED"
  | "PARTIAL_EVIDENCE"
  | "UNKNOWN"
  | "MANUAL_CLEANUP";

export type OperatorMainnetTestCleanupStatus =
  "pending" | "verified-clean" | "unknown";

export type OperatorMainnetTestManualAction =
  "entry-remainder-cancelled" | "position-closed" | "other";

export interface OperatorMainnetTestSourceRecord {
  readonly sourceId: string;
  readonly scope: PersistenceScope;
  readonly planHash: PlanHash;
  readonly planArtifactId: string;
  readonly approvalHash: PlanHash;
  readonly approvalArtifactId: string;
  readonly clientOrderId: string;
  readonly payloadJson: string;
  readonly payloadHash: PlanHash;
  readonly createdAt: UtcTimestamp;
}

export interface OperatorMainnetTestIntentRecord {
  readonly writeIntentId: string;
  readonly sourceId: string;
  readonly operation: "CREATE";
  readonly runId: string;
  readonly canonicalJson: string;
  readonly canonicalHash: PlanHash;
  readonly preparedAt: UtcTimestamp;
}

export interface OperatorMainnetTestAttemptRecord {
  readonly attemptId: string;
  readonly writeIntentId: string;
  readonly outcome: OperatorMainnetTestAttemptOutcome;
  readonly exchangeOrderId?: string;
  readonly providerReasonCode?: string;
  readonly canonicalJson: string;
  readonly canonicalHash: PlanHash;
  readonly recordedAt: UtcTimestamp;
}

export interface OperatorMainnetTestReconciliationRecord {
  readonly reconciliationId: string;
  readonly sourceId: string;
  readonly revision: number;
  readonly lifecycleOutcome: OperatorMainnetTestLifecycleOutcome;
  readonly cleanupStatus: OperatorMainnetTestCleanupStatus;
  readonly canonicalJson: string;
  readonly canonicalHash: PlanHash;
  readonly observedAt: UtcTimestamp;
}

export interface OperatorMainnetTestManualActionRecord {
  readonly actionId: string;
  readonly sourceId: string;
  readonly revision: number;
  readonly action: OperatorMainnetTestManualAction;
  readonly canonicalJson: string;
  readonly canonicalHash: PlanHash;
  readonly declaredAt: UtcTimestamp;
}

export interface OperatorMainnetTestSnapshot {
  readonly source: OperatorMainnetTestSourceRecord;
  readonly plan: OperatorMainnetTestPlan;
  readonly approval: OperatorMainnetTestApproval;
  readonly intent: OperatorMainnetTestIntentRecord;
  readonly attempt?: OperatorMainnetTestAttemptRecord;
  readonly reconciliations: readonly OperatorMainnetTestReconciliationRecord[];
  readonly manualActions: readonly OperatorMainnetTestManualActionRecord[];
  readonly halt: HaltState;
}

export interface PrepareOperatorMainnetTestCreateRequest {
  readonly runId: string;
  readonly plan: OperatorMainnetTestPlan;
  readonly approval: OperatorMainnetTestApproval;
  /** Exact UTF-8 bytes passed to the Bybit create transport. */
  readonly payloadJson: string;
  readonly payloadHash: PlanHash;
  readonly preparedAt: UtcTimestamp;
}

export interface RecordOperatorMainnetTestAttemptRequest {
  readonly runId: string;
  readonly sourceId: string;
  readonly attemptId: string;
  readonly outcome: OperatorMainnetTestAttemptOutcome;
  readonly exchangeOrderId?: string;
  readonly providerReasonCode?: string;
  readonly recordedAt: UtcTimestamp;
}

export interface AppendOperatorMainnetTestReconciliationRequest {
  readonly sourceId: string;
  readonly lifecycleOutcome: OperatorMainnetTestLifecycleOutcome;
  readonly cleanupStatus: OperatorMainnetTestCleanupStatus;
  readonly evidence: unknown;
  readonly observedAt: UtcTimestamp;
}

export interface AppendOperatorMainnetTestManualActionRequest {
  readonly sourceId: string;
  readonly action: OperatorMainnetTestManualAction;
  readonly provenance: unknown;
  readonly declaredAt: UtcTimestamp;
}

/**
 * Source-native, append-only journal for the supervised operator experiment.
 * The pending-source check is repeated inside prepareCreateIntent's write
 * transaction to close the gap between admission and durable intent.
 */
export interface OperatorMainnetTestPersistencePort {
  /** Keep a prepared, not-yet-approved plan in the scoped canonical artifact store. */
  persistPreparedPlan(plan: OperatorMainnetTestPlan): Result<void>;
  readPreparedPlan(
    planHash: PlanHash,
  ): Result<OperatorMainnetTestPlan | undefined>;
  readOperatorMainnetTestSource(
    sourceId: string,
  ): Result<OperatorMainnetTestSnapshot | undefined>;
  findPendingOperatorMainnetTestSource(): Result<
    OperatorMainnetTestSourceRecord | undefined
  >;
  prepareCreateIntent(
    request: PrepareOperatorMainnetTestCreateRequest,
  ): Result<OperatorMainnetTestSnapshot>;
  /** Persist an attempt; only ambiguous delivery raises a source-linked HALT. */
  recordAttempt(
    request: RecordOperatorMainnetTestAttemptRequest,
  ): Result<OperatorMainnetTestSnapshot>;
  raiseHalt(
    sourceId: string,
    reason: string,
    at: UtcTimestamp,
  ): Result<HaltState>;
  appendReconciliation(
    request: AppendOperatorMainnetTestReconciliationRequest,
  ): Result<OperatorMainnetTestReconciliationRecord>;
  appendManualAction(
    request: AppendOperatorMainnetTestManualActionRequest,
  ): Result<OperatorMainnetTestManualActionRecord>;
}
