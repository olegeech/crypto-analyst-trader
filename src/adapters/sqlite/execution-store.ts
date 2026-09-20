import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  encodeCanonicalArtifact,
  rehydrateArtifact,
  type CanonicalArtifactEnvelope,
} from "../../domain/identity/canonical-artifact.js";
import {
  createApproval,
  validateApproval,
} from "../../domain/execution/approval.js";
import { createClearanceEvidence } from "../../domain/execution/clearance-evidence.js";
import type { ExecutionAttempt } from "../../domain/execution/execution-attempt.js";
import { isProducedExecutionAttempt } from "../../domain/execution/execution-attempt-proof.js";
import type { ReconciliationResult } from "../../domain/execution/reconciliation.js";
import { isProducedReconciliationResult } from "../../domain/execution/reconciliation-proof.js";
import { isProducedExecutionPlan } from "../../domain/planning/plan-proof.js";
import type { ExecutionPlan } from "../../domain/planning/execution-plan.js";
import { domainError } from "../../domain/shared/errors.js";
import { fail, ok, type Result } from "../../domain/shared/result.js";
import {
  parseUtcTimestamp,
  timestampFromEpochMs,
  timestampToEpochMs,
  type UtcTimestamp,
} from "../../domain/shared/time.js";
import {
  requireFiniteInteger,
  requireHash,
  requireIdentifier,
  requireSafeText,
} from "../../domain/shared/validation.js";
import type { SqliteConnection } from "./connection.js";
import {
  commitTransaction,
  runInTransaction,
  sqliteError,
} from "./transaction.js";
import type {
  AppendAttemptRequest,
  AppendReconciliationRequest,
  AttemptRecord,
  HaltClearRequest,
  HaltState,
  LeaseAuthority,
  LeaseRequest,
  LeaseState,
  LineageRecord,
  OwnedIntentRecord,
  PersistenceEnvironment,
  PersistenceScope,
  PrepareIntentRequest,
  PrepareLineageRequest,
  ReconciliationRecord,
} from "../../ports/persistence.js";

const MAX_LEASE_TTL_MS = 24 * 60 * 60 * 1_000;
const SCOPE_WHERE =
  "exchange = ? AND environment = ? AND account_id = ? AND category = ? AND position_mode = ?";

type SqliteRow = Record<string, unknown>;
type PersistedTimestamp = UtcTimestamp;

function persistenceFailure(message: string): Result<never> {
  return fail(domainError("PERSISTENCE_INTEGRITY", message));
}

function conflictFailure(message: string): Result<never> {
  return fail(domainError("PERSISTENCE_CONFLICT", message));
}

function isEnvironment(value: unknown): value is PersistenceEnvironment {
  return value === "demo" || value === "testnet" || value === "mainnet";
}

function scopeValues(scope: PersistenceScope): readonly string[] {
  return [
    scope.exchange,
    scope.environment,
    scope.accountId,
    scope.category,
    scope.positionMode,
  ];
}

function scopesEqual(left: PersistenceScope, right: PersistenceScope): boolean {
  return (
    left.exchange === right.exchange &&
    left.environment === right.environment &&
    left.accountId === right.accountId &&
    left.category === right.category &&
    left.positionMode === right.positionMode
  );
}

function validateScope(
  scope: PersistenceScope,
  connection: SqliteConnection,
): Result<PersistenceScope> {
  const exchange = requireIdentifier(scope.exchange, "scope.exchange");
  const accountId = requireSafeText(scope.accountId, "scope.accountId");
  const category = requireIdentifier(scope.category, "scope.category");
  if (
    !exchange.ok ||
    !accountId.ok ||
    !category.ok ||
    !isEnvironment(scope.environment) ||
    (scope.positionMode !== "one-way" && scope.positionMode !== "hedge")
  ) {
    return fail(
      domainError("PERSISTENCE_ENVIRONMENT", "persistence scope is invalid"),
    );
  }
  if (scope.environment !== connection.environment) {
    return fail(
      domainError(
        "PERSISTENCE_ENVIRONMENT",
        "persistence scope does not match the opened database environment",
      ),
    );
  }
  return ok(
    Object.freeze({
      exchange: exchange.value,
      environment: scope.environment,
      accountId: accountId.value,
      category: category.value,
      positionMode: scope.positionMode,
    }),
  );
}

function scopeFromPlan(plan: ExecutionPlan): Result<PersistenceScope> {
  const executionScope = plan.material.executionScope;
  const accountScope = plan.material.accountSnapshot.scope;
  if (
    executionScope.exchange !== accountScope.exchange ||
    executionScope.environment !== accountScope.environment ||
    executionScope.category !== accountScope.category ||
    executionScope.positionMode !== accountScope.positionMode ||
    !isEnvironment(executionScope.environment)
  ) {
    return fail(
      domainError(
        "PERSISTENCE_ENVIRONMENT",
        "execution plan scope and account snapshot scope disagree",
      ),
    );
  }
  const accountId = requireSafeText(
    plan.material.accountSnapshot.accountScope,
    "accountScope",
  );
  if (!accountId.ok) return accountId;
  return ok({
    exchange: executionScope.exchange,
    environment: executionScope.environment,
    accountId: accountId.value,
    category: executionScope.category,
    positionMode: executionScope.positionMode,
  });
}

function deterministicId(prefix: string, value: string): string {
  const digest = createHash("sha256").update(value, "utf8").digest("hex");
  return `${prefix}-${digest.slice(0, 40)}`;
}

function storedString(row: SqliteRow, field: string): Result<string> {
  const value = row[field];
  return typeof value === "string"
    ? ok(value)
    : persistenceFailure(`persisted SQLite field ${field} is invalid`);
}

function storedIdentifier(row: SqliteRow, field: string): Result<string> {
  const value = storedString(row, field);
  if (!value.ok) return value;
  const parsed = requireIdentifier(value.value, field);
  return parsed.ok
    ? parsed
    : persistenceFailure(`persisted SQLite identifier ${field} is invalid`);
}

function storedHash(row: SqliteRow, field: string): Result<string> {
  const value = storedString(row, field);
  if (!value.ok) return value;
  const parsed = requireHash(value.value, field);
  return parsed.ok
    ? parsed
    : persistenceFailure(`persisted SQLite hash ${field} is invalid`);
}

function storedTimestamp(
  row: SqliteRow,
  field: string,
): Result<PersistedTimestamp> {
  const value = storedString(row, field);
  if (!value.ok) return value;
  const parsed = parseUtcTimestamp(value.value);
  return parsed.ok
    ? parsed
    : persistenceFailure(`persisted SQLite timestamp ${field} is invalid`);
}

function storedOptionalString(
  row: SqliteRow,
  field: string,
): Result<string | undefined> {
  const value = row[field];
  if (value === null || value === undefined) return ok(undefined);
  return typeof value === "string"
    ? ok(value)
    : persistenceFailure(`persisted SQLite optional field ${field} is invalid`);
}

function storedBoolean(row: SqliteRow, field: string): Result<boolean> {
  const value = row[field];
  if (value !== 0 && value !== 1) {
    return persistenceFailure(`persisted SQLite boolean ${field} is invalid`);
  }
  return ok(value === 1);
}

function envelopeFromRow(
  row: SqliteRow,
  expectedKind: CanonicalArtifactEnvelope["artifactKind"],
): Result<CanonicalArtifactEnvelope> {
  const artifactKind = storedString(row, "artifact_kind");
  const schemaVersion = storedString(row, "schema_version");
  const canonicalJson = storedString(row, "canonical_json");
  const canonicalHash = storedHash(row, "canonical_hash");
  if (
    !artifactKind.ok ||
    !schemaVersion.ok ||
    !canonicalJson.ok ||
    !canonicalHash.ok
  ) {
    return persistenceFailure("persisted SQLite artifact envelope is invalid");
  }
  if (artifactKind.value !== expectedKind) {
    return persistenceFailure("persisted SQLite artifact kind is unexpected");
  }
  return ok({
    artifactKind: expectedKind,
    schemaVersion: schemaVersion.value as "artifact/v1",
    canonicalJson: canonicalJson.value,
    canonicalHash: canonicalHash.value,
  });
}

function lineagesScopeSql(): string {
  return `SELECT lineage_id, run_id, plan_id, plan_hash, created_at
          FROM execution_lineages
          WHERE ${SCOPE_WHERE} AND lineage_id = ?`;
}

function lineageRow(
  database: DatabaseSync,
  scope: PersistenceScope,
  lineageId: string,
): SqliteRow | undefined {
  return database
    .prepare(lineagesScopeSql())
    .get(...scopeValues(scope), lineageId) as SqliteRow | undefined;
}

function lineageFromRow(
  row: SqliteRow,
  scope: PersistenceScope,
): Result<LineageRecord> {
  const lineageId = storedIdentifier(row, "lineage_id");
  const runId = storedIdentifier(row, "run_id");
  const planId = storedIdentifier(row, "plan_id");
  const planHash = storedHash(row, "plan_hash");
  const createdAt = storedTimestamp(row, "created_at");
  if (
    !lineageId.ok ||
    !runId.ok ||
    !planId.ok ||
    !planHash.ok ||
    !createdAt.ok
  ) {
    return persistenceFailure("persisted SQLite lineage is invalid");
  }
  return ok({
    lineageId: lineageId.value,
    runId: runId.value,
    planId: planId.value,
    planHash: planHash.value as LineageRecord["planHash"],
    scope,
    createdAt: createdAt.value,
  });
}

function ownedIntentRow(
  database: DatabaseSync,
  scope: PersistenceScope,
  lineageId: string,
  intentId: string,
): SqliteRow | undefined {
  return database
    .prepare(
      `SELECT intent_record_id, lineage_id, intent_id, plan_hash, client_order_id, prepared_at
       FROM owned_intents
       WHERE ${SCOPE_WHERE} AND lineage_id = ? AND intent_id = ?`,
    )
    .get(...scopeValues(scope), lineageId, intentId) as SqliteRow | undefined;
}

function ownedIntentFromRow(row: SqliteRow): Result<OwnedIntentRecord> {
  const intentRecordId = storedIdentifier(row, "intent_record_id");
  const lineageId = storedIdentifier(row, "lineage_id");
  const intentId = storedIdentifier(row, "intent_id");
  const planHash = storedHash(row, "plan_hash");
  const clientOrderId = storedIdentifier(row, "client_order_id");
  const preparedAt = storedTimestamp(row, "prepared_at");
  if (
    !intentRecordId.ok ||
    !lineageId.ok ||
    !intentId.ok ||
    !planHash.ok ||
    !clientOrderId.ok ||
    !preparedAt.ok
  ) {
    return persistenceFailure("persisted SQLite owned intent is invalid");
  }
  return ok({
    intentRecordId: intentRecordId.value,
    lineageId: lineageId.value,
    intentId: intentId.value,
    planHash: planHash.value as OwnedIntentRecord["planHash"],
    clientOrderId: clientOrderId.value,
    preparedAt: preparedAt.value,
  });
}

function readPlanFromDatabase(
  database: DatabaseSync,
  scope: PersistenceScope,
  lineageId: string,
): Result<ExecutionPlan | undefined> {
  const row = database
    .prepare(
      `SELECT a.artifact_kind, a.schema_version, a.canonical_json, a.canonical_hash
       FROM artifacts a
       INNER JOIN execution_lineages l ON l.plan_id = a.artifact_id
       WHERE ${SCOPE_WHERE} AND l.lineage_id = ?`,
    )
    .get(...scopeValues(scope), lineageId) as SqliteRow | undefined;
  if (row === undefined) return ok(undefined);
  const envelope = envelopeFromRow(row, "execution-plan");
  if (!envelope.ok) return envelope;
  const plan = rehydrateArtifact("execution-plan", envelope.value);
  return plan.ok
    ? plan
    : persistenceFailure("persisted execution plan failed domain rehydration");
}

function attemptFromRow(row: SqliteRow): Result<AttemptRecord> {
  const lineageId = storedIdentifier(row, "lineage_id");
  const dispatchedAt = storedTimestamp(row, "dispatched_at");
  const envelope = envelopeFromRow(row, "execution-attempt");
  if (!lineageId.ok || !dispatchedAt.ok || !envelope.ok) {
    return persistenceFailure("persisted SQLite attempt is invalid");
  }
  const attempt = rehydrateArtifact("execution-attempt", envelope.value);
  if (!attempt.ok || !isProducedExecutionAttempt(attempt.value)) {
    return persistenceFailure("persisted execution attempt failed rehydration");
  }
  const hydratedAttempt = attempt.value as ExecutionAttempt;
  return ok({
    lineageId: lineageId.value,
    attempt: hydratedAttempt,
    dispatchedAt: dispatchedAt.value,
  });
}

function reconciliationFromRow(row: SqliteRow): Result<ReconciliationRecord> {
  const lineageId = storedIdentifier(row, "lineage_id");
  const recordedAt = storedTimestamp(row, "recorded_at");
  const envelope = envelopeFromRow(row, "reconciliation-result");
  if (!lineageId.ok || !recordedAt.ok || !envelope.ok) {
    return persistenceFailure("persisted SQLite reconciliation is invalid");
  }
  const result = rehydrateArtifact("reconciliation-result", envelope.value);
  if (!result.ok || !isProducedReconciliationResult(result.value)) {
    return persistenceFailure("persisted reconciliation failed rehydration");
  }
  const hydratedResult = result.value as ReconciliationResult;
  return ok({
    lineageId: lineageId.value,
    result: hydratedResult,
    recordedAt: recordedAt.value,
  });
}

interface LeaseRow {
  readonly ownerRunId: string;
  readonly epoch: number;
  readonly acquiredAt: UtcTimestamp;
  readonly expiresAt: UtcTimestamp;
  readonly reconciliationRequired: boolean;
}

function leaseRow(
  database: DatabaseSync,
  scope: PersistenceScope,
): Result<LeaseRow | undefined> {
  const row = database
    .prepare(
      `SELECT owner_run_id, epoch, acquired_at, expires_at, reconciliation_required
       FROM leases WHERE ${SCOPE_WHERE}`,
    )
    .get(...scopeValues(scope)) as SqliteRow | undefined;
  if (row === undefined) return ok(undefined);
  const ownerRunId = storedIdentifier(row, "owner_run_id");
  const acquiredAt = storedTimestamp(row, "acquired_at");
  const expiresAt = storedTimestamp(row, "expires_at");
  const reconciliationRequired = storedBoolean(row, "reconciliation_required");
  if (
    !ownerRunId.ok ||
    typeof row.epoch !== "number" ||
    !Number.isSafeInteger(row.epoch) ||
    row.epoch < 1 ||
    !acquiredAt.ok ||
    !expiresAt.ok ||
    !reconciliationRequired.ok
  ) {
    return persistenceFailure("persisted SQLite lease is invalid");
  }
  return ok({
    ownerRunId: ownerRunId.value,
    epoch: row.epoch,
    acquiredAt: acquiredAt.value,
    expiresAt: expiresAt.value,
    reconciliationRequired: reconciliationRequired.value,
  });
}

function leaseState(scope: PersistenceScope, row: LeaseRow): LeaseState {
  return { scope, ...row };
}

function haltRow(
  database: DatabaseSync,
  scope: PersistenceScope,
): Result<HaltState> {
  const row = database
    .prepare(
      `SELECT active, revision, reason, raised_at, reconciliation_required
       FROM halt_state WHERE ${SCOPE_WHERE}`,
    )
    .get(...scopeValues(scope)) as SqliteRow | undefined;
  if (row === undefined) {
    return ok({
      scope,
      active: false,
      revision: 0,
      reconciliationRequired: false,
    });
  }
  const active = storedBoolean(row, "active");
  const reconciliationRequired = storedBoolean(row, "reconciliation_required");
  const reason = storedOptionalString(row, "reason");
  const raisedAtValue = row.raised_at;
  const raisedAt =
    raisedAtValue === null || raisedAtValue === undefined
      ? ok<UtcTimestamp | undefined>(undefined)
      : storedTimestamp(row, "raised_at");
  if (
    !active.ok ||
    !reconciliationRequired.ok ||
    !reason.ok ||
    !raisedAt.ok ||
    typeof row.revision !== "number" ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 0
  ) {
    return persistenceFailure("persisted SQLite HALT state is invalid");
  }
  return ok({
    scope,
    active: active.value,
    revision: row.revision,
    ...(reason.value === undefined ? {} : { reason: reason.value }),
    ...(raisedAt.value === undefined ? {} : { raisedAt: raisedAt.value }),
    reconciliationRequired: reconciliationRequired.value,
  });
}

function validateAuthority(authority: LeaseAuthority): Result<LeaseAuthority> {
  const ownerRunId = requireIdentifier(authority.ownerRunId, "ownerRunId");
  const epoch = requireFiniteInteger(authority.epoch, "epoch", 1);
  if (!ownerRunId.ok || !epoch.ok) {
    return fail(domainError("RUN_LEASE_LOST", "lease authority is invalid"));
  }
  return ok({ ownerRunId: ownerRunId.value, epoch: epoch.value });
}

function assertCurrentAuthority(
  database: DatabaseSync,
  scope: PersistenceScope,
  authority: LeaseAuthority,
  now: UtcTimestamp,
): Result<LeaseRow> {
  const parsedAuthority = validateAuthority(authority);
  if (!parsedAuthority.ok) return parsedAuthority;
  const current = leaseRow(database, scope);
  if (!current.ok) return current;
  if (
    current.value === undefined ||
    current.value.ownerRunId !== parsedAuthority.value.ownerRunId ||
    current.value.epoch !== parsedAuthority.value.epoch ||
    Date.parse(now) >= Date.parse(current.value.expiresAt)
  ) {
    return fail(
      domainError(
        "RUN_LEASE_LOST",
        "current run lease is no longer authoritative",
      ),
    );
  }
  return ok(current.value);
}

function validateLeaseRequest(
  request: LeaseRequest,
  scope: PersistenceScope,
): Result<{
  readonly ownerRunId: string;
  readonly now: UtcTimestamp;
  readonly expiresAt: UtcTimestamp;
  readonly ttlMs: number;
}> {
  if (!scopesEqual(request.scope, scope)) {
    return fail(
      domainError(
        "PERSISTENCE_ENVIRONMENT",
        "lease scope does not match the journal",
      ),
    );
  }
  const ownerRunId = requireIdentifier(request.ownerRunId, "ownerRunId");
  const now = parseUtcTimestamp(request.now);
  const ttlMs = requireFiniteInteger(request.ttlMs, "ttlMs", 1);
  if (
    !ownerRunId.ok ||
    !now.ok ||
    !ttlMs.ok ||
    ttlMs.value > MAX_LEASE_TTL_MS
  ) {
    return fail(domainError("INVALID_ARGUMENT", "lease request is invalid"));
  }
  const expiresAt = timestampFromEpochMs(
    timestampToEpochMs(now.value) + ttlMs.value,
  );
  if (!expiresAt.ok) return expiresAt;
  return ok({
    ownerRunId: ownerRunId.value,
    now: now.value,
    expiresAt: expiresAt.value,
    ttlMs: ttlMs.value,
  });
}

function validateTimestamp(
  value: unknown,
  field: string,
): Result<UtcTimestamp> {
  const parsed = parseUtcTimestamp(value);
  return parsed.ok
    ? parsed
    : fail(domainError("INVALID_TIMESTAMP", `${field} is invalid`, { field }));
}

function insertArtifact(
  database: DatabaseSync,
  artifactId: string,
  envelope: CanonicalArtifactEnvelope,
  materialHash: string | undefined,
  createdAt: UtcTimestamp,
): Result<void> {
  const existing = database
    .prepare(
      "SELECT artifact_kind, schema_version, canonical_json, canonical_hash, material_hash FROM artifacts WHERE artifact_id = ?",
    )
    .get(artifactId) as SqliteRow | undefined;
  if (existing !== undefined) {
    const same =
      existing.artifact_kind === envelope.artifactKind &&
      existing.schema_version === envelope.schemaVersion &&
      existing.canonical_json === envelope.canonicalJson &&
      existing.canonical_hash === envelope.canonicalHash &&
      (existing.material_hash ?? undefined) === materialHash;
    return same
      ? ok(undefined)
      : conflictFailure(
          "artifact identity is already bound to different bytes",
        );
  }
  database
    .prepare(
      `INSERT INTO artifacts
       (artifact_id, artifact_kind, schema_version, canonical_json, canonical_hash, material_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      artifactId,
      envelope.artifactKind,
      envelope.schemaVersion,
      envelope.canonicalJson,
      envelope.canonicalHash,
      materialHash ?? null,
      createdAt,
    );
  return ok(undefined);
}

function addHalt(
  database: DatabaseSync,
  scope: PersistenceScope,
  reason: string,
  recordedAt: UtcTimestamp,
  evidenceJson?: string,
): Result<HaltState> {
  const safeReason = requireSafeText(reason, "reason");
  if (!safeReason.ok) return safeReason;
  const current = haltRow(database, scope);
  if (!current.ok) return current;
  const revision = current.value.revision + 1;
  if (!Number.isSafeInteger(revision)) {
    return persistenceFailure("HALT revision exceeded the safe integer range");
  }
  const eventId = deterministicId(
    "halt",
    `${scopeValues(scope).join("\u0000")}:${revision}:${safeReason.value}`,
  );
  database
    .prepare(
      `INSERT INTO halt_state
       (exchange, environment, account_id, category, position_mode, active, revision, reason, raised_at, reconciliation_required)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, 1)
       ON CONFLICT (exchange, environment, account_id, category, position_mode)
       DO UPDATE SET active = 1, revision = excluded.revision, reason = excluded.reason,
         raised_at = excluded.raised_at, reconciliation_required = 1`,
    )
    .run(...scopeValues(scope), revision, safeReason.value, recordedAt);
  database
    .prepare(
      `INSERT INTO halt_events
       (event_id, exchange, environment, account_id, category, position_mode, revision, active, reason, recorded_at, evidence_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    )
    .run(
      eventId,
      ...scopeValues(scope),
      revision,
      safeReason.value,
      recordedAt,
      evidenceJson ?? null,
    );
  return haltRow(database, scope);
}

function authorityLineageRow(
  database: DatabaseSync,
  scope: PersistenceScope,
  lineageId: string,
  authority: LeaseAuthority,
): Result<SqliteRow> {
  const parsedAuthority = validateAuthority(authority);
  if (!parsedAuthority.ok) return parsedAuthority;
  const row = lineageRow(database, scope, lineageId);
  if (row === undefined) {
    return conflictFailure("execution lineage does not exist in this scope");
  }
  const runId = storedIdentifier(row, "run_id");
  if (!runId.ok) return runId;
  if (runId.value !== parsedAuthority.value.ownerRunId) {
    return fail(
      domainError("RUN_LEASE_LOST", "lineage is owned by another run"),
    );
  }
  return ok(row);
}

function appendConflictAfterHalt<T>(
  database: DatabaseSync,
  scope: PersistenceScope,
  reason: string,
  recordedAt: UtcTimestamp,
  message: string,
) {
  const halted = addHalt(database, scope, reason, recordedAt);
  if (!halted.ok) return halted;
  return commitTransaction(
    fail<T>(domainError("PERSISTENCE_CONFLICT", message)),
  );
}

export class SqliteExecutionStore {
  public readonly scope: PersistenceScope;
  public readonly path: string;
  private readonly database: DatabaseSync;
  private readonly connection: SqliteConnection;

  public constructor(connection: SqliteConnection, scope: PersistenceScope) {
    this.connection = connection;
    this.database = connection.db;
    this.path = connection.path;
    this.scope = scope;
  }

  public close(): void {
    this.connection.close();
  }

  public readLineage(lineageId: string): Result<LineageRecord | undefined> {
    try {
      const row = lineageRow(this.database, this.scope, lineageId);
      return row === undefined
        ? ok(undefined)
        : lineageFromRow(row, this.scope);
    } catch (error) {
      return fail(sqliteError(error, "PERSISTENCE_INTEGRITY"));
    }
  }

  public readPlan(lineageId: string): Result<ExecutionPlan | undefined> {
    try {
      return readPlanFromDatabase(this.database, this.scope, lineageId);
    } catch (error) {
      return fail(sqliteError(error, "PERSISTENCE_INTEGRITY"));
    }
  }

  public readOwnedIntent(
    lineageId: string,
    intentId: string,
  ): Result<OwnedIntentRecord | undefined> {
    try {
      const row = ownedIntentRow(
        this.database,
        this.scope,
        lineageId,
        intentId,
      );
      return row === undefined ? ok(undefined) : ownedIntentFromRow(row);
    } catch (error) {
      return fail(sqliteError(error, "PERSISTENCE_INTEGRITY"));
    }
  }

  public readAttempts(lineageId: string): Result<readonly AttemptRecord[]> {
    try {
      const rows = this.database
        .prepare(
          `SELECT lineage_id, submitted_at AS dispatched_at, 'execution-attempt' AS artifact_kind,
             'artifact/v1' AS schema_version, canonical_json, canonical_hash
           FROM execution_attempts
           WHERE lineage_id = ? ORDER BY attempt_number`,
        )
        .all(lineageId) as SqliteRow[];
      const attempts: AttemptRecord[] = [];
      for (const row of rows) {
        const attempt = attemptFromRow(row);
        if (!attempt.ok) return attempt;
        attempts.push(attempt.value);
      }
      return ok(attempts);
    } catch (error) {
      return fail(sqliteError(error, "PERSISTENCE_INTEGRITY"));
    }
  }

  public readReconciliations(
    lineageId: string,
  ): Result<readonly ReconciliationRecord[]> {
    try {
      const rows = this.database
        .prepare(
          `SELECT lineage_id, observed_at AS recorded_at, 'reconciliation-result' AS artifact_kind,
             'artifact/v1' AS schema_version, canonical_json, canonical_hash
           FROM reconciliation_results
           WHERE lineage_id = ? ORDER BY revision`,
        )
        .all(lineageId) as SqliteRow[];
      const reconciliations: ReconciliationRecord[] = [];
      for (const row of rows) {
        const reconciliation = reconciliationFromRow(row);
        if (!reconciliation.ok) return reconciliation;
        reconciliations.push(reconciliation.value);
      }
      return ok(reconciliations);
    } catch (error) {
      return fail(sqliteError(error, "PERSISTENCE_INTEGRITY"));
    }
  }

  public readLease(): Result<LeaseState | undefined> {
    try {
      const row = leaseRow(this.database, this.scope);
      return row.ok && row.value !== undefined
        ? ok(leaseState(this.scope, row.value))
        : row.ok
          ? ok(undefined)
          : row;
    } catch (error) {
      return fail(sqliteError(error, "PERSISTENCE_INTEGRITY"));
    }
  }

  public prepareLineage(request: PrepareLineageRequest): Result<LineageRecord> {
    if (!scopesEqual(request.scope, this.scope)) {
      return fail(
        domainError(
          "PERSISTENCE_ENVIRONMENT",
          "lineage scope does not match the journal",
        ),
      );
    }
    if (!isProducedExecutionPlan(request.plan)) {
      return fail(
        domainError(
          "INVALID_PLAN",
          "lineage requires a produced execution plan",
        ),
      );
    }
    const planScope = scopeFromPlan(request.plan);
    const runId = requireIdentifier(request.runId, "runId");
    const preparedAt = parseUtcTimestamp(request.preparedAt);
    const approval = createApproval(request.approval);
    if (!planScope.ok || !runId.ok || !preparedAt.ok || !approval.ok) {
      return fail(
        domainError(
          "PERSISTENCE_INTEGRITY",
          "lineage preparation input is invalid",
        ),
      );
    }
    if (!scopesEqual(planScope.value, this.scope)) {
      return fail(
        domainError(
          "PERSISTENCE_ENVIRONMENT",
          "plan scope does not match the journal",
        ),
      );
    }
    const validatedApproval = validateApproval(
      approval.value,
      request.plan.materialHash,
      { now: () => preparedAt.value },
    );
    if (!validatedApproval.ok) return validatedApproval;
    const planArtifact = encodeCanonicalArtifact(
      "execution-plan",
      request.plan,
    );
    const approvalArtifact = encodeCanonicalArtifact(
      "approval",
      approval.value,
    );
    if (!planArtifact.ok || !approvalArtifact.ok) {
      return fail(
        domainError(
          "PERSISTENCE_INTEGRITY",
          "lineage artifact encoding failed",
        ),
      );
    }
    const lineageId = deterministicId("lineage", request.plan.materialHash);

    return runInTransaction(
      this.database,
      (database) => {
        const existing = lineageRow(database, this.scope, lineageId);
        if (existing !== undefined) {
          const parsed = lineageFromRow(existing, this.scope);
          if (!parsed.ok) return parsed;
          if (parsed.value.runId !== runId.value) {
            return fail(
              domainError(
                "DUPLICATE_LINEAGE",
                "execution plan is already owned by another run",
              ),
            );
          }
          return parsed;
        }
        const planStored = insertArtifact(
          database,
          request.plan.planId,
          planArtifact.value,
          request.plan.materialHash,
          preparedAt.value,
        );
        if (!planStored.ok) return planStored;
        const approvalStored = insertArtifact(
          database,
          approval.value.approvalId,
          approvalArtifact.value,
          approval.value.planHash,
          preparedAt.value,
        );
        if (!approvalStored.ok) return approvalStored;
        database
          .prepare(
            `INSERT INTO execution_lineages
             (lineage_id, run_id, plan_id, plan_hash, exchange, environment, account_id, category, position_mode, created_at, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PREPARED')`,
          )
          .run(
            lineageId,
            runId.value,
            request.plan.planId,
            request.plan.materialHash,
            ...scopeValues(this.scope),
            preparedAt.value,
          );
        database
          .prepare(
            `INSERT INTO approvals
             (approval_id, lineage_id, plan_hash, actor, approved_at, expires_at, note)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            approval.value.approvalId,
            lineageId,
            approval.value.planHash,
            approval.value.actor,
            approval.value.approvedAt,
            approval.value.expiresAt,
            approval.value.note ?? null,
          );
        return ok({
          lineageId,
          runId: runId.value,
          planId: request.plan.planId,
          planHash: request.plan.materialHash,
          scope: this.scope,
          createdAt: preparedAt.value,
        });
      },
      "PERSISTENCE_CONFLICT",
    );
  }

  public prepareOwnedIntent(
    request: PrepareIntentRequest,
  ): Result<OwnedIntentRecord> {
    const lineageId = requireIdentifier(request.lineageId, "lineageId");
    const intentId = requireIdentifier(request.intentId, "intentId");
    const planHash = requireHash(request.planHash, "planHash");
    const clientOrderId = requireIdentifier(
      request.clientOrderId,
      "clientOrderId",
    );
    const now = parseUtcTimestamp(request.now);
    const preparedAt = parseUtcTimestamp(request.preparedAt);
    if (
      !lineageId.ok ||
      !intentId.ok ||
      !planHash.ok ||
      !clientOrderId.ok ||
      !now.ok ||
      !preparedAt.ok
    ) {
      return fail(
        domainError("PERSISTENCE_INTEGRITY", "owned intent input is invalid"),
      );
    }
    return runInTransaction(
      this.database,
      (database) => {
        const authority = assertCurrentAuthority(
          database,
          this.scope,
          request.authority,
          now.value,
        );
        if (!authority.ok) return authority;
        const lineage = lineageRow(database, this.scope, lineageId.value);
        if (lineage === undefined)
          return conflictFailure("execution lineage does not exist");
        const lineageOwner = storedIdentifier(lineage, "run_id");
        if (!lineageOwner.ok) return lineageOwner;
        if (lineageOwner.value !== request.authority.ownerRunId) {
          return fail(
            domainError("RUN_LEASE_LOST", "lineage is owned by another run"),
          );
        }

        const existing = ownedIntentRow(
          database,
          this.scope,
          lineageId.value,
          intentId.value,
        );
        if (existing !== undefined) {
          const parsed = ownedIntentFromRow(existing);
          if (!parsed.ok) return parsed;
          if (
            parsed.value.planHash === planHash.value &&
            parsed.value.clientOrderId === clientOrderId.value
          ) {
            return parsed;
          }
          return appendConflictAfterHalt(
            database,
            this.scope,
            "conflicting owned intent identity",
            now.value,
            "owned intent identity conflicts with the committed owner",
          );
        }

        const halt = haltRow(database, this.scope);
        if (!halt.ok) return halt;
        if (halt.value.active) {
          return fail(
            domainError(
              "HALT_ACTIVE",
              "account HALT blocks a new owned intent",
            ),
          );
        }
        if (authority.value.reconciliationRequired) {
          return fail(
            domainError(
              "UNRESOLVED_STATE",
              "lease takeover requires reconciliation before a new owned intent",
            ),
          );
        }

        const plan = readPlanFromDatabase(
          database,
          this.scope,
          lineageId.value,
        );
        if (!plan.ok) return plan;
        if (
          plan.value === undefined ||
          plan.value.materialHash !== planHash.value
        ) {
          return conflictFailure(
            "owned intent is not bound to the committed plan",
          );
        }
        if (
          !plan.value.material.orderIntents.some(
            (intent) => intent.intentId === intentId.value,
          )
        ) {
          return conflictFailure(
            "owned intent is not present in the committed plan",
          );
        }

        const sameClient = database
          .prepare(
            `SELECT intent_record_id, lineage_id, intent_id, plan_hash, client_order_id, prepared_at
             FROM owned_intents WHERE ${SCOPE_WHERE} AND client_order_id = ?`,
          )
          .get(...scopeValues(this.scope), clientOrderId.value) as
          SqliteRow | undefined;
        if (sameClient !== undefined) {
          const parsed = ownedIntentFromRow(sameClient);
          if (!parsed.ok) return parsed;
          return appendConflictAfterHalt(
            database,
            this.scope,
            "conflicting client order identity",
            now.value,
            "client order ID is already owned by another intent",
          );
        }

        const intentRecordId = deterministicId(
          "intent",
          `${lineageId.value}:${intentId.value}`,
        );
        database
          .prepare(
            `INSERT INTO owned_intents
             (intent_record_id, lineage_id, intent_id, plan_hash, client_order_id, exchange, environment, account_id, category, position_mode, prepared_at, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OWNED')`,
          )
          .run(
            intentRecordId,
            lineageId.value,
            intentId.value,
            planHash.value,
            clientOrderId.value,
            ...scopeValues(this.scope),
            preparedAt.value,
          );
        return ok({
          intentRecordId,
          lineageId: lineageId.value,
          intentId: intentId.value,
          planHash: planHash.value as OwnedIntentRecord["planHash"],
          clientOrderId: clientOrderId.value,
          preparedAt: preparedAt.value,
        });
      },
      "PERSISTENCE_CONFLICT",
    );
  }

  public appendAttempt(request: AppendAttemptRequest): Result<AttemptRecord> {
    const dispatchedAt = validateTimestamp(
      request.dispatchedAt,
      "dispatchedAt",
    );
    if (!dispatchedAt.ok || !isProducedExecutionAttempt(request.attempt)) {
      return fail(
        domainError(
          "PERSISTENCE_INTEGRITY",
          "execution attempt input is invalid",
        ),
      );
    }
    const envelope = encodeCanonicalArtifact(
      "execution-attempt",
      request.attempt,
    );
    if (!envelope.ok) return envelope;
    return runInTransaction(
      this.database,
      (database) => {
        const authority = assertCurrentAuthority(
          database,
          this.scope,
          request.authority,
          dispatchedAt.value,
        );
        if (!authority.ok) return authority;
        const lineage = authorityLineageRow(
          database,
          this.scope,
          request.lineageId,
          request.authority,
        );
        if (!lineage.ok) return lineage;
        const intent = database
          .prepare(
            `SELECT intent_record_id FROM owned_intents
             WHERE ${SCOPE_WHERE} AND lineage_id = ? AND intent_id = ? AND plan_hash = ? AND client_order_id = ?`,
          )
          .get(
            ...scopeValues(this.scope),
            request.lineageId,
            request.attempt.intentId,
            request.attempt.planHash,
            request.attempt.clientOrderId,
          ) as SqliteRow | undefined;
        if (intent === undefined)
          return conflictFailure("attempt has no committed owned intent");

        const existing = database
          .prepare(
            `SELECT attempt_id, lineage_id, submitted_at AS dispatched_at, 'execution-attempt' AS artifact_kind,
             'artifact/v1' AS schema_version, canonical_json, canonical_hash
             FROM execution_attempts WHERE attempt_id = ?`,
          )
          .get(request.attempt.attemptId) as SqliteRow | undefined;
        if (existing !== undefined) {
          const existingHash = storedHash(existing, "canonical_hash");
          const existingLineage = storedIdentifier(existing, "lineage_id");
          if (!existingHash.ok || !existingLineage.ok)
            return persistenceFailure("persisted attempt is invalid");
          if (
            existingLineage.value === request.lineageId &&
            existingHash.value === envelope.value.canonicalHash
          ) {
            return attemptFromRow(existing);
          }
          return appendConflictAfterHalt(
            database,
            this.scope,
            "conflicting execution attempt identity",
            dispatchedAt.value,
            "execution attempt identity conflicts with committed history",
          );
        }

        const storedArtifact = insertArtifact(
          database,
          request.attempt.attemptId,
          envelope.value,
          request.attempt.planHash,
          dispatchedAt.value,
        );
        if (!storedArtifact.ok) return storedArtifact;
        const countRow = database
          .prepare(
            "SELECT COALESCE(MAX(attempt_number), 0) + 1 AS next_number FROM execution_attempts WHERE lineage_id = ?",
          )
          .get(request.lineageId) as SqliteRow | undefined;
        const attemptNumber = countRow?.next_number;
        if (
          typeof attemptNumber !== "number" ||
          !Number.isSafeInteger(attemptNumber)
        ) {
          return persistenceFailure("execution attempt number is invalid");
        }
        database
          .prepare(
            `INSERT INTO execution_attempts
             (attempt_id, lineage_id, intent_record_id, attempt_number, plan_hash, intent_id, client_order_id, submitted_at, acknowledgement, terminal_status, exchange_order_id, canonical_json, canonical_hash)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            request.attempt.attemptId,
            request.lineageId,
            intent.intent_record_id as string,
            attemptNumber,
            request.attempt.planHash,
            request.attempt.intentId,
            request.attempt.clientOrderId,
            request.attempt.submittedAt,
            request.attempt.acknowledgement,
            request.attempt.terminalStatus,
            request.attempt.exchangeOrderId ?? null,
            envelope.value.canonicalJson,
            envelope.value.canonicalHash,
          );
        return ok({
          lineageId: request.lineageId,
          attempt: request.attempt,
          dispatchedAt: dispatchedAt.value,
        });
      },
      "PERSISTENCE_CONFLICT",
    );
  }

  public appendReconciliation(
    request: AppendReconciliationRequest,
  ): Result<ReconciliationRecord> {
    const recordedAt = validateTimestamp(request.recordedAt, "recordedAt");
    if (!recordedAt.ok || !isProducedReconciliationResult(request.result)) {
      return fail(
        domainError("PERSISTENCE_INTEGRITY", "reconciliation input is invalid"),
      );
    }
    const envelope = encodeCanonicalArtifact(
      "reconciliation-result",
      request.result,
    );
    if (!envelope.ok) return envelope;
    return runInTransaction(
      this.database,
      (database) => {
        const lineage = authorityLineageRow(
          database,
          this.scope,
          request.lineageId,
          request.authority,
        );
        if (!lineage.ok) return lineage;
        const attempt = database
          .prepare(
            `SELECT attempt_id, lineage_id, plan_hash, intent_id, client_order_id
             FROM execution_attempts WHERE attempt_id = ?`,
          )
          .get(request.result.attemptId) as SqliteRow | undefined;
        if (attempt === undefined)
          return conflictFailure("reconciliation has no committed attempt");
        const attemptLineage = storedIdentifier(attempt, "lineage_id");
        const attemptPlan = storedHash(attempt, "plan_hash");
        const attemptIntent = storedIdentifier(attempt, "intent_id");
        const attemptClient = storedIdentifier(attempt, "client_order_id");
        if (
          !attemptLineage.ok ||
          !attemptPlan.ok ||
          !attemptIntent.ok ||
          !attemptClient.ok
        ) {
          return persistenceFailure("persisted attempt ownership is invalid");
        }
        if (
          attemptLineage.value !== request.lineageId ||
          attemptPlan.value !== request.result.planHash ||
          attemptIntent.value !== request.result.intentId ||
          attemptClient.value !== request.result.clientOrderId
        ) {
          return appendConflictAfterHalt(
            database,
            this.scope,
            "conflicting reconciliation ownership",
            recordedAt.value,
            "reconciliation does not match the committed attempt owner",
          );
        }

        const duplicate = database
          .prepare(
            `SELECT lineage_id, observed_at AS recorded_at, 'reconciliation-result' AS artifact_kind,
             'artifact/v1' AS schema_version, canonical_json, canonical_hash
             FROM reconciliation_results WHERE lineage_id = ? AND canonical_hash = ?`,
          )
          .get(request.lineageId, envelope.value.canonicalHash) as
          SqliteRow | undefined;
        if (duplicate !== undefined) return reconciliationFromRow(duplicate);

        const storedArtifact = insertArtifact(
          database,
          deterministicId(
            "reconciliation-artifact",
            `${request.lineageId}:${envelope.value.canonicalHash}`,
          ),
          envelope.value,
          request.result.planHash,
          recordedAt.value,
        );
        if (!storedArtifact.ok) return storedArtifact;
        const revisionRow = database
          .prepare(
            "SELECT COALESCE(MAX(revision), 0) + 1 AS next_revision FROM reconciliation_results WHERE lineage_id = ?",
          )
          .get(request.lineageId) as SqliteRow | undefined;
        const revision = revisionRow?.next_revision;
        if (typeof revision !== "number" || !Number.isSafeInteger(revision)) {
          return persistenceFailure("reconciliation revision is invalid");
        }
        const reconciliationId = deterministicId(
          "reconciliation",
          `${request.lineageId}:${envelope.value.canonicalHash}`,
        );
        database
          .prepare(
            `INSERT INTO reconciliation_results
             (reconciliation_id, lineage_id, attempt_id, intent_id, plan_hash, client_order_id, status, observed_at, exchange_order_id, canonical_json, canonical_hash, revision)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            reconciliationId,
            request.lineageId,
            request.result.attemptId,
            request.result.intentId,
            request.result.planHash,
            request.result.clientOrderId,
            request.result.status,
            request.result.observedAt,
            request.result.exchangeOrderId ?? null,
            envelope.value.canonicalJson,
            envelope.value.canonicalHash,
            revision,
          );
        if (
          request.result.status === "PENDING" ||
          request.result.status === "PARTIAL" ||
          request.result.status === "UNRESOLVED"
        ) {
          const raised = addHalt(
            database,
            this.scope,
            `reconciliation status ${request.result.status} requires review`,
            recordedAt.value,
          );
          if (!raised.ok) return raised;
        }
        return ok({
          lineageId: request.lineageId,
          result: request.result,
          recordedAt: recordedAt.value,
        });
      },
      "PERSISTENCE_CONFLICT",
    );
  }

  public acquireLease(request: LeaseRequest): Result<LeaseState> {
    const values = validateLeaseRequest(request, this.scope);
    if (!values.ok) return values;
    return runInTransaction(
      this.database,
      (database) => {
        const existing = leaseRow(database, this.scope);
        if (!existing.ok) return existing;
        if (existing.value !== undefined) {
          if (
            Date.parse(values.value.now) < Date.parse(existing.value.expiresAt)
          ) {
            return fail(
              domainError(
                "RUN_LEASE_HELD",
                "account lease is held by another active run",
                {
                  expiresAt: existing.value.expiresAt,
                },
              ),
            );
          }
          const epoch = existing.value.epoch + 1;
          if (!Number.isSafeInteger(epoch)) {
            return persistenceFailure(
              "lease epoch exceeded the safe integer range",
            );
          }
          database
            .prepare(
              `UPDATE leases SET owner_run_id = ?, epoch = ?, acquired_at = ?, expires_at = ?, reconciliation_required = 1
               WHERE ${SCOPE_WHERE}`,
            )
            .run(
              values.value.ownerRunId,
              epoch,
              values.value.now,
              values.value.expiresAt,
              ...scopeValues(this.scope),
            );
          const raised = addHalt(
            database,
            this.scope,
            "lease takeover requires reconciliation",
            values.value.now,
          );
          if (!raised.ok) return raised;
          return ok(
            leaseState(this.scope, {
              ownerRunId: values.value.ownerRunId,
              epoch,
              acquiredAt: values.value.now,
              expiresAt: values.value.expiresAt,
              reconciliationRequired: true,
            }),
          );
        }
        database
          .prepare(
            `INSERT INTO leases
             (exchange, environment, account_id, category, position_mode, owner_run_id, epoch, acquired_at, expires_at, reconciliation_required)
             VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 0)`,
          )
          .run(
            ...scopeValues(this.scope),
            values.value.ownerRunId,
            values.value.now,
            values.value.expiresAt,
          );
        return ok(
          leaseState(this.scope, {
            ownerRunId: values.value.ownerRunId,
            epoch: 1,
            acquiredAt: values.value.now,
            expiresAt: values.value.expiresAt,
            reconciliationRequired: false,
          }),
        );
      },
      "PERSISTENCE_CONFLICT",
    );
  }

  public renewLease(
    request: LeaseRequest & { readonly authority: LeaseAuthority },
  ): Result<LeaseState> {
    const values = validateLeaseRequest(request, this.scope);
    if (!values.ok) return values;
    const authority = validateAuthority(request.authority);
    if (
      !authority.ok ||
      authority.value.ownerRunId !== values.value.ownerRunId
    ) {
      return fail(domainError("RUN_LEASE_LOST", "lease authority is invalid"));
    }
    return runInTransaction(
      this.database,
      (database) => {
        const current = assertCurrentAuthority(
          database,
          this.scope,
          authority.value,
          values.value.now,
        );
        if (!current.ok) return current;
        database
          .prepare(
            `UPDATE leases SET expires_at = ?
             WHERE ${SCOPE_WHERE} AND owner_run_id = ? AND epoch = ?`,
          )
          .run(
            values.value.expiresAt,
            ...scopeValues(this.scope),
            authority.value.ownerRunId,
            authority.value.epoch,
          );
        return ok(
          leaseState(this.scope, {
            ...current.value,
            expiresAt: values.value.expiresAt,
          }),
        );
      },
      "PERSISTENCE_CONFLICT",
    );
  }

  public releaseLease(authority: LeaseAuthority): Result<void> {
    const parsedAuthority = validateAuthority(authority);
    if (!parsedAuthority.ok) return parsedAuthority;
    return runInTransaction(
      this.database,
      (database) => {
        const current = leaseRow(database, this.scope);
        if (!current.ok) return current;
        if (
          current.value === undefined ||
          current.value.ownerRunId !== parsedAuthority.value.ownerRunId ||
          current.value.epoch !== parsedAuthority.value.epoch
        ) {
          return fail(
            domainError(
              "RUN_LEASE_LOST",
              "current run lease is no longer authoritative",
            ),
          );
        }
        database
          .prepare(
            `DELETE FROM leases WHERE ${SCOPE_WHERE} AND owner_run_id = ? AND epoch = ?`,
          )
          .run(
            ...scopeValues(this.scope),
            parsedAuthority.value.ownerRunId,
            parsedAuthority.value.epoch,
          );
        return ok(undefined);
      },
      "PERSISTENCE_CONFLICT",
    );
  }

  public raiseHalt(
    authority: LeaseAuthority,
    reason: string,
    recordedAt: UtcTimestamp,
  ): Result<HaltState> {
    const timestamp = validateTimestamp(recordedAt, "recordedAt");
    if (!timestamp.ok) return timestamp;
    return runInTransaction(
      this.database,
      (database) => {
        const current = assertCurrentAuthority(
          database,
          this.scope,
          authority,
          timestamp.value,
        );
        if (!current.ok) return current;
        return addHalt(database, this.scope, reason, timestamp.value);
      },
      "PERSISTENCE_CONFLICT",
    );
  }

  public readHalt(): Result<HaltState> {
    try {
      return haltRow(this.database, this.scope);
    } catch (error) {
      return fail(sqliteError(error, "PERSISTENCE_INTEGRITY"));
    }
  }

  public clearHalt(request: HaltClearRequest): Result<HaltState> {
    const expectedRevision = requireFiniteInteger(
      request.expectedHaltRevision,
      "expectedHaltRevision",
    );
    const evidence = createClearanceEvidence(request.evidence);
    if (!expectedRevision.ok || !evidence.ok) {
      return fail(
        domainError("PERSISTENCE_INTEGRITY", "HALT clearance input is invalid"),
      );
    }
    const clearanceArtifact = encodeCanonicalArtifact(
      "clearance-evidence",
      evidence.value,
    );
    if (!clearanceArtifact.ok) return clearanceArtifact;
    return runInTransaction(
      this.database,
      (database) => {
        const currentAuthority = assertCurrentAuthority(
          database,
          this.scope,
          request.authority,
          evidence.value.timestamp,
        );
        if (!currentAuthority.ok) return currentAuthority;
        const halt = haltRow(database, this.scope);
        if (!halt.ok) return halt;
        if (!halt.value.active) {
          return fail(domainError("HALT_ACTIVE", "account HALT is not active"));
        }
        if (halt.value.revision !== expectedRevision.value) {
          return conflictFailure("HALT revision changed before clearance");
        }
        const lineageRevisionRow = database
          .prepare(
            `SELECT COUNT(*) AS revision FROM execution_lineages WHERE ${SCOPE_WHERE}`,
          )
          .get(...scopeValues(this.scope)) as SqliteRow | undefined;
        const reconciliationRevisionRow = database
          .prepare(
            `SELECT COALESCE(MAX(rr.revision), 0) AS revision
             FROM reconciliation_results rr
             INNER JOIN execution_lineages l ON l.lineage_id = rr.lineage_id
             WHERE ${SCOPE_WHERE}`,
          )
          .get(...scopeValues(this.scope)) as SqliteRow | undefined;
        const lineageRevision = lineageRevisionRow?.revision;
        const reconciliationRevision = reconciliationRevisionRow?.revision;
        if (
          typeof lineageRevision !== "number" ||
          typeof reconciliationRevision !== "number" ||
          lineageRevision !== evidence.value.affectedLineageRevision ||
          reconciliationRevision !==
            evidence.value.affectedReconciliationRevision
        ) {
          return conflictFailure(
            "HALT clearance evidence is stale for the current journal revisions",
          );
        }
        const intents = database
          .prepare(
            `SELECT oi.lineage_id, oi.intent_id,
             (SELECT rr.status FROM reconciliation_results rr
              WHERE rr.lineage_id = oi.lineage_id AND rr.intent_id = oi.intent_id
              ORDER BY rr.revision DESC LIMIT 1) AS latest_status
             FROM owned_intents oi
             WHERE ${SCOPE_WHERE}`,
          )
          .all(...scopeValues(this.scope)) as SqliteRow[];
        for (const intent of intents) {
          if (
            intent.latest_status !== "RECONCILED" &&
            intent.latest_status !== "FAILED"
          ) {
            return fail(
              domainError(
                "UNRESOLVED_STATE",
                "every owned intent must have terminal reconciliation before HALT clearance",
              ),
            );
          }
        }
        const storedArtifact = insertArtifact(
          database,
          deterministicId("clearance", clearanceArtifact.value.canonicalHash),
          clearanceArtifact.value,
          undefined,
          evidence.value.timestamp,
        );
        if (!storedArtifact.ok) return storedArtifact;
        const nextRevision = halt.value.revision + 1;
        database
          .prepare(
            `UPDATE halt_state SET active = 0, revision = ?, reason = NULL, raised_at = NULL, reconciliation_required = 0
             WHERE ${SCOPE_WHERE} AND revision = ? AND active = 1`,
          )
          .run(nextRevision, ...scopeValues(this.scope), halt.value.revision);
        database
          .prepare(
            `INSERT INTO halt_events
             (event_id, exchange, environment, account_id, category, position_mode, revision, active, reason, recorded_at, evidence_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
          )
          .run(
            deterministicId(
              "halt-clearance",
              clearanceArtifact.value.canonicalHash,
            ),
            ...scopeValues(this.scope),
            nextRevision,
            evidence.value.reason,
            evidence.value.timestamp,
            clearanceArtifact.value.canonicalJson,
          );
        database
          .prepare(
            `UPDATE leases SET reconciliation_required = 0 WHERE ${SCOPE_WHERE} AND owner_run_id = ? AND epoch = ?`,
          )
          .run(
            ...scopeValues(this.scope),
            currentAuthority.value.ownerRunId,
            currentAuthority.value.epoch,
          );
        return ok({
          scope: this.scope,
          active: false,
          revision: nextRevision,
          reconciliationRequired: false,
        });
      },
      "PERSISTENCE_CONFLICT",
    );
  }
}

export function createSqliteExecutionStore(
  connection: SqliteConnection,
  scope: PersistenceScope,
): Result<SqliteExecutionStore> {
  const validated = validateScope(scope, connection);
  return validated.ok
    ? ok(new SqliteExecutionStore(connection, validated.value))
    : validated;
}
