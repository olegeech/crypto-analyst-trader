import { randomUUID } from "node:crypto";

import {
  derivePreparedLegSourceIdentity,
  type PreparedLegSourceIdentity,
} from "../domain/execution/prepared-leg-execution.js";
import {
  createPreparedLegOrderProof,
  matchesPreparedLegOrder,
} from "../domain/execution/prepared-leg-order-proof.js";
import { hashCanonical } from "../domain/identity/canonical-serialization.js";
import type { PlanHash } from "../domain/identity/canonical-serialization.js";
import { domainError, type DomainErrorCode } from "../domain/shared/errors.js";
import { fail, type Result } from "../domain/shared/result.js";
import {
  parseUtcTimestamp,
  timestampToEpochMs,
  type UtcTimestamp,
} from "../domain/shared/time.js";
import { requireIdentifier } from "../domain/shared/validation.js";
import type { PreparedLegRunSnapshot } from "../ports/persistence.js";
import type { PreparedLegWriteAuthorizationBinding } from "../ports/prepared-leg-write-authorization.js";
import type {
  ExchangeFillObservation,
  ExchangeOperation,
  ExchangeOrderAcknowledgement,
  ExchangeOrderObservation,
  ExchangeResult,
  MainnetExchangeReadState,
} from "../ports/exchange-execution.js";
import {
  acquireOrReuseMainnetLease,
  reconcilePreparedLegSource,
  verifyCurrentAccountBinding,
  type MainnetPreparedLegDependencies,
  type MainnetPreparedLegOutcome,
} from "./mainnet-prepared-leg-boundary.js";

const ZERO_FILL_PROOF_MAX_AGE_MS = 60_000;

function blocked(code: string) {
  return fail(domainError("INVALID_CAPABILITY", code));
}

function failedRead<T>(operation: ExchangeOperation): ExchangeResult<T> {
  return {
    ok: false,
    error: {
      kind: "transport",
      message: "exchange read failed at the application boundary",
      retry: "reconcile",
      operation,
    },
  };
}

function authorizationAdmitted(
  dependencies: MainnetPreparedLegDependencies,
  capability: object,
  binding: PreparedLegWriteAuthorizationBinding,
): boolean {
  try {
    return dependencies.authorization.isAdmitted(capability, binding);
  } catch {
    return false;
  }
}

function haltAfterCancelIntent(
  dependencies: MainnetPreparedLegDependencies,
  authority: { readonly ownerRunId: string; readonly epoch: number },
  at: UtcTimestamp,
  code: DomainErrorCode,
  reasonCode: string,
): Result<never> {
  dependencies.persistence.raiseHalt(
    authority,
    "prepared-leg cancel stopped after durable intent: " + reasonCode,
    at,
  );
  return fail(
    domainError(code, "cancel dispatch was stopped after durable intent"),
  );
}

function matchesMainnetLinearState(
  state: MainnetExchangeReadState,
  symbol: string,
): boolean {
  return (
    state.market.instrument === symbol &&
    state.market.scope.exchange === "bybit" &&
    state.market.scope.environment === "mainnet" &&
    state.market.scope.category === "linear" &&
    state.market.scope.positionMode === "one-way" &&
    state.position.instrument === symbol &&
    parseUtcTimestamp(state.serverTime).ok
  );
}

function identityForSource(
  dependencies: MainnetPreparedLegDependencies,
  source: PreparedLegRunSnapshot,
) {
  const prepared = dependencies.artifacts.loadPrepared(
    source.lineage.preparedHash,
  );
  if (!prepared.ok) return prepared;
  if (!prepared.value)
    return fail(
      domainError(
        "PERSISTENCE_INTEGRITY",
        "source-bound prepared artifact is unavailable",
      ),
    );
  const identity = derivePreparedLegSourceIdentity({
    prepared: prepared.value,
    preparedHash: source.lineage.preparedHash,
    legId: source.lineage.legId,
    accountIdentityHash: dependencies.persistence.scope.accountId,
  });
  if (!identity.ok) return identity;
  if (
    identity.value.preparedHash !== source.lineage.preparedHash ||
    identity.value.clientOrderId !== source.lineage.clientOrderId
  )
    return fail(
      domainError(
        "PERSISTENCE_INTEGRITY",
        "prepared identity conflicts with durable source",
      ),
    );
  return identity;
}

function cancelBinding(
  execution: PreparedLegSourceIdentity,
  sourceId: string,
  ownerRunId: string,
  epoch: number,
  exchangeOrderId: string,
  proofHash: PlanHash,
  observedAt: UtcTimestamp,
): PreparedLegWriteAuthorizationBinding {
  return Object.freeze({
    operation: "cancel",
    environment: "mainnet",
    accountIdentityHash: execution.accountIdentityHash,
    preparedHash: execution.preparedHash,
    sourceId,
    symbol: execution.leg.intent.instrument,
    legId: execution.leg.legId,
    leaseOwnerRunId: ownerRunId,
    leaseEpoch: epoch,
    clientOrderId: execution.clientOrderId,
    exchangeOrderId,
    zeroFillProofHash: proofHash,
    proofObservedAt: observedAt,
  });
}

/** One separately authorized cancellation of the exact owned, proven-unfilled order. */
export async function cancelMainnetPreparedLeg(
  input: unknown,
  dependencies: MainnetPreparedLegDependencies,
): Promise<Result<MainnetPreparedLegOutcome>> {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    Reflect.ownKeys(input).length !== 2 ||
    !Object.hasOwn(input, "sourceId") ||
    !Object.hasOwn(input, "runId")
  )
    return fail(
      domainError("INVALID_ARGUMENT", "cancel requires sourceId and runId"),
    );
  const sourceId = requireIdentifier(
    (input as { sourceId?: unknown }).sourceId,
    "sourceId",
  );
  const runId = requireIdentifier(
    (input as { runId?: unknown }).runId,
    "runId",
  );
  if (!sourceId.ok || !runId.ok)
    return fail(domainError("INVALID_ARGUMENT", "cancel identity is invalid"));

  const localNow = parseUtcTimestamp(dependencies.localClock.now());
  if (!localNow.ok) return localNow;
  const lease = acquireOrReuseMainnetLease(
    dependencies.persistence,
    runId.value,
    localNow.value,
  );
  if (!lease.ok) return lease;
  const source = dependencies.preparedLegs.readPreparedLegSource(
    sourceId.value,
  );
  if (!source.ok) return source;
  if (!source.value)
    return fail(
      domainError("OWNERSHIP_MISMATCH", "prepared-leg source does not exist"),
    );
  if (source.value.cancelIntent) {
    const execution = identityForSource(dependencies, source.value);
    if (!execution.ok) return execution;
    const accountBinding = await verifyCurrentAccountBinding(
      dependencies,
      execution.value,
    );
    if (!accountBinding.ok) return accountBinding;
    return reconcilePreparedLegSource(
      dependencies,
      execution.value,
      sourceId.value,
      lease.value,
      "recovery",
      {
        ...(source.value.cancelIntent.exchangeOrderId === undefined
          ? {}
          : { expectedOrderId: source.value.cancelIntent.exchangeOrderId }),
        cancelPending: true,
      },
    );
  }
  if (lease.value.reconciliationRequired)
    return fail(
      domainError("UNRESOLVED_STATE", "lease takeover is reconciliation-only"),
    );
  if (source.value.reconciliations.at(-1)?.status !== "CONFIRMED_OPEN")
    return fail(
      domainError(
        "UNRESOLVED_STATE",
        "cancel requires the exact source to be confirmed open",
      ),
    );

  const execution = identityForSource(dependencies, source.value);
  if (!execution.ok) return execution;
  const accountBinding = await verifyCurrentAccountBinding(
    dependencies,
    execution.value,
  );
  if (!accountBinding.ok) return accountBinding;
  const orderId = source.value.reconciliations.at(-1)?.exchangeOrderId;
  if (!orderId)
    return fail(
      domainError(
        "OWNERSHIP_MISMATCH",
        "confirmed source has no exchange order identity",
      ),
    );

  const monotonicStart = dependencies.monotonicClock();
  if (!Number.isFinite(monotonicStart))
    return blocked("MONOTONIC_CLOCK_INVALID");
  let stateBefore: ExchangeResult<MainnetExchangeReadState>;
  try {
    stateBefore = await dependencies.exchange.readState({
      instrument: execution.value.leg.intent.instrument,
    });
  } catch {
    stateBefore = failedRead("read");
  }
  if (
    !stateBefore.ok ||
    !matchesMainnetLinearState(
      stateBefore.value,
      execution.value.leg.intent.instrument,
    )
  )
    return fail(
      domainError(
        "UNRESOLVED_RECONCILIATION",
        "fresh Mainnet order state is unavailable",
      ),
    );
  const lookup = {
    instrument: execution.value.leg.intent.instrument,
    clientOrderId: execution.value.clientOrderId,
    exchangeOrderId: orderId,
  };
  let observed: ExchangeResult<ExchangeOrderObservation>;
  try {
    observed = await dependencies.exchange.observeOrder(lookup);
  } catch {
    observed = failedRead("observe");
  }
  if (!observed.ok)
    return fail(
      domainError(
        "UNRESOLVED_RECONCILIATION",
        "exact owned order could not be freshly confirmed",
      ),
    );
  const proof = createPreparedLegOrderProof(observed.value);
  if (
    !proof.ok ||
    !matchesPreparedLegOrder(proof.value, execution.value) ||
    proof.value.exchangeOrderId !== orderId ||
    proof.value.status !== "open" ||
    !proof.value.filledQuantity.isZero() ||
    timestampToEpochMs(proof.value.observedAt) <
      timestampToEpochMs(source.value.reconciliations.at(-1)!.observedAt)
  )
    return fail(
      domainError(
        "OWNERSHIP_MISMATCH",
        "fresh exact zero-fill proof is required",
      ),
    );

  let fills: ExchangeResult<readonly ExchangeFillObservation[]>;
  try {
    fills = await dependencies.exchange.listFills(lookup);
  } catch {
    fills = failedRead("fills");
  }
  if (!fills.ok || fills.value.length !== 0)
    return fail(
      domainError(
        "OWNERSHIP_MISMATCH",
        "cancel requires an exact empty execution history",
      ),
    );
  let stateAfter: ExchangeResult<MainnetExchangeReadState>;
  try {
    stateAfter = await dependencies.exchange.readState({
      instrument: execution.value.leg.intent.instrument,
    });
  } catch {
    stateAfter = failedRead("read");
  }
  if (
    !stateAfter.ok ||
    !matchesMainnetLinearState(
      stateAfter.value,
      execution.value.leg.intent.instrument,
    )
  )
    return fail(
      domainError(
        "UNRESOLVED_RECONCILIATION",
        "provider-time confirmation before cancel is unavailable",
      ),
    );
  const proofAgeMs =
    timestampToEpochMs(stateAfter.value.serverTime) -
    timestampToEpochMs(proof.value.observedAt);
  const monotonicAgeMs = dependencies.monotonicClock() - monotonicStart;
  if (
    !Number.isFinite(monotonicAgeMs) ||
    proofAgeMs < 0 ||
    proofAgeMs > ZERO_FILL_PROOF_MAX_AGE_MS ||
    monotonicAgeMs < 0 ||
    monotonicAgeMs > ZERO_FILL_PROOF_MAX_AGE_MS
  )
    return blocked("ZERO_FILL_PROOF_STALE");

  const proofHash = hashCanonical({ order: proof.value, fills: [] });
  if (!proofHash.ok) return proofHash;
  const binding: PreparedLegWriteAuthorizationBinding = cancelBinding(
    execution.value,
    sourceId.value,
    lease.value.ownerRunId,
    lease.value.epoch,
    orderId,
    proofHash.value,
    proof.value.observedAt,
  );
  let capability;
  try {
    capability = await dependencies.authorization.authorize(binding);
  } catch {
    return blocked("CANCEL_AUTHORIZATION_DENIED");
  }
  if (!capability || !authorizationAdmitted(dependencies, capability, binding))
    return blocked("CANCEL_AUTHORIZATION_NOT_ADMITTED");

  const cancelIntent = dependencies.preparedLegs.preparePreparedLegCancel({
    authority: lease.value,
    sourceId: sourceId.value,
    runId: runId.value,
    proof: proof.value,
    preparedAt: stateAfter.value.serverTime,
  });
  if (!cancelIntent.ok) return cancelIntent;
  if (
    !cancelIntent.value.created ||
    cancelIntent.value.snapshot.cancelIntent?.exchangeOrderId !== orderId
  )
    return reconcilePreparedLegSource(
      dependencies,
      execution.value,
      sourceId.value,
      lease.value,
      "recovery",
      {
        expectedOrderId: orderId,
        cancelPending: true,
      },
    );

  const current = dependencies.persistence.readScopeSnapshot();
  const finalLocalTime = parseUtcTimestamp(dependencies.localClock.now());
  if (!current.ok || !finalLocalTime.ok)
    return haltAfterCancelIntent(
      dependencies,
      lease.value,
      stateAfter.value.serverTime,
      "RUN_LEASE_LOST",
      "FINAL_REVALIDATION_FAILED",
    );
  const finalMonotonicAgeMs = dependencies.monotonicClock() - monotonicStart;
  const finalProofAgeMs = proofAgeMs + finalMonotonicAgeMs;
  if (
    current.value.lease?.ownerRunId !== lease.value.ownerRunId ||
    current.value.lease.epoch !== lease.value.epoch ||
    current.value.lease.reconciliationRequired ||
    timestampToEpochMs(finalLocalTime.value) >=
      timestampToEpochMs(current.value.lease.expiresAt) ||
    !Number.isFinite(finalMonotonicAgeMs) ||
    finalProofAgeMs < 0 ||
    finalProofAgeMs > ZERO_FILL_PROOF_MAX_AGE_MS ||
    !authorizationAdmitted(dependencies, capability, binding)
  )
    return haltAfterCancelIntent(
      dependencies,
      lease.value,
      finalLocalTime.value,
      "RUN_LEASE_LOST",
      "LEASE_AUTHORIZATION_OR_ZERO_FILL_PROOF_CHANGED",
    );

  let acknowledgement: ExchangeResult<ExchangeOrderAcknowledgement>;
  try {
    acknowledgement = await dependencies.exchange.cancelOrder(lookup);
  } catch {
    acknowledgement = {
      ok: false as const,
      error: {
        kind: "ambiguous" as const,
        message: "cancel write outcome is unknown",
        retry: "reconcile" as const,
        operation: "cancel" as const,
      },
    };
  }
  const parsedAttemptAt = parseUtcTimestamp(dependencies.localClock.now());
  const attemptAt = parsedAttemptAt.ok
    ? parsedAttemptAt.value
    : finalLocalTime.value;
  const attempt = dependencies.preparedLegs.appendPreparedLegAttempt({
    authority: lease.value,
    sourceId: sourceId.value,
    operation: "cancel",
    attemptId: randomUUID(),
    result: !parsedAttemptAt.ok
      ? {
          outcome: "ambiguous",
          providerReasonCode: "ATTEMPT_TIMESTAMP_UNAVAILABLE",
        }
      : acknowledgement.ok
        ? acknowledgement.value.clientOrderId ===
            execution.value.clientOrderId &&
          (acknowledgement.value.exchangeOrderId === undefined ||
            acknowledgement.value.exchangeOrderId === orderId)
          ? { outcome: "accepted", exchangeOrderId: orderId }
          : {
              outcome: "ambiguous",
              providerReasonCode: "CANCEL_ACK_IDENTITY_MISMATCH",
            }
        : {
            outcome: "ambiguous",
            providerReasonCode: acknowledgement.error.kind.toUpperCase(),
          },
    recordedAt: attemptAt,
  });
  if (!attempt.ok) {
    dependencies.persistence.raiseHalt(
      lease.value,
      "prepared-leg cancel acknowledgement could not be journaled",
      finalLocalTime.value,
    );
    return attempt;
  }
  return reconcilePreparedLegSource(
    dependencies,
    execution.value,
    sourceId.value,
    lease.value,
    "recovery",
    {
      expectedOrderId: orderId,
      cancelPending: true,
      ...(acknowledgement.ok &&
      acknowledgement.value.clientOrderId !== execution.value.clientOrderId
        ? { forceUnresolvedReason: "CANCEL_ACK_IDENTITY_MISMATCH" }
        : {}),
      ...(!parsedAttemptAt.ok
        ? { forceUnresolvedReason: "ATTEMPT_TIMESTAMP_UNAVAILABLE" }
        : {}),
    },
  );
}
