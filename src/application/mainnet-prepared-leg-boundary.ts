import { createHash, randomUUID } from "node:crypto";

import {
  requireTrustedCapability,
  type CapabilityRequirement,
} from "../domain/capabilities/capability.js";
import {
  derivePreparedLegExecutionIdentity,
  derivePreparedLegSourceIdentity,
  createPreparedLegExecution,
  createPreparedLegGridExecution,
  derivePreparedLegSourceId,
  type PreparedLegExecution,
  type PreparedLegGridExecution,
  type PreparedLegSourceIdentity,
} from "../domain/execution/prepared-leg-execution.js";
import { createPreparedGridCapacity } from "../domain/execution/prepared-grid-capacity.js";
import { hashCanonical } from "../domain/identity/canonical-serialization.js";
import {
  accountEvidenceContentHash,
  createAccountEvidenceBundle,
  type AccountEvidenceBundle,
} from "../domain/account/account-evidence-bundle.js";
import {
  createPreparedLegOrderProof,
  derivePreparedLegProtectionCoverage,
  isProducedPreparedLegOrderProof,
  matchesPreparedLegTakeProfitChild,
  matchesPreparedLegOrder,
} from "../domain/execution/prepared-leg-order-proof.js";
import type {
  PreparedLegOrderProof,
  PreparedLegProtectionCoverage,
} from "../domain/execution/prepared-leg-order-proof.js";
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
  PreparedLegProtectionEvidenceV2Input,
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
  readonly account: AccountEvidenceBundle;
  readonly readiness: MainnetExecutionReadiness;
  readonly state: MainnetExchangeReadState;
}

export interface MainnetPreparedGridReconciliationContext {
  readonly grid: PreparedLegGridExecution;
  readonly allowedLegIndexes: readonly number[];
  readonly currentLegIndex: number;
}

interface StoredGridSiblingEvidence {
  readonly status: PreparedLegReconciliationStatus;
  readonly proof?: PreparedLegOrderProof;
  readonly outstandingQuantity: DecimalValue;
}

export interface MainnetPreparedGridCreateContext {
  readonly grid: PreparedLegGridExecution;
  readonly currentLegIndex: number;
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
  readonly reasonCodes: readonly string[];
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
    return persistence.renewLease({
      scope: persistence.scope,
      ownerRunId: runId,
      now,
      ttlMs: LEASE_TTL_MS,
      authority: { ownerRunId: existing.ownerRunId, epoch: existing.epoch },
    });
  return persistence.acquireLease({
    scope: persistence.scope,
    ownerRunId: runId,
    now,
    ttlMs: LEASE_TTL_MS,
  });
}

export function matchesScope(
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

function validateGridJournalPosition(
  dependencies: MainnetPreparedLegDependencies,
  context: MainnetPreparedGridCreateContext,
  runId: string,
  leaseEpoch: number,
): Result<void> {
  for (const row of context.grid.legs) {
    const index = row.execution.leg.index;
    // The coordinator checked the full journal under this lease; the current
    // source is checked by the caller. Re-read only the durable prefix here.
    if (index >= context.currentLegIndex) break;
    const source = dependencies.preparedLegs.readPreparedLegSource(
      row.sourceId,
    );
    if (!source.ok) return source;
    const snapshot = source.value;
    const latest = snapshot?.reconciliations.at(-1);
    if (
      !snapshot ||
      snapshot.lineage.preparedHash !== context.grid.preparedHash ||
      snapshot.lineage.legId !== row.execution.leg.legId ||
      snapshot.lineage.clientOrderId !== row.execution.clientOrderId ||
      snapshot.createIntent.operation !== "create" ||
      snapshot.createIntent.runId !== runId ||
      snapshot.createIntent.leaseEpoch !== leaseEpoch ||
      snapshot.createIntent.clientOrderId !== row.execution.clientOrderId ||
      snapshot.createAttempt?.operation !== "create" ||
      snapshot.createAttempt.writeIntentId !==
        snapshot.createIntent.writeIntentId ||
      snapshot.cancelIntent !== undefined ||
      latest?.status !== "CONFIRMED_OPEN"
    )
      return blocked("GRID_PREFIX_JOURNAL_NOT_CONFIRMED");
  }
  return ok(undefined);
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
  const parsedAccount = createAccountEvidenceBundle(evidence.account);
  const accountHash = parsedAccount.ok
    ? accountEvidenceContentHash(parsedAccount.value)
    : parsedAccount;
  const evaluatedAt = parseUtcTimestamp(readiness.evaluatedAt);
  const serverTime = parseUtcTimestamp(state.serverTime);
  if (
    !parsedAccount.ok ||
    !accountHash.ok ||
    !evaluatedAt.ok ||
    !serverTime.ok ||
    readiness.environment !== "mainnet" ||
    readiness.symbol !== identity.leg.intent.instrument ||
    readiness.internalBinding?.accountIdentityHash !==
      identity.accountIdentityHash ||
    readiness.internalBinding?.accountEvidenceHash !== accountHash.value ||
    parsedAccount.value.collectionStatus !== "complete" ||
    parsedAccount.value.accountBinding.environment !== "mainnet" ||
    parsedAccount.value.accountBinding.origin !== "https://api.bybit.com" ||
    !parsedAccount.value.accountBinding.identityVerified ||
    parsedAccount.value.accountBinding.accountIdentityHash !==
      identity.accountIdentityHash ||
    parsedAccount.value.collectionEndedAt === null ||
    readiness.accountEvidenceAgeMs === undefined ||
    readiness.accountEvidenceAgeMs < 0 ||
    readiness.accountEvidenceAgeMs >
      PROVISIONAL_M1_MAX_ACCOUNT_EVIDENCE_AGE_MS ||
    timestampToEpochMs(serverTime.value) <
      timestampToEpochMs(evaluatedAt.value) ||
    timestampToEpochMs(serverTime.value) -
      timestampToEpochMs(evaluatedAt.value) >
      PROVISIONAL_M1_MAX_ACCOUNT_EVIDENCE_AGE_MS ||
    timestampToEpochMs(parsedAccount.value.collectionEndedAt) >
      timestampToEpochMs(evaluatedAt.value) ||
    timestampToEpochMs(serverTime.value) -
      timestampToEpochMs(parsedAccount.value.collectionEndedAt) >
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
  gridContext?: MainnetPreparedGridCreateContext,
): Result<void> {
  const { readiness, state } = evidence;
  const allowApprovedPrefix = gridContext !== undefined;
  const one = DecimalValue.fromString("1");
  const evaluatedAt = parseUtcTimestamp(readiness.evaluatedAt);
  const serverTime = parseUtcTimestamp(state.serverTime);
  if (!one.ok) return blocked("INVALID_LEVERAGE_CONSTANT");
  if (!evaluatedAt.ok || !serverTime.ok)
    return blocked("CREATE_READINESS_OR_TARGET_STATE_BLOCKED");
  if (!allowApprovedPrefix) {
    const parsedAccount = createAccountEvidenceBundle(evidence.account);
    const accountHash = parsedAccount.ok
      ? accountEvidenceContentHash(parsedAccount.value)
      : parsedAccount;
    if (
      !parsedAccount.ok ||
      !accountHash.ok ||
      readiness.internalBinding?.accountEvidenceHash !== accountHash.value ||
      parsedAccount.value.collectionStatus !== "complete" ||
      parsedAccount.value.accountBinding.environment !== "mainnet" ||
      parsedAccount.value.accountBinding.origin !== "https://api.bybit.com" ||
      !parsedAccount.value.accountBinding.identityVerified ||
      parsedAccount.value.accountBinding.accountIdentityHash !==
        execution.accountIdentityHash ||
      parsedAccount.value.collectionEndedAt === null ||
      timestampToEpochMs(parsedAccount.value.collectionEndedAt) >
        timestampToEpochMs(evaluatedAt.value) ||
      timestampToEpochMs(serverTime.value) -
        timestampToEpochMs(parsedAccount.value.collectionEndedAt) >
        PROVISIONAL_M1_MAX_ACCOUNT_EVIDENCE_AGE_MS
    )
      return blocked("CREATE_ACCOUNT_EVIDENCE_MISMATCH");
  }
  if (
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
    (!allowApprovedPrefix && state.openOrders.length !== 0) ||
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

function protectionEvidenceFill(
  fill: ExchangeFillObservation,
): PreparedLegProtectionEvidenceV2Input["entries"]["fills"][number] {
  return {
    executionId: fill.executionId,
    exchangeOrderId: fill.exchangeOrderId,
    clientOrderId: fill.clientOrderId,
    instrument: fill.instrument,
    side: fill.side,
    quantity: fill.quantity.toString(),
    price: fill.price.toString(),
    executedAt: fill.executedAt,
    source: fill.source,
  };
}

function protectionEvidenceChild(
  child: ExchangeOrderObservation,
): PreparedLegProtectionEvidenceV2Input["children"][number] {
  return {
    exchangeOrderId: child.exchangeOrderId,
    clientOrderId: child.clientOrderId,
    instrument: child.instrument,
    ...(child.providerOrderLinkId === undefined
      ? {}
      : { providerOrderLinkId: child.providerOrderLinkId }),
    ...(child.parentOrderLinkId === undefined
      ? {}
      : { parentOrderLinkId: child.parentOrderLinkId }),
    ...(child.category === undefined ? {} : { category: child.category }),
    ...(child.orderType === undefined ? {} : { orderType: child.orderType }),
    ...(child.price === undefined ? {} : { price: child.price.toString() }),
    side: child.side,
    requestedQuantity: child.requestedQuantity.toString(),
    filledQuantity: child.filledQuantity.toString(),
    remainingQuantity: child.requestedQuantity
      .subtract(child.filledQuantity)
      .toString(),
    status: child.status,
    source: child.source,
    observedAt: child.observedAt,
    ...(child.providerCreatedAt === undefined
      ? {}
      : { providerCreatedAt: child.providerCreatedAt }),
    ...(child.providerUpdatedAt === undefined
      ? {}
      : { providerUpdatedAt: child.providerUpdatedAt }),
    ...(child.providerStopOrderType === undefined
      ? {}
      : { providerStopOrderType: child.providerStopOrderType }),
    ...(child.providerTpslMode === undefined
      ? {}
      : { providerTpslMode: child.providerTpslMode }),
    ...(child.protectionType === undefined
      ? {}
      : { protectionType: child.protectionType }),
    ...(child.reduceOnly === undefined ? {} : { reduceOnly: child.reduceOnly }),
    ...(child.positionIdx === undefined
      ? {}
      : { positionIdx: child.positionIdx }),
    ...(child.triggerPrice === undefined
      ? {}
      : { triggerPrice: child.triggerPrice.toString() }),
    ...(child.triggerBy === undefined ? {} : { triggerBy: child.triggerBy }),
    ...(child.takeProfitTriggerBy === undefined
      ? {}
      : { takeProfitTriggerBy: child.takeProfitTriggerBy }),
  };
}

function createProtectionEvidenceV2(input: {
  readonly execution: PreparedLegSourceIdentity;
  readonly parent: PreparedLegOrderProof;
  readonly entries: readonly ExchangeFillObservation[];
  readonly exits: readonly ExchangeFillObservation[];
  readonly children: readonly ExchangeOrderObservation[];
  readonly coverage?: PreparedLegProtectionCoverage;
  readonly state: MainnetExchangeReadState;
  readonly observedAt: UtcTimestamp;
  readonly status: PreparedLegProtectionEvidenceV2Input["status"];
  readonly entryFillsComplete: boolean;
  readonly childOrdersComplete: boolean;
  readonly exitFillsComplete: boolean;
  readonly positionComplete: boolean;
  readonly reasonCodes: readonly string[];
}): PreparedLegProtectionEvidenceV2Input {
  const quantity = (fills: readonly ExchangeFillObservation[]) => {
    const zero = DecimalValue.fromString("0");
    if (!zero.ok) return null;
    return fills
      .reduce((sum, fill) => sum.add(fill.quantity), zero.value)
      .toString();
  };
  const entryQuantity = input.entryFillsComplete
    ? quantity(input.entries)
    : null;
  const exitQuantity = input.exitFillsComplete ? quantity(input.exits) : null;
  const reasonCodes = [
    ...new Set([...(input.coverage?.reasonCodes ?? []), ...input.reasonCodes]),
  ].sort();
  const coverageCovered = input.coverage
    ? input.coverage.covered &&
      input.positionComplete &&
      input.reasonCodes.length === 0
    : null;
  return {
    schemaVersion: "prepared-leg-protection-evidence/v2",
    status: input.status,
    observedAt: input.observedAt,
    parent: {
      exchangeOrderId: input.parent.exchangeOrderId,
      clientOrderId: input.parent.clientOrderId,
      instrument: input.parent.instrument,
      category: input.parent.category,
      side: input.parent.side,
      requestedQuantity: input.parent.requestedQuantity.toString(),
      filledQuantity: input.parent.filledQuantity.toString(),
      status: input.parent.status,
      source: input.parent.source,
      observedAt: input.parent.observedAt,
      takeProfit: input.parent.takeProfit?.toString() ?? null,
      ...(input.parent.providerTpslMode === undefined
        ? {}
        : { providerTpslMode: input.parent.providerTpslMode }),
      ...(input.parent.takeProfitTriggerBy === undefined
        ? {}
        : { takeProfitTriggerBy: input.parent.takeProfitTriggerBy }),
    },
    entries: {
      quantity: entryQuantity,
      executionIds: input.entries.map((fill) => fill.executionId).sort(),
      fills: input.entries.map(protectionEvidenceFill),
    },
    exits: {
      quantity: exitQuantity,
      executionIds: input.exits.map((fill) => fill.executionId).sort(),
      fills: input.exits.map(protectionEvidenceFill),
    },
    children: input.children.map(protectionEvidenceChild),
    coverage: {
      outstandingQuantity:
        input.coverage?.outstandingQuantity.toString() ?? null,
      activeRemainingQuantity:
        input.coverage?.activeRemainingQuantity.toString() ?? null,
      covered: coverageCovered,
      reasonCodes,
    },
    position: {
      instrument: input.state.position.instrument,
      side: input.state.position.side,
      quantity: input.state.position.quantity.toString(),
      serverTime: input.state.serverTime,
    },
    collection: {
      entryFills: input.entryFillsComplete ? "complete" : "incomplete",
      childOrders: input.childOrdersComplete ? "complete" : "incomplete",
      exitFills: input.childOrdersComplete
        ? input.exitFillsComplete
          ? "complete"
          : "incomplete"
        : "incomplete",
      position: input.positionComplete ? "complete" : "incomplete",
    },
    reasonCodes,
  };
}

interface FilledProtectionReads {
  readonly state: MainnetExchangeReadState;
  readonly observedAt: UtcTimestamp;
  readonly children: readonly ExchangeOrderObservation[];
  readonly exits: readonly ExchangeFillObservation[];
  readonly coverage?: PreparedLegProtectionCoverage;
  readonly childOrdersComplete: boolean;
  readonly exitFillsComplete: boolean;
  readonly positionComplete: boolean;
  readonly reasonCodes: readonly string[];
}

async function collectFilledProtectionReads(
  dependencies: MainnetPreparedLegDependencies,
  execution: PreparedLegSourceIdentity,
  parent: PreparedLegOrderProof,
  entries: readonly ExchangeFillObservation[],
  initialState: MainnetExchangeReadState,
): Promise<FilledProtectionReads> {
  const reasons: string[] = [];
  let children: readonly ExchangeOrderObservation[] = [];
  let childOrdersComplete = false;
  const exits: ExchangeFillObservation[] = [];
  let exitFillsComplete = false;

  let childResult: ExchangeResult<readonly ExchangeOrderObservation[]>;
  try {
    childResult = await dependencies.exchange.listAttachedProtection({
      instrument: execution.leg.intent.instrument,
      parentClientOrderId: execution.clientOrderId,
    });
  } catch {
    childResult = failedExchangeRead("observe");
  }
  if (childResult.ok) {
    children = childResult.value;
    childOrdersComplete = true;
    exitFillsComplete = true;
    for (const child of children) {
      let childFills: ExchangeResult<readonly ExchangeFillObservation[]>;
      try {
        childFills = await dependencies.exchange.listFills({
          instrument: execution.leg.intent.instrument,
          clientOrderId: child.providerOrderLinkId ?? child.clientOrderId,
          exchangeOrderId: child.exchangeOrderId,
        });
      } catch {
        childFills = failedExchangeRead("fills");
      }
      if (childFills.ok) exits.push(...childFills.value);
      else {
        exitFillsComplete = false;
        reasons.push(safeProviderReason(childFills));
      }
    }
  } else {
    reasons.push(safeProviderReason(childResult));
  }

  let freshState: ExchangeResult<MainnetExchangeReadState>;
  try {
    freshState = await dependencies.exchange.readState({
      instrument: execution.leg.intent.instrument,
    });
  } catch {
    freshState = failedExchangeRead("read");
  }
  const positionComplete = freshState.ok;
  const state = freshState.ok ? freshState.value : initialState;
  if (!freshState.ok) reasons.push(safeProviderReason(freshState));
  const observedAt = state.serverTime;
  let coverage: PreparedLegProtectionCoverage | undefined;
  if (childOrdersComplete && exitFillsComplete) {
    const derived = derivePreparedLegProtectionCoverage({
      execution,
      parent,
      entryFills: entries,
      exitFills: exits,
      children,
      observedAt,
      maxAgeMs: PROVISIONAL_M1_MAX_ACCOUNT_EVIDENCE_AGE_MS,
    });
    if (derived.ok) coverage = derived.value;
    else {
      let reasonCode: string;
      if (!isProducedPreparedLegOrderProof(parent))
        reasonCode = "PROTECTION_PARENT_PROOF_NOT_PRODUCED";
      else if (!execution.leg.intent.protection?.takeProfitPolicy)
        reasonCode = "PROTECTION_TP_POLICY_UNAVAILABLE";
      else if (!matchesPreparedLegOrder(parent, execution))
        reasonCode = "PROTECTION_PARENT_TERMS_MISMATCH";
      else reasonCode = "PROTECTION_COVERAGE_INPUT_INVALID";
      reasons.push(reasonCode);
    }
  }
  return {
    state,
    observedAt,
    children,
    exits,
    ...(coverage === undefined ? {} : { coverage }),
    childOrdersComplete,
    exitFillsComplete,
    positionComplete,
    reasonCodes: [...new Set(reasons)].sort(),
  };
}

function sharedReadStateScopeAndLeverageConflict(
  state: MainnetExchangeReadState,
  instrument: string,
): string | undefined {
  if (
    state.market.instrument !== instrument ||
    state.market.scope.exchange !== "bybit" ||
    state.market.scope.environment !== "mainnet" ||
    state.market.scope.category !== "linear" ||
    state.market.scope.positionMode !== "one-way" ||
    state.position.instrument !== instrument
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
  return undefined;
}

function exactFillPositionConflict(
  state: MainnetExchangeReadState,
  fills: readonly ExchangeFillObservation[],
): string | undefined {
  const zero = DecimalValue.fromString("0");
  if (!zero.ok) return "INVALID_FILL_TOTAL";
  let total = zero.value;
  for (const fill of fills) total = total.add(fill.quantity);
  return exactPositionConflict(state, total);
}

function exactPositionConflict(
  state: MainnetExchangeReadState,
  total: DecimalValue,
): string | undefined {
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

function sameProtectionChildTerms(
  left: ExchangeOrderObservation,
  right: ExchangeOrderObservation,
): boolean {
  return (
    left.exchangeOrderId === right.exchangeOrderId &&
    left.clientOrderId === right.clientOrderId &&
    left.providerOrderLinkId === right.providerOrderLinkId &&
    left.parentOrderLinkId === right.parentOrderLinkId &&
    left.instrument === right.instrument &&
    left.category === right.category &&
    left.side === right.side &&
    left.requestedQuantity.compare(right.requestedQuantity) === 0 &&
    left.filledQuantity.compare(right.filledQuantity) === 0 &&
    left.status === right.status &&
    left.orderType === right.orderType &&
    (left.triggerPrice === undefined
      ? right.triggerPrice === undefined
      : right.triggerPrice !== undefined &&
        left.triggerPrice.compare(right.triggerPrice) === 0) &&
    left.providerStopOrderType === right.providerStopOrderType &&
    left.providerTpslMode === right.providerTpslMode &&
    left.triggerBy === right.triggerBy &&
    left.takeProfitTriggerBy === right.takeProfitTriggerBy &&
    left.providerCreatedAt === right.providerCreatedAt &&
    left.providerUpdatedAt === right.providerUpdatedAt &&
    left.protectionType === right.protectionType &&
    left.reduceOnly === right.reduceOnly &&
    left.positionIdx === right.positionIdx
  );
}

function protectionChildStateConflict(
  state: MainnetExchangeReadState,
  execution: PreparedLegSourceIdentity,
  providerChildren: readonly ExchangeOrderObservation[],
): string | undefined {
  const expectedActive = providerChildren.filter(
    (child) => child.status === "open" || child.status === "partially-filled",
  );
  const observedActive = state.openOrders.filter(
    (order) => order.parentOrderLinkId === execution.clientOrderId,
  );
  const expectedById = new Map<string, ExchangeOrderObservation>();
  for (const child of expectedActive) {
    if (expectedById.has(child.exchangeOrderId))
      return "READ_STATE_PROTECTION_CHILD_MISMATCH";
    expectedById.set(child.exchangeOrderId, child);
  }
  const observedIds = new Set<string>();
  for (const child of observedActive) {
    if (
      observedIds.has(child.exchangeOrderId) ||
      !matchesPreparedLegTakeProfitChild(child, execution)
    )
      return "READ_STATE_PROTECTION_CHILD_MISMATCH";
    observedIds.add(child.exchangeOrderId);
    const providerChild = expectedById.get(child.exchangeOrderId);
    if (!providerChild || !sameProtectionChildTerms(child, providerChild))
      return "READ_STATE_PROTECTION_CHILD_MISMATCH";
  }
  if (observedIds.size !== expectedById.size)
    return "READ_STATE_PROTECTION_CHILD_MISMATCH";
  return undefined;
}

function targetStateConflict(
  dependencies: MainnetPreparedLegDependencies,
  state: MainnetExchangeReadState,
  execution: PreparedLegSourceIdentity,
  proof: PreparedLegOrderProof,
  fills: readonly ExchangeFillObservation[],
  coverage?: PreparedLegProtectionCoverage,
  gridContext?: MainnetPreparedGridReconciliationContext,
  protectionChildren: readonly ExchangeOrderObservation[] = [],
): string | undefined {
  const symbol = execution.leg.intent.instrument;
  if (gridContext)
    return gridTargetStateConflict(
      dependencies,
      state,
      execution,
      proof,
      coverage,
      gridContext,
      protectionChildren,
    );
  const isAttachedTakeProfitChild = (order: ExchangeOrderObservation) =>
    order.parentOrderLinkId === execution.clientOrderId &&
    order.protectionType === "take-profit";
  const scopeAndLeverageConflict = sharedReadStateScopeAndLeverageConflict(
    state,
    symbol,
  );
  if (scopeAndLeverageConflict) return scopeAndLeverageConflict;
  if (
    state.openOrders.some(
      (order) =>
        order.instrument !== symbol ||
        (order.clientOrderId !== execution.clientOrderId &&
          !isAttachedTakeProfitChild(order)),
    )
  )
    return "UNOWNED_TARGET_ORDER_PRESENT";
  const ownedOpenOrders = state.openOrders.filter(
    (order) =>
      order.clientOrderId === execution.clientOrderId &&
      !isAttachedTakeProfitChild(order),
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
  if (proof.filledQuantity.isPositive()) {
    if (!coverage) return "PROTECTION_COVERAGE_UNAVAILABLE";
    const childConflict = protectionChildStateConflict(
      state,
      execution,
      protectionChildren,
    );
    if (childConflict) return childConflict;
    return exactPositionConflict(state, coverage.outstandingQuantity);
  }
  return exactFillPositionConflict(state, fills);
}

function gridTargetStateConflict(
  dependencies: MainnetPreparedLegDependencies,
  state: MainnetExchangeReadState,
  execution: PreparedLegSourceIdentity,
  proof: PreparedLegOrderProof,
  coverage: PreparedLegProtectionCoverage | undefined,
  context: MainnetPreparedGridReconciliationContext,
  protectionChildren: readonly ExchangeOrderObservation[],
): string | undefined {
  const symbol = execution.leg.intent.instrument;
  const scopeAndLeverageConflict = sharedReadStateScopeAndLeverageConflict(
    state,
    symbol,
  );
  if (scopeAndLeverageConflict) return scopeAndLeverageConflict;

  const allowed = new Map<number, PreparedLegExecution>();
  for (const index of context.allowedLegIndexes) {
    const row = context.grid.legs[index];
    if (!row || allowed.has(index)) return "GRID_PREFIX_IDENTITY_INVALID";
    allowed.set(index, row.execution);
  }
  const currentRow =
    context.currentLegIndex === undefined
      ? undefined
      : context.grid.legs[context.currentLegIndex];
  if (
    context.currentLegIndex !== undefined &&
    (!currentRow ||
      currentRow.execution.clientOrderId !== execution.clientOrderId)
  )
    return "GRID_CURRENT_LEG_IDENTITY_MISMATCH";

  const byClientId = new Map(
    [...allowed.values()].map((row) => [row.clientOrderId, row]),
  );
  const siblingEvidence = new Map<number, StoredGridSiblingEvidence>();
  for (const index of context.allowedLegIndexes) {
    if (index === context.currentLegIndex) continue;
    const row = context.grid.legs[index];
    if (!row) return "GRID_PREFIX_IDENTITY_INVALID";
    const evidence = readStoredGridSiblingEvidence(
      dependencies,
      row.sourceId,
      row.execution,
    );
    if (!evidence.ok) return "GRID_SIBLING_EVIDENCE_INVALID";
    siblingEvidence.set(index, evidence.value);
  }
  const parentOrders = new Map<string, ExchangeOrderObservation>();
  const protectionOrderIds = new Set<string>();
  for (const order of state.openOrders) {
    if (order.instrument !== symbol) return "READ_STATE_SCOPE_MISMATCH";
    if (
      order.parentOrderLinkId !== undefined ||
      order.protectionType !== undefined
    ) {
      const parentId = order.parentOrderLinkId;
      if (
        parentId === undefined ||
        order.protectionType !== "take-profit" ||
        !byClientId.has(parentId) ||
        !matchesPreparedLegTakeProfitChild(order, byClientId.get(parentId)!) ||
        protectionOrderIds.has(order.exchangeOrderId)
      )
        return "ATTACHED_PROTECTION_CONTRADICTS_APPROVAL";
      protectionOrderIds.add(order.exchangeOrderId);
      continue;
    }
    const approved = byClientId.get(order.clientOrderId);
    if (!approved) return "UNOWNED_TARGET_ORDER_PRESENT";
    if (parentOrders.has(order.clientOrderId))
      return "DUPLICATE_OWNED_TARGET_ORDER";
    const observed = createPreparedLegOrderProof(order);
    if (!observed.ok || !matchesPreparedLegOrder(observed.value, approved))
      return "READ_STATE_ORDER_CONTRADICTS_RECONCILIATION";
    if (approved.leg.index !== context.currentLegIndex) {
      const prior = siblingEvidence.get(approved.leg.index);
      if (!prior?.proof || !sameOrderObservation(observed.value, prior.proof))
        return "PREFIX_ORDER_NOT_ZERO_FILL";
    } else if (
      observed.value.exchangeOrderId !== proof.exchangeOrderId ||
      observed.value.status !== proof.status ||
      observed.value.filledQuantity.compare(proof.filledQuantity) !== 0
    ) {
      return "READ_STATE_ORDER_CONTRADICTS_RECONCILIATION";
    }
    parentOrders.set(order.clientOrderId, order);
  }

  for (const [index, approved] of allowed) {
    const parent = parentOrders.get(approved.clientOrderId);
    const currentIsTerminalOrFilled =
      index === context.currentLegIndex &&
      (proof.status !== "open" || proof.filledQuantity.isPositive());
    if (!parent) {
      const sibling = siblingEvidence.get(index);
      const siblingIsDurablyTerminalFill =
        (sibling?.status === "PROTECTION_PENDING" ||
          sibling?.status === "UNRESOLVED") &&
        sibling.proof !== undefined &&
        (sibling.proof.status === "filled" ||
          sibling.proof.status === "cancelled") &&
        sibling.proof.filledQuantity.isPositive();
      if (!currentIsTerminalOrFilled && !siblingIsDurablyTerminalFill)
        return "PREFIX_ORDER_NOT_VISIBLE_IN_READ_STATE";
      continue;
    }
  }

  if (proof.filledQuantity.isPositive()) {
    if (!coverage) return "PROTECTION_COVERAGE_UNAVAILABLE";
    const childConflict = protectionChildStateConflict(
      state,
      execution,
      protectionChildren,
    );
    if (childConflict) return childConflict;
  }
  const zero = DecimalValue.fromString("0");
  if (!zero.ok) return "INVALID_FILL_TOTAL";
  const siblingOutstanding = [...siblingEvidence.values()].reduce(
    (total, evidence) => total.add(evidence.outstandingQuantity),
    zero.value,
  );
  const currentOutstanding = coverage?.outstandingQuantity ?? zero.value;
  return exactPositionConflict(
    state,
    siblingOutstanding.add(currentOutstanding),
  );
}

function sameOrderObservation(
  left: PreparedLegOrderProof,
  right: PreparedLegOrderProof,
): boolean {
  return (
    left.exchangeOrderId === right.exchangeOrderId &&
    left.clientOrderId === right.clientOrderId &&
    left.status === right.status &&
    left.filledQuantity.compare(right.filledQuantity) === 0
  );
}

function reviveCanonicalDecimals(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reviveCanonicalDecimals);
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length === 1 && typeof record.$decimal === "string")
    return record.$decimal;
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => [
      key,
      reviveCanonicalDecimals(item),
    ]),
  );
}

function readStoredGridSiblingEvidence(
  dependencies: MainnetPreparedLegDependencies,
  sourceId: string,
  execution: PreparedLegExecution,
): Result<StoredGridSiblingEvidence> {
  const source = dependencies.preparedLegs.readPreparedLegSource(sourceId);
  if (!source.ok) return source;
  const snapshot = source.value;
  const reconciliation = snapshot?.reconciliations.at(-1);
  if (
    !snapshot ||
    snapshot.lineage.sourceId !== sourceId ||
    snapshot.lineage.preparedHash !== execution.preparedHash ||
    snapshot.lineage.legId !== execution.leg.legId ||
    snapshot.lineage.clientOrderId !== execution.clientOrderId ||
    !reconciliation
  )
    return fail(
      domainError("PERSISTENCE_INTEGRITY", "grid sibling source is incomplete"),
    );
  const rawHash =
    "sha256:" +
    createHash("sha256")
      .update(reconciliation.canonicalJson, "utf8")
      .digest("hex");
  if (rawHash !== reconciliation.canonicalHash)
    return fail(
      domainError("PERSISTENCE_INTEGRITY", "grid sibling hash is invalid"),
    );
  let raw: unknown;
  try {
    raw = JSON.parse(reconciliation.canonicalJson) as unknown;
  } catch {
    return fail(
      domainError("PERSISTENCE_INTEGRITY", "grid sibling record is invalid"),
    );
  }
  const record = reviveCanonicalDecimals(raw);
  if (
    !closedRecord(record, [
      "schemaVersion",
      "sourceId",
      "revision",
      "status",
      "observedAt",
      "exchangeOrderId",
      "result",
    ]) ||
    record.schemaVersion !== "prepared-leg-reconciliation/v1" ||
    record.sourceId !== sourceId ||
    record.revision !== reconciliation.revision ||
    record.status !== (reconciliation.legacyStatus ?? reconciliation.status) ||
    record.observedAt !== reconciliation.observedAt ||
    record.exchangeOrderId !== reconciliation.exchangeOrderId ||
    !closedRecord(record.result, ["orderProof", "fills", "reasonCodes"])
  )
    return fail(
      domainError("PERSISTENCE_INTEGRITY", "grid sibling record mismatches"),
    );

  if (
    record.status !== "CONFIRMED_OPEN" &&
    record.status !== "PROTECTION_PENDING" &&
    record.status !== "UNRESOLVED"
  )
    return fail(
      domainError("PERSISTENCE_INTEGRITY", "grid sibling is unresolved"),
    );
  const proofResult = createPreparedLegOrderProof(record.result.orderProof);
  if (
    !proofResult.ok ||
    !matchesPreparedLegOrder(proofResult.value, execution) ||
    proofResult.value.exchangeOrderId !== reconciliation.exchangeOrderId
  )
    return fail(
      domainError(
        "PERSISTENCE_INTEGRITY",
        "grid sibling order proof is invalid",
      ),
    );
  const proof = proofResult.value;
  const rawFills = record.result.fills ?? [];
  if (!Array.isArray(rawFills))
    return fail(
      domainError("PERSISTENCE_INTEGRITY", "grid sibling fills are invalid"),
    );
  const quantities: DecimalValue[] = [];
  const executionIds = new Set<string>();
  for (const fill of rawFills) {
    if (
      !closedRecord(fill, [
        "executionId",
        "quantity",
        "price",
        "executedAt",
        "fee",
        "feeCurrency",
      ]) ||
      typeof fill.executionId !== "string" ||
      executionIds.has(fill.executionId) ||
      !parseUtcTimestamp(fill.executedAt).ok
    )
      return fail(
        domainError("PERSISTENCE_INTEGRITY", "grid sibling fill is invalid"),
      );
    const quantity = DecimalValue.fromString(fill.quantity);
    const price = DecimalValue.fromString(fill.price);
    if (
      !quantity.ok ||
      !quantity.value.isPositive() ||
      !price.ok ||
      !price.value.isPositive()
    )
      return fail(
        domainError("PERSISTENCE_INTEGRITY", "grid sibling fill is invalid"),
      );
    executionIds.add(fill.executionId);
    quantities.push(quantity.value);
  }
  const fillTotal = DecimalValue.fromString("0");
  if (!fillTotal.ok) return fillTotal;
  const total = quantities.reduce(
    (sum, quantity) => sum.add(quantity),
    fillTotal.value,
  );
  const fillStatusConsistent =
    (proof.filledQuantity.isZero() &&
      quantities.length === 0 &&
      (proof.status === "open" ||
        proof.status === "cancelled" ||
        proof.status === "rejected")) ||
    (proof.filledQuantity.isPositive() &&
      total.compare(proof.filledQuantity) === 0 &&
      ((proof.status === "partially-filled" &&
        proof.filledQuantity.compare(proof.requestedQuantity) < 0) ||
        (proof.status === "filled" &&
          proof.filledQuantity.compare(proof.requestedQuantity) === 0) ||
        (proof.status === "cancelled" &&
          proof.filledQuantity.compare(proof.requestedQuantity) < 0)));
  if (
    (record.status === "CONFIRMED_OPEN" &&
      (proof.status !== "open" ||
        !proof.filledQuantity.isZero() ||
        quantities.length > 0)) ||
    (record.status === "PROTECTION_PENDING" &&
      (!proof.filledQuantity.isPositive() || !fillStatusConsistent)) ||
    (record.status === "UNRESOLVED" && !fillStatusConsistent)
  )
    return fail(
      domainError(
        "PERSISTENCE_INTEGRITY",
        "grid sibling fills do not reconcile",
      ),
    );
  const zero = DecimalValue.fromString("0");
  if (!zero.ok) return zero;
  let outstandingQuantity = zero.value;
  if (proof.filledQuantity.isPositive()) {
    const v2 = reconciliation.protectionEvidence;
    const outstanding = DecimalValue.fromString(
      v2?.coverage.outstandingQuantity,
    );
    if (
      !v2 ||
      (v2.status !== "PROTECTION_CONFIRMED" &&
        v2.status !== "VERIFIED_CLOSED") ||
      !v2.coverage.covered ||
      v2.collection.entryFills !== "complete" ||
      v2.collection.childOrders !== "complete" ||
      v2.collection.exitFills !== "complete" ||
      v2.collection.position !== "complete" ||
      !outstanding.ok
    )
      return fail(
        domainError(
          "PERSISTENCE_INTEGRITY",
          "filled grid sibling lacks exact v2 coverage evidence",
        ),
      );
    outstandingQuantity = outstanding.value;
  } else if (
    record.status !== "CONFIRMED_OPEN" ||
    proof.status !== "open" ||
    quantities.length !== 0
  ) {
    return fail(
      domainError(
        "PERSISTENCE_INTEGRITY",
        "zero-fill grid sibling is not a confirmed open parent",
      ),
    );
  }
  return ok({
    status: reconciliation.status,
    proof,
    outstandingQuantity,
  });
}

function ensurePreparedLegCreateAttempt(
  dependencies: MainnetPreparedLegDependencies,
  sourceId: string,
  authority: { readonly ownerRunId: string; readonly epoch: number },
  proof: PreparedLegOrderProof,
): Result<string> {
  const source = dependencies.preparedLegs.readPreparedLegSource(sourceId);
  if (!source.ok) return source;
  if (!source.value)
    return fail(
      domainError("PERSISTENCE_INTEGRITY", "fill source is not durable"),
    );
  const createIntent = source.value.createIntent;
  const existing = source.value.createAttempt;
  if (existing) {
    if (
      existing.operation !== "create" ||
      existing.writeIntentId !== createIntent.writeIntentId
    )
      return fail(
        domainError(
          "PERSISTENCE_INTEGRITY",
          "prepared-leg create attempt does not match its durable intent",
        ),
      );
    return ok(existing.attemptId);
  }
  const recordedAt = parseUtcTimestamp(dependencies.localClock.now());
  if (!recordedAt.ok) return recordedAt;
  const recovered = dependencies.preparedLegs.appendPreparedLegAttempt({
    authority,
    sourceId,
    operation: "create",
    attemptId: `recovered-create-${createIntent.writeIntentId}`,
    result: {
      outcome: proof.status === "rejected" ? "rejected" : "accepted",
      exchangeOrderId: proof.exchangeOrderId,
    },
    recordedAt: recordedAt.value,
  });
  if (!recovered.ok) return recovered;
  if (
    recovered.value.operation !== "create" ||
    recovered.value.writeIntentId !== createIntent.writeIntentId
  )
    return fail(
      domainError(
        "PERSISTENCE_INTEGRITY",
        "recovered create attempt does not match its durable intent",
      ),
    );
  return ok(recovered.value.attemptId);
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
  const attempt = source.value.createAttempt;
  if (
    !attempt ||
    attempt.operation !== "create" ||
    attempt.writeIntentId !== source.value.createIntent.writeIntentId
  )
    return fail(
      domainError(
        "PERSISTENCE_INTEGRITY",
        "fill source has no matching durable create attempt",
      ),
    );
  for (const fill of fills) {
    const persisted = ingestExchangeFillObservation(
      dependencies.persistence,
      dependencies.persistence.scope,
      fill,
      attempt.attemptId,
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
    readonly gridContext?: MainnetPreparedGridReconciliationContext;
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
    return outcome(kind, execution, sourceId, saved.value, [
      safeProviderReason(observed),
    ]);
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
    return outcome(kind, execution, sourceId, saved.value, [
      "ORDER_TERMS_INCOMPLETE",
    ]);
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
  const fills = fillsResult.ok
    ? fillEvidence(fillsResult.value, execution, proof.value.exchangeOrderId)
    : fail(
        domainError(
          "UNRESOLVED_RECONCILIATION",
          "provider fill evidence is unavailable",
        ),
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
  const sourceOrderIdentityProven =
    matches &&
    proof.value.instrument === execution.leg.intent.instrument &&
    (expectedOrderId === undefined ||
      proof.value.exchangeOrderId === expectedOrderId);
  const createAttempt = exactOrder
    ? ensurePreparedLegCreateAttempt(
        dependencies,
        sourceId,
        authority,
        proof.value,
      )
    : ok<string | undefined>(undefined);
  const createAttemptMissing =
    exactOrder && (!createAttempt.ok || createAttempt.value === undefined);
  const stateConflict =
    fillsResult.ok &&
    fills.ok &&
    exactOrder &&
    proof.value.filledQuantity.isZero()
      ? targetStateConflict(
          dependencies,
          readState.value,
          execution,
          proof.value,
          fillsResult.value,
          undefined,
          options.gridContext,
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
  let accounting: Result<void> = ok(undefined);
  if (
    exactOrder &&
    fillsResult.ok &&
    fills.ok &&
    exactFillTotal &&
    filledQuantity.isPositive()
  ) {
    if (!createAttempt.ok) accounting = fail(createAttempt.error);
    else if (createAttempt.value === undefined)
      accounting = fail(
        domainError(
          "PERSISTENCE_INTEGRITY",
          "exact order has no durable create attempt identity",
        ),
      );
    else
      accounting = persistEntryAccounting(
        dependencies,
        sourceId,
        fillsResult.value,
      );
  }
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
  let protectionEvidence: PreparedLegProtectionEvidenceV2Input | undefined;
  let reconciliationObservedAt = proofObservedAt;
  const positiveFillProblems = [
    ...(options.forceUnresolvedReason === undefined
      ? []
      : [options.forceUnresolvedReason]),
    ...(createAttemptMissing ? ["CREATE_ATTEMPT_PERSISTENCE_FAILED"] : []),
    ...(!fillsResult.ok ? [safeProviderReason(fillsResult)] : []),
    ...(fillsResult.ok && !fills.ok ? ["FILL_IDENTITY_INVALID"] : []),
    ...(!exactFillTotal ? ["FILL_TOTAL_MISMATCH"] : []),
    ...(!filledStatusConsistent ? ["ORDER_STATUS_FILL_QUANTITY_CONFLICT"] : []),
    ...(!accounting.ok ? ["ENTRY_ACCOUNTING_PERSISTENCE_FAILED"] : []),
  ];
  const persistPendingProtection =
    filledQuantity.isPositive() &&
    sourceOrderIdentityProven &&
    positiveFillProblems.length > 0;
  if (persistPendingProtection) {
    const entries = fills.ok && fillsResult.ok ? fillsResult.value : [];
    const entryFillsComplete = fills.ok && exactFillTotal;
    const protectionReads = await collectFilledProtectionReads(
      dependencies,
      execution,
      proof.value,
      entries,
      readState.value,
    );
    reconciliationObservedAt = protectionReads.observedAt;
    const reasons = [
      ...positiveFillProblems,
      ...protectionReads.reasonCodes,
      ...(protectionReads.coverage?.reasonCodes ?? []),
    ];
    status = "PROTECTION_PENDING";
    result = {
      orderProof: proof.value,
      ...(fills.ok ? { fills: fills.value } : {}),
      reasonCodes: [...new Set(reasons)].sort(),
    };
    protectionEvidence = createProtectionEvidenceV2({
      execution,
      parent: proof.value,
      entries,
      exits: protectionReads.exits,
      children: protectionReads.children,
      ...(protectionReads.coverage === undefined
        ? {}
        : { coverage: protectionReads.coverage }),
      state: protectionReads.state,
      observedAt: protectionReads.observedAt,
      status: "PROTECTION_PENDING",
      entryFillsComplete,
      childOrdersComplete: protectionReads.childOrdersComplete,
      exitFillsComplete: protectionReads.exitFillsComplete,
      positionComplete: protectionReads.positionComplete,
      reasonCodes: reasons,
    });
  } else if (
    !exactOrder ||
    createAttemptMissing ||
    (filledQuantity.isZero() &&
      (!fills.ok || !exactFillTotal || stateConflict !== undefined))
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
              : !exactFillTotal
                ? "FILL_TOTAL_MISMATCH"
                : !filledStatusConsistent
                  ? "ORDER_STATUS_FILL_QUANTITY_CONFLICT"
                  : !accounting.ok
                    ? "ENTRY_ACCOUNTING_PERSISTENCE_FAILED"
                    : "CREATE_ATTEMPT_PERSISTENCE_FAILED"),
      ],
    };
  } else if (filledQuantity.isPositive()) {
    if (fills.ok && fillsResult.ok) {
      const protectionReads = await collectFilledProtectionReads(
        dependencies,
        execution,
        proof.value,
        fillsResult.value,
        readState.value,
      );
      reconciliationObservedAt = protectionReads.observedAt;
      const filledStateConflict =
        protectionReads.positionComplete && protectionReads.coverage
          ? targetStateConflict(
              dependencies,
              protectionReads.state,
              execution,
              proof.value,
              fillsResult.value,
              protectionReads.coverage,
              options.gridContext,
              protectionReads.children,
            )
          : undefined;
      const priorReconciliation = sourceSnapshot.value.reconciliations.at(-1);
      const legacyPendingNeedsReview =
        priorReconciliation?.status === "PROTECTION_PENDING" &&
        priorReconciliation.protectionEvidence === undefined;
      const cancelStillOpen =
        cancelPending &&
        proof.value.status !== "cancelled" &&
        proof.value.status !== "filled";
      const reasons = [
        ...protectionReads.reasonCodes,
        ...(protectionReads.coverage?.reasonCodes ?? []),
        ...(filledStateConflict ? [filledStateConflict] : []),
        ...(legacyPendingNeedsReview
          ? ["LEGACY_PROTECTION_PENDING_REQUIRES_REVIEW"]
          : []),
        ...(cancelStillOpen ? ["CANCEL_NOT_TERMINAL"] : []),
      ];
      const canConfirm =
        filledStatusConsistent &&
        exactFillTotal &&
        accounting.ok &&
        protectionReads.positionComplete &&
        protectionReads.childOrdersComplete &&
        protectionReads.exitFillsComplete &&
        protectionReads.coverage?.covered === true &&
        filledStateConflict === undefined &&
        !legacyPendingNeedsReview &&
        !cancelStillOpen;
      const isClosed =
        canConfirm &&
        protectionReads.coverage?.outstandingQuantity.isZero() === true;
      status = canConfirm
        ? isClosed
          ? "VERIFIED_CLOSED"
          : "PROTECTION_CONFIRMED"
        : "PROTECTION_PENDING";
      if (status === "PROTECTION_PENDING" && reasons.length === 0)
        reasons.push("PROTECTION_COVERAGE_UNVERIFIED");
      result = {
        orderProof: proof.value,
        fills: fills.value,
        ...(reasons.length === 0
          ? {}
          : { reasonCodes: [...new Set(reasons)].sort() }),
      };
      protectionEvidence = createProtectionEvidenceV2({
        execution,
        parent: proof.value,
        entries: fillsResult.value,
        exits: protectionReads.exits,
        children: protectionReads.children,
        ...(protectionReads.coverage === undefined
          ? {}
          : { coverage: protectionReads.coverage }),
        state: protectionReads.state,
        observedAt: protectionReads.observedAt,
        status:
          status === "PROTECTION_CONFIRMED" || status === "VERIFIED_CLOSED"
            ? status
            : "PROTECTION_PENDING",
        entryFillsComplete: fills.ok,
        childOrdersComplete: protectionReads.childOrdersComplete,
        exitFillsComplete: protectionReads.exitFillsComplete,
        positionComplete: protectionReads.positionComplete,
        reasonCodes: status === "PROTECTION_PENDING" ? reasons : [],
      });
    } else {
      const protectionReads = await collectFilledProtectionReads(
        dependencies,
        execution,
        proof.value,
        [],
        readState.value,
      );
      reconciliationObservedAt = protectionReads.observedAt;
      status = "PROTECTION_PENDING";
      result = {
        orderProof: proof.value,
        reasonCodes: [
          safeProviderReason(fillsResult),
          "ENTRY_FILLS_INCOMPLETE",
        ],
      };
      protectionEvidence = createProtectionEvidenceV2({
        execution,
        parent: proof.value,
        entries: [],
        exits: protectionReads.exits,
        children: protectionReads.children,
        ...(protectionReads.coverage === undefined
          ? {}
          : { coverage: protectionReads.coverage }),
        state: protectionReads.state,
        observedAt: protectionReads.observedAt,
        status: "PROTECTION_PENDING",
        entryFillsComplete: false,
        childOrdersComplete: protectionReads.childOrdersComplete,
        exitFillsComplete: protectionReads.exitFillsComplete,
        positionComplete: protectionReads.positionComplete,
        reasonCodes: [
          safeProviderReason(fillsResult),
          "ENTRY_FILLS_INCOMPLETE",
          ...protectionReads.reasonCodes,
        ],
      });
    }
  } else if (!fills.ok) {
    status = "UNRESOLVED";
    result = {
      orderProof: proof.value,
      reasonCodes: [safeProviderReason(fillsResult)],
    };
  } else if (fills.value.length !== 0 || !exactFillTotal) {
    status = "UNRESOLVED";
    result = {
      orderProof: proof.value,
      fills: fills.value,
      reasonCodes: ["ZERO_FILL_PARENT_HAS_EXECUTIONS"],
    };
  } else if (proof.value.status === "open") {
    status = cancelPending ? "UNRESOLVED" : "CONFIRMED_OPEN";
    result = cancelPending
      ? { orderProof: proof.value, reasonCodes: ["CANCEL_NOT_TERMINAL"] }
      : { orderProof: proof.value };
  } else if (proof.value.status === "cancelled") {
    status = "CANCELLED";
    result = { orderProof: proof.value };
  } else if (proof.value.status === "rejected") {
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
    observedAt: reconciliationObservedAt,
    exchangeOrderId: proof.value.exchangeOrderId,
    result,
    ...(protectionEvidence === undefined ? {} : { protectionEvidence }),
  });
  if (!saved.ok) return saved;
  const final = outcome(
    kind,
    execution,
    sourceId,
    saved.value,
    result.reasonCodes ?? [],
  );
  if (
    options.gridContext === undefined &&
    (status === "CONFIRMED_OPEN" ||
      status === "CANCELLED" ||
      status === "REJECTED")
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
  reasonCodes: readonly string[] = [],
): Result<MainnetPreparedLegOutcome> {
  return ok({
    kind,
    sourceId,
    clientOrderId: execution.clientOrderId,
    status: reconciliation.status,
    reconciliationRevision: reconciliation.revision,
    reasonCodes,
  });
}

/** Executes only the exact unexpired approval leg; recovery is a separate read-only API. */
async function createMainnetPreparedLegInternal(
  input: unknown,
  dependencies: MainnetPreparedLegCreateDependencies,
  gridContext?: MainnetPreparedGridCreateContext,
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
  if (gridContext) {
    const selected = gridContext.grid.legs[gridContext.currentLegIndex];
    const expectedSourceId = derivePreparedLegSourceId(
      identity.value.accountIdentityHash,
      identity.value.preparedHash,
      identity.value.leg.legId,
    );
    if (
      !expectedSourceId.ok ||
      !selected ||
      gridContext.grid.approvalHash !== approvalHash.value ||
      gridContext.grid.preparedHash !== identity.value.preparedHash ||
      selected.execution.approvalHash !== approvalHash.value ||
      selected.execution.leg.legId !== legId.value ||
      selected.execution.clientOrderId !== identity.value.clientOrderId ||
      selected.sourceId !== expectedSourceId.value
    )
      return blocked("GRID_CREATE_IDENTITY_MISMATCH");
  }
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
  if (gridContext) {
    const journalPosition = validateGridJournalPosition(
      dependencies,
      gridContext,
      runId.value,
      lease.value.epoch,
    );
    if (!journalPosition.ok) return journalPosition;
  }
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
  if (gridContext) {
    const canonicalGrid = createPreparedLegGridExecution({
      approval: loaded.value,
      approvalHash: approvalHash.value,
      now: evidence.state.serverTime,
    });
    const expectedHash = canonicalGrid.ok
      ? hashCanonical(canonicalGrid.value)
      : canonicalGrid;
    const providedHash = hashCanonical(gridContext.grid);
    if (
      !canonicalGrid.ok ||
      !expectedHash.ok ||
      !providedHash.ok ||
      expectedHash.value !== providedHash.value
    )
      return blocked("GRID_CREATE_IDENTITY_MISMATCH");
  }
  const eligible = validateCurrentEvidence(
    evidence,
    execution.value,
    gridContext,
  );
  if (!eligible.ok) return eligible;
  if (gridContext) {
    const liveEvidence = {
      readiness: evidence.readiness,
      state: {
        serverTime: evidence.state.serverTime,
        symbol: evidence.state.market.instrument,
        position: evidence.state.position,
        leverage: evidence.state.leverage,
        market: evidence.state.market,
        openOrders: evidence.state.openOrders,
      },
    };
    const capacity = createPreparedGridCapacity({
      approval: loaded.value,
      approvalHash: approvalHash.value,
      account: evidence.account,
      liveEvidence,
      nextLegIndex: gridContext.currentLegIndex,
      supplementalEvidence: [],
      evaluationTime: evidence.state.serverTime,
    });
    if (
      !capacity.ok ||
      capacity.value.status !== "pass" ||
      capacity.value.execution.clientOrderId !==
        execution.value.clientOrderId ||
      capacity.value.accountEvidenceHash !==
        evidence.readiness.internalBinding?.accountEvidenceHash
    )
      return blocked(
        capacity.ok
          ? `GRID_CAPACITY_BLOCKED:${capacity.value.reasonCodes.join(",")}`
          : "GRID_CAPACITY_EVIDENCE_INVALID",
      );
  }
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
      ...(gridContext === undefined
        ? {}
        : {
            gridContext: {
              grid: gridContext.grid,
              allowedLegIndexes: gridContext.grid.legs
                .slice(0, gridContext.currentLegIndex + 1)
                .map((row) => row.execution.leg.index),
              currentLegIndex: gridContext.currentLegIndex,
            },
          }),
    },
  );
}

/** Standalone #21 entry point: one exact approved leg, clean target only. */
export async function createMainnetPreparedLeg(
  input: unknown,
  dependencies: MainnetPreparedLegCreateDependencies,
): Promise<Result<MainnetPreparedLegOutcome>> {
  return createMainnetPreparedLegInternal(input, dependencies);
}

/** Internal #46 seam; only the grid coordinator supplies its checked prefix. */
export async function createMainnetPreparedLegForGrid(
  input: unknown,
  dependencies: MainnetPreparedLegCreateDependencies,
  context: MainnetPreparedGridCreateContext,
): Promise<Result<MainnetPreparedLegOutcome>> {
  return createMainnetPreparedLegInternal(input, dependencies, context);
}

/** Read-only recovery resolves source identity without a current approval lookup. */
export async function recoverMainnetPreparedLegSource(
  input: unknown,
  dependencies: MainnetPreparedLegCreateDependencies,
): Promise<Result<MainnetPreparedLegOutcome>> {
  return recoverMainnetPreparedLegSourceInternal(input, dependencies);
}

/** Internal recovery seam for a source already admitted by the grid journal. */
export async function recoverMainnetPreparedLegSourceForGrid(
  input: unknown,
  dependencies: MainnetPreparedLegCreateDependencies,
  gridContext: MainnetPreparedGridReconciliationContext,
): Promise<Result<MainnetPreparedLegOutcome>> {
  return recoverMainnetPreparedLegSourceInternal(
    input,
    dependencies,
    gridContext,
  );
}

async function recoverMainnetPreparedLegSourceInternal(
  input: unknown,
  dependencies: MainnetPreparedLegCreateDependencies,
  gridContext?: MainnetPreparedGridReconciliationContext,
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
      ...(gridContext === undefined ? {} : { gridContext }),
    },
  );
}
