import {
  createAccountEvidenceBundle,
  type AccountEvidenceBundle,
  type AccountEvidenceFact,
  type AccountOrderEvidence,
} from "../account/account-evidence-bundle.js";
import { hashCanonical } from "../identity/canonical-serialization.js";
import { prepareDailyPlanningInputs } from "../planning/daily-planning-inputs.js";
import { closedRecord } from "../planning/planning-validation.js";
import {
  createPortfolioRiskProjectionForApprovedLeg,
  type PortfolioRiskProjection,
} from "../risk/portfolio-risk-projection.js";
import {
  calculatePortfolioRiskIncrementalCapacity,
  assessPortfolioRiskLeverage,
  type PortfolioRiskLeverageAssessment,
} from "../risk/portfolio-risk-capacity.js";
import type { PortfolioRiskBlockReasonCode } from "../risk/portfolio-risk-diagnostics.js";
import { createPortfolioRiskPolicy } from "../risk/portfolio-risk-policy.js";
import {
  rehydratePreparedPlanApproval,
  type PreparedPlanApproval,
} from "../review/prepared-plan-approval.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { DecimalValue } from "../shared/decimal.js";
import { domainError } from "../shared/errors.js";
import { fail, ok, type Result } from "../shared/result.js";
import {
  parseUtcTimestamp,
  timestampToEpochMs,
  type UtcTimestamp,
} from "../shared/time.js";
import {
  isRecord,
  requireFiniteInteger,
  requireHash,
} from "../shared/validation.js";
import {
  createPreparedLegGridExecution,
  type PreparedLegGridExecution,
  type PreparedLegExecution,
} from "./prepared-leg-execution.js";
import {
  createPreparedLegOrderProof,
  matchesPreparedLegTakeProfitChild,
  matchesPreparedLegOrder,
  type PreparedLegOrderProof,
} from "./prepared-leg-order-proof.js";
import type { ExchangeOrderObservation } from "./exchange-order.js";

export const PREPARED_GRID_CAPACITY_SCHEMA_VERSION =
  "prepared-grid-capacity/v1" as const;

export type PreparedGridCapacityReasonCode =
  | "APPROVAL_INVALID"
  | "ACCOUNT_BINDING_MISMATCH"
  | "READINESS_BLOCKED"
  | "READINESS_MISMATCH"
  | "READINESS_FUTURE"
  | "READINESS_STALE"
  | "READINESS_PRECEDES_ACCOUNT"
  | "READ_STATE_SCOPE_MISMATCH"
  | "READ_STATE_FUTURE"
  | "READ_STATE_STALE"
  | "READ_STATE_PRECEDES_ACCOUNT"
  | "TARGET_POSITION_NOT_FLAT"
  | "PREFIX_RECONCILIATION_MISMATCH"
  | "ACCOUNT_ORDER_PREFIX_MISMATCH"
  | "PREFIX_ORDER_NOT_ZERO_FILL"
  | "ATTACHED_PROTECTION_CONTRADICTS_APPROVAL"
  | "RISK_PROJECTION_BLOCKED"
  | "LEVERAGE_EXCEEDS_POLICY"
  | "LEVERAGE_NOT_ONE_X"
  | "LEVERAGE_UNKNOWN"
  | "AVAILABLE_BALANCE_UNKNOWN"
  | "CAPACITY_EXCEEDED"
  | "APPROVED_ALLOCATION_EXCEEDED"
  | PortfolioRiskBlockReasonCode;

export interface PreparedGridReadinessBinding {
  readonly verdict: "READY" | "BLOCKED";
  readonly environment: "mainnet";
  readonly symbol: string;
  readonly evaluatedAt: UtcTimestamp;
  readonly internalBinding?: {
    readonly accountIdentityHash: string;
    readonly accountEvidenceHash: string;
  };
}

export interface PreparedGridCurrentState {
  readonly serverTime: UtcTimestamp;
  readonly symbol: string;
  readonly position: {
    readonly instrument: string;
    readonly side: "flat" | "long" | "short";
    readonly quantity: DecimalValue;
    readonly leverage: DecimalValue;
  };
  readonly leverage: {
    readonly buy: DecimalValue;
    readonly sell: DecimalValue;
    readonly effective: DecimalValue;
  };
  readonly market: {
    readonly instrument: string;
    readonly scope: {
      readonly exchange: "bybit";
      readonly environment: "mainnet";
      readonly category: "linear";
      readonly positionMode: "one-way";
    };
  };
  readonly openOrders: readonly ExchangeOrderObservation[];
}

export interface PreparedGridFreshEvidence {
  readonly readiness: PreparedGridReadinessBinding;
  readonly state: PreparedGridCurrentState;
}

export interface PreparedGridCapacityInput {
  readonly approval: unknown;
  readonly approvalHash: unknown;
  readonly account: unknown;
  readonly liveEvidence: unknown;
  readonly nextLegIndex: unknown;
  readonly supplementalEvidence: unknown;
  readonly evaluationTime: unknown;
}

export interface PreparedGridCapacity {
  readonly schemaVersion: typeof PREPARED_GRID_CAPACITY_SCHEMA_VERSION;
  readonly contentHash: string;
  readonly status: "pass" | "block";
  readonly reasonCodes: readonly PreparedGridCapacityReasonCode[];
  readonly approvalHash: string;
  readonly preparedHash: string;
  readonly dailyPlanHash: string;
  readonly accountIdentityHash: string;
  readonly accountEvidenceHash: string;
  readonly policyHash: string;
  readonly evaluationTime: UtcTimestamp;
  readonly execution: PreparedLegExecution;
  readonly capacity: {
    readonly availableBalance: DecimalValue | null;
    readonly reserve: DecimalValue | null;
    readonly incrementalCapacity: DecimalValue | null;
    readonly requestedIncrementalNotional: DecimalValue;
    readonly approvedAllocation: DecimalValue;
    readonly confirmedPrefixNotional: DecimalValue;
    readonly cumulativeApprovedNotional: DecimalValue;
    readonly withinCapacity: boolean | null;
    readonly withinApprovedAllocation: boolean;
  };
  readonly projection: PortfolioRiskProjection;
  readonly leverage: PortfolioRiskLeverageAssessment;
}

function invalid(message = "prepared grid capacity input is invalid") {
  return fail(domainError("INVALID_EVIDENCE", message));
}

function hasPlainDataProperties(value: object): boolean {
  return (
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) =>
      Object.hasOwn(descriptor, "value"),
    )
  );
}

function closedInput(value: unknown): value is Record<string, unknown> {
  const fields = [
    "approval",
    "approvalHash",
    "account",
    "liveEvidence",
    "nextLegIndex",
    "supplementalEvidence",
    "evaluationTime",
  ];
  return (
    closedRecord(value, fields) &&
    Reflect.ownKeys(value).length === fields.length
  );
}

function parseDecimal(value: unknown): DecimalValue | null {
  if (value instanceof DecimalValue) return value;
  const parsed = DecimalValue.fromString(value);
  return parsed.ok ? parsed.value : null;
}

function objectWithData(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    hasPlainDataProperties(value) &&
    Reflect.ownKeys(value).every((key) => typeof key === "string")
  );
}

function readLiveEvidence(input: unknown): Result<PreparedGridFreshEvidence> {
  if (
    !objectWithData(input) ||
    !objectWithData(input.readiness) ||
    !objectWithData(input.state)
  )
    return invalid("fresh readiness and read-state evidence are required");
  const readiness = input.readiness;
  const state = input.state;
  const readinessTime = parseUtcTimestamp(readiness.evaluatedAt);
  const stateTime = parseUtcTimestamp(state.serverTime);
  const position = state.position;
  const leverage = state.leverage;
  const market = state.market;
  const scope = objectWithData(market) ? market.scope : undefined;
  if (
    (readiness.verdict !== "READY" && readiness.verdict !== "BLOCKED") ||
    readiness.environment !== "mainnet" ||
    typeof readiness.symbol !== "string" ||
    !readinessTime.ok ||
    !stateTime.ok ||
    typeof state.symbol !== "string" ||
    !objectWithData(position) ||
    typeof position.instrument !== "string" ||
    !["flat", "long", "short"].includes(position.side as string) ||
    !objectWithData(leverage) ||
    !objectWithData(market) ||
    typeof market.instrument !== "string" ||
    !objectWithData(scope) ||
    !Array.isArray(state.openOrders) ||
    Reflect.ownKeys(state.openOrders).length !== state.openOrders.length + 1 ||
    Object.values(Object.getOwnPropertyDescriptors(state.openOrders)).some(
      (descriptor) => !Object.hasOwn(descriptor, "value"),
    )
  )
    return invalid("fresh readiness or read-state evidence is malformed");
  if (state.openOrders.some((order) => !objectWithData(order)))
    return invalid("read-state orders must be plain provider observations");
  const quantity = parseDecimal(position.quantity);
  const positionLeverage = parseDecimal(position.leverage);
  const buyLeverage = parseDecimal(leverage.buy);
  const sellLeverage = parseDecimal(leverage.sell);
  const effectiveLeverage = parseDecimal(leverage.effective);
  const identity = readiness.internalBinding;
  if (
    quantity === null ||
    positionLeverage === null ||
    buyLeverage === null ||
    sellLeverage === null ||
    effectiveLeverage === null ||
    !objectWithData(identity) ||
    typeof identity.accountIdentityHash !== "string" ||
    typeof identity.accountEvidenceHash !== "string"
  )
    return invalid("fresh readiness binding or read-state values are missing");
  return ok({
    readiness: {
      verdict: readiness.verdict,
      environment: "mainnet",
      symbol: readiness.symbol,
      evaluatedAt: readinessTime.value,
      internalBinding: {
        accountIdentityHash: identity.accountIdentityHash,
        accountEvidenceHash: identity.accountEvidenceHash,
      },
    },
    state: {
      serverTime: stateTime.value,
      symbol: state.symbol,
      position: {
        instrument: position.instrument,
        side: position.side as "flat" | "long" | "short",
        quantity,
        leverage: positionLeverage,
      },
      leverage: {
        buy: buyLeverage,
        sell: sellLeverage,
        effective: effectiveLeverage,
      },
      market: {
        instrument: market.instrument,
        scope: {
          exchange: scope.exchange as "bybit",
          environment: scope.environment as "mainnet",
          category: scope.category as "linear",
          positionMode: scope.positionMode as "one-way",
        },
      },
      openOrders: state.openOrders as ExchangeOrderObservation[],
    },
  });
}

function isKnown<T>(
  fact: AccountEvidenceFact<T>,
): fact is { readonly state: "known"; readonly value: T } {
  return fact.state === "known" && Object.hasOwn(fact, "value");
}

function projectedTargetPositionIsFlat(
  targetPosition: PortfolioRiskProjection["targetPosition"],
): boolean {
  if (targetPosition.state === "absent") return true;
  if (targetPosition.state === "ambiguous") return false;
  const position = targetPosition.position;
  return (
    position.category === "linear" &&
    position.positionIdx === 0 &&
    position.side === "None" &&
    isKnown(position.size) &&
    position.size.unit === "contracts" &&
    position.size.value.isZero()
  );
}

function isAccountTakeProfitChild(order: AccountOrderEvidence): boolean {
  return (
    order.orderLinkId === null &&
    isKnown(order.stopOrderType) &&
    order.stopOrderType.value === "TakeProfit"
  );
}

function isActiveAccountOrder(order: AccountOrderEvidence): boolean {
  return (
    order.leavesQty.state !== "known" || order.leavesQty.value.isPositive()
  );
}

function matchesAccountTakeProfitChild(
  order: AccountOrderEvidence,
  restOrder: ExchangeOrderObservation,
  execution: PreparedLegExecution,
): boolean {
  const takeProfit = execution.leg.intent.protection?.takeProfit;
  const policy = execution.leg.intent.protection?.takeProfitPolicy;
  const childRemaining = restOrder.requestedQuantity.subtract(
    restOrder.filledQuantity,
  );
  return (
    takeProfit !== undefined &&
    policy?.tpslMode === "Partial" &&
    matchesPreparedLegTakeProfitChild(restOrder, execution) &&
    restOrder.requestedQuantity.compare(execution.leg.intent.quantity) === 0 &&
    isAccountTakeProfitChild(order) &&
    order.category === "linear" &&
    order.symbol === execution.leg.intent.instrument &&
    order.orderId === restOrder.exchangeOrderId &&
    (order.status === "New" || order.status === "Untriggered") &&
    order.side === "Sell" &&
    order.orderType === "Market" &&
    isKnown(order.positionIdx) &&
    order.positionIdx.value === 0 &&
    isKnown(order.reduceOnly) &&
    order.reduceOnly.value &&
    isKnown(order.qty) &&
    order.qty.unit === "contracts" &&
    order.qty.value.compare(restOrder.requestedQuantity) === 0 &&
    restOrder.filledQuantity.isZero() &&
    isKnown(order.cumExecQty) &&
    order.cumExecQty.unit === "contracts" &&
    order.cumExecQty.value.compare(restOrder.filledQuantity) === 0 &&
    isKnown(order.leavesQty) &&
    order.leavesQty.unit === "contracts" &&
    order.leavesQty.value.compare(childRemaining) === 0 &&
    isKnown(order.triggerPrice) &&
    order.triggerPrice.unit === "price" &&
    order.triggerPrice.value.compare(takeProfit) === 0 &&
    isKnown(order.tpslMode) &&
    order.tpslMode.value === "Partial" &&
    isKnown(order.triggerBy) &&
    order.triggerBy.value === "LastPrice"
  );
}

function matchesAccountOrder(
  order: AccountOrderEvidence,
  execution: PreparedLegExecution,
  exchangeOrderId: string,
): boolean {
  const intent = execution.leg.intent;
  const takeProfit = intent.protection?.takeProfit;
  const noStopLoss =
    order.stopLoss.state === "not-applicable" ||
    (isKnown(order.stopLoss) &&
      order.stopLoss.unit === "price" &&
      order.stopLoss.value.isZero());
  return (
    takeProfit !== undefined &&
    order.category === "linear" &&
    order.symbol === intent.instrument &&
    order.orderId === exchangeOrderId &&
    order.orderLinkId === execution.clientOrderId &&
    order.status === "New" &&
    order.side === "Buy" &&
    order.orderType === "Limit" &&
    isKnown(order.positionIdx) &&
    order.positionIdx.value === 0 &&
    isKnown(order.reduceOnly) &&
    !order.reduceOnly.value &&
    isKnown(order.timeInForce) &&
    order.timeInForce.value === "GTC" &&
    isKnown(order.price) &&
    order.price.unit === "price" &&
    order.price.value.compare(intent.price) === 0 &&
    isKnown(order.qty) &&
    order.qty.unit === "contracts" &&
    order.qty.value.compare(intent.quantity) === 0 &&
    isKnown(order.cumExecQty) &&
    order.cumExecQty.unit === "contracts" &&
    order.cumExecQty.value.isZero() &&
    isKnown(order.leavesQty) &&
    order.leavesQty.unit === "contracts" &&
    order.leavesQty.value.compare(intent.quantity) === 0 &&
    isKnown(order.takeProfit) &&
    order.takeProfit.unit === "price" &&
    order.takeProfit.value.compare(takeProfit) === 0 &&
    noStopLoss
  );
}

function checkTargetOrders(input: {
  readonly account: AccountEvidenceBundle;
  readonly state: PreparedGridCurrentState;
  readonly grid: PreparedLegGridExecution;
  readonly prefixLength: number;
  readonly symbol: string;
  readonly evaluationTime: UtcTimestamp;
  readonly maxAgeMs: number;
}): {
  readonly codes: readonly PreparedGridCapacityReasonCode[];
  readonly notional: DecimalValue;
} {
  const codes = new Set<PreparedGridCapacityReasonCode>();
  const prefix = input.grid.legs.slice(0, input.prefixLength);
  const prefixByClientId = new Map(
    prefix.map(({ execution }) => [execution.clientOrderId, execution]),
  );
  const restParents = new Map<string, PreparedLegOrderProof>();
  const protectionChildren = new Map<string, ExchangeOrderObservation>();

  for (const order of input.state.openOrders) {
    if (order.instrument !== input.symbol) {
      codes.add("READ_STATE_SCOPE_MISMATCH");
      continue;
    }
    const parentId = order.parentOrderLinkId;
    if (parentId !== undefined || order.protectionType !== undefined) {
      if (
        parentId !== undefined &&
        order.clientOrderId === parentId &&
        order.protectionType === "take-profit" &&
        prefixByClientId.has(parentId) &&
        matchesPreparedLegTakeProfitChild(
          order,
          prefixByClientId.get(parentId)!,
        )
      ) {
        if (protectionChildren.has(parentId)) {
          codes.add("ATTACHED_PROTECTION_CONTRADICTS_APPROVAL");
        } else {
          protectionChildren.set(parentId, order);
        }
      } else {
        codes.add("ATTACHED_PROTECTION_CONTRADICTS_APPROVAL");
      }
      continue;
    }
    const execution = prefixByClientId.get(order.clientOrderId);
    const proof = createPreparedLegOrderProof(order);
    if (
      execution === undefined ||
      !proof.ok ||
      !matchesPreparedLegOrder(proof.value, execution) ||
      proof.value.status !== "open" ||
      !proof.value.filledQuantity.isZero() ||
      timestampToEpochMs(proof.value.observedAt) >
        timestampToEpochMs(input.state.serverTime) ||
      timestampToEpochMs(input.evaluationTime) -
        timestampToEpochMs(proof.value.observedAt) >
        input.maxAgeMs ||
      restParents.has(order.clientOrderId)
    ) {
      codes.add(
        proof.ok && !proof.value.filledQuantity.isZero()
          ? "PREFIX_ORDER_NOT_ZERO_FILL"
          : "PREFIX_RECONCILIATION_MISMATCH",
      );
      continue;
    }
    restParents.set(order.clientOrderId, proof.value);
  }

  if (restParents.size !== input.prefixLength)
    codes.add("PREFIX_RECONCILIATION_MISMATCH");

  const targetAccountOrders =
    input.account.criticalPasses.B?.orders.filter(
      (order) => order.symbol === input.symbol && isActiveAccountOrder(order),
    ) ?? [];
  const accountProtectionChildren = targetAccountOrders.filter(
    isAccountTakeProfitChild,
  );
  const activeAccountOrders = targetAccountOrders.filter(
    (order) => !isAccountTakeProfitChild(order),
  );
  if (activeAccountOrders.length !== input.prefixLength)
    codes.add("PREFIX_RECONCILIATION_MISMATCH");
  if (accountProtectionChildren.length !== protectionChildren.size)
    codes.add("ATTACHED_PROTECTION_CONTRADICTS_APPROVAL");
  for (const order of accountProtectionChildren) {
    const restOrder = [...protectionChildren.values()].find(
      (candidate) => candidate.exchangeOrderId === order.orderId,
    );
    const execution = restOrder
      ? prefixByClientId.get(restOrder.clientOrderId)
      : undefined;
    if (
      !restOrder ||
      !execution ||
      !matchesAccountTakeProfitChild(order, restOrder, execution)
    )
      codes.add("ATTACHED_PROTECTION_CONTRADICTS_APPROVAL");
  }
  const accountOrderIds = new Set<string>();
  for (const order of activeAccountOrders) {
    const execution = prefixByClientId.get(order.orderLinkId ?? "");
    const rest = order.orderLinkId
      ? restParents.get(order.orderLinkId)
      : undefined;
    if (
      execution === undefined ||
      rest === undefined ||
      accountOrderIds.has(order.orderLinkId ?? "") ||
      !matchesAccountOrder(order, execution, rest.exchangeOrderId)
    ) {
      codes.add("ACCOUNT_ORDER_PREFIX_MISMATCH");
      continue;
    }
    accountOrderIds.add(order.orderLinkId!);
  }

  const zero = DecimalValue.fromString("0");
  if (!zero.ok) throw new Error("zero decimal constant is invalid");
  const notional = prefix.reduce(
    (total, row) => total.add(row.execution.leg.intent.notional),
    zero.value,
  );
  return { codes: [...codes], notional };
}

function isFutureOrStale(
  observedAt: UtcTimestamp,
  evaluationTime: UtcTimestamp,
  maxAgeMs: number,
): "future" | "stale" | undefined {
  const age =
    timestampToEpochMs(evaluationTime) - timestampToEpochMs(observedAt);
  return age < 0 ? "future" : age > maxAgeMs ? "stale" : undefined;
}

function addFreshnessReasons(input: {
  readonly account: AccountEvidenceBundle;
  readonly evidence: PreparedGridFreshEvidence;
  readonly evaluationTime: UtcTimestamp;
  readonly maxAgeMs: number;
  readonly reasons: Set<PreparedGridCapacityReasonCode>;
}): void {
  const readinessAge = isFutureOrStale(
    input.evidence.readiness.evaluatedAt,
    input.evaluationTime,
    input.maxAgeMs,
  );
  if (readinessAge === "future") input.reasons.add("READINESS_FUTURE");
  if (readinessAge === "stale") input.reasons.add("READINESS_STALE");
  const stateAge = isFutureOrStale(
    input.evidence.state.serverTime,
    input.evaluationTime,
    input.maxAgeMs,
  );
  if (stateAge === "future") input.reasons.add("READ_STATE_FUTURE");
  if (stateAge === "stale") input.reasons.add("READ_STATE_STALE");
  if (
    input.account.collectionEndedAt !== null &&
    timestampToEpochMs(input.evidence.readiness.evaluatedAt) <
      timestampToEpochMs(input.account.collectionEndedAt)
  )
    input.reasons.add("READINESS_PRECEDES_ACCOUNT");
  if (
    input.account.collectionEndedAt !== null &&
    timestampToEpochMs(input.evidence.state.serverTime) <
      timestampToEpochMs(input.account.collectionEndedAt)
  )
    input.reasons.add("READ_STATE_PRECEDES_ACCOUNT");
}

function makeAssessment(input: {
  readonly approval: PreparedPlanApproval;
  readonly approvalHash: string;
  readonly account: AccountEvidenceBundle;
  readonly evaluationTime: UtcTimestamp;
  readonly execution: PreparedLegExecution;
  readonly projection: PortfolioRiskProjection;
  readonly leverage: PortfolioRiskLeverageAssessment;
  readonly reasons: Set<PreparedGridCapacityReasonCode>;
  readonly availableBalance: DecimalValue | null;
  readonly reserve: DecimalValue | null;
  readonly incrementalCapacity: DecimalValue | null;
  readonly requestedIncrementalNotional: DecimalValue;
  readonly approvedAllocation: DecimalValue;
  readonly confirmedPrefixNotional: DecimalValue;
  readonly cumulativeApprovedNotional: DecimalValue;
  readonly withinCapacity: boolean | null;
  readonly withinApprovedAllocation: boolean;
}): Result<PreparedGridCapacity> {
  const prepared = input.approval.replayInputs.prepared;
  const reasonCodes = [...input.reasons].sort();
  const payload = {
    schemaVersion: PREPARED_GRID_CAPACITY_SCHEMA_VERSION,
    status: reasonCodes.length === 0 ? ("pass" as const) : ("block" as const),
    reasonCodes,
    approvalHash: input.approvalHash,
    preparedHash: prepared.contentHash,
    dailyPlanHash: input.projection.dailyPlanHash,
    accountIdentityHash: input.account.accountBinding.accountIdentityHash,
    accountEvidenceHash: input.projection.accountEvidenceHash,
    policyHash: input.projection.policyHash,
    evaluationTime: input.evaluationTime,
    execution: input.execution,
    capacity: {
      availableBalance: input.availableBalance,
      reserve: input.reserve,
      incrementalCapacity: input.incrementalCapacity,
      requestedIncrementalNotional: input.requestedIncrementalNotional,
      approvedAllocation: input.approvedAllocation,
      confirmedPrefixNotional: input.confirmedPrefixNotional,
      cumulativeApprovedNotional: input.cumulativeApprovedNotional,
      withinCapacity: input.withinCapacity,
      withinApprovedAllocation: input.withinApprovedAllocation,
    },
    projection: input.projection,
    leverage: input.leverage,
  };
  const contentHash = hashCanonical(payload);
  return contentHash.ok
    ? ok(deepFreeze({ ...payload, contentHash: contentHash.value }))
    : contentHash;
}

/** Freshly proves exactly one sequential next leg against the immutable approval. */
export function createPreparedGridCapacity(
  input: PreparedGridCapacityInput,
): Result<PreparedGridCapacity> {
  if (!closedInput(input)) return invalid();
  const evaluationTime = parseUtcTimestamp(input.evaluationTime);
  const approvalHash = requireHash(input.approvalHash, "approvalHash");
  const nextLegIndex = requireFiniteInteger(input.nextLegIndex, "nextLegIndex");
  const approval = rehydratePreparedPlanApproval(input.approval);
  const account = createAccountEvidenceBundle(input.account);
  const liveEvidence = readLiveEvidence(input.liveEvidence);
  if (
    !evaluationTime.ok ||
    !approvalHash.ok ||
    !nextLegIndex.ok ||
    !approval.ok ||
    !account.ok ||
    !liveEvidence.ok ||
    !Array.isArray(input.supplementalEvidence)
  )
    return invalid(
      "exact approval, account and fresh execution evidence are required",
    );
  const admittedGrid = createPreparedLegGridExecution({
    approval: approval.value,
    approvalHash: approvalHash.value,
    now: evaluationTime.value,
  });
  if (!admittedGrid.ok) return admittedGrid;
  const prepared = approval.value.replayInputs.prepared;
  const preflight = prepared.replayInputs.preflight;
  const dailyPlan = preflight.replayInputs.dailyPlan;
  const planning = prepareDailyPlanningInputs(dailyPlan.inputs);
  if (!planning.ok) return invalid("approved planning inputs are invalid");
  const policyResult = createPortfolioRiskPolicy(preflight.replayInputs.policy);
  if (!policyResult.ok) return invalid("approved risk policy is invalid");
  const policy = policyResult.value;
  if (
    dailyPlan.decision.recommendation !== "ADD_LONG" ||
    !Array.isArray(dailyPlan.candidateLegs) ||
    nextLegIndex.value >= admittedGrid.value.legs.length
  )
    return invalid("the approved plan has no selected sequential ADD leg");
  const selected = admittedGrid.value.legs[nextLegIndex.value];
  if (
    !selected ||
    selected.execution.leg.index !== nextLegIndex.value ||
    selected.execution.preparedHash !== prepared.contentHash ||
    selected.execution.accountIdentityHash !==
      prepared.inputIdentity.accountIdentityHash ||
    selected.execution.approvalHash !== approvalHash.value
  )
    return invalid("approved grid identity does not match its source artifact");

  const reasons = new Set<PreparedGridCapacityReasonCode>();
  const evidence = liveEvidence.value;
  const targetSymbol = planning.value.symbol;
  const binding = evidence.readiness.internalBinding;
  if (
    prepared.inputIdentity.environment !== "mainnet" ||
    account.value.accountBinding.exchange !== "bybit" ||
    account.value.accountBinding.environment !== "mainnet" ||
    account.value.accountBinding.origin !== "https://api.bybit.com" ||
    !account.value.accountBinding.identityVerified ||
    prepared.inputIdentity.accountIdentityHash !==
      account.value.accountBinding.accountIdentityHash ||
    selected.execution.accountIdentityHash !==
      account.value.accountBinding.accountIdentityHash
  )
    reasons.add("ACCOUNT_BINDING_MISMATCH");
  if (
    evidence.readiness.verdict !== "READY" ||
    evidence.readiness.environment !== "mainnet"
  )
    reasons.add("READINESS_BLOCKED");
  if (
    evidence.readiness.symbol !== targetSymbol ||
    evidence.state.symbol !== targetSymbol ||
    evidence.state.market.instrument !== targetSymbol ||
    evidence.state.market.scope.exchange !== "bybit" ||
    evidence.state.market.scope.environment !== "mainnet" ||
    evidence.state.market.scope.category !== "linear" ||
    evidence.state.market.scope.positionMode !== "one-way" ||
    evidence.state.position.instrument !== targetSymbol ||
    !binding ||
    binding.accountIdentityHash !==
      account.value.accountBinding.accountIdentityHash
  )
    reasons.add("READINESS_MISMATCH");

  addFreshnessReasons({
    account: account.value,
    evidence,
    evaluationTime: evaluationTime.value,
    maxAgeMs: policy.maxAccountEvidenceAgeMs,
    reasons,
  });

  if (
    evidence.state.position.side !== "flat" ||
    !evidence.state.position.quantity.isZero()
  )
    reasons.add("TARGET_POSITION_NOT_FLAT");
  for (const leverage of [
    evidence.state.position.leverage,
    evidence.state.leverage.buy,
    evidence.state.leverage.sell,
    evidence.state.leverage.effective,
  ]) {
    if (leverage.compare(policy.maxDerivativesLeverage) > 0)
      reasons.add("LEVERAGE_EXCEEDS_POLICY");
    else if (leverage.compare(policy.maxDerivativesLeverage) !== 0)
      reasons.add("LEVERAGE_NOT_ONE_X");
  }

  const prefixCheck = checkTargetOrders({
    account: account.value,
    state: evidence.state,
    grid: admittedGrid.value,
    prefixLength: nextLegIndex.value,
    symbol: targetSymbol,
    evaluationTime: evaluationTime.value,
    maxAgeMs: policy.maxAccountEvidenceAgeMs,
  });
  for (const code of prefixCheck.codes) reasons.add(code);

  const projectionResult = createPortfolioRiskProjectionForApprovedLeg({
    dailyPlan,
    account: account.value,
    policy,
    evaluationTime: evaluationTime.value,
    legId: selected.execution.leg.legId,
  });
  if (!projectionResult.ok) return projectionResult;
  const projection = projectionResult.value;
  if (binding?.accountEvidenceHash !== projection.accountEvidenceHash)
    reasons.add("READINESS_MISMATCH");
  if (!projectedTargetPositionIsFlat(projection.targetPosition))
    reasons.add("TARGET_POSITION_NOT_FLAT");
  for (const code of projection.sharedAdmission.reasonCodes) reasons.add(code);
  for (const code of projection.addProjection.reasonCodes) reasons.add(code);
  if (
    projection.sharedAdmission.status !== "admitted" ||
    projection.addProjection.status !== "complete"
  )
    reasons.add("RISK_PROJECTION_BLOCKED");
  const leverage = assessPortfolioRiskLeverage({
    account: account.value,
    projection,
    policy,
    evaluationTime: evaluationTime.value,
    supplementalEvidence: input.supplementalEvidence,
  });
  for (const code of leverage.reasonCodes) reasons.add(code);

  const availableFact = projection.addProjection.availableBalance;
  const availableBalance =
    availableFact.state === "known" ? availableFact.value : null;
  const zero = DecimalValue.fromString("0");
  if (!zero.ok) return invalid();
  let reserve: DecimalValue | null = null;
  let incrementalCapacity: DecimalValue | null = null;
  let withinCapacity: boolean | null = null;
  if (availableBalance === null) {
    reasons.add("AVAILABLE_BALANCE_UNKNOWN");
  } else {
    const capacity = calculatePortfolioRiskIncrementalCapacity({
      availableBalance,
      requestedNotional: selected.execution.leg.intent.notional,
      marginReserveRatio: policy.marginReserveRatio,
    });
    if (!capacity.ok) return capacity;
    reserve = capacity.value.reserve;
    incrementalCapacity = capacity.value.incrementalCapacity;
    withinCapacity = capacity.value.withinCapacity;
    if (!withinCapacity) reasons.add("CAPACITY_EXCEEDED");
  }

  const approvedAllocation = planning.value.allocation;
  const gridTotal = admittedGrid.value.legs.reduce(
    (total, leg) => total.add(leg.execution.leg.intent.notional),
    zero.value,
  );
  const cumulativeApprovedNotional = prefixCheck.notional.add(
    selected.execution.leg.intent.notional,
  );
  const withinApprovedAllocation =
    gridTotal.compare(approvedAllocation) <= 0 &&
    cumulativeApprovedNotional.compare(approvedAllocation) <= 0;
  if (!withinApprovedAllocation) reasons.add("APPROVED_ALLOCATION_EXCEEDED");

  return makeAssessment({
    approval: approval.value,
    approvalHash: approvalHash.value,
    account: account.value,
    evaluationTime: evaluationTime.value,
    execution: selected.execution,
    projection,
    leverage,
    reasons,
    availableBalance,
    reserve,
    incrementalCapacity,
    requestedIncrementalNotional: selected.execution.leg.intent.notional,
    approvedAllocation,
    confirmedPrefixNotional: prefixCheck.notional,
    cumulativeApprovedNotional,
    withinCapacity,
    withinApprovedAllocation,
  });
}
