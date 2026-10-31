import { createHash, randomUUID } from "node:crypto";

import { mapCreateOrderRequest } from "../adapters/bybit-v5/order-mappers.js";
import {
  deriveOperatorMainnetTestSourceId,
  rehydrateOperatorMainnetTestApproval,
  rehydrateOperatorMainnetTestPlan,
  validateOperatorMainnetTestApproval,
} from "../domain/execution/operator-mainnet-test-plan.js";
import type { PlanHash } from "../domain/identity/canonical-serialization.js";
import { domainError } from "../domain/shared/errors.js";
import { fail, ok, type Result } from "../domain/shared/result.js";
import {
  parseUtcTimestamp,
  timestampFromEpochMs,
  timestampToEpochMs,
  type Clock,
  type UtcTimestamp,
} from "../domain/shared/time.js";
import { requireHash, requireIdentifier } from "../domain/shared/validation.js";
import type {
  MainnetExchangeExecutionPort,
  ExchangeOrderAcknowledgement,
  ExchangeResult,
  ExchangeOrderRequest,
} from "../ports/exchange-execution.js";
import type {
  OperatorMainnetTestAuthorizationPort,
  OperatorMainnetTestCreateAuthorizationBinding,
} from "../ports/operator-mainnet-test-authorization.js";
import type {
  OperatorMainnetTestPersistencePort,
  OperatorMainnetTestAttemptOutcome,
} from "../ports/operator-mainnet-test-persistence.js";
import type { PersistencePort } from "../ports/persistence.js";
import {
  createOperatorMainnetCreateRequest,
  revalidateMainnetOperatorEvidenceAge,
  validateMainnetOperatorTestEvidence,
  type MainnetOperatorTestEvidencePort,
} from "./mainnet-entry-evidence.js";

import { OperatorEvidenceReadError } from "./mainnet-operator-test-evidence.js";
import type { MainnetInvocationMetrics } from "./mainnet-composition-helpers.js";

export interface MainnetOperatorTestDependencies {
  readonly persistence: PersistencePort;
  readonly journal: OperatorMainnetTestPersistencePort;
  readonly exchange: Pick<MainnetExchangeExecutionPort, "createOrder">;
  readonly evidence: MainnetOperatorTestEvidencePort;
  readonly authorization: OperatorMainnetTestAuthorizationPort;
  readonly localClock: Clock;
  readonly monotonicClock: () => number;
}

export interface MainnetOperatorTestInput {
  readonly approval: unknown;
  readonly approvalHash: unknown;
  readonly runId: unknown;
}

export interface MainnetOperatorTestOutcome extends Partial<MainnetInvocationMetrics> {
  readonly kind: "attempted" | "recovery";
  readonly sourceId: string;
  readonly clientOrderId: string;
  readonly attemptOutcome?: OperatorMainnetTestAttemptOutcome;
  readonly attemptJournaled: boolean;
  readonly reasonCode?: string;
  /** Production composition counts actual Mainnet HTTP requests per invocation. */
  readonly exchangeReads?: number;
  readonly exchangeWrites?: number;
}

function blocked(
  code: string,
  message = "operator Mainnet admission is blocked",
  details: Readonly<Record<string, unknown>> = {},
) {
  return fail(
    domainError("INVALID_CAPABILITY", message, {
      reasonCode: code,
      ...details,
    }),
  );
}

function sameScope(
  left: PersistencePort["scope"],
  right: PersistencePort["scope"],
): boolean {
  return (
    left.exchange === right.exchange &&
    left.environment === right.environment &&
    left.accountId === right.accountId &&
    left.category === right.category &&
    left.positionMode === right.positionMode
  );
}

function effectiveProviderTime(
  base: UtcTimestamp,
  elapsedMs: number,
): Result<UtcTimestamp> {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0)
    return fail(
      domainError("INVALID_TIMESTAMP", "provider time progression is invalid"),
    );
  return timestampFromEpochMs(timestampToEpochMs(base) + Math.ceil(elapsedMs));
}

function haltIsClear(persistence: PersistencePort): Result<void> {
  const halt = persistence.readHalt();
  if (!halt.ok) return halt;
  if (halt.value.active || halt.value.reconciliationRequired)
    return blocked("HALT_OR_RECONCILIATION_REQUIRED");
  return ok(undefined);
}

function payloadFor(
  request: ExchangeOrderRequest,
): Result<{ json: string; hash: PlanHash }> {
  try {
    const json = JSON.stringify(mapCreateOrderRequest(request));
    const hashText =
      `sha256:${createHash("sha256").update(json, "utf8").digest("hex")}` as PlanHash;
    const hash = requireHash(hashText, "payloadHash");
    if (!hash.ok) return hash;
    return ok({ json, hash: hashText });
  } catch {
    return fail(
      domainError("INVALID_CAPABILITY", "approved CREATE payload is invalid"),
    );
  }
}

function validAcknowledgement(
  value: unknown,
  clientOrderId: string,
): value is ExchangeOrderAcknowledgement {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const row = value as Record<string, unknown>;
  return (
    row.clientOrderId === clientOrderId &&
    (row.status === "accepted" || row.status === "pending") &&
    parseUtcTimestamp(row.acknowledgedAt).ok &&
    (row.exchangeOrderId === undefined ||
      requireIdentifier(row.exchangeOrderId, "exchangeOrderId").ok)
  );
}

function classifyAttempt(
  result: ExchangeResult<ExchangeOrderAcknowledgement> | undefined,
  thrown: boolean,
  clientOrderId: string,
): {
  readonly outcome: OperatorMainnetTestAttemptOutcome;
  readonly exchangeOrderId?: string;
  readonly providerReasonCode?: string;
} {
  if (thrown || result === undefined)
    return {
      outcome: "ambiguous",
      providerReasonCode: "CREATE_RESULT_UNKNOWN",
    };
  if (result.ok) {
    if (!validAcknowledgement(result.value, clientOrderId))
      return {
        outcome: "ambiguous",
        providerReasonCode: "ACK_IDENTITY_INVALID",
      };
    return {
      outcome: "accepted",
      ...(result.value.exchangeOrderId === undefined
        ? {}
        : { exchangeOrderId: result.value.exchangeOrderId }),
    };
  }
  const error = result.error;
  const knownRejection =
    error.kind === "exchange" ||
    error.kind === "permission" ||
    error.kind === "authentication" ||
    error.kind === "precondition";
  return {
    outcome: knownRejection ? "rejected" : "ambiguous",
    providerReasonCode: `CREATE_${error.kind.toUpperCase().replaceAll("-", "_")}`,
  };
}

function recovery(
  sourceId: string,
  clientOrderId: string,
  reasonCode: string,
  attemptOutcome?: OperatorMainnetTestAttemptOutcome,
  attemptJournaled = false,
): MainnetOperatorTestOutcome {
  return Object.freeze({
    kind: "recovery",
    sourceId,
    clientOrderId,
    ...(attemptOutcome === undefined ? {} : { attemptOutcome }),
    attemptJournaled,
    reasonCode,
  });
}

/** One source-bound CREATE attempt. Durable intent is the no-resend boundary. */
export async function executeMainnetOperatorTest(
  input: MainnetOperatorTestInput,
  dependencies: MainnetOperatorTestDependencies,
): Promise<Result<MainnetOperatorTestOutcome>> {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    Reflect.ownKeys(input).length !== 3 ||
    !Object.hasOwn(input, "approval") ||
    !Object.hasOwn(input, "approvalHash") ||
    !Object.hasOwn(input, "runId")
  )
    return blocked("INVALID_INPUT");

  const approval = rehydrateOperatorMainnetTestApproval(input.approval);
  const approvalHash = requireHash(input.approvalHash, "approvalHash");
  const runId = requireIdentifier(input.runId, "runId");
  const localNow = parseUtcTimestamp(dependencies.localClock.now());
  if (!approval.ok || !approvalHash.ok || !runId.ok || !localNow.ok)
    return blocked("INVALID_APPROVAL_OR_RUN_ID");
  const plan = rehydrateOperatorMainnetTestPlan(
    approval.value.replayInputs.plan,
  );
  if (!plan.ok) return fail(plan.error);
  if (
    !sameScope(dependencies.persistence.scope, {
      exchange: "bybit",
      environment: "mainnet",
      accountId: plan.value.accountIdentityHash,
      category: "linear",
      positionMode: "one-way",
    })
  )
    return blocked("PERSISTENCE_SCOPE_MISMATCH");
  const sourceId = deriveOperatorMainnetTestSourceId(plan.value.contentHash);
  if (!sourceId.ok) return sourceId;
  const exactApproval = validateOperatorMainnetTestApproval(
    approval.value,
    plan.value,
    approvalHash.value,
    localNow.value,
  );
  if (!exactApproval.ok) return exactApproval;

  const existing = dependencies.journal.readOperatorMainnetTestSource(
    sourceId.value,
  );
  if (!existing.ok) return existing;
  if (existing.value)
    return ok(
      recovery(
        sourceId.value,
        plan.value.clientOrderId,
        "SOURCE_ALREADY_ADMITTED_NO_RESEND",
        existing.value.attempt?.outcome,
        existing.value.attempt !== undefined,
      ),
    );

  const recoveryGrant = dependencies.journal.findOperatorMainnetRecoveryGrant(
    plan.value.contentHash,
    localNow.value,
  );
  if (!recoveryGrant.ok) return recoveryGrant;
  if (
    plan.value.recoveryAttestationHash &&
    (!recoveryGrant.value ||
      recoveryGrant.value.resolution.kind !== "manual-attested" ||
      recoveryGrant.value.resolution.attestationHash !==
        plan.value.recoveryAttestationHash)
  )
    return blocked(
      "RECOVERY_AUTHORIZATION_REQUIRED",
      "manual recovery plans require an unexpired, exact-plan recovery grant",
    );

  const initial = haltIsClear(dependencies.persistence);
  if (!initial.ok) return initial;
  const pending = dependencies.journal.findPendingOperatorMainnetTestSource();
  if (!pending.ok) return pending;
  if (
    pending.value &&
    (recoveryGrant.value === undefined ||
      pending.value.sourceId !== recoveryGrant.value.sourceId)
  )
    return blocked("UNRESOLVED_SAME_ACCOUNT_SOURCE_EXISTS");

  let fresh: Awaited<ReturnType<MainnetOperatorTestEvidencePort["collect"]>>;
  try {
    fresh = await dependencies.evidence.collect(plan.value.symbol);
  } catch (error) {
    if (error instanceof OperatorEvidenceReadError)
      return blocked(
        error.reasonCode,
        "operator Mainnet admission evidence was not accepted",
        error.details,
      );
    return blocked("FRESH_MAINNET_EVIDENCE_UNAVAILABLE");
  }
  const evidence = validateMainnetOperatorTestEvidence(plan.value, fresh);
  if (!evidence.ok) return evidence;
  const evidenceTime =
    "manualTargetState" in fresh && fresh.manualTargetState
      ? fresh.manualTargetState.serverTime
      : "state" in fresh && fresh.state
        ? fresh.state.serverTime
        : undefined;
  const providerTime = parseUtcTimestamp(evidenceTime);
  if (!providerTime.ok) return blocked("PROVIDER_TIME_INVALID");
  const currentApproval = validateOperatorMainnetTestApproval(
    exactApproval.value,
    plan.value,
    approvalHash.value,
    providerTime.value,
  );
  if (!currentApproval.ok) return currentApproval;
  const create = createOperatorMainnetCreateRequest(plan.value);
  if (!create.ok) return create;
  const exactPayload = payloadFor(create.value.request);
  const approvedPayloadHash = requireHash(
    create.value.payloadHash,
    "payloadHash",
  );
  if (
    !exactPayload.ok ||
    !approvedPayloadHash.ok ||
    exactPayload.value.json !== create.value.payloadJson ||
    exactPayload.value.hash !== approvedPayloadHash.value
  )
    return blocked("APPROVED_CREATE_PAYLOAD_MISMATCH");

  let evidenceMonotonic = Number.NaN;
  try {
    evidenceMonotonic = dependencies.monotonicClock();
  } catch {
    return blocked("MONOTONIC_CLOCK_INVALID");
  }
  if (!Number.isFinite(evidenceMonotonic))
    return blocked("MONOTONIC_CLOCK_INVALID");
  const binding: OperatorMainnetTestCreateAuthorizationBinding = Object.freeze({
    operation: "CREATE",
    environment: "mainnet",
    planHash: plan.value.contentHash,
    approvalHash: exactApproval.value.contentHash,
    sourceId: sourceId.value,
    accountIdentityHash: plan.value.accountIdentityHash,
    symbol: plan.value.symbol,
    clientOrderId: plan.value.clientOrderId,
    exactPayloadHash: approvedPayloadHash.value as PlanHash,
    runId: runId.value,
    expiresAt: exactApproval.value.expiresAt,
  });
  let capability: object | undefined;
  try {
    capability = await dependencies.authorization.issue(binding);
  } catch {
    return blocked("CREATE_AUTHORIZATION_UNAVAILABLE");
  }
  if (typeof capability !== "object" || capability === null)
    return blocked("CREATE_AUTHORIZATION_UNAVAILABLE");

  const prepared = dependencies.journal.prepareCreateIntent({
    runId: runId.value,
    plan: plan.value,
    approval: exactApproval.value,
    payloadJson: create.value.payloadJson,
    payloadHash: approvedPayloadHash.value as PlanHash,
    preparedAt: providerTime.value,
    ...(recoveryGrant.value === undefined
      ? {}
      : { recoveryGrantId: recoveryGrant.value.grantId }),
  });
  if (!prepared.ok) return prepared;

  const elapsedNow = () => {
    let monotonicNow: number;
    try {
      monotonicNow = dependencies.monotonicClock();
    } catch {
      return fail(
        domainError("INVALID_TIMESTAMP", "monotonic clock is unavailable"),
      );
    }
    if (!Number.isFinite(monotonicNow) || monotonicNow < evidenceMonotonic)
      return fail(
        domainError("INVALID_TIMESTAMP", "monotonic clock moved backwards"),
      );
    return ok(monotonicNow - evidenceMonotonic);
  };
  const rejectAfterIntent = (
    reasonCode: string,
  ): Result<MainnetOperatorTestOutcome> => {
    return ok(recovery(sourceId.value, plan.value.clientOrderId, reasonCode));
  };

  const elapsed = elapsedNow();
  if (!elapsed.ok) return rejectAfterIntent("POST_INTENT_RECHECK_UNAVAILABLE");
  const currentProviderTime = effectiveProviderTime(
    providerTime.value,
    elapsed.value,
  );
  if (!currentProviderTime.ok)
    return rejectAfterIntent("PROVIDER_TIME_RECHECK_UNAVAILABLE");
  const approvalStillValid = validateOperatorMainnetTestApproval(
    exactApproval.value,
    plan.value,
    approvalHash.value,
    currentProviderTime.value,
  );
  const freshEnough = revalidateMainnetOperatorEvidenceAge(
    plan.value,
    evidence.value,
    elapsed.value,
  );
  const payloadAgain = payloadFor(create.value.request);
  const halt = haltIsClear(dependencies.persistence);
  const persisted = dependencies.journal.readOperatorMainnetTestSource(
    sourceId.value,
  );
  if (
    !approvalStillValid.ok ||
    !freshEnough.ok ||
    !payloadAgain.ok ||
    payloadAgain.value.json !== create.value.payloadJson ||
    payloadAgain.value.hash !== approvedPayloadHash.value ||
    !halt.ok ||
    !persisted.ok ||
    !persisted.value ||
    persisted.value.intent.operation !== "CREATE" ||
    persisted.value.intent.runId !== runId.value ||
    persisted.value.source.payloadHash !== approvedPayloadHash.value
  )
    return rejectAfterIntent("POST_INTENT_RECHECK_FAILED");

  if (
    !dependencies.authorization.consume(
      capability,
      binding,
      currentProviderTime.value,
    )
  )
    return rejectAfterIntent("CREATE_CAPABILITY_INVALID_OR_CONSUMED");

  let dispatchResult: ExchangeResult<ExchangeOrderAcknowledgement> | undefined;
  let dispatchThrew = false;
  try {
    // This is the sole dispatch site. The one-use capability is consumed directly above it.
    dispatchResult = await dependencies.exchange.createOrder(
      create.value.request,
    );
  } catch {
    dispatchThrew = true;
  }
  const classified = classifyAttempt(
    dispatchResult,
    dispatchThrew,
    plan.value.clientOrderId,
  );
  const elapsedAfterDispatch = elapsedNow();
  const attemptAt = effectiveProviderTime(
    providerTime.value,
    elapsedAfterDispatch.ok ? elapsedAfterDispatch.value : elapsed.value,
  );
  const recordedAt = attemptAt.ok ? attemptAt.value : providerTime.value;
  const attempt = dependencies.journal.recordAttempt({
    runId: runId.value,
    sourceId: sourceId.value,
    attemptId: randomUUID(),
    outcome: classified.outcome,
    ...(classified.exchangeOrderId === undefined
      ? {}
      : { exchangeOrderId: classified.exchangeOrderId }),
    ...(classified.providerReasonCode === undefined
      ? {}
      : { providerReasonCode: classified.providerReasonCode }),
    recordedAt,
  });
  if (!attempt.ok) {
    // A durable CREATE may already have reached Bybit. If its result could not
    // be journaled atomically with the attempt, preserve an explicit incident
    // using the still-validated source and intent, and never resubmit it.
    dependencies.journal.raiseHalt(
      sourceId.value,
      "operator Mainnet CREATE outcome could not be durably recorded",
      recordedAt,
    );
    return ok(
      recovery(
        sourceId.value,
        plan.value.clientOrderId,
        "POST_OUTCOME_NOT_DURABLY_RECORDED_NO_RESEND",
        "ambiguous",
      ),
    );
  }
  return ok(
    Object.freeze({
      kind: "attempted",
      sourceId: sourceId.value,
      clientOrderId: plan.value.clientOrderId,
      attemptOutcome: classified.outcome,
      attemptJournaled: true,
      ...(classified.providerReasonCode === undefined
        ? {}
        : { reasonCode: classified.providerReasonCode }),
    }),
  );
}
