import { createHash, randomUUID } from "node:crypto";

import { mapCreateOrderRequest } from "../adapters/bybit-v5/order-mappers.js";
import {
  deriveOperatorMainnetTestSourceId,
  rehydrateOperatorMainnetTestApproval,
  rehydrateOperatorMainnetTestPlan,
  validateOperatorMainnetTestApproval,
  type OperatorMainnetTestApproval,
  type OperatorMainnetTestPlan,
} from "../domain/execution/operator-mainnet-test-plan.js";
import {
  rehydrateOperatorMainnetTradeCommandBinding,
  rehydrateOperatorMainnetTradeCommandPlan,
  rehydrateOperatorMainnetTradeCommandReceipt,
  validateOperatorMainnetTradeCommandBinding,
  type OperatorMainnetTradeCommandBinding,
  type OperatorMainnetTradeCommandPlan,
  type OperatorMainnetTradeCommandReceipt,
} from "../domain/execution/operator-mainnet-trade-command.js";
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
  OperatorMainnetTestSnapshot,
} from "../ports/operator-mainnet-test-persistence.js";
import type { PersistencePort } from "../ports/persistence.js";
import type { OperatorMainnetRecoveryGrant } from "../domain/execution/operator-mainnet-recovery.js";
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
  /** OS-derived only by the private production composition; ignored for legacy approvals. */
  readonly localActorIdentityHash: () => Result<PlanHash>;
}

export type MainnetOperatorTestAuthorizationInput =
  | {
      readonly kind: "approval";
      readonly approval: unknown;
      readonly approvalHash: unknown;
    }
  | {
      readonly kind: "trade-command";
      readonly receipt: unknown;
      readonly binding: unknown;
    };

export interface MainnetOperatorTestInput {
  readonly authorization: MainnetOperatorTestAuthorizationInput;
  /** Required only for the direct-command variant; it is replay-checked against its binding. */
  readonly plan?: unknown;
  readonly runId: unknown;
}

/** Transitional CLI input accepted only by the production composition adapter. */
export interface LegacyMainnetOperatorTestInput {
  readonly approval: unknown;
  readonly approvalHash: unknown;
  readonly runId: unknown;
}

export type MainnetOperatorTestCompositionInput =
  MainnetOperatorTestInput | LegacyMainnetOperatorTestInput;

type ValidatedAuthorization =
  | {
      readonly kind: "approval";
      readonly approval: OperatorMainnetTestApproval;
      readonly approvalHash: PlanHash;
      readonly plan: OperatorMainnetTestPlan;
      readonly expiresAt: UtcTimestamp;
    }
  | {
      readonly kind: "trade-command";
      readonly receipt: OperatorMainnetTradeCommandReceipt;
      readonly binding: OperatorMainnetTradeCommandBinding;
      readonly plan: OperatorMainnetTestPlan;
      readonly expiresAt: UtcTimestamp;
    };

export interface MainnetOperatorTestOutcome extends Partial<MainnetInvocationMetrics> {
  readonly kind: "attempted" | "recovery";
  readonly sourceId: string;
  readonly clientOrderId: string;
  readonly attemptOutcome?: OperatorMainnetTestAttemptOutcome;
  readonly attemptJournaled: boolean;
  readonly reasonCode?: string;
  readonly admissionQuoteAgeAtReadMs?: number;
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

function exactOwnDataRecord(
  value: unknown,
  fields: readonly string[],
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null) &&
    Reflect.ownKeys(value).length === fields.length &&
    fields.every((field) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      return descriptor !== undefined && Object.hasOwn(descriptor, "value");
    })
  );
}

function validateAuthorizationInput(
  input: unknown,
  now: UtcTimestamp,
  localActorIdentityHash: () => Result<PlanHash>,
): Result<ValidatedAuthorization & { readonly runId: string }> {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return blocked("INVALID_INPUT");
  const authorizationDescriptor = Object.getOwnPropertyDescriptor(
    input,
    "authorization",
  );
  const runIdDescriptor = Object.getOwnPropertyDescriptor(input, "runId");
  if (
    !authorizationDescriptor ||
    !Object.hasOwn(authorizationDescriptor, "value") ||
    !runIdDescriptor ||
    !Object.hasOwn(runIdDescriptor, "value")
  )
    return blocked("INVALID_INPUT");
  const authorization = authorizationDescriptor.value as unknown;
  const runId = requireIdentifier(runIdDescriptor.value, "runId");
  if (!runId.ok) return blocked("INVALID_AUTHORIZATION_OR_RUN_ID");
  if (
    typeof authorization !== "object" ||
    authorization === null ||
    Array.isArray(authorization)
  )
    return blocked("INVALID_AUTHORIZATION_OR_RUN_ID");
  const kindDescriptor = Object.getOwnPropertyDescriptor(authorization, "kind");
  if (!kindDescriptor || !Object.hasOwn(kindDescriptor, "value"))
    return blocked("INVALID_AUTHORIZATION_OR_RUN_ID");
  const tag = kindDescriptor.value;
  if (tag === "approval") {
    if (
      !exactOwnDataRecord(input, ["authorization", "runId"]) ||
      !exactOwnDataRecord(authorization, ["kind", "approval", "approvalHash"])
    )
      return blocked("INVALID_INPUT");
    const approval = rehydrateOperatorMainnetTestApproval(
      authorization.approval,
    );
    const approvalHash = requireHash(
      authorization.approvalHash,
      "approvalHash",
    );
    if (
      !approval.ok ||
      !approvalHash.ok ||
      approval.value.contentHash !== approvalHash.value
    )
      return blocked("INVALID_APPROVAL_OR_RUN_ID");
    const plan = rehydrateOperatorMainnetTestPlan(
      approval.value.replayInputs.plan,
    );
    if (!plan.ok) return plan;
    const exactApproval = validateOperatorMainnetTestApproval(
      approval.value,
      plan.value,
      approvalHash.value,
      now,
    );
    if (!exactApproval.ok) return exactApproval;
    return ok({
      kind: "approval",
      approval: exactApproval.value,
      approvalHash: approvalHash.value as PlanHash,
      plan: plan.value,
      expiresAt: exactApproval.value.expiresAt,
      runId: runId.value,
    });
  }
  if (tag === "trade-command") {
    if (
      !exactOwnDataRecord(input, ["authorization", "plan", "runId"]) ||
      !exactOwnDataRecord(authorization, ["kind", "receipt", "binding"])
    )
      return blocked("INVALID_INPUT");
    const planDescriptor = Object.getOwnPropertyDescriptor(input, "plan");
    if (!planDescriptor || !Object.hasOwn(planDescriptor, "value"))
      return blocked("INVALID_INPUT");
    const receipt = rehydrateOperatorMainnetTradeCommandReceipt(
      authorization.receipt,
    );
    const binding = rehydrateOperatorMainnetTradeCommandBinding(
      authorization.binding,
    );
    const plan = rehydrateOperatorMainnetTradeCommandPlan(planDescriptor.value);
    if (!receipt.ok || !binding.ok || !plan.ok)
      return blocked("INVALID_TRADE_COMMAND_AUTHORITY");
    if (
      plan.value.contentHash !== binding.value.planHash ||
      plan.value.contentHash !== binding.value.replayInputs.plan.contentHash ||
      plan.value.commandId !== receipt.value.commandId ||
      binding.value.commandId !== receipt.value.commandId ||
      binding.value.receiptHash !== receipt.value.contentHash ||
      plan.value.commandReceiptHash !== receipt.value.contentHash ||
      plan.value.accountIdentityHash !== receipt.value.accountIdentityHash
    )
      return blocked("TRADE_COMMAND_BINDING_MISMATCH");
    const localActor = localActorIdentityHash();
    if (!localActor.ok || localActor.value !== receipt.value.actorIdentityHash)
      return blocked("LOCAL_OPERATOR_IDENTITY_MISMATCH");
    const exactBinding = validateOperatorMainnetTradeCommandBinding(
      receipt.value,
      binding.value,
      now,
    );
    if (!exactBinding.ok) return exactBinding;
    return ok({
      kind: "trade-command",
      receipt: receipt.value,
      binding: exactBinding.value,
      plan: plan.value as unknown as OperatorMainnetTestPlan,
      expiresAt: receipt.value.expiresAt,
      runId: runId.value,
    });
  }
  return blocked("INVALID_AUTHORIZATION_KIND");
}

function currentAuthorizationValid(
  authorization: ValidatedAuthorization,
  plan: OperatorMainnetTestPlan,
  providerNow: UtcTimestamp,
  localNow: UtcTimestamp,
  payloadHash?: PlanHash,
): Result<void> {
  if (authorization.kind === "approval") {
    const valid = validateOperatorMainnetTestApproval(
      authorization.approval,
      plan,
      authorization.approvalHash,
      providerNow,
    );
    return valid.ok ? ok(undefined) : fail(valid.error);
  }
  const valid = validateOperatorMainnetTradeCommandBinding(
    authorization.receipt,
    authorization.binding,
    localNow,
    payloadHash,
  );
  if (!valid.ok) return fail(valid.error);
  return valid.value.planHash === plan.contentHash
    ? ok(undefined)
    : blocked("TRADE_COMMAND_BINDING_MISMATCH");
}

function persistedAuthorizationMatches(
  snapshot: OperatorMainnetTestSnapshot,
  authorization: ValidatedAuthorization,
): boolean {
  if (authorization.kind === "approval")
    return (
      snapshot.authorization.kind === "approval" &&
      snapshot.authorization.hash === authorization.approvalHash &&
      snapshot.authorization.approval.contentHash ===
        authorization.approval.contentHash
    );
  return (
    snapshot.authorization.kind === "trade-command" &&
    snapshot.authorization.commandId === authorization.receipt.commandId &&
    snapshot.authorization.receiptHash === authorization.receipt.contentHash &&
    snapshot.authorization.hash === authorization.binding.contentHash &&
    snapshot.authorization.binding.contentHash ===
      authorization.binding.contentHash
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
  admissionQuoteAgeAtReadMs?: number,
): MainnetOperatorTestOutcome {
  return Object.freeze({
    kind: "recovery",
    sourceId,
    clientOrderId,
    ...(attemptOutcome === undefined ? {} : { attemptOutcome }),
    attemptJournaled,
    ...(admissionQuoteAgeAtReadMs === undefined
      ? {}
      : { admissionQuoteAgeAtReadMs }),
    reasonCode,
  });
}

/** One source-bound CREATE attempt. Durable intent is the no-resend boundary. */
export async function executeMainnetOperatorTest(
  input: MainnetOperatorTestInput,
  dependencies: MainnetOperatorTestDependencies,
): Promise<Result<MainnetOperatorTestOutcome>> {
  const localNow = parseUtcTimestamp(dependencies.localClock.now());
  if (!localNow.ok) return blocked("INVALID_AUTHORIZATION_OR_RUN_ID");
  const resolved = validateAuthorizationInput(
    input,
    localNow.value,
    dependencies.localActorIdentityHash,
  );
  if (!resolved.ok) return resolved;
  const authorization = resolved.value;
  const plan = authorization.plan;
  const runId = authorization.runId;
  if (
    !sameScope(dependencies.persistence.scope, {
      exchange: "bybit",
      environment: "mainnet",
      accountId: plan.accountIdentityHash,
      category: "linear",
      positionMode: "one-way",
    })
  )
    return blocked("PERSISTENCE_SCOPE_MISMATCH");
  const sourceId = deriveOperatorMainnetTestSourceId(plan.contentHash);
  if (!sourceId.ok) return sourceId;

  const existing = dependencies.journal.readOperatorMainnetTestSource(
    sourceId.value,
  );
  if (!existing.ok) return existing;
  if (existing.value)
    return ok(
      recovery(
        sourceId.value,
        plan.clientOrderId,
        "SOURCE_ALREADY_ADMITTED_NO_RESEND",
        existing.value.attempt?.outcome,
        existing.value.attempt !== undefined,
      ),
    );

  let recoveryGrant: OperatorMainnetRecoveryGrant | undefined;
  if (authorization.kind === "approval") {
    const found = dependencies.journal.findOperatorMainnetRecoveryGrant(
      plan.contentHash,
      localNow.value,
    );
    if (!found.ok) return found;
    recoveryGrant = found.value;
    if (
      plan.recoveryAttestationHash &&
      (!recoveryGrant ||
        recoveryGrant.resolution.kind !== "manual-attested" ||
        recoveryGrant.resolution.attestationHash !==
          plan.recoveryAttestationHash)
    )
      return blocked(
        "RECOVERY_AUTHORIZATION_REQUIRED",
        "manual recovery plans require an unexpired, exact-plan recovery grant",
      );
  } else if ("recoveryAttestationHash" in plan) {
    return blocked("DIRECT_COMMAND_CANNOT_AUTHORIZE_RECOVERY");
  } else {
    const command = dependencies.journal.readOperatorMainnetTradeCommand(
      authorization.receipt.commandId,
    );
    if (!command.ok) return command;
    if (
      !command.value ||
      command.value.receipt.contentHash !== authorization.receipt.contentHash ||
      command.value.binding?.contentHash !== authorization.binding.contentHash
    )
      return blocked("TRADE_COMMAND_AUTHORITY_NOT_PERSISTED");
    const preIntentLeverageProof = command.value.outcomes.map(
      ({ stage, code }) => `${stage}:${code}`,
    );
    const leveragePrecheckComplete =
      (preIntentLeverageProof.length === 1 &&
        preIntentLeverageProof[0] === "precheck:LEVERAGE_CONFIG_ALREADY_1X") ||
      (preIntentLeverageProof.length === 2 &&
        preIntentLeverageProof[0] === "precheck:LEVERAGE_CONFIG_ATTEMPTED" &&
        preIntentLeverageProof[1] === "precheck:LEVERAGE_CONFIG_VERIFIED");
    if (
      (command.value.outcomes.length > 0 && !leveragePrecheckComplete) ||
      command.value.consumption
    )
      return blocked("TRADE_COMMAND_ALREADY_ATTEMPTED_NO_RESEND");
  }

  const initial = haltIsClear(dependencies.persistence);
  if (!initial.ok) return initial;
  const pending = dependencies.journal.findPendingOperatorMainnetTestSource();
  if (!pending.ok) return pending;
  if (
    pending.value &&
    (recoveryGrant === undefined ||
      pending.value.sourceId !== recoveryGrant.sourceId)
  )
    return blocked("UNRESOLVED_SAME_ACCOUNT_SOURCE_EXISTS");

  let fresh: Awaited<ReturnType<MainnetOperatorTestEvidencePort["collect"]>>;
  try {
    fresh = await dependencies.evidence.collect(plan.symbol);
  } catch (error) {
    if (error instanceof OperatorEvidenceReadError)
      return blocked(
        error.reasonCode,
        "operator Mainnet admission evidence was not accepted",
        error.details,
      );
    return blocked("FRESH_MAINNET_EVIDENCE_UNAVAILABLE");
  }
  const evidence = validateMainnetOperatorTestEvidence(plan, fresh);
  if (!evidence.ok) return evidence;
  const evidenceTime =
    "manualTargetState" in fresh && fresh.manualTargetState
      ? fresh.manualTargetState.serverTime
      : "state" in fresh && fresh.state
        ? fresh.state.serverTime
        : undefined;
  const providerTime = parseUtcTimestamp(evidenceTime);
  if (!providerTime.ok) return blocked("PROVIDER_TIME_INVALID");
  let currentLocalTime: Result<UtcTimestamp>;
  try {
    currentLocalTime = parseUtcTimestamp(dependencies.localClock.now());
  } catch {
    return blocked("LOCAL_TIME_INVALID");
  }
  if (!currentLocalTime.ok) return blocked("LOCAL_TIME_INVALID");
  const create = createOperatorMainnetCreateRequest(plan);
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
  const currentAuthorization = currentAuthorizationValid(
    authorization,
    plan,
    providerTime.value,
    currentLocalTime.value,
    approvedPayloadHash.value as PlanHash,
  );
  if (!currentAuthorization.ok) return currentAuthorization;

  let evidenceMonotonic = Number.NaN;
  try {
    evidenceMonotonic = dependencies.monotonicClock();
  } catch {
    return blocked("MONOTONIC_CLOCK_INVALID");
  }
  if (!Number.isFinite(evidenceMonotonic))
    return blocked("MONOTONIC_CLOCK_INVALID");
  const binding: OperatorMainnetTestCreateAuthorizationBinding =
    authorization.kind === "approval"
      ? Object.freeze({
          kind: "approval",
          operation: "CREATE",
          environment: "mainnet",
          planHash: plan.contentHash,
          approvalHash: authorization.approvalHash,
          sourceId: sourceId.value,
          accountIdentityHash: plan.accountIdentityHash,
          symbol: plan.symbol,
          clientOrderId: plan.clientOrderId,
          exactPayloadHash: approvedPayloadHash.value as PlanHash,
          runId,
          expiresAt: authorization.expiresAt,
        })
      : Object.freeze({
          kind: "trade-command",
          operation: "CREATE",
          environment: "mainnet",
          planHash: plan.contentHash,
          commandId: authorization.receipt.commandId,
          receiptHash: authorization.receipt.contentHash,
          commandBindingHash: authorization.binding.contentHash,
          sourceId: sourceId.value,
          accountIdentityHash: plan.accountIdentityHash,
          symbol: plan.symbol,
          clientOrderId: plan.clientOrderId,
          exactPayloadHash: approvedPayloadHash.value as PlanHash,
          runId,
          expiresAt: authorization.expiresAt,
        });
  let capability: object | undefined;
  try {
    capability = await dependencies.authorization.issue(binding);
  } catch {
    return blocked("CREATE_AUTHORIZATION_UNAVAILABLE");
  }
  if (typeof capability !== "object" || capability === null)
    return blocked("CREATE_AUTHORIZATION_UNAVAILABLE");

  let tradeCommandAuthorizationAt: UtcTimestamp | undefined;
  if (authorization.kind === "trade-command") {
    let authorizationAt: Result<UtcTimestamp>;
    try {
      authorizationAt = parseUtcTimestamp(dependencies.localClock.now());
    } catch {
      return blocked("LOCAL_TIME_RECHECK_UNAVAILABLE");
    }
    if (!authorizationAt.ok) return blocked("LOCAL_TIME_RECHECK_UNAVAILABLE");
    tradeCommandAuthorizationAt = authorizationAt.value;
  }

  const prepared =
    authorization.kind === "approval"
      ? dependencies.journal.prepareCreateIntent({
          runId,
          plan,
          approval: authorization.approval,
          payloadJson: create.value.payloadJson,
          payloadHash: approvedPayloadHash.value as PlanHash,
          preparedAt: providerTime.value,
          ...(recoveryGrant === undefined
            ? {}
            : { recoveryGrantId: recoveryGrant.grantId }),
        })
      : dependencies.journal.prepareCreateIntent({
          runId,
          plan: plan as unknown as OperatorMainnetTradeCommandPlan,
          tradeCommand: {
            receipt: authorization.receipt,
            binding: authorization.binding,
            authorizationAt: tradeCommandAuthorizationAt!,
          },
          payloadJson: create.value.payloadJson,
          payloadHash: approvedPayloadHash.value as PlanHash,
          preparedAt: providerTime.value,
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
    return ok(
      recovery(
        sourceId.value,
        plan.clientOrderId,
        reasonCode,
        undefined,
        false,
        evidence.value.quoteAgeAtReadMs,
      ),
    );
  };

  const elapsed = elapsedNow();
  if (!elapsed.ok) return rejectAfterIntent("POST_INTENT_RECHECK_UNAVAILABLE");
  const currentProviderTime = effectiveProviderTime(
    providerTime.value,
    elapsed.value,
  );
  if (!currentProviderTime.ok)
    return rejectAfterIntent("PROVIDER_TIME_RECHECK_UNAVAILABLE");
  let currentLocalNow: Result<UtcTimestamp>;
  try {
    currentLocalNow = parseUtcTimestamp(dependencies.localClock.now());
  } catch {
    return rejectAfterIntent("LOCAL_TIME_RECHECK_UNAVAILABLE");
  }
  if (!currentLocalNow.ok)
    return rejectAfterIntent("LOCAL_TIME_RECHECK_UNAVAILABLE");
  const authorizationStillValid = currentAuthorizationValid(
    authorization,
    plan,
    currentProviderTime.value,
    currentLocalNow.value,
    approvedPayloadHash.value as PlanHash,
  );
  const freshEnough = revalidateMainnetOperatorEvidenceAge(
    plan,
    evidence.value,
    elapsed.value,
  );
  const payloadAgain = payloadFor(create.value.request);
  const halt = haltIsClear(dependencies.persistence);
  const persisted = dependencies.journal.readOperatorMainnetTestSource(
    sourceId.value,
  );
  if (
    !authorizationStillValid.ok ||
    !freshEnough.ok ||
    !payloadAgain.ok ||
    payloadAgain.value.json !== create.value.payloadJson ||
    payloadAgain.value.hash !== approvedPayloadHash.value ||
    !halt.ok ||
    !persisted.ok ||
    !persisted.value ||
    persisted.value.intent.operation !== "CREATE" ||
    persisted.value.intent.runId !== runId ||
    persisted.value.source.payloadHash !== approvedPayloadHash.value ||
    !persistedAuthorizationMatches(persisted.value, authorization)
  )
    return rejectAfterIntent("POST_INTENT_RECHECK_FAILED");

  if (
    !dependencies.authorization.consume(
      capability,
      binding,
      authorization.kind === "approval"
        ? currentProviderTime.value
        : currentLocalNow.value,
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
    plan.clientOrderId,
  );
  const elapsedAfterDispatch = elapsedNow();
  const attemptAt = effectiveProviderTime(
    providerTime.value,
    elapsedAfterDispatch.ok ? elapsedAfterDispatch.value : elapsed.value,
  );
  const recordedAt = attemptAt.ok ? attemptAt.value : providerTime.value;
  const attempt = dependencies.journal.recordAttempt({
    runId,
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
        plan.clientOrderId,
        "POST_OUTCOME_NOT_DURABLY_RECORDED_NO_RESEND",
        "ambiguous",
      ),
    );
  }
  return ok(
    Object.freeze({
      kind: "attempted",
      sourceId: sourceId.value,
      clientOrderId: plan.clientOrderId,
      attemptOutcome: classified.outcome,
      attemptJournaled: true,
      admissionQuoteAgeAtReadMs: evidence.value.quoteAgeAtReadMs,
      ...(classified.providerReasonCode === undefined
        ? {}
        : { reasonCode: classified.providerReasonCode }),
    }),
  );
}
