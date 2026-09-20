import { CURRENT_SCHEMA_VERSION } from "./migrations.js";
import {
  openSqliteConnection,
  type SqliteConnection,
  type SqliteConnectionOptions,
} from "./connection.js";
import {
  createSqliteAccountingStore,
  type SqliteAccountingStore,
} from "./accounting-store.js";
import {
  createSqliteExecutionStore,
  type SqliteExecutionStore,
} from "./execution-store.js";
import { fail, ok, type Result } from "../../domain/shared/result.js";
import { domainError } from "../../domain/shared/errors.js";
import type { Approval } from "../../domain/execution/approval.js";
import type { UtcTimestamp } from "../../domain/shared/time.js";
import type {
  AppendAttemptRequest,
  AppendReconciliationRequest,
  AttemptRecord,
  CheckpointState,
  CheckpointUpdateRequest,
  HaltClearRequest,
  HaltState,
  IngestionFact,
  LeaseAuthority,
  LeaseRequest,
  LeaseState,
  LineageRecord,
  OwnedIntentRecord,
  PersistedArtifact,
  PersistenceDiagnostics,
  PersistenceEnvironment,
  PersistenceFactKind,
  PersistencePort,
  PersistenceRunSnapshot,
  PersistenceScopeSnapshot,
  PersistenceScope,
  PrepareIntentRequest,
  PrepareLineageRequest,
  ReconciliationRecord,
} from "../../ports/persistence.js";

export interface SqlitePersistenceOptions extends Omit<
  SqliteConnectionOptions,
  "environment"
> {
  readonly environment: PersistenceEnvironment;
  readonly scope: PersistenceScope;
}

export class SqlitePersistence implements PersistencePort {
  public readonly scope: PersistenceScope;
  private readonly execution: SqliteExecutionStore;
  private readonly accounting: SqliteAccountingStore;

  public constructor(
    private readonly connection: SqliteConnection,
    execution: SqliteExecutionStore,
    accounting: SqliteAccountingStore,
  ) {
    this.scope = execution.scope;
    this.execution = execution;
    this.accounting = accounting;
  }

  public diagnostics(): PersistenceDiagnostics {
    return {
      databasePath: this.connection.path,
      environment: this.scope.environment,
      nodeVersion: this.connection.runtime.nodeVersion,
      sqliteVersion: this.connection.runtime.sqliteVersion,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      scope: this.scope,
    };
  }

  public close(): void {
    this.connection.close();
  }

  public readArtifact(
    artifactId: string,
  ): Result<PersistedArtifact | undefined> {
    return this.execution.readArtifact(artifactId);
  }

  public writeArtifact(artifact: PersistedArtifact): Result<void> {
    return this.execution.writeArtifact(artifact);
  }

  public readApproval(lineageId: string): Result<Approval | undefined> {
    return this.execution.readApproval(lineageId);
  }

  public readRun(
    lineageId: string,
  ): Result<PersistenceRunSnapshot | undefined> {
    const lineage = this.execution.readLineage(lineageId);
    if (!lineage.ok) return lineage;
    if (lineage.value === undefined) return ok(undefined);
    const plan = this.execution.readPlan(lineageId);
    if (!plan.ok) return plan;
    if (plan.value === undefined) {
      return fail(
        domainError(
          "PERSISTENCE_INTEGRITY",
          "committed lineage has no rehydratable execution plan",
        ),
      );
    }
    const approval = this.execution.readApproval(lineageId);
    if (!approval.ok) return approval;
    if (approval.value === undefined) {
      return fail(
        domainError(
          "PERSISTENCE_INTEGRITY",
          "committed lineage has no rehydratable approval",
        ),
      );
    }
    const ownedIntents: OwnedIntentRecord[] = [];
    for (const intent of plan.value.material.orderIntents) {
      const owned = this.execution.readOwnedIntent(lineageId, intent.intentId);
      if (!owned.ok) return owned;
      if (owned.value !== undefined) ownedIntents.push(owned.value);
    }
    const attempts = this.execution.readAttempts(lineageId);
    if (!attempts.ok) return attempts;
    const reconciliations = this.execution.readReconciliations(lineageId);
    if (!reconciliations.ok) return reconciliations;
    const lease = this.execution.readLease();
    if (!lease.ok) return lease;
    const halt = this.execution.readHalt();
    if (!halt.ok) return halt;
    return ok({
      lineage: lineage.value,
      plan: plan.value,
      approval: approval.value,
      ownedIntents,
      attempts: attempts.value,
      reconciliations: reconciliations.value,
      ...(lease.value === undefined ? {} : { lease: lease.value }),
      halt: halt.value,
    });
  }

  public readScopeSnapshot(): Result<PersistenceScopeSnapshot> {
    const accountingFacts = this.accounting.readFacts();
    if (!accountingFacts.ok) return accountingFacts;
    const lease = this.execution.readLease();
    if (!lease.ok) return lease;
    const halt = this.execution.readHalt();
    if (!halt.ok) return halt;
    return ok({
      scope: this.scope,
      accountingFacts: accountingFacts.value,
      ...(lease.value === undefined ? {} : { lease: lease.value }),
      halt: halt.value,
    });
  }

  public prepareLineage(request: PrepareLineageRequest): Result<LineageRecord> {
    return this.execution.prepareLineage(request);
  }

  public prepareOwnedIntent(
    request: PrepareIntentRequest,
  ): Result<OwnedIntentRecord> {
    return this.execution.prepareOwnedIntent(request);
  }

  public appendAttempt(request: AppendAttemptRequest): Result<AttemptRecord> {
    return this.execution.appendAttempt(request);
  }

  public appendReconciliation(
    request: AppendReconciliationRequest,
  ): Result<ReconciliationRecord> {
    return this.execution.appendReconciliation(request);
  }

  public ingestFact(fact: IngestionFact): Result<"inserted" | "duplicate"> {
    return this.accounting.ingestFact(fact);
  }

  public ingestFactAndAdvanceCheckpoint(
    fact: IngestionFact,
    request: CheckpointUpdateRequest,
  ): Result<"inserted" | "duplicate"> {
    return this.accounting.ingestFactAndAdvanceCheckpoint(fact, request);
  }

  public readFact(
    factKind: PersistenceFactKind,
    eventIdentity: string,
  ): Result<IngestionFact | undefined> {
    return this.accounting.readFact(factKind, eventIdentity);
  }

  public readFacts(): Result<readonly IngestionFact[]> {
    return this.accounting.readFacts();
  }

  public readCheckpoint(stream: string): Result<CheckpointState | undefined> {
    return this.accounting.readCheckpoint(stream);
  }

  public updateCheckpoint(
    request: CheckpointUpdateRequest,
  ): Result<CheckpointState> {
    return this.accounting.updateCheckpoint(request);
  }

  public acquireLease(request: LeaseRequest): Result<LeaseState> {
    return this.execution.acquireLease(request);
  }

  public renewLease(
    request: LeaseRequest & { readonly authority: LeaseAuthority },
  ): Result<LeaseState> {
    return this.execution.renewLease(request);
  }

  public releaseLease(authority: LeaseAuthority): Result<void> {
    return this.execution.releaseLease(authority);
  }

  public raiseHalt(
    authority: LeaseAuthority,
    reason: string,
    recordedAt: UtcTimestamp,
  ): Result<HaltState> {
    return this.execution.raiseHalt(authority, reason, recordedAt);
  }

  public readHalt(): Result<HaltState> {
    return this.execution.readHalt();
  }

  public clearHalt(request: HaltClearRequest): Result<HaltState> {
    return this.execution.clearHalt(request);
  }
}

export function openSqlitePersistence(
  options: SqlitePersistenceOptions,
): Result<SqlitePersistence> {
  const connection = openSqliteConnection({
    ...options,
    environment: options.environment,
  });
  if (!connection.ok) return connection;
  const execution = createSqliteExecutionStore(connection.value, options.scope);
  if (!execution.ok) {
    connection.value.close();
    return execution;
  }
  const accounting = createSqliteAccountingStore(
    connection.value,
    options.scope,
    execution.value.scope,
  );
  if (!accounting.ok) {
    connection.value.close();
    return accounting;
  }
  return ok(
    new SqlitePersistence(connection.value, execution.value, accounting.value),
  );
}
