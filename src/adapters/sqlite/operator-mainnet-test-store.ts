import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

import {
  encodeCanonicalArtifact,
  rehydrateArtifact,
  type CanonicalArtifactEnvelope,
} from "../../domain/identity/canonical-artifact.js";
import {
  canonicalSerialize,
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
import {
  isTerminalOperatorRecoveryOrderStatus,
  operatorMainnetRecoverySourceRevision,
  OPERATOR_MAINNET_RECOVERY_MAX_AGE_MS,
  createOperatorMainnetRecoveryGrant,
  recoveryGrantEvidenceExpiry,
  rehydrateOperatorMainnetRecoveryAttestation,
  rehydrateOperatorMainnetRecoveryGrant,
  recoveryGrantPlanExpiry,
  validateOperatorMainnetRecoveryAttestationBinding,
  validateOperatorMainnetRecoveryGrantForPlan,
  type OperatorMainnetRecoveryAttestation,
  type OperatorMainnetRecoveryGrant,
} from "../../domain/execution/operator-mainnet-recovery.js";
import { domainError } from "../../domain/shared/errors.js";
import { fail, ok, type Result } from "../../domain/shared/result.js";
import {
  parseUtcTimestamp,
  timestampToEpochMs,
  type UtcTimestamp,
} from "../../domain/shared/time.js";
import {
  isRecord,
  requireFiniteInteger,
  requireHash,
  requireIdentifier,
  requireSafeText,
} from "../../domain/shared/validation.js";
import type {
  AppendOperatorMainnetTestManualActionRequest,
  AppendOperatorMainnetTestReconciliationRequest,
  CreateOperatorMainnetRecoveryGrantRequest,
  OperatorMainnetTestSourceDispositionRecord,
  OperatorMainnetTestAttemptRecord,
  OperatorMainnetTestCleanupStatus,
  OperatorMainnetTestIntentRecord,
  OperatorMainnetTestLifecycleOutcome,
  OperatorMainnetTestManualActionRecord,
  OperatorMainnetTestPersistencePort,
  OperatorMainnetTestSnapshot,
  OperatorMainnetTestSourceRecord,
  OperatorMainnetRecoveryResolutionRequest,
  PrepareOperatorMainnetTestCreateRequest,
  PersistOperatorMainnetRecoveryAttestationRequest,
  RecordOperatorMainnetTestAttemptRequest,
} from "../../ports/operator-mainnet-test-persistence.js";
import type { HaltState, PersistenceScope } from "../../ports/persistence.js";
import type { SqliteConnection } from "./connection.js";
import {
  clearOperatorHaltWithinTransaction,
  haltRow,
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
  return serialized.ok
    ? ok({ json: serialized.value, hash: hashPayload(serialized.value) })
    : invalid("operator journal record is not canonical");
}

function hasLatestApiVerifiedCleanReconciliation(
  snapshot: OperatorMainnetTestSnapshot,
): boolean {
  const latest = snapshot.reconciliations.at(-1);
  if (
    latest === undefined ||
    latest.cleanupStatus !== "verified-clean" ||
    !["TP_LIFECYCLE_PASS", "NOT_EXERCISED", "MANUAL_CLEANUP"].includes(
      latest.lifecycleOutcome,
    )
  )
    return false;
  try {
    const record: unknown = JSON.parse(latest.canonicalJson);
    if (
      !isRecord(record) ||
      record.schemaVersion !== "operator-mainnet-test-reconciliation/v1" ||
      record.sourceId !== snapshot.source.sourceId ||
      record.revision !== latest.revision ||
      record.lifecycleOutcome !== latest.lifecycleOutcome ||
      record.cleanupStatus !== "verified-clean" ||
      record.observedAt !== latest.observedAt ||
      !isRecord(record.evidence)
    )
      return false;
    return (
      record.evidence.schemaVersion ===
        "operator-mainnet-test-status-evidence/v1" &&
      record.evidence.observedAt === latest.observedAt &&
      Number.isSafeInteger(record.evidence.exchangeReads) &&
      (record.evidence.exchangeReads as number) > 0
    );
  } catch {
    return false;
  }
}

function hashPayload(json: string): PlanHash {
  return `sha256:${createHash("sha256").update(json, "utf8").digest("hex")}` as PlanHash;
}

function manualRecoveryOrdersAreTerminal(
  attestation: OperatorMainnetRecoveryAttestation,
): boolean {
  return [
    ...attestation.inspection.sourceOrders,
    ...attestation.inspection.sourceTakeProfitOrders,
  ].every((order) => isTerminalOperatorRecoveryOrderStatus(order.status));
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
  const expectedJson = JSON.stringify(expected);
  if (JSON.stringify(parsed) !== expectedJson || expectedJson !== payloadJson)
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

  persistPreparedPlan(planInput: OperatorMainnetTestPlan): Result<void> {
    const plan = rehydrateOperatorMainnetTestPlan(planInput);
    if (
      !plan.ok ||
      !validScope(this.scope) ||
      plan.value.environment !== "mainnet" ||
      plan.value.accountIdentityHash !== this.scope.accountId
    )
      return invalid("prepared operator plan does not match its account scope");
    const envelope = encodeCanonicalArtifact(PLAN_KIND, plan.value);
    if (!envelope.ok) return envelope;
    const artifactId = PLAN_ARTIFACT_ID(plan.value.contentHash);
    try {
      return runInTransaction(
        this.db,
        (database) =>
          insertArtifact(
            database,
            this.scope,
            artifactId,
            envelope.value,
            plan.value.contentHash,
            plan.value.preparedAt,
          ),
        "PERSISTENCE_CONFLICT",
      );
    } catch (error) {
      return fail(sqliteError(error, "PERSISTENCE_INTEGRITY"));
    }
  }

  readPreparedPlan(
    planHashInput: PlanHash,
  ): Result<OperatorMainnetTestPlan | undefined> {
    const planHash = requireHash(planHashInput, "planHash");
    if (!planHash.ok || !validScope(this.scope)) return invalid();
    const artifact = this.artifactRow(PLAN_ARTIFACT_ID(planHash.value));
    if (!artifact.ok) return artifact;
    if (!artifact.value) return ok(undefined);
    if (
      artifact.value.artifactKind !== PLAN_KIND ||
      artifact.value.materialHash !== planHash.value
    )
      return persistenceFailure(
        "prepared operator plan artifact identity is invalid",
      );
    const plan = rehydrateArtifact(PLAN_KIND, artifact.value.envelope);
    if (
      !plan.ok ||
      plan.value.contentHash !== planHash.value ||
      plan.value.accountIdentityHash !== this.scope.accountId
    )
      return persistenceFailure(
        "prepared operator plan does not match its scope",
      );
    return ok(plan.value);
  }

  private sourceDispositionFromRow(
    row: SqliteRow,
  ): Result<OperatorMainnetTestSourceDispositionRecord> {
    const dispositionId = storedIdentifier(row, "disposition_id");
    const sourceId = storedIdentifier(row, "source_id");
    const grantId = storedIdentifier(row, "grant_id");
    const nextSourceId = storedIdentifier(row, "next_source_id");
    const nextWriteIntentId = storedIdentifier(row, "next_write_intent_id");
    const canonicalJson = storedString(row, "canonical_json");
    const canonicalHash = storedHash(row, "canonical_hash");
    const recordedAt = storedTimestamp(row, "recorded_at");
    const revision = requireFiniteInteger(row.revision, "revision", 1);
    if (
      row.disposition !== "human-attested" ||
      !dispositionId.ok ||
      !sourceId.ok ||
      !grantId.ok ||
      !nextSourceId.ok ||
      !nextWriteIntentId.ok ||
      !canonicalJson.ok ||
      !canonicalHash.ok ||
      !recordedAt.ok ||
      !revision.ok
    )
      return persistenceFailure(
        "persisted operator source disposition is invalid",
      );
    const parsed = parseJsonHash(canonicalJson.value, canonicalHash.value);
    if (!parsed.ok) return parsed;
    const serialized = canonicalSerialize(parsed.value);
    if (
      !serialized.ok ||
      serialized.value !== canonicalJson.value ||
      !isRecord(parsed.value) ||
      parsed.value.schemaVersion !== "operator-mainnet-source-disposition/v1" ||
      parsed.value.sourceId !== sourceId.value ||
      parsed.value.revision !== revision.value ||
      parsed.value.disposition !== "human-attested" ||
      parsed.value.grantId !== grantId.value ||
      parsed.value.nextSourceId !== nextSourceId.value ||
      parsed.value.nextWriteIntentId !== nextWriteIntentId.value
    )
      return persistenceFailure(
        "operator source disposition identity is invalid",
      );
    return ok({
      dispositionId: dispositionId.value,
      sourceId: sourceId.value,
      revision: revision.value,
      disposition: "human-attested",
      grantId: grantId.value,
      nextSourceId: nextSourceId.value,
      nextWriteIntentId: nextWriteIntentId.value,
      canonicalJson: canonicalJson.value,
      canonicalHash: canonicalHash.value as PlanHash,
      recordedAt: recordedAt.value,
    });
  }

  private sourceDispositionRow(
    sourceId: string,
    database = this.db,
  ): Result<OperatorMainnetTestSourceDispositionRecord | undefined> {
    const row = database
      .prepare(
        `SELECT * FROM operator_mainnet_test_source_dispositions
         WHERE source_id = ?`,
      )
      .get(sourceId) as SqliteRow | undefined;
    return row === undefined
      ? ok(undefined)
      : this.sourceDispositionFromRow(row);
  }

  private sourceRevision(snapshot: OperatorMainnetTestSnapshot): number {
    return operatorMainnetRecoverySourceRevision(snapshot);
  }

  private recoveryAttestationFromRow(
    row: SqliteRow,
  ): Result<OperatorMainnetRecoveryAttestation> {
    const attestationHash = storedHash(row, "attestation_hash");
    const attestationId = storedIdentifier(row, "attestation_id");
    const sourceId = storedIdentifier(row, "source_id");
    const canonicalJson = storedString(row, "canonical_json");
    const canonicalHash = storedHash(row, "canonical_hash");
    const revision = requireFiniteInteger(
      row.source_revision,
      "source_revision",
    );
    const observedAt = storedTimestamp(row, "observed_at");
    if (
      row.exchange !== this.scope.exchange ||
      row.environment !== this.scope.environment ||
      row.account_id !== this.scope.accountId ||
      row.category !== this.scope.category ||
      row.position_mode !== this.scope.positionMode ||
      !attestationHash.ok ||
      !attestationId.ok ||
      !sourceId.ok ||
      !canonicalJson.ok ||
      !canonicalHash.ok ||
      !revision.ok ||
      !observedAt.ok
    )
      return persistenceFailure(
        "persisted operator recovery attestation is invalid",
      );
    const parsed = parseJsonHash(canonicalJson.value, canonicalHash.value);
    if (!parsed.ok) return parsed;
    const canonical = canonicalSerialize(parsed.value);
    if (!canonical.ok || canonical.value !== canonicalJson.value)
      return persistenceFailure(
        "operator recovery attestation is not canonical",
      );
    const attestation = rehydrateOperatorMainnetRecoveryAttestation(
      parsed.value,
    );
    if (
      !attestation.ok ||
      attestation.value.contentHash !== attestationHash.value ||
      attestation.value.attestationId !== attestationId.value ||
      attestation.value.sourceId !== sourceId.value ||
      attestation.value.sourceRevision !== revision.value ||
      attestation.value.observedAt !== observedAt.value
    )
      return persistenceFailure(
        "operator recovery attestation identity is invalid",
      );
    return attestation;
  }

  private recoveryAttestationRow(
    attestationHash: string,
    database = this.db,
  ): Result<OperatorMainnetRecoveryAttestation | undefined> {
    const row = database
      .prepare(
        `SELECT * FROM operator_mainnet_recovery_attestations
         WHERE attestation_hash = ? AND exchange = ? AND environment = ? AND account_id = ?`,
      )
      .get(
        attestationHash,
        this.scope.exchange,
        this.scope.environment,
        this.scope.accountId,
      ) as SqliteRow | undefined;
    return row === undefined
      ? ok(undefined)
      : this.recoveryAttestationFromRow(row);
  }

  private recoveryGrantFromRow(
    row: SqliteRow,
  ): Result<OperatorMainnetRecoveryGrant> {
    const grantId = storedIdentifier(row, "grant_id");
    const sourceId = storedIdentifier(row, "source_id");
    const planHash = storedHash(row, "plan_hash");
    const canonicalJson = storedString(row, "canonical_json");
    const canonicalHash = storedHash(row, "canonical_hash");
    if (
      row.exchange !== this.scope.exchange ||
      row.environment !== this.scope.environment ||
      row.account_id !== this.scope.accountId ||
      row.category !== this.scope.category ||
      row.position_mode !== this.scope.positionMode ||
      !grantId.ok ||
      !sourceId.ok ||
      !planHash.ok ||
      !canonicalJson.ok ||
      !canonicalHash.ok
    )
      return persistenceFailure("persisted operator recovery grant is invalid");
    const parsed = parseJsonHash(canonicalJson.value, canonicalHash.value);
    if (!parsed.ok) return parsed;
    const canonical = canonicalSerialize(parsed.value);
    if (!canonical.ok || canonical.value !== canonicalJson.value)
      return persistenceFailure("operator recovery grant is not canonical");
    const grant = rehydrateOperatorMainnetRecoveryGrant(parsed.value);
    if (
      !grant.ok ||
      grant.value.grantId !== grantId.value ||
      grant.value.sourceId !== sourceId.value ||
      grant.value.planHash !== planHash.value ||
      grant.value.haltRevision !== row.halt_revision ||
      grant.value.sourceRevision !== row.source_revision ||
      grant.value.resolution.kind !== row.resolution_kind ||
      (grant.value.resolution.kind === "api-resolved" &&
        grant.value.resolution.evidenceHash !== row.evidence_hash) ||
      (grant.value.resolution.kind === "manual-attested" &&
        grant.value.resolution.attestationHash !== row.attestation_hash) ||
      grant.value.haltOrigin?.eventId !==
        (row.halt_origin_event_id ?? undefined) ||
      grant.value.haltOrigin?.revision !==
        (row.halt_origin_revision ?? undefined)
    )
      return persistenceFailure("operator recovery grant identity is invalid");
    return grant;
  }

  private recoveryGrantRow(
    grantId: string,
    database = this.db,
  ): Result<OperatorMainnetRecoveryGrant | undefined> {
    const row = database
      .prepare(
        `SELECT * FROM operator_mainnet_recovery_grants
         WHERE grant_id = ? AND exchange = ? AND environment = ? AND account_id = ?`,
      )
      .get(
        grantId,
        this.scope.exchange,
        this.scope.environment,
        this.scope.accountId,
      ) as SqliteRow | undefined;
    return row === undefined ? ok(undefined) : this.recoveryGrantFromRow(row);
  }

  persistOperatorMainnetRecoveryAttestation(
    request: PersistOperatorMainnetRecoveryAttestationRequest,
  ): Result<OperatorMainnetRecoveryAttestation> {
    const at = parseUtcTimestamp(request.recordedAt);
    const attestation = rehydrateOperatorMainnetRecoveryAttestation(
      request.attestation,
    );
    if (!at.ok || !attestation.ok || !validScope(this.scope)) return invalid();
    if (
      timestampToEpochMs(attestation.value.observedAt) >
      timestampToEpochMs(at.value)
    )
      return invalid("manual UI observation cannot be future dated");
    return runInTransaction(
      this.db,
      (database) => {
        const sourceRow = this.sourceRow(attestation.value.sourceId, database);
        if (!sourceRow)
          return fail(
            domainError(
              "PERSISTENCE_CONFLICT",
              "manual recovery source does not exist",
            ),
          );
        const snapshot = this.snapshot(sourceRow, database);
        if (!snapshot.ok) return snapshot;
        const currentRevision = this.sourceRevision(snapshot.value);
        const binding = validateOperatorMainnetRecoveryAttestationBinding(
          attestation.value,
          {
            accountIdentityHash: this.scope.accountId,
            sourceId: snapshot.value.source.sourceId,
            sourcePlanHash: snapshot.value.source.planHash,
            sourceIntentId: snapshot.value.intent.writeIntentId,
            sourceRevision: currentRevision,
            entryClientOrderId: snapshot.value.source.clientOrderId,
          },
        );
        if (!binding.ok) return binding;
        const encoded = encode(binding.value);
        if (!encoded.ok) return encoded;
        const existing = this.recoveryAttestationRow(
          binding.value.contentHash,
          database,
        );
        if (!existing.ok) return existing;
        if (existing.value) {
          const same =
            existing.value.attestationId === binding.value.attestationId &&
            existing.value.contentHash === binding.value.contentHash;
          return same
            ? ok(existing.value)
            : fail(
                domainError(
                  "PERSISTENCE_CONFLICT",
                  "manual recovery attestation hash is already bound",
                ),
              );
        }
        database
          .prepare(
            `INSERT INTO operator_mainnet_recovery_attestations
             (attestation_hash, attestation_id, exchange, environment, account_id,
              category, position_mode, source_id, source_revision, observed_at,
              canonical_json, canonical_hash, recorded_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            binding.value.contentHash,
            binding.value.attestationId,
            ...scopeValues(this.scope),
            binding.value.sourceId,
            binding.value.sourceRevision,
            binding.value.observedAt,
            encoded.value.json,
            encoded.value.hash,
            at.value,
          );
        return ok(binding.value);
      },
      "PERSISTENCE_CONFLICT",
    );
  }

  readOperatorMainnetRecoveryAttestation(
    attestationHashInput: PlanHash,
  ): Result<OperatorMainnetRecoveryAttestation | undefined> {
    const hash = requireHash(attestationHashInput, "attestationHash");
    if (!hash.ok || !validScope(this.scope)) return invalid();
    try {
      return this.recoveryAttestationRow(hash.value);
    } catch (error) {
      return fail(sqliteError(error, "PERSISTENCE_INTEGRITY"));
    }
  }

  private latestRecoveryGrantForSource(
    sourceId: string,
    database = this.db,
  ): Result<OperatorMainnetRecoveryGrant | undefined> {
    const row = database
      .prepare(
        `SELECT * FROM operator_mainnet_recovery_grants
         WHERE source_id = ? AND exchange = ? AND environment = ? AND account_id = ?
         ORDER BY rowid DESC LIMIT 1`,
      )
      .get(
        sourceId,
        this.scope.exchange,
        this.scope.environment,
        this.scope.accountId,
      ) as SqliteRow | undefined;
    return row === undefined ? ok(undefined) : this.recoveryGrantFromRow(row);
  }

  private validateHaltOriginForSource(
    event: SqliteRow,
    snapshot: OperatorMainnetTestSnapshot,
  ): Result<{
    readonly eventId: string;
    readonly revision: number;
    readonly originHash: PlanHash;
  }> {
    const eventId = storedIdentifier(event, "event_id");
    const revision = requireFiniteInteger(event.revision, "revision", 1);
    const evidenceJson = storedOptionalString(event, "evidence_json");
    if (
      !eventId.ok ||
      !revision.ok ||
      !evidenceJson.ok ||
      evidenceJson.value === undefined
    )
      return fail(
        domainError(
          "HALT_ACTIVE",
          "HALT origin is missing or uncorrelated; inspect the saved source and intent before recovery",
        ),
      );
    const evidenceHash = hashPayload(evidenceJson.value);
    const parsed = parseJsonHash(evidenceJson.value, evidenceHash);
    if (!parsed.ok)
      return fail(
        domainError(
          "HALT_ACTIVE",
          "saved HALT origin failed integrity validation",
        ),
      );
    const serialized = canonicalSerialize(parsed.value);
    if (
      !serialized.ok ||
      serialized.value !== evidenceJson.value ||
      !isRecord(parsed.value)
    )
      return fail(
        domainError("HALT_ACTIVE", "saved HALT origin is not canonical"),
      );
    const evidence = parsed.value;
    if (evidence.schemaVersion === "operator-mainnet-test-create-attempt/v1") {
      const attempt = snapshot.attempt;
      if (
        attempt === undefined ||
        attempt.canonicalJson !== evidenceJson.value ||
        attempt.writeIntentId !== snapshot.intent.writeIntentId ||
        evidence.sourceId !== snapshot.source.sourceId ||
        evidence.writeIntentId !== snapshot.intent.writeIntentId
      )
        return fail(
          domainError(
            "HALT_ACTIVE",
            "legacy HALT attempt cannot be matched to immutable source and intent evidence",
          ),
        );
    } else if (evidence.schemaVersion === "operator-mainnet-halt-origin/v1") {
      const trigger = evidence.trigger;
      if (
        evidence.sourceId !== snapshot.source.sourceId ||
        evidence.writeIntentId !== snapshot.intent.writeIntentId ||
        evidence.sourcePlanHash !== snapshot.source.planHash ||
        evidence.intentCanonicalHash !== snapshot.intent.canonicalHash ||
        !isRecord(trigger)
      )
        return fail(
          domainError(
            "HALT_ACTIVE",
            "HALT origin does not match the immutable source and intent",
          ),
        );
      if (trigger.kind === "ambiguous-create-attempt") {
        const attempt = snapshot.attempt;
        if (
          attempt === undefined ||
          attempt.outcome !== "ambiguous" ||
          trigger.attemptId !== attempt.attemptId ||
          trigger.attemptCanonicalJson !== attempt.canonicalJson ||
          trigger.attemptCanonicalHash !== attempt.canonicalHash
        )
          return fail(
            domainError(
              "HALT_ACTIVE",
              "HALT attempt origin cannot be matched to the saved attempt",
            ),
          );
      } else if (trigger.kind === "status-unknown") {
        const linked = snapshot.reconciliations.find(
          (reconciliation) =>
            reconciliation.revision === trigger.reconciliationRevision,
        );
        if (
          linked === undefined ||
          linked.lifecycleOutcome !== "UNKNOWN" ||
          linked.cleanupStatus !== "unknown" ||
          trigger.reconciliationCanonicalJson !== linked.canonicalJson ||
          trigger.reconciliationCanonicalHash !== linked.canonicalHash
        )
          return fail(
            domainError(
              "HALT_ACTIVE",
              "HALT status origin cannot be matched to the saved reconciliation",
            ),
          );
      } else if (
        trigger.kind !== "operator-source-halt" ||
        typeof trigger.reason !== "string" ||
        typeof trigger.recordedAt !== "string"
      ) {
        return fail(
          domainError(
            "HALT_ACTIVE",
            "HALT origin type is unsupported; keep HALT active and inspect the account manually",
          ),
        );
      }
    } else {
      return fail(
        domainError(
          "HALT_ACTIVE",
          "HALT origin type is unsupported; keep HALT active and inspect the account manually",
        ),
      );
    }
    return ok({
      eventId: eventId.value,
      revision: revision.value,
      originHash: evidenceHash,
    });
  }

  private activeHaltOrigin(
    snapshot: OperatorMainnetTestSnapshot,
    database: DatabaseSync,
  ): Result<{
    readonly eventId: string;
    readonly revision: number;
    readonly originHash: PlanHash;
  }> {
    const state = haltRow(database, this.scope);
    if (!state.ok) return state;
    if (!state.value.active)
      return fail(
        domainError("HALT_ACTIVE", "no active HALT origin is available"),
      );
    const rows = database
      .prepare(
        `SELECT * FROM halt_events
         WHERE exchange = ? AND environment = ? AND account_id = ? AND revision <= ?
         ORDER BY revision`,
      )
      .all(
        this.scope.exchange,
        this.scope.environment,
        this.scope.accountId,
        state.value.revision,
      ) as SqliteRow[];
    let lastClearanceIndex = -1;
    for (const [index, row] of rows.entries()) {
      if (row.active === 0) lastClearanceIndex = index;
    }
    const activeRows = rows
      .slice(lastClearanceIndex + 1)
      .filter((row) => row.active === 1);
    if (
      activeRows.length === 0 ||
      rows.at(-1)?.revision !== state.value.revision ||
      rows.at(-1)?.active !== 1
    )
      return fail(
        domainError(
          "HALT_ACTIVE",
          "active HALT event history is incomplete; keep the account blocked",
        ),
      );
    let current:
      | {
          readonly eventId: string;
          readonly revision: number;
          readonly originHash: PlanHash;
        }
      | undefined;
    for (const event of activeRows) {
      const origin = this.validateHaltOriginForSource(event, snapshot);
      if (!origin.ok) return origin;
      current = origin.value;
    }
    return current
      ? ok(current)
      : fail(domainError("HALT_ACTIVE", "active HALT origin is unavailable"));
  }

  private latestApiResolution(
    snapshot: OperatorMainnetTestSnapshot,
    resolution: OperatorMainnetRecoveryResolutionRequest,
    issuedAt: UtcTimestamp,
  ): Result<{
    readonly evidenceHash: PlanHash;
    readonly observedAt: UtcTimestamp;
  }> {
    if (resolution.kind !== "api-resolved")
      return fail(
        domainError("INVALID_EVIDENCE", "API reconciliation proof is required"),
      );
    const reconciliationId = requireIdentifier(
      resolution.reconciliationId,
      "reconciliationId",
    );
    const reconciliationHash = requireHash(
      resolution.reconciliationHash,
      "reconciliationHash",
    );
    const latest = snapshot.reconciliations.at(-1);
    if (
      !reconciliationId.ok ||
      !reconciliationHash.ok ||
      latest === undefined ||
      latest.reconciliationId !== reconciliationId.value ||
      latest.canonicalHash !== reconciliationHash.value ||
      latest.cleanupStatus !== "verified-clean" ||
      latest.lifecycleOutcome === "UNKNOWN" ||
      timestampToEpochMs(issuedAt) < timestampToEpochMs(latest.observedAt) ||
      timestampToEpochMs(issuedAt) - timestampToEpochMs(latest.observedAt) >
        OPERATOR_MAINNET_RECOVERY_MAX_AGE_MS
    )
      return fail(
        domainError(
          "UNRESOLVED_STATE",
          "fresh API cleanup proof is unavailable; run GET-only status and use the exact verified-clean result",
        ),
      );
    return ok({
      evidenceHash: latest.canonicalHash,
      observedAt: latest.observedAt,
    });
  }

  createOperatorMainnetRecoveryGrant(
    request: CreateOperatorMainnetRecoveryGrantRequest,
  ): Result<OperatorMainnetRecoveryGrant> {
    const sourceId = requireIdentifier(request.sourceId, "sourceId");
    const planHash = requireHash(request.planHash, "planHash");
    const actor = requireIdentifier(request.actor, "actor");
    const issuedAt = parseUtcTimestamp(request.issuedAt);
    const consent = request.consent === true;
    if (
      !sourceId.ok ||
      !planHash.ok ||
      !actor.ok ||
      !issuedAt.ok ||
      !consent ||
      !validScope(this.scope)
    )
      return invalid(
        "explicit valid consent and exact recovery inputs are required",
      );
    return runInTransaction(
      this.db,
      (database) => {
        const sourceRow = this.sourceRow(sourceId.value, database);
        if (!sourceRow)
          return fail(
            domainError(
              "PERSISTENCE_CONFLICT",
              "recovery source does not exist in this account",
            ),
          );
        const snapshot = this.snapshot(sourceRow, database);
        if (!snapshot.ok) return snapshot;
        const currentSourceRevision = this.sourceRevision(snapshot.value);
        const planArtifact = this.artifactRow(PLAN_ARTIFACT_ID(planHash.value));
        if (!planArtifact.ok) return planArtifact;
        if (
          !planArtifact.value ||
          planArtifact.value.artifactKind !== PLAN_KIND
        )
          return fail(
            domainError(
              "PERSISTENCE_CONFLICT",
              "recovery requires a saved exact plan",
            ),
          );
        const plan = rehydrateArtifact(PLAN_KIND, planArtifact.value.envelope);
        if (
          !plan.ok ||
          plan.value.contentHash !== planHash.value ||
          plan.value.accountIdentityHash !== this.scope.accountId ||
          plan.value.contentHash === snapshot.value.source.planHash
        )
          return fail(
            domainError(
              "PERSISTENCE_CONFLICT",
              "recovery plan must be a different saved plan for this exact account",
            ),
          );
        const pending = this.pendingSourceRows(database);
        if (!pending.ok) return pending;
        if (pending.value.some((source) => source.sourceId !== sourceId.value))
          return fail(
            domainError(
              "UNRESOLVED_STATE",
              "another operator source remains unresolved; recover only one source at a time",
            ),
          );

        const halt = haltRow(database, this.scope);
        if (!halt.ok) return halt;
        if (
          !halt.value.active &&
          !pending.value.some((source) => source.sourceId === sourceId.value)
        )
          return fail(
            domainError(
              "UNRESOLVED_STATE",
              "there is no active eligible HALT or pending source to recover",
            ),
          );
        const origin = halt.value.active
          ? this.activeHaltOrigin(snapshot.value, database)
          : ok<OperatorMainnetRecoveryGrant["haltOrigin"]>(null);
        if (!origin.ok) return origin;

        let resolution: OperatorMainnetRecoveryGrant["resolution"];
        if (request.resolution.kind === "api-resolved") {
          const api = this.latestApiResolution(
            snapshot.value,
            request.resolution,
            issuedAt.value,
          );
          if (!api.ok) return api;
          resolution = { kind: "api-resolved", ...api.value };
        } else if (request.resolution.kind === "manual-attested") {
          const attestationHash = requireHash(
            request.resolution.attestationHash,
            "attestationHash",
          );
          if (!attestationHash.ok) return attestationHash;
          const attestation = this.recoveryAttestationRow(
            attestationHash.value,
            database,
          );
          if (!attestation.ok) return attestation;
          if (!attestation.value)
            return fail(
              domainError(
                "INVALID_EVIDENCE",
                "saved manual recovery attestation is unavailable",
              ),
            );
          if (plan.value.recoveryAttestationHash !== attestationHash.value)
            return fail(
              domainError(
                "INVALID_APPROVAL",
                "manual recovery plan is not bound to this exact attestation",
              ),
            );
          const binding = validateOperatorMainnetRecoveryAttestationBinding(
            attestation.value,
            {
              accountIdentityHash: this.scope.accountId,
              sourceId: snapshot.value.source.sourceId,
              sourcePlanHash: snapshot.value.source.planHash,
              sourceIntentId: snapshot.value.intent.writeIntentId,
              sourceRevision: currentSourceRevision,
              entryClientOrderId: snapshot.value.source.clientOrderId,
            },
          );
          if (!binding.ok) return binding;
          if (!manualRecoveryOrdersAreTerminal(binding.value))
            return fail(
              domainError(
                "UNRESOLVED_STATE",
                "manual source order history includes a nonterminal or unknown order status; inspect the source and TP in Bybit and retry with current evidence",
              ),
            );
          if (
            binding.value.inspection.accountOpenOrders.length > 0 ||
            binding.value.inspection.accountPositions.length > 0 ||
            binding.value.inspection.sourcePosition !== null ||
            timestampToEpochMs(issuedAt.value) <
              timestampToEpochMs(binding.value.observedAt) ||
            timestampToEpochMs(issuedAt.value) -
              timestampToEpochMs(binding.value.observedAt) >
              OPERATOR_MAINNET_RECOVERY_MAX_AGE_MS
          )
            return fail(
              domainError(
                "UNRESOLVED_STATE",
                "manual inspection is stale or shows an open order or position; resolve the exposure before recovery",
              ),
            );
          resolution = {
            kind: "manual-attested",
            attestationId: binding.value.attestationId,
            attestationHash: binding.value.contentHash,
            observedAt: binding.value.observedAt,
          };
        } else {
          return invalid("recovery resolution kind is invalid");
        }

        const planExpiry = recoveryGrantPlanExpiry(plan.value);
        if (!planExpiry.ok) return planExpiry;
        const expiresAt = recoveryGrantEvidenceExpiry(
          resolution.observedAt,
          planExpiry.value,
        );
        if (!expiresAt.ok) return expiresAt;
        const grant = createOperatorMainnetRecoveryGrant({
          plan: plan.value,
          resolution,
          exchange: "bybit",
          environment: "mainnet",
          accountIdentityHash: this.scope.accountId,
          sourceId: snapshot.value.source.sourceId,
          sourcePlanHash: snapshot.value.source.planHash,
          sourceIntentId: snapshot.value.intent.writeIntentId,
          sourceRevision: currentSourceRevision,
          haltRevision: halt.value.revision + (halt.value.active ? 1 : 0),
          haltOrigin: origin.value,
          planHash: plan.value.contentHash,
          planExpiresAt: planExpiry.value,
          actor: actor.value,
          consent: true,
          issuedAt: issuedAt.value,
          expiresAt: expiresAt.value,
        });
        if (!grant.ok) return grant;
        const encoded = encode(grant.value);
        if (!encoded.ok) return encoded;
        const duplicate = database
          .prepare(
            "SELECT 1 AS present FROM operator_mainnet_recovery_grants WHERE grant_id = ?",
          )
          .get(grant.value.grantId) as SqliteRow | undefined;
        if (duplicate)
          return fail(
            domainError(
              "PERSISTENCE_CONFLICT",
              "this exact recovery authorization already exists",
            ),
          );
        database
          .prepare(
            `INSERT INTO operator_mainnet_recovery_grants
             (grant_id, exchange, environment, account_id, category, position_mode,
              source_id, source_revision, plan_hash, plan_artifact_id, resolution_kind,
              evidence_hash, attestation_hash, halt_revision, halt_origin_event_id,
              halt_origin_revision, issued_at, expires_at, canonical_json, canonical_hash)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            grant.value.grantId,
            ...scopeValues(this.scope),
            grant.value.sourceId,
            grant.value.sourceRevision,
            grant.value.planHash,
            PLAN_ARTIFACT_ID(grant.value.planHash),
            grant.value.resolution.kind,
            grant.value.resolution.kind === "api-resolved"
              ? grant.value.resolution.evidenceHash
              : null,
            grant.value.resolution.kind === "manual-attested"
              ? grant.value.resolution.attestationHash
              : null,
            grant.value.haltRevision,
            grant.value.haltOrigin?.eventId ?? null,
            grant.value.haltOrigin?.revision ?? null,
            grant.value.issuedAt,
            grant.value.expiresAt,
            encoded.value.json,
            encoded.value.hash,
          );
        if (halt.value.active) {
          const clearanceEvidence = encode({
            schemaVersion: "operator-mainnet-recovery-clearance/v1",
            grantId: grant.value.grantId,
            grantHash: grant.value.contentHash,
            sourceId: grant.value.sourceId,
            sourceRevision: grant.value.sourceRevision,
            planHash: grant.value.planHash,
            priorHaltEventId: grant.value.haltOrigin?.eventId,
            priorHaltRevision: grant.value.haltOrigin?.revision,
            resolutionKind: grant.value.resolution.kind,
            ...(grant.value.resolution.kind === "manual-attested"
              ? { attestationHash: grant.value.resolution.attestationHash }
              : { evidenceHash: grant.value.resolution.evidenceHash }),
          });
          if (!clearanceEvidence.ok) return clearanceEvidence;
          const cleared = clearOperatorHaltWithinTransaction(
            database,
            this.scope,
            halt.value.revision,
            "operator explicitly accepted source-bound recovery",
            issuedAt.value,
            clearanceEvidence.value.json,
          );
          if (!cleared.ok) return cleared;
          if (
            cleared.value.revision !== grant.value.haltRevision ||
            cleared.value.active
          )
            return fail(
              domainError(
                "HALT_ACTIVE",
                "HALT clearance did not match the persisted recovery grant",
              ),
            );
        }
        return ok(grant.value);
      },
      "PERSISTENCE_CONFLICT",
    );
  }

  readOperatorMainnetRecoveryGrant(
    grantIdInput: string,
  ): Result<OperatorMainnetRecoveryGrant | undefined> {
    const grantId = requireIdentifier(grantIdInput, "grantId");
    if (!grantId.ok || !validScope(this.scope)) return invalid();
    try {
      return this.recoveryGrantRow(grantId.value);
    } catch (error) {
      return fail(sqliteError(error, "PERSISTENCE_INTEGRITY"));
    }
  }

  findOperatorMainnetRecoveryGrant(
    planHashInput: PlanHash,
    nowInput: UtcTimestamp,
  ): Result<OperatorMainnetRecoveryGrant | undefined> {
    const planHash = requireHash(planHashInput, "planHash");
    const now = parseUtcTimestamp(nowInput);
    if (!planHash.ok || !now.ok || !validScope(this.scope)) return invalid();
    return runInTransaction(
      this.db,
      (database) => {
        const rows = database
          .prepare(
            `SELECT * FROM operator_mainnet_recovery_grants
             WHERE plan_hash = ? AND exchange = ? AND environment = ? AND account_id = ?
             ORDER BY rowid DESC`,
          )
          .all(
            planHash.value,
            this.scope.exchange,
            this.scope.environment,
            this.scope.accountId,
          ) as SqliteRow[];
        for (const row of rows) {
          const grant = this.recoveryGrantFromRow(row);
          if (!grant.ok) return grant;
          const consumed = database
            .prepare(
              "SELECT 1 AS present FROM operator_mainnet_recovery_grant_consumptions WHERE grant_id = ?",
            )
            .get(grant.value.grantId) as SqliteRow | undefined;
          if (consumed) continue;
          const source = this.sourceRow(grant.value.sourceId, database);
          if (!source) continue;
          const snapshot = this.snapshot(source, database);
          if (!snapshot.ok) return snapshot;
          const currentRevision = this.sourceRevision(snapshot.value);
          const halt = haltRow(database, this.scope);
          if (!halt.ok) return halt;
          if (
            grant.value.sourceRevision !== currentRevision ||
            grant.value.haltRevision !== halt.value.revision ||
            halt.value.active
          )
            continue;
          const planArtifact = this.artifactRow(
            PLAN_ARTIFACT_ID(planHash.value),
          );
          if (!planArtifact.ok) return planArtifact;
          if (!planArtifact.value)
            return persistenceFailure("recovery plan artifact is missing");
          const plan = rehydrateArtifact(
            PLAN_KIND,
            planArtifact.value.envelope,
          );
          if (!plan.ok) return plan;
          const valid = validateOperatorMainnetRecoveryGrantForPlan(
            grant.value,
            plan.value,
            now.value,
          );
          if (!valid.ok) continue;
          const latest = this.latestRecoveryGrantForSource(
            grant.value.sourceId,
            database,
          );
          if (!latest.ok) return latest;
          if (latest.value?.grantId !== grant.value.grantId) continue;
          const pending = this.pendingSourceRows(database);
          if (!pending.ok) return pending;
          if (
            pending.value.some((item) => item.sourceId !== grant.value.sourceId)
          )
            continue;
          return ok(grant.value);
        }
        return ok(undefined);
      },
      "PERSISTENCE_INTEGRITY",
    );
  }

  private recoveryGrantForIntent(
    grantId: string,
    plan: OperatorMainnetTestPlan,
    now: UtcTimestamp,
    database: DatabaseSync,
  ): Result<{
    readonly grant: OperatorMainnetRecoveryGrant;
    readonly source: OperatorMainnetTestSnapshot;
  }> {
    const grant = this.recoveryGrantRow(grantId, database);
    if (!grant.ok) return grant;
    if (!grant.value)
      return fail(
        domainError(
          "INVALID_APPROVAL",
          "source-bound recovery grant was not found for this account",
        ),
      );
    const storedGrant = grant.value;
    const bound = validateOperatorMainnetRecoveryGrantForPlan(
      storedGrant,
      plan,
      now,
    );
    if (!bound.ok) return bound;
    const latest = this.latestRecoveryGrantForSource(
      storedGrant.sourceId,
      database,
    );
    if (!latest.ok) return latest;
    if (latest.value?.grantId !== storedGrant.grantId)
      return fail(
        domainError(
          "INVALID_APPROVAL",
          "a newer recovery grant superseded this one",
        ),
      );
    const consumed = database
      .prepare(
        "SELECT 1 AS present FROM operator_mainnet_recovery_grant_consumptions WHERE grant_id = ?",
      )
      .get(storedGrant.grantId) as SqliteRow | undefined;
    if (consumed)
      return fail(
        domainError(
          "INVALID_APPROVAL",
          "source-bound recovery grant was already consumed",
        ),
      );
    const sourceRow = this.sourceRow(storedGrant.sourceId, database);
    if (!sourceRow)
      return fail(
        domainError(
          "PERSISTENCE_CONFLICT",
          "recovery source is no longer present",
        ),
      );
    const snapshot = this.snapshot(sourceRow, database);
    if (!snapshot.ok) return snapshot;
    if (
      this.sourceRevision(snapshot.value) !== storedGrant.sourceRevision ||
      snapshot.value.source.planHash !== storedGrant.sourcePlanHash ||
      snapshot.value.intent.writeIntentId !== storedGrant.sourceIntentId
    )
      return fail(
        domainError(
          "INVALID_APPROVAL",
          "source changed after recovery was authorized",
        ),
      );
    const halt = haltRow(database, this.scope);
    if (!halt.ok) return halt;
    if (halt.value.active || halt.value.revision !== storedGrant.haltRevision)
      return fail(
        domainError(
          "HALT_ACTIVE",
          "HALT changed after recovery was authorized",
        ),
      );
    if (storedGrant.resolution.kind === "api-resolved") {
      const latestReconciliation = snapshot.value.reconciliations.at(-1);
      if (
        latestReconciliation?.cleanupStatus !== "verified-clean" ||
        latestReconciliation.canonicalHash !==
          storedGrant.resolution.evidenceHash
      )
        return fail(
          domainError(
            "UNRESOLVED_STATE",
            "API recovery evidence changed after authorization",
          ),
        );
    } else {
      const attestation = this.recoveryAttestationRow(
        storedGrant.resolution.attestationHash,
        database,
      );
      if (!attestation.ok) return attestation;
      if (
        attestation.value === undefined ||
        attestation.value.attestationId !==
          storedGrant.resolution.attestationId ||
        attestation.value.sourceRevision !== storedGrant.sourceRevision
      )
        return fail(
          domainError(
            "INVALID_APPROVAL",
            "manual recovery attestation is missing or no longer current",
          ),
        );
    }
    return ok({ grant: storedGrant, source: snapshot.value });
  }

  private consumeRecoveryGrantWithinTransaction(
    database: DatabaseSync,
    grant: OperatorMainnetRecoveryGrant,
    oldSource: OperatorMainnetTestSnapshot,
    nextSourceId: string,
    nextWriteIntentId: string,
    consumedAt: UtcTimestamp,
  ): Result<void> {
    const event = encode({
      schemaVersion: "operator-mainnet-recovery-grant-consumption/v1",
      grantId: grant.grantId,
      grantHash: grant.contentHash,
      oldSourceId: grant.sourceId,
      oldSourceRevision: grant.sourceRevision,
      nextSourceId,
      nextWriteIntentId,
      nextPlanHash: grant.planHash,
      resolutionKind: grant.resolution.kind,
      consumedAt,
    });
    if (!event.ok) return event;
    database
      .prepare(
        `INSERT INTO operator_mainnet_recovery_grant_consumptions
         (grant_id, exchange, environment, account_id, new_source_id,
          new_write_intent_id, consumed_at, canonical_json, canonical_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        grant.grantId,
        this.scope.exchange,
        this.scope.environment,
        this.scope.accountId,
        nextSourceId,
        nextWriteIntentId,
        consumedAt,
        event.value.json,
        event.value.hash,
      );
    if (grant.resolution.kind !== "manual-attested") return ok(undefined);
    if (oldSource.sourceDisposition !== undefined)
      return fail(
        domainError(
          "PERSISTENCE_CONFLICT",
          "recovery source already has a terminal disposition",
        ),
      );
    const revision = this.sourceRevision(oldSource) + 1;
    const dispositionId = deterministicId(
      "operator-mainnet-source-disposition",
      `${grant.sourceId}:${grant.grantId}`,
    );
    const disposition = encode({
      schemaVersion: "operator-mainnet-source-disposition/v1",
      sourceId: grant.sourceId,
      revision,
      disposition: "human-attested",
      grantId: grant.grantId,
      grantHash: grant.contentHash,
      attestationId: grant.resolution.attestationId,
      attestationHash: grant.resolution.attestationHash,
      nextSourceId,
      nextWriteIntentId,
      recordedAt: consumedAt,
    });
    if (!disposition.ok) return disposition;
    database
      .prepare(
        `INSERT INTO operator_mainnet_test_source_dispositions
         (disposition_id, source_id, revision, disposition, grant_id,
          next_source_id, next_write_intent_id, canonical_json, canonical_hash, recorded_at)
         VALUES (?, ?, ?, 'human-attested', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        dispositionId,
        grant.sourceId,
        revision,
        grant.grantId,
        nextSourceId,
        nextWriteIntentId,
        disposition.value.json,
        disposition.value.hash,
        consumedAt,
      );
    return ok(undefined);
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
    const canonicalJson = storedString(row, "canonical_json");
    const canonicalHash = storedHash(row, "canonical_hash");
    const preparedAt = storedTimestamp(row, "prepared_at");
    if (
      row.operation !== "CREATE" ||
      !writeIntentId.ok ||
      !sourceId.ok ||
      !runId.ok ||
      !canonicalJson.ok ||
      !canonicalHash.ok ||
      !preparedAt.ok
    )
      return persistenceFailure("persisted operator CREATE intent is invalid");
    const parsed = parseJsonHash(canonicalJson.value, canonicalHash.value);
    if (!parsed.ok) return parsed;
    const serialized = canonicalSerialize(parsed.value);
    if (
      !serialized.ok ||
      serialized.value !== canonicalJson.value ||
      typeof parsed.value !== "object" ||
      parsed.value === null ||
      (parsed.value as Record<string, unknown>).sourceId !== sourceId.value ||
      (parsed.value as Record<string, unknown>).operation !== "CREATE" ||
      (parsed.value as Record<string, unknown>).runId !== runId.value
    )
      return persistenceFailure("operator CREATE intent identity is invalid");
    const value = parsed.value as Record<string, unknown>;
    if (
      (value.schemaVersion !== "operator-mainnet-test-create-intent/v1" &&
        value.schemaVersion !== "operator-mainnet-test-create-intent/v2" &&
        value.schemaVersion !== "operator-mainnet-test-create-intent/v3") ||
      (value.schemaVersion === "operator-mainnet-test-create-intent/v1" &&
        (!requireIdentifier(value.leaseOwnerRunId, "leaseOwnerRunId").ok ||
          !requireFiniteInteger(value.leaseEpoch, "leaseEpoch", 1).ok)) ||
      (value.schemaVersion === "operator-mainnet-test-create-intent/v2" &&
        ("leaseOwnerRunId" in value ||
          "leaseEpoch" in value ||
          "recoveryGrantId" in value)) ||
      (value.schemaVersion === "operator-mainnet-test-create-intent/v3" &&
        ("leaseOwnerRunId" in value ||
          "leaseEpoch" in value ||
          !requireIdentifier(value.recoveryGrantId, "recoveryGrantId").ok))
    )
      return persistenceFailure("operator CREATE intent version is invalid");
    return ok({
      writeIntentId: writeIntentId.value,
      sourceId: sourceId.value,
      operation: "CREATE",
      runId: runId.value,
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
    const serialized = canonicalSerialize(parsed.value);
    if (
      !serialized.ok ||
      serialized.value !== canonicalJson.value ||
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
      const serialized = canonicalSerialize(parsed.value);
      if (
        !serialized.ok ||
        serialized.value !== canonicalJson.value ||
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
      const serialized = canonicalSerialize(parsed.value);
      if (
        !serialized.ok ||
        serialized.value !== canonicalJson.value ||
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
    const planArtifact = this.artifactRow(source.value.planArtifactId);
    const approvalArtifact = this.artifactRow(source.value.approvalArtifactId);
    if (!planArtifact.ok) return planArtifact;
    if (!approvalArtifact.ok) return approvalArtifact;
    if (!planArtifact.value || !approvalArtifact.value)
      return persistenceFailure("operator source artifacts are missing");
    const plan = rehydrateArtifact(PLAN_KIND, planArtifact.value.envelope);
    const approval = rehydrateArtifact(
      APPROVAL_KIND,
      approvalArtifact.value.envelope,
    );
    if (
      !plan.ok ||
      !approval.ok ||
      plan.value.contentHash !== source.value.planHash ||
      approval.value.contentHash !== source.value.approvalHash
    )
      return persistenceFailure("operator source artifacts failed validation");
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
    const sourceDisposition = this.sourceDispositionRow(
      source.value.sourceId,
      database,
    );
    if (!sourceDisposition.ok) return sourceDisposition;
    const halt = haltRow(database, this.scope);
    if (!halt.ok) return halt;
    return ok({
      source: source.value,
      plan: plan.value,
      approval: approval.value,
      intent: intent.value,
      ...(attempt.value === undefined ? {} : { attempt: attempt.value }),
      reconciliations: reconciliations.value,
      manualActions: manualActions.value,
      ...(sourceDisposition.value === undefined
        ? {}
        : { sourceDisposition: sourceDisposition.value }),
      halt: halt.value,
    });
  }

  private haltOriginEvidence(
    source: OperatorMainnetTestSourceRecord,
    intent: OperatorMainnetTestIntentRecord,
    trigger: Readonly<Record<string, unknown>>,
  ): Result<string> {
    if (source.sourceId !== intent.sourceId)
      return persistenceFailure(
        "operator HALT source and CREATE intent origin do not match",
      );
    const encoded = encode({
      schemaVersion: "operator-mainnet-halt-origin/v1",
      sourceId: source.sourceId,
      writeIntentId: intent.writeIntentId,
      sourcePlanHash: source.planHash,
      intentCanonicalHash: intent.canonicalHash,
      trigger,
    });
    return encoded.ok ? ok(encoded.value.json) : encoded;
  }

  private pendingSourceRows(
    database = this.db,
  ): Result<readonly OperatorMainnetTestSourceRecord[]> {
    const rows = database
      .prepare(
        `SELECT s.* FROM operator_mainnet_test_sources s
         JOIN operator_mainnet_test_write_intents i ON i.source_id = s.source_id
         WHERE s.exchange = ? AND s.environment = ? AND s.account_id = ?
           AND s.category = ? AND s.position_mode = ?
         ORDER BY s.created_at, s.source_id`,
      )
      .all(...scopeValues(this.scope)) as SqliteRow[];
    const pending: OperatorMainnetTestSourceRecord[] = [];
    for (const row of rows) {
      // Validate the complete persisted source and its canonical reconciliation
      // rows before trusting cleanup status to release the account gate.
      const snapshot = this.snapshot(row, database);
      if (!snapshot.ok) return snapshot;
      if (snapshot.value.sourceDisposition !== undefined) continue;
      // A fresh, source-attributed API status result is independently enough
      // to release the pending-source gate. Grants authorize only the bound
      // recovery intent; an unused or expired grant must not hold clean state.
      if (hasLatestApiVerifiedCleanReconciliation(snapshot.value)) continue;
      const latestGrant = this.latestRecoveryGrantForSource(
        snapshot.value.source.sourceId,
        database,
      );
      if (!latestGrant.ok) return latestGrant;
      if (latestGrant.value) {
        const consumed = database
          .prepare(
            "SELECT 1 AS present FROM operator_mainnet_recovery_grant_consumptions WHERE grant_id = ?",
          )
          .get(latestGrant.value.grantId) as SqliteRow | undefined;
        if (!consumed) {
          pending.push(snapshot.value.source);
          continue;
        }
      }
      pending.push(snapshot.value.source);
    }
    return ok(pending);
  }

  private pendingSourceRow(
    database = this.db,
  ): Result<OperatorMainnetTestSourceRecord | undefined> {
    const pending = this.pendingSourceRows(database);
    return pending.ok ? ok(pending.value[0]) : pending;
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

  findPendingOperatorMainnetTestSource(): Result<
    OperatorMainnetTestSourceRecord | undefined
  > {
    if (!validScope(this.scope)) return invalid();
    return runInTransaction(
      this.db,
      (database) => this.pendingSourceRow(database),
      "PERSISTENCE_INTEGRITY",
    );
  }

  prepareCreateIntent(
    request: PrepareOperatorMainnetTestCreateRequest,
  ): Result<OperatorMainnetTestSnapshot> {
    const runId = requireIdentifier(request.runId, "runId");
    const at = parseUtcTimestamp(request.preparedAt);
    const recoveryGrantId =
      request.recoveryGrantId === undefined
        ? ok<string | undefined>(undefined)
        : requireIdentifier(request.recoveryGrantId, "recoveryGrantId");
    if (!runId.ok || !at.ok || !recoveryGrantId.ok || !validScope(this.scope))
      return invalid();
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
      schemaVersion:
        recoveryGrantId.value === undefined
          ? "operator-mainnet-test-create-intent/v2"
          : "operator-mainnet-test-create-intent/v3",
      operation: "CREATE" as const,
      sourceId,
      runId: runId.value,
      planHash: artifacts.value.plan.contentHash,
      approvalHash: artifacts.value.approval.contentHash,
      accountIdentityHash: artifacts.value.plan.accountIdentityHash,
      symbol: artifacts.value.plan.symbol,
      clientOrderId: artifacts.value.plan.clientOrderId,
      exactPayloadHash: payload.value.hash,
      expiresAt: artifacts.value.approval.expiresAt,
      preparedAt: at.value,
      ...(recoveryGrantId.value === undefined
        ? {}
        : { recoveryGrantId: recoveryGrantId.value }),
    };
    const intent = encode(intentValue);
    if (!intent.ok) return intent;
    return runInTransaction(
      this.db,
      (database) => {
        const recoveryGrant =
          recoveryGrantId.value === undefined
            ? ok<
                | {
                    readonly grant: OperatorMainnetRecoveryGrant;
                    readonly source: OperatorMainnetTestSnapshot;
                  }
                | undefined
              >(undefined)
            : this.recoveryGrantForIntent(
                recoveryGrantId.value,
                artifacts.value.plan,
                at.value,
                database,
              );
        if (!recoveryGrant.ok) return recoveryGrant;
        const halt = haltRow(database, this.scope);
        if (!halt.ok) return halt;
        if (halt.value.active)
          return fail(
            domainError(
              "HALT_ACTIVE",
              "HALT blocks a new operator Mainnet CREATE; inspect saved event and source/intent evidence before explicit recovery",
            ),
          );
        const pending = this.pendingSourceRow(database);
        if (!pending.ok) return pending;
        if (
          pending.value &&
          (recoveryGrant.value === undefined ||
            pending.value.sourceId !==
              recoveryGrant.value.source.source.sourceId)
        )
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
             (write_intent_id, source_id, operation, run_id, canonical_json, canonical_hash, prepared_at)
             VALUES (?, ?, 'CREATE', ?, ?, ?, ?)`,
          )
          .run(
            writeIntentId,
            sourceId,
            runId.value,
            intent.value.json,
            intent.value.hash,
            at.value,
          );
        if (recoveryGrant.value !== undefined) {
          const consumed = this.consumeRecoveryGrantWithinTransaction(
            database,
            recoveryGrant.value.grant,
            recoveryGrant.value.source,
            sourceId,
            writeIntentId,
            at.value,
          );
          if (!consumed.ok) return consumed;
        }
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

  recordAttempt(
    request: RecordOperatorMainnetTestAttemptRequest,
  ): Result<OperatorMainnetTestSnapshot> {
    const sourceId = requireIdentifier(request.sourceId, "sourceId");
    const attemptId = requireIdentifier(request.attemptId, "attemptId");
    const runId = requireIdentifier(request.runId, "runId");
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
      !runId.ok ||
      !at.ok ||
      !providerReasonCode.ok ||
      !exchangeOrderId.ok ||
      !["accepted", "rejected", "ambiguous"].includes(request.outcome)
    )
      return invalid();
    return runInTransaction(
      this.db,
      (database) => {
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
        if (intent.value.runId !== runId.value)
          return fail(
            domainError(
              "PERSISTENCE_CONFLICT",
              "operator CREATE attempt belongs to another run",
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
        if (request.outcome === "ambiguous") {
          const validated = this.snapshot(sourceRow, database);
          if (!validated.ok) return validated;
          const origin = this.haltOriginEvidence(
            validated.value.source,
            validated.value.intent,
            {
              kind: "ambiguous-create-attempt",
              attemptId: attemptId.value,
              attemptCanonicalJson: attempt.value.json,
              attemptCanonicalHash: attempt.value.hash,
            },
          );
          if (!origin.ok) return origin;
          const raised = raiseHaltWithinTransaction(
            database,
            this.scope,
            "operator Mainnet CREATE awaits read-only reconciliation",
            at.value,
            origin.value,
          );
          if (!raised.ok) return raised;
        }
        return this.snapshot(sourceRow, database);
      },
      "PERSISTENCE_CONFLICT",
    );
  }

  raiseHalt(
    sourceId: string,
    reason: string,
    at: UtcTimestamp,
  ): Result<HaltState> {
    const id = requireIdentifier(sourceId, "sourceId");
    const time = parseUtcTimestamp(at);
    const safeReason = requireSafeText(reason, "reason");
    if (!id.ok || !time.ok || !safeReason.ok || !validScope(this.scope))
      return invalid();
    return runInTransaction(
      this.db,
      (database) => {
        const source = this.sourceRow(id.value, database);
        if (!source)
          return fail(
            domainError(
              "PERSISTENCE_CONFLICT",
              "operator source does not exist",
            ),
          );
        const snapshot = this.snapshot(source, database);
        if (!snapshot.ok) return snapshot;
        const latestReconciliation = snapshot.value.reconciliations.at(-1);
        const origin = this.haltOriginEvidence(
          snapshot.value.source,
          snapshot.value.intent,
          {
            kind:
              latestReconciliation?.lifecycleOutcome === "UNKNOWN" &&
              latestReconciliation.cleanupStatus === "unknown"
                ? "status-unknown"
                : "operator-source-halt",
            reason: safeReason.value,
            recordedAt: time.value,
            ...(latestReconciliation === undefined
              ? {}
              : {
                  reconciliationRevision: latestReconciliation.revision,
                  reconciliationCanonicalJson:
                    latestReconciliation.canonicalJson,
                  reconciliationCanonicalHash:
                    latestReconciliation.canonicalHash,
                }),
          },
        );
        if (!origin.ok) return origin;
        return raiseHaltWithinTransaction(
          database,
          this.scope,
          safeReason.value,
          time.value,
          origin.value,
        );
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
