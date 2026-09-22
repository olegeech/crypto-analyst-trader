import type { DatabaseSync } from "node:sqlite";

import {
  encodeCanonicalArtifact,
  rehydrateArtifact,
  type ArtifactKind,
  type CanonicalArtifactEnvelope,
} from "../../domain/identity/canonical-artifact.js";
import {
  createApproval,
  validateApproval,
  type Approval,
} from "../../domain/execution/approval.js";
import { createClearanceEvidence } from "../../domain/execution/clearance-evidence.js";
import type { ExecutionAttempt } from "../../domain/execution/execution-attempt.js";
import { isProducedExecutionAttempt } from "../../domain/execution/execution-attempt-proof.js";
import {
  createIdentityBinding,
  createIdentityBindingCandidate,
  identityBindingCandidateFromBinding,
  identityBindingCandidateKey,
  identityBindingCandidatesEqual,
  isProducedIdentityBinding,
  type IdentityBindingCandidate,
} from "../../domain/execution/identity-binding.js";
import type { ExchangeOrderObservation } from "../../domain/execution/exchange-order.js";
import type { ReconciliationResult } from "../../domain/execution/reconciliation.js";
import { isProducedReconciliationResult } from "../../domain/execution/reconciliation-proof.js";
import { isProducedExecutionPlan } from "../../domain/planning/plan-proof.js";
import type { ExecutionPlan } from "../../domain/planning/execution-plan.js";
import type { PlanHash } from "../../domain/identity/canonical-serialization.js";
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
  assertCurrentAuthorityWithinTransaction,
  haltRow,
  leaseRow,
  leaseState,
  raiseHaltWithinTransaction,
  validateAuthority,
} from "./sqlite-authority.js";
import {
  AUTHORITY_SCOPE_WHERE,
  authorityScopeValues,
  deterministicId,
  isEnvironment,
  persistenceFailure,
  scopesEqual,
  SCOPE_WHERE,
  scopeValues,
  storedHash,
  storedIdentifier,
  storedOptionalString,
  storedString,
  storedTimestamp,
  trustedNow,
  type SqliteRow,
} from "./sqlite-helpers.js";
import {
  commitTransaction,
  runInTransaction,
  sqliteError,
} from "./transaction.js";
import type {
  AppendAttemptRequest,
  AppendReconciliationRequest,
  AppendIdentityBindingRequest,
  AttemptRecord,
  HaltClearRequest,
  HaltState,
  IdentityBindingOutcome,
  IdentityBindingRecord,
  LeaseAuthority,
  LeaseRequest,
  LeaseState,
  LineageRecord,
  OwnedIntentRecord,
  PersistedArtifact,
  PersistenceScope,
  PersistenceRunSnapshot,
  PrepareIntentRequest,
  PrepareLineageRequest,
  ReconciliationRecord,
} from "../../ports/persistence.js";

const MAX_LEASE_TTL_MS = 24 * 60 * 60 * 1_000;

function conflictFailure(message: string): Result<never> {
  return fail(domainError("PERSISTENCE_CONFLICT", message));
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
       WHERE l.exchange = ? AND l.environment = ? AND l.account_id = ?
         AND l.category = ? AND l.position_mode = ?
         AND a.exchange = l.exchange AND a.environment = l.environment
         AND a.account_id = l.account_id AND a.category = l.category
         AND a.position_mode = l.position_mode
         AND l.lineage_id = ?`,
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

function approvalFromRow(row: SqliteRow): Result<Approval> {
  const envelope = envelopeFromRow(row, "approval");
  if (!envelope.ok) return envelope;
  const approval = rehydrateArtifact("approval", envelope.value);
  if (!approval.ok) {
    return persistenceFailure("persisted approval failed domain rehydration");
  }
  return approval;
}

function approvalRow(
  database: DatabaseSync,
  scope: PersistenceScope,
  lineageId: string,
): SqliteRow | undefined {
  return database
    .prepare(
      `SELECT a.artifact_kind, a.schema_version, a.canonical_json, a.canonical_hash
       FROM approvals p
       INNER JOIN execution_lineages l ON l.lineage_id = p.lineage_id
       INNER JOIN artifacts a ON a.artifact_id = p.approval_id
       WHERE l.exchange = ? AND l.environment = ? AND l.account_id = ?
         AND l.category = ? AND l.position_mode = ?
         AND a.exchange = l.exchange AND a.environment = l.environment
         AND a.account_id = l.account_id AND a.category = l.category
         AND a.position_mode = l.position_mode
         AND l.lineage_id = ?`,
    )
    .get(...scopeValues(scope), lineageId) as SqliteRow | undefined;
}

function readApprovalFromDatabase(
  database: DatabaseSync,
  scope: PersistenceScope,
  lineageId: string,
): Result<Approval | undefined> {
  const row = approvalRow(database, scope, lineageId);
  return row === undefined ? ok(undefined) : approvalFromRow(row);
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

function identityBindingFromRow(row: SqliteRow): Result<IdentityBindingRecord> {
  const bindingId = storedIdentifier(row, "binding_id");
  const lineageId = storedIdentifier(row, "lineage_id");
  const attemptId = storedIdentifier(row, "attempt_id");
  const intentId = storedIdentifier(row, "intent_id");
  const planHash = storedHash(row, "plan_hash");
  const clientOrderId = storedIdentifier(row, "client_order_id");
  const instrument = storedIdentifier(row, "instrument");
  const exchangeOrderId = storedIdentifier(row, "exchange_order_id");
  const exchange = storedIdentifier(row, "exchange");
  const environment = storedString(row, "environment");
  const accountId = storedString(row, "account_id");
  const category = storedIdentifier(row, "category");
  const boundAt = storedTimestamp(row, "bound_at");
  const requestedQuantity = storedString(row, "requested_quantity");
  if (
    !bindingId.ok ||
    !lineageId.ok ||
    !attemptId.ok ||
    !intentId.ok ||
    !planHash.ok ||
    !clientOrderId.ok ||
    !instrument.ok ||
    !exchangeOrderId.ok ||
    !exchange.ok ||
    !environment.ok ||
    !accountId.ok ||
    !category.ok ||
    !boundAt.ok ||
    !requestedQuantity.ok
  ) {
    return persistenceFailure("persisted identity binding is invalid");
  }
  const binding = createIdentityBinding({
    bindingId: bindingId.value,
    lineageId: lineageId.value,
    attemptId: attemptId.value,
    intentId: intentId.value,
    planHash: planHash.value,
    boundAt: boundAt.value,
    exchangeOrderId: exchangeOrderId.value,
    clientOrderId: clientOrderId.value,
    instrument: instrument.value,
    side: row.side,
    requestedQuantity: requestedQuantity.value,
    ownershipContext: {
      exchange: exchange.value,
      environment: environment.value,
      accountId: accountId.value,
      category: category.value,
      positionMode: row.position_mode,
      lineageId: lineageId.value,
      intentId: intentId.value,
      attemptId: attemptId.value,
    },
  });
  if (!binding.ok || !isProducedIdentityBinding(binding.value)) {
    return persistenceFailure("persisted identity binding failed rehydration");
  }
  return binding;
}

function identityBindingRow(
  database: DatabaseSync,
  scope: PersistenceScope,
  lineageId: string,
  attemptId: string,
): SqliteRow | undefined {
  return database
    .prepare(
      `SELECT binding_id, lineage_id, attempt_id, intent_id, plan_hash,
              client_order_id, instrument, side, requested_quantity,
              exchange_order_id, exchange, environment, account_id, category,
              position_mode, bound_at
       FROM execution_identity_bindings
       WHERE ${SCOPE_WHERE} AND lineage_id = ? AND attempt_id = ?`,
    )
    .get(...scopeValues(scope), lineageId, attemptId) as SqliteRow | undefined;
}

function identityBindingRows(
  database: DatabaseSync,
  scope: PersistenceScope,
  lineageId: string,
): SqliteRow[] {
  return database
    .prepare(
      `SELECT binding_id, lineage_id, attempt_id, intent_id, plan_hash,
              client_order_id, instrument, side, requested_quantity,
              exchange_order_id, exchange, environment, account_id, category,
              position_mode, bound_at
       FROM execution_identity_bindings
       WHERE ${SCOPE_WHERE} AND lineage_id = ?
       ORDER BY bound_at, binding_id`,
    )
    .all(...scopeValues(scope), lineageId) as SqliteRow[];
}

function ownedIntentRows(
  database: DatabaseSync,
  scope: PersistenceScope,
  lineageId: string,
): SqliteRow[] {
  return database
    .prepare(
      `SELECT oi.intent_record_id, oi.lineage_id, oi.intent_id, oi.plan_hash,
              oi.client_order_id, oi.prepared_at
       FROM owned_intents oi
       INNER JOIN execution_lineages l ON l.lineage_id = oi.lineage_id
       WHERE l.exchange = ? AND l.environment = ? AND l.account_id = ?
         AND l.category = ? AND l.position_mode = ? AND oi.lineage_id = ?
       ORDER BY oi.prepared_at, oi.intent_id`,
    )
    .all(...scopeValues(scope), lineageId) as SqliteRow[];
}

function validateLeaseRequest(
  request: LeaseRequest,
  scope: PersistenceScope,
  authoritativeNow: UtcTimestamp,
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
  const requestNow = parseUtcTimestamp(request.now);
  const ttlMs = requireFiniteInteger(request.ttlMs, "ttlMs", 1);
  if (
    !ownerRunId.ok ||
    !requestNow.ok ||
    !ttlMs.ok ||
    ttlMs.value > MAX_LEASE_TTL_MS
  ) {
    return fail(domainError("INVALID_ARGUMENT", "lease request is invalid"));
  }
  const expiresAt = timestampFromEpochMs(
    timestampToEpochMs(authoritativeNow) + ttlMs.value,
  );
  if (!expiresAt.ok) return expiresAt;
  return ok({
    ownerRunId: ownerRunId.value,
    now: authoritativeNow,
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
  scope: PersistenceScope,
  artifactId: string,
  envelope: CanonicalArtifactEnvelope,
  materialHash: string | undefined,
  createdAt: UtcTimestamp,
): Result<void> {
  const existing = database
    .prepare(
      `SELECT exchange, environment, account_id, category, position_mode,
              artifact_kind, schema_version, canonical_json, canonical_hash, material_hash
       FROM artifacts WHERE artifact_id = ?`,
    )
    .get(artifactId) as SqliteRow | undefined;
  if (existing !== undefined) {
    const sameScope =
      existing.exchange === scope.exchange &&
      existing.environment === scope.environment &&
      existing.account_id === scope.accountId &&
      existing.category === scope.category &&
      existing.position_mode === scope.positionMode;
    if (!sameScope) {
      return conflictFailure(
        "artifact identity is already bound to a different persistence scope",
      );
    }
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
       (artifact_id, exchange, environment, account_id, category, position_mode,
        artifact_kind, schema_version, canonical_json, canonical_hash, material_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      artifactId,
      ...scopeValues(scope),
      envelope.artifactKind,
      envelope.schemaVersion,
      envelope.canonicalJson,
      envelope.canonicalHash,
      materialHash ?? null,
      createdAt,
    );
  return ok(undefined);
}

function artifactFromRow(
  row: SqliteRow,
  artifactId: string,
): Result<PersistedArtifact> {
  const artifactKind = storedString(row, "artifact_kind");
  const schemaVersion = storedString(row, "schema_version");
  const canonicalJson = storedString(row, "canonical_json");
  const canonicalHash = storedHash(row, "canonical_hash");
  const materialHash = storedOptionalString(row, "material_hash");
  if (
    !artifactKind.ok ||
    !schemaVersion.ok ||
    !canonicalJson.ok ||
    !canonicalHash.ok ||
    !materialHash.ok
  ) {
    return persistenceFailure("persisted SQLite artifact is invalid");
  }
  const envelope: CanonicalArtifactEnvelope = {
    artifactKind: artifactKind.value as ArtifactKind,
    schemaVersion: schemaVersion.value as "artifact/v1",
    canonicalJson: canonicalJson.value,
    canonicalHash: canonicalHash.value,
  };
  const rehydrated = rehydrateArtifact(envelope.artifactKind, envelope);
  if (!rehydrated.ok) {
    return persistenceFailure(
      "persisted SQLite artifact failed domain rehydration",
    );
  }
  const parsedMaterialHash =
    materialHash.value === undefined
      ? ok<string | undefined>(undefined)
      : requireHash(materialHash.value, "materialHash");
  if (!parsedMaterialHash.ok) {
    return persistenceFailure("persisted SQLite material hash is invalid");
  }
  if (parsedMaterialHash.value === undefined) {
    return ok({ artifactId, artifactKind: envelope.artifactKind, envelope });
  }
  return ok({
    artifactId,
    artifactKind: envelope.artifactKind,
    envelope,
    materialHash: parsedMaterialHash.value as PlanHash,
  });
}

interface DurableFactArtifact {
  readonly factKind: string;
  readonly eventIdentity: string;
  readonly artifact: PersistedArtifact;
}

function readDurableFactArtifacts(
  database: DatabaseSync,
  scope: PersistenceScope,
): Result<readonly DurableFactArtifact[]> {
  try {
    const rows = database
      .prepare(
        `SELECT f.fact_kind, f.event_identity,
                a.artifact_id, a.artifact_kind, a.schema_version,
                a.canonical_json, a.canonical_hash, a.material_hash
         FROM accounting_facts f
         INNER JOIN artifacts a
           ON a.artifact_id = f.reference_id
          AND a.exchange = f.exchange
          AND a.environment = f.environment
          AND a.account_id = f.account_id
          AND a.category = f.category
          AND a.position_mode = f.position_mode
         WHERE f.exchange = ? AND f.environment = ? AND f.account_id = ?
           AND f.category = ? AND f.position_mode = ?`,
      )
      .all(...scopeValues(scope)) as SqliteRow[];
    const facts: DurableFactArtifact[] = [];
    for (const row of rows) {
      const factKind = storedString(row, "fact_kind");
      const eventIdentity = storedString(row, "event_identity");
      const artifactId = storedIdentifier(row, "artifact_id");
      if (!factKind.ok || !eventIdentity.ok || !artifactId.ok) {
        return persistenceFailure(
          "persisted accounting fact identity is invalid",
        );
      }
      const artifact = artifactFromRow(row, artifactId.value);
      if (!artifact.ok) return artifact;
      facts.push({
        factKind: factKind.value,
        eventIdentity: eventIdentity.value,
        artifact: artifact.value,
      });
    }
    return ok(facts);
  } catch (error) {
    return fail(sqliteError(error, "PERSISTENCE_INTEGRITY"));
  }
}

function hasDurableAccountingEvidence(
  facts: readonly DurableFactArtifact[],
  lineageId: string,
  exchangeOrderId: string,
  clientOrderId: string,
  intent: ExecutionPlan["material"]["orderIntents"][number],
  attemptIds: ReadonlySet<string>,
): boolean {
  const parentCandidates: ExchangeOrderObservation[] = [];
  for (const fact of facts) {
    if (
      fact.factKind !== "exchange-observation" ||
      !fact.eventIdentity.startsWith(`exchange-parent-${lineageId}-`)
    ) {
      continue;
    }
    const parent = rehydrateArtifact("exchange-order", fact.artifact.envelope);
    if (
      parent.ok &&
      parent.value.exchangeOrderId === exchangeOrderId &&
      parent.value.clientOrderId === clientOrderId &&
      parent.value.instrument === intent.instrument &&
      parent.value.side === intent.side &&
      parent.value.requestedQuantity.compare(intent.quantity) === 0
    ) {
      parentCandidates.push(parent.value);
    }
  }
  const parent = parentCandidates.at(-1);
  if (
    parent === undefined ||
    parent.status !== "filled" ||
    !parent.filledQuantity.isPositive()
  ) {
    return false;
  }

  const fillIds = new Set<string>();
  let total = parent.filledQuantity.subtract(parent.filledQuantity);
  for (const fact of facts) {
    if (fact.factKind !== "fill") continue;
    const fill = rehydrateArtifact("fill", fact.artifact.envelope);
    if (
      fill.ok &&
      "attemptId" in fill.value &&
      "exchangeOrderId" in fill.value &&
      "instrument" in fill.value &&
      "side" in fill.value &&
      "fillId" in fill.value &&
      "quantity" in fill.value &&
      attemptIds.has(fill.value.attemptId) &&
      fill.value.exchangeOrderId === parent.exchangeOrderId &&
      fill.value.instrument === parent.instrument &&
      fill.value.side === parent.side &&
      !fillIds.has(fill.value.fillId)
    ) {
      fillIds.add(fill.value.fillId);
      total = total.add(fill.value.quantity);
    }
  }
  if (fillIds.size === 0 || total.compare(parent.filledQuantity) !== 0) {
    return false;
  }
  const ledgerReferences = new Set<string>();
  for (const fact of facts) {
    if (fact.factKind !== "ledger-entry") continue;
    const ledger = rehydrateArtifact("ledger-entry", fact.artifact.envelope);
    if (
      ledger.ok &&
      "kind" in ledger.value &&
      "referenceId" in ledger.value &&
      ledger.value.kind === "fill" &&
      fillIds.has(ledger.value.referenceId)
    ) {
      ledgerReferences.add(ledger.value.referenceId);
    }
  }
  return [...fillIds].every((fillId) => ledgerReferences.has(fillId));
}

function hasDurableProtectionEvidence(
  facts: readonly DurableFactArtifact[],
  lineageId: string,
  clientOrderId: string,
  intent: ExecutionPlan["material"]["orderIntents"][number],
): boolean {
  const eventPrefix = `exchange-protection-${lineageId}-`;
  const expectedSide = intent.side === "buy" ? "sell" : "buy";
  return facts.some((fact) => {
    if (
      fact.factKind !== "exchange-observation" ||
      !fact.eventIdentity.startsWith(eventPrefix)
    ) {
      return false;
    }
    const child = rehydrateArtifact("exchange-order", fact.artifact.envelope);
    return (
      child.ok &&
      child.value.parentOrderLinkId === clientOrderId &&
      child.value.instrument === intent.instrument &&
      child.value.side === expectedSide &&
      child.value.requestedQuantity.compare(intent.quantity) === 0 &&
      child.value.protectionType === "take-profit" &&
      child.value.status === "open" &&
      child.value.filledQuantity.isZero()
    );
  });
}

function validatePersistedArtifact(
  artifact: PersistedArtifact,
): Result<PersistedArtifact> {
  const artifactId = requireIdentifier(artifact.artifactId, "artifactId");
  const materialHash =
    artifact.materialHash === undefined
      ? ok<string | undefined>(undefined)
      : requireHash(artifact.materialHash, "materialHash");
  if (
    !artifactId.ok ||
    !materialHash.ok ||
    artifact.artifactKind !== artifact.envelope.artifactKind
  ) {
    return persistenceFailure("artifact identity or material hash is invalid");
  }
  const rehydrated = rehydrateArtifact(
    artifact.artifactKind,
    artifact.envelope,
  );
  if (!rehydrated.ok) {
    return persistenceFailure("artifact failed domain rehydration");
  }
  if (materialHash.value === undefined) {
    return ok({
      artifactId: artifactId.value,
      artifactKind: artifact.artifactKind,
      envelope: artifact.envelope,
    });
  }
  return ok({
    artifactId: artifactId.value,
    artifactKind: artifact.artifactKind,
    envelope: artifact.envelope,
    materialHash: materialHash.value as PlanHash,
  });
}

function scopedLineageRow(
  database: DatabaseSync,
  scope: PersistenceScope,
  lineageId: string,
): Result<SqliteRow> {
  const row = lineageRow(database, scope, lineageId);
  if (row === undefined) {
    return conflictFailure("execution lineage does not exist in this scope");
  }
  // The current lease fences the write above. A takeover intentionally changes
  // the lease owner while the durable lineage keeps its original run_id, so
  // recovery facts must remain appendable to that prior lineage.
  return ok(row);
}

function appendConflictAfterHalt<T>(
  database: DatabaseSync,
  scope: PersistenceScope,
  reason: string,
  recordedAt: UtcTimestamp,
  message: string,
) {
  const halted = raiseHaltWithinTransaction(
    database,
    scope,
    reason,
    recordedAt,
  );
  if (!halted.ok) return halted;
  return commitTransaction(
    fail<T>(domainError("PERSISTENCE_CONFLICT", message)),
  );
}

export class SqliteExecutionStore {
  public readonly scope: PersistenceScope;
  private readonly database: DatabaseSync;
  private readonly connection: SqliteConnection;

  public constructor(connection: SqliteConnection, scope: PersistenceScope) {
    this.connection = connection;
    this.database = connection.db;
    this.scope = scope;
  }

  public close(): void {
    this.connection.close();
  }

  public readArtifact(
    artifactId: string,
  ): Result<PersistedArtifact | undefined> {
    const parsedArtifactId = requireIdentifier(artifactId, "artifactId");
    if (!parsedArtifactId.ok) return parsedArtifactId;
    try {
      const row = this.database
        .prepare(
          `SELECT artifact_id, artifact_kind, schema_version, canonical_json, canonical_hash, material_hash
           FROM artifacts
           WHERE artifact_id = ? AND ${SCOPE_WHERE}`,
        )
        .get(parsedArtifactId.value, ...scopeValues(this.scope)) as
        SqliteRow | undefined;
      return row === undefined
        ? ok(undefined)
        : artifactFromRow(row, parsedArtifactId.value);
    } catch (error) {
      return fail(sqliteError(error, "PERSISTENCE_INTEGRITY"));
    }
  }

  public writeArtifact(artifact: PersistedArtifact): Result<void> {
    const validated = validatePersistedArtifact(artifact);
    if (!validated.ok) return validated;
    const createdAt = timestampFromEpochMs(Date.now());
    if (!createdAt.ok) return createdAt;
    return runInTransaction(
      this.database,
      (database) =>
        insertArtifact(
          database,
          this.scope,
          validated.value.artifactId,
          validated.value.envelope,
          validated.value.materialHash,
          createdAt.value,
        ),
      "PERSISTENCE_CONFLICT",
    );
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

  public readApproval(lineageId: string): Result<Approval | undefined> {
    const parsedLineageId = requireIdentifier(lineageId, "lineageId");
    if (!parsedLineageId.ok) return parsedLineageId;
    try {
      return readApprovalFromDatabase(
        this.database,
        this.scope,
        parsedLineageId.value,
      );
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
          `SELECT ea.lineage_id, ea.dispatched_at, 'execution-attempt' AS artifact_kind,
             'artifact/v1' AS schema_version, canonical_json, canonical_hash
           FROM execution_attempts ea
           INNER JOIN execution_lineages l ON l.lineage_id = ea.lineage_id
           WHERE ${SCOPE_WHERE} AND ea.lineage_id = ? ORDER BY ea.attempt_number`,
        )
        .all(...scopeValues(this.scope), lineageId) as SqliteRow[];
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
          `SELECT rr.lineage_id, rr.recorded_at, 'reconciliation-result' AS artifact_kind,
             'artifact/v1' AS schema_version, canonical_json, canonical_hash
           FROM reconciliation_results rr
           INNER JOIN execution_lineages l ON l.lineage_id = rr.lineage_id
           WHERE ${SCOPE_WHERE} AND rr.lineage_id = ? ORDER BY rr.revision`,
        )
        .all(...scopeValues(this.scope), lineageId) as SqliteRow[];
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

  public readIdentityBinding(
    lineageId: string,
    attemptId: string,
  ): Result<IdentityBindingRecord | undefined> {
    const parsedLineageId = requireIdentifier(lineageId, "lineageId");
    const parsedAttemptId = requireIdentifier(attemptId, "attemptId");
    if (!parsedLineageId.ok || !parsedAttemptId.ok) {
      return fail(
        domainError(
          "PERSISTENCE_INTEGRITY",
          "identity binding identity is invalid",
        ),
      );
    }
    try {
      const row = identityBindingRow(
        this.database,
        this.scope,
        parsedLineageId.value,
        parsedAttemptId.value,
      );
      return row === undefined ? ok(undefined) : identityBindingFromRow(row);
    } catch (error) {
      return fail(sqliteError(error, "PERSISTENCE_INTEGRITY"));
    }
  }

  public readIdentityBindings(
    lineageId: string,
  ): Result<readonly IdentityBindingRecord[]> {
    const parsedLineageId = requireIdentifier(lineageId, "lineageId");
    if (!parsedLineageId.ok) return parsedLineageId;
    try {
      const bindings: IdentityBindingRecord[] = [];
      for (const row of identityBindingRows(
        this.database,
        this.scope,
        parsedLineageId.value,
      )) {
        const binding = identityBindingFromRow(row);
        if (!binding.ok) return binding;
        bindings.push(binding.value);
      }
      return ok(bindings);
    } catch (error) {
      return fail(sqliteError(error, "PERSISTENCE_INTEGRITY"));
    }
  }

  public readRun(
    lineageId: string,
  ): Result<PersistenceRunSnapshot | undefined> {
    const parsedLineageId = requireIdentifier(lineageId, "lineageId");
    if (!parsedLineageId.ok) return parsedLineageId;
    try {
      const lineage = this.readLineage(parsedLineageId.value);
      if (!lineage.ok) return lineage;
      if (lineage.value === undefined) return ok(undefined);

      const plan = readPlanFromDatabase(
        this.database,
        this.scope,
        parsedLineageId.value,
      );
      if (!plan.ok) return plan;
      if (plan.value === undefined) {
        return fail(
          domainError(
            "PERSISTENCE_INTEGRITY",
            "committed lineage has no rehydratable execution plan",
          ),
        );
      }
      const approval = readApprovalFromDatabase(
        this.database,
        this.scope,
        parsedLineageId.value,
      );
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
      for (const row of ownedIntentRows(
        this.database,
        this.scope,
        parsedLineageId.value,
      )) {
        const owned = ownedIntentFromRow(row);
        if (!owned.ok) return owned;
        if (
          owned.value.planHash !== plan.value.materialHash ||
          !plan.value.material.orderIntents.some(
            (intent) => intent.intentId === owned.value.intentId,
          )
        ) {
          return persistenceFailure(
            "persisted owned intent is not bound to the committed plan",
          );
        }
        ownedIntents.push(owned.value);
      }

      const attempts = this.readAttempts(parsedLineageId.value);
      if (!attempts.ok) return attempts;
      const identityBindings = this.readIdentityBindings(parsedLineageId.value);
      if (!identityBindings.ok) return identityBindings;
      for (const binding of identityBindings.value) {
        if (
          binding.planHash !== plan.value.materialHash ||
          binding.lineageId !== parsedLineageId.value ||
          !ownedIntents.some(
            (intent) =>
              intent.intentId === binding.intentId &&
              intent.clientOrderId === binding.clientOrderId,
          ) ||
          !attempts.value.some(
            (attempt) =>
              attempt.attempt.attemptId === binding.attemptId &&
              attempt.attempt.intentId === binding.intentId &&
              attempt.attempt.clientOrderId === binding.clientOrderId,
          )
        ) {
          return persistenceFailure(
            "persisted identity binding is not owned by the committed run",
          );
        }
      }
      const reconciliations = this.readReconciliations(parsedLineageId.value);
      if (!reconciliations.ok) return reconciliations;
      const lease = this.readLease();
      if (!lease.ok) return lease;
      const halt = this.readHalt();
      if (!halt.ok) return halt;
      return ok({
        lineage: lineage.value,
        plan: plan.value,
        approval: approval.value,
        ownedIntents,
        attempts: attempts.value,
        identityBindings: identityBindings.value,
        reconciliations: reconciliations.value,
        ...(lease.value === undefined ? {} : { lease: lease.value }),
        halt: halt.value,
      });
    } catch (error) {
      return fail(sqliteError(error, "PERSISTENCE_INTEGRITY"));
    }
  }

  public readRuns(): Result<readonly PersistenceRunSnapshot[]> {
    try {
      const rows = this.database
        .prepare(
          `SELECT lineage_id
           FROM execution_lineages
           WHERE ${SCOPE_WHERE}
           ORDER BY created_at, lineage_id`,
        )
        .all(...scopeValues(this.scope)) as SqliteRow[];
      const runs: PersistenceRunSnapshot[] = [];
      for (const row of rows) {
        const lineageId = storedIdentifier(row, "lineage_id");
        if (!lineageId.ok) {
          return persistenceFailure("persisted lineage identity is invalid");
        }
        const run = this.readRun(lineageId.value);
        if (!run.ok) return run;
        if (run.value !== undefined) runs.push(run.value);
      }
      return ok(runs);
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
          this.scope,
          request.plan.planId,
          planArtifact.value,
          request.plan.materialHash,
          preparedAt.value,
        );
        if (!planStored.ok) return planStored;
        const approvalStored = insertArtifact(
          database,
          this.scope,
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
        const authority = assertCurrentAuthorityWithinTransaction(
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
        const currentTime = trustedNow(database);
        if (!currentTime.ok) return currentTime;
        const approval = readApprovalFromDatabase(
          database,
          this.scope,
          lineageId.value,
        );
        if (!approval.ok) return approval;
        if (approval.value === undefined) {
          return persistenceFailure(
            "committed lineage has no rehydratable approval",
          );
        }
        const validatedApproval = validateApproval(
          approval.value,
          plan.value.materialHash,
          { now: () => currentTime.value },
        );
        if (!validatedApproval.ok) return validatedApproval;

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
        const authority = assertCurrentAuthorityWithinTransaction(
          database,
          this.scope,
          request.authority,
          dispatchedAt.value,
        );
        if (!authority.ok) return authority;
        const lineage = scopedLineageRow(
          database,
          this.scope,
          request.lineageId,
        );
        if (!lineage.ok) return lineage;
        const existing = database
          .prepare(
            `SELECT attempt_id, lineage_id, dispatched_at, 'execution-attempt' AS artifact_kind,
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

        const plan = readPlanFromDatabase(
          database,
          this.scope,
          request.lineageId,
        );
        if (!plan.ok) return plan;
        if (
          plan.value === undefined ||
          plan.value.materialHash !== request.attempt.planHash
        ) {
          return conflictFailure("attempt is not bound to the committed plan");
        }
        const approval = readApprovalFromDatabase(
          database,
          this.scope,
          request.lineageId,
        );
        if (!approval.ok) return approval;
        if (approval.value === undefined) {
          return persistenceFailure(
            "committed lineage has no rehydratable approval",
          );
        }
        if (
          Date.parse(request.attempt.submittedAt) <
            Date.parse(approval.value.approvedAt) ||
          Date.parse(request.attempt.submittedAt) >=
            Date.parse(approval.value.expiresAt)
        ) {
          return fail(
            domainError(
              "PLAN_EXPIRED",
              "execution attempt is not attached to a historically authorized dispatch",
            ),
          );
        }

        const storedArtifact = insertArtifact(
          database,
          this.scope,
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
             (attempt_id, lineage_id, intent_record_id, attempt_number, plan_hash, intent_id, client_order_id, dispatched_at, submitted_at, acknowledgement, terminal_status, exchange_order_id, canonical_json, canonical_hash)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            request.attempt.attemptId,
            request.lineageId,
            intent.intent_record_id as string,
            attemptNumber,
            request.attempt.planHash,
            request.attempt.intentId,
            request.attempt.clientOrderId,
            dispatchedAt.value,
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

  public appendIdentityBinding(
    request: AppendIdentityBindingRequest,
  ): Result<IdentityBindingOutcome> {
    const lineageId = requireIdentifier(request.lineageId, "lineageId");
    const attemptId = requireIdentifier(request.attemptId, "attemptId");
    const boundAt = validateTimestamp(request.boundAt, "boundAt");
    if (!lineageId.ok || !attemptId.ok || !boundAt.ok) {
      return fail(
        domainError(
          "PERSISTENCE_INTEGRITY",
          "identity binding request identity is invalid",
        ),
      );
    }
    const candidateInputs =
      request.candidates ??
      (request.candidate === undefined ? [] : [request.candidate]);
    const candidates: IdentityBindingCandidate[] = [];
    for (const candidateInput of candidateInputs) {
      const candidate = createIdentityBindingCandidate(candidateInput);
      if (!candidate.ok) {
        return fail(
          domainError(
            "OWNERSHIP_MISMATCH",
            "identity binding candidate is invalid",
          ),
        );
      }
      candidates.push(candidate.value);
    }
    return runInTransaction(
      this.database,
      (database) => {
        const authority = assertCurrentAuthorityWithinTransaction(
          database,
          this.scope,
          request.authority,
          boundAt.value,
        );
        if (!authority.ok) return authority;
        const lineage = scopedLineageRow(database, this.scope, lineageId.value);
        if (!lineage.ok) return lineage;
        const attempt = database
          .prepare(
            `SELECT ea.attempt_id, ea.lineage_id, ea.plan_hash, ea.intent_id,
                    ea.client_order_id, ea.exchange_order_id, ea.submitted_at
             FROM execution_attempts ea
             INNER JOIN execution_lineages l ON l.lineage_id = ea.lineage_id
             WHERE ${SCOPE_WHERE} AND ea.lineage_id = ? AND ea.attempt_id = ?`,
          )
          .get(...scopeValues(this.scope), lineageId.value, attemptId.value) as
          SqliteRow | undefined;
        if (attempt === undefined) {
          return conflictFailure(
            "identity binding has no committed execution attempt",
          );
        }
        const attemptLineage = storedIdentifier(attempt, "lineage_id");
        const persistedAttemptId = storedIdentifier(attempt, "attempt_id");
        const attemptPlanHash = storedHash(attempt, "plan_hash");
        const attemptIntentId = storedIdentifier(attempt, "intent_id");
        const attemptClientOrderId = storedIdentifier(
          attempt,
          "client_order_id",
        );
        const persistedExchangeOrderId = storedOptionalString(
          attempt,
          "exchange_order_id",
        );
        const submittedAt = storedTimestamp(attempt, "submitted_at");
        if (
          !attemptLineage.ok ||
          !persistedAttemptId.ok ||
          !attemptPlanHash.ok ||
          !attemptIntentId.ok ||
          !attemptClientOrderId.ok ||
          !persistedExchangeOrderId.ok ||
          !submittedAt.ok
        ) {
          return persistenceFailure("persisted attempt identity is invalid");
        }
        if (
          attemptLineage.value !== lineageId.value ||
          persistedAttemptId.value !== attemptId.value ||
          (request.planHash !== undefined &&
            request.planHash !== attemptPlanHash.value) ||
          (request.intentId !== undefined &&
            request.intentId !== attemptIntentId.value) ||
          (request.clientOrderId !== undefined &&
            request.clientOrderId !== attemptClientOrderId.value)
        ) {
          return conflictFailure("identity binding attempt scope is invalid");
        }
        const plan = readPlanFromDatabase(
          database,
          this.scope,
          lineageId.value,
        );
        if (!plan.ok) return plan;
        if (plan.value === undefined) {
          return persistenceFailure(
            "identity binding lineage has no rehydratable plan",
          );
        }
        const intent = plan.value.material.orderIntents.find(
          (candidate) => candidate.intentId === attemptIntentId.value,
        );
        if (intent === undefined) {
          return conflictFailure(
            "identity binding attempt intent is not in the committed plan",
          );
        }
        if (attemptPlanHash.value !== plan.value.materialHash) {
          return conflictFailure(
            "identity binding attempt is not bound to the committed plan",
          );
        }
        const approval = readApprovalFromDatabase(
          database,
          this.scope,
          lineageId.value,
        );
        if (!approval.ok) return approval;
        if (approval.value === undefined) {
          return persistenceFailure(
            "identity binding lineage has no rehydratable approval",
          );
        }
        if (
          Date.parse(submittedAt.value) <
            Date.parse(approval.value.approvedAt) ||
          Date.parse(submittedAt.value) >= Date.parse(approval.value.expiresAt)
        ) {
          return fail(
            domainError(
              "PLAN_EXPIRED",
              "identity binding is not attached to a historically authorized dispatch",
            ),
          );
        }

        const existingRow = identityBindingRow(
          database,
          this.scope,
          lineageId.value,
          attemptId.value,
        );
        if (existingRow !== undefined) {
          const existing = identityBindingFromRow(existingRow);
          if (!existing.ok) return existing;
          const existingCandidate = identityBindingCandidateFromBinding(
            existing.value,
          );
          const distinctCandidates = new Map<
            string,
            IdentityBindingCandidate
          >();
          for (const candidate of candidates) {
            distinctCandidates.set(
              identityBindingCandidateKey(candidate),
              candidate,
            );
          }
          if (
            distinctCandidates.size === 0 ||
            (distinctCandidates.size === 1 &&
              identityBindingCandidatesEqual(
                [...distinctCandidates.values()][0]!,
                existingCandidate,
              ))
          ) {
            return ok<IdentityBindingOutcome>({
              status: "BOUND",
              binding: existing.value,
              idempotent: true,
            });
          }
          return appendConflictAfterHalt(
            database,
            this.scope,
            "conflicting late exchange identity",
            boundAt.value,
            "attempt identity is already bound to different exchange evidence",
          );
        }

        const distinctCandidates = new Map<string, IdentityBindingCandidate>();
        for (const candidate of candidates) {
          distinctCandidates.set(
            identityBindingCandidateKey(candidate),
            candidate,
          );
        }
        if (distinctCandidates.size === 0) {
          return ok<IdentityBindingOutcome>({
            status: "UNRESOLVED",
            idempotent: false,
          });
        }

        if (distinctCandidates.size > 1) {
          return appendConflictAfterHalt(
            database,
            this.scope,
            "ambiguous late exchange identity",
            boundAt.value,
            "more than one internally consistent exchange identity candidate exists",
          );
        }
        const [candidate] = [...distinctCandidates.values()];
        if (candidate === undefined) {
          return persistenceFailure("identity binding candidate is missing");
        }
        const context = candidate.ownershipContext;
        const ownershipMatches =
          context.exchange === this.scope.exchange &&
          context.environment === this.scope.environment &&
          context.accountId === this.scope.accountId &&
          context.category === this.scope.category &&
          context.positionMode === this.scope.positionMode &&
          context.lineageId === lineageId.value &&
          context.intentId === attemptIntentId.value &&
          context.attemptId === attemptId.value;
        if (
          !ownershipMatches ||
          candidate.clientOrderId !== attemptClientOrderId.value ||
          candidate.clientOrderId !==
            (
              database
                .prepare(
                  `SELECT client_order_id FROM owned_intents
                 WHERE ${SCOPE_WHERE} AND lineage_id = ? AND intent_id = ?`,
                )
                .get(
                  ...scopeValues(this.scope),
                  lineageId.value,
                  attemptIntentId.value,
                ) as SqliteRow | undefined
            )?.client_order_id ||
          candidate.instrument !== intent.instrument ||
          candidate.side !== intent.side ||
          candidate.requestedQuantity.compare(intent.quantity) !== 0 ||
          (persistedExchangeOrderId.value !== undefined &&
            persistedExchangeOrderId.value !== candidate.exchangeOrderId)
        ) {
          return fail(
            domainError(
              "OWNERSHIP_MISMATCH",
              "late exchange identity candidate does not match the committed owner",
            ),
          );
        }

        const existingOrder = database
          .prepare(
            `SELECT binding_id, lineage_id, attempt_id, intent_id, plan_hash,
                    client_order_id, instrument, side, requested_quantity,
                    exchange_order_id, exchange, environment, account_id, category,
                    position_mode, bound_at
             FROM execution_identity_bindings
             WHERE ${SCOPE_WHERE} AND exchange_order_id = ?`,
          )
          .get(...scopeValues(this.scope), candidate.exchangeOrderId) as
          SqliteRow | undefined;
        if (existingOrder !== undefined) {
          return appendConflictAfterHalt(
            database,
            this.scope,
            "exchange identity is already owned",
            boundAt.value,
            "exchange order identity is already bound to another attempt",
          );
        }
        const bindingId = deterministicId(
          "identity-binding",
          `${lineageId.value}:${attemptId.value}:${candidate.exchangeOrderId}`,
        );
        const binding = createIdentityBinding({
          bindingId,
          lineageId: lineageId.value,
          attemptId: attemptId.value,
          intentId: attemptIntentId.value,
          planHash: attemptPlanHash.value,
          boundAt: boundAt.value,
          ...candidate,
        });
        if (!binding.ok || !isProducedIdentityBinding(binding.value)) {
          return persistenceFailure(
            "identity binding failed domain validation",
          );
        }
        database
          .prepare(
            `INSERT INTO execution_identity_bindings
             (binding_id, lineage_id, attempt_id, intent_id, plan_hash,
              client_order_id, instrument, side, requested_quantity,
              exchange_order_id, exchange, environment, account_id, category,
              position_mode, bound_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            binding.value.bindingId,
            binding.value.lineageId,
            binding.value.attemptId,
            binding.value.intentId,
            binding.value.planHash,
            binding.value.clientOrderId,
            binding.value.instrument,
            binding.value.side,
            binding.value.requestedQuantity.toString(),
            binding.value.exchangeOrderId,
            ...scopeValues(this.scope),
            binding.value.boundAt,
          );
        return ok<IdentityBindingOutcome>({
          status: "BOUND",
          binding: binding.value,
          idempotent: false,
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
        const authority = assertCurrentAuthorityWithinTransaction(
          database,
          this.scope,
          request.authority,
          recordedAt.value,
        );
        if (!authority.ok) return authority;
        const lineage = lineageRow(database, this.scope, request.lineageId);
        if (lineage === undefined) {
          return conflictFailure(
            "execution lineage does not exist in this scope",
          );
        }
        const attempt = database
          .prepare(
            `SELECT ea.attempt_id, ea.lineage_id, ea.plan_hash, ea.intent_id,
                    ea.client_order_id, ea.exchange_order_id
             FROM execution_attempts ea
             INNER JOIN execution_lineages l ON l.lineage_id = ea.lineage_id
             WHERE ${SCOPE_WHERE} AND ea.attempt_id = ?`,
          )
          .get(...scopeValues(this.scope), request.result.attemptId) as
          SqliteRow | undefined;
        if (attempt === undefined)
          return conflictFailure("reconciliation has no committed attempt");
        const attemptId = storedIdentifier(attempt, "attempt_id");
        const attemptLineage = storedIdentifier(attempt, "lineage_id");
        const attemptPlan = storedHash(attempt, "plan_hash");
        const attemptIntent = storedIdentifier(attempt, "intent_id");
        const attemptClient = storedIdentifier(attempt, "client_order_id");
        const persistedExchangeOrderId = storedOptionalString(
          attempt,
          "exchange_order_id",
        );
        if (
          !attemptId.ok ||
          !attemptLineage.ok ||
          !attemptPlan.ok ||
          !attemptIntent.ok ||
          !attemptClient.ok ||
          !persistedExchangeOrderId.ok
        ) {
          return persistenceFailure("persisted attempt ownership is invalid");
        }
        const parsedPersistedExchangeOrderId =
          persistedExchangeOrderId.value === undefined
            ? ok<string | undefined>(undefined)
            : requireIdentifier(
                persistedExchangeOrderId.value,
                "exchangeOrderId",
              );
        if (!parsedPersistedExchangeOrderId.ok) {
          return persistenceFailure(
            "persisted attempt exchange order is invalid",
          );
        }
        if (
          attemptId.value !== request.result.attemptId ||
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
        const bindingRow = identityBindingRow(
          database,
          this.scope,
          request.lineageId,
          request.result.attemptId,
        );
        let boundExchangeOrderId: string | undefined;
        if (bindingRow !== undefined) {
          const binding = identityBindingFromRow(bindingRow);
          if (!binding.ok) return binding;
          if (
            binding.value.planHash !== request.result.planHash ||
            binding.value.intentId !== request.result.intentId ||
            binding.value.clientOrderId !== request.result.clientOrderId
          ) {
            return appendConflictAfterHalt(
              database,
              this.scope,
              "conflicting reconciliation binding",
              recordedAt.value,
              "reconciliation does not match the committed late identity binding",
            );
          }
          boundExchangeOrderId = binding.value.exchangeOrderId;
        }
        const effectiveExchangeOrderId =
          parsedPersistedExchangeOrderId.value ?? boundExchangeOrderId;
        if (
          request.result.exchangeOrderId !== undefined &&
          request.result.exchangeOrderId !== effectiveExchangeOrderId
        ) {
          return appendConflictAfterHalt(
            database,
            this.scope,
            "conflicting reconciliation exchange order",
            recordedAt.value,
            "reconciliation exchange order does not match the committed attempt",
          );
        }
        if (
          request.result.status === "RECONCILED" &&
          (request.result.exchangeOrderId === undefined ||
            effectiveExchangeOrderId === undefined)
        ) {
          return appendConflictAfterHalt(
            database,
            this.scope,
            "reconciled result lacks exchange proof",
            recordedAt.value,
            "RECONCILED reconciliation requires the persisted exchange order proof",
          );
        }

        const duplicate = database
          .prepare(
            `SELECT lineage_id, recorded_at, 'reconciliation-result' AS artifact_kind,
             'artifact/v1' AS schema_version, canonical_json, canonical_hash
             FROM reconciliation_results WHERE lineage_id = ? AND canonical_hash = ?`,
          )
          .get(request.lineageId, envelope.value.canonicalHash) as
          SqliteRow | undefined;
        if (duplicate !== undefined) return reconciliationFromRow(duplicate);

        const storedArtifact = insertArtifact(
          database,
          this.scope,
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
             (reconciliation_id, lineage_id, attempt_id, intent_id, plan_hash, client_order_id, status, recorded_at, observed_at, exchange_order_id, canonical_json, canonical_hash, revision)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            reconciliationId,
            request.lineageId,
            request.result.attemptId,
            request.result.intentId,
            request.result.planHash,
            request.result.clientOrderId,
            request.result.status,
            recordedAt.value,
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
          const raised = raiseHaltWithinTransaction(
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
    return runInTransaction(
      this.database,
      (database) => {
        const currentTime = trustedNow(database);
        if (!currentTime.ok) return currentTime;
        const values = validateLeaseRequest(
          request,
          this.scope,
          currentTime.value,
        );
        if (!values.ok) return values;
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
               WHERE ${AUTHORITY_SCOPE_WHERE}`,
            )
            .run(
              values.value.ownerRunId,
              epoch,
              values.value.now,
              values.value.expiresAt,
              ...authorityScopeValues(this.scope),
            );
          const raised = raiseHaltWithinTransaction(
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
    return runInTransaction(
      this.database,
      (database) => {
        const currentTime = trustedNow(database);
        if (!currentTime.ok) return currentTime;
        const values = validateLeaseRequest(
          request,
          this.scope,
          currentTime.value,
        );
        if (!values.ok) return values;
        const authority = validateAuthority(request.authority);
        if (
          !authority.ok ||
          authority.value.ownerRunId !== values.value.ownerRunId
        ) {
          return fail(
            domainError("RUN_LEASE_LOST", "lease authority is invalid"),
          );
        }
        const current = assertCurrentAuthorityWithinTransaction(
          database,
          this.scope,
          authority.value,
          values.value.now,
        );
        if (!current.ok) return current;
        database
          .prepare(
            `UPDATE leases SET expires_at = ?
             WHERE ${AUTHORITY_SCOPE_WHERE} AND owner_run_id = ? AND epoch = ?`,
          )
          .run(
            values.value.expiresAt,
            ...authorityScopeValues(this.scope),
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
        const currentTime = trustedNow(database);
        if (!currentTime.ok) return currentTime;
        const current = assertCurrentAuthorityWithinTransaction(
          database,
          this.scope,
          parsedAuthority.value,
          currentTime.value,
        );
        if (!current.ok) return current;
        if (current.value.reconciliationRequired) {
          return fail(
            domainError(
              "UNRESOLVED_STATE",
              "reconciliation-required lease cannot be released",
            ),
          );
        }
        database
          .prepare(
            `DELETE FROM leases WHERE ${AUTHORITY_SCOPE_WHERE} AND owner_run_id = ? AND epoch = ?`,
          )
          .run(
            ...authorityScopeValues(this.scope),
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
        const current = assertCurrentAuthorityWithinTransaction(
          database,
          this.scope,
          authority,
          timestamp.value,
        );
        if (!current.ok) return current;
        return raiseHaltWithinTransaction(
          database,
          this.scope,
          reason,
          timestamp.value,
        );
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
        const currentAuthority = assertCurrentAuthorityWithinTransaction(
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
            `SELECT COUNT(*) AS revision
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
        const accountingConflictRow = database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM accounting_conflicts c
             WHERE c.exchange = ? AND c.environment = ? AND c.account_id = ? AND c.category = ? AND c.position_mode = ?
               AND NOT EXISTS (
                 SELECT 1
                 FROM accounting_facts original
                 INNER JOIN accounting_facts correction
                   ON correction.linked_fact_id = original.fact_id
                 WHERE original.exchange = ? AND original.environment = ? AND original.account_id = ? AND original.category = ? AND original.position_mode = ?
                   AND correction.exchange = ? AND correction.environment = ? AND correction.account_id = ? AND correction.category = ? AND correction.position_mode = ?
                   AND original.fact_kind = c.fact_kind
                   AND original.event_identity = c.event_identity
                   AND original.canonical_hash = c.existing_hash
                   AND correction.fact_kind = c.fact_kind
                   AND correction.canonical_hash = c.incoming_hash
               )`,
          )
          .get(
            ...scopeValues(this.scope),
            ...scopeValues(this.scope),
            ...scopeValues(this.scope),
          ) as SqliteRow | undefined;
        const accountingConflictCount = accountingConflictRow?.count;
        if (
          typeof accountingConflictCount !== "number" ||
          !Number.isSafeInteger(accountingConflictCount)
        ) {
          return persistenceFailure("accounting conflict count is invalid");
        }
        if (accountingConflictCount > 0) {
          return fail(
            domainError(
              "UNRESOLVED_STATE",
              "unresolved accounting conflicts block HALT clearance",
            ),
          );
        }
        const durableFacts = readDurableFactArtifacts(database, this.scope);
        if (!durableFacts.ok) return durableFacts;
        const intents = database
          .prepare(
            `SELECT oi.lineage_id, oi.intent_id, oi.client_order_id,
             (SELECT rr.status FROM reconciliation_results rr
              WHERE rr.lineage_id = oi.lineage_id AND rr.intent_id = oi.intent_id
              ORDER BY rr.revision DESC LIMIT 1) AS latest_status,
             (SELECT rr.exchange_order_id FROM reconciliation_results rr
              WHERE rr.lineage_id = oi.lineage_id AND rr.intent_id = oi.intent_id
              ORDER BY rr.revision DESC LIMIT 1) AS latest_exchange_order_id
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
          if (intent.latest_status === "RECONCILED") {
            const lineageId = storedIdentifier(intent, "lineage_id");
            const intentId = storedIdentifier(intent, "intent_id");
            const clientOrderId = storedIdentifier(intent, "client_order_id");
            const exchangeOrderId = storedOptionalString(
              intent,
              "latest_exchange_order_id",
            );
            if (
              !lineageId.ok ||
              !intentId.ok ||
              !clientOrderId.ok ||
              !exchangeOrderId.ok ||
              exchangeOrderId.value === undefined
            ) {
              return persistenceFailure(
                "persisted owned intent identity is invalid",
              );
            }
            const plan = readPlanFromDatabase(
              database,
              this.scope,
              lineageId.value,
            );
            if (!plan.ok) return plan;
            if (plan.value === undefined) {
              return fail(
                domainError(
                  "UNRESOLVED_STATE",
                  "reconciled owned intent has no durable execution plan",
                ),
              );
            }
            const orderIntent = plan.value.material.orderIntents.find(
              (candidate) => candidate.intentId === intentId.value,
            );
            if (orderIntent === undefined) {
              return fail(
                domainError(
                  "UNRESOLVED_STATE",
                  "reconciled owned intent is absent from its durable plan",
                ),
              );
            }
            const attemptRows = database
              .prepare(
                `SELECT ea.attempt_id
                 FROM execution_attempts ea
                 INNER JOIN execution_lineages l ON l.lineage_id = ea.lineage_id
                 WHERE l.exchange = ? AND l.environment = ? AND l.account_id = ?
                   AND l.category = ? AND l.position_mode = ?
                   AND ea.lineage_id = ? AND ea.intent_id = ?`,
              )
              .all(
                ...scopeValues(this.scope),
                lineageId.value,
                intentId.value,
              ) as SqliteRow[];
            const attemptIds = new Set<string>();
            for (const attemptRow of attemptRows) {
              const attemptId = storedIdentifier(attemptRow, "attempt_id");
              if (!attemptId.ok) return attemptId;
              attemptIds.add(attemptId.value);
            }
            if (
              !hasDurableAccountingEvidence(
                durableFacts.value,
                lineageId.value,
                exchangeOrderId.value,
                clientOrderId.value,
                orderIntent,
                attemptIds,
              ) ||
              (plan.value.material.strategy.requiresProtection &&
                !hasDurableProtectionEvidence(
                  durableFacts.value,
                  lineageId.value,
                  clientOrderId.value,
                  orderIntent,
                ))
            ) {
              return fail(
                domainError(
                  "UNRESOLVED_STATE",
                  "reconciled owned intent lacks durable accounting or protection evidence",
                ),
              );
            }
          }
        }
        const storedArtifact = insertArtifact(
          database,
          this.scope,
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
             WHERE ${AUTHORITY_SCOPE_WHERE} AND revision = ? AND active = 1`,
          )
          .run(
            nextRevision,
            ...authorityScopeValues(this.scope),
            halt.value.revision,
          );
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
            `UPDATE leases SET reconciliation_required = 0 WHERE ${AUTHORITY_SCOPE_WHERE} AND owner_run_id = ? AND epoch = ?`,
          )
          .run(
            ...authorityScopeValues(this.scope),
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
