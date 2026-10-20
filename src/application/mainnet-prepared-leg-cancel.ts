import { randomUUID } from "node:crypto";

import {
  derivePreparedLegSourceIdentity,
  type PreparedLegSourceIdentity,
} from "../domain/execution/prepared-leg-execution.js";
import {
  createPreparedLegOrderProof,
  derivePreparedLegProtectionCoverage,
  matchesPreparedLegOrder,
  matchesPreparedLegTakeProfitChild,
  type PreparedLegOrderProof,
} from "../domain/execution/prepared-leg-order-proof.js";
import { hashCanonical } from "../domain/identity/canonical-serialization.js";
import type { PlanHash } from "../domain/identity/canonical-serialization.js";
import { DecimalValue } from "../domain/shared/decimal.js";
import { domainError, type DomainErrorCode } from "../domain/shared/errors.js";
import { fail, ok, type Result } from "../domain/shared/result.js";
import {
  parseUtcTimestamp,
  timestampToEpochMs,
  type UtcTimestamp,
} from "../domain/shared/time.js";
import { requireIdentifier } from "../domain/shared/validation.js";
import type {
  PreparedLegRemainderCancelProof,
  PreparedLegRunSnapshot,
} from "../ports/persistence.js";
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

function cancelRecoveryBlockReason(
  source: PreparedLegRunSnapshot,
): string | undefined {
  const attempt = source.cancelAttempt;
  if (!attempt) return "CANCEL_ATTEMPT_NOT_DURABLE";
  let raw: unknown;
  try {
    raw = JSON.parse(attempt.canonicalJson) as unknown;
  } catch {
    return "CANCEL_ATTEMPT_INVALID";
  }
  if (
    typeof raw !== "object" ||
    raw === null ||
    Array.isArray(raw) ||
    typeof (raw as Record<string, unknown>).result !== "object" ||
    (raw as Record<string, unknown>).result === null
  )
    return "CANCEL_ATTEMPT_INVALID";
  const outcome = (
    (raw as Record<string, unknown>).result as Record<string, unknown>
  ).outcome;
  return outcome === "accepted" ? undefined : "CANCEL_ATTEMPT_AMBIGUOUS";
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

function remainderCancelBinding(
  execution: PreparedLegSourceIdentity,
  ownerRunId: string,
  proof: PreparedLegRemainderCancelProof,
): PreparedLegWriteAuthorizationBinding {
  return Object.freeze({
    operation: "cancel",
    environment: "mainnet",
    accountIdentityHash: execution.accountIdentityHash,
    preparedHash: execution.preparedHash,
    sourceId: proof.sourceId,
    symbol: execution.leg.intent.instrument,
    legId: execution.leg.legId,
    leaseOwnerRunId: ownerRunId,
    leaseEpoch: proof.leaseEpoch,
    clientOrderId: proof.clientOrderId,
    exchangeOrderId: proof.parentExchangeOrderId,
    remainderCancelProofHash: proof.remainderCancelProofHash,
    approvedCancelPlanHash: proof.approvedCancelPlanHash,
    protectionEvidenceHash: proof.protectionEvidenceHash,
    coverageHash: proof.coverageHash,
    filledQuantity: proof.filledQuantity,
    unfilledRemainder: proof.unfilledRemainder,
    proofObservedAt: proof.observedAt,
  });
}

function entryFillsMatchParent(
  fills: readonly ExchangeFillObservation[],
  execution: PreparedLegSourceIdentity,
  proof: PreparedLegOrderProof,
): boolean {
  const ids = new Set<string>();
  const zero = DecimalValue.fromString("0");
  if (!zero.ok) return false;
  let total = zero.value;
  for (const fill of fills) {
    if (
      ids.has(fill.executionId) ||
      fill.exchangeOrderId !== proof.exchangeOrderId ||
      fill.clientOrderId !== execution.clientOrderId ||
      fill.instrument !== execution.leg.intent.instrument ||
      fill.side !== "buy" ||
      !fill.quantity.isPositive() ||
      !fill.price.isPositive()
    )
      return false;
    ids.add(fill.executionId);
    total = total.add(fill.quantity);
  }
  return total.compare(proof.filledQuantity) === 0;
}

function sameActiveProtectionReads(
  state: MainnetExchangeReadState,
  execution: PreparedLegSourceIdentity,
  providerChildren: readonly ExchangeOrderObservation[],
): boolean {
  const active = (order: ExchangeOrderObservation) =>
    order.status === "open" || order.status === "partially-filled";
  const expected = providerChildren.filter(active);
  const observed = state.openOrders.filter(
    (order) => order.parentOrderLinkId === execution.clientOrderId,
  );
  if (
    new Set(expected.map((child) => child.exchangeOrderId)).size !==
      expected.length ||
    new Set(observed.map((child) => child.exchangeOrderId)).size !==
      observed.length ||
    expected.length !== observed.length
  )
    return false;
  return observed.every((child) => {
    const providerChild = expected.find(
      (candidate) => candidate.exchangeOrderId === child.exchangeOrderId,
    );
    return (
      providerChild !== undefined &&
      matchesPreparedLegTakeProfitChild(child, execution) &&
      child.clientOrderId === providerChild.clientOrderId &&
      child.providerOrderLinkId === providerChild.providerOrderLinkId &&
      child.parentOrderLinkId === providerChild.parentOrderLinkId &&
      child.side === providerChild.side &&
      child.requestedQuantity.compare(providerChild.requestedQuantity) === 0 &&
      child.filledQuantity.compare(providerChild.filledQuantity) === 0 &&
      child.status === providerChild.status &&
      child.orderType === providerChild.orderType &&
      child.triggerPrice?.compare(providerChild.triggerPrice!) === 0 &&
      child.providerStopOrderType === providerChild.providerStopOrderType &&
      child.providerTpslMode === providerChild.providerTpslMode &&
      child.triggerBy === providerChild.triggerBy &&
      child.takeProfitTriggerBy === providerChild.takeProfitTriggerBy &&
      child.reduceOnly === providerChild.reduceOnly &&
      child.positionIdx === providerChild.positionIdx
    );
  });
}

async function readRemainderCancelProof(
  dependencies: MainnetPreparedLegDependencies,
  execution: PreparedLegSourceIdentity,
  sourceId: string,
  authority: { readonly ownerRunId: string; readonly epoch: number },
  parent: PreparedLegOrderProof,
  latestProtectionHash: PlanHash,
): Promise<
  Result<{
    readonly proof: PreparedLegRemainderCancelProof;
    readonly state: MainnetExchangeReadState;
  }>
> {
  const parentLookup = {
    instrument: execution.leg.intent.instrument,
    clientOrderId: execution.clientOrderId,
    exchangeOrderId: parent.exchangeOrderId,
  };
  let entryResult: ExchangeResult<readonly ExchangeFillObservation[]>;
  try {
    entryResult = await dependencies.exchange.listFills(parentLookup);
  } catch {
    entryResult = failedRead("fills");
  }
  if (
    !entryResult.ok ||
    !entryFillsMatchParent(entryResult.value, execution, parent)
  )
    return fail(
      domainError(
        "UNRESOLVED_RECONCILIATION",
        "exact partial entry fills are unavailable",
      ),
    );

  let childrenResult: ExchangeResult<readonly ExchangeOrderObservation[]>;
  try {
    childrenResult = await dependencies.exchange.listAttachedProtection({
      instrument: execution.leg.intent.instrument,
      parentClientOrderId: execution.clientOrderId,
    });
  } catch {
    childrenResult = failedRead("observe");
  }
  if (!childrenResult.ok)
    return fail(
      domainError(
        "UNRESOLVED_RECONCILIATION",
        "attached TP evidence is unavailable",
      ),
    );

  const exits: ExchangeFillObservation[] = [];
  for (const child of childrenResult.value) {
    let result: ExchangeResult<readonly ExchangeFillObservation[]>;
    try {
      result = await dependencies.exchange.listFills({
        instrument: execution.leg.intent.instrument,
        clientOrderId: child.providerOrderLinkId ?? child.clientOrderId,
        exchangeOrderId: child.exchangeOrderId,
      });
    } catch {
      result = failedRead("fills");
    }
    if (!result.ok)
      return fail(
        domainError(
          "UNRESOLVED_RECONCILIATION",
          "attached TP fills are unavailable",
        ),
      );
    exits.push(...result.value);
  }

  let stateResult: ExchangeResult<MainnetExchangeReadState>;
  try {
    stateResult = await dependencies.exchange.readState({
      instrument: execution.leg.intent.instrument,
    });
  } catch {
    stateResult = failedRead("read");
  }
  if (
    !stateResult.ok ||
    !matchesMainnetLinearState(
      stateResult.value,
      execution.leg.intent.instrument,
    )
  )
    return fail(
      domainError(
        "UNRESOLVED_RECONCILIATION",
        "fresh one-way position is unavailable",
      ),
    );
  const state = stateResult.value;
  const coverage = derivePreparedLegProtectionCoverage({
    execution,
    parent,
    entryFills: entryResult.value,
    exitFills: exits,
    children: childrenResult.value,
    observedAt: state.serverTime,
    maxAgeMs: ZERO_FILL_PROOF_MAX_AGE_MS,
  });
  if (!coverage.ok || !coverage.value.covered)
    return fail(
      domainError(
        "UNRESOLVED_RECONCILIATION",
        "fresh partial TP coverage is not exact",
      ),
    );
  if (!coverage.value.outstandingQuantity.isPositive())
    return fail(
      domainError(
        "OWNERSHIP_MISMATCH",
        "partial cancel requires a live protected position",
      ),
    );
  const one = DecimalValue.fromString("1");
  if (!one.ok) return one;
  const currentParent = state.openOrders.filter(
    (order) =>
      order.clientOrderId === execution.clientOrderId &&
      order.parentOrderLinkId !== execution.clientOrderId &&
      order.protectionType !== "take-profit",
  );
  const stateChildren = state.openOrders.filter(
    (order) =>
      order.parentOrderLinkId === execution.clientOrderId ||
      order.protectionType === "take-profit",
  );
  const currentParentProof =
    currentParent.length === 1
      ? createPreparedLegOrderProof(currentParent[0])
      : undefined;
  if (
    state.leverage.buy.compare(one.value) !== 0 ||
    state.leverage.sell.compare(one.value) !== 0 ||
    state.leverage.effective.compare(one.value) !== 0 ||
    state.position.side !== "long" ||
    state.position.quantity.compare(coverage.value.outstandingQuantity) !== 0 ||
    currentParent.length !== 1 ||
    !currentParentProof?.ok ||
    !matchesPreparedLegOrder(currentParentProof.value, execution) ||
    currentParent[0]?.exchangeOrderId !== parent.exchangeOrderId ||
    currentParent[0]?.status !== "partially-filled" ||
    currentParentProof?.value.filledQuantity.compare(parent.filledQuantity) !==
      0 ||
    new Set(stateChildren.map((child) => child.exchangeOrderId)).size !==
      stateChildren.length ||
    !sameActiveProtectionReads(state, execution, childrenResult.value) ||
    state.openOrders.some(
      (order) =>
        order.exchangeOrderId !== parent.exchangeOrderId &&
        !childrenResult.value.some(
          (child) =>
            child.exchangeOrderId === order.exchangeOrderId &&
            matchesPreparedLegTakeProfitChild(order, execution),
        ),
    )
  )
    return fail(
      domainError(
        "OWNERSHIP_MISMATCH",
        "fresh parent, position, or TP ownership conflicts",
      ),
    );
  const remainder = parent.requestedQuantity.subtract(parent.filledQuantity);
  if (!remainder.isPositive())
    return fail(
      domainError("OWNERSHIP_MISMATCH", "parent remainder is already filled"),
    );
  const coverageHash = hashCanonical({
    schemaVersion: "prepared-leg-remainder-cancel-coverage/v1",
    coverage: coverage.value,
    entries: entryResult.value.map((fill) => ({
      executionId: fill.executionId,
      exchangeOrderId: fill.exchangeOrderId,
      clientOrderId: fill.clientOrderId,
      quantity: fill.quantity,
      price: fill.price,
      executedAt: fill.executedAt,
    })),
    exits: exits.map((fill) => ({
      executionId: fill.executionId,
      exchangeOrderId: fill.exchangeOrderId,
      clientOrderId: fill.clientOrderId,
      quantity: fill.quantity,
      price: fill.price,
      executedAt: fill.executedAt,
    })),
    children: childrenResult.value,
    position: state.position,
  });
  if (!coverageHash.ok) return coverageHash;
  const cancelPlan = {
    schemaVersion: "prepared-leg-approved-remainder-cancel-plan/v1",
    sourceId,
    leaseEpoch: authority.epoch,
    parentExchangeOrderId: parent.exchangeOrderId,
    clientOrderId: parent.clientOrderId,
    requestedQuantity: parent.requestedQuantity.toString(),
    filledQuantity: parent.filledQuantity.toString(),
    unfilledRemainder: remainder.toString(),
    outstandingQuantity: coverage.value.outstandingQuantity.toString(),
    protectionEvidenceHash: latestProtectionHash,
    coverageHash: coverageHash.value,
  };
  const approvedCancelPlanHash = hashCanonical(cancelPlan);
  if (!approvedCancelPlanHash.ok) return approvedCancelPlanHash;
  const body = {
    schemaVersion: "prepared-leg-remainder-cancel-proof/v1" as const,
    sourceId,
    leaseEpoch: authority.epoch,
    parentExchangeOrderId: parent.exchangeOrderId,
    clientOrderId: parent.clientOrderId,
    requestedQuantity: parent.requestedQuantity.toString(),
    filledQuantity: parent.filledQuantity.toString(),
    unfilledRemainder: remainder.toString(),
    outstandingQuantity: coverage.value.outstandingQuantity.toString(),
    entryExecutionIds: coverage.value.entryExecutionIds,
    exitExecutionIds: coverage.value.exitExecutionIds,
    protectionEvidenceHash: latestProtectionHash,
    coverageHash: coverageHash.value,
    approvedCancelPlanHash: approvedCancelPlanHash.value,
    observedAt: state.serverTime,
  };
  const remainderCancelProofHash = hashCanonical(body);
  if (!remainderCancelProofHash.ok) return remainderCancelProofHash;
  return ok({
    proof: {
      ...body,
      remainderCancelProofHash: remainderCancelProofHash.value,
    },
    state,
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
    const recoveryBlockReason = cancelRecoveryBlockReason(source.value);
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
        ...(recoveryBlockReason === undefined
          ? {}
          : { forceUnresolvedReason: recoveryBlockReason }),
      },
    );
  }
  if (lease.value.reconciliationRequired)
    return fail(
      domainError("UNRESOLVED_STATE", "lease takeover is reconciliation-only"),
    );
  const latest = source.value.reconciliations.at(-1);
  const remainderMode =
    latest?.status === "PROTECTION_CONFIRMED" &&
    latest.protectionEvidence !== undefined &&
    latest.protectionCanonicalHash !== undefined;
  if (latest?.status !== "CONFIRMED_OPEN" && !remainderMode)
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
  if (!proof.ok)
    return fail(
      domainError(
        "OWNERSHIP_MISMATCH",
        "fresh exact parent order proof is required",
      ),
    );
  if (
    !matchesPreparedLegOrder(proof.value, execution.value) ||
    proof.value.exchangeOrderId !== orderId ||
    timestampToEpochMs(proof.value.observedAt) <
      timestampToEpochMs(latest!.observedAt)
  )
    return fail(
      domainError(
        "OWNERSHIP_MISMATCH",
        "fresh exact parent order proof is required",
      ),
    );

  let stateAfter: MainnetExchangeReadState;
  let proofObservedAt: UtcTimestamp;
  let proofAgeMs: number;
  let binding: PreparedLegWriteAuthorizationBinding;
  let remainderCancelProof: PreparedLegRemainderCancelProof | undefined;
  if (remainderMode) {
    if (
      proof.value.status === "filled" ||
      proof.value.filledQuantity.compare(proof.value.requestedQuantity) === 0
    )
      return reconcilePreparedLegSource(
        dependencies,
        execution.value,
        sourceId.value,
        lease.value,
        "recovery",
        { expectedOrderId: orderId },
      );
    if (
      proof.value.status !== "partially-filled" ||
      !proof.value.filledQuantity.isPositive() ||
      proof.value.filledQuantity.compare(proof.value.requestedQuantity) >= 0
    )
      return fail(
        domainError(
          "OWNERSHIP_MISMATCH",
          "partial remainder cancel requires a live partially-filled parent",
        ),
      );
    const latestProtectionHash = latest.protectionCanonicalHash;
    const fresh = await readRemainderCancelProof(
      dependencies,
      execution.value,
      sourceId.value,
      lease.value,
      proof.value,
      latestProtectionHash,
    );
    if (!fresh.ok)
      return reconcilePreparedLegSource(
        dependencies,
        execution.value,
        sourceId.value,
        lease.value,
        "recovery",
        { expectedOrderId: orderId },
      );
    stateAfter = fresh.value.state;
    remainderCancelProof = fresh.value.proof;
    proofObservedAt = remainderCancelProof.observedAt;
    proofAgeMs =
      timestampToEpochMs(stateAfter.serverTime) -
      timestampToEpochMs(proofObservedAt);
    binding = remainderCancelBinding(
      execution.value,
      lease.value.ownerRunId,
      remainderCancelProof,
    );
  } else {
    if (proof.value.status !== "open" || !proof.value.filledQuantity.isZero())
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
    let freshState: ExchangeResult<MainnetExchangeReadState>;
    try {
      freshState = await dependencies.exchange.readState({
        instrument: execution.value.leg.intent.instrument,
      });
    } catch {
      freshState = failedRead("read");
    }
    if (
      !freshState.ok ||
      !matchesMainnetLinearState(
        freshState.value,
        execution.value.leg.intent.instrument,
      )
    )
      return fail(
        domainError(
          "UNRESOLVED_RECONCILIATION",
          "provider-time confirmation before cancel is unavailable",
        ),
      );
    stateAfter = freshState.value;
    proofObservedAt = proof.value.observedAt;
    proofAgeMs =
      timestampToEpochMs(stateAfter.serverTime) -
      timestampToEpochMs(proofObservedAt);
    const proofHash = hashCanonical({ order: proof.value, fills: [] });
    if (!proofHash.ok) return proofHash;
    binding = cancelBinding(
      execution.value,
      sourceId.value,
      lease.value.ownerRunId,
      lease.value.epoch,
      orderId,
      proofHash.value,
      proof.value.observedAt,
    );
  }
  const monotonicAgeMs = dependencies.monotonicClock() - monotonicStart;
  if (
    !Number.isFinite(monotonicAgeMs) ||
    proofAgeMs < 0 ||
    proofAgeMs > ZERO_FILL_PROOF_MAX_AGE_MS ||
    monotonicAgeMs < 0 ||
    monotonicAgeMs > ZERO_FILL_PROOF_MAX_AGE_MS
  )
    return blocked("ZERO_FILL_PROOF_STALE");

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
    ...(remainderCancelProof === undefined ? {} : { remainderCancelProof }),
    preparedAt: stateAfter.serverTime,
  });
  if (!cancelIntent.ok) return cancelIntent;
  if (
    !cancelIntent.value.created ||
    cancelIntent.value.snapshot.cancelIntent?.exchangeOrderId !== orderId ||
    cancelIntent.value.snapshot.cancelIntent?.remainderCancelProof
      ?.remainderCancelProofHash !==
      remainderCancelProof?.remainderCancelProofHash
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
      stateAfter.serverTime,
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
      "LEASE_AUTHORIZATION_OR_CANCEL_PROOF_CHANGED",
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
      ...(!acknowledgement.ok
        ? { forceUnresolvedReason: "CANCEL_ACK_AMBIGUOUS" }
        : acknowledgement.value.clientOrderId !==
              execution.value.clientOrderId ||
            (acknowledgement.value.exchangeOrderId !== undefined &&
              acknowledgement.value.exchangeOrderId !== orderId)
          ? { forceUnresolvedReason: "CANCEL_ACK_IDENTITY_MISMATCH" }
          : {}),
      ...(!parsedAttemptAt.ok
        ? { forceUnresolvedReason: "ATTEMPT_TIMESTAMP_UNAVAILABLE" }
        : {}),
    },
  );
}
