import { decimalIsZero, parseDecimal } from "./decimal.js";
import {
  accountHash,
  isManualRecoveryClosedStatus,
  MANUAL_RECOVERY_STATUS,
  type ManualRecoveryCheck,
  type ProbeVerdict,
  type StoredIntent,
  type StoredRun,
  type ProbeStore,
} from "./store.js";
import { recoverInterruptedRun } from "./recovery.js";
import { hashProbePlan, type ProbePlan } from "./probe-plan.js";
import type { ProbeApproval } from "./approval.js";
import {
  responseList,
  type BybitResponse,
  type QueryInput,
} from "./transport.js";

type JsonObject = Record<string, unknown>;

export interface ManualRecoveryTransport {
  get(path: string, query?: QueryInput): Promise<BybitResponse>;
  post(path: string, body: JsonObject): Promise<BybitResponse>;
}

export interface ManualRecoveryTarget {
  readonly runId: string;
  readonly accountIdHash: string;
  readonly checks: readonly {
    readonly category: string;
    readonly symbol: string;
    readonly orderLinkId: string;
    readonly exchangeOrderId: string | undefined;
  }[];
}

export interface ManualRecoveryOptions {
  readonly runId: string;
  readonly accountId: string;
  readonly store: ProbeStore;
  readonly transport: ManualRecoveryTransport;
  readonly authorize: (plan: ProbePlan) => Promise<ProbeApproval>;
  readonly readOwnedExposure?: Parameters<
    typeof recoverInterruptedRun
  >[0]["readOwnedExposure"];
  readonly clock?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly realtimeAttempts?: number;
  readonly historyAttempts?: number;
  readonly output?: { write(message: string): void };
}

export type ManualRecoveryResultStatus =
  | typeof MANUAL_RECOVERY_STATUS
  | "RECOVERED_CLEAN"
  | "MANUAL_RECOVERY_BLOCKED"
  | "PRECONDITION_FAILED";

export interface ManualRecoveryResult {
  readonly status: ManualRecoveryResultStatus;
  readonly runId: string;
  readonly message: string;
  readonly originalVerdict?: ProbeVerdict;
}

const DEFAULT_LOOKUP_ATTEMPTS = 2;
const MAX_READ_PAGES = 5;

function originalVerdict(verdict: ProbeVerdict | undefined): {
  readonly originalVerdict?: ProbeVerdict;
} {
  return verdict === undefined ? {} : { originalVerdict: verdict };
}

function display(value: string): string {
  return value && !/[\u0000-\u001f\u007f\r\n]/.test(value)
    ? value
    : "unverified";
}

function intentIdentity(intent: StoredIntent):
  | {
      readonly category: string;
      readonly symbol: string;
      readonly orderLinkId: string;
      readonly exchangeOrderId: string | undefined;
    }
  | undefined {
  const category = intent.plan.params.category;
  const symbol = intent.plan.params.symbol;
  const orderLinkId = intent.orderLinkId ?? intent.plan.params.orderLinkId;
  if (
    typeof category !== "string" ||
    typeof symbol !== "string" ||
    typeof orderLinkId !== "string"
  ) {
    return undefined;
  }
  return {
    category,
    symbol,
    orderLinkId,
    exchangeOrderId: intent.exchangeOrderId,
  };
}

function planMatchesAccount(intent: StoredIntent, accountId: string): boolean {
  const { accountIdHash: persistedAccountHash, ...redactedPlan } = intent.plan;
  return (
    persistedAccountHash === accountHash(accountId) &&
    hashProbePlan({
      ...redactedPlan,
      accountId,
    }) === intent.planDigest
  );
}

function orderMatches(
  value: JsonObject,
  identity: ReturnType<typeof intentIdentity>,
): boolean {
  if (!identity) return false;
  const orderLinkId = value.orderLinkId;
  const orderId = value.orderId;
  return (
    orderLinkId === identity.orderLinkId &&
    (identity.exchangeOrderId === undefined ||
      orderId === identity.exchangeOrderId)
  );
}

function orderIdentityConflict(
  value: JsonObject,
  identity: ReturnType<typeof intentIdentity>,
): boolean {
  if (!identity) return true;
  return (
    (value.orderLinkId === identity.orderLinkId &&
      identity.exchangeOrderId !== undefined &&
      value.orderId !== identity.exchangeOrderId) ||
    (identity.exchangeOrderId !== undefined &&
      value.orderId === identity.exchangeOrderId &&
      value.orderLinkId !== identity.orderLinkId)
  );
}

async function readOrderState(
  transport: ManualRecoveryTransport,
  path: "/v5/order/realtime" | "/v5/order/history",
  identity: NonNullable<ReturnType<typeof intentIdentity>>,
  attempts: number,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<{ matches: number; conflict: boolean }> {
  let matches = 0;
  let conflict = false;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await transport.get(path, {
      category: identity.category,
      symbol: identity.symbol,
      ...(identity.exchangeOrderId === undefined
        ? { orderLinkId: identity.orderLinkId }
        : { orderId: identity.exchangeOrderId }),
    });
    const list = responseList(response);
    if (list === undefined) throw new Error(`${path} returned an invalid list`);
    for (const item of list) {
      if (orderMatches(item, identity)) matches += 1;
      else if (orderIdentityConflict(item, identity)) conflict = true;
    }
    if (matches > 0 || conflict) break;
    if (attempt + 1 < attempts) await sleep(1_000);
  }
  return { matches, conflict };
}

async function readOpenOrders(
  transport: ManualRecoveryTransport,
  identity: NonNullable<ReturnType<typeof intentIdentity>>,
): Promise<{ matches: number; count: number; conflict: boolean }> {
  let cursor: string | undefined;
  let matches = 0;
  let count = 0;
  let conflict = false;
  for (let page = 0; page < MAX_READ_PAGES; page += 1) {
    const response = await transport.get("/v5/order/realtime", {
      category: identity.category,
      symbol: identity.symbol,
      openOnly: "0",
      limit: "50",
      ...(cursor === undefined ? {} : { cursor }),
    });
    const list = responseList(response);
    if (list === undefined) throw new Error("open order response is invalid");
    count += list.length;
    for (const item of list) {
      if (orderMatches(item, identity)) matches += 1;
      else if (orderIdentityConflict(item, identity)) conflict = true;
    }
    const nextCursor = response.result.nextPageCursor;
    if (nextCursor === undefined || nextCursor === "")
      return { matches, count, conflict };
    if (typeof nextCursor !== "string" || nextCursor === cursor) {
      throw new Error("open order pagination is invalid");
    }
    cursor = nextCursor;
  }
  throw new Error("open order pagination exceeded the bounded read budget");
}

async function readExecutions(
  transport: ManualRecoveryTransport,
  identity: NonNullable<ReturnType<typeof intentIdentity>>,
): Promise<{ matches: number; conflict: boolean }> {
  let cursor: string | undefined;
  let matches = 0;
  let conflict = false;
  for (let page = 0; page < MAX_READ_PAGES; page += 1) {
    const response = await transport.get("/v5/execution/list", {
      category: identity.category,
      symbol: identity.symbol,
      limit: "50",
      ...(cursor === undefined ? {} : { cursor }),
    });
    const list = responseList(response);
    if (list === undefined) throw new Error("execution response is invalid");
    for (const item of list) {
      const sameOrderId =
        identity.exchangeOrderId !== undefined &&
        item.orderId === identity.exchangeOrderId;
      const sameOrderLinkId = item.orderLinkId === identity.orderLinkId;
      if (
        sameOrderLinkId &&
        (identity.exchangeOrderId === undefined || sameOrderId)
      ) {
        matches += 1;
      } else if (sameOrderId || sameOrderLinkId) {
        conflict = true;
      }
    }
    const nextCursor = response.result.nextPageCursor;
    if (nextCursor === undefined || nextCursor === "") {
      return { matches, conflict };
    }
    if (typeof nextCursor !== "string" || nextCursor === cursor) {
      throw new Error("execution pagination is invalid");
    }
    cursor = nextCursor;
  }
  throw new Error("execution pagination exceeded the bounded read budget");
}

async function readPosition(
  transport: ManualRecoveryTransport,
  identity: NonNullable<ReturnType<typeof intentIdentity>>,
): Promise<"flat" | "non-flat"> {
  const response = await transport.get("/v5/position/list", {
    category: identity.category,
    symbol: identity.symbol,
  });
  const list = responseList(response);
  if (list === undefined) throw new Error("position response is invalid");
  for (const item of list) {
    if (typeof item.size !== "string")
      throw new Error("position size is invalid");
    try {
      if (!decimalIsZero(parseDecimal(item.size))) return "non-flat";
    } catch {
      throw new Error("position size is invalid");
    }
    if (item.side !== undefined && item.side !== "" && item.side !== "None") {
      return "non-flat";
    }
  }
  return "flat";
}

async function inspectIntent(
  transport: ManualRecoveryTransport,
  intent: StoredIntent,
  options: {
    readonly realtimeAttempts: number;
    readonly historyAttempts: number;
    readonly sleep: (milliseconds: number) => Promise<void>;
  },
): Promise<{
  readonly check: ManualRecoveryCheck;
  readonly ownedEvidence: boolean;
  readonly nonCleanReason: string | undefined;
}> {
  const identity = intentIdentity(intent);
  if (!identity) throw new Error("saved run lacks a validated order identity");
  const [realtime, history, openOrders, executionMatches, position] =
    await Promise.all([
      readOrderState(
        transport,
        "/v5/order/realtime",
        identity,
        options.realtimeAttempts,
        options.sleep,
      ),
      readOrderState(
        transport,
        "/v5/order/history",
        identity,
        options.historyAttempts,
        options.sleep,
      ),
      readOpenOrders(transport, identity),
      readExecutions(transport, identity),
      readPosition(transport, identity),
    ]);
  const executionState = executionMatches;
  const ownedEvidence =
    realtime.matches +
      history.matches +
      openOrders.matches +
      executionState.matches >
    0;
  const nonCleanReason =
    openOrders.count > 0 && openOrders.matches === 0
      ? "unrelated open orders remain on the saved symbol"
      : position === "non-flat" && !ownedEvidence
        ? "a non-flat position remains without a proven saved-order identity"
        : realtime.conflict ||
            history.conflict ||
            openOrders.conflict ||
            executionState.conflict
          ? "an exchange order identity conflicts with the saved intent"
          : undefined;
  return {
    check: {
      category: identity.category,
      symbol: identity.symbol,
      orderLinkId: identity.orderLinkId,
      exchangeOrderId: identity.exchangeOrderId,
      realtimeOrderMatches: realtime.matches,
      historyOrderMatches: history.matches,
      executionMatches: executionState.matches,
      openOrderMatches: openOrders.matches,
      openOrderCount: openOrders.count,
      position,
    },
    ownedEvidence,
    nonCleanReason,
  };
}

function targetFromRun(
  run: StoredRun,
  accountId: string,
): ManualRecoveryTarget | undefined {
  const checks = run.intents.map(intentIdentity);
  if (checks.some((check) => check === undefined)) return undefined;
  return {
    runId: run.runId,
    accountIdHash: accountHash(accountId),
    checks: checks as ManualRecoveryTarget["checks"],
  };
}

export async function runManualRecovery(
  options: ManualRecoveryOptions,
): Promise<ManualRecoveryResult> {
  const clock = options.clock ?? Date.now;
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let lockHeld = false;
  try {
    await options.store.acquireLock(options.runId);
    lockHeld = true;
    const saved = (await options.store.listSavedRuns()).find(
      (run) => run.runId === options.runId,
    );
    if (!saved) {
      return {
        status: "PRECONDITION_FAILED",
        runId: options.runId,
        message: "the saved probe run was not found",
      };
    }
    if (isManualRecoveryClosedStatus(saved.manualRecovery?.status)) {
      return {
        status: MANUAL_RECOVERY_STATUS,
        runId: options.runId,
        message: "manual recovery was already confirmed for this run",
        ...originalVerdict(saved.verdict),
      };
    }
    if (saved.verdict !== "UNRESOLVED") {
      return {
        status: "PRECONDITION_FAILED",
        runId: options.runId,
        message: "manual recovery requires an UNRESOLVED saved run",
        ...originalVerdict(saved.verdict),
      };
    }
    if (saved.intents.length === 0) {
      return {
        status: "MANUAL_RECOVERY_BLOCKED",
        runId: options.runId,
        message: "manual recovery requires a durable saved intent",
        ...originalVerdict(saved.verdict),
      };
    }
    if (
      !saved.intents.every((intent) =>
        planMatchesAccount(intent, options.accountId),
      )
    ) {
      return {
        status: "MANUAL_RECOVERY_BLOCKED",
        runId: options.runId,
        message: `the current ${options.store.environment === "demo" ? "Demo" : "Testnet"} account does not match the saved run`,
        ...originalVerdict(saved.verdict),
      };
    }
    const target = targetFromRun(saved, options.accountId);
    if (!target) {
      return {
        status: "MANUAL_RECOVERY_BLOCKED",
        runId: options.runId,
        message: "the saved run lacks a validated recovery identity",
        ...originalVerdict(saved.verdict),
      };
    }
    const realtimeAttempts =
      options.realtimeAttempts ?? DEFAULT_LOOKUP_ATTEMPTS;
    const historyAttempts = options.historyAttempts ?? DEFAULT_LOOKUP_ATTEMPTS;
    if (
      !Number.isInteger(realtimeAttempts) ||
      realtimeAttempts < 1 ||
      !Number.isInteger(historyAttempts) ||
      historyAttempts < 1
    ) {
      return {
        status: "PRECONDITION_FAILED",
        runId: options.runId,
        message:
          "manual recovery requires positive realtime and history read budgets",
        ...originalVerdict(saved.verdict),
      };
    }
    options.output?.write(
      [
        "Manual recovery target",
        `runId: ${display(target.runId)}`,
        `account: ${display(target.accountIdHash)}`,
        ...target.checks.flatMap((check) => [
          `symbol: ${display(check.symbol)}`,
          `orderLinkId: ${display(check.orderLinkId)}`,
          ...(check.exchangeOrderId === undefined
            ? []
            : [`exchangeOrderId: ${display(check.exchangeOrderId)}`]),
        ]),
        "original capability result: UNRESOLVED (unverified)",
      ].join("\n") + "\n",
    );
    const inspections = [];
    for (const intent of saved.intents) {
      inspections.push(
        await inspectIntent(options.transport, intent, {
          realtimeAttempts,
          historyAttempts,
          sleep,
        }),
      );
    }
    const nonCleanReason = inspections.find(
      (inspection) => inspection.nonCleanReason !== undefined,
    )?.nonCleanReason;
    const ownedEvidence = inspections.some(
      (inspection) => inspection.ownedEvidence,
    );
    if (ownedEvidence) {
      await options.store.releaseLock(options.runId);
      lockHeld = false;
      const recovered = await recoverInterruptedRun({
        runId: options.runId,
        accountId: options.accountId,
        store: options.store,
        transport: options.transport,
        authorize: options.authorize,
        ...(options.readOwnedExposure === undefined
          ? {}
          : { readOwnedExposure: options.readOwnedExposure }),
        clock,
        sleep,
        ...(options.realtimeAttempts === undefined
          ? {}
          : { realtimeAttempts: options.realtimeAttempts }),
        ...(options.historyAttempts === undefined
          ? {}
          : { historyAttempts: options.historyAttempts }),
      });
      return {
        status:
          recovered.verdict === "CONFIRMED_CLEAN"
            ? "RECOVERED_CLEAN"
            : "MANUAL_RECOVERY_BLOCKED",
        runId: options.runId,
        message:
          recovered.verdict === "CONFIRMED_CLEAN"
            ? "owned state was found and reconciled through the normal recovery path"
            : recovered.message,
        ...originalVerdict(saved.verdict),
      };
    }
    if (nonCleanReason !== undefined) {
      return {
        status: "MANUAL_RECOVERY_BLOCKED",
        runId: options.runId,
        message: nonCleanReason,
        ...originalVerdict(saved.verdict),
      };
    }
    await options.store.writeManualRecovery({
      runId: options.runId,
      confirmedAt: clock(),
      accountIdHash: target.accountIdHash,
      originalVerdict: "UNRESOLVED",
      checks: inspections.map((inspection) => inspection.check),
    });
    return {
      status: MANUAL_RECOVERY_STATUS,
      runId: options.runId,
      message:
        "recovery reconciled clean state automatically; the original UNRESOLVED capability result remains unverified",
      ...originalVerdict(saved.verdict),
    };
  } catch (error) {
    return {
      status: "PRECONDITION_FAILED",
      runId: options.runId,
      message:
        error instanceof Error ? error.message : "manual recovery failed",
    };
  } finally {
    if (lockHeld) {
      try {
        await options.store.releaseLock(options.runId);
      } catch {
        // The recovery record remains the source of truth; the next run will
        // fail closed if the lock cannot be inspected.
      }
    }
  }
}
