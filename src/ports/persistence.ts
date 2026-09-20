import type {
  ArtifactKind,
  CanonicalArtifactEnvelope,
} from "../domain/identity/canonical-artifact.js";
import type { Approval } from "../domain/execution/approval.js";
import type { ClearanceEvidence } from "../domain/execution/clearance-evidence.js";
import type { ExecutionAttempt } from "../domain/execution/execution-attempt.js";
import type { ReconciliationResult } from "../domain/execution/reconciliation.js";
import type { ExecutionPlan } from "../domain/planning/execution-plan.js";
import type { PlanHash } from "../domain/identity/canonical-serialization.js";
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
  readonly factKind: PersistenceFactKind;
  readonly eventIdentity: string;
  readonly scope: PersistenceScope;
  readonly observedAt: UtcTimestamp;
  readonly canonicalHash: string;
  readonly artifact: PersistedArtifact;
  readonly observationRevision?: string;
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

export interface PersistencePort {
  readonly scope: PersistenceScope;
  close(): void;
  readArtifact(artifactId: string): Result<PersistedArtifact | undefined>;
  writeArtifact(artifact: PersistedArtifact): Result<void>;
  prepareLineage(request: PrepareLineageRequest): Result<LineageRecord>;
  prepareOwnedIntent(request: PrepareIntentRequest): Result<OwnedIntentRecord>;
  appendAttempt(request: AppendAttemptRequest): Result<AttemptRecord>;
  appendReconciliation(
    request: AppendReconciliationRequest,
  ): Result<ReconciliationRecord>;
  ingestFact(fact: IngestionFact): Result<"inserted" | "duplicate">;
  readCheckpoint(stream: string): Result<CheckpointState | undefined>;
  updateCheckpoint(request: CheckpointUpdateRequest): Result<CheckpointState>;
  acquireLease(request: LeaseRequest): Result<LeaseState>;
  renewLease(
    request: LeaseRequest & { readonly authority: LeaseAuthority },
  ): Result<LeaseState>;
  releaseLease(authority: LeaseAuthority): Result<void>;
  readHalt(): Result<HaltState>;
  clearHalt(request: HaltClearRequest): Result<HaltState>;
}
