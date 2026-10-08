import { randomUUID } from "node:crypto";

import {
  requireTrustedCapability,
  type CapabilityRequirement,
} from "../domain/capabilities/capability.js";
import {
  derivePreparedLegExecutionIdentity,
  derivePreparedLegSourceIdentity,
  createPreparedLegExecution,
  derivePreparedLegSourceId,
  type PreparedLegExecution,
  type PreparedLegSourceIdentity,
} from "../domain/execution/prepared-leg-execution.js";
import {
  createPreparedLegOrderProof,
  matchesPreparedLegOrder,
} from "../domain/execution/prepared-leg-order-proof.js";
import type { PreparedLegOrderProof } from "../domain/execution/prepared-leg-order-proof.js";
import { domainError, type DomainErrorCode } from "../domain/shared/errors.js";
import { normalizeOrderIntent } from "../domain/planning/normalize-order-intent.js";
import { fail, ok, type Result } from "../domain/shared/result.js";
import {
  parseUtcTimestamp,
  timestampToEpochMs,
  type Clock,
  type UtcTimestamp,
} from "../domain/shared/time.js";
import { requireHash, requireIdentifier } from "../domain/shared/validation.js";
import { DecimalValue } from "../domain/shared/decimal.js";
import { PROVISIONAL_M1_MAX_ACCOUNT_EVIDENCE_AGE_MS } from "./policies/provisional-m1.js";
import { ingestExchangeFillObservation } from "./accounting-ingestion.js";
import { closedRecord } from "../domain/planning/planning-validation.js";
import type { PreparedArtifactStore } from "../ports/prepared-artifact-store.js";
import type {
  PreparedLegPersistencePort,
  PreparedLegReconciliationStatus,
  PersistencePort,
} from "../ports/persistence.js";
import type {
  PreparedLegWriteAuthorizationBinding,
  PreparedLegWriteAuthorizationPort,
  PreparedLegWriteCapability,
} from "../ports/prepared-leg-write-authorization.js";
import type {
  ExchangeOperation,
  ExchangeResult,
  ExchangeFillObservation,
  ExchangeOrderAcknowledgement,
  ExchangeOrderObservation,
  MainnetExchangeExecutionPort,
  MainnetExchangeReadState,
} from "../ports/exchange-execution.js";
import type { MainnetExecutionReadiness } from "./mainnet-execution-readiness.js";

const LEASE_TTL_MS = 60_000;

export interface MainnetPreparedLegFreshEvidence {
  readonly readiness: MainnetExecutionReadiness;
  readonly state: MainnetExchangeReadState;
}

export interface MainnetPreparedLegEvidencePort {
  /** Composition performs #16/#20 reads using one credential snapshot. */
  collect(symbol: string): Promise<MainnetPreparedLegFreshEvidence>;
}

export interface MainnetPreparedLegDependencies {
  readonly artifacts: PreparedArtifactStore;
  readonly persistence: PersistencePort;
  readonly preparedLegs: PreparedLegPersistencePort;
  readonly exchange: MainnetExchangeExecutionPort;
  readonly evidence: MainnetPreparedLegEvidencePort;
  readonly authorization: PreparedLegWriteAuthorizationPort;
  readonly localClock: Clock;
  readonly monotonicClock: () => number;
}

export type MainnetPreparedLegCreateDependencies =
  MainnetPreparedLegDependencies;

export interface MainnetPreparedLegOutcome {
  readonly kind: "created" | "recovery";
  readonly sourceId: string;
  readonly clientOrderId: string;
  readonly status: PreparedLegReconciliationStatus;
  readonly reconciliationRevision: number;
}

function blocked(code: string) {
  return fail(domainError("INVALID_CAPABILITY", code));
}

export function acquireOrReuseMainnetLease(
  persistence: PersistencePort,
  runId: string,
  now: UtcTimestamp,
) {
  const snapshot = persistence.readScopeSnapshot();
  if (!snapshot.ok) return snapshot;
  const existing = snapshot.value.lease;
  if (
    existing?.ownerRunId === runId &&
    timestampToEpochMs(now) < timestampToEpochMs(existing.expiresAt)
  )
    return ok(existing);
  return persistence.acquireLease({
    scope: persistence.scope,
    ownerRunId: runId,
    now,
    ttlMs: LEASE_TTL_MS,
  });
}

function matchesScope(
  persistence: PersistencePort,
  execution: PreparedLegSourceIdentity,
): boolean {
  return (
    persistence.scope.exchange === "bybit" &&
    persistence.scope.environment === "mainnet" &&
    persistence.scope.accountId === execution.accountIdentityHash &&
    persistence.scope.category === "linear" &&
    persistence.scope.positionMode === "one-way"
  );
}

export async function verifyCurrentAccountBinding(
  dependencies: MainnetPreparedLegDependencies,
  identity: PreparedLegSourceIdentity,
): Promise<Result<void>> {
  let evidence: MainnetPreparedLegFreshEvidence;
  try {
    evidence = await dependencies.evidence.collect(
      identity.leg.intent.instrument,
    );
  } catch {
    return blocked("CURRENT_ACCOUNT_IDENTITY_UNAVAILABLE");
  }
  const { readiness, state } = evidence;
  const evaluatedAt = parseUtcTimestamp(readiness.evaluatedAt);
  const serverTime = parseUtcTimestamp(state.serverTime);
  if (
    !evaluatedAt.ok ||
    !serverTime.ok ||
    readiness.environment !== "mainnet" ||
    readiness.symbol !== identity.leg.intent.instrument ||
    readiness.internalBinding?.accountIdentityHash !==
      identity.accountIdentityHash ||
    readiness.accountEvidenceAgeMs === undefined ||
    readiness.accountEvidenceAgeMs < 0 ||
    readiness.accountEvidenceAgeMs >
      PROVISIONAL_M1_MAX_ACCOUNT_EVIDENCE_AGE_MS ||
    timestampToEpochMs(serverTime.value) <
      timestampToEpochMs(evaluatedAt.value) ||
    timestampToEpochMs(serverTime.value) -
      timestampToEpochMs(evaluatedAt.value) >
      PROVISIONAL_M1_MAX_ACCOUNT_EVIDENCE_AGE_MS ||
    state.market.instrument !== identity.leg.intent.instrument ||
    state.market.scope.exchange !== "bybit" ||
    state.market.scope.environment !== "mainnet" ||
    state.market.scope.category !== "linear" ||
    state.market.scope.positionMode !== "one-way"
  )
    return blocked("CURRENT_ACCOUNT_IDENTITY_MISMATCH");
  return ok(undefined);
}

function validateCurrentEvidence(
  evidence: MainnetPreparedLegFreshEvidence,
  execution: PreparedLegExecution,
): Result<void> {
  const { readiness, state } = evidence;
  const one = DecimalValue.fromString("1");
  const evaluatedAt = parseUtcTimestamp(readiness.evaluatedAt);
  const serverTime = parseUtcTimestamp(state.serverTime);
  if (!one.ok) return blocked("INVALID_LEVERAGE_CONSTANT");
  if (
    !evaluatedAt.ok ||
    !serverTime.ok ||
    readiness.environment !== "mainnet" ||
    readiness.verdict !== "READY" ||
    readiness.symbol !== execution.leg.intent.instrument ||
    readiness.internalBinding?.accountIdentityHash !==
      execution.accountIdentityHash ||
    readiness.accountEvidenceAgeMs === undefined ||
    readiness.accountEvidenceAgeMs < 0 ||
    readiness.accountEvidenceAgeMs >
      PROVISIONAL_M1_MAX_ACCOUNT_EVIDENCE_AGE_MS ||
    timestampToEpochMs(serverTime.value) <
      timestampToEpochMs(evaluatedAt.value) ||
    timestampToEpochMs(serverTime.value) -
      timestampToEpochMs(evaluatedAt.value) >
      PROVISIONAL_M1_MAX_ACCOUNT_EVIDENCE_AGE_MS ||
    state.market.instrument !== execution.leg.intent.instrument ||
    state.market.scope.exchange !== "bybit" ||
    state.market.scope.environment !== "mainnet" ||
    state.market.scope.category !== "linear" ||
    state.market.scope.positionMode !== "one-way" ||
    state.position.instrument !== execution.leg.intent.instrument ||
    state.position.side !== "flat" ||
    !state.position.quantity.isZero() ||
    state.openOrders.length !== 0 ||
    state.leverage.buy.compare(one.value) !== 0 ||
    state.leverage.sell.compare(one.value) !== 0 ||
    state.leverage.effective.compare(one.value) !== 0
  )
    return blocked("CREATE_READINESS_OR_TARGET_STATE_BLOCKED");
  const scope = {
    exchange: "bybit",
    environment: "mainnet",
    category: "linear",
    positionMode: "one-way",
  } as const;
  const requiredCapabilities = [
    "order-create",
    "attached-protection",
    "reconciliation-reads",
  ] as const;
  for (const capability of requiredCapabilities) {
    const requirement: CapabilityRequirement = { capability, scope };
    const observation = state.capabilities.find(
      (item) =>
        item.capability === capability &&
        item.scope.exchange === scope.exchange &&
        item.scope.environment === scope.environment &&
        item.scope.category === scope.category &&
        item.scope.positionMode === scope.positionMode,
    );
    if (
      !observation ||
      !requireTrustedCapability(observation, requirement, {
        now: () => state.serverTime,
      }).ok
    )
      return blocked("REQUIRED_EXECUTION_CAPABILITY_UNPROVEN");
  }
  const intent = execution.leg.intent;
  const constraints = state.market.constraints;
  if (
    constraints.instrument !== intent.instrument ||
    (constraints.minPrice !== undefined &&
      intent.price.compare(constraints.minPrice) < 0) ||
    (constraints.maxPrice !== undefined &&
      intent.price.compare(constraints.maxPrice) > 0) ||
    (constraints.maxLimitQuantity !== undefined &&
      intent.quantity.compare(constraints.maxLimitQuantity) > 0)
  )
    return blocked("APPROVED_TERMS_OUTSIDE_CURRENT_CONSTRAINTS");
  const normalized = normalizeOrderIntent(
    {
      intentId: intent.intentId,
      instrument: intent.instrument,
      orderType: intent.orderType,
      side: intent.side,
      positionEffect: intent.positionEffect,
      price: intent.price.toString(),
      quantity: intent.quantity.toString(),
      rounding: intent.normalization,
      ...(intent.protection === undefined
        ? {}
        : {
            protection: {
              ...(intent.protection.takeProfit === undefined
                ? {}
                : { takeProfit: intent.protection.takeProfit.toString() }),
              ...(intent.protection.stopLoss === undefined
                ? {}
                : { stopLoss: intent.protection.stopLoss.toString() }),
            },
          }),
    },
    constraints,
  );
  if (
    !normalized.ok ||
    normalized.value.price.compare(intent.price) !== 0 ||
    normalized.value.quantity.compare(intent.quantity) !== 0 ||
    normalized.value.notional.compare(intent.notional) !== 0 ||
    normalized.value.protection?.takeProfit?.compare(
      intent.protection?.takeProfit ?? intent.price,
    ) !== 0 ||
    normalized.value.protection?.stopLoss !== undefined
  )
    return blocked("APPROVED_TERMS_CHANGED_BY_CURRENT_CONSTRAINTS");
  return ok(undefined);
}

function authorizationBinding(
  execution: PreparedLegExecution,
  sourceId: string,
  authority: { readonly ownerRunId: string; readonly epoch: number },
): PreparedLegWriteAuthorizationBinding {
  return Object.freeze({
    operation: "create",
    environment: "mainnet",
    accountIdentityHash: execution.accountIdentityHash,
    preparedHash: execution.preparedHash,
    approvalHash: execution.approvalHash,
    sourceId,
    symbol: execution.leg.intent.instrument,
    legId: execution.leg.legId,
    leaseOwnerRunId: authority.ownerRunId,
    leaseEpoch: authority.epoch,
    clientOrderId: execution.clientOrderId,
  });
}

function safeProviderReason(result: ExchangeResult<unknown>): string {
  return result.ok
    ? "NONE"
    : "EXCHANGE_" +
        result.error.kind.replace(/[^A-Za-z0-9_-]/gu, "_").toUpperCase();
}

function failedExchangeRead<T>(
  operation: ExchangeOperation,
): ExchangeResult<T> {
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

function failedExchangeWrite<T>(
  operation: "create" | "cancel",
): ExchangeResult<T> {
  return {
    ok: false,
    error: {
      kind: "ambiguous",
      message: "exchange write outcome is unknown",
      retry: "reconcile",
      operation,
    },
  };
}

function isAuthorizationAdmitted(
  dependencies: MainnetPreparedLegDependencies,
  capability: PreparedLegWriteCapability,
  binding: PreparedLegWriteAuthorizationBinding,
): boolean {
  try {
    return dependencies.authorization.isAdmitted(capability, binding);
  } catch {
    return false;
  }
}

function haltAfterDurableIntent(
  dependencies: MainnetPreparedLegDependencies,
  authority: { readonly ownerRunId: string; readonly epoch: number },
  at: UtcTimestamp,
  code: DomainErrorCode,
  reasonCode: string,
): Result<never> {
  dependencies.persistence.raiseHalt(
    authority,
    "prepared-leg dispatch stopped after durable intent: " + reasonCode,
    at,
  );
  return fail(
    domainError(code, "prepared-leg dispatch was stopped after durable intent"),
  );
}

function fillEvidence(
  fills: readonly ExchangeFillObservation[],
  execution: PreparedLegSourceIdentity,
  orderId: string,
): Result<
  readonly {
    executionId: string;
    quantity: string;
    price: string;
    executedAt: UtcTimestamp;
    fee?: string;
    feeCurrency?: string;
  }[]
> {
  const seen = new Set<string>();
  const result = [];
  for (const fill of fills) {
    if (
      seen.has(fill.executionId) ||
      fill.exchangeOrderId !== orderId ||
      fill.clientOrderId !== execution.clientOrderId ||
      fill.instrument !== execution.leg.intent.instrument ||
      fill.side !== "buy" ||
      !fill.quantity.isPositive() ||
      !fill.price.isPositive()
    )
      return fail(
        domainError(
          "UNRESOLVED_RECONCILIATION",
          "fill identity or terms conflict",
        ),
      );
    seen.add(fill.executionId);
    result.push({
      executionId: fill.executionId,
      quantity: fill.quantity.toString(),
      price: fill.price.toString(),
      executedAt: fill.executedAt,
      ...(fill.fee === undefined ? {} : { fee: fill.fee.toString() }),
      ...(fill.feeCurrency === undefined
        ? {}
        : { feeCurrency: fill.feeCurrency }),
    });
  }
  return ok(result);
}

function targetStateConflict(
  state: MainnetExchangeReadState,
  execution: PreparedLegSourceIdentity,
  proof: PreparedLegOrderProof,
  fills: readonly ExchangeFillObservation[],
): string | undefined {
  const symbol = execution.leg.intent.instrument;
  if (
    state.market.instrument !== symbol ||
    state.market.scope.exchange !== "bybit" ||
    state.market.scope.environment !== "mainnet" ||
    state.market.scope.category !== "linear" ||
    state.market.scope.positionMode !== "one-way" ||
    state.position.instrument !== symbol
  )
    return "READ_STATE_SCOPE_MISMATCH";
  const one = DecimalValue.fromString("1");
  if (
    !one.ok ||
    state.leverage.effective.compare(one.value) !== 0 ||
    state.leverage.buy.compare(one.value) !== 0 ||
    state.leverage.sell.compare(one.value) !== 0
  )
    return "POST_CREATE_LEVERAGE_CHANGED";
  if (
    state.openOrders.some(
      (order) =>
        order.instrument !== symbol ||
        order.clientOrderId !== execution.clientOrderId,
    )
  )
    return "UNOWNED_TARGET_ORDER_PRESENT";
  const ownedOpenOrders = state.openOrders.filter(
    (order) => order.clientOrderId === execution.clientOrderId,
  );
  if (ownedOpenOrders.length > 1) return "DUPLICATE_OWNED_TARGET_ORDER";
  if (ownedOpenOrders.length === 1) {
    const current = createPreparedLegOrderProof(ownedOpenOrders[0]);
    if (
      !current.ok ||
      current.value.exchangeOrderId !== proof.exchangeOrderId ||
      current.value.status !== proof.status ||
      current.value.filledQuantity.compare(proof.filledQuantity) !== 0 ||
      !matchesPreparedLegOrder(current.value, execution)
    )
      return "READ_STATE_ORDER_CONTRADICTS_RECONCILIATION";
  }
  const parsedZero = DecimalValue.fromString("0");
  if (!parsedZero.ok) return "INVALID_FILL_TOTAL";
  let total = parsedZero.value;
  for (const fill of fills) total = total.add(fill.quantity);
  if (total.isZero()) {
    if (state.position.side !== "flat" || !state.position.quantity.isZero())
      return "UNOWNED_TARGET_POSITION_PRESENT";
  } else if (
    state.position.side !== "long" ||
    state.position.quantity.compare(total) !== 0
  ) {
    return "TARGET_POSITION_CONTRADICTS_EXACT_FILLS";
  }
  return undefined;
}

function persistEntryAccounting(
  dependencies: MainnetPreparedLegDependencies,
  sourceId: string,
  fills: readonly ExchangeFillObservation[],
): Result<void> {
  const source = dependencies.preparedLegs.readPreparedLegSource(sourceId);
  if (!source.ok) return source;
  if (!source.value)
    return fail(
      domainError("PERSISTENCE_INTEGRITY", "fill source is not durable"),
    );
  for (const fill of fills) {
    const persisted = ingestExchangeFillObservation(
      dependencies.persistence,
      dependencies.persistence.scope,
      fill,
      source.value.createIntent.writeIntentId,
      {
        eventKey: `${sourceId}:${fill.executionId}`,
        ledgerCurrency: "USDT",
      },
    );
    if (!persisted.ok) return persisted;
  }
  return ok(undefined);
}

export async function reconcilePreparedLegSource(
  dependencies: MainnetPreparedLegDependencies,
  execution: PreparedLegSourceIdentity,
  sourceId: string,
  authority: { readonly ownerRunId: string; readonly epoch: number },
  kind: "created" | "recovery",
  options: {
    readonly expectedOrderId?: string;
    readonly cancelPending?: boolean;
    readonly forceUnresolvedReason?: string;
  } = {},
): Promise<Result<MainnetPreparedLegOutcome>> {
  const sourceSnapshot =
    dependencies.preparedLegs.readPreparedLegSource(sourceId);
  if (!sourceSnapshot.ok) return sourceSnapshot;
  if (!sourceSnapshot.value)
    return fail(
      domainError(
        "PERSISTENCE_INTEGRITY",
        "prepared-leg source is not durable",
      ),
    );
  const durableCancelOrderId =
    sourceSnapshot.value.cancelIntent?.exchangeOrderId;
  const expectedOrderId = durableCancelOrderId ?? options.expectedOrderId;
  const cancelPending =
    options.cancelPending === true ||
    sourceSnapshot.value.cancelIntent !== undefined;
  let readState: ExchangeResult<MainnetExchangeReadState>;
  try {
    readState = await dependencies.exchange.readState({
      instrument: execution.leg.intent.instrument,
    });
  } catch {
    readState = failedExchangeRead("read");
  }
  if (!readState.ok) {
    dependencies.persistence.raiseHalt(
      authority,
      "prepared-leg reconciliation time/state unavailable",
      sourceSnapshot.value.createIntent.preparedAt,
    );
    return fail(
      domainError(
        "UNRESOLVED_RECONCILIATION",
        "provider time/state unavailable; source remains possibly dispatched",
      ),
    );
  }
  const observedAt = readState.value.serverTime;
  const lookup = {
    instrument: execution.leg.intent.instrument,
    clientOrderId: execution.clientOrderId,
    ...(expectedOrderId === undefined
      ? {}
      : { exchangeOrderId: expectedOrderId }),
  };
  let observed: ExchangeResult<ExchangeOrderObservation>;
  try {
    observed = await dependencies.exchange.observeOrder(lookup);
  } catch {
    observed = failedExchangeRead("observe");
  }
  if (!observed.ok) {
    const saved = dependencies.preparedLegs.appendPreparedLegReconciliation({
      authority,
      sourceId,
      status: "UNRESOLVED",
      observedAt,
      result: { reasonCodes: [safeProviderReason(observed)] },
    });
    if (!saved.ok) return saved;
    return outcome(kind, execution, sourceId, saved.value);
  }
  const proof = createPreparedLegOrderProof(observed.value);
  if (!proof.ok) {
    const saved = dependencies.preparedLegs.appendPreparedLegReconciliation({
      authority,
      sourceId,
      status: "UNRESOLVED",
      observedAt,
      exchangeOrderId: observed.value.exchangeOrderId,
      result: { reasonCodes: ["ORDER_TERMS_INCOMPLETE"] },
    });
    if (!saved.ok) return saved;
    return outcome(kind, execution, sourceId, saved.value);
  }
  const proofObservedAt = proof.value.observedAt;
  const matches = matchesPreparedLegOrder(proof.value, execution);
  let fillsResult: ExchangeResult<readonly ExchangeFillObservation[]>;
  try {
    fillsResult = await dependencies.exchange.listFills({
      instrument: execution.leg.intent.instrument,
      clientOrderId: execution.clientOrderId,
      exchangeOrderId: proof.value.exchangeOrderId,
    });
  } catch {
    fillsResult = failedExchangeRead("fills");
  }
  if (!fillsResult.ok) {
    const saved = dependencies.preparedLegs.appendPreparedLegReconciliation({
      authority,
      sourceId,
      status: "UNRESOLVED",
      observedAt: proofObservedAt,
      exchangeOrderId: proof.value.exchangeOrderId,
      result: {
        orderProof: proof.value,
        reasonCodes: [safeProviderReason(fillsResult)],
      },
    });
    if (!saved.ok) return saved;
    return outcome(kind, execution, sourceId, saved.value);
  }
  const fills = fillEvidence(
    fillsResult.value,
    execution,
    proof.value.exchangeOrderId,
  );
  const zero = DecimalValue.fromString("0");
  if (!zero.ok)
    return fail(domainError("INVALID_DECIMAL", "zero constant is invalid"));
  let sums = zero.value;
  if (fills.ok) {
    for (const fill of fills.value) {
      const quantity = DecimalValue.fromString(fill.quantity);
      if (!quantity.ok)
        return fail(
          domainError(
            "UNRESOLVED_RECONCILIATION",
            "stored fill quantity is invalid",
          ),
        );
      sums = sums.add(quantity.value);
    }
  }
  const exactFillTotal =
    fills.ok && sums?.compare(proof.value.filledQuantity) === 0;
  const exactOrder =
    matches &&
    proof.value.instrument === execution.leg.intent.instrument &&
    (expectedOrderId === undefined ||
      proof.value.exchangeOrderId === expectedOrderId) &&
    options.forceUnresolvedReason === undefined;
  const stateConflict =
    fills.ok && exactOrder
      ? targetStateConflict(
          readState.value,
          execution,
          proof.value,
          fillsResult.value,
        )
      : undefined;
  const filledQuantity = proof.value.filledQuantity;
  const filledStatusConsistent =
    (proof.value.status === "partially-filled" &&
      filledQuantity.isPositive() &&
      filledQuantity.compare(proof.value.requestedQuantity) < 0) ||
    (proof.value.status === "filled" &&
      filledQuantity.compare(proof.value.requestedQuantity) === 0) ||
    (proof.value.status === "cancelled" &&
      filledQuantity.isPositive() &&
      filledQuantity.compare(proof.value.requestedQuantity) < 0);
  const accounting =
    exactOrder && fills.ok && exactFillTotal && filledQuantity.isPositive()
      ? persistEntryAccounting(dependencies, sourceId, fillsResult.value)
      : ok(undefined);
  let status: PreparedLegReconciliationStatus;
  let result: {
    orderProof: typeof proof.value;
    fills?: readonly {
      executionId: string;
      quantity: string;
      price: string;
      executedAt: UtcTimestamp;
      fee?: string;
      feeCurrency?: string;
    }[];
    reasonCodes?: readonly string[];
  };
  if (
    !exactOrder ||
    !fills.ok ||
    !exactFillTotal ||
    stateConflict !== undefined
  ) {
    status = "UNRESOLVED";
    result = {
      orderProof: proof.value,
      ...(fills.ok ? { fills: fills.value } : {}),
      reasonCodes: [
        options.forceUnresolvedReason ??
          stateConflict ??
          (!exactOrder
            ? "ORDER_TERMS_MISMATCH"
            : !fills.ok
              ? "FILL_IDENTITY_INVALID"
              : "FILL_TOTAL_MISMATCH"),
      ],
    };
  } else if (filledQuantity.isPositive()) {
    if (!filledStatusConsistent) {
      status = "UNRESOLVED";
      result = {
        orderProof: proof.value,
        fills: fills.value,
        reasonCodes: ["ORDER_STATUS_FILL_QUANTITY_CONFLICT"],
      };
    } else if (!accounting.ok) {
      status = "UNRESOLVED";
      result = {
        orderProof: proof.value,
        fills: fills.value,
        reasonCodes: ["ENTRY_ACCOUNTING_PERSISTENCE_FAILED"],
      };
    } else {
      status = "PROTECTION_PENDING";
      result = { orderProof: proof.value, fills: fills.value };
    }
  } else if (proof.value.status === "open" && fills.value.length === 0) {
    status = cancelPending ? "UNRESOLVED" : "CONFIRMED_OPEN";
    result = cancelPending
      ? { orderProof: proof.value, reasonCodes: ["CANCEL_NOT_TERMINAL"] }
      : { orderProof: proof.value };
  } else if (proof.value.status === "cancelled" && fills.value.length === 0) {
    status = "CANCELLED";
    result = { orderProof: proof.value };
  } else if (proof.value.status === "rejected" && fills.value.length === 0) {
    status = "REJECTED";
    result = { orderProof: proof.value };
  } else {
    status = "UNRESOLVED";
    result = { orderProof: proof.value, reasonCodes: ["ORDER_STATE_CONFLICT"] };
  }
  const saved = dependencies.preparedLegs.appendPreparedLegReconciliation({
    authority,
    sourceId,
    status,
    observedAt: proofObservedAt,
    exchangeOrderId: proof.value.exchangeOrderId,
    result,
  });
  if (!saved.ok) return saved;
  const final = outcome(kind, execution, sourceId, saved.value);
  if (
    status === "CONFIRMED_OPEN" ||
    status === "CANCELLED" ||
    status === "REJECTED"
  )
    dependencies.persistence.releaseLease(authority);
  return final;
}

function outcome(
  kind: "created" | "recovery",
  execution: PreparedLegSourceIdentity,
  sourceId: string,
  reconciliation: {
    readonly status: PreparedLegReconciliationStatus;
    readonly revision: number;
  },
): Result<MainnetPreparedLegOutcome> {
  return ok({
    kind,
    sourceId,
    clientOrderId: execution.clientOrderId,
    status: reconciliation.status,
    reconciliationRevision: reconciliation.revision,
  });
}

/** Executes only the exact unexpired approval leg; recovery is a separate read-only API. */
export async function createMainnetPreparedLeg(
  input: unknown,
  dependencies: MainnetPreparedLegCreateDependencies,
): Promise<Result<MainnetPreparedLegOutcome>> {
  if (
    !closedRecord(input, ["approvalHash", "legId", "runId"]) ||
    Reflect.ownKeys(input).length !== 3
  )
    return fail(
      domainError(
        "INVALID_APPROVAL",
        "create requires exact approvalHash, legId and runId",
      ),
    );
  const approvalHash = requireHash(input.approvalHash, "approvalHash");
  const legId = requireIdentifier(input.legId, "legId");
  const runId = requireIdentifier(input.runId, "runId");
  if (!approvalHash.ok || !legId.ok || !runId.ok)
    return fail(domainError("INVALID_APPROVAL", "create identity is invalid"));
  const loaded = dependencies.artifacts.loadApproval(approvalHash.value);
  if (!loaded.ok) return loaded;
  if (!loaded.value)
    return fail(
      domainError("INVALID_APPROVAL", "exact approved artifact was not found"),
    );
  const identity = derivePreparedLegExecutionIdentity({
    approval: loaded.value,
    approvalHash: approvalHash.value,
    legId: legId.value,
  });
  if (!identity.ok) return identity;
  if (!matchesScope(dependencies.persistence, identity.value))
    return fail(
      domainError(
        "PERSISTENCE_ENVIRONMENT",
        "prepared approval does not match the selected Mainnet journal",
      ),
    );
  const localNow = parseUtcTimestamp(dependencies.localClock.now());
  if (!localNow.ok) return localNow;
  const lease = acquireOrReuseMainnetLease(
    dependencies.persistence,
    runId.value,
    localNow.value,
  );
  if (!lease.ok) return lease;
  const sourceId = derivePreparedLegSourceId(
    identity.value.accountIdentityHash,
    identity.value.preparedHash,
    identity.value.leg.legId,
  );
  if (!sourceId.ok) return sourceId;
  const prior = dependencies.preparedLegs.readPreparedLegSource(sourceId.value);
  if (!prior.ok) return prior;
  if (prior.value) {
    const accountBinding = await verifyCurrentAccountBinding(
      dependencies,
      identity.value,
    );
    if (!accountBinding.ok) return accountBinding;
    return reconcilePreparedLegSource(
      dependencies,
      identity.value,
      sourceId.value,
      lease.value,
      "recovery",
    );
  }
  if (lease.value.reconciliationRequired)
    return fail(
      domainError("UNRESOLVED_STATE", "lease takeover is reconciliation-only"),
    );
  const halt = dependencies.persistence.readHalt();
  if (!halt.ok) return halt;
  if (halt.value.active)
    return fail(
      domainError(
        "HALT_ACTIVE",
        "account HALT blocks a new prepared-leg create",
      ),
    );
  let evidence: MainnetPreparedLegFreshEvidence;
  try {
    evidence = await dependencies.evidence.collect(
      identity.value.leg.intent.instrument,
    );
  } catch {
    return blocked("FRESH_MAINNET_EVIDENCE_UNAVAILABLE");
  }
  const evidenceReadCompletedAt = dependencies.monotonicClock();
  if (!Number.isFinite(evidenceReadCompletedAt))
    return blocked("MONOTONIC_CLOCK_INVALID");
  const execution = createPreparedLegExecution({
    approval: loaded.value,
    approvalHash: approvalHash.value,
    legId: legId.value,
    now: evidence.state.serverTime,
  });
  if (!execution.ok) return execution;
  const eligible = validateCurrentEvidence(evidence, execution.value);
  if (!eligible.ok) return eligible;
  const initialAccountEvidenceAgeMs = evidence.readiness.accountEvidenceAgeMs;
  if (initialAccountEvidenceAgeMs === undefined)
    return blocked("FRESH_MAINNET_EVIDENCE_UNAVAILABLE");
  const ageAfterRead = dependencies.monotonicClock() - evidenceReadCompletedAt;
  const providerAgeAtRead =
    initialAccountEvidenceAgeMs +
    timestampToEpochMs(evidence.state.serverTime) -
    timestampToEpochMs(evidence.readiness.evaluatedAt);
  if (
    ageAfterRead < 0 ||
    providerAgeAtRead + ageAfterRead >
      PROVISIONAL_M1_MAX_ACCOUNT_EVIDENCE_AGE_MS
  )
    return blocked("FRESH_MAINNET_EVIDENCE_EXPIRED");
  const source = derivePreparedLegSourceId(
    execution.value.accountIdentityHash,
    execution.value.preparedHash,
    execution.value.leg.legId,
  );
  if (!source.ok) return source;
  const binding = authorizationBinding(
    execution.value,
    source.value,
    lease.value,
  );
  let capability: PreparedLegWriteCapability | undefined;
  try {
    capability = await dependencies.authorization.authorize(binding);
  } catch {
    return blocked("CREATE_AUTHORIZATION_DENIED");
  }
  if (
    !capability ||
    !isAuthorizationAdmitted(dependencies, capability, binding)
  )
    return blocked("CREATE_AUTHORIZATION_NOT_ADMITTED");
  const preparedAt = parseUtcTimestamp(dependencies.localClock.now());
  if (!preparedAt.ok) return preparedAt;
  const intent = dependencies.preparedLegs.preparePreparedLegCreate({
    authority: lease.value,
    runId: runId.value,
    execution: execution.value,
    preparedAt: preparedAt.value,
  });
  if (!intent.ok) return intent;
  if (!intent.value.created)
    return reconcilePreparedLegSource(
      dependencies,
      execution.value,
      source.value,
      lease.value,
      "recovery",
    );
  const currentSnapshot = dependencies.persistence.readScopeSnapshot();
  if (!currentSnapshot.ok)
    return haltAfterDurableIntent(
      dependencies,
      lease.value,
      preparedAt.value,
      "RUN_LEASE_LOST",
      "SCOPE_REVALIDATION_FAILED",
    );
  const currentLeaseState = currentSnapshot.value.lease;
  const currentHalt = currentSnapshot.value.halt;
  const dispatchTime = parseUtcTimestamp(dependencies.localClock.now());
  if (!dispatchTime.ok)
    return haltAfterDurableIntent(
      dependencies,
      lease.value,
      preparedAt.value,
      "INVALID_TIMESTAMP",
      "DISPATCH_TIME_UNAVAILABLE",
    );
  const elapsedSinceEvidenceMs =
    dependencies.monotonicClock() - evidenceReadCompletedAt;
  const evidenceAgeAtDispatch = providerAgeAtRead + elapsedSinceEvidenceMs;
  const providerTimeAtDispatchMs =
    timestampToEpochMs(evidence.state.serverTime) +
    Math.ceil(elapsedSinceEvidenceMs);
  if (
    currentLeaseState?.ownerRunId !== lease.value.ownerRunId ||
    currentLeaseState.epoch !== lease.value.epoch ||
    currentLeaseState.reconciliationRequired ||
    timestampToEpochMs(dispatchTime.value) >=
      timestampToEpochMs(currentLeaseState.expiresAt)
  )
    return haltAfterDurableIntent(
      dependencies,
      lease.value,
      dispatchTime.value,
      "RUN_LEASE_LOST",
      "LEASE_FENCED_OR_EXPIRED",
    );
  if (
    !Number.isFinite(providerTimeAtDispatchMs) ||
    providerTimeAtDispatchMs >= timestampToEpochMs(execution.value.expiresAt)
  )
    return haltAfterDurableIntent(
      dependencies,
      lease.value,
      dispatchTime.value,
      "PLAN_EXPIRED",
      "APPROVAL_EXPIRED",
    );
  if (currentHalt.active)
    return haltAfterDurableIntent(
      dependencies,
      lease.value,
      dispatchTime.value,
      "HALT_ACTIVE",
      "HALT_ACTIVE",
    );
  if (
    !Number.isFinite(evidenceAgeAtDispatch) ||
    evidenceAgeAtDispatch < 0 ||
    evidenceAgeAtDispatch > PROVISIONAL_M1_MAX_ACCOUNT_EVIDENCE_AGE_MS
  )
    return haltAfterDurableIntent(
      dependencies,
      lease.value,
      dispatchTime.value,
      "STALE_EVIDENCE",
      "FRESH_MAINNET_EVIDENCE_EXPIRED",
    );
  if (!isAuthorizationAdmitted(dependencies, capability, binding))
    return haltAfterDurableIntent(
      dependencies,
      lease.value,
      dispatchTime.value,
      "INVALID_CAPABILITY",
      "CREATE_AUTHORIZATION_NOT_ADMITTED",
    );
  let ack: ExchangeResult<ExchangeOrderAcknowledgement>;
  try {
    ack = await dependencies.exchange.createOrder({
      intent: execution.value.leg.intent,
      clientOrderId: execution.value.clientOrderId,
      timeInForce: execution.value.leg.timeInForce,
      reduceOnly: false,
    });
  } catch {
    ack = failedExchangeWrite("create");
  }
  const parsedAttemptAt = parseUtcTimestamp(dependencies.localClock.now());
  const attemptAt = parsedAttemptAt.ok
    ? parsedAttemptAt.value
    : dispatchTime.value;
  const attempt = dependencies.preparedLegs.appendPreparedLegAttempt({
    authority: lease.value,
    sourceId: source.value,
    operation: "create",
    attemptId: randomUUID(),
    result: !parsedAttemptAt.ok
      ? {
          outcome: "ambiguous",
          providerReasonCode: "ATTEMPT_TIMESTAMP_UNAVAILABLE",
        }
      : ack.ok
        ? ack.value.clientOrderId === execution.value.clientOrderId
          ? {
              outcome: "accepted",
              ...(ack.value.exchangeOrderId
                ? { exchangeOrderId: ack.value.exchangeOrderId }
                : {}),
            }
          : {
              outcome: "ambiguous",
              providerReasonCode: "ACK_CLIENT_ID_MISMATCH",
            }
        : { outcome: "ambiguous", providerReasonCode: safeProviderReason(ack) },
    recordedAt: attemptAt,
  });
  if (!attempt.ok) {
    dependencies.persistence.raiseHalt(
      lease.value,
      "prepared-leg acknowledgement could not be journaled",
      dispatchTime.value,
    );
    return attempt;
  }
  return reconcilePreparedLegSource(
    dependencies,
    execution.value,
    source.value,
    lease.value,
    "created",
    {
      ...(ack.ok &&
      ack.value.clientOrderId === execution.value.clientOrderId &&
      ack.value.exchangeOrderId
        ? { expectedOrderId: ack.value.exchangeOrderId }
        : {}),
      ...(ack.ok && ack.value.clientOrderId !== execution.value.clientOrderId
        ? { forceUnresolvedReason: "ACK_CLIENT_ID_MISMATCH" }
        : {}),
      ...(!parsedAttemptAt.ok
        ? { forceUnresolvedReason: "ATTEMPT_TIMESTAMP_UNAVAILABLE" }
        : {}),
    },
  );
}

/** Read-only recovery resolves source identity without a current approval lookup. */
export async function recoverMainnetPreparedLegSource(
  input: unknown,
  dependencies: MainnetPreparedLegCreateDependencies,
): Promise<Result<MainnetPreparedLegOutcome>> {
  if (
    !closedRecord(input, ["sourceId", "runId"]) ||
    Reflect.ownKeys(input).length !== 2
  )
    return fail(
      domainError("INVALID_ARGUMENT", "recovery requires sourceId and runId"),
    );
  const sourceId = requireIdentifier(input.sourceId, "sourceId");
  const runId = requireIdentifier(input.runId, "runId");
  if (!sourceId.ok || !runId.ok)
    return fail(
      domainError("INVALID_ARGUMENT", "recovery identity is invalid"),
    );
  const source = dependencies.preparedLegs.readPreparedLegSource(
    sourceId.value,
  );
  if (!source.ok) return source;
  if (!source.value)
    return fail(
      domainError("OWNERSHIP_MISMATCH", "prepared-leg source does not exist"),
    );
  const at = parseUtcTimestamp(dependencies.localClock.now());
  if (!at.ok) return at;
  const lease = acquireOrReuseMainnetLease(
    dependencies.persistence,
    runId.value,
    at.value,
  );
  if (!lease.ok) return lease;
  const prepared = dependencies.artifacts.loadPrepared(
    source.value.lineage.preparedHash,
  );
  if (!prepared.ok) return prepared;
  if (!prepared.value)
    return fail(
      domainError(
        "PERSISTENCE_INTEGRITY",
        "source-bound prepared artifact is unavailable",
      ),
    );
  const execution = derivePreparedLegSourceIdentity({
    prepared: prepared.value,
    preparedHash: source.value.lineage.preparedHash,
    legId: source.value.lineage.legId,
    accountIdentityHash: dependencies.persistence.scope.accountId,
  });
  if (!execution.ok) return execution;
  if (
    execution.value.preparedHash !== source.value.lineage.preparedHash ||
    execution.value.clientOrderId !== source.value.lineage.clientOrderId
  )
    return fail(
      domainError(
        "PERSISTENCE_INTEGRITY",
        "source prepared identity does not match durable lineage",
      ),
    );
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
      ...(source.value.reconciliations.at(-1)?.exchangeOrderId === undefined
        ? {}
        : {
            expectedOrderId:
              source.value.reconciliations.at(-1)!.exchangeOrderId,
          }),
      cancelPending: source.value.cancelIntent !== undefined,
    },
  );
}
