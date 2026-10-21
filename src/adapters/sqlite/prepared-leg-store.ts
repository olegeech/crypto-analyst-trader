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
  createPreparedLegGridExecution,
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
  isRecord,
  onlyKeys,
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
  PreparedLegProtectionEvidenceV2,
  PreparedLegProtectionEvidenceV2Input,
  PreparedLegReconciliationRecord,
  PreparedLegReconciliationStatus,
  LegacyPreparedLegReconciliationStatus,
  PreparedLegRunSnapshot,
  PreparedLegRemainderCancelProof,
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

function isStatus(
  value: string,
): value is LegacyPreparedLegReconciliationStatus {
  return [
    "CONFIRMED_OPEN",
    "PROTECTION_PENDING",
    "CANCELLED",
    "REJECTED",
    "UNRESOLVED",
  ].includes(value);
}

function isV2ProtectionStatus(
  value: string,
): value is PreparedLegProtectionEvidenceV2["status"] {
  return [
    "PROTECTION_PENDING",
    "PROTECTION_CONFIRMED",
    "VERIFIED_CLOSED",
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

function validateRemainderCancelProof(
  value: unknown,
): Result<PreparedLegRemainderCancelProof> {
  if (
    !exactRecord(value, [
      "schemaVersion",
      "sourceId",
      "leaseEpoch",
      "parentExchangeOrderId",
      "clientOrderId",
      "requestedQuantity",
      "filledQuantity",
      "unfilledRemainder",
      "outstandingQuantity",
      "entryExecutionIds",
      "exitExecutionIds",
      "protectionEvidenceHash",
      "coverageHash",
      "approvedCancelPlanHash",
      "remainderCancelProofHash",
      "observedAt",
    ]) ||
    value.schemaVersion !== "prepared-leg-remainder-cancel-proof/v1" ||
    typeof value.sourceId !== "string" ||
    !requireIdentifier(value.sourceId, "sourceId").ok ||
    typeof value.leaseEpoch !== "number" ||
    !Number.isSafeInteger(value.leaseEpoch) ||
    value.leaseEpoch < 1 ||
    typeof value.parentExchangeOrderId !== "string" ||
    !requireIdentifier(value.parentExchangeOrderId, "parentExchangeOrderId")
      .ok ||
    typeof value.clientOrderId !== "string" ||
    !requireIdentifier(value.clientOrderId, "clientOrderId").ok ||
    !exactDecimal(value.requestedQuantity, true) ||
    !exactDecimal(value.filledQuantity, true) ||
    !exactDecimal(value.unfilledRemainder, true) ||
    !exactDecimal(value.outstandingQuantity, false) ||
    !Array.isArray(value.entryExecutionIds) ||
    !value.entryExecutionIds.every(
      (id) => requireIdentifier(id, "entryExecutionId").ok,
    ) ||
    new Set(value.entryExecutionIds).size !== value.entryExecutionIds.length ||
    !Array.isArray(value.exitExecutionIds) ||
    !value.exitExecutionIds.every(
      (id) => requireIdentifier(id, "exitExecutionId").ok,
    ) ||
    new Set(value.exitExecutionIds).size !== value.exitExecutionIds.length ||
    !requireHash(value.protectionEvidenceHash, "protectionEvidenceHash").ok ||
    !requireHash(value.coverageHash, "coverageHash").ok ||
    !requireHash(value.approvedCancelPlanHash, "approvedCancelPlanHash").ok ||
    !requireHash(value.remainderCancelProofHash, "remainderCancelProofHash")
      .ok ||
    !parseUtcTimestamp(value.observedAt).ok
  )
    return invalid("remainder-cancel proof is malformed");
  const requested = DecimalValue.fromString(value.requestedQuantity);
  const filled = DecimalValue.fromString(value.filledQuantity);
  const remainder = DecimalValue.fromString(value.unfilledRemainder);
  if (
    !requested.ok ||
    !filled.ok ||
    !remainder.ok ||
    filled.value.compare(requested.value) >= 0 ||
    requested.value.subtract(filled.value).compare(remainder.value) !== 0
  )
    return invalid("remainder-cancel quantities conflict");
  const { remainderCancelProofHash, ...body } = value;
  const calculatedHash = hashCanonical(body);
  return calculatedHash.ok && calculatedHash.value === remainderCancelProofHash
    ? ok(value as unknown as PreparedLegRemainderCancelProof)
    : invalid("remainder-cancel proof hash is invalid");
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
  const parsedBody = parseCanonicalJson(json.value, hash.value);
  if (!parsedBody.ok)
    return persistenceFailure("prepared-leg intent hash is invalid");
  let remainderCancelProof: PreparedLegRemainderCancelProof | undefined;
  if (
    typeof parsedBody.value === "object" &&
    parsedBody.value !== null &&
    !Array.isArray(parsedBody.value) &&
    (parsedBody.value as Record<string, unknown>).schemaVersion ===
      "prepared-leg-write-intent/v2"
  ) {
    const body = parsedBody.value as Record<string, unknown>;
    const parsedProof = validateRemainderCancelProof(body.remainderCancelProof);
    if (
      !parsedProof.ok ||
      operation.value !== "cancel" ||
      body.sourceId !== sourceId.value ||
      body.clientOrderId !== client.value ||
      body.exchangeOrderId !== exchange.value ||
      body.leaseEpoch !== epoch.value ||
      Object.keys(body).some(
        (key) =>
          ![
            "schemaVersion",
            "operation",
            "sourceId",
            "runId",
            "leaseEpoch",
            "clientOrderId",
            "exchangeOrderId",
            "observedAt",
            "requestedQuantity",
            "filledQuantity",
            "remainderCancelProof",
          ].includes(key),
      )
    )
      return persistenceFailure(
        "prepared-leg remainder-cancel intent is invalid",
      );
    remainderCancelProof = parsedProof.value;
  }
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
    ...(remainderCancelProof === undefined ? {} : { remainderCancelProof }),
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

function protectionEvidenceFromRow(row: SqliteRow): Result<{
  readonly evidence: PreparedLegProtectionEvidenceV2;
  readonly canonicalJson: string;
  readonly canonicalHash: PlanHash;
}> {
  const reconciliationId = storedIdentifier(row, "reconciliation_id");
  const sourceId = storedIdentifier(row, "source_id");
  const revision = requireFiniteInteger(row.revision, "revision", 1);
  const status = storedString(row, "status");
  const json = storedString(row, "canonical_json");
  const hash = storedHash(row, "canonical_hash");
  if (
    !reconciliationId.ok ||
    !sourceId.ok ||
    !revision.ok ||
    !status.ok ||
    !json.ok ||
    !hash.ok ||
    !isV2ProtectionStatus(status.value)
  )
    return persistenceFailure("persisted v2 protection evidence is invalid");
  const parsed = parseCanonicalJson(json.value, hash.value);
  if (!parsed.ok) return parsed;
  const evidence = parsed.value as PreparedLegProtectionEvidenceV2;
  if (
    evidence.schemaVersion !== "prepared-leg-protection-evidence/v2" ||
    evidence.sourceId !== sourceId.value ||
    evidence.revision !== revision.value ||
    evidence.status !== status.value
  )
    return persistenceFailure(
      "persisted v2 protection evidence lineage conflicts",
    );
  const { sourceId: _sourceId, revision: _revision, ...input } = evidence;
  void _sourceId;
  void _revision;
  const validated = validateProtectionEvidenceV2(input);
  if (!validated.ok)
    return persistenceFailure("persisted v2 protection evidence is malformed");
  return ok({
    evidence,
    canonicalJson: json.value,
    canonicalHash: hash.value as PlanHash,
  });
}

function reconciliationFromRow(
  row: SqliteRow,
  protectionRow?: SqliteRow,
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
  const protection = protectionRow
    ? protectionEvidenceFromRow(protectionRow)
    : ok<
        | {
            readonly evidence: PreparedLegProtectionEvidenceV2;
            readonly canonicalJson: string;
            readonly canonicalHash: PlanHash;
          }
        | undefined
      >(undefined);
  if (!protection.ok) return protection;
  if (
    protection.value !== undefined &&
    (status.value !== "PROTECTION_PENDING" ||
      protection.value.evidence.sourceId !== source.value ||
      protection.value.evidence.revision !== revision.value)
  )
    return persistenceFailure(
      "v2 protection evidence does not match reconciliation",
    );
  const effectiveStatus = protection.value?.evidence.status ?? status.value;
  return ok({
    reconciliationId: id.value,
    sourceId: source.value,
    revision: revision.value,
    status: effectiveStatus,
    ...(protection.value === undefined
      ? {}
      : {
          legacyStatus: status.value,
          protectionEvidence: protection.value.evidence,
          protectionCanonicalJson: protection.value.canonicalJson,
          protectionCanonicalHash: protection.value.canonicalHash,
        }),
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
  protectionEvidence?: PreparedLegProtectionEvidenceV2Input,
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
  const legacyStatus =
    status === "PROTECTION_CONFIRMED" || status === "VERIFIED_CLOSED"
      ? "PROTECTION_PENDING"
      : status;
  if (
    (legacyStatus === "CONFIRMED_OPEN" &&
      proof.status === "open" &&
      zeroFills) ||
    (legacyStatus === "CANCELLED" &&
      proof.status === "cancelled" &&
      zeroFills) ||
    (legacyStatus === "REJECTED" && proof.status === "rejected" && zeroFills)
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
  const pendingExposureIsUncertain =
    protectionEvidence?.status === "PROTECTION_PENDING" &&
    proof.filledQuantity.isPositive();
  if (
    legacyStatus !== "PROTECTION_PENDING" ||
    (!fillStatusConsistent && !pendingExposureIsUncertain) ||
    (fills.length === 0 && protectionEvidence?.status !== "PROTECTION_PENDING")
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
  return total.compare(proof.filledQuantity) === 0 ||
    protectionEvidence?.status === "PROTECTION_PENDING"
    ? ok(undefined)
    : invalid("fill sum differs from provider order total");
}

function exactRecord(
  value: unknown,
  allowed: readonly string[],
): value is Record<string, unknown> {
  return isRecord(value) && onlyKeys(value, allowed);
}

function exactDecimal(value: unknown, positive: boolean): value is string {
  if (typeof value !== "string") return false;
  const parsed = DecimalValue.fromString(value);
  return (
    parsed.ok &&
    parsed.value.toString() === value &&
    (positive ? parsed.value.isPositive() : !parsed.value.isNegative())
  );
}

function exactSignedDecimal(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = DecimalValue.fromString(value);
  return parsed.ok && parsed.value.toString() === value;
}

function validEvidenceFills(
  value: unknown,
): value is PreparedLegProtectionEvidenceV2Input["entries"]["fills"] {
  if (!Array.isArray(value)) return false;
  const seen = new Set<string>();
  return value.every((fill) => {
    if (
      !exactRecord(fill, [
        "executionId",
        "exchangeOrderId",
        "clientOrderId",
        "instrument",
        "side",
        "quantity",
        "price",
        "executedAt",
        "source",
      ]) ||
      typeof fill.executionId !== "string" ||
      !requireIdentifier(fill.executionId, "executionId").ok ||
      seen.has(fill.executionId) ||
      typeof fill.exchangeOrderId !== "string" ||
      !requireIdentifier(fill.exchangeOrderId, "exchangeOrderId").ok ||
      typeof fill.clientOrderId !== "string" ||
      (fill.clientOrderId !== "" &&
        !requireIdentifier(fill.clientOrderId, "clientOrderId").ok) ||
      typeof fill.instrument !== "string" ||
      !requireIdentifier(fill.instrument, "instrument").ok ||
      (fill.side !== "buy" && fill.side !== "sell") ||
      !exactDecimal(fill.quantity, true) ||
      !exactDecimal(fill.price, true) ||
      !parseUtcTimestamp(fill.executedAt).ok ||
      typeof fill.source !== "string" ||
      !requireSafeText(fill.source, "source").ok
    )
      return false;
    seen.add(fill.executionId);
    return true;
  });
}

function validateProtectionEvidenceV2(
  value: PreparedLegProtectionEvidenceV2Input,
  aggregatePosition?: DecimalValue,
): Result<void> {
  if (
    !exactRecord(value, [
      "schemaVersion",
      "status",
      "observedAt",
      "parent",
      "entries",
      "exits",
      "children",
      "coverage",
      "position",
      "collection",
      "reasonCodes",
      "aggregate",
    ]) ||
    value.schemaVersion !== "prepared-leg-protection-evidence/v2" ||
    !isV2ProtectionStatus(value.status) ||
    !parseUtcTimestamp(value.observedAt).ok ||
    !exactRecord(value.parent, [
      "exchangeOrderId",
      "clientOrderId",
      "instrument",
      "category",
      "side",
      "requestedQuantity",
      "filledQuantity",
      "status",
      "source",
      "observedAt",
      "takeProfit",
      "providerTpslMode",
      "takeProfitTriggerBy",
    ]) ||
    typeof value.parent.exchangeOrderId !== "string" ||
    !requireIdentifier(value.parent.exchangeOrderId, "exchangeOrderId").ok ||
    typeof value.parent.clientOrderId !== "string" ||
    !requireIdentifier(value.parent.clientOrderId, "clientOrderId").ok ||
    typeof value.parent.instrument !== "string" ||
    !requireIdentifier(value.parent.instrument, "instrument").ok ||
    typeof value.parent.category !== "string" ||
    !requireSafeText(value.parent.category, "category").ok ||
    (value.parent.side !== "buy" && value.parent.side !== "sell") ||
    !exactDecimal(value.parent.requestedQuantity, true) ||
    !exactDecimal(value.parent.filledQuantity, false) ||
    !parseUtcTimestamp(value.parent.observedAt).ok ||
    typeof value.parent.status !== "string" ||
    typeof value.parent.source !== "string" ||
    !requireSafeText(value.parent.source, "source").ok ||
    (value.parent.takeProfit !== null &&
      !exactDecimal(value.parent.takeProfit, true)) ||
    (value.parent.providerTpslMode !== undefined &&
      !requireSafeText(value.parent.providerTpslMode, "providerTpslMode").ok) ||
    (value.parent.takeProfitTriggerBy !== undefined &&
      !["LastPrice", "MarkPrice", "IndexPrice"].includes(
        value.parent.takeProfitTriggerBy,
      )) ||
    !exactRecord(value.entries, ["quantity", "executionIds", "fills"]) ||
    !exactRecord(value.exits, ["quantity", "executionIds", "fills"]) ||
    !Array.isArray(value.entries.executionIds) ||
    !Array.isArray(value.exits.executionIds) ||
    !validEvidenceFills(value.entries.fills) ||
    !validEvidenceFills(value.exits.fills) ||
    !Array.isArray(value.children) ||
    !exactRecord(value.coverage, [
      "outstandingQuantity",
      "activeRemainingQuantity",
      "covered",
      "reasonCodes",
    ]) ||
    !exactRecord(value.position, [
      "instrument",
      "side",
      "quantity",
      "serverTime",
    ]) ||
    typeof value.position.instrument !== "string" ||
    !requireIdentifier(value.position.instrument, "instrument").ok ||
    !["long", "short", "flat"].includes(value.position.side) ||
    !exactDecimal(value.position.quantity, false) ||
    !parseUtcTimestamp(value.position.serverTime).ok ||
    !exactRecord(value.collection, [
      "entryFills",
      "childOrders",
      "exitFills",
      "position",
    ]) ||
    !["complete", "incomplete"].includes(value.collection.entryFills) ||
    !["complete", "incomplete", "not-required"].includes(
      value.collection.childOrders,
    ) ||
    !["complete", "incomplete", "not-required"].includes(
      value.collection.exitFills,
    ) ||
    !["complete", "incomplete"].includes(value.collection.position) ||
    !Array.isArray(value.reasonCodes) ||
    !value.reasonCodes.every((code) => requireSafeText(code, "reasonCode").ok)
  )
    return invalid("v2 protection evidence is malformed");

  const entryIds = value.entries.fills.map((fill) => fill.executionId).sort();
  const exitIds = value.exits.fills.map((fill) => fill.executionId).sort();
  if (
    JSON.stringify(entryIds) !==
      JSON.stringify([...value.entries.executionIds].sort()) ||
    JSON.stringify(exitIds) !==
      JSON.stringify([...value.exits.executionIds].sort()) ||
    new Set(value.entries.executionIds).size !==
      value.entries.executionIds.length ||
    new Set(value.exits.executionIds).size !==
      value.exits.executionIds.length ||
    (value.entries.quantity !== null &&
      !exactDecimal(value.entries.quantity, false)) ||
    (value.exits.quantity !== null &&
      !exactDecimal(value.exits.quantity, false)) ||
    (value.coverage.outstandingQuantity !== null &&
      !exactSignedDecimal(value.coverage.outstandingQuantity)) ||
    (value.coverage.activeRemainingQuantity !== null &&
      !exactSignedDecimal(value.coverage.activeRemainingQuantity)) ||
    (value.coverage.covered !== null &&
      typeof value.coverage.covered !== "boolean") ||
    !Array.isArray(value.coverage.reasonCodes) ||
    !value.coverage.reasonCodes.every(
      (code) => requireSafeText(code, "reasonCode").ok,
    )
  )
    return invalid("v2 protection quantities or execution identities conflict");

  const zero = DecimalValue.fromString("0");
  if (!zero.ok) return invalid();
  let entryTotal = zero.value;
  let exitTotal = zero.value;
  for (const fill of value.entries.fills) {
    const quantity = DecimalValue.fromString(fill.quantity);
    if (!quantity.ok) return invalid();
    entryTotal = entryTotal.add(quantity.value);
  }
  for (const fill of value.exits.fills) {
    const quantity = DecimalValue.fromString(fill.quantity);
    if (!quantity.ok) return invalid();
    exitTotal = exitTotal.add(quantity.value);
  }
  const storedEntryTotal =
    value.entries.quantity === null
      ? undefined
      : DecimalValue.fromString(value.entries.quantity);
  const storedExitTotal =
    value.exits.quantity === null
      ? undefined
      : DecimalValue.fromString(value.exits.quantity);
  const parentFillTotal = DecimalValue.fromString(value.parent.filledQuantity);
  if (
    (storedEntryTotal !== undefined &&
      (!storedEntryTotal.ok ||
        entryTotal.compare(storedEntryTotal.value) !== 0)) ||
    (storedExitTotal !== undefined &&
      (!storedExitTotal.ok ||
        exitTotal.compare(storedExitTotal.value) !== 0)) ||
    !parentFillTotal.ok ||
    (value.status !== "PROTECTION_PENDING" &&
      value.entries.quantity !== null &&
      entryTotal.compare(parentFillTotal.value) !== 0)
  )
    return invalid("v2 protection fill totals conflict");

  for (const child of value.children) {
    if (
      !exactRecord(child, [
        "exchangeOrderId",
        "clientOrderId",
        "instrument",
        "providerOrderLinkId",
        "parentOrderLinkId",
        "category",
        "orderType",
        "price",
        "side",
        "requestedQuantity",
        "filledQuantity",
        "remainingQuantity",
        "status",
        "source",
        "observedAt",
        "providerCreatedAt",
        "providerUpdatedAt",
        "providerStopOrderType",
        "providerTpslMode",
        "protectionType",
        "reduceOnly",
        "positionIdx",
        "triggerPrice",
        "triggerBy",
        "takeProfitTriggerBy",
      ]) ||
      typeof child.exchangeOrderId !== "string" ||
      !requireIdentifier(child.exchangeOrderId, "exchangeOrderId").ok ||
      typeof child.clientOrderId !== "string" ||
      !requireIdentifier(child.clientOrderId, "clientOrderId").ok ||
      typeof child.instrument !== "string" ||
      !requireIdentifier(child.instrument, "instrument").ok ||
      (child.providerOrderLinkId !== undefined &&
        !requireIdentifier(child.providerOrderLinkId, "providerOrderLinkId")
          .ok) ||
      (child.parentOrderLinkId !== undefined &&
        !requireIdentifier(child.parentOrderLinkId, "parentOrderLinkId").ok) ||
      (child.side !== "buy" && child.side !== "sell") ||
      !exactDecimal(child.requestedQuantity, true) ||
      !exactDecimal(child.filledQuantity, false) ||
      !exactSignedDecimal(child.remainingQuantity) ||
      typeof child.status !== "string" ||
      typeof child.source !== "string" ||
      !requireSafeText(child.source, "source").ok ||
      !parseUtcTimestamp(child.observedAt).ok ||
      (child.providerCreatedAt !== undefined &&
        !parseUtcTimestamp(child.providerCreatedAt).ok) ||
      (child.providerUpdatedAt !== undefined &&
        !parseUtcTimestamp(child.providerUpdatedAt).ok) ||
      (child.category !== undefined &&
        (typeof child.category !== "string" ||
          !["linear", "inverse", "spot", "option"].includes(child.category))) ||
      (child.orderType !== undefined &&
        (typeof child.orderType !== "string" ||
          !["limit", "market"].includes(child.orderType))) ||
      (child.price !== undefined && !exactDecimal(child.price, true)) ||
      (child.protectionType !== undefined &&
        !["take-profit", "stop-loss", "trailing-stop", "other"].includes(
          typeof child.protectionType === "string" ? child.protectionType : "",
        )) ||
      (child.reduceOnly !== undefined &&
        typeof child.reduceOnly !== "boolean") ||
      (child.positionIdx !== undefined &&
        (typeof child.positionIdx !== "number" ||
          ![0, 1, 2].includes(child.positionIdx))) ||
      (child.providerStopOrderType !== undefined &&
        !requireSafeText(child.providerStopOrderType, "providerStopOrderType")
          .ok) ||
      (child.providerTpslMode !== undefined &&
        !requireSafeText(child.providerTpslMode, "providerTpslMode").ok) ||
      (child.triggerBy !== undefined &&
        (typeof child.triggerBy !== "string" ||
          !["LastPrice", "MarkPrice", "IndexPrice"].includes(
            child.triggerBy,
          ))) ||
      (child.takeProfitTriggerBy !== undefined &&
        (typeof child.takeProfitTriggerBy !== "string" ||
          !["LastPrice", "MarkPrice", "IndexPrice"].includes(
            child.takeProfitTriggerBy,
          ))) ||
      (child.triggerPrice !== undefined &&
        !exactDecimal(child.triggerPrice, true))
    )
      return invalid("v2 protection child evidence is malformed");
  }

  let expectedPosition = aggregatePosition;
  if (value.aggregate !== undefined) {
    if (
      aggregatePosition !== undefined ||
      !exactRecord(value.aggregate, ["approvalHash", "siblings"]) ||
      !requireHash(value.aggregate.approvalHash, "approvalHash").ok ||
      !Array.isArray(value.aggregate.siblings) ||
      value.aggregate.siblings.length === 0
    )
      return invalid("aggregate protection lineage is malformed");
    const own = DecimalValue.fromString(value.coverage.outstandingQuantity);
    if (!own.ok) return invalid("aggregate own outstanding is invalid");
    let total = own.value;
    const sourceIds = new Set<string>();
    const parentIds = new Set([value.parent.exchangeOrderId]);
    const executionIds = new Set([
      ...value.entries.executionIds,
      ...value.exits.executionIds,
    ]);
    const childIds = new Set(
      value.children.map((child) => child.exchangeOrderId),
    );
    for (const sibling of value.aggregate.siblings) {
      if (
        !exactRecord(sibling, ["sourceId", "evidence"]) ||
        typeof sibling.sourceId !== "string" ||
        !requireIdentifier(sibling.sourceId, "sourceId").ok ||
        sourceIds.has(sibling.sourceId) ||
        !isRecord(sibling.evidence) ||
        sibling.evidence.aggregate !== undefined
      )
        return invalid("aggregate sibling identity is malformed");
      sourceIds.add(sibling.sourceId);
      const net = DecimalValue.fromString(value.position.quantity);
      if (!net.ok) return invalid("aggregate position quantity is malformed");
      const checked = validateProtectionEvidenceV2(
        sibling.evidence as unknown as PreparedLegProtectionEvidenceV2Input,
        net.value,
      );
      if (!checked.ok) return checked;
      const e =
        sibling.evidence as unknown as PreparedLegProtectionEvidenceV2Input;
      if (e.status !== "PROTECTION_CONFIRMED" && e.status !== "VERIFIED_CLOSED")
        return invalid("aggregate sibling coverage is not proven");
      const quantity = DecimalValue.fromString(e.coverage?.outstandingQuantity);
      if (
        !quantity.ok ||
        parentIds.has(e.parent?.exchangeOrderId) ||
        e.parent?.instrument !== value.parent.instrument ||
        e.observedAt !== value.observedAt ||
        e.position?.quantity !== value.position.quantity ||
        e.position?.serverTime !== value.position.serverTime ||
        e.position?.side !== value.position.side
      )
        return invalid("aggregate sibling proof conflicts");
      parentIds.add(e.parent.exchangeOrderId);
      total = total.add(quantity.value);
      for (const id of [
        ...(e.entries?.executionIds ?? []),
        ...(e.exits?.executionIds ?? []),
      ]) {
        if (executionIds.has(id))
          return invalid("aggregate execution is shared");
        executionIds.add(id);
      }
      for (const child of e.children ?? []) {
        if (childIds.has(child.exchangeOrderId))
          return invalid("aggregate child is shared");
        childIds.add(child.exchangeOrderId);
      }
    }
    if ([...parentIds].some((id) => childIds.has(id)))
      return invalid("aggregate parent is also a child");
    expectedPosition = total;
    for (const sibling of value.aggregate.siblings) {
      const valid = validateProtectionEvidenceV2(sibling.evidence, total);
      if (!valid.ok) return valid;
    }
  }
  const outstanding =
    value.coverage.outstandingQuantity === null
      ? undefined
      : DecimalValue.fromString(value.coverage.outstandingQuantity);
  const positionQuantity = DecimalValue.fromString(value.position.quantity);
  const activeRemaining =
    value.coverage.activeRemainingQuantity === null
      ? undefined
      : DecimalValue.fromString(value.coverage.activeRemainingQuantity);
  if (
    (value.status === "PROTECTION_CONFIRMED" &&
      (value.coverage.covered !== true ||
        outstanding === undefined ||
        !outstanding.ok ||
        !outstanding.value.isPositive() ||
        value.position.side !==
          ((expectedPosition ?? outstanding.value).isZero()
            ? "flat"
            : "long") ||
        !positionQuantity.ok ||
        positionQuantity.value.compare(
          expectedPosition ?? outstanding.value,
        ) !== 0 ||
        activeRemaining === undefined ||
        !activeRemaining.ok ||
        activeRemaining.value.compare(outstanding.value) !== 0)) ||
    (value.status === "VERIFIED_CLOSED" &&
      (value.coverage.covered !== true ||
        value.coverage.outstandingQuantity !== "0" ||
        value.coverage.activeRemainingQuantity !== "0" ||
        (expectedPosition === undefined
          ? value.position.side !== "flat" || value.position.quantity !== "0"
          : !positionQuantity.ok ||
            positionQuantity.value.compare(expectedPosition) !== 0 ||
            value.position.side !==
              (expectedPosition.isZero() ? "flat" : "long")))) ||
    ((value.status === "PROTECTION_CONFIRMED" ||
      value.status === "VERIFIED_CLOSED") &&
      (value.collection.entryFills !== "complete" ||
        value.collection.childOrders !== "complete" ||
        value.collection.exitFills !== "complete" ||
        value.collection.position !== "complete"))
  )
    return invalid("v2 protection outcome lacks exact complete coverage");
  const nestedZeroFill =
    aggregatePosition !== undefined &&
    value.parent.filledQuantity === "0" &&
    value.status === "VERIFIED_CLOSED" &&
    ["open", "cancelled", "rejected"].includes(value.parent.status) &&
    value.entries.quantity === "0" &&
    value.entries.fills.length === 0 &&
    value.entries.executionIds.length === 0 &&
    value.exits.quantity === "0" &&
    value.exits.fills.length === 0 &&
    value.exits.executionIds.length === 0 &&
    value.children.length === 0 &&
    value.parent.providerTpslMode === "Partial" &&
    value.parent.takeProfitTriggerBy === "LastPrice";
  if (
    (value.status === "PROTECTION_CONFIRMED" ||
      value.status === "VERIFIED_CLOSED") &&
    !hasExactProtectionFacts(
      value,
      entryTotal,
      exitTotal,
      parentFillTotal.value,
      nestedZeroFill,
    )
  )
    return invalid("v2 protection outcome conflicts with observed TP facts");
  return ok(undefined);
}

function hasExactProtectionFacts(
  value: PreparedLegProtectionEvidenceV2Input,
  entryTotal: DecimalValue,
  exitTotal: DecimalValue,
  parentFillTotal: DecimalValue,
  allowZeroFill = false,
): boolean {
  const timestamp = timestampToEpochMs;
  const validOrderSource = (source: string): boolean =>
    /^bybit-mainnet\/(?:realtime|history|order\/(?:realtime|history))$/u.test(
      source,
    );
  if (
    value.parent.category !== "linear" ||
    value.parent.side !== "buy" ||
    value.parent.takeProfit === null ||
    value.parent.providerTpslMode !== "Partial" ||
    value.parent.takeProfitTriggerBy !== "LastPrice" ||
    !validOrderSource(value.parent.source) ||
    timestamp(value.parent.observedAt) > timestamp(value.observedAt) ||
    timestamp(value.observedAt) - timestamp(value.parent.observedAt) >
      CANCEL_PROOF_MAX_AGE_MS ||
    value.position.serverTime !== value.observedAt ||
    (!parentFillTotal.isPositive() && !allowZeroFill) ||
    entryTotal.compare(parentFillTotal) !== 0 ||
    value.entries.quantity === null ||
    value.exits.quantity === null ||
    value.coverage.outstandingQuantity === null ||
    value.coverage.activeRemainingQuantity === null ||
    value.position.instrument !== value.parent.instrument ||
    value.reasonCodes.length !== 0 ||
    value.coverage.reasonCodes.length !== 0
  )
    return false;

  const takeProfit = DecimalValue.fromString(value.parent.takeProfit);
  const outstanding = DecimalValue.fromString(
    value.coverage.outstandingQuantity,
  );
  const activeRemaining = DecimalValue.fromString(
    value.coverage.activeRemainingQuantity,
  );
  const requested = DecimalValue.fromString(value.parent.requestedQuantity);
  if (
    !takeProfit.ok ||
    !outstanding.ok ||
    !activeRemaining.ok ||
    !requested.ok ||
    outstanding.value.compare(entryTotal.subtract(exitTotal)) !== 0 ||
    activeRemaining.value.isNegative() ||
    outstanding.value.isNegative()
  )
    return false;
  const zero = DecimalValue.fromString("0");
  if (!zero.ok) return false;

  const seenChildren = new Set<string>();
  const activeTotal = DecimalValue.fromString("0");
  if (!activeTotal.ok) return false;
  let active = activeTotal.value;
  const children = new Map<
    string,
    PreparedLegProtectionEvidenceV2Input["children"][number]
  >();
  for (const child of value.children) {
    const childRequested = DecimalValue.fromString(child.requestedQuantity);
    const childFilled = DecimalValue.fromString(child.filledQuantity);
    const childRemaining = DecimalValue.fromString(child.remainingQuantity);
    const createdAt = child.providerCreatedAt
      ? timestamp(child.providerCreatedAt)
      : Number.NaN;
    const updatedAt = child.providerUpdatedAt
      ? timestamp(child.providerUpdatedAt)
      : Number.NaN;
    const observedAt = timestamp(child.observedAt);
    const childIdentityIsConsistent =
      child.providerOrderLinkId === undefined
        ? child.clientOrderId === value.parent.clientOrderId
        : child.clientOrderId === child.providerOrderLinkId;
    if (
      seenChildren.has(child.exchangeOrderId) ||
      !childRequested.ok ||
      !childFilled.ok ||
      !childRemaining.ok ||
      childRequested.value.compare(requested.value) > 0 ||
      childFilled.value.compare(childRequested.value) > 0 ||
      childRemaining.value.compare(
        childRequested.value.subtract(childFilled.value),
      ) !== 0 ||
      child.clientOrderId.length === 0 ||
      !childIdentityIsConsistent ||
      child.parentOrderLinkId !== value.parent.clientOrderId ||
      child.instrument !== value.parent.instrument ||
      child.category !== "linear" ||
      child.protectionType !== "take-profit" ||
      child.providerStopOrderType !== "PartialTakeProfit" ||
      child.providerTpslMode !== "Partial" ||
      child.side !== "sell" ||
      child.orderType !== "market" ||
      child.price !== undefined ||
      child.triggerPrice !== value.parent.takeProfit ||
      child.takeProfitTriggerBy !== "LastPrice" ||
      (child.triggerBy !== undefined && child.triggerBy !== "LastPrice") ||
      child.reduceOnly !== true ||
      child.positionIdx !== 0 ||
      !/^bybit-mainnet\/protection\/order\/(?:realtime|history)$/u.test(
        child.source,
      ) ||
      !Number.isFinite(createdAt) ||
      !Number.isFinite(updatedAt) ||
      createdAt > updatedAt ||
      updatedAt > observedAt ||
      observedAt > timestamp(value.observedAt) ||
      (child.status === "open" && !childFilled.value.isZero()) ||
      (child.status === "partially-filled" &&
        (!childFilled.value.isPositive() ||
          childFilled.value.compare(childRequested.value) >= 0)) ||
      (child.status === "filled" &&
        childFilled.value.compare(childRequested.value) !== 0) ||
      ((child.status === "cancelled" || child.status === "rejected") &&
        childFilled.value.compare(childRequested.value) > 0) ||
      !["open", "partially-filled", "filled", "cancelled", "rejected"].includes(
        child.status,
      )
    )
      return false;
    seenChildren.add(child.exchangeOrderId);
    children.set(child.exchangeOrderId, child);
    if (child.status === "open" || child.status === "partially-filled")
      active = active.add(childRemaining.value);
  }

  const exitsByChild = new Map<string, DecimalValue>();
  const executionIds = new Set<string>();
  for (const fill of value.entries.fills) {
    if (
      executionIds.has(fill.executionId) ||
      fill.exchangeOrderId !== value.parent.exchangeOrderId ||
      fill.clientOrderId !== value.parent.clientOrderId ||
      fill.instrument !== value.parent.instrument ||
      fill.side !== "buy" ||
      !fill.source.startsWith("bybit-mainnet/execution") ||
      timestamp(fill.executedAt) > timestamp(value.observedAt)
    )
      return false;
    executionIds.add(fill.executionId);
  }
  for (const fill of value.exits.fills) {
    const child = children.get(fill.exchangeOrderId);
    if (
      !child ||
      executionIds.has(fill.executionId) ||
      fill.instrument !== value.parent.instrument ||
      fill.side !== "sell" ||
      (fill.clientOrderId !== value.parent.clientOrderId &&
        fill.clientOrderId !== child.providerOrderLinkId &&
        fill.clientOrderId !== "") ||
      !fill.source.startsWith("bybit-mainnet/execution") ||
      timestamp(fill.executedAt) > timestamp(value.observedAt)
    )
      return false;
    executionIds.add(fill.executionId);
    const quantity = DecimalValue.fromString(fill.quantity);
    if (!quantity.ok) return false;
    const prior = exitsByChild.get(child.exchangeOrderId);
    const childExitTotal = prior ?? zero.value;
    exitsByChild.set(child.exchangeOrderId, childExitTotal.add(quantity.value));
  }
  for (const [childId, child] of children) {
    const filled = DecimalValue.fromString(child.filledQuantity);
    if (
      !filled.ok ||
      (exitsByChild.get(childId) ?? zero.value).compare(filled.value) !== 0
    )
      return false;
  }
  if (
    active.compare(activeRemaining.value) !== 0 ||
    active.compare(outstanding.value) !== 0
  )
    return false;

  return value.status === "PROTECTION_CONFIRMED"
    ? outstanding.value.isPositive()
    : outstanding.value.isZero() && active.isZero();
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
        const remainderProof = request.remainderCancelProof;
        const proofAgeIsValid =
          last !== undefined &&
          proof.clientOrderId === source.value.clientOrderId &&
          last.exchangeOrderId === proof.exchangeOrderId &&
          timestampToEpochMs(proof.observedAt) >=
            timestampToEpochMs(last.observedAt) &&
          timestampToEpochMs(at.value) >=
            timestampToEpochMs(proof.observedAt) &&
          timestampToEpochMs(at.value) - timestampToEpochMs(proof.observedAt) <=
            CANCEL_PROOF_MAX_AGE_MS;
        let cancelProofValid =
          remainderProof === undefined &&
          last?.status === "CONFIRMED_OPEN" &&
          proof.status === "open" &&
          proof.filledQuantity.isZero() &&
          proofAgeIsValid;
        if (remainderProof !== undefined && last?.protectionEvidence) {
          const v2 = last.protectionEvidence;
          const requested = proof.requestedQuantity.toString();
          const filled = proof.filledQuantity.toString();
          const remainder = proof.requestedQuantity
            .subtract(proof.filledQuantity)
            .toString();
          const sameIds = (left: readonly string[], right: readonly string[]) =>
            JSON.stringify([...left].sort()) ===
            JSON.stringify([...right].sort());
          const remainderProofResult =
            validateRemainderCancelProof(remainderProof);
          cancelProofValid =
            remainderProofResult.ok &&
            (last.status === "PROTECTION_CONFIRMED" ||
              last.status === "VERIFIED_CLOSED") &&
            proof.status === "partially-filled" &&
            proof.filledQuantity.isPositive() &&
            proof.filledQuantity.compare(proof.requestedQuantity) < 0 &&
            proofAgeIsValid &&
            (v2.status === "PROTECTION_CONFIRMED" ||
              v2.status === "VERIFIED_CLOSED") &&
            v2.coverage.covered === true &&
            v2.collection.entryFills === "complete" &&
            v2.collection.childOrders === "complete" &&
            v2.collection.exitFills === "complete" &&
            v2.collection.position === "complete" &&
            v2.parent.exchangeOrderId === proof.exchangeOrderId &&
            v2.parent.clientOrderId === proof.clientOrderId &&
            v2.parent.requestedQuantity === requested &&
            v2.parent.filledQuantity === filled &&
            v2.coverage.outstandingQuantity ===
              remainderProof.outstandingQuantity &&
            v2.coverage.activeRemainingQuantity ===
              remainderProof.outstandingQuantity &&
            v2.position.side ===
              (v2.position.quantity === "0" ? "flat" : "long") &&
            (v2.aggregate !== undefined ||
              v2.position.quantity === remainderProof.outstandingQuantity) &&
            v2.sourceId === sourceId.value &&
            remainderProof.sourceId === sourceId.value &&
            remainderProof.leaseEpoch === request.authority.epoch &&
            remainderProof.parentExchangeOrderId === proof.exchangeOrderId &&
            remainderProof.clientOrderId === proof.clientOrderId &&
            remainderProof.requestedQuantity === requested &&
            remainderProof.filledQuantity === filled &&
            remainderProof.unfilledRemainder === remainder &&
            remainderProof.protectionEvidenceHash ===
              last.protectionCanonicalHash &&
            sameIds(
              remainderProof.entryExecutionIds,
              v2.entries.executionIds,
            ) &&
            sameIds(remainderProof.exitExecutionIds, v2.exits.executionIds) &&
            timestampToEpochMs(remainderProof.observedAt) >=
              timestampToEpochMs(proof.observedAt) &&
            timestampToEpochMs(at.value) >=
              timestampToEpochMs(remainderProof.observedAt) &&
            timestampToEpochMs(at.value) -
              timestampToEpochMs(remainderProof.observedAt) <=
              CANCEL_PROOF_MAX_AGE_MS;
        }
        if (!cancelProofValid)
          return fail(
            domainError(
              "OWNERSHIP_MISMATCH",
              remainderProof === undefined
                ? "fresh exact zero-fill order proof is required"
                : "fresh exact protected remainder proof is required",
            ),
          );
        const exact = this.matchesSource(db, source.value, proof);
        if (!exact.ok) return exact;
        const previous = this.intentRow(sourceId.value, "cancel", db);
        if (previous) {
          const parsed = intentFromRow(previous);
          return parsed.ok &&
            parsed.value.exchangeOrderId === proof.exchangeOrderId &&
            parsed.value.remainderCancelProof?.remainderCancelProofHash ===
              remainderProof?.remainderCancelProofHash
            ? ok({ snapshot: snapshot.value, created: false })
            : fail(
                domainError(
                  "PERSISTENCE_CONFLICT",
                  "cancel intent is already bound to another order",
                ),
              );
        }
        const intent = encode(
          remainderProof === undefined
            ? {
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
              }
            : {
                schemaVersion: "prepared-leg-write-intent/v2",
                operation: "cancel",
                sourceId: sourceId.value,
                runId: run.value,
                leaseEpoch: request.authority.epoch,
                clientOrderId: source.value.clientOrderId,
                exchangeOrderId: proof.exchangeOrderId,
                observedAt: remainderProof.observedAt,
                requestedQuantity: proof.requestedQuantity,
                filledQuantity: proof.filledQuantity,
                remainderCancelProof: remainderProof,
              },
        );
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
    const protectionEvidence = request.protectionEvidence;
    const evidence = validateReconciliation(
      request.status,
      request.result,
      protectionEvidence,
    );
    const protectionValidation = protectionEvidence
      ? validateProtectionEvidenceV2(protectionEvidence)
      : ok(undefined);
    if (
      !source.ok ||
      !at.ok ||
      !order.ok ||
      !evidence.ok ||
      !protectionValidation.ok ||
      ((request.status === "PROTECTION_CONFIRMED" ||
        request.status === "VERIFIED_CLOSED") &&
        protectionEvidence === undefined) ||
      (protectionEvidence !== undefined &&
        protectionEvidence.status !== request.status)
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
        if (protectionEvidence?.aggregate) {
          const aggregateValid = this.validateAggregateOwnership(
            db,
            parsedSource.value,
            protectionEvidence,
          );
          if (!aggregateValid.ok) return aggregateValid;
        }
        let status = request.status;
        let evidenceResult = request.result;
        let v2Evidence = protectionEvidence;
        const proof = evidenceResult.orderProof;
        if (proof) {
          const exact = this.matchesSource(db, parsedSource.value, proof);
          const proofConflict =
            order.value !== undefined && proof.exchangeOrderId !== order.value;
          if (!exact.ok || proofConflict) {
            status = "UNRESOLVED";
            v2Evidence = undefined;
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
            v2Evidence = undefined;
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
          v2Evidence,
        );
        if (!validatedEvidence.ok) return validatedEvidence;
        const revision = requireFiniteInteger(
          Number(priorRows?.revision ?? 0),
          "revision",
          0,
        );
        if (!revision.ok) return revision;
        const next = revision.value + 1;
        const storedStatus: LegacyPreparedLegReconciliationStatus =
          status === "PROTECTION_CONFIRMED" || status === "VERIFIED_CLOSED"
            ? "PROTECTION_PENDING"
            : status;
        if (
          v2Evidence !== undefined &&
          (v2Evidence.parent.exchangeOrderId !== proof?.exchangeOrderId ||
            v2Evidence.parent.clientOrderId !== proof?.clientOrderId ||
            v2Evidence.parent.filledQuantity !==
              proof?.filledQuantity.toString() ||
            v2Evidence.parent.requestedQuantity !==
              proof?.requestedQuantity.toString() ||
            v2Evidence.parent.observedAt !== proof?.observedAt ||
            v2Evidence.observedAt !== at.value)
        )
          return invalid(
            "v2 protection evidence is not bound to the order proof",
          );
        const orderId = order.value ?? proof?.exchangeOrderId;
        const body = encode({
          schemaVersion: "prepared-leg-reconciliation/v1",
          sourceId: source.value,
          revision: next,
          status: storedStatus,
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
          storedStatus,
          at.value,
          orderId ?? null,
          body.value.json,
          body.value.hash,
        );
        if (v2Evidence !== undefined) {
          const v2 = encode({
            ...v2Evidence,
            schemaVersion: "prepared-leg-protection-evidence/v2",
            sourceId: source.value,
            revision: next,
          });
          if (!v2.ok) return v2;
          db.prepare(
            "INSERT INTO prepared_leg_reconciliation_v2 (reconciliation_id, source_id, revision, status, canonical_json, canonical_hash) VALUES (?, ?, ?, ?, ?, ?)",
          ).run(
            id,
            source.value,
            next,
            v2Evidence.status,
            v2.value.json,
            v2.value.hash,
          );
        }
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
        const insertedV2 = inserted
          ? (db
              .prepare(
                "SELECT reconciliation_id, source_id, revision, status, canonical_json, canonical_hash FROM prepared_leg_reconciliation_v2 WHERE reconciliation_id = ?",
              )
              .get(id) as SqliteRow | undefined)
          : undefined;
        return inserted
          ? reconciliationFromRow(inserted, insertedV2)
          : invalid();
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
    const protectionRows = db
      .prepare(
        "SELECT protection.reconciliation_id, protection.source_id, protection.revision, protection.status, protection.canonical_json, protection.canonical_hash FROM prepared_leg_reconciliation_v2 AS protection JOIN prepared_leg_reconciliations AS reconciliation ON reconciliation.reconciliation_id = protection.reconciliation_id WHERE reconciliation.source_id = ? ORDER BY reconciliation.revision",
      )
      .all(lineage.value.sourceId) as SqliteRow[];
    const protectionByReconciliationId = new Map<string, SqliteRow>();
    for (const protectionRow of protectionRows) {
      const reconciliationId = storedIdentifier(
        protectionRow,
        "reconciliation_id",
      );
      if (!reconciliationId.ok) return reconciliationId;
      protectionByReconciliationId.set(reconciliationId.value, protectionRow);
    }
    const reconciliations: PreparedLegReconciliationRecord[] = [];
    for (const item of rows) {
      const reconciliationId = storedIdentifier(item, "reconciliation_id");
      if (!reconciliationId.ok) return reconciliationId;
      const parsed = reconciliationFromRow(
        item,
        protectionByReconciliationId.get(reconciliationId.value),
      );
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

  private validateAggregateOwnership(
    db: DatabaseSync,
    selected: PreparedLegLineageRecord,
    evidence: PreparedLegProtectionEvidenceV2Input,
  ): Result<void> {
    const aggregate = evidence.aggregate;
    if (!aggregate) return ok(undefined);
    const envelope = this.readArtifact(
      db,
      approvalId(aggregate.approvalHash),
      "prepared-plan-approval",
      aggregate.approvalHash,
    );
    if (!envelope.ok) return envelope;
    const approval = rehydrateArtifact(
      "prepared-plan-approval",
      envelope.value,
    );
    if (!approval.ok)
      return invalid("aggregate approval could not be rehydrated");
    const grid = createPreparedLegGridExecution({
      approval: approval.value,
      approvalHash: aggregate.approvalHash,
      now: approval.value.approvedAt,
    });
    if (
      !grid.ok ||
      grid.value.preparedHash !== selected.preparedHash ||
      !grid.value.legs.some((row) => row.sourceId === selected.sourceId)
    )
      return invalid("aggregate approval does not own selected source");
    const selectedRow = this.sourceRow(selected.sourceId, db);
    const selectedSnapshot = selectedRow
      ? this.snapshot(selectedRow, db)
      : undefined;
    if (
      !selectedSnapshot?.ok ||
      !selectedSnapshot.value.approvalHashes.includes(aggregate.approvalHash)
    )
      return invalid("selected source lacks aggregate approval");
    const expected = new Set<string>();
    for (const row of grid.value.legs) {
      if (row.sourceId === selected.sourceId) continue;
      const stored = this.sourceRow(row.sourceId, db);
      if (!stored) continue;
      expected.add(row.sourceId);
      const source = this.snapshot(stored, db);
      const sibling = aggregate.siblings.find(
        (item) => item.sourceId === row.sourceId,
      );
      if (
        !source.ok ||
        !sibling ||
        !source.value.approvalHashes.includes(aggregate.approvalHash) ||
        source.value.lineage.preparedHash !== selected.preparedHash ||
        source.value.lineage.clientOrderId !== row.execution.clientOrderId ||
        sibling.evidence.parent.exchangeOrderId !==
          source.value.reconciliations.at(-1)?.exchangeOrderId ||
        sibling.evidence.parent.clientOrderId !== row.execution.clientOrderId ||
        sibling.evidence.parent.requestedQuantity !==
          row.execution.leg.intent.quantity.toString() ||
        sibling.evidence.parent.takeProfit !==
          row.execution.leg.intent.protection?.takeProfit?.toString() ||
        sibling.evidence.parent.instrument !==
          row.execution.leg.intent.instrument ||
        sibling.evidence.parent.side !== "buy" ||
        sibling.evidence.parent.providerTpslMode !== "Partial" ||
        sibling.evidence.parent.takeProfitTriggerBy !== "LastPrice"
      )
        return invalid("aggregate sibling lacks exact durable ownership");
    }
    if (
      aggregate.siblings.length !== expected.size ||
      aggregate.siblings.some((sibling) => !expected.has(sibling.sourceId))
    )
      return invalid("aggregate sibling set does not match durable approval");
    return ok(undefined);
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
