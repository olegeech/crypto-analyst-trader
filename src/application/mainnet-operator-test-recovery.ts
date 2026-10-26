import { openSqlitePersistence } from "../adapters/sqlite/sqlite-persistence.js";
import {
  resolveOperatorMainnetPlan,
  resolveOperatorMainnetSource,
} from "../adapters/sqlite/operator-mainnet-test-lookup.js";
import {
  createOperatorMainnetRecoveryAttestation,
  operatorMainnetRecoverySourceRevision,
  type OperatorMainnetRecoveryAttestation,
} from "../domain/execution/operator-mainnet-recovery.js";
import type { PlanHash } from "../domain/identity/canonical-serialization.js";
import { domainError } from "../domain/shared/errors.js";
import { fail, ok, type Result } from "../domain/shared/result.js";
import { parseUtcTimestamp, type UtcTimestamp } from "../domain/shared/time.js";
import {
  isRecord,
  requireHash,
  requireIdentifier,
} from "../domain/shared/validation.js";
import type {
  OperatorMainnetRecoveryGrant,
  OperatorRecoveryAcceptedUncertainty,
  OperatorRecoveryManualAction,
} from "../domain/execution/operator-mainnet-recovery.js";

export interface OperatorMainnetRecoveryInspectionInput {
  /** Time the operator actually inspected the Bybit UI, from the local JSON file. */
  readonly observedAt: unknown;
  readonly inspection: unknown;
  readonly manualActions: readonly OperatorRecoveryManualAction[];
  readonly acceptedUncertainty: readonly OperatorRecoveryAcceptedUncertainty[];
}

export interface PersistManualOperatorRecoveryInput {
  readonly sourceId: string;
  readonly inspection: OperatorMainnetRecoveryInspectionInput;
  readonly actor: string;
  /** Local persistence time; deliberately separate from the UI observation time. */
  readonly recordedAt: UtcTimestamp;
}

export interface ManualOperatorRecoveryResult {
  readonly attestation: OperatorMainnetRecoveryAttestation;
  readonly exchangeReads: 0;
  readonly exchangeWrites: 0;
}

export interface OperatorRecoveryApplicationDependencies {
  readonly resolveSource?: typeof resolveOperatorMainnetSource;
  readonly resolvePlan?: typeof resolveOperatorMainnetPlan;
  readonly openPersistence?: typeof openSqlitePersistence;
}

function failed(code: string, message = "operator recovery is blocked") {
  return fail(domainError("INVALID_APPROVAL", message, { reasonCode: code }));
}

export function persistManualOperatorRecoveryAttestation(
  input: PersistManualOperatorRecoveryInput,
  dependencies: OperatorRecoveryApplicationDependencies = {},
): Result<ManualOperatorRecoveryResult> {
  const sourceId = requireIdentifier(input.sourceId, "sourceId");
  const actor = requireIdentifier(input.actor, "actor");
  const observedAt = parseUtcTimestamp(input.inspection?.observedAt);
  const recordedAt = parseUtcTimestamp(input.recordedAt);
  if (
    !sourceId.ok ||
    !actor.ok ||
    !observedAt.ok ||
    !recordedAt.ok ||
    !isRecord(input.inspection) ||
    Reflect.ownKeys(input.inspection).length !== 4 ||
    !Object.hasOwn(input.inspection, "observedAt") ||
    !Object.hasOwn(input.inspection, "inspection") ||
    !Object.hasOwn(input.inspection, "manualActions") ||
    !Object.hasOwn(input.inspection, "acceptedUncertainty")
  )
    return failed("INVALID_MANUAL_RECOVERY_INPUT");
  const resolved = (dependencies.resolveSource ?? resolveOperatorMainnetSource)(
    sourceId.value,
  );
  if (!resolved.ok) return resolved;
  if (!resolved.value) return failed("RECOVERY_SOURCE_NOT_FOUND");
  const { scope, snapshot } = resolved.value;
  const currentRevision = operatorMainnetRecoverySourceRevision(snapshot);
  const attestation = createOperatorMainnetRecoveryAttestation({
    provenance: "MANUAL_ATTESTED_NOT_API_VERIFIED",
    exchange: "bybit",
    environment: "mainnet",
    accountIdentityHash: scope.accountId,
    sourceId: snapshot.source.sourceId,
    sourcePlanHash: snapshot.source.planHash,
    sourceIntentId: snapshot.intent.writeIntentId,
    sourceRevision: currentRevision,
    actor: actor.value,
    observedAt: observedAt.value,
    inspection: input.inspection.inspection,
    manualActions: input.inspection.manualActions,
    acceptedUncertainty: input.inspection.acceptedUncertainty,
  });
  if (!attestation.ok) return attestation;
  const persistence = (dependencies.openPersistence ?? openSqlitePersistence)({
    environment: "mainnet",
    scope,
  });
  if (!persistence.ok) return persistence;
  try {
    const journal = persistence.value.operatorMainnetTest;
    if (!journal) return failed("OPERATOR_JOURNAL_UNAVAILABLE");
    const saved = journal.persistOperatorMainnetRecoveryAttestation({
      attestation: attestation.value,
      recordedAt: recordedAt.value,
    });
    return saved.ok
      ? ok({
          attestation: saved.value,
          exchangeReads: 0,
          exchangeWrites: 0,
        })
      : saved;
  } finally {
    persistence.value.close();
  }
}

export interface RecoverMainnetOperatorTestInput {
  readonly sourceId: string;
  readonly planHash: PlanHash;
  readonly resolution: "api-resolved" | "manual-attested";
  readonly actor: string;
  readonly consent: true;
  readonly issuedAt: UtcTimestamp;
}

export interface RecoverMainnetOperatorTestResult {
  readonly grant: OperatorMainnetRecoveryGrant;
  readonly exchangeReads: 0;
  readonly exchangeWrites: 0;
}

/** Explicit local-journal recovery; this function has no exchange transport. */
export function recoverMainnetOperatorTest(
  input: RecoverMainnetOperatorTestInput,
  dependencies: OperatorRecoveryApplicationDependencies = {},
): Result<RecoverMainnetOperatorTestResult> {
  const sourceId = requireIdentifier(input.sourceId, "sourceId");
  const planHash = requireHash(input.planHash, "planHash");
  const actor = requireIdentifier(input.actor, "actor");
  const issuedAt = parseUtcTimestamp(input.issuedAt);
  if (!sourceId.ok || !planHash.ok || !actor.ok || !issuedAt.ok)
    return failed("INVALID_RECOVERY_INPUT");
  const source = (dependencies.resolveSource ?? resolveOperatorMainnetSource)(
    sourceId.value,
  );
  const plan = (dependencies.resolvePlan ?? resolveOperatorMainnetPlan)(
    planHash.value,
  );
  if (!source.ok) return source;
  if (!plan.ok) return plan;
  if (!source.value || !plan.value)
    return failed("RECOVERY_ARTIFACT_NOT_FOUND");
  if (
    source.value.scope.accountId !== plan.value.scope.accountId ||
    source.value.scope.exchange !== plan.value.scope.exchange ||
    source.value.scope.environment !== plan.value.scope.environment ||
    source.value.scope.category !== plan.value.scope.category ||
    source.value.scope.positionMode !== plan.value.scope.positionMode ||
    plan.value.plan.accountIdentityHash !== source.value.scope.accountId
  )
    return failed("RECOVERY_SCOPE_MISMATCH");

  const persistence = (dependencies.openPersistence ?? openSqlitePersistence)({
    environment: "mainnet",
    scope: source.value.scope,
  });
  if (!persistence.ok) return persistence;
  try {
    const journal = persistence.value.operatorMainnetTest;
    if (!journal) return failed("OPERATOR_JOURNAL_UNAVAILABLE");
    let resolution:
      | {
          readonly kind: "api-resolved";
          readonly reconciliationId: string;
          readonly reconciliationHash: PlanHash;
        }
      | {
          readonly kind: "manual-attested";
          readonly attestationHash: PlanHash;
        };
    if (input.resolution === "api-resolved") {
      const latest = source.value.snapshot.reconciliations.at(-1);
      if (!latest || latest.cleanupStatus !== "verified-clean")
        return failed(
          "API_CLEANUP_NOT_VERIFIED",
          "run GET-only status and recover only from its latest verified-clean reconciliation",
        );
      resolution = {
        kind: "api-resolved",
        reconciliationId: latest.reconciliationId,
        reconciliationHash: latest.canonicalHash,
      };
    } else {
      if (!plan.value.plan.recoveryAttestationHash)
        return failed(
          "MANUAL_ATTESTATION_NOT_BOUND_TO_PLAN",
          "prepare the exact plan with the saved manual recovery attestation before recovery",
        );
      resolution = {
        kind: "manual-attested",
        attestationHash: plan.value.plan.recoveryAttestationHash,
      };
    }
    const grant = journal.createOperatorMainnetRecoveryGrant({
      sourceId: sourceId.value,
      planHash: plan.value.plan.contentHash,
      resolution,
      actor: actor.value,
      consent: input.consent,
      issuedAt: issuedAt.value,
    });
    return grant.ok
      ? ok({ grant: grant.value, exchangeReads: 0, exchangeWrites: 0 })
      : grant;
  } finally {
    persistence.value.close();
  }
}
