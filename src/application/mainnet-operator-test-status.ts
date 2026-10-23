import { randomUUID } from "node:crypto";

import type { OperatorMainnetTestPlan } from "../domain/execution/operator-mainnet-test-plan.js";
import type { ExchangeFillObservation } from "../domain/execution/exchange-fill.js";
import type { ExchangeOrderObservation } from "../domain/execution/exchange-order.js";
import { DecimalValue } from "../domain/shared/decimal.js";
import { domainError } from "../domain/shared/errors.js";
import { fail, ok, type Result } from "../domain/shared/result.js";
import {
  parseUtcTimestamp,
  timestampToEpochMs,
  type Clock,
  type UtcTimestamp,
} from "../domain/shared/time.js";
import { requireIdentifier } from "../domain/shared/validation.js";
import type {
  OperatorMainnetTestCleanupStatus,
  OperatorMainnetTestLifecycleOutcome,
  OperatorMainnetTestManualAction,
  OperatorMainnetTestPersistencePort,
  OperatorMainnetTestSnapshot,
} from "../ports/operator-mainnet-test-persistence.js";
import type {
  HaltState,
  LeaseAuthority,
  PersistencePort,
} from "../ports/persistence.js";

const LEASE_TTL_MS = 60_000;
const MAX_OBSERVATION_AGE_MS = 60_000;

export interface MainnetOperatorTestPosition {
  readonly instrument: string;
  readonly side: "long" | "short" | "flat";
  readonly quantity: DecimalValue;
}

export interface MainnetOperatorTestChildFills {
  readonly exchangeOrderId: string;
  readonly clientOrderId: string;
  readonly fills: readonly ExchangeFillObservation[];
}

/** Read projection deliberately contains no exchange mutation capability. */
export interface MainnetOperatorTestStatusObservation {
  readonly observedAt: UtcTimestamp;
  readonly parentLookupComplete: boolean;
  readonly parent?: ExchangeOrderObservation;
  readonly entryFills: readonly ExchangeFillObservation[];
  readonly children: readonly ExchangeOrderObservation[];
  readonly childFills: readonly MainnetOperatorTestChildFills[];
  readonly position: MainnetOperatorTestPosition;
  readonly activeOrders: readonly ExchangeOrderObservation[];
  readonly exchangeReads: number;
}

export interface MainnetOperatorTestStatusExchangePort {
  observe(
    plan: OperatorMainnetTestPlan,
    exchangeOrderId?: string,
  ): Promise<Result<MainnetOperatorTestStatusObservation>>;
}

export interface MainnetOperatorTestStatusDependencies {
  readonly persistence: PersistencePort;
  readonly journal: OperatorMainnetTestPersistencePort;
  readonly exchange: MainnetOperatorTestStatusExchangePort;
  readonly clock: Clock;
}

export interface MainnetOperatorTestStatusInput {
  readonly sourceId: unknown;
  readonly manualAction?: OperatorMainnetTestManualAction;
  readonly actor?: unknown;
}

export interface MainnetOperatorTestStatusResult {
  readonly sourceId: string;
  readonly lifecycleOutcome: OperatorMainnetTestLifecycleOutcome;
  readonly cleanupStatus: OperatorMainnetTestCleanupStatus;
  readonly exchangeReads: number;
  readonly journaled: boolean;
  readonly latestSnapshot: OperatorMainnetTestSnapshot;
  readonly halt: HaltState;
  readonly reasons: readonly string[];
}

interface Classification {
  readonly lifecycleOutcome: OperatorMainnetTestLifecycleOutcome;
  readonly cleanupStatus: OperatorMainnetTestCleanupStatus;
  readonly reasons: readonly string[];
  readonly evidence: Record<string, unknown>;
}

function invalid(message: string) {
  return fail(domainError("INVALID_VALUE", message));
}

function active(order: ExchangeOrderObservation): boolean {
  return order.status === "open" || order.status === "partially-filled";
}

function zero(): DecimalValue {
  const parsed = DecimalValue.fromString("0");
  if (!parsed.ok) throw new Error("zero decimal is invalid");
  return parsed.value;
}

function sameDecimal(
  left: DecimalValue | undefined,
  right: DecimalValue,
): boolean {
  return left !== undefined && left.compare(right) === 0;
}

function quantitySum(
  fills: readonly ExchangeFillObservation[],
  expected: {
    readonly instrument: string;
    readonly side: "buy" | "sell";
    readonly exchangeOrderId: string;
    readonly clientOrderId: string;
    readonly allowEmptyClientOrderId?: boolean;
  },
):
  | { readonly quantity: DecimalValue; readonly ids: readonly string[] }
  | undefined {
  const zero = DecimalValue.fromString("0");
  if (!zero.ok) return undefined;
  let quantity = zero.value;
  const ids = new Set<string>();
  for (const fill of fills) {
    const clientOrderIdMatches =
      fill.clientOrderId === expected.clientOrderId ||
      (expected.allowEmptyClientOrderId === true &&
        fill.clientOrderId === "" &&
        fill.exchangeOrderId === expected.exchangeOrderId);
    if (
      !requireIdentifier(fill.executionId, "executionId").ok ||
      !requireIdentifier(fill.exchangeOrderId, "exchangeOrderId").ok ||
      (fill.clientOrderId !== "" &&
        !requireIdentifier(fill.clientOrderId, "clientOrderId").ok) ||
      (fill.clientOrderId === "" &&
        expected.allowEmptyClientOrderId !== true) ||
      ids.has(fill.executionId) ||
      fill.instrument !== expected.instrument ||
      fill.side !== expected.side ||
      fill.exchangeOrderId !== expected.exchangeOrderId ||
      !clientOrderIdMatches ||
      !fill.quantity.isPositive() ||
      !fill.price.isPositive()
    )
      return undefined;
    ids.add(fill.executionId);
    quantity = quantity.add(fill.quantity);
  }
  return { quantity, ids: [...ids].sort() };
}

function orderMatchesPlan(
  order: ExchangeOrderObservation,
  plan: OperatorMainnetTestPlan,
): boolean {
  return (
    order.clientOrderId === plan.clientOrderId &&
    order.instrument === plan.symbol &&
    order.category === "linear" &&
    order.side === "buy" &&
    order.requestedQuantity.compare(plan.entry.quantity) === 0 &&
    order.orderType === "limit" &&
    sameDecimal(order.price, plan.entry.limitPrice) &&
    order.timeInForce === "GTC" &&
    sameDecimal(
      order.takeProfit ?? undefined,
      plan.entry.takeProfit.triggerPrice,
    ) &&
    (order.stopLoss === null || order.stopLoss === undefined) &&
    order.reduceOnly === false &&
    order.positionIdx === 0
  );
}

function childMatchesPlan(
  child: ExchangeOrderObservation,
  plan: OperatorMainnetTestPlan,
  observedAt: UtcTimestamp,
): boolean {
  const createdAt = child.providerCreatedAt
    ? timestampToEpochMs(child.providerCreatedAt)
    : Number.NaN;
  const updatedAt = child.providerUpdatedAt
    ? timestampToEpochMs(child.providerUpdatedAt)
    : Number.NaN;
  const observed = timestampToEpochMs(observedAt);
  return (
    child.clientOrderId === child.providerOrderLinkId &&
    child.parentOrderLinkId === plan.clientOrderId &&
    child.instrument === plan.symbol &&
    child.category === "linear" &&
    child.protectionType === "take-profit" &&
    child.providerStopOrderType === "PartialTakeProfit" &&
    child.providerTpslMode === "Partial" &&
    child.side === "sell" &&
    child.requestedQuantity.isPositive() &&
    child.requestedQuantity.compare(plan.entry.quantity) <= 0 &&
    child.orderType === "market" &&
    child.price === undefined &&
    sameDecimal(child.triggerPrice, plan.entry.takeProfit.triggerPrice) &&
    child.takeProfitTriggerBy === "LastPrice" &&
    (child.triggerBy === undefined || child.triggerBy === "LastPrice") &&
    child.reduceOnly === true &&
    child.positionIdx === 0 &&
    child.stopLoss === null &&
    Number.isFinite(createdAt) &&
    Number.isFinite(updatedAt) &&
    createdAt <= updatedAt &&
    updatedAt <= observed &&
    (child.status === "open" ||
      child.status === "partially-filled" ||
      child.status === "filled" ||
      child.status === "cancelled" ||
      child.status === "rejected")
  );
}

function freshOrder(
  order: ExchangeOrderObservation,
  observedAt: UtcTimestamp,
): boolean {
  const observed = timestampToEpochMs(observedAt);
  if (!order.providerCreatedAt || !order.providerUpdatedAt) return false;
  const providerCreated = timestampToEpochMs(order.providerCreatedAt);
  const providerUpdated = timestampToEpochMs(order.providerUpdatedAt);
  return (
    timestampToEpochMs(order.observedAt) <= observed &&
    observed - timestampToEpochMs(order.observedAt) <= MAX_OBSERVATION_AGE_MS &&
    // Provider timestamps describe order events, which may precede this fresh
    // REST observation by minutes or longer for historical or unchanged orders.
    providerCreated <= providerUpdated &&
    providerUpdated <= observed
  );
}

function executionTimelineIsValid(
  observation: MainnetOperatorTestStatusObservation,
): boolean {
  const observedAt = timestampToEpochMs(observation.observedAt);
  const parentCreatedAt = observation.parent?.providerCreatedAt
    ? timestampToEpochMs(observation.parent.providerCreatedAt)
    : undefined;
  const children = new Map(
    observation.children.map((child) => [child.exchangeOrderId, child]),
  );
  const events: {
    readonly at: number;
    readonly kind: "entry" | "exit";
    readonly quantity: DecimalValue;
  }[] = [];

  for (const fill of observation.entryFills) {
    const executedAt = parseUtcTimestamp(fill.executedAt);
    if (
      !executedAt.ok ||
      timestampToEpochMs(executedAt.value) > observedAt ||
      (parentCreatedAt !== undefined &&
        timestampToEpochMs(executedAt.value) < parentCreatedAt)
    )
      return false;
    events.push({
      at: timestampToEpochMs(executedAt.value),
      kind: "entry",
      quantity: fill.quantity,
    });
  }

  for (const group of observation.childFills) {
    const child = children.get(group.exchangeOrderId);
    if (!child?.providerCreatedAt) return false;
    const childCreatedAt = timestampToEpochMs(child.providerCreatedAt);
    for (const fill of group.fills) {
      const executedAt = parseUtcTimestamp(fill.executedAt);
      if (
        !executedAt.ok ||
        timestampToEpochMs(executedAt.value) > observedAt ||
        timestampToEpochMs(executedAt.value) < childCreatedAt
      )
        return false;
      events.push({
        at: timestampToEpochMs(executedAt.value),
        kind: "exit",
        quantity: fill.quantity,
      });
    }
  }

  // If provider timestamps have only millisecond precision, count exits before
  // same-millisecond entries so ambiguous ordering cannot prove protection.
  events.sort(
    (left, right) =>
      left.at - right.at ||
      (left.kind === right.kind ? 0 : left.kind === "exit" ? -1 : 1),
  );
  let entered = zero();
  let exited = zero();
  for (const event of events) {
    if (event.kind === "entry") {
      entered = entered.add(event.quantity);
    } else {
      exited = exited.add(event.quantity);
      if (exited.compare(entered) > 0) return false;
    }
  }
  return true;
}

function classify(
  snapshot: OperatorMainnetTestSnapshot,
  observation: MainnetOperatorTestStatusObservation,
): Classification {
  const plan = snapshot.plan;
  const reasons = new Set<string>();
  if (!executionTimelineIsValid(observation))
    reasons.add("EXECUTION_TIMELINE_INVALID");
  const relatedOpenOrders = observation.activeOrders.filter(
    (order) =>
      active(order) &&
      (order.clientOrderId === plan.clientOrderId ||
        order.parentOrderLinkId === plan.clientOrderId),
  );
  const parent = observation.parent;
  if (!observation.parentLookupComplete) reasons.add("ORDER_LOOKUP_INCOMPLETE");
  if (
    parent &&
    (!orderMatchesPlan(parent, plan) ||
      !freshOrder(parent, observation.observedAt))
  )
    reasons.add("PARENT_PROOF_INVALID_OR_STALE");
  if (
    observation.position.instrument !== plan.symbol ||
    observation.position.quantity.isNegative() ||
    (observation.position.side === "flat" &&
      !observation.position.quantity.isZero()) ||
    (observation.position.side !== "flat" &&
      !observation.position.quantity.isPositive())
  )
    reasons.add("POSITION_PROOF_INVALID");

  const parentId = parent?.exchangeOrderId ?? snapshot.attempt?.exchangeOrderId;
  const entry = parentId
    ? quantitySum(observation.entryFills, {
        instrument: plan.symbol,
        side: "buy",
        exchangeOrderId: parentId,
        clientOrderId: plan.clientOrderId,
        allowEmptyClientOrderId: true,
      })
    : observation.entryFills.length === 0
      ? {
          quantity: zero(),
          ids: [] as readonly string[],
        }
      : undefined;
  if (!entry) reasons.add("ENTRY_FILL_ATTRIBUTION_INVALID");
  if (parent && entry && parent.filledQuantity.compare(entry.quantity) !== 0)
    reasons.add("ENTRY_FILL_TOTAL_MISMATCH");

  const childIds = new Set<string>();
  if (observation.children.length > 1)
    reasons.add("DUPLICATE_OR_STRAY_TP_CHILD");
  for (const child of observation.children) {
    if (
      childIds.has(child.exchangeOrderId) ||
      !childMatchesPlan(child, plan, observation.observedAt) ||
      !freshOrder(child, observation.observedAt)
    )
      reasons.add("TP_CHILD_PROOF_INVALID_OR_DUPLICATE");
    childIds.add(child.exchangeOrderId);
  }

  const exitIds = new Set<string>();
  let exitQuantity = zero();
  let exitProofValid = true;
  for (const child of observation.children) {
    const childFills = observation.childFills.filter(
      (row) => row.exchangeOrderId === child.exchangeOrderId,
    );
    // An active TP can exist before any execution is reported. Missing fill
    // attribution is neutral only while the child itself proves zero fills.
    if (childFills.length === 0 && child.filledQuantity.isZero()) continue;
    if (
      childFills.length !== 1 ||
      childFills[0]?.clientOrderId !== child.clientOrderId
    ) {
      exitProofValid = false;
      continue;
    }
    const sum = quantitySum(childFills[0]!.fills, {
      instrument: plan.symbol,
      side: "sell",
      exchangeOrderId: child.exchangeOrderId,
      clientOrderId: child.clientOrderId,
      allowEmptyClientOrderId: true,
    });
    if (!sum || sum.quantity.compare(child.filledQuantity) !== 0) {
      exitProofValid = false;
      continue;
    }
    for (const id of sum.ids) {
      if (exitIds.has(id) || (entry && entry.ids.includes(id)))
        exitProofValid = false;
      exitIds.add(id);
    }
    exitQuantity = exitQuantity.add(sum.quantity);
  }
  if (
    observation.childFills.some((row) => !childIds.has(row.exchangeOrderId)) ||
    !exitProofValid
  )
    reasons.add("TP_EXIT_FILL_ATTRIBUTION_INVALID");

  const activeChild = observation.children.some(active);
  const openParent = parent !== undefined && active(parent);
  const flat =
    observation.position.side === "flat" &&
    observation.position.quantity.isZero();
  const cleanupIsProven =
    reasons.size === 0 &&
    !openParent &&
    !activeChild &&
    relatedOpenOrders.length === 0 &&
    flat;
  const manualActions = snapshot.manualActions.map((row) => row.action);
  const manualPositionClose = manualActions.includes("position-closed");
  const unclassifiedManualAction = manualActions.includes("other");

  if (
    parent &&
    entry &&
    entry.quantity.isPositive() &&
    observation.children.length === 0 &&
    !manualPositionClose
  )
    reasons.add("TP_CHILD_MISSING_FOR_FILLED_ENTRY");
  if (
    parent &&
    observation.children.length === 1 &&
    observation.children[0]!.requestedQuantity.compare(
      parent.filledQuantity,
    ) !== 0
  )
    reasons.add("TP_CHILD_QUANTITY_MISMATCH");
  if (entry && exitQuantity.compare(entry.quantity) > 0)
    reasons.add("TP_EXIT_EXCEEDS_ENTRY_QUANTITY");
  if (entry && !manualPositionClose && reasons.size === 0) {
    const remainingEntry = entry.quantity.subtract(exitQuantity);
    const expectedSide = remainingEntry.isZero() ? "flat" : "long";
    if (
      observation.position.quantity.compare(remainingEntry) !== 0 ||
      observation.position.side !== expectedSide
    )
      reasons.add("POSITION_EXIT_MISMATCH");
  }

  let lifecycleOutcome: OperatorMainnetTestLifecycleOutcome = "UNKNOWN";
  let cleanupStatus: OperatorMainnetTestCleanupStatus = reasons.size
    ? "unknown"
    : openParent || activeChild || relatedOpenOrders.length > 0 || !flat
      ? "pending"
      : "verified-clean";

  const hasProvenZeroEntryFills =
    entry !== undefined &&
    entry.quantity.isZero() &&
    (parent === undefined
      ? snapshot.attempt?.outcome === "rejected" &&
        observation.parentLookupComplete
      : parent.filledQuantity.isZero());
  if (reasons.size === 0 && hasProvenZeroEntryFills) {
    lifecycleOutcome = "NOT_EXERCISED";
  } else if (reasons.size === 0 && manualPositionClose) {
    lifecycleOutcome = "MANUAL_CLEANUP";
  } else if (reasons.size === 0 && unclassifiedManualAction) {
    lifecycleOutcome = "UNKNOWN";
    cleanupStatus = "unknown";
    reasons.add("MANUAL_ACTION_ATTRIBUTION_UNSUPPORTED");
  } else if (
    reasons.size === 0 &&
    entry !== undefined &&
    entry.quantity.isPositive() &&
    observation.children.length === 1
  ) {
    if (
      exitQuantity.compare(entry.quantity) === 0 &&
      cleanupIsProven &&
      !manualPositionClose
    ) {
      lifecycleOutcome = "TP_LIFECYCLE_PASS";
      cleanupStatus = "verified-clean";
    } else {
      lifecycleOutcome = "PARTIAL_EVIDENCE";
    }
  }

  if (reasons.size > 0) cleanupStatus = "unknown";
  const displayedEntry = entry?.quantity.toString() ?? "unknown";
  return {
    lifecycleOutcome,
    cleanupStatus,
    reasons: [...reasons].sort(),
    evidence: {
      schemaVersion: "operator-mainnet-test-status-evidence/v1",
      observedAt: observation.observedAt,
      exchangeReads: observation.exchangeReads,
      parent: parent
        ? {
            exchangeOrderId: parent.exchangeOrderId,
            clientOrderId: parent.clientOrderId,
            status: parent.status,
            requestedQuantity: parent.requestedQuantity.toString(),
            filledQuantity: parent.filledQuantity.toString(),
            remainingQuantity: parent.requestedQuantity
              .subtract(parent.filledQuantity)
              .toString(),
          }
        : null,
      entryFills: observation.entryFills.map((fill) => ({
        executionId: fill.executionId,
        exchangeOrderId: fill.exchangeOrderId,
        quantity: fill.quantity.toString(),
        price: fill.price.toString(),
        executedAt: fill.executedAt,
        ...(fill.fee === undefined ? {} : { fee: fill.fee.toString() }),
        ...(fill.feeCurrency === undefined
          ? {}
          : { feeCurrency: fill.feeCurrency }),
      })),
      tpChildren: observation.children.map((child) => ({
        exchangeOrderId: child.exchangeOrderId,
        clientOrderId: child.clientOrderId,
        status: child.status,
        requestedQuantity: child.requestedQuantity.toString(),
        filledQuantity: child.filledQuantity.toString(),
        triggerPrice: child.triggerPrice?.toString() ?? null,
        providerStopOrderType: child.providerStopOrderType ?? null,
        providerTpslMode: child.providerTpslMode ?? null,
      })),
      tpExitExecutionIds: [...exitIds].sort(),
      tpExitQuantity: exitQuantity.toString(),
      executedEntryQuantity: displayedEntry,
      position: {
        instrument: observation.position.instrument,
        side: observation.position.side,
        quantity: observation.position.quantity.toString(),
      },
      activeOwnedOrderIds: relatedOpenOrders
        .map((order) => order.exchangeOrderId)
        .sort(),
      manualActions,
      reasons: [...reasons].sort(),
    },
  };
}

function statusAuthority(
  persistence: PersistencePort,
  snapshot: OperatorMainnetTestSnapshot,
  now: UtcTimestamp,
): Result<LeaseAuthority> {
  const current = persistence.readScopeSnapshot();
  if (!current.ok) return current;
  const lease = current.value.lease;
  const activeLease =
    lease !== undefined &&
    timestampToEpochMs(now) < timestampToEpochMs(lease.expiresAt);
  const evidenceOwner = (() => {
    const latest = snapshot.reconciliations.at(-1);
    if (!latest) return undefined;
    try {
      const row = JSON.parse(latest.canonicalJson) as Record<string, unknown>;
      const evidence = row.evidence;
      return typeof evidence === "object" && evidence !== null
        ? (evidence as Record<string, unknown>).statusAuthorityOwnerRunId
        : undefined;
    } catch {
      return undefined;
    }
  })();
  const reusableOwners = [snapshot.intent.leaseOwnerRunId, evidenceOwner];
  if (activeLease) {
    if (!reusableOwners.includes(lease.ownerRunId))
      return fail(
        domainError(
          "RUN_LEASE_HELD",
          "another account operation holds the status lease",
        ),
      );
    const renewed = persistence.renewLease({
      scope: persistence.scope,
      ownerRunId: lease.ownerRunId,
      now,
      ttlMs: LEASE_TTL_MS,
      authority: { ownerRunId: lease.ownerRunId, epoch: lease.epoch },
    });
    return renewed.ok
      ? ok({ ownerRunId: renewed.value.ownerRunId, epoch: renewed.value.epoch })
      : renewed;
  }
  const acquired = persistence.acquireLease({
    scope: persistence.scope,
    ownerRunId: `operator-status-${randomUUID()}`,
    now,
    ttlMs: LEASE_TTL_MS,
  });
  return acquired.ok
    ? ok({ ownerRunId: acquired.value.ownerRunId, epoch: acquired.value.epoch })
    : acquired;
}

/** Read-only exchange recovery plus append-only local evidence; it never clears HALT. */
export async function runMainnetOperatorTestStatus(
  input: MainnetOperatorTestStatusInput,
  dependencies: MainnetOperatorTestStatusDependencies,
): Promise<Result<MainnetOperatorTestStatusResult>> {
  const sourceId = requireIdentifier(input.sourceId, "sourceId");
  if (!sourceId.ok) return sourceId;
  if (
    input.manualAction !== undefined &&
    input.manualAction !== "entry-remainder-cancelled" &&
    input.manualAction !== "position-closed" &&
    input.manualAction !== "other"
  )
    return invalid("manual action category is unsupported");
  const actor =
    input.manualAction === undefined
      ? ok<string | undefined>(undefined)
      : requireIdentifier(input.actor, "actor");
  if (!actor.ok) return actor;

  let snapshotResult = dependencies.journal.readOperatorMainnetTestSource(
    sourceId.value,
  );
  if (!snapshotResult.ok) return snapshotResult;
  if (!snapshotResult.value)
    return fail(
      domainError("INVALID_VALUE", "operator status source was not found"),
    );
  let snapshot = snapshotResult.value;
  const parsedNow = parseUtcTimestamp(dependencies.clock.now());
  if (!parsedNow.ok) return parsedNow;
  const authority = statusAuthority(
    dependencies.persistence,
    snapshot,
    parsedNow.value,
  );
  if (!authority.ok) return authority;

  if (input.manualAction !== undefined) {
    const recorded = dependencies.journal.appendManualAction({
      authority: authority.value,
      sourceId: sourceId.value,
      action: input.manualAction,
      provenance: {
        schemaVersion: "operator-mainnet-manual-action-provenance/v1",
        source: "interactive-status",
        actor: actor.value,
        statement: input.manualAction,
      },
      declaredAt: parsedNow.value,
    });
    if (!recorded.ok) return recorded;
    snapshotResult = dependencies.journal.readOperatorMainnetTestSource(
      sourceId.value,
    );
    if (!snapshotResult.ok || !snapshotResult.value)
      return snapshotResult.ok
        ? fail(
            domainError("PERSISTENCE_INTEGRITY", "operator source disappeared"),
          )
        : snapshotResult;
    snapshot = snapshotResult.value;
  }

  let observation: MainnetOperatorTestStatusObservation | undefined;
  let observationFailure: string | undefined;
  let failedObservationReads = 0;
  try {
    const observed = await dependencies.exchange.observe(
      snapshot.plan,
      snapshot.attempt?.exchangeOrderId,
    );
    if (observed.ok) observation = observed.value;
    else {
      const reasonCode = observed.error.details?.reasonCode;
      observationFailure =
        typeof reasonCode === "string" &&
        /^[A-Z0-9_:-]{1,100}$/u.test(reasonCode)
          ? reasonCode
          : observed.error.code;
      const exchangeReads = observed.error.details?.exchangeReads;
      failedObservationReads =
        typeof exchangeReads === "number" &&
        Number.isSafeInteger(exchangeReads) &&
        exchangeReads >= 0
          ? exchangeReads
          : 0;
    }
  } catch {
    observationFailure = "READ_FAILED";
  }

  const observedAt = observation?.observedAt ?? parsedNow.value;
  const result = observation
    ? classify(snapshot, observation)
    : {
        lifecycleOutcome: "UNKNOWN" as const,
        cleanupStatus: "unknown" as const,
        reasons: [observationFailure ?? "READ_FAILED"],
        evidence: {
          schemaVersion: "operator-mainnet-test-status-evidence/v1",
          observedAt,
          exchangeReads: failedObservationReads,
          failedStage: observationFailure ?? "READ_FAILED",
          manualActions: snapshot.manualActions.map((row) => row.action),
        },
      };
  const evidence = {
    ...result.evidence,
    statusAuthorityOwnerRunId: authority.value.ownerRunId,
    statusAuthorityEpoch: authority.value.epoch,
    statusJournalObservedAt: observedAt,
  };
  const persisted = dependencies.journal.appendReconciliation({
    authority: authority.value,
    sourceId: sourceId.value,
    lifecycleOutcome: result.lifecycleOutcome,
    cleanupStatus: result.cleanupStatus,
    evidence,
    observedAt,
  });
  if (!persisted.ok) return persisted;

  if (result.lifecycleOutcome === "UNKNOWN") {
    const currentHalt = dependencies.persistence.readHalt();
    if (!currentHalt.ok) return currentHalt;
    if (!currentHalt.value.active) {
      const raised = dependencies.persistence.raiseHalt(
        authority.value,
        "operator Mainnet status is unknown",
        observedAt,
      );
      if (!raised.ok) return raised;
    }
  }

  const latest = dependencies.journal.readOperatorMainnetTestSource(
    sourceId.value,
  );
  const halt = dependencies.persistence.readHalt();
  if (!latest.ok) return latest;
  if (!latest.value)
    return fail(
      domainError("PERSISTENCE_INTEGRITY", "operator source disappeared"),
    );
  if (!halt.ok) return halt;
  return ok({
    sourceId: sourceId.value,
    lifecycleOutcome: result.lifecycleOutcome,
    cleanupStatus: result.cleanupStatus,
    exchangeReads: observation?.exchangeReads ?? failedObservationReads,
    journaled: true,
    latestSnapshot: latest.value,
    halt: halt.value,
    reasons: result.reasons,
  });
}
