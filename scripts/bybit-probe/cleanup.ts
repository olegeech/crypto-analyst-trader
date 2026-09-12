import {
  absDecimal,
  addDecimals,
  compareDecimals,
  decimalIsZero,
  negateDecimal,
  parseDecimal,
  subtractDecimals,
  toDecimalString,
} from "./decimal.js";
import { reverifyProbeApproval, type ProbeApproval } from "./approval.js";
import { buildProbePlan, type ProbePlan } from "./probe-plan.js";
import { TERMINAL_ORDER_STATUSES } from "./scenarios.js";
import type { ProbeStore } from "./store.js";
import {
  responseList,
  type BybitResponse,
  type QueryInput,
} from "./transport.js";

type JsonObject = Record<string, unknown>;

export interface CleanupTransport {
  get(path: string, query?: QueryInput): Promise<BybitResponse>;
  post(path: string, body: JsonObject): Promise<BybitResponse>;
}

export interface OwnedExecution {
  readonly executionId: string;
  readonly orderId: string;
  readonly orderLinkId: string;
  readonly side: "Buy" | "Sell";
  readonly qty: string;
}

export function ownedExecutionFingerprint(execution: OwnedExecution): string {
  return JSON.stringify([
    execution.executionId,
    execution.orderId,
    execution.orderLinkId,
    execution.side,
    execution.qty,
  ]);
}

export interface OwnershipState {
  readonly currentSignedQty: string;
  readonly ownedOrderIds: readonly string[];
  readonly protectiveExitOrderIds: readonly string[];
  readonly executionFingerprints: readonly string[];
}

export interface EntryOrderIdentity {
  readonly orderId: string;
  readonly orderLinkId: string;
}

export interface OwnershipContext {
  readonly runId: string;
  readonly entryOrderIds: ReadonlySet<string>;
  readonly protectiveExitOrderIds: ReadonlySet<string>;
}

export function isOwnedEntry(
  order: EntryOrderIdentity,
  context: OwnershipContext,
): boolean {
  return (
    context.entryOrderIds.has(order.orderId) &&
    !context.protectiveExitOrderIds.has(order.orderId) &&
    order.orderLinkId.startsWith(`${context.runId}-`)
  );
}

export type OwnedExposureResult =
  | Readonly<{
      kind: "owned";
      remainingSignedQty: string;
      flattenSide: "Buy" | "Sell";
      flattenQty: string;
    }>
  | Readonly<{ kind: "already-flat"; remainingSignedQty: "0" }>
  | Readonly<{ kind: "unresolved"; message: string }>;

function signedExecutionQty(execution: OwnedExecution) {
  const quantity = parseDecimal(execution.qty);
  return execution.side === "Buy" ? quantity : negateDecimal(quantity);
}

export function deriveOwnedExposure(input: {
  readonly baselineSignedQty: string;
  readonly currentSignedQty: string;
  readonly executions: readonly OwnedExecution[];
}): OwnedExposureResult {
  let expectedDelta = parseDecimal("0");
  const executionIds = new Set<string>();
  for (const execution of input.executions) {
    if (
      executionIds.has(execution.executionId) ||
      !execution.executionId ||
      !execution.orderId ||
      !execution.orderLinkId
    ) {
      return {
        kind: "unresolved",
        message: "execution ownership is incomplete or duplicated",
      };
    }
    executionIds.add(execution.executionId);
    try {
      expectedDelta = addDecimals(expectedDelta, signedExecutionQty(execution));
    } catch {
      return { kind: "unresolved", message: "execution quantity is invalid" };
    }
  }
  let baseline;
  let current;
  try {
    baseline = parseDecimal(input.baselineSignedQty);
    current = parseDecimal(input.currentSignedQty);
  } catch {
    return {
      kind: "unresolved",
      message: "baseline or current position is invalid",
    };
  }
  const actualDelta = subtractDecimals(current, baseline);
  if (compareDecimals(actualDelta, expectedDelta) !== 0) {
    return {
      kind: "unresolved",
      message:
        "current position is not explained by owned entry and exit executions",
    };
  }
  if (decimalIsZero(actualDelta))
    return { kind: "already-flat", remainingSignedQty: "0" };
  const flattenSide = actualDelta.coefficient > 0n ? "Sell" : "Buy";
  return {
    kind: "owned",
    remainingSignedQty: toDecimalString(actualDelta),
    flattenSide,
    flattenQty: toDecimalString(absDecimal(actualDelta)),
  };
}

export type CleanupResult =
  | Readonly<{
      kind: "confirmed-clean";
      exchangeOrderId?: string;
      message: string;
    }>
  | Readonly<{ kind: "already-flat"; message: string }>
  | Readonly<{ kind: "unresolved"; message: string }>;

function refusalMessage(approval: ProbeApproval): string {
  return approval.kind === "refused"
    ? `cleanup approval refused (${approval.reason})`
    : "cleanup was not approved";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sameStringSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return (
    leftSet.size === rightSet.size &&
    [...leftSet].every((value) => rightSet.has(value))
  );
}

export async function proveCleanState(
  transport: CleanupTransport,
  category: string,
  symbol: string,
): Promise<boolean> {
  const orders = responseList(
    await transport.get("/v5/order/realtime", {
      category,
      symbol,
      openOnly: "0",
      limit: "1",
    }),
  );
  if (!orders) return false;
  if (orders.length > 0) return false;
  const positions = responseList(
    await transport.get("/v5/position/list", { category, symbol }),
  );
  if (!positions) return false;
  for (const position of positions) {
    const size = stringValue(position.size);
    if (size === undefined) return false;
    try {
      if (!decimalIsZero(parseDecimal(size))) return false;
    } catch {
      return false;
    }
    if (
      position.side !== undefined &&
      position.side !== "" &&
      position.side !== "None"
    )
      return false;
  }
  return true;
}

export interface CleanupOwnedEntryOptions {
  readonly runId: string;
  readonly attemptId: string;
  readonly accountId: string;
  readonly category: string;
  readonly symbol: string;
  readonly order: EntryOrderIdentity & {
    readonly side: "Buy" | "Sell";
    readonly orderStatus: string;
  };
  readonly entryOrderIds: ReadonlySet<string>;
  readonly protectiveExitOrderIds: ReadonlySet<string>;
  readonly store: ProbeStore;
  readonly transport: CleanupTransport;
  readonly approve: (plan: ProbePlan) => Promise<ProbeApproval>;
  readonly readOwnership?: () => Promise<boolean>;
  readonly clock?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export async function cleanupOwnedEntry(
  options: CleanupOwnedEntryOptions,
): Promise<CleanupResult> {
  const context = {
    runId: options.runId,
    entryOrderIds: options.entryOrderIds,
    protectiveExitOrderIds: options.protectiveExitOrderIds,
  };
  if (!isOwnedEntry(options.order, context)) {
    return {
      kind: "unresolved",
      message: "entry identity is not proven to belong to this run",
    };
  }
  if (TERMINAL_ORDER_STATUSES.has(options.order.orderStatus)) {
    return {
      kind: "already-flat",
      message: "entry is already terminal; no cancel write was needed",
    };
  }
  const plan = buildProbePlan({
    environment: "testnet",
    accountId: options.accountId,
    scenario: "cleanup-cancel-entry",
    expiresAt: (options.clock ?? Date.now)() + 120_000,
    method: "POST",
    endpoint: "/v5/order/cancel",
    params: {
      category: options.category,
      symbol: options.symbol,
      side: options.order.side,
      orderId: options.order.orderId,
      orderLinkId: options.order.orderLinkId,
      positionIdx: 0,
    },
  });
  const approval = await options.approve(plan);
  if (approval.kind === "refused")
    return { kind: "unresolved", message: refusalMessage(approval) };
  await options.store.writeIntent({
    runId: options.runId,
    attemptId: options.attemptId,
    scenario: plan.scenario,
    plan,
    planDigest: approval.digest,
    approvedAt: approval.approvedAt,
    approvalExpiresAt: approval.expiresAt,
    createdAt: (options.clock ?? Date.now)(),
    orderLinkId: options.order.orderLinkId,
    exchangeOrderId: options.order.orderId,
    baselineSignedQty: undefined,
  });
  if (options.readOwnership !== undefined) {
    try {
      if (!(await options.readOwnership())) {
        return {
          kind: "unresolved",
          message: "entry ownership changed during cleanup approval",
        };
      }
    } catch {
      return {
        kind: "unresolved",
        message: "entry ownership could not be revalidated before cancel",
      };
    }
  }
  try {
    reverifyProbeApproval(approval, plan, (options.clock ?? Date.now)());
  } catch (error) {
    return {
      kind: "unresolved",
      message:
        error instanceof Error ? error.message : "cleanup approval expired",
    };
  }
  try {
    await options.transport.post(
      "/v5/order/cancel",
      plan.params as unknown as JsonObject,
    );
  } catch {
    return { kind: "unresolved", message: "cancel outcome was ambiguous" };
  }
  if (
    !(await proveCleanState(
      options.transport,
      options.category,
      options.symbol,
    ))
  ) {
    return {
      kind: "unresolved",
      message: "clean state could not be proven after cancel",
    };
  }
  return {
    kind: "confirmed-clean",
    exchangeOrderId: options.order.orderId,
    message: "owned entry cancelled and clean state reconciled",
  };
}

export interface FlattenOwnedExposureOptions {
  readonly runId: string;
  readonly attemptId: string;
  readonly accountId: string;
  readonly category: string;
  readonly symbol: string;
  readonly baselineSignedQty: string;
  readonly currentState: OwnershipState;
  readonly executions: readonly OwnedExecution[];
  readonly store: ProbeStore;
  readonly transport: CleanupTransport;
  readonly approve: (plan: ProbePlan) => Promise<ProbeApproval>;
  readonly ownedOrderIdentities?: ReadonlyMap<string, string>;
  readonly readOwnership?: () => Promise<OwnershipState>;
  readonly clock?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export async function flattenOwnedExposure(
  options: FlattenOwnedExposureOptions,
): Promise<CleanupResult> {
  const knownOrderIds = new Set([
    ...options.currentState.ownedOrderIds,
    ...options.currentState.protectiveExitOrderIds,
  ]);
  for (const execution of options.executions) {
    const expectedOrderLinkId = options.ownedOrderIdentities?.get(
      execution.orderId,
    );
    if (
      !knownOrderIds.has(execution.orderId) ||
      (expectedOrderLinkId !== undefined &&
        expectedOrderLinkId !== execution.orderLinkId) ||
      (expectedOrderLinkId === undefined &&
        !execution.orderLinkId.startsWith(`${options.runId}-`))
    ) {
      return {
        kind: "unresolved",
        message:
          "execution refers to an order not proven to belong to this run",
      };
    }
  }
  const exposure = deriveOwnedExposure({
    baselineSignedQty: options.baselineSignedQty,
    currentSignedQty: options.currentState.currentSignedQty,
    executions: options.executions,
  });
  if (exposure.kind === "unresolved") return exposure;
  if (exposure.kind === "already-flat") {
    return (await proveCleanState(
      options.transport,
      options.category,
      options.symbol,
    ))
      ? {
          kind: "already-flat",
          message:
            "owned exposure is already flat and clean state is reconciled",
        }
      : { kind: "unresolved", message: "flat position still has open orders" };
  }
  const flattenSuffix = `-flatten-${options.attemptId}`;
  const runIdLength = 36 - flattenSuffix.length;
  if (runIdLength < 1) {
    return {
      kind: "unresolved",
      message: "flatten attempt identity does not fit the exchange limit",
    };
  }
  const orderLinkId = `${options.runId.slice(-runIdLength)}${flattenSuffix}`;
  const plan = buildProbePlan({
    environment: "testnet",
    accountId: options.accountId,
    scenario: "cleanup-flatten-exposure",
    expiresAt: (options.clock ?? Date.now)() + 120_000,
    method: "POST",
    endpoint: "/v5/order/create",
    params: {
      category: options.category,
      symbol: options.symbol,
      side: exposure.flattenSide,
      orderLinkId,
      qty: exposure.flattenQty,
      orderType: "Market",
      timeInForce: "IOC",
      reduceOnly: true,
      positionIdx: 0,
    },
  });
  const approval = await options.approve(plan);
  if (approval.kind === "refused")
    return { kind: "unresolved", message: refusalMessage(approval) };
  await options.store.writeIntent({
    runId: options.runId,
    attemptId: options.attemptId,
    scenario: plan.scenario,
    plan,
    planDigest: approval.digest,
    approvedAt: approval.approvedAt,
    approvalExpiresAt: approval.expiresAt,
    createdAt: (options.clock ?? Date.now)(),
    orderLinkId,
    exchangeOrderId: undefined,
    baselineSignedQty: options.baselineSignedQty,
  });
  if (options.readOwnership !== undefined) {
    let reread: OwnershipState;
    try {
      reread = await options.readOwnership();
    } catch {
      return {
        kind: "unresolved",
        message: "ownership could not be revalidated before flatten",
      };
    }
    try {
      if (
        compareDecimals(
          parseDecimal(reread.currentSignedQty),
          parseDecimal(options.currentState.currentSignedQty),
        ) !== 0 ||
        !sameStringSet(
          reread.ownedOrderIds,
          options.currentState.ownedOrderIds,
        ) ||
        !sameStringSet(
          reread.protectiveExitOrderIds,
          options.currentState.protectiveExitOrderIds,
        ) ||
        !sameStringSet(
          reread.executionFingerprints,
          options.currentState.executionFingerprints,
        )
      ) {
        return {
          kind: "unresolved",
          message: "ownership changed during flatten approval",
        };
      }
    } catch {
      return {
        kind: "unresolved",
        message: "ownership could not be validated before flatten",
      };
    }
  }
  try {
    reverifyProbeApproval(approval, plan, (options.clock ?? Date.now)());
  } catch (error) {
    return {
      kind: "unresolved",
      message:
        error instanceof Error ? error.message : "cleanup approval expired",
    };
  }
  try {
    await options.transport.post(
      "/v5/order/create",
      plan.params as unknown as JsonObject,
    );
  } catch {
    return { kind: "unresolved", message: "flatten outcome was ambiguous" };
  }
  if (
    !(await proveCleanState(
      options.transport,
      options.category,
      options.symbol,
    ))
  ) {
    return {
      kind: "unresolved",
      message: "clean state could not be proven after flatten",
    };
  }
  return {
    kind: "confirmed-clean",
    message:
      "owned exposure flattened with reduce-only order and clean state reconciled",
  };
}

export const reconcileOwnedExposure = deriveOwnedExposure;
