import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

import {
  encodeCanonicalArtifact,
  rehydrateArtifact,
  type CanonicalArtifactEnvelope,
} from "../../domain/identity/canonical-artifact.js";
import {
  canonicalSerialize,
  hashCanonical,
  type PlanHash,
} from "../../domain/identity/canonical-serialization.js";
import {
  deriveOperatorMainnetTestSourceId,
  rehydrateOperatorMainnetTestApproval,
  rehydrateOperatorMainnetTestPlan,
  validateOperatorMainnetTestApproval,
  type OperatorMainnetTestApproval,
  type OperatorMainnetTestPlan,
} from "../../domain/execution/operator-mainnet-test-plan.js";
import { domainError } from "../../domain/shared/errors.js";
import { fail, ok, type Result } from "../../domain/shared/result.js";
import {
  parseUtcTimestamp,
  type UtcTimestamp,
} from "../../domain/shared/time.js";
import {
  requireFiniteInteger,
  requireHash,
  requireIdentifier,
  requireSafeText,
} from "../../domain/shared/validation.js";
import type {
  AppendOperatorMainnetTestManualActionRequest,
  AppendOperatorMainnetTestReconciliationRequest,
  OperatorMainnetTestAttemptRecord,
  OperatorMainnetTestCleanupStatus,
  OperatorMainnetTestIntentRecord,
  OperatorMainnetTestLifecycleOutcome,
  OperatorMainnetTestManualActionRecord,
  OperatorMainnetTestPersistencePort,
  OperatorMainnetTestSnapshot,
  OperatorMainnetTestSourceRecord,
  PrepareOperatorMainnetTestCreateRequest,
  RecordOperatorMainnetTestAttemptRequest,
} from "../../ports/operator-mainnet-test-persistence.js";
import type { PersistenceScope } from "../../ports/persistence.js";
import type { SqliteConnection } from "./connection.js";
import {
  assertCurrentAuthorityWithinTransaction,
  haltRow,
  leaseRow,
  leaseState,
  raiseHaltWithinTransaction,
} from "./sqlite-authority.js";
import {
  AUTHORITY_SCOPE_WHERE,
  deterministicId,
  persistenceFailure,
  scopeValues,
  storedHash,
  storedIdentifier,
  storedOptionalString,
  storedString,
  storedTimestamp,
  type SqliteRow,
} from "./sqlite-helpers.js";
import { runInTransaction, sqliteError } from "./transaction.js";

const PLAN_KIND = "operator-mainnet-execution-test" as const;
const APPROVAL_KIND = "operator-mainnet-execution-approval" as const;
const PLAN_ARTIFACT_ID = (hash: string) => `operator-mainnet-test:${hash}`;
const APPROVAL_ARTIFACT_ID = (hash: string) =>
  `operator-mainnet-test-approval:${hash}`;

const invalid = (
  message = "operator Mainnet test persistence input is invalid",
) => fail(domainError("PERSISTENCE_INTEGRITY", message));

function validScope(scope: PersistenceScope): boolean {
  return (
    scope.exchange === "bybit" &&
    scope.environment === "mainnet" &&
    scope.category === "linear" &&
    scope.positionMode === "one-way" &&
    requireHash(scope.accountId, "accountId").ok
  );
}

function encode(value: unknown): Result<{ json: string; hash: PlanHash }> {
  const serialized = canonicalSerialize(value);
  const hash = hashCanonical(value);
  return serialized.ok && hash.ok
    ? ok({ json: serialized.value, hash: hash.value })
    : invalid("operator journal record is not canonical");
}

function hashPayload(json: string): PlanHash {
  return `sha256:${createHash("sha256").update(json, "utf8").digest("hex")}` as PlanHash;
}

function expectedPayload(
  plan: OperatorMainnetTestPlan,
): Record<string, unknown> {
  return {
    category: "linear",
    symbol: plan.symbol,
    side: "Buy",
    orderType: "Limit",
    qty: plan.entry.quantity.toString(),
    price: plan.entry.limitPrice.toString(),
    timeInForce: "GTC",
    positionIdx: 0,
    orderLinkId: plan.clientOrderId,
    reduceOnly: false,
    takeProfit: plan.entry.takeProfit.triggerPrice.toString(),
    tpslMode: "Partial",
    tpOrderType: "Market",
    tpTriggerBy: "LastPrice",
  };
}

function validatePayload(
  plan: OperatorMainnetTestPlan,
  payloadJson: unknown,
  payloadHash: unknown,
): Result<{ json: string; hash: PlanHash }> {
  if (typeof payloadJson !== "string" || payloadJson.length > 16_384)
    return invalid("exact operator CREATE payload is absent or oversized");
  const hash = requireHash(payloadHash, "payloadHash");
  if (!hash.ok || hash.value !== hashPayload(payloadJson))
    return invalid("operator CREATE payload hash does not match its bytes");
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson) as unknown;
  } catch {
    return invalid("operator CREATE payload is malformed");
  }
  const expected = expectedPayload(plan);
  if (
    JSON.stringify(parsed) !== JSON.stringify(expected) ||
    JSON.stringify(expected) !== payloadJson
  )
    return invalid("operator CREATE payload differs from the approved plan");
  return ok({ json: payloadJson, hash: hash.value as PlanHash });
}

function artifactBytes(value: {
  readonly artifactKind: string;
  readonly schemaVersion: string;
  readonly canonicalJson: string;
  readonly canonicalHash: string;
}): Result<CanonicalArtifactEnvelope> {
  if (
    value.schemaVersion !== "artifact/v1" ||
    typeof value.canonicalJson !== "string" ||
    !requireHash(value.canonicalHash, "canonicalHash").ok
  )
    return invalid("operator artifact envelope is malformed");
  const actual = hashPayload(value.canonicalJson);
  if (actual !== value.canonicalHash)
    return invalid("operator artifact bytes do not match their hash");
  return ok(value as CanonicalArtifactEnvelope);
}

function insertArtifact(
  database: DatabaseSync,
  scope: PersistenceScope,
  artifactId: string,
  envelope: CanonicalArtifactEnvelope,
  materialHash: PlanHash,
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
    const same =
      existing.exchange === scope.exchange &&
      existing.environment === scope.environment &&
      existing.account_id === scope.accountId &&
      existing.category === scope.category &&
      existing.position_mode === scope.positionMode &&
      existing.artifact_kind === envelope.artifactKind &&
      existing.schema_version === envelope.schemaVersion &&
      existing.canonical_json === envelope.canonicalJson &&
      existing.canonical_hash === envelope.canonicalHash &&
      existing.material_hash === materialHash;
    return same
      ? ok(undefined)
      : fail(
          domainError(
            "PERSISTENCE_CONFLICT",
            "operator artifact identity is already bound to different bytes or scope",
          ),
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
      materialHash,
      createdAt,
    );
  return ok(undefined);
}

function validateArtifacts(
  planInput: unknown,
  approvalInput: unknown,
  scope: PersistenceScope,
  now: UtcTimestamp,
): Result<{
  plan: OperatorMainnetTestPlan;
  approval: OperatorMainnetTestApproval;
  sourceId: string;
}> {
  const plan = rehydrateOperatorMainnetTestPlan(planInput);
  const approval = rehydrateOperatorMainnetTestApproval(approvalInput);
  if (
    !plan.ok ||
    !approval.ok ||
    !validScope(scope) ||
    plan.value.environment !== "mainnet" ||
    plan.value.accountIdentityHash !== scope.accountId
  )
    return invalid(
      "operator artifacts do not match the scoped Mainnet account",
    );
  const validated = validateOperatorMainnetTestApproval(
    approval.value,
    plan.value,
    approval.value.contentHash,
    now,
  );
  const sourceId = deriveOperatorMainnetTestSourceId(plan.value.contentHash);
  if (
    !validated.ok ||
    !sourceId.ok ||
    approval.value.sourceId !== sourceId.value ||
    approval.value.clientOrderId !== plan.value.clientOrderId
  )
    return invalid("operator approval is not bound to the exact source plan");
  return ok({
    plan: plan.value,
    approval: approval.value,
    sourceId: sourceId.value,
  });
}

function parseJsonHash(json: string, hash: string): Result<unknown> {
  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch {
    return persistenceFailure("persisted operator journal JSON is invalid");
  }
  return hashPayload(json) === hash
    ? ok(value)
    : persistenceFailure("persisted operator journal hash is invalid");
}

export class SqliteOperatorMainnetTestStore implements OperatorMainnetTestPersistencePort {
  private readonly db: DatabaseSync;

  constructor(
    connection: SqliteConnection,
    readonly scope: PersistenceScope,
  ) {
    this.db = connection.db;
  }

  private sourceRow(
    sourceId: string,
    database = this.db,
  ): SqliteRow | undefined {
    return database
      .prepare(
        `SELECT * FROM operator_mainnet_test_sources
         WHERE source_id = ? AND ${AUTHORITY_SCOPE_WHERE}`,
      )
      .get(
        sourceId,
        this.scope.exchange,
        this.scope.environment,
        this.scope.accountId,
      ) as SqliteRow | undefined;
  }

  private sourceFromRow(
    row: SqliteRow,
  ): Result<OperatorMainnetTestSourceRecord> {
    const sourceId = storedIdentifier(row, "source_id");
    const planHash = storedHash(row, "plan_hash");
    const planArtifactId = storedIdentifier(row, "plan_artifact_id");
    const approvalHash = storedHash(row, "approval_hash");
    const approvalArtifactId = storedIdentifier(row, "approval_artifact_id");
    const clientOrderId = storedIdentifier(row, "client_order_id");
    const payloadJson = storedString(row, "payload_json");
    const payloadHash = storedHash(row, "payload_hash");
    const createdAt = storedTimestamp(row, "created_at");
    if (
      row.exchange !== "bybit" ||
      row.environment !== "mainnet" ||
      row.account_id !== this.scope.accountId ||
      row.category !== "linear" ||
      row.position_mode !== "one-way" ||
      !sourceId.ok ||
      !planHash.ok ||
      !planArtifactId.ok ||
      !approvalHash.ok ||
      !approvalArtifactId.ok ||
      !clientOrderId.ok ||
      !payloadJson.ok ||
      !payloadHash.ok ||
      !createdAt.ok
    )
      return persistenceFailure("persisted operator source is invalid");
    let payload: unknown;
    try {
      payload = JSON.parse(payloadJson.value) as unknown;
    } catch {
      return persistenceFailure("persisted operator CREATE payload is invalid");
    }
    if (
      hashPayload(payloadJson.value) !== payloadHash.value ||
      JSON.stringify(payload) !== payloadJson.value
    )
      return persistenceFailure(
        "persisted operator CREATE payload hash is invalid",
      );
    const planArtifact = this.artifactRow(planArtifactId.value);
    const approvalArtifact = this.artifactRow(approvalArtifactId.value);
    if (!planArtifact.ok) return fail(planArtifact.error);
    if (!approvalArtifact.ok) return fail(approvalArtifact.error);
    if (
      planArtifact.value?.artifactKind !== PLAN_KIND ||
      approvalArtifact.value?.artifactKind !== APPROVAL_KIND ||
      planArtifact.value.materialHash !== planHash.value ||
      approvalArtifact.value.materialHash !== approvalHash.value
    )
      return persistenceFailure(
        "operator artifact reference or material hash is invalid",
      );
    const plan = rehydrateArtifact(PLAN_KIND, planArtifact.value.envelope);
    const approval = rehydrateArtifact(
      APPROVAL_KIND,
      approvalArtifact.value.envelope,
    );
    const expectedSourceId = plan.ok
      ? deriveOperatorMainnetTestSourceId(plan.value.contentHash)
      : plan;
    const payloadValidated = plan.ok
      ? validatePayload(plan.value, payloadJson.value, payloadHash.value)
      : plan;
    if (
      !plan.ok ||
      !approval.ok ||
      !expectedSourceId.ok ||
      !payloadValidated.ok ||
      plan.value.contentHash !== planHash.value ||
      approval.value.contentHash !== approvalHash.value ||
      approval.value.planHash !== planHash.value ||
      approval.value.sourceId !== sourceId.value ||
      approval.value.clientOrderId !== clientOrderId.value ||
      plan.value.clientOrderId !== clientOrderId.value ||
      expectedSourceId.value !== sourceId.value
    )
      return persistenceFailure(
        "persisted operator source identity is invalid",
      );
    return ok({
      sourceId: sourceId.value,
      scope: this.scope,
      planHash: planHash.value as PlanHash,
      planArtifactId: planArtifactId.value,
      approvalHash: approvalHash.value as PlanHash,
      approvalArtifactId: approvalArtifactId.value,
      clientOrderId: clientOrderId.value,
      payloadJson: payloadJson.value,
      payloadHash: payloadHash.value as PlanHash,
      createdAt: createdAt.value,
    });
  }

  private artifactRow(artifactId: string): Result<
    | {
        readonly artifactKind: string;
        readonly materialHash: string;
        readonly envelope: CanonicalArtifactEnvelope;
      }
    | undefined
  > {
    const row = this.db
      .prepare(
        `SELECT exchange, environment, account_id, category, position_mode,
                artifact_kind, schema_version, canonical_json, canonical_hash, material_hash
         FROM artifacts WHERE artifact_id = ?`,
      )
      .get(artifactId) as SqliteRow | undefined;
    if (row === undefined) return ok(undefined);
    const materialHash = storedHash(row, "material_hash");
    const envelope = artifactBytes({
      artifactKind: row.artifact_kind as string,
      schemaVersion: row.schema_version as string,
      canonicalJson: row.canonical_json as string,
      canonicalHash: row.canonical_hash as string,
    });
    if (
      row.exchange !== this.scope.exchange ||
      row.environment !== this.scope.environment ||
      row.account_id !== this.scope.accountId ||
      row.category !== this.scope.category ||
      row.position_mode !== this.scope.positionMode ||
      !materialHash.ok ||
      !envelope.ok
    )
      return persistenceFailure("persisted operator artifact scope is invalid");
    const decoded = rehydrateArtifact(
      envelope.value.artifactKind as never,
      envelope.value,
    );
    if (!decoded.ok)
      return persistenceFailure(
        "persisted operator artifact failed rehydration",
      );
    return ok({
      artifactKind: envelope.value.artifactKind,
      materialHash: materialHash.value,
      envelope: envelope.value,
    });
  }

  private intentFromRow(
    row: SqliteRow,
  ): Result<OperatorMainnetTestIntentRecord> {
    const writeIntentId = storedIdentifier(row, "write_intent_id");
    const sourceId = storedIdentifier(row, "source_id");
    const runId = storedIdentifier(row, "run_id");
    const leaseOwnerRunId = storedIdentifier(row, "lease_owner_run_id");
    const canonicalJson = storedString(row, "canonical_json");
    const canonicalHash = storedHash(row, "canonical_hash");
    const preparedAt = storedTimestamp(row, "prepared_at");
    const epoch = requireFiniteInteger(row.lease_epoch, "lease_epoch", 1);
    if (
      row.operation !== "CREATE" ||
      !writeIntentId.ok ||
      !sourceId.ok ||
      !runId.ok ||
      !leaseOwnerRunId.ok ||
      !canonicalJson.ok ||
      !canonicalHash.ok ||
      !preparedAt.ok ||
      !epoch.ok
    )
      return persistenceFailure("persisted operator CREATE intent is invalid");
    const parsed = parseJsonHash(canonicalJson.value, canonicalHash.value);
    if (!parsed.ok) return parsed;
    const encoded = encode(parsed.value);
    if (
      !encoded.ok ||
      encoded.value.json !== canonicalJson.value ||
      encoded.value.hash !== canonicalHash.value ||
      typeof parsed.value !== "object" ||
      parsed.value === null ||
      (parsed.value as Record<string, unknown>).sourceId !== sourceId.value ||
      (parsed.value as Record<string, unknown>).operation !== "CREATE" ||
      (parsed.value as Record<string, unknown>).runId !== runId.value ||
      (parsed.value as Record<string, unknown>).leaseOwnerRunId !==
        leaseOwnerRunId.value ||
      (parsed.value as Record<string, unknown>).leaseEpoch !== epoch.value
    )
      return persistenceFailure("operator CREATE intent identity is invalid");
    return ok({
      writeIntentId: writeIntentId.value,
      sourceId: sourceId.value,
      operation: "CREATE",
      runId: runId.value,
      leaseOwnerRunId: leaseOwnerRunId.value,
      leaseEpoch: epoch.value,
      canonicalJson: canonicalJson.value,
      canonicalHash: canonicalHash.value as PlanHash,
      preparedAt: preparedAt.value,
    });
  }

  private attemptFromRow(
    row: SqliteRow,
  ): Result<OperatorMainnetTestAttemptRecord> {
    const attemptId = storedIdentifier(row, "attempt_id");
    const writeIntentId = storedIdentifier(row, "write_intent_id");
    const exchangeOrderId = storedOptionalString(row, "exchange_order_id");
    const providerReasonCode = storedOptionalString(
      row,
      "provider_reason_code",
    );
    const canonicalJson = storedString(row, "canonical_json");
    const canonicalHash = storedHash(row, "canonical_hash");
    const recordedAt = storedTimestamp(row, "recorded_at");
    if (
      !attemptId.ok ||
      !writeIntentId.ok ||
      !exchangeOrderId.ok ||
      !providerReasonCode.ok ||
      !canonicalJson.ok ||
      !canonicalHash.ok ||
      !recordedAt.ok ||
      !["accepted", "rejected", "ambiguous"].includes(row.outcome as string)
    )
      return persistenceFailure("persisted operator CREATE attempt is invalid");
    const parsed = parseJsonHash(canonicalJson.value, canonicalHash.value);
    if (!parsed.ok) return parsed;
    const encoded = encode(parsed.value);
    if (
      !encoded.ok ||
      encoded.value.json !== canonicalJson.value ||
      encoded.value.hash !== canonicalHash.value ||
      typeof parsed.value !== "object" ||
      parsed.value === null ||
      (parsed.value as Record<string, unknown>).outcome !== row.outcome ||
      (parsed.value as Record<string, unknown>).attemptId !== attemptId.value ||
      (parsed.value as Record<string, unknown>).writeIntentId !==
        writeIntentId.value
    )
      return persistenceFailure("operator CREATE attempt identity is invalid");
    return ok({
      attemptId: attemptId.value,
      writeIntentId: writeIntentId.value,
      outcome: row.outcome as OperatorMainnetTestAttemptRecord["outcome"],
      ...(exchangeOrderId.value === undefined
        ? {}
        : { exchangeOrderId: exchangeOrderId.value }),
      ...(providerReasonCode.value === undefined
        ? {}
        : { providerReasonCode: providerReasonCode.value }),
      canonicalJson: canonicalJson.value,
      canonicalHash: canonicalHash.value as PlanHash,
      recordedAt: recordedAt.value,
    });
  }

  private reconciliationRows(
    sourceId: string,
    database = this.db,
  ): Result<OperatorMainnetTestSnapshot["reconciliations"]> {
    const rows = database
      .prepare(
        `SELECT * FROM operator_mainnet_test_reconciliations
         WHERE source_id = ? ORDER BY revision`,
      )
      .all(sourceId) as SqliteRow[];
    const output: OperatorMainnetTestSnapshot["reconciliations"][number][] = [];
    for (const row of rows) {
      const id = storedIdentifier(row, "reconciliation_id");
      const source = storedIdentifier(row, "source_id");
      const canonicalJson = storedString(row, "canonical_json");
      const canonicalHash = storedHash(row, "canonical_hash");
      const observedAt = storedTimestamp(row, "observed_at");
      const revision = requireFiniteInteger(row.revision, "revision", 1);
      if (
        !id.ok ||
        !source.ok ||
        !canonicalJson.ok ||
        !canonicalHash.ok ||
        !observedAt.ok ||
        !revision.ok ||
        !isLifecycleOutcome(row.lifecycle_outcome) ||
        !isCleanupStatus(row.cleanup_status)
      )
        return persistenceFailure(
          "persisted operator reconciliation is invalid",
        );
      const parsed = parseJsonHash(canonicalJson.value, canonicalHash.value);
      if (!parsed.ok) return parsed;
      const encoded = encode(parsed.value);
      if (
        !encoded.ok ||
        encoded.value.json !== canonicalJson.value ||
        encoded.value.hash !== canonicalHash.value ||
        typeof parsed.value !== "object" ||
        parsed.value === null ||
        (parsed.value as Record<string, unknown>).sourceId !== source.value ||
        (parsed.value as Record<string, unknown>).revision !== revision.value ||
        (parsed.value as Record<string, unknown>).lifecycleOutcome !==
          row.lifecycle_outcome ||
        (parsed.value as Record<string, unknown>).cleanupStatus !==
          row.cleanup_status
      )
        return persistenceFailure(
          "operator reconciliation identity is invalid",
        );
      output.push({
        reconciliationId: id.value,
        sourceId: source.value,
        revision: revision.value,
        lifecycleOutcome: row.lifecycle_outcome,
        cleanupStatus: row.cleanup_status,
        canonicalJson: canonicalJson.value,
        canonicalHash: canonicalHash.value as PlanHash,
        observedAt: observedAt.value,
      });
    }
    return ok(output);
  }

  private manualActionRows(
    sourceId: string,
    database = this.db,
  ): Result<OperatorMainnetTestSnapshot["manualActions"]> {
    const rows = database
      .prepare(
        `SELECT * FROM operator_mainnet_test_manual_actions
         WHERE source_id = ? ORDER BY revision`,
      )
      .all(sourceId) as SqliteRow[];
    const output: OperatorMainnetTestManualActionRecord[] = [];
    for (const row of rows) {
      const actionId = storedIdentifier(row, "action_id");
      const source = storedIdentifier(row, "source_id");
      const canonicalJson = storedString(row, "canonical_json");
      const canonicalHash = storedHash(row, "canonical_hash");
      const declaredAt = storedTimestamp(row, "declared_at");
      const revision = requireFiniteInteger(row.revision, "revision", 1);
      if (
        !actionId.ok ||
        !source.ok ||
        !canonicalJson.ok ||
        !canonicalHash.ok ||
        !declaredAt.ok ||
        !revision.ok ||
        !isManualAction(row.action)
      )
        return persistenceFailure(
          "persisted operator manual action is invalid",
        );
      const parsed = parseJsonHash(canonicalJson.value, canonicalHash.value);
      if (!parsed.ok) return parsed;
      const encoded = encode(parsed.value);
      if (
        !encoded.ok ||
        encoded.value.json !== canonicalJson.value ||
        encoded.value.hash !== canonicalHash.value ||
        typeof parsed.value !== "object" ||
        parsed.value === null ||
        (parsed.value as Record<string, unknown>).sourceId !== source.value ||
        (parsed.value as Record<string, unknown>).revision !== revision.value ||
        (parsed.value as Record<string, unknown>).action !== row.action
      )
        return persistenceFailure("operator manual action identity is invalid");
      output.push({
        actionId: actionId.value,
        sourceId: source.value,
        revision: revision.value,
        action: row.action,
        canonicalJson: canonicalJson.value,
        canonicalHash: canonicalHash.value as PlanHash,
        declaredAt: declaredAt.value,
      });
    }
    return ok(output);
  }

  private snapshot(
    sourceRow: SqliteRow,
    database = this.db,
  ): Result<OperatorMainnetTestSnapshot> {
    const source = this.sourceFromRow(sourceRow);
    if (!source.ok) return source;
    const intentRow = database
      .prepare(
        "SELECT * FROM operator_mainnet_test_write_intents WHERE source_id = ?",
      )
      .get(source.value.sourceId) as SqliteRow | undefined;
    if (!intentRow)
      return persistenceFailure("operator source has no durable CREATE intent");
    const intent = this.intentFromRow(intentRow);
    if (!intent.ok) return intent;
    const attemptRow = database
      .prepare(
        "SELECT * FROM operator_mainnet_test_attempts WHERE write_intent_id = ?",
      )
      .get(intent.value.writeIntentId) as SqliteRow | undefined;
    const attempt = attemptRow
      ? this.attemptFromRow(attemptRow)
      : ok(undefined);
    if (!attempt.ok) return attempt;
    const reconciliations = this.reconciliationRows(
      source.value.sourceId,
      database,
    );
    if (!reconciliations.ok) return reconciliations;
    const manualActions = this.manualActionRows(
      source.value.sourceId,
      database,
    );
    if (!manualActions.ok) return manualActions;
    const halt = haltRow(database, this.scope);
    if (!halt.ok) return halt;
    const lease = leaseRow(database, this.scope);
    if (!lease.ok) return lease;
    return ok({
      source: source.value,
      intent: intent.value,
      ...(attempt.value === undefined ? {} : { attempt: attempt.value }),
      reconciliations: reconciliations.value,
      manualActions: manualActions.value,
      halt: halt.value,
      ...(lease.value === undefined
        ? {}
        : { lease: leaseState(this.scope, lease.value) }),
    });
  }

  private pendingSourceRow(
    database = this.db,
  ): Result<OperatorMainnetTestSourceRecord | undefined> {
    const rows = database
      .prepare(
        `SELECT s.* FROM operator_mainnet_test_sources s
         JOIN operator_mainnet_test_write_intents i ON i.source_id = s.source_id
         WHERE s.exchange = ? AND s.environment = ? AND s.account_id = ?
           AND s.category = ? AND s.position_mode = ?
         ORDER BY s.created_at, s.source_id`,
      )
      .all(...scopeValues(this.scope)) as SqliteRow[];
    for (const row of rows) {
      // Validate the complete persisted source and its canonical reconciliation
      // rows before trusting cleanup status to release the account gate.
      const snapshot = this.snapshot(row, database);
      if (!snapshot.ok) return snapshot;
      const latest = snapshot.value.reconciliations.at(-1);
      if (latest?.cleanupStatus !== "verified-clean")
        return ok(snapshot.value.source);
    }
    return ok(undefined);
  }

  readOperatorMainnetTestSource(
    sourceId: string,
  ): Result<OperatorMainnetTestSnapshot | undefined> {
    const id = requireIdentifier(sourceId, "sourceId");
    if (!id.ok) return id;
    try {
      const row = this.sourceRow(id.value);
      return row ? this.snapshot(row) : ok(undefined);
    } catch (error) {
      return fail(sqliteError(error, "PERSISTENCE_INTEGRITY"));
    }
  }

  findPendingOperatorMainnetTestSource(
    authority: { readonly ownerRunId: string; readonly epoch: number },
    now: UtcTimestamp,
  ): Result<OperatorMainnetTestSourceRecord | undefined> {
    const at = parseUtcTimestamp(now);
    if (!validScope(this.scope) || !at.ok) return invalid();
    return runInTransaction(
      this.db,
      (database) => {
        const current = assertCurrentAuthorityWithinTransaction(
          database,
          this.scope,
          authority,
          at.value,
        );
        if (!current.ok) return current;
        if (current.value.reconciliationRequired)
          return fail(
            domainError(
              "UNRESOLVED_STATE",
              "lease takeover requires reconciliation",
            ),
          );
        return this.pendingSourceRow(database);
      },
      "PERSISTENCE_INTEGRITY",
    );
  }

  prepareCreateIntent(
    request: PrepareOperatorMainnetTestCreateRequest,
  ): Result<OperatorMainnetTestSnapshot> {
    const runId = requireIdentifier(request.runId, "runId");
    const at = parseUtcTimestamp(request.preparedAt);
    if (!runId.ok || !at.ok || !validScope(this.scope)) return invalid();
    const artifacts = validateArtifacts(
      request.plan,
      request.approval,
      this.scope,
      at.value,
    );
    if (!artifacts.ok) return artifacts;
    const payload = validatePayload(
      artifacts.value.plan,
      request.payloadJson,
      request.payloadHash,
    );
    if (!payload.ok) return payload;
    const planEnvelope = encodeCanonicalArtifact(
      PLAN_KIND,
      artifacts.value.plan,
    );
    const approvalEnvelope = encodeCanonicalArtifact(
      APPROVAL_KIND,
      artifacts.value.approval,
    );
    if (!planEnvelope.ok || !approvalEnvelope.ok)
      return invalid("operator artifact encoding failed");
    const planArtifactId = PLAN_ARTIFACT_ID(artifacts.value.plan.contentHash);
    const approvalArtifactId = APPROVAL_ARTIFACT_ID(
      artifacts.value.approval.contentHash,
    );
    const sourceId = artifacts.value.sourceId;
    const writeIntentId = deterministicId(
      "operator-mainnet-test-write",
      `${sourceId}:CREATE`,
    );
    const intentValue = {
      schemaVersion: "operator-mainnet-test-create-intent/v1",
      operation: "CREATE" as const,
      sourceId,
      runId: runId.value,
      leaseOwnerRunId: request.authority.ownerRunId,
      leaseEpoch: request.authority.epoch,
      planHash: artifacts.value.plan.contentHash,
      approvalHash: artifacts.value.approval.contentHash,
      accountIdentityHash: artifacts.value.plan.accountIdentityHash,
      symbol: artifacts.value.plan.symbol,
      clientOrderId: artifacts.value.plan.clientOrderId,
      exactPayloadHash: payload.value.hash,
      expiresAt: artifacts.value.approval.expiresAt,
      preparedAt: at.value,
    };
    const intent = encode(intentValue);
    if (!intent.ok) return intent;
    return runInTransaction(
      this.db,
      (database) => {
        const current = assertCurrentAuthorityWithinTransaction(
          database,
          this.scope,
          request.authority,
          at.value,
        );
        if (!current.ok) return current;
        if (current.value.reconciliationRequired)
          return fail(
            domainError(
              "UNRESOLVED_STATE",
              "lease takeover requires reconciliation",
            ),
          );
        const halt = haltRow(database, this.scope);
        if (!halt.ok) return halt;
        if (halt.value.active)
          return fail(
            domainError(
              "HALT_ACTIVE",
              "HALT blocks a new operator Mainnet CREATE",
            ),
          );
        const pending = this.pendingSourceRow(database);
        if (!pending.ok) return pending;
        if (pending.value)
          return fail(
            domainError(
              "UNRESOLVED_STATE",
              "an earlier operator Mainnet source requires reconciliation",
            ),
          );
        if (this.sourceRow(sourceId, database))
          return fail(
            domainError(
              "PERSISTENCE_CONFLICT",
              "operator source already has a durable intent",
            ),
          );
        const planStored = insertArtifact(
          database,
          this.scope,
          planArtifactId,
          planEnvelope.value,
          artifacts.value.plan.contentHash,
          at.value,
        );
        if (!planStored.ok) return planStored;
        const approvalStored = insertArtifact(
          database,
          this.scope,
          approvalArtifactId,
          approvalEnvelope.value,
          artifacts.value.approval.contentHash,
          at.value,
        );
        if (!approvalStored.ok) return approvalStored;
        database
          .prepare(
            `INSERT INTO operator_mainnet_test_sources
             (source_id, exchange, environment, account_id, category, position_mode,
              plan_hash, plan_artifact_id, approval_hash, approval_artifact_id,
              client_order_id, payload_json, payload_hash, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            sourceId,
            ...scopeValues(this.scope),
            artifacts.value.plan.contentHash,
            planArtifactId,
            artifacts.value.approval.contentHash,
            approvalArtifactId,
            artifacts.value.plan.clientOrderId,
            payload.value.json,
            payload.value.hash,
            at.value,
          );
        database
          .prepare(
            `INSERT INTO operator_mainnet_test_write_intents
             (write_intent_id, source_id, operation, run_id, lease_owner_run_id,
              lease_epoch, canonical_json, canonical_hash, prepared_at)
             VALUES (?, ?, 'CREATE', ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            writeIntentId,
            sourceId,
            runId.value,
            request.authority.ownerRunId,
            request.authority.epoch,
            intent.value.json,
            intent.value.hash,
            at.value,
          );
        const source = this.sourceRow(sourceId, database);
        if (!source)
          return invalid(
            "operator source did not persist with its CREATE intent",
          );
        return this.snapshot(source, database);
      },
      "PERSISTENCE_CONFLICT",
    );
  }

  recordAttemptAndHalt(
    request: RecordOperatorMainnetTestAttemptRequest,
  ): Result<OperatorMainnetTestSnapshot> {
    const sourceId = requireIdentifier(request.sourceId, "sourceId");
    const attemptId = requireIdentifier(request.attemptId, "attemptId");
    const at = parseUtcTimestamp(request.recordedAt);
    const providerReasonCode =
      request.providerReasonCode === undefined
        ? ok<string | undefined>(undefined)
        : requireSafeText(request.providerReasonCode, "providerReasonCode");
    const exchangeOrderId =
      request.exchangeOrderId === undefined
        ? ok<string | undefined>(undefined)
        : requireIdentifier(request.exchangeOrderId, "exchangeOrderId");
    if (
      !sourceId.ok ||
      !attemptId.ok ||
      !at.ok ||
      !providerReasonCode.ok ||
      !exchangeOrderId.ok ||
      !["accepted", "rejected", "ambiguous"].includes(request.outcome)
    )
      return invalid();
    return runInTransaction(
      this.db,
      (database) => {
        const current = assertCurrentAuthorityWithinTransaction(
          database,
          this.scope,
          request.authority,
          at.value,
        );
        if (!current.ok) return current;
        const sourceRow = this.sourceRow(sourceId.value, database);
        if (!sourceRow)
          return fail(
            domainError(
              "PERSISTENCE_CONFLICT",
              "operator source does not exist",
            ),
          );
        const intentRow = database
          .prepare(
            "SELECT * FROM operator_mainnet_test_write_intents WHERE source_id = ?",
          )
          .get(sourceId.value) as SqliteRow | undefined;
        if (!intentRow)
          return persistenceFailure(
            "operator source has no durable CREATE intent",
          );
        const intent = this.intentFromRow(intentRow);
        if (!intent.ok) return intent;
        if (
          intent.value.leaseOwnerRunId !== request.authority.ownerRunId ||
          intent.value.leaseEpoch !== request.authority.epoch
        )
          return fail(
            domainError(
              "RUN_LEASE_LOST",
              "operator CREATE attempt is fenced by another lease",
            ),
          );
        if (
          database
            .prepare(
              "SELECT 1 AS present FROM operator_mainnet_test_attempts WHERE write_intent_id = ?",
            )
            .get(intent.value.writeIntentId)
        )
          return fail(
            domainError(
              "PERSISTENCE_CONFLICT",
              "operator CREATE attempt is already recorded",
            ),
          );
        const attemptValue = {
          schemaVersion: "operator-mainnet-test-create-attempt/v1",
          attemptId: attemptId.value,
          writeIntentId: intent.value.writeIntentId,
          sourceId: sourceId.value,
          outcome: request.outcome,
          ...(exchangeOrderId.value === undefined
            ? {}
            : { exchangeOrderId: exchangeOrderId.value }),
          ...(providerReasonCode.value === undefined
            ? {}
            : { providerReasonCode: providerReasonCode.value }),
          recordedAt: at.value,
        };
        const attempt = encode(attemptValue);
        if (!attempt.ok) return attempt;
        database
          .prepare(
            `INSERT INTO operator_mainnet_test_attempts
             (attempt_id, write_intent_id, outcome, exchange_order_id, provider_reason_code,
              canonical_json, canonical_hash, recorded_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            attemptId.value,
            intent.value.writeIntentId,
            request.outcome,
            exchangeOrderId.value ?? null,
            providerReasonCode.value ?? null,
            attempt.value.json,
            attempt.value.hash,
            at.value,
          );
        const raised = raiseHaltWithinTransaction(
          database,
          this.scope,
          "operator Mainnet CREATE awaits read-only reconciliation",
          at.value,
          attempt.value.json,
        );
        if (!raised.ok) return raised;
        return this.snapshot(sourceRow, database);
      },
      "PERSISTENCE_CONFLICT",
    );
  }

  appendReconciliation(
    request: AppendOperatorMainnetTestReconciliationRequest,
  ): Result<OperatorMainnetTestSnapshot["reconciliations"][number]> {
    const sourceId = requireIdentifier(request.sourceId, "sourceId");
    const at = parseUtcTimestamp(request.observedAt);
    if (
      !sourceId.ok ||
      !at.ok ||
      !isLifecycleOutcome(request.lifecycleOutcome) ||
      !isCleanupStatus(request.cleanupStatus) ||
      (request.lifecycleOutcome === "TP_LIFECYCLE_PASS" &&
        request.cleanupStatus !== "verified-clean")
    )
      return invalid(
        "operator reconciliation outcome and cleanup status conflict",
      );
    return runInTransaction(
      this.db,
      (database) => {
        const current = assertCurrentAuthorityWithinTransaction(
          database,
          this.scope,
          request.authority,
          at.value,
        );
        if (!current.ok) return current;
        const source = this.sourceRow(sourceId.value, database);
        if (!source)
          return fail(
            domainError(
              "PERSISTENCE_CONFLICT",
              "operator source does not exist",
            ),
          );
        const currentRows = database
          .prepare(
            "SELECT MAX(revision) AS revision FROM operator_mainnet_test_reconciliations WHERE source_id = ?",
          )
          .get(sourceId.value) as SqliteRow | undefined;
        const previous = currentRows?.revision;
        const revision = typeof previous === "number" ? previous + 1 : 1;
        if (!Number.isSafeInteger(revision))
          return invalid("operator reconciliation revision is invalid");
        const value = {
          schemaVersion: "operator-mainnet-test-reconciliation/v1",
          sourceId: sourceId.value,
          revision,
          lifecycleOutcome: request.lifecycleOutcome,
          cleanupStatus: request.cleanupStatus,
          evidence: request.evidence,
          observedAt: at.value,
        };
        const encoded = encode(value);
        if (!encoded.ok) return encoded;
        const reconciliationId = deterministicId(
          "operator-mainnet-test-reconciliation",
          `${sourceId.value}:${revision}:${encoded.value.hash}`,
        );
        database
          .prepare(
            `INSERT INTO operator_mainnet_test_reconciliations
           (reconciliation_id, source_id, revision, lifecycle_outcome, cleanup_status,
            canonical_json, canonical_hash, observed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            reconciliationId,
            sourceId.value,
            revision,
            request.lifecycleOutcome,
            request.cleanupStatus,
            encoded.value.json,
            encoded.value.hash,
            at.value,
          );
        const rows = this.reconciliationRows(sourceId.value, database);
        if (!rows.ok) return rows;
        return ok(rows.value.at(-1)!);
      },
      "PERSISTENCE_CONFLICT",
    );
  }

  appendManualAction(
    request: AppendOperatorMainnetTestManualActionRequest,
  ): Result<OperatorMainnetTestSnapshot["manualActions"][number]> {
    const sourceId = requireIdentifier(request.sourceId, "sourceId");
    const at = parseUtcTimestamp(request.declaredAt);
    if (!sourceId.ok || !at.ok || !isManualAction(request.action))
      return invalid();
    return runInTransaction(
      this.db,
      (database) => {
        const current = assertCurrentAuthorityWithinTransaction(
          database,
          this.scope,
          request.authority,
          at.value,
        );
        if (!current.ok) return current;
        const source = this.sourceRow(sourceId.value, database);
        if (!source)
          return fail(
            domainError(
              "PERSISTENCE_CONFLICT",
              "operator source does not exist",
            ),
          );
        const currentRows = database
          .prepare(
            "SELECT MAX(revision) AS revision FROM operator_mainnet_test_manual_actions WHERE source_id = ?",
          )
          .get(sourceId.value) as SqliteRow | undefined;
        const previous = currentRows?.revision;
        const revision = typeof previous === "number" ? previous + 1 : 1;
        if (!Number.isSafeInteger(revision))
          return invalid("operator manual-action revision is invalid");
        const value = {
          schemaVersion: "operator-mainnet-test-manual-action/v1",
          sourceId: sourceId.value,
          revision,
          action: request.action,
          provenance: request.provenance,
          declaredAt: at.value,
        };
        const encoded = encode(value);
        if (!encoded.ok) return encoded;
        const actionId = deterministicId(
          "operator-mainnet-test-manual-action",
          `${sourceId.value}:${revision}:${encoded.value.hash}`,
        );
        database
          .prepare(
            `INSERT INTO operator_mainnet_test_manual_actions
           (action_id, source_id, revision, action, canonical_json, canonical_hash, declared_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            actionId,
            sourceId.value,
            revision,
            request.action,
            encoded.value.json,
            encoded.value.hash,
            at.value,
          );
        const rows = this.manualActionRows(sourceId.value, database);
        if (!rows.ok) return rows;
        return ok(rows.value.at(-1)!);
      },
      "PERSISTENCE_CONFLICT",
    );
  }
}

function isLifecycleOutcome(
  value: unknown,
): value is OperatorMainnetTestLifecycleOutcome {
  return [
    "ENTRY_TP_PROVEN",
    "TP_LIFECYCLE_PASS",
    "NOT_EXERCISED",
    "PARTIAL_EVIDENCE",
    "UNKNOWN",
    "MANUAL_CLEANUP",
  ].includes(value as string);
}

function isCleanupStatus(
  value: unknown,
): value is OperatorMainnetTestCleanupStatus {
  return (
    value === "pending" || value === "verified-clean" || value === "unknown"
  );
}

function isManualAction(
  value: unknown,
): value is OperatorMainnetTestManualActionRecord["action"] {
  return (
    value === "entry-remainder-cancelled" ||
    value === "position-closed" ||
    value === "other"
  );
}

export function createSqliteOperatorMainnetTestStore(
  connection: SqliteConnection,
  scope: PersistenceScope,
): Result<OperatorMainnetTestPersistencePort> {
  if (connection.environment !== "mainnet" || !validScope(scope))
    return invalid(
      "operator journal requires the scoped Mainnet account database",
    );
  try {
    return ok(new SqliteOperatorMainnetTestStore(connection, scope));
  } catch (error) {
    return fail(sqliteError(error, "PERSISTENCE_INTEGRITY"));
  }
}
