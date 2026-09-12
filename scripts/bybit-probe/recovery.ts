import {
  cleanupOwnedEntry,
  flattenOwnedExposure,
  proveCleanState,
  type OwnedExecution,
  type OwnershipState,
} from "./cleanup.js";
import { accountHash, type ProbeVerdict, type StoredIntent } from "./store.js";
import type { ProbeStore } from "./store.js";
import { reconcileOrder } from "./scenarios.js";
import type { ProbeApproval } from "./approval.js";
import { hashProbePlan, type ProbePlan } from "./probe-plan.js";
import {
  responseList,
  type BybitResponse,
  type QueryInput,
} from "./transport.js";

export interface RecoveryTransport {
  get(path: string, query?: QueryInput): Promise<BybitResponse>;
  post(path: string, body: Record<string, unknown>): Promise<BybitResponse>;
}

export interface RecoveryOwnedExposure {
  readonly baselineSignedQty: string;
  readonly currentState: OwnershipState;
  readonly executions: readonly OwnedExecution[];
}

export interface RecoveryOptions {
  readonly runId: string;
  readonly accountId: string;
  readonly store: ProbeStore;
  readonly transport: RecoveryTransport;
  readonly approve: (plan: ProbePlan) => Promise<ProbeApproval>;
  readonly clock?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly realtimeAttempts?: number;
  readonly historyAttempts?: number;
  readonly readOwnedExposure?: (
    intent: StoredIntent,
    ownedOrderIdentities: ReadonlyMap<string, string>,
  ) => Promise<RecoveryOwnedExposure>;
}

export interface RecoveryResult {
  readonly runId: string;
  readonly verdict: ProbeVerdict;
  readonly message: string;
}

function handoff(
  runId: string,
  lastConfirmedState: string,
  uncertainty: string,
) {
  return {
    runId,
    lastConfirmedState,
    uncertainty,
    nextAction:
      "Reconcile the saved run through the exchange UI manual fallback described in SECURITY.md.",
  };
}

async function finalize(
  store: ProbeStore,
  runId: string,
  verdict: ProbeVerdict,
  message: string,
  unresolvedReason?: string,
): Promise<RecoveryResult> {
  if (verdict === "UNRESOLVED") {
    await store.writeVerdict(
      runId,
      verdict,
      handoff(runId, message, unresolvedReason ?? message),
    );
  } else {
    await store.writeVerdict(runId, verdict);
  }
  return { runId, verdict, message };
}

function orderIdentities(
  intents: readonly StoredIntent[],
): Map<string, string> {
  const identities = new Map<string, string>();
  for (const intent of intents) {
    if (
      intent.exchangeOrderId !== undefined &&
      intent.orderLinkId !== undefined
    ) {
      identities.set(intent.exchangeOrderId, intent.orderLinkId);
    }
  }
  return identities;
}

async function cleanAfterTerminal(
  transport: RecoveryTransport,
  intent: StoredIntent,
): Promise<boolean> {
  const symbol = intent.plan.params.symbol;
  const category = intent.plan.params.category;
  if (typeof symbol !== "string" || typeof category !== "string") return false;
  return proveCleanState(transport, category, symbol);
}

export async function recoverInterruptedRun(
  options: RecoveryOptions,
): Promise<RecoveryResult> {
  try {
    await options.store.acquireLock(options.runId);
  } catch (error) {
    return {
      runId: options.runId,
      verdict: "PRECONDITION_FAILED",
      message:
        error instanceof Error
          ? error.message
          : "the probe lock could not be acquired",
    };
  }

  try {
    const savedRuns = await options.store.listSavedRuns();
    const saved = savedRuns.find((run) => run.runId === options.runId);
    if (!saved)
      return {
        runId: options.runId,
        verdict: "PRECONDITION_FAILED",
        message: "the saved probe run was not found",
      };
    if (saved.verdict === "CONFIRMED_CLEAN") {
      return {
        runId: options.runId,
        verdict: "CONFIRMED_CLEAN",
        message: "the original run was already proven clean",
      };
    }
    if (saved.intents.length === 0) {
      return finalize(
        options.store,
        options.runId,
        "UNRESOLVED",
        "the original run has no durable intent evidence",
        "missing intent identity",
      );
    }
    const currentAccountHash = accountHash(options.accountId);
    if (
      saved.intents.some(
        (intent) => intent.plan.accountIdHash !== currentAccountHash,
      )
    ) {
      return finalize(
        options.store,
        options.runId,
        "UNRESOLVED",
        "the current Testnet account does not match the original run",
        "account identity mismatch",
      );
    }
    if (
      saved.intents.some((intent) => {
        const redactedPlan = {
          schemaVersion: intent.plan.schemaVersion,
          environment: intent.plan.environment,
          scenario: intent.plan.scenario,
          expiresAt: intent.plan.expiresAt,
          method: intent.plan.method,
          endpoint: intent.plan.endpoint,
          params: intent.plan.params,
        };
        return (
          hashProbePlan({
            ...redactedPlan,
            accountId: options.accountId,
          }) !== intent.planDigest
        );
      })
    ) {
      return finalize(
        options.store,
        options.runId,
        "UNRESOLVED",
        "the saved probe plan digest does not match its persisted intent",
        "persisted plan identity mismatch",
      );
    }

    const entryOrderIdentities = orderIdentities(saved.intents);
    for (const intent of saved.intents) {
      const orderLinkId = intent.orderLinkId ?? intent.plan.params.orderLinkId;
      const symbol = intent.plan.params.symbol;
      const category = intent.plan.params.category;
      if (
        typeof orderLinkId !== "string" ||
        typeof symbol !== "string" ||
        typeof category !== "string"
      ) {
        return finalize(
          options.store,
          options.runId,
          "UNRESOLVED",
          "the saved run lacks a validated order identity",
          "incomplete recovery identity",
        );
      }
      const reconciliation = await reconcileOrder(options.transport, {
        orderLinkId,
        ...(intent.exchangeOrderId === undefined
          ? {}
          : { exchangeOrderId: intent.exchangeOrderId }),
        category,
        symbol,
        ...(options.realtimeAttempts === undefined
          ? {}
          : { realtimeAttempts: options.realtimeAttempts }),
        ...(options.historyAttempts === undefined
          ? {}
          : { historyAttempts: options.historyAttempts }),
        ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      });
      if (
        reconciliation.kind === "unresolved" ||
        reconciliation.kind === "ambiguous"
      ) {
        return finalize(
          options.store,
          options.runId,
          "UNRESOLVED",
          "the original run could not be reconciled",
          reconciliation.message,
        );
      }
      if (reconciliation.kind === "rejected") {
        if (!(await cleanAfterTerminal(options.transport, intent))) {
          return finalize(
            options.store,
            options.runId,
            "UNRESOLVED",
            "a rejected original order left state that cannot be proven clean",
            "rejected order has a non-clean account state",
          );
        }
        continue;
      }
      const reconciledOrder = reconciliation.order;
      if (!reconciledOrder) {
        return finalize(
          options.store,
          options.runId,
          "UNRESOLVED",
          "the original run lacks a validated exchange order identity",
          "reconciliation returned no order identity",
        );
      }
      entryOrderIdentities.set(
        reconciledOrder.orderId,
        reconciledOrder.orderLinkId,
      );
      if (intent.exchangeOrderId === undefined) {
        await options.store.updateIntent(options.runId, intent.attemptId, {
          exchangeOrderId: reconciledOrder.orderId,
          baselineSignedQty: intent.baselineSignedQty,
        });
      }
      if (reconciliation.kind === "resting") {
        const order = reconciledOrder;
        const side = intent.plan.params.side;
        if (side !== "Buy" && side !== "Sell") {
          return finalize(
            options.store,
            options.runId,
            "UNRESOLVED",
            "the saved order side is invalid",
            "invalid side during recovery",
          );
        }
        const cleanup = await cleanupOwnedEntry({
          runId: options.runId,
          attemptId: `${intent.attemptId}-recover-cancel`,
          accountId: options.accountId,
          category,
          symbol,
          order: {
            orderId: order.orderId,
            orderLinkId: order.orderLinkId,
            side,
            orderStatus: order.orderStatus,
          },
          entryOrderIds: new Set(entryOrderIdentities.keys()),
          protectiveExitOrderIds: new Set<string>(),
          store: options.store,
          transport: options.transport,
          approve: options.approve,
          readOwnership: async () => {
            const response = await options.transport.get("/v5/order/realtime", {
              category,
              symbol,
              orderId: order.orderId,
            });
            const values = responseList(response);
            return (
              values !== undefined &&
              values.length === 1 &&
              values[0]?.orderId === order.orderId &&
              values[0]?.orderLinkId === order.orderLinkId
            );
          },
          ...(options.clock === undefined ? {} : { clock: options.clock }),
          ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
        });
        if (cleanup.kind === "unresolved") {
          return finalize(
            options.store,
            options.runId,
            "UNRESOLVED",
            "recovery cleanup did not prove clean state",
            cleanup.message,
          );
        }
      } else if (!(await cleanAfterTerminal(options.transport, intent))) {
        if (options.readOwnedExposure === undefined) {
          return finalize(
            options.store,
            options.runId,
            "UNRESOLVED",
            "the terminal order left state that cannot be proven clean",
            "position or owned order remains without execution evidence",
          );
        }
        if (intent.baselineSignedQty === undefined) {
          return finalize(
            options.store,
            options.runId,
            "UNRESOLVED",
            "the terminal order has no saved flat baseline",
            "missing baseline for ownership reconciliation",
          );
        }
        const readExposure = () =>
          options.readOwnedExposure!(intent, entryOrderIdentities);
        const exposure = await readExposure();
        const cleanup = await flattenOwnedExposure({
          runId: options.runId,
          attemptId: `${intent.attemptId}-recover-flatten`,
          accountId: options.accountId,
          category,
          symbol,
          baselineSignedQty: exposure.baselineSignedQty,
          currentState: exposure.currentState,
          executions: exposure.executions,
          store: options.store,
          transport: options.transport,
          approve: options.approve,
          ownedOrderIdentities: entryOrderIdentities,
          readOwnership: async () => (await readExposure()).currentState,
          ...(options.clock === undefined ? {} : { clock: options.clock }),
          ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
        });
        if (cleanup.kind === "unresolved") {
          return finalize(
            options.store,
            options.runId,
            "UNRESOLVED",
            "recovery flatten did not prove clean state",
            cleanup.message,
          );
        }
      }
    }
    return finalize(
      options.store,
      options.runId,
      saved.verdict === "CONTRADICTION" ? "CONTRADICTION" : "CONFIRMED_CLEAN",
      "the original run was reconciled and cleaned before new scenarios",
    );
  } catch (error) {
    return finalize(
      options.store,
      options.runId,
      "UNRESOLVED",
      "recovery stopped before clean state was proven",
      error instanceof Error ? error.message : "unknown recovery error",
    );
  } finally {
    try {
      await options.store.releaseLock(options.runId);
    } catch {
      // The original recovery result remains the source of truth; a lock that
      // cannot be released is surfaced by the next precondition check.
    }
  }
}

export const recoverSavedRun = recoverInterruptedRun;
