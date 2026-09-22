import type {
  ArtifactKind,
  CanonicalArtifactEnvelope,
} from "../domain/identity/canonical-artifact.js";
import type { Approval } from "../domain/execution/approval.js";
import type { ClearanceEvidence } from "../domain/execution/clearance-evidence.js";
import type { ExecutionAttempt } from "../domain/execution/execution-attempt.js";
import type {
  IdentityBinding,
  IdentityBindingCandidateInput,
} from "../domain/execution/identity-binding.js";
import type { ReconciliationResult } from "../domain/execution/reconciliation.js";
import type { ExecutionPlan } from "../domain/planning/execution-plan.js";
import type { PlanHash } from "../domain/identity/canonical-serialization.js";
import type { DomainError } from "../domain/shared/errors.js";
import type { Result } from "../domain/shared/result.js";
import type { UtcTimestamp } from "../domain/shared/time.js";

export type PersistenceEnvironment = "demo" | "testnet" | "mainnet";

export interface PersistenceScope {
  readonly exchange: string;
  readonly environment: PersistenceEnvironment;
  readonly accountId: string;
  readonly category: string;
  readonly positionMode: "one-way" | "hedge";
}

export interface PersistedArtifact {
  readonly artifactId: string;
  readonly artifactKind: ArtifactKind;
  readonly envelope: CanonicalArtifactEnvelope;
  readonly materialHash?: PlanHash;
}

export interface LineageRecord {
  readonly lineageId: string;
  readonly runId: string;
  readonly planId: string;
  readonly planHash: PlanHash;
  readonly scope: PersistenceScope;
  readonly createdAt: UtcTimestamp;
}

export interface OwnedIntentRecord {
  readonly intentRecordId: string;
  readonly lineageId: string;
  readonly intentId: string;
  readonly planHash: PlanHash;
  readonly clientOrderId: string;
  readonly preparedAt: UtcTimestamp;
}

export interface AttemptRecord {
  readonly lineageId: string;
  readonly attempt: ExecutionAttempt;
  readonly dispatchedAt: UtcTimestamp;
}

export interface ReconciliationRecord {
  readonly lineageId: string;
  readonly result: ReconciliationResult;
  readonly recordedAt: UtcTimestamp;
}

export type PersistenceFactKind =
  | "fill"
  | "fee"
  | "funding"
  | "ledger-entry"
  | "exchange-observation"
  | "reconciliation"
  | "audit";

export interface IngestionFact {
  /** The generated durable identifier is populated by persistence reads. */
  readonly factId?: string;
  readonly factKind: PersistenceFactKind;
  readonly eventIdentity: string;
  readonly scope: PersistenceScope;
  readonly observedAt: UtcTimestamp;
  readonly canonicalHash: string;
  readonly artifact: PersistedArtifact;
  readonly observationRevision?: string;
  readonly linkedFactId?: string;
  readonly adjustmentReason?: string;
}

export interface CheckpointState {
  readonly stream: string;
  readonly scope: PersistenceScope;
  readonly cursor?: string;
  readonly observedThrough?: UtcTimestamp;
  readonly overlapFrom?: UtcTimestamp;
  readonly updatedAt: UtcTimestamp;
  readonly revision: number;
}

export interface LeaseState {
  readonly scope: PersistenceScope;
  readonly ownerRunId: string;
  readonly epoch: number;
  readonly acquiredAt: UtcTimestamp;
  readonly expiresAt: UtcTimestamp;
  readonly reconciliationRequired: boolean;
}

export interface LeaseAuthority {
  readonly ownerRunId: string;
  readonly epoch: number;
}

export interface HaltState {
  readonly scope: PersistenceScope;
  readonly active: boolean;
  readonly revision: number;
  readonly reason?: string;
  readonly raisedAt?: UtcTimestamp;
  readonly reconciliationRequired: boolean;
}

export interface LeaseRequest {
  readonly scope: PersistenceScope;
  readonly ownerRunId: string;
  readonly now: UtcTimestamp;
  readonly ttlMs: number;
}

export interface PrepareLineageRequest {
  readonly scope: PersistenceScope;
  readonly runId: string;
  readonly plan: ExecutionPlan;
  readonly approval: Approval;
  readonly preparedAt: UtcTimestamp;
}

export interface PrepareIntentRequest {
  readonly authority: LeaseAuthority;
  readonly lineageId: string;
  readonly intentId: string;
  readonly planHash: PlanHash;
  readonly clientOrderId: string;
  readonly now: UtcTimestamp;
  readonly preparedAt: UtcTimestamp;
}

export interface AppendAttemptRequest {
  readonly authority: LeaseAuthority;
  readonly lineageId: string;
  readonly attempt: ExecutionAttempt;
  readonly dispatchedAt: UtcTimestamp;
}

export interface AppendReconciliationRequest {
  readonly authority: LeaseAuthority;
  readonly lineageId: string;
  readonly result: ReconciliationResult;
  readonly recordedAt: UtcTimestamp;
}

export interface CheckpointUpdateRequest {
  readonly authority: LeaseAuthority;
  readonly checkpoint: Omit<CheckpointState, "revision">;
  readonly expectedRevision: number;
}

export interface HaltClearRequest {
  readonly authority: LeaseAuthority;
  readonly evidence: ClearanceEvidence;
  readonly expectedHaltRevision: number;
}

export type IdentityBindingRecord = IdentityBinding;

export interface AppendIdentityBindingRequest {
  readonly authority: LeaseAuthority;
  readonly lineageId: string;
  readonly attemptId: string;
  readonly planHash?: PlanHash;
  readonly intentId?: string;
  readonly clientOrderId?: string;
  readonly candidates?: readonly IdentityBindingCandidateInput[];
  readonly candidate?: IdentityBindingCandidateInput;
  readonly boundAt: UtcTimestamp;
}

export type IdentityBindingOutcome =
  | {
      readonly status: "BOUND";
      readonly binding: IdentityBindingRecord;
      readonly idempotent: boolean;
    }
  | {
      readonly status: "UNRESOLVED";
      readonly binding?: never;
      readonly idempotent: false;
    };

export interface PersistenceDiagnostics {
  readonly databasePath: string;
  readonly environment: PersistenceEnvironment;
  readonly nodeVersion: string;
  readonly sqliteVersion: string;
  readonly schemaVersion: number;
  readonly scope: PersistenceScope;
}

export interface PersistenceRunSnapshot {
  readonly lineage: LineageRecord;
  readonly plan: ExecutionPlan;
  readonly approval: Approval;
  readonly ownedIntents: readonly OwnedIntentRecord[];
  readonly attempts: readonly AttemptRecord[];
  readonly identityBindings: readonly IdentityBindingRecord[];
  readonly reconciliations: readonly ReconciliationRecord[];
  readonly lease?: LeaseState;
  readonly halt: HaltState;
}

export interface PersistenceScopeSnapshot {
  readonly scope: PersistenceScope;
  readonly accountingFacts: readonly IngestionFact[];
  readonly lease?: LeaseState;
  readonly halt: HaltState;
}

export type PersistenceRecoveryCategory =
  | "integrity"
  | "schema"
  | "runtime"
  | "environment"
  | "contention"
  | "lease-held"
  | "lease-lost"
  | "duplicate-conflict"
  | "halt"
  | "unresolved"
  | "input";

export type PersistenceRecoveryAction =
  | "inspect-schema"
  | "run-supported-runtime"
  | "open-selected-environment"
  | "retry-after-contention"
  | "wait-for-lease"
  | "reconcile-before-reacquire"
  | "preserve-and-reconcile"
  | "reconcile-and-clear-halt"
  | "reconcile-before-exposure"
  | "inspect-and-correct-input";

export type PersistenceRecoveryEvidence =
  | "schema-version"
  | "migration-result"
  | "node-version"
  | "sqlite-version"
  | "environment"
  | "database-identity"
  | "scope"
  | "expires-at"
  | "owner-run-id"
  | "epoch"
  | "identity"
  | "canonical-hash"
  | "halt-revision"
  | "lineage-revision"
  | "reconciliation-revision"
  | "owned-intent"
  | "attempt"
  | "reconciliation-result"
  | "typed-error-code";

export type PersistenceDiagnosticField = "code" | "scope" | "expiresAt";

export interface PersistenceRecoveryMetadata {
  readonly category: PersistenceRecoveryCategory;
  readonly canRead: boolean;
  readonly canWrite: boolean;
  readonly canAppendReconciliation: boolean;
  readonly retryable: boolean;
  readonly nextAction: PersistenceRecoveryAction;
  readonly requiredEvidence: readonly PersistenceRecoveryEvidence[];
  readonly redactedDiagnosticFields: readonly PersistenceDiagnosticField[];
}

export function persistenceRecoveryMetadata(
  error: DomainError,
): PersistenceRecoveryMetadata {
  switch (error.code) {
    case "PERSISTENCE_SCHEMA":
      return {
        category: "schema",
        canRead: false,
        canWrite: false,
        canAppendReconciliation: false,
        retryable: false,
        nextAction: "inspect-schema",
        requiredEvidence: ["schema-version", "migration-result"],
        redactedDiagnosticFields: ["code"],
      };
    case "PERSISTENCE_RUNTIME":
      return {
        category: "runtime",
        canRead: false,
        canWrite: false,
        canAppendReconciliation: false,
        retryable: false,
        nextAction: "run-supported-runtime",
        requiredEvidence: ["node-version", "sqlite-version"],
        redactedDiagnosticFields: ["code"],
      };
    case "PERSISTENCE_ENVIRONMENT":
      return {
        category: "environment",
        canRead: false,
        canWrite: false,
        canAppendReconciliation: false,
        retryable: false,
        nextAction: "open-selected-environment",
        requiredEvidence: ["environment", "database-identity"],
        redactedDiagnosticFields: ["code"],
      };
    case "PERSISTENCE_BUSY":
    case "CHECKPOINT_STALE":
      return {
        category: "contention",
        canRead: true,
        canWrite: false,
        canAppendReconciliation: false,
        retryable: true,
        nextAction: "retry-after-contention",
        requiredEvidence: ["scope"],
        redactedDiagnosticFields: ["code", "scope"],
      };
    case "RUN_LEASE_HELD":
      return {
        category: "lease-held",
        canRead: true,
        canWrite: false,
        canAppendReconciliation: false,
        retryable: true,
        nextAction: "wait-for-lease",
        requiredEvidence: ["scope", "expires-at"],
        redactedDiagnosticFields: ["code", "scope", "expiresAt"],
      };
    case "RUN_LEASE_LOST":
      return {
        category: "lease-lost",
        canRead: true,
        canWrite: false,
        canAppendReconciliation: true,
        retryable: true,
        nextAction: "reconcile-before-reacquire",
        requiredEvidence: ["scope", "owner-run-id", "epoch"],
        redactedDiagnosticFields: ["code", "scope"],
      };
    case "DUPLICATE_LINEAGE":
    case "PERSISTENCE_CONFLICT":
      return {
        category: "duplicate-conflict",
        canRead: true,
        canWrite: false,
        canAppendReconciliation: true,
        retryable: false,
        nextAction: "preserve-and-reconcile",
        requiredEvidence: ["scope", "identity", "canonical-hash"],
        redactedDiagnosticFields: ["code", "scope"],
      };
    case "HALT_ACTIVE":
      return {
        category: "halt",
        canRead: true,
        canWrite: false,
        canAppendReconciliation: true,
        retryable: false,
        nextAction: "reconcile-and-clear-halt",
        requiredEvidence: [
          "halt-revision",
          "lineage-revision",
          "reconciliation-revision",
        ],
        redactedDiagnosticFields: ["code", "scope"],
      };
    case "UNRESOLVED_STATE":
    case "UNRESOLVED_RECONCILIATION":
      return {
        category: "unresolved",
        canRead: true,
        canWrite: false,
        canAppendReconciliation: true,
        retryable: false,
        nextAction: "reconcile-before-exposure",
        requiredEvidence: ["owned-intent", "attempt", "reconciliation-result"],
        redactedDiagnosticFields: ["code", "scope"],
      };
    default:
      return {
        category: error.code.startsWith("PERSISTENCE_") ? "integrity" : "input",
        canRead: error.code.startsWith("PERSISTENCE_"),
        canWrite: false,
        canAppendReconciliation: false,
        retryable: false,
        nextAction: "inspect-and-correct-input",
        requiredEvidence: ["typed-error-code"],
        redactedDiagnosticFields: ["code"],
      };
  }
}

export interface PersistencePort {
  readonly scope: PersistenceScope;
  diagnostics(): PersistenceDiagnostics;
  close(): void;
  readArtifact(artifactId: string): Result<PersistedArtifact | undefined>;
  writeArtifact(artifact: PersistedArtifact): Result<void>;
  readRun(lineageId: string): Result<PersistenceRunSnapshot | undefined>;
  readRuns(): Result<readonly PersistenceRunSnapshot[]>;
  readScopeSnapshot(): Result<PersistenceScopeSnapshot>;
  readApproval(lineageId: string): Result<Approval | undefined>;
  prepareLineage(request: PrepareLineageRequest): Result<LineageRecord>;
  prepareOwnedIntent(request: PrepareIntentRequest): Result<OwnedIntentRecord>;
  appendAttempt(request: AppendAttemptRequest): Result<AttemptRecord>;
  appendIdentityBinding(
    request: AppendIdentityBindingRequest,
  ): Result<IdentityBindingOutcome>;
  readIdentityBinding(
    lineageId: string,
    attemptId: string,
  ): Result<IdentityBindingRecord | undefined>;
  readIdentityBindings(
    lineageId: string,
  ): Result<readonly IdentityBindingRecord[]>;
  appendReconciliation(
    request: AppendReconciliationRequest,
  ): Result<ReconciliationRecord>;
  ingestFact(fact: IngestionFact): Result<"inserted" | "duplicate">;
  ingestFactAndAdvanceCheckpoint(
    fact: IngestionFact,
    request: CheckpointUpdateRequest,
  ): Result<"inserted" | "duplicate">;
  readFact(
    factKind: PersistenceFactKind,
    eventIdentity: string,
  ): Result<IngestionFact | undefined>;
  readFacts(): Result<readonly IngestionFact[]>;
  readCheckpoint(stream: string): Result<CheckpointState | undefined>;
  updateCheckpoint(request: CheckpointUpdateRequest): Result<CheckpointState>;
  acquireLease(request: LeaseRequest): Result<LeaseState>;
  renewLease(
    request: LeaseRequest & { readonly authority: LeaseAuthority },
  ): Result<LeaseState>;
  releaseLease(authority: LeaseAuthority): Result<void>;
  raiseHalt(
    authority: LeaseAuthority,
    reason: string,
    recordedAt: UtcTimestamp,
  ): Result<HaltState>;
  readHalt(): Result<HaltState>;
  clearHalt(request: HaltClearRequest): Result<HaltState>;
}
