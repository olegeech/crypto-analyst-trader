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
  OPERATOR_MAINNET_TRADE_COMMAND_PLAN_SCHEMA_VERSION,
  rehydrateOperatorMainnetTestApproval,
  rehydrateOperatorMainnetTestPlan,
  validateOperatorMainnetTestApproval,
  type OperatorMainnetTestApproval,
  type OperatorMainnetTestPlan,
} from "../../domain/execution/operator-mainnet-test-plan.js";
import {
  rehydrateOperatorMainnetTradeCommandBinding,
  rehydrateOperatorMainnetTradeCommandPlan,
  rehydrateOperatorMainnetTradeCommandReceipt,
  validateOperatorMainnetTradeCommandBinding,
  type OperatorMainnetTradeCommandBinding,
  type OperatorMainnetTradeCommandReceipt,
} from "../../domain/execution/operator-mainnet-trade-command.js";
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
  AppendOperatorMainnetTradeCommandOutcomeRequest,
  BindOperatorMainnetTradeCommandRequest,
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
  OperatorMainnetTradeCommandOutcomeRecord,
  OperatorMainnetTradeCommandSnapshot,
  OperatorMainnetRecoveryResolutionRequest,
  PrepareOperatorMainnetTestCreateRequest,
  PersistOperatorMainnetRecoveryAttestationRequest,
  PersistOperatorMainnetTradeCommandReceiptRequest,
  RecordOperatorMainnetTestAttemptRequest,
} from "../../ports/operator-mainnet-test-persistence.js";
import { OPERATOR_MAINNET_TRADE_COMMAND_DIAGNOSTIC_FIELDS } from "../../ports/operator-mainnet-test-persistence.js";
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
const TRADE_COMMAND_RECEIPT_KIND =
  "operator-mainnet-trade-command-receipt" as const;
const TRADE_COMMAND_BINDING_KIND =
  "operator-mainnet-trade-command-binding" as const;
const PLAN_ARTIFACT_ID = (hash: string) => `operator-mainnet-test:${hash}`;
const APPROVAL_ARTIFACT_ID = (hash: string) =>
  `operator-mainnet-test-approval:${hash}`;
const TRADE_COMMAND_RECEIPT_ARTIFACT_ID = (hash: string) =>
  `operator-mainnet-trade-command-receipt:${hash}`;
const TRADE_COMMAND_BINDING_ARTIFACT_ID = (hash: string) =>
  `operator-mainnet-trade-command-binding:${hash}`;
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

const TRADE_COMMAND_OUTCOME_STAGES = [
  "plan-derivation",
  "precheck",
  "binding",
  "admission",
] as const;
const TRADE_COMMAND_DIAGNOSTIC_KEYS = new Set<string>(
  OPERATOR_MAINNET_TRADE_COMMAND_DIAGNOSTIC_FIELDS,
);

function isTradeCommandOutcomeStage(
  value: unknown,
): value is (typeof TRADE_COMMAND_OUTCOME_STAGES)[number] {
  return (
    typeof value === "string" &&
    TRADE_COMMAND_OUTCOME_STAGES.includes(
      value as (typeof TRADE_COMMAND_OUTCOME_STAGES)[number],
    )
  );
}

/** Only a completed safe target-leverage precheck may precede a v3 binding/CREATE. */
function tradeCommandPreIntentOutcomesPermitCreate(
  database: DatabaseSync,
  commandId: string,
): boolean {
  const rows = database
    .prepare(
      `SELECT stage, code FROM operator_mainnet_trade_command_outcomes
       WHERE command_id = ? ORDER BY revision`,
    )
    .all(commandId) as SqliteRow[];
  if (rows.length === 0) return true;
  if (rows.some((row) => row.stage !== "precheck")) return false;
  const codes = rows.map((row) => row.code);
  return (
    (codes.length === 1 && codes[0] === "LEVERAGE_CONFIG_ALREADY_1X") ||
    (codes.length === 2 &&
      codes[0] === "LEVERAGE_CONFIG_ATTEMPTED" &&
      codes[1] === "LEVERAGE_CONFIG_VERIFIED")
  );
}

function normalizeTradeCommandDiagnostics(
  input: unknown,
): Result<Readonly<Record<string, string | number | boolean>>> {
  if (!isRecord(input) || Object.getPrototypeOf(input) !== Object.prototype)
    return invalid("trade-command diagnostics must be a plain object");
  const output: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!TRADE_COMMAND_DIAGNOSTIC_KEYS.has(key))
      return invalid(
        "trade-command diagnostics contain a non-allowlisted field",
      );
    if (typeof value === "string") {
      const safe = requireSafeText(value, key);
      if (!safe.ok || safe.value.length > 256)
        return invalid("trade-command diagnostic text is invalid");
      output[key] = safe.value;
    } else if (typeof value === "number") {
      if (!Number.isFinite(value) || Math.abs(value) > 1_000_000_000_000)
        return invalid("trade-command diagnostic number is invalid");
      output[key] = value;
    } else if (typeof value === "boolean") {
      output[key] = value;
    } else {
      return invalid("trade-command diagnostic value is invalid");
    }
  }
  return ok(output);
}

function receiptArtifactBytes(
  receipt: OperatorMainnetTradeCommandReceipt,
): string | undefined {
  const serialized = canonicalSerialize(receipt);
  return serialized.ok ? serialized.value : undefined;
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

  persistOperatorMainnetTradeCommandReceipt(
    request: PersistOperatorMainnetTradeCommandReceiptRequest,
  ): Result<OperatorMainnetTradeCommandReceipt> {
    const receipt = rehydrateOperatorMainnetTradeCommandReceipt(
      request.receipt,
    );
    const recordedAt = parseUtcTimestamp(request.recordedAt);
    if (
      !receipt.ok ||
      !recordedAt.ok ||
      !validScope(this.scope) ||
      receipt.value.accountIdentityHash !== this.scope.accountId ||
      timestampToEpochMs(recordedAt.value) <
        timestampToEpochMs(receipt.value.acceptedAt)
    )
      return invalid(
        "trade-command receipt does not match its persisted scope",
      );
    const envelope = encodeCanonicalArtifact(
      TRADE_COMMAND_RECEIPT_KIND,
      receipt.value,
    );
    if (!envelope.ok) return envelope;
    const artifactId = TRADE_COMMAND_RECEIPT_ARTIFACT_ID(
      receipt.value.contentHash,
    );
    return runInTransaction(
      this.db,
      (database) => {
        const existing = database
          .prepare(
            `SELECT command_id FROM operator_mainnet_trade_command_receipts
             WHERE command_id = ?`,
          )
          .get(receipt.value.commandId) as SqliteRow | undefined;
        if (existing) {
          const saved = this.tradeCommandReceiptFromRow(
            receipt.value.commandId,
            database,
          );
          if (!saved.ok) return saved;
          const same =
            saved.value.contentHash === receipt.value.contentHash &&
            receiptArtifactBytes(saved.value) ===
              receiptArtifactBytes(receipt.value);
          return same
            ? saved
            : fail(
                domainError(
                  "PERSISTENCE_CONFLICT",
                  "trade-command ID is already bound to another receipt",
                ),
              );
        }
        const stored = insertArtifact(
          database,
          this.scope,
          artifactId,
          envelope.value,
          receipt.value.contentHash,
          recordedAt.value,
        );
        if (!stored.ok) return stored;
        database
          .prepare(
            `INSERT INTO operator_mainnet_trade_command_receipts
             (command_id, exchange, environment, account_id, category, position_mode,
              receipt_hash, receipt_artifact_id, accepted_at, expires_at, recorded_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            receipt.value.commandId,
            ...scopeValues(this.scope),
            receipt.value.contentHash,
            artifactId,
            receipt.value.acceptedAt,
            receipt.value.expiresAt,
            recordedAt.value,
          );
        return ok(receipt.value);
      },
      "PERSISTENCE_CONFLICT",
    );
  }

  readOperatorMainnetTradeCommandReceipt(
    commandIdInput: string,
  ): Result<OperatorMainnetTradeCommandReceipt | undefined> {
    const commandId = requireIdentifier(commandIdInput, "commandId");
    if (!commandId.ok || !validScope(this.scope)) return invalid();
    const row = this.db
      .prepare(
        `SELECT 1 AS present FROM operator_mainnet_trade_command_receipts
         WHERE command_id = ? AND exchange = ? AND environment = ?
           AND account_id = ? AND category = ? AND position_mode = ?`,
      )
      .get(commandId.value, ...scopeValues(this.scope));
    if (!row) return ok(undefined);
    const receipt = this.tradeCommandReceiptFromRow(commandId.value);
    return receipt.ok ? ok(receipt.value) : receipt;
  }

  bindOperatorMainnetTradeCommand(
    request: BindOperatorMainnetTradeCommandRequest,
  ): Result<OperatorMainnetTradeCommandBinding> {
    const binding = rehydrateOperatorMainnetTradeCommandBinding(
      request.binding,
    );
    const boundAt = parseUtcTimestamp(request.boundAt);
    if (
      !binding.ok ||
      !boundAt.ok ||
      !validScope(this.scope) ||
      binding.value.boundAt !== boundAt.value ||
      binding.value.replayInputs.receipt.accountIdentityHash !==
        this.scope.accountId
    )
      return invalid("trade-command binding does not match its scope or time");
    const receiptEnvelope = encodeCanonicalArtifact(
      TRADE_COMMAND_RECEIPT_KIND,
      binding.value.replayInputs.receipt,
    );
    const planEnvelope = encodeCanonicalArtifact(
      PLAN_KIND,
      binding.value.replayInputs.plan,
    );
    const bindingEnvelope = encodeCanonicalArtifact(
      TRADE_COMMAND_BINDING_KIND,
      binding.value,
    );
    if (!receiptEnvelope.ok || !planEnvelope.ok || !bindingEnvelope.ok)
      return invalid("trade-command artifact encoding failed");
    const receiptArtifactId = TRADE_COMMAND_RECEIPT_ARTIFACT_ID(
      binding.value.receiptHash,
    );
    const planArtifactId = PLAN_ARTIFACT_ID(binding.value.planHash);
    const bindingArtifactId = TRADE_COMMAND_BINDING_ARTIFACT_ID(
      binding.value.contentHash,
    );
    return runInTransaction(
      this.db,
      (database) => {
        const receipt = this.tradeCommandReceiptFromRow(
          binding.value.commandId,
          database,
        );
        if (!receipt.ok) return receipt;
        if (
          receipt.value.contentHash !== binding.value.receiptHash ||
          receiptArtifactId !==
            TRADE_COMMAND_RECEIPT_ARTIFACT_ID(receipt.value.contentHash)
        )
          return fail(
            domainError(
              "PERSISTENCE_CONFLICT",
              "trade-command receipt differs from the saved instruction",
            ),
          );
        const existing = database
          .prepare(
            `SELECT binding_hash FROM operator_mainnet_trade_command_bindings
             WHERE command_id = ?`,
          )
          .get(binding.value.commandId) as SqliteRow | undefined;
        if (existing) {
          const saved = this.tradeCommandBindingFromRow(
            TRADE_COMMAND_BINDING_ARTIFACT_ID(String(existing.binding_hash)),
            database,
          );
          if (!saved.ok) return saved;
          return saved.value.contentHash === binding.value.contentHash
            ? saved
            : fail(
                domainError(
                  "PERSISTENCE_CONFLICT",
                  "trade-command receipt is already bound to another plan",
                ),
              );
        }
        if (
          !tradeCommandPreIntentOutcomesPermitCreate(
            database,
            binding.value.commandId,
          )
        )
          return fail(
            domainError(
              "PERSISTENCE_CONFLICT",
              "a trade-command has a blocking pre-intent outcome and cannot be bound",
            ),
          );
        const receiptStored = insertArtifact(
          database,
          this.scope,
          receiptArtifactId,
          receiptEnvelope.value,
          binding.value.receiptHash,
          boundAt.value,
        );
        if (!receiptStored.ok) return receiptStored;
        const planStored = insertArtifact(
          database,
          this.scope,
          planArtifactId,
          planEnvelope.value,
          binding.value.planHash,
          binding.value.replayInputs.plan.preparedAt,
        );
        if (!planStored.ok) return planStored;
        const bindingStored = insertArtifact(
          database,
          this.scope,
          bindingArtifactId,
          bindingEnvelope.value,
          binding.value.contentHash,
          boundAt.value,
        );
        if (!bindingStored.ok) return bindingStored;
        database
          .prepare(
            `INSERT INTO operator_mainnet_trade_command_bindings
             (command_id, exchange, environment, account_id, category, position_mode,
              binding_hash, binding_artifact_id, plan_hash, plan_artifact_id,
              source_id, client_order_id, create_payload_hash, bound_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            binding.value.commandId,
            ...scopeValues(this.scope),
            binding.value.contentHash,
            bindingArtifactId,
            binding.value.planHash,
            planArtifactId,
            binding.value.sourceId,
            binding.value.clientOrderId,
            binding.value.createPayloadHash,
            boundAt.value,
          );
        return ok(binding.value);
      },
      "PERSISTENCE_CONFLICT",
    );
  }

  readOperatorMainnetTradeCommandBinding(
    commandIdInput: string,
  ): Result<OperatorMainnetTradeCommandBinding | undefined> {
    const commandId = requireIdentifier(commandIdInput, "commandId");
    if (!commandId.ok || !validScope(this.scope)) return invalid();
    const row = this.db
      .prepare(
        `SELECT binding_artifact_id FROM operator_mainnet_trade_command_bindings
         WHERE command_id = ? AND exchange = ? AND environment = ?
           AND account_id = ? AND category = ? AND position_mode = ?`,
      )
      .get(commandId.value, ...scopeValues(this.scope)) as
      SqliteRow | undefined;
    if (!row) return ok(undefined);
    const artifactId = storedIdentifier(row, "binding_artifact_id");
    if (!artifactId.ok)
      return persistenceFailure("persisted binding reference is invalid");
    const binding = this.tradeCommandBindingFromRow(artifactId.value);
    return binding.ok ? ok(binding.value) : binding;
  }

  appendOperatorMainnetTradeCommandOutcome(
    request: AppendOperatorMainnetTradeCommandOutcomeRequest,
  ): Result<OperatorMainnetTradeCommandOutcomeRecord> {
    const commandId = requireIdentifier(request.commandId, "commandId");
    const outcomeId = requireIdentifier(request.outcomeId, "outcomeId");
    const code = requireSafeText(request.code, "outcomeCode");
    const occurredAt = parseUtcTimestamp(request.occurredAt);
    const diagnostics = normalizeTradeCommandDiagnostics(
      request.diagnosticDetails ?? {},
    );
    if (
      !commandId.ok ||
      !outcomeId.ok ||
      !code.ok ||
      !occurredAt.ok ||
      !diagnostics.ok ||
      !isTradeCommandOutcomeStage(request.stage) ||
      !validScope(this.scope)
    )
      return invalid("trade-command outcome is invalid");
    return runInTransaction(
      this.db,
      (database) => {
        const receipt = this.tradeCommandReceiptFromRow(
          commandId.value,
          database,
        );
        if (!receipt.ok) return receipt;
        const binding = database
          .prepare(
            `SELECT source_id FROM operator_mainnet_trade_command_bindings
             WHERE command_id = ?`,
          )
          .get(commandId.value) as SqliteRow | undefined;
        const sourceId = binding
          ? storedIdentifier(binding, "source_id")
          : undefined;
        if (sourceId && !sourceId.ok)
          return persistenceFailure(
            "direct-command source reference is invalid",
          );
        if (
          database
            .prepare(
              `SELECT 1 AS present FROM operator_mainnet_trade_command_consumptions
               WHERE command_id = ?`,
            )
            .get(commandId.value) ||
          (sourceId && sourceId.ok && this.sourceRow(sourceId.value, database))
        )
          return fail(
            domainError(
              "PERSISTENCE_CONFLICT",
              "a consumed trade-command cannot receive a pre-intent outcome",
            ),
          );
        const revisionRow = database
          .prepare(
            `SELECT COALESCE(MAX(revision), 0) AS revision
             FROM operator_mainnet_trade_command_outcomes WHERE command_id = ?`,
          )
          .get(commandId.value) as SqliteRow | undefined;
        const previousRevision = requireFiniteInteger(
          revisionRow?.revision,
          "outcomeRevision",
        );
        if (!previousRevision.ok)
          return persistenceFailure(
            "trade-command outcome revision is invalid",
          );
        const revision = previousRevision.value + 1;
        const value = {
          schemaVersion: "operator-mainnet-trade-command-outcome/v1",
          outcomeId: outcomeId.value,
          commandId: commandId.value,
          revision,
          stage: request.stage,
          code: code.value,
          occurredAt: occurredAt.value,
          diagnosticDetails: diagnostics.value,
        };
        const encoded = encode(value);
        const diagnosticsEncoded = encode(diagnostics.value);
        if (!encoded.ok || !diagnosticsEncoded.ok)
          return invalid("trade-command outcome could not be encoded");
        database
          .prepare(
            `INSERT INTO operator_mainnet_trade_command_outcomes
             (outcome_id, command_id, revision, stage, code, occurred_at,
              diagnostics_json, canonical_json, canonical_hash)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            outcomeId.value,
            commandId.value,
            revision,
            request.stage,
            code.value,
            occurredAt.value,
            diagnosticsEncoded.value.json,
            encoded.value.json,
            encoded.value.hash,
          );
        return this.tradeCommandOutcomeFromRow(
          database
            .prepare(
              `SELECT * FROM operator_mainnet_trade_command_outcomes
               WHERE outcome_id = ?`,
            )
            .get(outcomeId.value) as SqliteRow,
        );
      },
      "PERSISTENCE_CONFLICT",
    );
  }

  readOperatorMainnetTradeCommand(
    commandIdInput: string,
  ): Result<OperatorMainnetTradeCommandSnapshot | undefined> {
    const commandId = requireIdentifier(commandIdInput, "commandId");
    if (!commandId.ok || !validScope(this.scope)) return invalid();
    return runInTransaction(
      this.db,
      (database) => {
        const row = database
          .prepare(
            `SELECT 1 AS present FROM operator_mainnet_trade_command_receipts
             WHERE command_id = ? AND exchange = ? AND environment = ?
               AND account_id = ? AND category = ? AND position_mode = ?`,
          )
          .get(commandId.value, ...scopeValues(this.scope));
        if (!row) return ok(undefined);
        const receipt = this.tradeCommandReceiptFromRow(
          commandId.value,
          database,
        );
        if (!receipt.ok) return receipt;
        const binding = this.readTradeCommandBindingFromCommandRow(
          commandId.value,
          database,
        );
        if (!binding.ok) return binding;
        const outcomes = this.tradeCommandOutcomeRows(
          commandId.value,
          database,
        );
        if (!outcomes.ok) return outcomes;
        const consumptionRow = database
          .prepare(
            `SELECT * FROM operator_mainnet_trade_command_consumptions
             WHERE command_id = ?`,
          )
          .get(commandId.value) as SqliteRow | undefined;
        const consumption = consumptionRow
          ? this.tradeCommandConsumptionFromRow(consumptionRow)
          : ok<OperatorMainnetTradeCommandSnapshot["consumption"]>(undefined);
        if (!consumption.ok) return consumption;
        const source =
          binding.value && consumption.value
            ? this.readOperatorMainnetTestSource(consumption.value.sourceId)
            : ok<OperatorMainnetTestSnapshot | undefined>(undefined);
        if (!source.ok) return source;
        if (consumption.value) {
          if (!binding.value || !source.value)
            return persistenceFailure(
              "consumed trade-command binding or source is missing",
            );
          const authorization = source.value.authorization;
          if (
            consumption.value.commandId !== receipt.value.commandId ||
            consumption.value.receiptHash !== receipt.value.contentHash ||
            consumption.value.bindingHash !== binding.value.contentHash ||
            consumption.value.sourceId !== binding.value.sourceId ||
            consumption.value.writeIntentId !==
              source.value.intent.writeIntentId ||
            authorization.kind !== "trade-command" ||
            authorization.commandId !== receipt.value.commandId ||
            authorization.receiptHash !== receipt.value.contentHash ||
            authorization.hash !== binding.value.contentHash ||
            source.value.intent.commandId !== receipt.value.commandId ||
            source.value.intent.commandReceiptHash !==
              receipt.value.contentHash ||
            source.value.intent.commandBindingHash !== binding.value.contentHash
          )
            return persistenceFailure(
              "trade-command consumption does not match its receipt, binding, source and intent",
            );
        }
        return ok({
          receipt: receipt.value,
          ...(binding.value === undefined ? {} : { binding: binding.value }),
          outcomes: outcomes.value,
          ...(consumption.value === undefined
            ? {}
            : { consumption: consumption.value }),
          ...(source.value === undefined ? {} : { source: source.value }),
        });
      },
      "PERSISTENCE_INTEGRITY",
    );
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
        if (
          plan.value.schemaVersion ===
          OPERATOR_MAINNET_TRADE_COMMAND_PLAN_SCHEMA_VERSION
        )
          return fail(
            domainError(
              "PERSISTENCE_CONFLICT",
              "direct trade-command plans cannot authorize recovery grants",
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
    const legacyApprovalHash = storedHash(row, "approval_hash");
    const legacyApprovalArtifactId = storedIdentifier(
      row,
      "approval_artifact_id",
    );
    const authorizationHash = storedHash(row, "authorization_hash");
    const authorizationArtifactId = storedIdentifier(
      row,
      "authorization_artifact_id",
    );
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
      !legacyApprovalHash.ok ||
      !legacyApprovalArtifactId.ok ||
      !authorizationHash.ok ||
      !authorizationArtifactId.ok ||
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
    if (!planArtifact.ok) return fail(planArtifact.error);
    if (
      planArtifact.value?.artifactKind !== PLAN_KIND ||
      planArtifact.value.materialHash !== planHash.value
    )
      return persistenceFailure(
        "operator plan artifact reference or material hash is invalid",
      );
    const plan = rehydrateArtifact(PLAN_KIND, planArtifact.value.envelope);
    const expectedSourceId = plan.ok
      ? deriveOperatorMainnetTestSourceId(plan.value.contentHash)
      : plan;
    const payloadValidated = plan.ok
      ? validatePayload(plan.value, payloadJson.value, payloadHash.value)
      : plan;
    if (
      !plan.ok ||
      !expectedSourceId.ok ||
      !payloadValidated.ok ||
      plan.value.contentHash !== planHash.value ||
      plan.value.clientOrderId !== clientOrderId.value ||
      expectedSourceId.value !== sourceId.value
    )
      return persistenceFailure(
        "persisted operator source identity is invalid",
      );
    let authorization: OperatorMainnetTestSourceRecord["authorization"];
    if (row.authorization_kind === "approval") {
      if (
        authorizationHash.value !== legacyApprovalHash.value ||
        authorizationArtifactId.value !== legacyApprovalArtifactId.value
      )
        return persistenceFailure(
          "legacy operator approval reference differs from its tagged authorization",
        );
      const approvalArtifact = this.artifactRow(authorizationArtifactId.value);
      if (!approvalArtifact.ok) return fail(approvalArtifact.error);
      if (
        approvalArtifact.value?.artifactKind !== APPROVAL_KIND ||
        approvalArtifact.value.materialHash !== authorizationHash.value
      )
        return persistenceFailure(
          "legacy operator approval artifact reference is invalid",
        );
      const approval = rehydrateArtifact(
        APPROVAL_KIND,
        approvalArtifact.value.envelope,
      );
      if (
        !approval.ok ||
        approval.value.contentHash !== authorizationHash.value ||
        approval.value.planHash !== planHash.value ||
        approval.value.sourceId !== sourceId.value ||
        approval.value.clientOrderId !== clientOrderId.value
      )
        return persistenceFailure(
          "legacy operator approval does not match its source",
        );
      authorization = {
        kind: "approval",
        hash: authorizationHash.value as PlanHash,
        artifactId: authorizationArtifactId.value,
      };
    } else if (row.authorization_kind === "trade-command") {
      // These v8 NOT NULL columns remain compatibility aliases only. The
      // neutral reference points at a real binding artifact, not an approval.
      if (
        authorizationHash.value !== legacyApprovalHash.value ||
        authorizationArtifactId.value !== legacyApprovalArtifactId.value
      )
        return persistenceFailure(
          "direct-command compatibility reference differs from its tagged authorization",
        );
      const binding = this.tradeCommandBindingFromRow(
        authorizationArtifactId.value,
        this.db,
      );
      if (!binding.ok) return binding;
      const receipt = this.tradeCommandReceiptFromRow(
        binding.value.commandId,
        this.db,
      );
      if (!receipt.ok) return receipt;
      const planDigest = hashCanonical(plan.value);
      if (
        !planDigest.ok ||
        binding.value.contentHash !== authorizationHash.value ||
        binding.value.planHash !== planHash.value ||
        binding.value.planArtifactHash !== planDigest.value ||
        binding.value.sourceId !== sourceId.value ||
        binding.value.clientOrderId !== clientOrderId.value ||
        binding.value.createPayloadHash !== payloadHash.value ||
        binding.value.commandId !== receipt.value.commandId ||
        binding.value.receiptHash !== receipt.value.contentHash ||
        binding.value.replayInputs.plan.contentHash !== planHash.value ||
        binding.value.replayInputs.receipt.contentHash !==
          receipt.value.contentHash
      )
        return persistenceFailure(
          "direct-command binding does not match its persisted source",
        );
      authorization = {
        kind: "trade-command",
        hash: authorizationHash.value as PlanHash,
        artifactId: authorizationArtifactId.value,
        commandId: binding.value.commandId,
        receiptHash: receipt.value.contentHash,
        receiptArtifactId: TRADE_COMMAND_RECEIPT_ARTIFACT_ID(
          receipt.value.contentHash,
        ),
      };
    } else {
      return persistenceFailure(
        "persisted operator authorization kind is invalid",
      );
    }
    return ok({
      sourceId: sourceId.value,
      scope: this.scope,
      planHash: planHash.value as PlanHash,
      planArtifactId: planArtifactId.value,
      authorization,
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

  private tradeCommandReceiptFromRow(
    commandId: string,
    database = this.db,
  ): Result<OperatorMainnetTradeCommandReceipt> {
    const row = database
      .prepare(
        `SELECT * FROM operator_mainnet_trade_command_receipts
         WHERE command_id = ? AND exchange = ? AND environment = ?
           AND account_id = ? AND category = ? AND position_mode = ?`,
      )
      .get(commandId, ...scopeValues(this.scope)) as SqliteRow | undefined;
    if (!row) return persistenceFailure("direct-command receipt is missing");
    const storedCommandId = storedIdentifier(row, "command_id");
    const receiptHash = storedHash(row, "receipt_hash");
    const receiptArtifactId = storedIdentifier(row, "receipt_artifact_id");
    const acceptedAt = storedTimestamp(row, "accepted_at");
    const expiresAt = storedTimestamp(row, "expires_at");
    const recordedAt = storedTimestamp(row, "recorded_at");
    if (
      row.exchange !== "bybit" ||
      row.environment !== "mainnet" ||
      row.account_id !== this.scope.accountId ||
      row.category !== "linear" ||
      row.position_mode !== "one-way" ||
      !storedCommandId.ok ||
      !receiptHash.ok ||
      !receiptArtifactId.ok ||
      !acceptedAt.ok ||
      !expiresAt.ok ||
      !recordedAt.ok
    )
      return persistenceFailure(
        "persisted direct-command receipt row is invalid",
      );
    const artifact = this.artifactRow(receiptArtifactId.value);
    if (!artifact.ok) return artifact;
    if (
      artifact.value?.artifactKind !== TRADE_COMMAND_RECEIPT_KIND ||
      artifact.value.materialHash !== receiptHash.value ||
      receiptArtifactId.value !==
        TRADE_COMMAND_RECEIPT_ARTIFACT_ID(receiptHash.value)
    )
      return persistenceFailure(
        "direct-command receipt artifact reference is invalid",
      );
    const receipt = rehydrateArtifact(
      TRADE_COMMAND_RECEIPT_KIND,
      artifact.value.envelope,
    );
    if (
      !receipt.ok ||
      receipt.value.commandId !== storedCommandId.value ||
      receipt.value.contentHash !== receiptHash.value ||
      receipt.value.accountIdentityHash !== this.scope.accountId ||
      receipt.value.acceptedAt !== acceptedAt.value ||
      receipt.value.expiresAt !== expiresAt.value ||
      timestampToEpochMs(recordedAt.value) <
        timestampToEpochMs(acceptedAt.value)
    )
      return persistenceFailure(
        "persisted direct-command receipt identity is invalid",
      );
    return receipt;
  }

  private tradeCommandBindingFromRow(
    bindingArtifactId: string,
    database = this.db,
  ): Result<OperatorMainnetTradeCommandBinding> {
    const row = database
      .prepare(
        `SELECT * FROM operator_mainnet_trade_command_bindings
         WHERE binding_artifact_id = ? AND exchange = ? AND environment = ?
           AND account_id = ? AND category = ? AND position_mode = ?`,
      )
      .get(bindingArtifactId, ...scopeValues(this.scope)) as
      SqliteRow | undefined;
    if (!row)
      return persistenceFailure("direct-command binding row is missing");
    const commandId = storedIdentifier(row, "command_id");
    const bindingHash = storedHash(row, "binding_hash");
    const storedArtifactId = storedIdentifier(row, "binding_artifact_id");
    const planHash = storedHash(row, "plan_hash");
    const planArtifactId = storedIdentifier(row, "plan_artifact_id");
    const sourceId = storedIdentifier(row, "source_id");
    const clientOrderId = storedIdentifier(row, "client_order_id");
    const payloadHash = storedHash(row, "create_payload_hash");
    const boundAt = storedTimestamp(row, "bound_at");
    if (
      row.exchange !== "bybit" ||
      row.environment !== "mainnet" ||
      row.account_id !== this.scope.accountId ||
      row.category !== "linear" ||
      row.position_mode !== "one-way" ||
      !commandId.ok ||
      !bindingHash.ok ||
      !storedArtifactId.ok ||
      !planHash.ok ||
      !planArtifactId.ok ||
      !sourceId.ok ||
      !clientOrderId.ok ||
      !payloadHash.ok ||
      !boundAt.ok ||
      storedArtifactId.value !== bindingArtifactId
    )
      return persistenceFailure(
        "persisted direct-command binding row is invalid",
      );
    const artifact = this.artifactRow(bindingArtifactId);
    if (!artifact.ok) return artifact;
    if (
      artifact.value?.artifactKind !== TRADE_COMMAND_BINDING_KIND ||
      artifact.value.materialHash !== bindingHash.value ||
      bindingArtifactId !== TRADE_COMMAND_BINDING_ARTIFACT_ID(bindingHash.value)
    )
      return persistenceFailure(
        "direct-command binding artifact reference is invalid",
      );
    const binding = rehydrateArtifact(
      TRADE_COMMAND_BINDING_KIND,
      artifact.value.envelope,
    );
    const receipt = this.tradeCommandReceiptFromRow(commandId.value, database);
    const planDigest = binding.ok
      ? hashCanonical(binding.value.replayInputs.plan)
      : binding;
    if (
      !binding.ok ||
      !receipt.ok ||
      !planDigest.ok ||
      binding.value.commandId !== commandId.value ||
      binding.value.contentHash !== bindingHash.value ||
      binding.value.planHash !== planHash.value ||
      binding.value.planArtifactHash !== planDigest.value ||
      binding.value.replayInputs.plan.contentHash !== planHash.value ||
      binding.value.sourceId !== sourceId.value ||
      binding.value.clientOrderId !== clientOrderId.value ||
      binding.value.createPayloadHash !== payloadHash.value ||
      binding.value.receiptHash !== receipt.value.contentHash ||
      binding.value.replayInputs.receipt.contentHash !==
        receipt.value.contentHash ||
      binding.value.boundAt !== boundAt.value ||
      planArtifactId.value !== PLAN_ARTIFACT_ID(planHash.value)
    )
      return persistenceFailure(
        "persisted direct-command binding identity is invalid",
      );
    return binding;
  }

  private readTradeCommandBindingFromCommandRow(
    commandId: string,
    database = this.db,
  ): Result<OperatorMainnetTradeCommandBinding | undefined> {
    const row = database
      .prepare(
        `SELECT binding_artifact_id FROM operator_mainnet_trade_command_bindings
         WHERE command_id = ? AND exchange = ? AND environment = ?
           AND account_id = ? AND category = ? AND position_mode = ?`,
      )
      .get(commandId, ...scopeValues(this.scope)) as SqliteRow | undefined;
    if (!row) return ok(undefined);
    const artifactId = storedIdentifier(row, "binding_artifact_id");
    if (!artifactId.ok)
      return persistenceFailure(
        "persisted direct-command binding reference is invalid",
      );
    const binding = this.tradeCommandBindingFromRow(artifactId.value, database);
    return binding.ok ? ok(binding.value) : binding;
  }

  private tradeCommandOutcomeFromRow(
    row: SqliteRow,
  ): Result<OperatorMainnetTradeCommandOutcomeRecord> {
    const outcomeId = storedIdentifier(row, "outcome_id");
    const commandId = storedIdentifier(row, "command_id");
    const revision = requireFiniteInteger(row.revision, "revision", 1);
    const code = requireSafeText(row.code, "outcomeCode");
    const occurredAt = storedTimestamp(row, "occurred_at");
    const diagnosticsJson = storedString(row, "diagnostics_json");
    const canonicalJson = storedString(row, "canonical_json");
    const canonicalHash = storedHash(row, "canonical_hash");
    if (
      !outcomeId.ok ||
      !commandId.ok ||
      !revision.ok ||
      !code.ok ||
      !occurredAt.ok ||
      !diagnosticsJson.ok ||
      !canonicalJson.ok ||
      !canonicalHash.ok ||
      !isTradeCommandOutcomeStage(row.stage)
    )
      return persistenceFailure("persisted trade-command outcome is invalid");
    const parsed = parseJsonHash(canonicalJson.value, canonicalHash.value);
    if (!parsed.ok) return parsed;
    let diagnostics: unknown;
    try {
      diagnostics = JSON.parse(diagnosticsJson.value) as unknown;
    } catch {
      return persistenceFailure(
        "persisted trade-command diagnostics are invalid",
      );
    }
    const normalized = normalizeTradeCommandDiagnostics(diagnostics);
    const diagnosticCanonical = canonicalSerialize(diagnostics);
    const canonical = canonicalSerialize(parsed.value);
    const normalizedCanonical = normalized.ok
      ? canonicalSerialize(normalized.value)
      : normalized;
    if (
      !normalized.ok ||
      !diagnosticCanonical.ok ||
      !canonical.ok ||
      !normalizedCanonical.ok ||
      diagnosticCanonical.value !== diagnosticsJson.value ||
      canonical.value !== canonicalJson.value ||
      !isRecord(parsed.value) ||
      parsed.value.schemaVersion !==
        "operator-mainnet-trade-command-outcome/v1" ||
      parsed.value.outcomeId !== outcomeId.value ||
      parsed.value.commandId !== commandId.value ||
      parsed.value.revision !== revision.value ||
      parsed.value.stage !== row.stage ||
      parsed.value.code !== code.value ||
      parsed.value.occurredAt !== occurredAt.value ||
      normalizedCanonical.value !== diagnosticsJson.value
    )
      return persistenceFailure("trade-command outcome identity is invalid");
    return ok({
      outcomeId: outcomeId.value,
      commandId: commandId.value,
      revision: revision.value,
      stage: row.stage,
      code: code.value,
      occurredAt: occurredAt.value,
      diagnosticDetails: normalized.value,
      canonicalJson: canonicalJson.value,
      canonicalHash: canonicalHash.value as PlanHash,
    });
  }

  private tradeCommandOutcomeRows(
    commandId: string,
    database = this.db,
  ): Result<readonly OperatorMainnetTradeCommandOutcomeRecord[]> {
    const rows = database
      .prepare(
        `SELECT * FROM operator_mainnet_trade_command_outcomes
         WHERE command_id = ? ORDER BY revision`,
      )
      .all(commandId) as SqliteRow[];
    const output: OperatorMainnetTradeCommandOutcomeRecord[] = [];
    for (const row of rows) {
      const outcome = this.tradeCommandOutcomeFromRow(row);
      if (!outcome.ok) return outcome;
      output.push(outcome.value);
    }
    return ok(output);
  }

  private tradeCommandConsumptionFromRow(
    row: SqliteRow,
  ): Result<OperatorMainnetTradeCommandSnapshot["consumption"]> {
    const commandId = storedIdentifier(row, "command_id");
    const receiptHash = storedHash(row, "receipt_hash");
    const bindingHash = storedHash(row, "binding_hash");
    const sourceId = storedIdentifier(row, "source_id");
    const writeIntentId = storedIdentifier(row, "write_intent_id");
    const consumedAt = storedTimestamp(row, "consumed_at");
    if (
      !commandId.ok ||
      !receiptHash.ok ||
      !bindingHash.ok ||
      !sourceId.ok ||
      !writeIntentId.ok ||
      !consumedAt.ok
    )
      return persistenceFailure(
        "persisted trade-command consumption is invalid",
      );
    return ok({
      commandId: commandId.value,
      receiptHash: receiptHash.value as PlanHash,
      bindingHash: bindingHash.value as PlanHash,
      sourceId: sourceId.value,
      writeIntentId: writeIntentId.value,
      consumedAt: consumedAt.value,
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
        value.schemaVersion !== "operator-mainnet-test-create-intent/v3" &&
        value.schemaVersion !== "operator-mainnet-test-create-intent/v4") ||
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
          !requireIdentifier(value.recoveryGrantId, "recoveryGrantId").ok)) ||
      (value.schemaVersion === "operator-mainnet-test-create-intent/v4" &&
        ("leaseOwnerRunId" in value ||
          "leaseEpoch" in value ||
          "recoveryGrantId" in value ||
          !requireIdentifier(value.commandId, "commandId").ok ||
          !requireHash(value.commandReceiptHash, "commandReceiptHash").ok ||
          !requireHash(value.commandBindingHash, "commandBindingHash").ok ||
          "approvalHash" in value))
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
      ...(value.schemaVersion === "operator-mainnet-test-create-intent/v4"
        ? {
            commandId: value.commandId as string,
            commandReceiptHash: value.commandReceiptHash as PlanHash,
            commandBindingHash: value.commandBindingHash as PlanHash,
          }
        : {}),
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
    if (!planArtifact.ok) return planArtifact;
    if (!planArtifact.value)
      return persistenceFailure("operator plan artifact is missing");
    const plan = rehydrateArtifact(PLAN_KIND, planArtifact.value.envelope);
    if (!plan.ok || plan.value.contentHash !== source.value.planHash)
      return persistenceFailure("operator plan artifact failed validation");
    let authorization:
      | Extract<
          OperatorMainnetTestSnapshot["authorization"],
          { kind: "approval" }
        >
      | Extract<
          OperatorMainnetTestSnapshot["authorization"],
          { kind: "trade-command" }
        >;
    if (source.value.authorization.kind === "approval") {
      const approvalArtifact = this.artifactRow(
        source.value.authorization.artifactId,
      );
      if (!approvalArtifact.ok) return approvalArtifact;
      if (
        approvalArtifact.value?.artifactKind !== APPROVAL_KIND ||
        approvalArtifact.value.materialHash !== source.value.authorization.hash
      )
        return persistenceFailure(
          "operator approval artifact is missing or invalid",
        );
      const approval = rehydrateArtifact(
        APPROVAL_KIND,
        approvalArtifact.value.envelope,
      );
      if (
        !approval.ok ||
        approval.value.contentHash !== source.value.authorization.hash
      )
        return persistenceFailure(
          "operator approval artifact failed validation",
        );
      authorization = {
        ...source.value.authorization,
        approval: approval.value,
      };
    } else {
      const binding = this.tradeCommandBindingFromRow(
        source.value.authorization.artifactId,
        database,
      );
      if (!binding.ok) return binding;
      const receipt = this.tradeCommandReceiptFromRow(
        source.value.authorization.commandId,
        database,
      );
      if (!receipt.ok) return receipt;
      const directPlan = rehydrateOperatorMainnetTradeCommandPlan(plan.value);
      if (
        !directPlan.ok ||
        binding.value.contentHash !== source.value.authorization.hash ||
        binding.value.commandId !== source.value.authorization.commandId ||
        receipt.value.contentHash !== source.value.authorization.receiptHash ||
        receipt.value.contentHash !== binding.value.receiptHash ||
        directPlan.value.contentHash !== binding.value.planHash
      )
        return persistenceFailure(
          "operator direct-command artifacts failed validation",
        );
      authorization = {
        ...source.value.authorization,
        receipt: receipt.value,
        binding: binding.value,
      };
    }
    const intentRow = database
      .prepare(
        "SELECT * FROM operator_mainnet_test_write_intents WHERE source_id = ?",
      )
      .get(source.value.sourceId) as SqliteRow | undefined;
    if (!intentRow)
      return persistenceFailure("operator source has no durable CREATE intent");
    const intent = this.intentFromRow(intentRow);
    if (!intent.ok) return intent;
    if (
      authorization.kind === "trade-command" &&
      (intent.value.commandId !== authorization.commandId ||
        intent.value.commandReceiptHash !== authorization.receiptHash ||
        intent.value.commandBindingHash !== authorization.hash)
    )
      return persistenceFailure(
        "direct-command CREATE intent does not match its receipt and binding",
      );
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
    const common = {
      source: source.value,
      plan: plan.value,
      intent: intent.value,
      ...(attempt.value === undefined ? {} : { attempt: attempt.value }),
      reconciliations: reconciliations.value,
      manualActions: manualActions.value,
      ...(sourceDisposition.value === undefined
        ? {}
        : { sourceDisposition: sourceDisposition.value }),
      halt: halt.value,
    };
    return authorization.kind === "approval"
      ? ok({ ...common, authorization })
      : ok({ ...common, authorization });
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
    if (request.tradeCommand !== undefined)
      return this.prepareTradeCommandCreateIntent(request);
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
              authorization_kind, authorization_hash, authorization_artifact_id,
              client_order_id, payload_json, payload_hash, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approval', ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            sourceId,
            ...scopeValues(this.scope),
            artifacts.value.plan.contentHash,
            planArtifactId,
            artifacts.value.approval.contentHash,
            approvalArtifactId,
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

  private prepareTradeCommandCreateIntent(
    request: Extract<
      PrepareOperatorMainnetTestCreateRequest,
      { readonly tradeCommand: unknown }
    >,
  ): Result<OperatorMainnetTestSnapshot> {
    const runId = requireIdentifier(request.runId, "runId");
    const at = parseUtcTimestamp(request.preparedAt);
    const authorizationAt = parseUtcTimestamp(
      request.tradeCommand.authorizationAt,
    );
    const receipt = rehydrateOperatorMainnetTradeCommandReceipt(
      request.tradeCommand.receipt,
    );
    const binding = rehydrateOperatorMainnetTradeCommandBinding(
      request.tradeCommand.binding,
    );
    const plan = rehydrateOperatorMainnetTradeCommandPlan(request.plan);
    if (
      !runId.ok ||
      !at.ok ||
      !authorizationAt.ok ||
      !receipt.ok ||
      !binding.ok ||
      !plan.ok ||
      !validScope(this.scope) ||
      receipt.value.accountIdentityHash !== this.scope.accountId ||
      plan.value.contentHash !== binding.value.planHash ||
      plan.value.commandId !== receipt.value.commandId ||
      plan.value.commandReceiptHash !== receipt.value.contentHash ||
      binding.value.commandId !== receipt.value.commandId ||
      binding.value.receiptHash !== receipt.value.contentHash ||
      binding.value.replayInputs.plan.contentHash !== plan.value.contentHash
    )
      return invalid(
        "direct-command intent inputs do not match the saved authority",
      );
    const currentBinding = validateOperatorMainnetTradeCommandBinding(
      receipt.value,
      binding.value,
      authorizationAt.value,
      request.payloadHash,
    );
    if (!currentBinding.ok) return currentBinding;
    const payload = validatePayload(
      plan.value as unknown as OperatorMainnetTestPlan,
      request.payloadJson,
      request.payloadHash,
    );
    if (!payload.ok) return payload;
    if (
      payload.value.hash !== binding.value.createPayloadHash ||
      timestampToEpochMs(at.value) < timestampToEpochMs(plan.value.preparedAt)
    )
      return invalid(
        "direct-command CREATE payload differs from its immutable binding",
      );
    const sourceId = deriveOperatorMainnetTestSourceId(plan.value.contentHash);
    if (!sourceId.ok || sourceId.value !== binding.value.sourceId)
      return invalid("direct-command source identity differs from its binding");
    const writeIntentId = deterministicId(
      "operator-mainnet-test-write",
      `${sourceId.value}:CREATE`,
    );
    const intentValue = {
      schemaVersion: "operator-mainnet-test-create-intent/v4",
      operation: "CREATE" as const,
      sourceId: sourceId.value,
      runId: runId.value,
      planHash: plan.value.contentHash,
      commandId: receipt.value.commandId,
      commandReceiptHash: receipt.value.contentHash,
      commandBindingHash: binding.value.contentHash,
      accountIdentityHash: plan.value.accountIdentityHash,
      symbol: plan.value.symbol,
      clientOrderId: plan.value.clientOrderId,
      exactPayloadHash: payload.value.hash,
      expiresAt: receipt.value.expiresAt,
      preparedAt: at.value,
    };
    const intent = encode(intentValue);
    if (!intent.ok) return intent;
    const receiptEnvelope = encodeCanonicalArtifact(
      TRADE_COMMAND_RECEIPT_KIND,
      receipt.value,
    );
    const planEnvelope = encodeCanonicalArtifact(PLAN_KIND, plan.value);
    const bindingEnvelope = encodeCanonicalArtifact(
      TRADE_COMMAND_BINDING_KIND,
      binding.value,
    );
    if (!receiptEnvelope.ok || !planEnvelope.ok || !bindingEnvelope.ok)
      return invalid("direct-command artifacts could not be encoded");
    const receiptArtifactId = TRADE_COMMAND_RECEIPT_ARTIFACT_ID(
      receipt.value.contentHash,
    );
    const planArtifactId = PLAN_ARTIFACT_ID(plan.value.contentHash);
    const bindingArtifactId = TRADE_COMMAND_BINDING_ARTIFACT_ID(
      binding.value.contentHash,
    );
    return runInTransaction(
      this.db,
      (database) => {
        const persistedReceipt = this.tradeCommandReceiptFromRow(
          receipt.value.commandId,
          database,
        );
        if (!persistedReceipt.ok) return persistedReceipt;
        const persistedBinding = this.tradeCommandBindingFromRow(
          bindingArtifactId,
          database,
        );
        if (!persistedBinding.ok) return persistedBinding;
        if (
          persistedReceipt.value.contentHash !== receipt.value.contentHash ||
          persistedBinding.value.contentHash !== binding.value.contentHash ||
          persistedBinding.value.planHash !== plan.value.contentHash ||
          persistedBinding.value.createPayloadHash !== payload.value.hash
        )
          return fail(
            domainError(
              "PERSISTENCE_CONFLICT",
              "saved direct-command authority differs from the requested CREATE",
            ),
          );
        if (
          !tradeCommandPreIntentOutcomesPermitCreate(
            database,
            receipt.value.commandId,
          )
        )
          return fail(
            domainError(
              "PERSISTENCE_CONFLICT",
              "a trade-command has a blocking pre-intent outcome and cannot create an intent",
            ),
          );
        if (
          database
            .prepare(
              `SELECT 1 AS present FROM operator_mainnet_trade_command_consumptions
               WHERE command_id = ?`,
            )
            .get(receipt.value.commandId)
        )
          return fail(
            domainError(
              "PERSISTENCE_CONFLICT",
              "direct-command authority was already consumed",
            ),
          );
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
        if (pending.value)
          return fail(
            domainError(
              "UNRESOLVED_STATE",
              "an earlier operator Mainnet source requires reconciliation",
            ),
          );
        if (this.sourceRow(sourceId.value, database))
          return fail(
            domainError(
              "PERSISTENCE_CONFLICT",
              "operator source already has a durable intent",
            ),
          );
        for (const [artifactId, envelope, materialHash, createdAt] of [
          [
            receiptArtifactId,
            receiptEnvelope.value,
            receipt.value.contentHash,
            receipt.value.acceptedAt,
          ],
          [
            planArtifactId,
            planEnvelope.value,
            plan.value.contentHash,
            plan.value.preparedAt,
          ],
          [
            bindingArtifactId,
            bindingEnvelope.value,
            binding.value.contentHash,
            binding.value.boundAt,
          ],
        ] as const) {
          const stored = insertArtifact(
            database,
            this.scope,
            artifactId,
            envelope,
            materialHash,
            createdAt,
          );
          if (!stored.ok) return stored;
        }
        database
          .prepare(
            `INSERT INTO operator_mainnet_test_sources
             (source_id, exchange, environment, account_id, category, position_mode,
              plan_hash, plan_artifact_id, approval_hash, approval_artifact_id,
              authorization_kind, authorization_hash, authorization_artifact_id,
              client_order_id, payload_json, payload_hash, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'trade-command', ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            sourceId.value,
            ...scopeValues(this.scope),
            plan.value.contentHash,
            planArtifactId,
            binding.value.contentHash,
            bindingArtifactId,
            binding.value.contentHash,
            bindingArtifactId,
            plan.value.clientOrderId,
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
            sourceId.value,
            runId.value,
            intent.value.json,
            intent.value.hash,
            at.value,
          );
        database
          .prepare(
            `INSERT INTO operator_mainnet_trade_command_consumptions
             (command_id, receipt_hash, binding_hash, source_id, write_intent_id, consumed_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            receipt.value.commandId,
            receipt.value.contentHash,
            binding.value.contentHash,
            sourceId.value,
            writeIntentId,
            at.value,
          );
        const source = this.sourceRow(sourceId.value, database);
        if (!source)
          return invalid(
            "direct-command source did not persist with its CREATE intent",
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
