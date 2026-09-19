import { reverifyProbeApproval, type ProbeApproval } from "./approval.js";
import { decimalIsZero, parseDecimal } from "./decimal.js";
import {
  buildProbePlan,
  type ProbePlan,
  type ProbeOrderParameters,
} from "./probe-plan.js";
import type { ProbeStore } from "./store.js";
import {
  BybitProbeTransportError,
  classifyRetCode,
  responseList,
} from "./transport.js";
import type {
  BybitResponse,
  QueryInput,
  TransportFailureKind,
} from "./transport.js";

type JsonObject = Record<string, unknown>;
export type ScenarioTransport = {
  get(path: string, query?: QueryInput): Promise<BybitResponse>;
  post(path: string, body: JsonObject): Promise<BybitResponse>;
};

export const TERMINAL_ORDER_STATUSES = new Set([
  "Filled",
  "Cancelled",
  "Rejected",
  "Deactivated",
]);

export interface ValidatedOrder {
  readonly orderId: string;
  readonly orderLinkId: string;
  readonly orderStatus: string;
  readonly takeProfit: string | undefined;
  readonly stopLoss: string | undefined;
  readonly cancelType: string | undefined;
  readonly cancelOrigin: "exchange-post-only" | "intentional" | undefined;
}

export type ReconciliationResult =
  | Readonly<{
      kind: "rejected";
      acknowledgement: "pending";
      order: undefined;
      lookupCount: 0;
      terminalState: undefined;
      source: undefined;
      message: string;
    }>
  | Readonly<{
      kind: "resting";
      acknowledgement: "pending";
      order: ValidatedOrder;
      lookupCount: number;
      terminalState: undefined;
      source: "realtime" | "history";
    }>
  | Readonly<{
      kind: "terminal";
      acknowledgement: "pending";
      order: ValidatedOrder;
      lookupCount: number;
      terminalState: string;
      source: "realtime" | "history";
    }>
  | Readonly<{
      kind: "unresolved" | "ambiguous";
      acknowledgement: "pending";
      order: undefined;
      lookupCount: number;
      terminalState: undefined;
      source: undefined;
      message: string;
    }>;

export interface ReconcileOrderOptions {
  readonly orderLinkId: string;
  readonly exchangeOrderId?: string;
  readonly category: string;
  readonly symbol: string;
  readonly realtimeAttempts?: number;
  readonly historyAttempts?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly clock?: () => number;
}

function safeString(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    !/[\u0000-\u001f\u007f\r\n]/.test(value)
    ? value
    : undefined;
}

function validateOrder(value: JsonObject): ValidatedOrder | undefined {
  const orderId = safeString(value.orderId);
  const orderLinkId = safeString(value.orderLinkId);
  const orderStatus = safeString(value.orderStatus);
  if (!orderId || !orderLinkId || !orderStatus) return undefined;
  return {
    orderId,
    orderLinkId,
    orderStatus,
    takeProfit: safeString(value.takeProfit),
    stopLoss: safeString(value.stopLoss),
    cancelType: safeString(value.cancelType),
    cancelOrigin:
      typeof value.cancelType === "string" &&
      /post.?only/i.test(value.cancelType)
        ? "exchange-post-only"
        : typeof value.cancelType === "string"
          ? "intentional"
          : undefined,
  };
}

function matchingOrders(
  values: readonly JsonObject[],
  options: ReconcileOrderOptions,
): readonly ValidatedOrder[] {
  const matches: ValidatedOrder[] = [];
  for (const value of values) {
    const order = validateOrder(value);
    if (!order || order.orderLinkId !== options.orderLinkId) continue;
    if (
      options.exchangeOrderId !== undefined &&
      order.orderId !== options.exchangeOrderId
    )
      continue;
    matches.push(order);
  }
  return matches;
}

function terminal(order: ValidatedOrder): boolean {
  return TERMINAL_ORDER_STATUSES.has(order.orderStatus);
}

function isActive(order: ValidatedOrder): boolean {
  return !terminal(order);
}

function unresolved(
  kind: "unresolved" | "ambiguous",
  lookupCount: number,
  message: string,
): ReconciliationResult {
  return {
    kind,
    acknowledgement: "pending",
    order: undefined,
    lookupCount,
    terminalState: undefined,
    source: undefined,
    message,
  };
}

function selectOrder(
  candidates: readonly ValidatedOrder[],
  lookupCount: number,
): ReconciliationResult | ValidatedOrder | undefined {
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];
  const active = candidates.filter(isActive);
  if (active.length > 1)
    return unresolved(
      "ambiguous",
      lookupCount,
      "multiple active exchange orders matched one client order ID",
    );
  if (active.length === 1) return active[0];
  return unresolved(
    "ambiguous",
    lookupCount,
    "multiple exchange orders matched without a unique active identity",
  );
}

function resultFor(
  order: ValidatedOrder,
  lookupCount: number,
  source: "realtime" | "history",
): ReconciliationResult {
  if (terminal(order)) {
    return {
      kind: "terminal",
      acknowledgement: "pending",
      order,
      lookupCount,
      terminalState: order.orderStatus,
      source,
    };
  }
  return {
    kind: "resting",
    acknowledgement: "pending",
    order,
    lookupCount,
    terminalState: undefined,
    source,
  };
}

export async function reconcileOrder(
  transport: ScenarioTransport,
  options: ReconcileOrderOptions,
): Promise<ReconciliationResult> {
  const realtimeAttempts = options.realtimeAttempts ?? 10;
  const historyAttempts = options.historyAttempts ?? 3;
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let lookupCount = 0;
  let restingObservations = 0;
  let lastResting: ValidatedOrder | undefined;

  for (let attempt = 0; attempt < realtimeAttempts; attempt += 1) {
    const response = await transport.get("/v5/order/realtime", {
      category: options.category ?? "linear",
      symbol: options.symbol ?? "",
      ...(options.exchangeOrderId === undefined
        ? { orderLinkId: options.orderLinkId }
        : { orderId: options.exchangeOrderId }),
    });
    lookupCount += 1;
    const values = responseList(response);
    if (values === undefined)
      return unresolved(
        "unresolved",
        lookupCount,
        "realtime order response did not contain a validated list",
      );
    const selected = selectOrder(matchingOrders(values, options), lookupCount);
    if (selected && typeof selected !== "object") return selected;
    if (selected && "kind" in selected) return selected;
    if (selected) {
      if (terminal(selected))
        return resultFor(selected, lookupCount, "realtime");
      restingObservations += 1;
      lastResting = selected;
      if (restingObservations >= 2)
        return resultFor(selected, lookupCount, "realtime");
    }
    if (attempt + 1 < realtimeAttempts) await sleep(1_000);
  }

  for (let attempt = 0; attempt < historyAttempts; attempt += 1) {
    const response = await transport.get("/v5/order/history", {
      category: options.category ?? "linear",
      symbol: options.symbol ?? "",
      ...(options.exchangeOrderId === undefined
        ? { orderLinkId: options.orderLinkId }
        : { orderId: options.exchangeOrderId }),
    });
    lookupCount += 1;
    const values = responseList(response);
    if (values === undefined)
      return unresolved(
        "unresolved",
        lookupCount,
        "order history response did not contain a validated list",
      );
    const selected = selectOrder(matchingOrders(values, options), lookupCount);
    if (selected && typeof selected !== "object") return selected;
    if (selected && "kind" in selected) return selected;
    if (selected) {
      if (terminal(selected))
        return resultFor(selected, lookupCount, "history");
      restingObservations += 1;
      lastResting = selected;
      if (restingObservations >= 2)
        return resultFor(selected, lookupCount, "history");
    }
    if (attempt + 1 < historyAttempts) await sleep(2_000);
  }
  if (lastResting) {
    return unresolved(
      "unresolved",
      lookupCount,
      "order remained non-terminal after bounded reconciliation",
    );
  }
  return unresolved(
    "unresolved",
    lookupCount,
    "order was not visible; not-found does not prove non-submission",
  );
}

export interface EntryScenarioOptions {
  readonly runId: string;
  readonly attemptId: string;
  readonly plan: ProbePlan;
  readonly transport: ScenarioTransport;
  readonly store: ProbeStore;
  readonly authorize: (plan: ProbePlan) => Promise<ProbeApproval>;
  readonly baselineSignedQty?: string;
  readonly discardAcknowledgement?: boolean;
  readonly clock?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly realtimeAttempts?: number;
  readonly historyAttempts?: number;
}

export interface DispatchErrorEvidence {
  readonly classification: "exchange-rejection" | "ambiguous-transport";
  readonly transportKind: TransportFailureKind | undefined;
  readonly retCode: number | undefined;
  readonly explanation: string;
}

export type EntryScenarioResult =
  | Readonly<{
      kind: "refused";
      acknowledgement: "not-dispatched";
      approval: Extract<ProbeApproval, { kind: "refused" }>;
      attachedExits: "not-observed";
    }>
  | Readonly<{
      kind: "rejected" | "resting" | "terminal" | "unresolved" | "ambiguous";
      acknowledgement: "pending" | "rejected";
      attachedExits:
        "accepted" | "silent-drop" | "not-observed" | "rejected-110057";
      protectionAfterFill: "not-tested";
      reconciliation: ReconciliationResult;
      side: "Buy" | "Sell";
      orderLinkId: string;
      exchangeOrderId: string | undefined;
      duplicateOutcome: "rejected" | "accepted" | undefined;
      dispatchError: DispatchErrorEvidence | undefined;
    }>;

export type DispatchedEntryScenarioResult = Exclude<
  EntryScenarioResult,
  Readonly<{ kind: "refused" }>
>;

function attachedExitEvidence(
  order: ValidatedOrder | undefined,
): "accepted" | "silent-drop" | "not-observed" {
  if (!order) return "not-observed";
  const takeProfit = classifyExitValue(order.takeProfit);
  const stopLoss = classifyExitValue(order.stopLoss);
  if (takeProfit === "present" && stopLoss === "present") return "accepted";
  if (takeProfit === "absent" && stopLoss === "absent") return "silent-drop";
  return "not-observed";
}

function classifyExitValue(
  value: string | undefined,
): "present" | "absent" | "invalid" {
  if (value === undefined) return "absent";
  try {
    return decimalIsZero(parseDecimal(value)) ? "absent" : "present";
  } catch {
    return "invalid";
  }
}

function resultOrderId(response: BybitResponse): string | undefined {
  const value = response.result.orderId;
  return safeString(value);
}

function rejectionReconciliation(message: string): ReconciliationResult {
  return {
    kind: "rejected",
    acknowledgement: "pending",
    order: undefined,
    lookupCount: 0,
    terminalState: undefined,
    source: undefined,
    message,
  };
}

function sanitizedDispatchError(
  error: unknown,
): DispatchErrorEvidence | undefined {
  if (error === undefined) return undefined;
  if (error instanceof BybitProbeTransportError) {
    const retCode = Number.isSafeInteger(error.retCode)
      ? error.retCode
      : undefined;
    const ambiguousExchangeOutcome =
      retCode === undefined || retCode === 10000 || retCode === 10016;
    return {
      classification: ambiguousExchangeOutcome
        ? "ambiguous-transport"
        : "exchange-rejection",
      transportKind: error.kind,
      retCode,
      explanation:
        retCode === undefined
          ? "The request outcome is ambiguous; reconcile saved order and account state before any retry."
          : classifyRetCode(retCode).message,
    };
  }
  return {
    classification: "ambiguous-transport",
    transportKind: undefined,
    retCode: undefined,
    explanation:
      "The request outcome is ambiguous; reconcile saved order and account state before any retry.",
  };
}

const DETERMINISTIC_REJECTION_CODES = new Set([10014, 10024, 110057, 110072]);

export async function runEntryScenario(
  options: EntryScenarioOptions,
): Promise<EntryScenarioResult> {
  const clock = options.clock ?? Date.now;
  const approval = await options.authorize(options.plan);
  if (approval.kind === "refused") {
    return {
      kind: "refused",
      acknowledgement: "not-dispatched",
      approval,
      attachedExits: "not-observed",
    };
  }
  const orderLinkId = safeString(options.plan.params.orderLinkId);
  if (!orderLinkId) throw new Error("entry probe plan requires an orderLinkId");
  await options.store.writeIntent({
    runId: options.runId,
    attemptId: options.attemptId,
    scenario: options.plan.scenario,
    plan: options.plan,
    planDigest: approval.digest,
    approvedAt: approval.approvedAt,
    approvalExpiresAt: approval.expiresAt,
    createdAt: clock(),
    orderLinkId,
    exchangeOrderId: undefined,
    baselineSignedQty: options.baselineSignedQty,
  });
  reverifyProbeApproval(approval, options.plan, clock());

  let acknowledgement: BybitResponse | undefined;
  let dispatchError: unknown;
  try {
    acknowledgement = await options.transport.post(
      options.plan.endpoint,
      options.plan.params as unknown as JsonObject,
    );
  } catch (error) {
    dispatchError = error;
  }
  const acknowledgedOrderId = acknowledgement
    ? resultOrderId(acknowledgement)
    : undefined;
  const reconciliationOrderId = options.discardAcknowledgement
    ? undefined
    : acknowledgedOrderId;
  if (reconciliationOrderId !== undefined) {
    await options.store.updateIntent(options.runId, options.attemptId, {
      exchangeOrderId: reconciliationOrderId,
      baselineSignedQty: options.baselineSignedQty,
    });
  }
  const duplicateOutcome =
    dispatchError instanceof BybitProbeTransportError &&
    (dispatchError.retCode === 10014 || dispatchError.retCode === 110072)
      ? "rejected"
      : undefined;
  const attachedExitRejection =
    dispatchError instanceof BybitProbeTransportError &&
    dispatchError.retCode === 110057;
  const deterministicExchangeRejection =
    dispatchError instanceof BybitProbeTransportError &&
    dispatchError.retCode !== undefined &&
    DETERMINISTIC_REJECTION_CODES.has(dispatchError.retCode);
  const isDeterministicRejection =
    duplicateOutcome === "rejected" ||
    attachedExitRejection ||
    deterministicExchangeRejection;
  const dispatchErrorEvidence = sanitizedDispatchError(dispatchError);
  const reconciliation = isDeterministicRejection
    ? rejectionReconciliation(
        duplicateOutcome === "rejected"
          ? "Bybit rejected the reused client order ID; the prior order identity was not reused."
          : attachedExitRejection
            ? "Bybit rejected attached TP/SL parameters with 110057."
            : (dispatchErrorEvidence?.explanation ??
              "Bybit rejected the probe write before creating an order."),
      )
    : await reconcileOrder(options.transport, {
        orderLinkId,
        category: options.plan.params.category,
        symbol: options.plan.params.symbol,
        ...(reconciliationOrderId === undefined
          ? {}
          : { exchangeOrderId: reconciliationOrderId }),
        ...(options.realtimeAttempts === undefined
          ? {}
          : { realtimeAttempts: options.realtimeAttempts }),
        ...(options.historyAttempts === undefined
          ? {}
          : { historyAttempts: options.historyAttempts }),
        ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      });
  const order = reconciliation.order;
  if (order && reconciliationOrderId === undefined) {
    await options.store.updateIntent(options.runId, options.attemptId, {
      exchangeOrderId: order.orderId,
      baselineSignedQty: options.baselineSignedQty,
    });
  }
  const attachedExits = attachedExitRejection
    ? "rejected-110057"
    : attachedExitEvidence(order);
  const kind = isDeterministicRejection ? "rejected" : reconciliation.kind;
  const duplicateScenarioOutcome =
    options.plan.scenario === "duplicate-client-order-id"
      ? (duplicateOutcome ??
        (acknowledgement === undefined ? undefined : "accepted"))
      : undefined;
  return {
    kind,
    acknowledgement: isDeterministicRejection ? "rejected" : "pending",
    attachedExits,
    protectionAfterFill: "not-tested",
    reconciliation,
    side: options.plan.params.side,
    orderLinkId,
    exchangeOrderId: order?.orderId ?? reconciliationOrderId,
    duplicateOutcome: duplicateScenarioOutcome,
    dispatchError: dispatchErrorEvidence,
  };
}

export function buildAttachedEntryPlan(input: {
  readonly environment: "testnet";
  readonly accountId: string;
  readonly scenario: string;
  readonly expiresAt: number;
  readonly category: string;
  readonly symbol: string;
  readonly side: "Buy" | "Sell";
  readonly orderLinkId: string;
  readonly price: string;
  readonly qty: string;
  readonly takeProfit: string;
  readonly stopLoss: string;
}): ProbePlan {
  const params: ProbeOrderParameters = {
    category: input.category,
    symbol: input.symbol,
    side: input.side,
    orderLinkId: input.orderLinkId,
    price: input.price,
    qty: input.qty,
    takeProfit: input.takeProfit,
    stopLoss: input.stopLoss,
    orderType: "Limit",
    timeInForce: "PostOnly",
    reduceOnly: false,
    positionIdx: 0,
    tpslMode: "Full",
    tpOrderType: "Market",
    slOrderType: "Market",
    tpTriggerBy: "LastPrice",
    slTriggerBy: "LastPrice",
  };
  return buildProbePlan({
    environment: input.environment,
    accountId: input.accountId,
    scenario: input.scenario,
    expiresAt: input.expiresAt,
    method: "POST",
    endpoint: "/v5/order/create",
    params,
  });
}

export const reconcileByOrderLinkId = reconcileOrder;
