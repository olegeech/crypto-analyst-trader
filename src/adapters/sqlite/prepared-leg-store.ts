import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

import {
  rehydrateArtifact,
  type CanonicalArtifactEnvelope,
} from "../../domain/identity/canonical-artifact.js";
import {
  canonicalSerialize,
  hashCanonical,
  type PlanHash,
} from "../../domain/identity/canonical-serialization.js";
import {
  createPreparedLegExecution,
  derivePreparedLegClientOrderId,
  derivePreparedLegSourceId,
  type PreparedLegExecution,
  type PreparedLegSourceIdentity,
} from "../../domain/execution/prepared-leg-execution.js";
import {
  isProducedPreparedLegOrderProof,
  matchesPreparedLegOrder,
  type PreparedLegOrderProof,
} from "../../domain/execution/prepared-leg-order-proof.js";
import { DecimalValue } from "../../domain/shared/decimal.js";
import { domainError } from "../../domain/shared/errors.js";
import { fail, ok, type Result } from "../../domain/shared/result.js";
import {
  parseUtcTimestamp,
  timestampToEpochMs,
  type UtcTimestamp,
} from "../../domain/shared/time.js";
import {
  requireFiniteInteger,
  requireHash,
  requireIdentifier,
  requireSafeText,
} from "../../domain/shared/validation.js";
import type {
  AppendPreparedLegAttemptRequest,
  AppendPreparedLegReconciliationRequest,
  PersistenceScope,
  PreparedLegAttemptEvidence,
  PreparedLegAttemptRecord,
  PreparedLegLineageRecord,
  PreparedLegOperation,
  PreparedLegPersistencePort,
  PreparedLegReconciliationRecord,
  PreparedLegReconciliationStatus,
  PreparedLegRunSnapshot,
  PreparePreparedLegCancelRequest,
  PreparePreparedLegCreateRequest,
  PreparePreparedLegCancelResult,
  PreparePreparedLegCreateResult,
} from "../../ports/persistence.js";
import type { SqliteConnection } from "./connection.js";
import {
  assertCurrentAuthorityWithinTransaction,
  haltRow,
  leaseRow,
  leaseState,
  raiseHaltWithinTransaction,
} from "./sqlite-authority.js";
import {
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
import { createSqliteExecutionStore } from "./execution-store.js";
import { runInTransaction, sqliteError } from "./transaction.js";

const CANCEL_PROOF_MAX_AGE_MS = 60_000;
const preparedId = (hash: string) => "prepared:" + hash;
const approvalId = (hash: string) => "prepared-consent:" + hash;
const invalid = (message = "prepared-leg persistence input is invalid") =>
  fail(domainError("PERSISTENCE_INTEGRITY", message));

function encode(value: unknown): Result<{ json: string; hash: PlanHash }> {
  const json = canonicalSerialize(value);
  const hash = hashCanonical(value);
  return json.ok && hash.ok
    ? ok({ json: json.value, hash: hash.value })
    : invalid("prepared-leg evidence is not canonical");
}

function sourceIdFor(
  scope: PersistenceScope,
  preparedHash: string,
  legId: string,
): string {
  const identity = derivePreparedLegSourceId(
    scope.accountId,
    preparedHash,
    legId,
  );
  return identity.ok ? identity.value : "invalid-prepared-leg-source";
}

function isStatus(value: string): value is PreparedLegReconciliationStatus {
  return [
    "CONFIRMED_OPEN",
    "PROTECTION_PENDING",
    "CANCELLED",
    "REJECTED",
    "UNRESOLVED",
  ].includes(value);
}

function parseCanonicalJson(json: string, hash: string): Result<unknown> {
  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch {
    return persistenceFailure("stored prepared-leg JSON is invalid");
  }
  const actual =
    "sha256:" + createHash("sha256").update(json, "utf8").digest("hex");
  return actual === hash
    ? ok(value)
    : persistenceFailure("stored prepared-leg hash is invalid");
}

function sourceFromRow(
  row: SqliteRow,
  scope: PersistenceScope,
): Result<PreparedLegLineageRecord> {
  const sourceId = storedIdentifier(row, "source_id");
  const preparedHash = storedHash(row, "prepared_hash");
  const legId = storedIdentifier(row, "leg_id");
  const clientOrderId = storedIdentifier(row, "client_order_id");
  const json = storedString(row, "selection_json");
  const hash = storedHash(row, "selection_hash");
  const createdAt = storedTimestamp(row, "created_at");
  if (
    !sourceId.ok ||
    !preparedHash.ok ||
    !legId.ok ||
    !clientOrderId.ok ||
    !json.ok ||
    !hash.ok ||
    !createdAt.ok
  )
    return persistenceFailure("persisted prepared-leg source is invalid");
  if (!parseCanonicalJson(json.value, hash.value).ok)
    return persistenceFailure("prepared-leg selection hash is invalid");
  return ok({
    sourceId: sourceId.value,
    scope,
    preparedHash: preparedHash.value as PlanHash,
    legId: legId.value,
    clientOrderId: clientOrderId.value,
    selectionCanonicalJson: json.value,
    selectionHash: hash.value as PlanHash,
    createdAt: createdAt.value,
  });
}

function intentFromRow(
  row: SqliteRow,
): Result<PreparedLegRunSnapshot["createIntent"]> {
  const id = storedIdentifier(row, "write_intent_id");
  const sourceId = storedIdentifier(row, "source_id");
  const operation = storedString(row, "operation");
  const runId = storedIdentifier(row, "run_id");
  const epoch = requireFiniteInteger(row.lease_epoch, "leaseEpoch", 1);
  const client = storedIdentifier(row, "client_order_id");
  const exchange = storedOptionalString(row, "exchange_order_id");
  const json = storedString(row, "canonical_json");
  const hash = storedHash(row, "canonical_hash");
  const at = storedTimestamp(row, "prepared_at");
  if (
    !id.ok ||
    !sourceId.ok ||
    !operation.ok ||
    !runId.ok ||
    !epoch.ok ||
    !client.ok ||
    !exchange.ok ||
    !json.ok ||
    !hash.ok ||
    !at.ok ||
    (operation.value !== "create" && operation.value !== "cancel")
  )
    return persistenceFailure("persisted prepared-leg intent is invalid");
  if (!parseCanonicalJson(json.value, hash.value).ok)
    return persistenceFailure("prepared-leg intent hash is invalid");
  return ok({
    writeIntentId: id.value,
    sourceId: sourceId.value,
    operation: operation.value,
    runId: runId.value,
    leaseEpoch: epoch.value,
    clientOrderId: client.value,
    ...(exchange.value === undefined
      ? {}
      : { exchangeOrderId: exchange.value }),
    canonicalJson: json.value,
    canonicalHash: hash.value as PlanHash,
    preparedAt: at.value,
  });
}

function attemptFromRow(row: SqliteRow): Result<PreparedLegAttemptRecord> {
  const id = storedIdentifier(row, "attempt_id");
  const intent = storedIdentifier(row, "write_intent_id");
  const operation = storedString(row, "operation");
  const json = storedString(row, "canonical_json");
  const hash = storedHash(row, "canonical_hash");
  const at = storedTimestamp(row, "recorded_at");
  if (
    !id.ok ||
    !intent.ok ||
    !operation.ok ||
    !json.ok ||
    !hash.ok ||
    !at.ok ||
    (operation.value !== "create" && operation.value !== "cancel")
  )
    return persistenceFailure("persisted prepared-leg attempt is invalid");
  if (!parseCanonicalJson(json.value, hash.value).ok)
    return persistenceFailure("prepared-leg attempt hash is invalid");
  return ok({
    attemptId: id.value,
    writeIntentId: intent.value,
    operation: operation.value,
    canonicalJson: json.value,
    canonicalHash: hash.value as PlanHash,
    recordedAt: at.value,
  });
}

function reconciliationFromRow(
  row: SqliteRow,
): Result<PreparedLegReconciliationRecord> {
  const id = storedIdentifier(row, "reconciliation_id");
  const source = storedIdentifier(row, "source_id");
  const revision = requireFiniteInteger(row.revision, "revision", 1);
  const status = storedString(row, "status");
  const at = storedTimestamp(row, "observed_at");
  const order = storedOptionalString(row, "exchange_order_id");
  const json = storedString(row, "canonical_json");
  const hash = storedHash(row, "canonical_hash");
  if (
    !id.ok ||
    !source.ok ||
    !revision.ok ||
    !status.ok ||
    !at.ok ||
    !order.ok ||
    !json.ok ||
    !hash.ok ||
    !isStatus(status.value)
  )
    return persistenceFailure(
      "persisted prepared-leg reconciliation is invalid",
    );
  if (!parseCanonicalJson(json.value, hash.value).ok)
    return persistenceFailure("prepared-leg reconciliation hash is invalid");
  return ok({
    reconciliationId: id.value,
    sourceId: source.value,
    revision: revision.value,
    status: status.value,
    observedAt: at.value,
    ...(order.value === undefined ? {} : { exchangeOrderId: order.value }),
    canonicalJson: json.value,
    canonicalHash: hash.value as PlanHash,
  });
}

function validateAttempt(
  value: PreparedLegAttemptEvidence,
): Result<PreparedLegAttemptEvidence> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !["accepted", "rejected", "ambiguous"].includes(value.outcome) ||
    Object.keys(value).some(
      (key) =>
        !["outcome", "exchangeOrderId", "providerReasonCode"].includes(key),
    )
  )
    return invalid("attempt evidence contains unsupported fields");
  if (
    value.exchangeOrderId !== undefined &&
    !requireIdentifier(value.exchangeOrderId, "exchangeOrderId").ok
  )
    return invalid();
  if (
    value.providerReasonCode !== undefined &&
    !requireSafeText(value.providerReasonCode, "providerReasonCode").ok
  )
    return invalid();
  return ok(value);
}

function validateReconciliation(
  status: PreparedLegReconciliationStatus,
  result: AppendPreparedLegReconciliationRequest["result"],
): Result<void> {
  if (
    typeof result !== "object" ||
    result === null ||
    Array.isArray(result) ||
    Object.keys(result).some(
      (key) => !["orderProof", "fills", "reasonCodes"].includes(key),
    )
  )
    return invalid("reconciliation evidence contains unsupported fields");
  if (status === "UNRESOLVED") {
    return result.reasonCodes?.length &&
      result.reasonCodes.every((code) => requireSafeText(code, "reasonCode").ok)
      ? ok(undefined)
      : invalid("unresolved reconciliation needs safe reason codes");
  }
  const proof = result.orderProof;
  if (!proof || !isProducedPreparedLegOrderProof(proof))
    return invalid("resolved result needs provider order proof");
  const fills = result.fills ?? [];
  const zeroFills = proof.filledQuantity.isZero() && fills.length === 0;
  if (
    (status === "CONFIRMED_OPEN" && proof.status === "open" && zeroFills) ||
    (status === "CANCELLED" && proof.status === "cancelled" && zeroFills) ||
    (status === "REJECTED" && proof.status === "rejected" && zeroFills)
  )
    return ok(undefined);
  const partialFill =
    proof.filledQuantity.isPositive() &&
    proof.filledQuantity.compare(proof.requestedQuantity) < 0;
  const fullFill = proof.filledQuantity.compare(proof.requestedQuantity) === 0;
  const fillStatusConsistent =
    (proof.status === "partially-filled" && partialFill) ||
    (proof.status === "filled" && fullFill) ||
    (proof.status === "cancelled" && partialFill);
  if (
    status !== "PROTECTION_PENDING" ||
    !fillStatusConsistent ||
    fills.length === 0
  )
    return invalid("reconciliation status conflicts with provider facts");
  const seen = new Set<string>();
  const zeroDecimal = DecimalValue.fromString("0");
  if (!zeroDecimal.ok) return invalid();
  let total = zeroDecimal.value;
  for (const fill of fills) {
    if (
      !fill ||
      typeof fill !== "object" ||
      Object.keys(fill).some(
        (key) =>
          ![
            "executionId",
            "quantity",
            "price",
            "executedAt",
            "fee",
            "feeCurrency",
          ].includes(key),
      ) ||
      !requireIdentifier(fill.executionId, "executionId").ok ||
      seen.has(fill.executionId)
    )
      return invalid("fill identity is invalid or duplicated");
    seen.add(fill.executionId);
    const quantity = DecimalValue.fromString(fill.quantity);
    const price = DecimalValue.fromString(fill.price);
    const time = parseUtcTimestamp(fill.executedAt);
    if (
      !quantity.ok ||
      !quantity.value.isPositive() ||
      !price.ok ||
      !price.value.isPositive() ||
      !time.ok
    )
      return invalid("fill fact is invalid");
    if (fill.fee !== undefined) {
      const fee = DecimalValue.fromString(fill.fee);
      if (!fee.ok || fee.value.isNegative())
        return invalid("fill fee is invalid");
    }
    if (
      fill.feeCurrency !== undefined &&
      !requireIdentifier(fill.feeCurrency, "feeCurrency").ok
    )
      return invalid("fill fee currency is invalid");
    total = total.add(quantity.value);
  }
  return total.compare(proof.filledQuantity) === 0
    ? ok(undefined)
    : invalid("fill sum differs from provider order total");
}

export class SqlitePreparedLegStore implements PreparedLegPersistencePort {
  private readonly db: DatabaseSync;
  constructor(
    connection: SqliteConnection,
    readonly scope: PersistenceScope,
  ) {
    this.db = connection.db;
  }

  readPreparedLegSource(
    sourceId: string,
  ): Result<PreparedLegRunSnapshot | undefined> {
    const id = requireIdentifier(sourceId, "sourceId");
    if (!id.ok) return id;
    try {
      const row = this.sourceRow(id.value);
      return row ? this.snapshot(row) : ok(undefined);
    } catch (error) {
      return fail(sqliteError(error, "PERSISTENCE_INTEGRITY"));
    }
  }

  findPreparedLegSource(
    preparedHash: string,
    legId: string,
  ): Result<PreparedLegRunSnapshot | undefined> {
    const hash = requireHash(preparedHash, "preparedHash");
    const leg = requireIdentifier(legId, "legId");
    if (!hash.ok || !leg.ok) return invalid();
    return this.readPreparedLegSource(
      sourceIdFor(this.scope, hash.value, leg.value),
    );
  }

  preparePreparedLegCreate(
    request: PreparePreparedLegCreateRequest,
  ): Result<PreparePreparedLegCreateResult> {
    const run = requireIdentifier(request.runId, "runId");
    const at = parseUtcTimestamp(request.preparedAt);
    if (
      !run.ok ||
      !at.ok ||
      !scopeMatchesExecution(this.scope, request.execution)
    )
      return invalid();
    const exec = request.execution;
    const sourceId = sourceIdFor(this.scope, exec.preparedHash, exec.leg.legId);
    return runInTransaction(
      this.db,
      (db) => {
        const current = assertCurrentAuthorityWithinTransaction(
          db,
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
        const halt = haltRow(db, this.scope);
        if (!halt.ok) return halt;
        if (halt.value.active)
          return fail(
            domainError("HALT_ACTIVE", "HALT blocks a new prepared-leg create"),
          );
        const verified = this.verifyConsent(db, exec, at.value);
        if (!verified.ok) return verified;
        const selection = encode({
          preparedHash: exec.preparedHash,
          legId: exec.leg.legId,
          leg: exec.leg,
          clientOrderId: exec.clientOrderId,
        });
        if (!selection.ok) return selection;
        const existing = this.sourceRow(sourceId, db);
        if (existing) {
          const source = sourceFromRow(existing, this.scope);
          if (!source.ok) return source;
          if (
            source.value.selectionHash !== selection.value.hash ||
            source.value.clientOrderId !== exec.clientOrderId
          ) {
            const raised = raiseHaltWithinTransaction(
              db,
              this.scope,
              "prepared-leg identity conflict",
              at.value,
            );
            return raised.ok
              ? fail(
                  domainError(
                    "PERSISTENCE_CONFLICT",
                    "prepared-leg source conflicts",
                  ),
                )
              : raised;
          }
          const associated = this.associateApproval(
            db,
            sourceId,
            exec.approvalHash,
            at.value,
          );
          if (!associated.ok) return associated;
          const snapshot = this.snapshot(existing, db);
          return snapshot.ok
            ? ok({
                snapshot: snapshot.value,
                created: false,
                approvalAdded: associated.value,
              })
            : snapshot;
        }
        const pId = preparedId(exec.preparedHash);
        const aId = approvalId(exec.approvalHash);
        const prepared = this.assertArtifact(
          db,
          pId,
          "prepared-daily-plan",
          exec.preparedHash,
        );
        const approval = this.assertArtifact(
          db,
          aId,
          "prepared-plan-approval",
          exec.approvalHash,
        );
        if (!prepared.ok || !approval.ok)
          return invalid(
            "approved artifacts are absent from the scoped journal",
          );
        const intent = encode({
          schemaVersion: "prepared-leg-write-intent/v1",
          operation: "create",
          sourceId,
          runId: run.value,
          leaseEpoch: request.authority.epoch,
          preparedHash: exec.preparedHash,
          approvalHash: exec.approvalHash,
          legId: exec.leg.legId,
          clientOrderId: exec.clientOrderId,
          instrument: exec.leg.intent.instrument,
          side: exec.leg.intent.side,
          orderType: exec.leg.intent.orderType,
          price: exec.leg.intent.price,
          quantity: exec.leg.intent.quantity,
          timeInForce: exec.leg.timeInForce,
          takeProfit: exec.leg.intent.protection?.takeProfit,
          stopLoss: null,
          reduceOnly: false,
          positionIdx: 0,
        });
        if (!intent.ok) return intent;
        db.prepare(
          "INSERT INTO prepared_leg_sources (source_id, exchange, environment, account_id, category, position_mode, prepared_hash, prepared_artifact_id, leg_id, client_order_id, selection_json, selection_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          sourceId,
          ...scopeValues(this.scope),
          exec.preparedHash,
          pId,
          exec.leg.legId,
          exec.clientOrderId,
          selection.value.json,
          selection.value.hash,
          at.value,
        );
        const associated = this.associateApproval(
          db,
          sourceId,
          exec.approvalHash,
          at.value,
        );
        if (!associated.ok) return associated;
        this.insertIntent(db, {
          sourceId,
          operation: "create",
          runId: run.value,
          epoch: request.authority.epoch,
          clientOrderId: exec.clientOrderId,
          json: intent.value.json,
          hash: intent.value.hash,
          at: at.value,
        });
        const inserted = this.sourceRow(sourceId, db);
        if (!inserted) return invalid("prepared-leg source was not persisted");
        const snapshot = this.snapshot(inserted, db);
        return snapshot.ok
          ? ok({ snapshot: snapshot.value, created: true, approvalAdded: true })
          : snapshot;
      },
      "PERSISTENCE_CONFLICT",
    );
  }

  preparePreparedLegCancel(
    request: PreparePreparedLegCancelRequest,
  ): Result<PreparePreparedLegCancelResult> {
    const sourceId = requireIdentifier(request.sourceId, "sourceId");
    const run = requireIdentifier(request.runId, "runId");
    const at = parseUtcTimestamp(request.preparedAt);
    if (
      !sourceId.ok ||
      !run.ok ||
      !at.ok ||
      !isProducedPreparedLegOrderProof(request.proof)
    )
      return invalid();
    return runInTransaction(
      this.db,
      (db) => {
        const current = assertCurrentAuthorityWithinTransaction(
          db,
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
        const row = this.sourceRow(sourceId.value, db);
        if (!row)
          return fail(
            domainError(
              "OWNERSHIP_MISMATCH",
              "prepared-leg source does not exist",
            ),
          );
        const source = sourceFromRow(row, this.scope);
        const snapshot = this.snapshot(row, db);
        if (!source.ok || !snapshot.ok) return invalid();
        const last = snapshot.value.reconciliations.at(-1);
        const proof = request.proof;
        if (
          last?.status !== "CONFIRMED_OPEN" ||
          proof.status !== "open" ||
          !proof.filledQuantity.isZero() ||
          proof.clientOrderId !== source.value.clientOrderId ||
          last.exchangeOrderId !== proof.exchangeOrderId ||
          timestampToEpochMs(proof.observedAt) <
            timestampToEpochMs(last.observedAt) ||
          timestampToEpochMs(at.value) < timestampToEpochMs(proof.observedAt) ||
          timestampToEpochMs(at.value) - timestampToEpochMs(proof.observedAt) >
            CANCEL_PROOF_MAX_AGE_MS
        )
          return fail(
            domainError(
              "OWNERSHIP_MISMATCH",
              "fresh exact zero-fill order proof is required",
            ),
          );
        const exact = this.matchesSource(db, source.value, proof);
        if (!exact.ok) return exact;
        const previous = this.intentRow(sourceId.value, "cancel", db);
        if (previous) {
          const parsed = intentFromRow(previous);
          return parsed.ok &&
            parsed.value.exchangeOrderId === proof.exchangeOrderId
            ? ok({ snapshot: snapshot.value, created: false })
            : fail(
                domainError(
                  "PERSISTENCE_CONFLICT",
                  "cancel intent is already bound to another order",
                ),
              );
        }
        const intent = encode({
          schemaVersion: "prepared-leg-write-intent/v1",
          operation: "cancel",
          sourceId: sourceId.value,
          runId: run.value,
          leaseEpoch: request.authority.epoch,
          clientOrderId: source.value.clientOrderId,
          exchangeOrderId: proof.exchangeOrderId,
          observedAt: proof.observedAt,
          requestedQuantity: proof.requestedQuantity,
          filledQuantity: proof.filledQuantity,
        });
        if (!intent.ok) return intent;
        this.insertIntent(db, {
          sourceId: sourceId.value,
          operation: "cancel",
          runId: run.value,
          epoch: request.authority.epoch,
          clientOrderId: source.value.clientOrderId,
          exchangeOrderId: proof.exchangeOrderId,
          json: intent.value.json,
          hash: intent.value.hash,
          at: at.value,
        });
        const updated = this.sourceRow(sourceId.value, db);
        if (!updated) return invalid();
        const persisted = this.snapshot(updated, db);
        return persisted.ok
          ? ok({ snapshot: persisted.value, created: true })
          : persisted;
      },
      "PERSISTENCE_CONFLICT",
    );
  }

  appendPreparedLegAttempt(
    request: AppendPreparedLegAttemptRequest,
  ): Result<PreparedLegAttemptRecord> {
    const source = requireIdentifier(request.sourceId, "sourceId");
    const id = requireIdentifier(request.attemptId, "attemptId");
    const at = parseUtcTimestamp(request.recordedAt);
    const evidence = validateAttempt(request.result);
    if (!source.ok || !id.ok || !at.ok || !evidence.ok) return invalid();
    return runInTransaction(
      this.db,
      (db) => {
        const current = assertCurrentAuthorityWithinTransaction(
          db,
          this.scope,
          request.authority,
          at.value,
        );
        if (!current.ok) return current;
        const intentRow = this.intentRow(source.value, request.operation, db);
        if (!intentRow)
          return fail(
            domainError("OWNERSHIP_MISMATCH", "write intent does not exist"),
          );
        const intent = intentFromRow(intentRow);
        if (!intent.ok) return intent;
        if (intent.value.leaseEpoch !== request.authority.epoch)
          return fail(
            domainError("RUN_LEASE_LOST", "write intent lease was fenced"),
          );
        const body = encode({
          schemaVersion: "prepared-leg-write-attempt/v1",
          writeIntentId: intent.value.writeIntentId,
          operation: request.operation,
          result: evidence.value,
        });
        if (!body.ok) return body;
        const old = db
          .prepare(
            "SELECT attempt_id, write_intent_id, operation, canonical_json, canonical_hash, recorded_at FROM prepared_leg_attempts WHERE write_intent_id = ?",
          )
          .get(intent.value.writeIntentId) as SqliteRow | undefined;
        if (old) {
          const prior = attemptFromRow(old);
          if (prior.ok && prior.value.canonicalHash === body.value.hash)
            return prior;
          return fail(
            domainError(
              "PERSISTENCE_CONFLICT",
              "write intent already has a different attempt",
            ),
          );
        }
        db.prepare(
          "INSERT INTO prepared_leg_attempts (attempt_id, write_intent_id, operation, canonical_json, canonical_hash, recorded_at) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(
          id.value,
          intent.value.writeIntentId,
          request.operation,
          body.value.json,
          body.value.hash,
          at.value,
        );
        const inserted = db
          .prepare(
            "SELECT attempt_id, write_intent_id, operation, canonical_json, canonical_hash, recorded_at FROM prepared_leg_attempts WHERE attempt_id = ?",
          )
          .get(id.value) as SqliteRow | undefined;
        return inserted ? attemptFromRow(inserted) : invalid();
      },
      "PERSISTENCE_CONFLICT",
    );
  }

  appendPreparedLegReconciliation(
    request: AppendPreparedLegReconciliationRequest,
  ): Result<PreparedLegReconciliationRecord> {
    const source = requireIdentifier(request.sourceId, "sourceId");
    const at = parseUtcTimestamp(request.observedAt);
    const order =
      request.exchangeOrderId === undefined
        ? ok<string | undefined>(undefined)
        : requireIdentifier(request.exchangeOrderId, "exchangeOrderId");
    const evidence = validateReconciliation(request.status, request.result);
    if (!source.ok || !at.ok || !order.ok || !evidence.ok) return invalid();
    return runInTransaction(
      this.db,
      (db) => {
        const current = assertCurrentAuthorityWithinTransaction(
          db,
          this.scope,
          request.authority,
          at.value,
        );
        if (!current.ok) return current;
        const sourceRow = this.sourceRow(source.value, db);
        if (!sourceRow)
          return fail(
            domainError(
              "OWNERSHIP_MISMATCH",
              "prepared-leg source does not exist",
            ),
          );
        const parsedSource = sourceFromRow(sourceRow, this.scope);
        if (!parsedSource.ok) return parsedSource;
        let status = request.status;
        let evidenceResult = request.result;
        const proof = evidenceResult.orderProof;
        if (proof) {
          const exact = this.matchesSource(db, parsedSource.value, proof);
          const proofConflict =
            order.value !== undefined && proof.exchangeOrderId !== order.value;
          if (!exact.ok || proofConflict) {
            status = "UNRESOLVED";
            evidenceResult = {
              ...evidenceResult,
              reasonCodes: [
                ...(evidenceResult.reasonCodes ?? []),
                "ORDER_IDENTITY_OR_TERMS_CONFLICT",
              ],
            };
          }
        }
        const priorRows = db
          .prepare(
            "SELECT reconciliation_id, source_id, revision, status, observed_at, exchange_order_id, canonical_json, canonical_hash FROM prepared_leg_reconciliations WHERE source_id = ? ORDER BY revision DESC LIMIT 1",
          )
          .get(source.value) as SqliteRow | undefined;
        if (priorRows && proof) {
          const prior = reconciliationFromRow(priorRows);
          if (!prior.ok) return prior;
          if (
            prior.value.exchangeOrderId !== undefined &&
            prior.value.exchangeOrderId !== proof.exchangeOrderId
          ) {
            status = "UNRESOLVED";
            evidenceResult = {
              ...evidenceResult,
              reasonCodes: [
                ...(evidenceResult.reasonCodes ?? []),
                "EXCHANGE_ORDER_ID_CHANGED",
              ],
            };
          }
        }
        const validatedEvidence = validateReconciliation(
          status,
          evidenceResult,
        );
        if (!validatedEvidence.ok) return validatedEvidence;
        const revision = requireFiniteInteger(
          Number(priorRows?.revision ?? 0),
          "revision",
          0,
        );
        if (!revision.ok) return revision;
        const next = revision.value + 1;
        const orderId = order.value ?? proof?.exchangeOrderId;
        const body = encode({
          schemaVersion: "prepared-leg-reconciliation/v1",
          sourceId: source.value,
          revision: next,
          status,
          observedAt: at.value,
          ...(orderId ? { exchangeOrderId: orderId } : {}),
          result: evidenceResult,
        });
        if (!body.ok) return body;
        const id = deterministicId(
          "prepared-leg-reconciliation",
          source.value + ":" + next + ":" + body.value.hash,
        );
        db.prepare(
          "INSERT INTO prepared_leg_reconciliations (reconciliation_id, source_id, revision, status, observed_at, exchange_order_id, canonical_json, canonical_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          id,
          source.value,
          next,
          status,
          at.value,
          orderId ?? null,
          body.value.json,
          body.value.hash,
        );
        if (status === "UNRESOLVED" || status === "PROTECTION_PENDING") {
          const halted = raiseHaltWithinTransaction(
            db,
            this.scope,
            status === "UNRESOLVED"
              ? "prepared-leg reconciliation unresolved"
              : "prepared-leg protection pending",
            at.value,
            body.value.json,
          );
          if (!halted.ok) return halted;
        }
        const inserted = db
          .prepare(
            "SELECT reconciliation_id, source_id, revision, status, observed_at, exchange_order_id, canonical_json, canonical_hash FROM prepared_leg_reconciliations WHERE reconciliation_id = ?",
          )
          .get(id) as SqliteRow | undefined;
        return inserted ? reconciliationFromRow(inserted) : invalid();
      },
      "PERSISTENCE_CONFLICT",
    );
  }

  private verifyConsent(
    db: DatabaseSync,
    execution: PreparedLegExecution,
    now: UtcTimestamp,
  ): Result<void> {
    const envelope = this.readArtifact(
      db,
      approvalId(execution.approvalHash),
      "prepared-plan-approval",
      execution.approvalHash,
    );
    if (!envelope.ok) return envelope;
    const approval = rehydrateArtifact(
      "prepared-plan-approval",
      envelope.value,
    );
    if (!approval.ok) return invalid("stored approval failed rehydration");
    const recreated = createPreparedLegExecution({
      approval: approval.value,
      approvalHash: execution.approvalHash,
      legId: execution.leg.legId,
      now,
    });
    if (!recreated.ok) return recreated;
    const expected = encode(recreated.value);
    const actual = encode(execution);
    return expected.ok && actual.ok && expected.value.hash === actual.value.hash
      ? ok(undefined)
      : invalid("execution does not match the exact persisted approval");
  }

  private readArtifact(
    db: DatabaseSync,
    id: string,
    kind: "prepared-daily-plan" | "prepared-plan-approval",
    material: string,
  ): Result<CanonicalArtifactEnvelope> {
    const row = db
      .prepare(
        "SELECT exchange, environment, account_id, category, position_mode, artifact_kind, schema_version, canonical_json, canonical_hash, material_hash FROM artifacts WHERE artifact_id = ?",
      )
      .get(id) as SqliteRow | undefined;
    if (!row)
      return fail(
        domainError(
          "PERSISTENCE_CONFLICT",
          "approved artifact must be saved before execution",
        ),
      );
    if (
      row.exchange !== this.scope.exchange ||
      row.environment !== this.scope.environment ||
      row.account_id !== this.scope.accountId ||
      row.category !== this.scope.category ||
      row.position_mode !== this.scope.positionMode ||
      row.artifact_kind !== kind ||
      row.material_hash !== material ||
      typeof row.schema_version !== "string" ||
      typeof row.canonical_json !== "string" ||
      typeof row.canonical_hash !== "string"
    )
      return invalid("stored artifact scope or hash conflicts");
    const envelope: CanonicalArtifactEnvelope = {
      artifactKind: kind,
      schemaVersion: row.schema_version as "artifact/v1",
      canonicalJson: row.canonical_json,
      canonicalHash: row.canonical_hash,
    };
    return rehydrateArtifact(kind, envelope).ok
      ? ok(envelope)
      : invalid("stored artifact failed canonical verification");
  }

  private assertArtifact(
    db: DatabaseSync,
    id: string,
    kind: "prepared-daily-plan" | "prepared-plan-approval",
    hash: string,
  ): Result<void> {
    const found = this.readArtifact(db, id, kind, hash);
    return found.ok ? ok(undefined) : found;
  }

  private associateApproval(
    db: DatabaseSync,
    source: string,
    hash: string,
    at: UtcTimestamp,
  ): Result<boolean> {
    const id = approvalId(hash);
    const artifact = this.assertArtifact(
      db,
      id,
      "prepared-plan-approval",
      hash,
    );
    if (!artifact.ok) return artifact;
    const prior = db
      .prepare(
        "SELECT approval_artifact_id FROM prepared_leg_approvals WHERE source_id = ? AND approval_hash = ?",
      )
      .get(source, hash) as SqliteRow | undefined;
    if (prior)
      return prior.approval_artifact_id === id
        ? ok(false)
        : fail(
            domainError(
              "PERSISTENCE_CONFLICT",
              "approval association conflicts",
            ),
          );
    db.prepare(
      "INSERT INTO prepared_leg_approvals (source_id, approval_hash, approval_artifact_id, associated_at) VALUES (?, ?, ?, ?)",
    ).run(source, hash, id, at);
    return ok(true);
  }

  private insertIntent(
    db: DatabaseSync,
    input: {
      sourceId: string;
      operation: PreparedLegOperation;
      runId: string;
      epoch: number;
      clientOrderId: string;
      exchangeOrderId?: string;
      json: string;
      hash: PlanHash;
      at: UtcTimestamp;
    },
  ): void {
    const id = deterministicId(
      "prepared-leg-intent",
      input.sourceId + ":" + input.operation,
    );
    db.prepare(
      "INSERT INTO prepared_leg_write_intents (write_intent_id, source_id, operation, run_id, lease_epoch, client_order_id, exchange_order_id, canonical_json, canonical_hash, prepared_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      id,
      input.sourceId,
      input.operation,
      input.runId,
      input.epoch,
      input.clientOrderId,
      input.exchangeOrderId ?? null,
      input.json,
      input.hash,
      input.at,
    );
  }

  private sourceRow(id: string, db = this.db): SqliteRow | undefined {
    return db
      .prepare(
        "SELECT source_id, prepared_hash, leg_id, client_order_id, selection_json, selection_hash, created_at FROM prepared_leg_sources WHERE source_id = ? AND exchange = ? AND environment = ? AND account_id = ? AND category = ? AND position_mode = ?",
      )
      .get(id, ...scopeValues(this.scope)) as SqliteRow | undefined;
  }

  private intentRow(
    source: string,
    operation: PreparedLegOperation,
    db: DatabaseSync,
  ): SqliteRow | undefined {
    return db
      .prepare(
        "SELECT write_intent_id, source_id, operation, run_id, lease_epoch, client_order_id, exchange_order_id, canonical_json, canonical_hash, prepared_at FROM prepared_leg_write_intents WHERE source_id = ? AND operation = ?",
      )
      .get(source, operation) as SqliteRow | undefined;
  }

  private snapshot(
    row: SqliteRow,
    db = this.db,
  ): Result<PreparedLegRunSnapshot> {
    const lineage = sourceFromRow(row, this.scope);
    if (!lineage.ok) return lineage;
    const intents = db
      .prepare(
        "SELECT write_intent_id, source_id, operation, run_id, lease_epoch, client_order_id, exchange_order_id, canonical_json, canonical_hash, prepared_at FROM prepared_leg_write_intents WHERE source_id = ? ORDER BY operation",
      )
      .all(lineage.value.sourceId) as SqliteRow[];
    let createIntent: PreparedLegRunSnapshot["createIntent"] | undefined;
    let cancelIntent: PreparedLegRunSnapshot["cancelIntent"];
    for (const item of intents) {
      const parsed = intentFromRow(item);
      if (!parsed.ok) return parsed;
      if (parsed.value.operation === "create") createIntent = parsed.value;
      else cancelIntent = parsed.value;
    }
    if (!createIntent) return invalid("source has no durable create intent");
    const approvals = db
      .prepare(
        "SELECT approval_hash FROM prepared_leg_approvals WHERE source_id = ? ORDER BY associated_at, approval_hash",
      )
      .all(lineage.value.sourceId) as SqliteRow[];
    const approvalHashes: PlanHash[] = [];
    for (const item of approvals) {
      const hash = storedHash(item, "approval_hash");
      if (!hash.ok) return hash;
      approvalHashes.push(hash.value as PlanHash);
    }
    const readAttempt = (
      intent: PreparedLegRunSnapshot["createIntent"] | undefined,
    ): Result<PreparedLegAttemptRecord | undefined> => {
      if (!intent) return ok(undefined);
      const item = db
        .prepare(
          "SELECT attempt_id, write_intent_id, operation, canonical_json, canonical_hash, recorded_at FROM prepared_leg_attempts WHERE write_intent_id = ?",
        )
        .get(intent.writeIntentId) as SqliteRow | undefined;
      if (!item) return ok(undefined);
      const parsed = attemptFromRow(item);
      return parsed.ok ? ok(parsed.value) : parsed;
    };
    const createAttempt = readAttempt(createIntent);
    const cancelAttempt = readAttempt(cancelIntent);
    if (!createAttempt.ok || !cancelAttempt.ok)
      return invalid("attempt record is invalid");
    const rows = db
      .prepare(
        "SELECT reconciliation_id, source_id, revision, status, observed_at, exchange_order_id, canonical_json, canonical_hash FROM prepared_leg_reconciliations WHERE source_id = ? ORDER BY revision",
      )
      .all(lineage.value.sourceId) as SqliteRow[];
    const reconciliations: PreparedLegReconciliationRecord[] = [];
    for (const item of rows) {
      const parsed = reconciliationFromRow(item);
      if (!parsed.ok) return parsed;
      reconciliations.push(parsed.value);
    }
    const halt = haltRow(db, this.scope);
    const lease = leaseRow(db, this.scope);
    if (!halt.ok || !lease.ok)
      return invalid("persisted HALT or lease state is invalid");
    return ok({
      lineage: lineage.value,
      approvalHashes,
      createIntent,
      ...(cancelIntent ? { cancelIntent } : {}),
      ...(createAttempt.value ? { createAttempt: createAttempt.value } : {}),
      ...(cancelAttempt.value ? { cancelAttempt: cancelAttempt.value } : {}),
      reconciliations,
      halt: halt.value,
      ...(lease.value ? { lease: leaseState(this.scope, lease.value) } : {}),
    });
  }

  private matchesSource(
    db: DatabaseSync,
    source: PreparedLegLineageRecord,
    proof: PreparedLegOrderProof,
  ): Result<void> {
    const envelope = this.readArtifact(
      db,
      preparedId(source.preparedHash),
      "prepared-daily-plan",
      source.preparedHash,
    );
    if (!envelope.ok) return envelope;
    const prepared = rehydrateArtifact("prepared-daily-plan", envelope.value);
    if (!prepared.ok)
      return invalid("prepared artifact could not be rehydrated");
    const legs =
      prepared.value.replayInputs.preflight.replayInputs.dailyPlan
        .candidateLegs ?? [];
    const selected = legs.filter((leg) => leg.legId === source.legId);
    if (selected.length !== 1)
      return invalid("stored source leg is missing or ambiguous");
    const execution: PreparedLegSourceIdentity = {
      environment: "mainnet",
      accountIdentityHash: this.scope.accountId,
      preparedHash: source.preparedHash,
      leg: selected[0]!,
      clientOrderId: source.clientOrderId,
    };
    return matchesPreparedLegOrder(proof, execution)
      ? ok(undefined)
      : fail(
          domainError(
            "OWNERSHIP_MISMATCH",
            "order proof does not match the durable prepared leg",
          ),
        );
  }
}

function scopeMatchesExecution(
  scope: PersistenceScope,
  execution: PreparedLegExecution,
): boolean {
  const clientId = derivePreparedLegClientOrderId(
    execution.preparedHash,
    execution.leg.legId,
  );
  return (
    scope.exchange === "bybit" &&
    scope.environment === "mainnet" &&
    scope.accountId === execution.accountIdentityHash &&
    scope.category === "linear" &&
    scope.positionMode === "one-way" &&
    execution.environment === "mainnet" &&
    clientId.ok &&
    clientId.value === execution.clientOrderId
  );
}

export function createSqlitePreparedLegStore(
  connection: SqliteConnection,
  scope: PersistenceScope,
): Result<SqlitePreparedLegStore> {
  const validated = createSqliteExecutionStore(connection, scope);
  if (!validated.ok) return validated;
  const normalized = validated.value.scope;
  if (
    normalized.exchange !== "bybit" ||
    normalized.environment !== "mainnet" ||
    normalized.category !== "linear" ||
    normalized.positionMode !== "one-way" ||
    !requireHash(normalized.accountId, "accountIdentityHash").ok
  )
    return fail(
      domainError(
        "PERSISTENCE_ENVIRONMENT",
        "prepared-leg store requires sanitized Mainnet Bybit one-way scope",
      ),
    );
  return ok(new SqlitePreparedLegStore(connection, normalized));
}
