import { randomBytes } from "node:crypto";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { promptVisible } from "../src/cli/interactive-prompt.js";
import {
  type CredentialProvider,
  type ExchangeCredentials,
} from "../src/ports/credential-provider.js";
import { createMacOSKeychainProvider } from "../src/adapters/macos-keychain.js";
import {
  approveProbePlan,
  type ProbeApproval,
} from "./bybit-probe/approval.js";
import {
  cleanupOwnedEntry,
  flattenOwnedExposure,
  ownedExecutionFingerprint,
  proveCleanState,
  type CleanupTransport,
  type OwnedExecution,
  type OwnershipState,
} from "./bybit-probe/cleanup.js";
import { resolveProbeConfig } from "./bybit-probe/config.js";
import {
  renderSanitizedFindings,
  type SanitizedScenarioFinding,
} from "./bybit-probe/findings.js";
import { runReadOnlyPreflight } from "./bybit-probe/preflight.js";
import { recoverInterruptedRun } from "./bybit-probe/recovery.js";
import {
  buildAttachedEntryPlan,
  type DispatchedEntryScenarioResult,
  runEntryScenario,
  type EntryScenarioResult,
  type ScenarioTransport,
} from "./bybit-probe/scenarios.js";
import {
  EXIT_CODES,
  ProbeStore,
  type ProbeVerdict,
} from "./bybit-probe/store.js";
import {
  BybitProbeTransport,
  responseList,
  type BybitResponse,
} from "./bybit-probe/transport.js";

export { EXIT_CODES } from "./bybit-probe/store.js";
export type { ProbeVerdict } from "./bybit-probe/store.js";

export interface ProbeRunResult {
  readonly verdict: ProbeVerdict;
  readonly message: string;
  readonly runId: string;
}

type Output = { write(message: string): void };
type PromptInput = NodeJS.ReadableStream & { isTTY?: boolean };

export interface CapabilityProbeOptions {
  readonly environment?: Record<string, string | undefined>;
  readonly request?: typeof fetch;
  readonly credentials?: ExchangeCredentials;
  readonly accountId?: string;
  readonly credentialProvider?: Pick<CredentialProvider, "load">;
  readonly transport?: ScenarioTransport;
  readonly store?: ProbeStore;
  readonly clock?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly input?: PromptInput;
  readonly output?: Output;
  readonly approve?: (
    plan: Parameters<typeof approveProbePlan>[0],
  ) => Promise<ProbeApproval>;
  readonly confirmExclusiveUse?: () => boolean | Promise<boolean>;
  readonly runId?: string;
  readonly realtimeAttempts?: number;
  readonly historyAttempts?: number;
}

function newRunId(clock: () => number): string {
  return `probe-${Math.trunc(clock())}-${randomBytes(4).toString("hex")}`;
}

async function confirmExclusiveUse(
  input: PromptInput,
  output: Output,
): Promise<boolean> {
  if (input.isTTY !== true) return false;
  try {
    const answer = await promptVisible(
      "Confirm exclusive use of the configured Testnet account and symbol for this run (type YES)",
      "Interactive probe confirmation requires a terminal.",
      {
        input,
        output: output as unknown as NodeJS.WritableStream,
        timeoutMs: 120_000,
      },
    );
    return answer.trim() === "YES";
  } catch {
    return false;
  }
}

function signedPosition(response: BybitResponse): string | undefined {
  const list = responseList(response);
  if (!list) return undefined;
  if (list.length > 1) return undefined;
  const item = list[0];
  if (!item) return "0";
  if (typeof item.size !== "string") return undefined;
  if (item.size === "0") return "0";
  if (item.side === "Buy") return item.size;
  if (item.side === "Sell") return `-${item.size}`;
  return undefined;
}

async function readOwnedExposure(
  transport: ScenarioTransport,
  category: string,
  symbol: string,
  ownedOrderIdentities: ReadonlyMap<string, string>,
  baselineSignedQty = "0",
): Promise<
  | {
      readonly baselineSignedQty: string;
      readonly currentState: OwnershipState;
      readonly executions: readonly OwnedExecution[];
    }
  | undefined
> {
  const position = signedPosition(
    await transport.get("/v5/position/list", { category, symbol }),
  );
  const executions: OwnedExecution[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 5; page += 1) {
    const executionResponse = await transport.get("/v5/execution/list", {
      category,
      symbol,
      limit: "50",
      ...(cursor === undefined ? {} : { cursor }),
    });
    const list = responseList(executionResponse);
    if (!list) return undefined;
    for (const item of list) {
      const executionId =
        typeof item.execId === "string" ? item.execId : undefined;
      const orderId =
        typeof item.orderId === "string" ? item.orderId : undefined;
      const orderLinkId =
        typeof item.orderLinkId === "string" ? item.orderLinkId : undefined;
      const side =
        item.side === "Buy" || item.side === "Sell" ? item.side : undefined;
      const qty = typeof item.execQty === "string" ? item.execQty : undefined;
      if (!executionId || !orderId || !orderLinkId || !side || !qty)
        return undefined;
      const expectedOrderLinkId = ownedOrderIdentities.get(orderId);
      if (expectedOrderLinkId !== undefined) {
        if (expectedOrderLinkId !== orderLinkId) return undefined;
        executions.push({ executionId, orderId, orderLinkId, side, qty });
      }
    }
    const nextCursor = executionResponse.result.nextPageCursor;
    if (nextCursor === undefined || nextCursor === "") break;
    if (typeof nextCursor !== "string" || nextCursor === cursor)
      return undefined;
    cursor = nextCursor;
    if (page === 4) return undefined;
  }
  if (position === undefined) return undefined;
  return {
    baselineSignedQty,
    currentState: {
      currentSignedQty: position,
      ownedOrderIds: [...ownedOrderIdentities.keys()],
      protectiveExitOrderIds: [],
      executionFingerprints: executions.map(ownedExecutionFingerprint),
    },
    executions,
  };
}

async function cleanupScenario(
  result: DispatchedEntryScenarioResult,
  options: {
    readonly runId: string;
    readonly attemptId: string;
    readonly accountId: string;
    readonly category: string;
    readonly symbol: string;
    readonly baselineSignedQty: string;
    readonly store: ProbeStore;
    readonly transport: CleanupTransport;
    readonly approve: (
      plan: Parameters<typeof approveProbePlan>[0],
    ) => Promise<ProbeApproval>;
    readonly clock: () => number;
    readonly sleep?: (milliseconds: number) => Promise<void>;
  },
): Promise<{
  kind: "clean" | "unresolved" | "contradiction";
  message: string;
}> {
  const order = result.reconciliation.order;
  if (result.kind === "unresolved" || result.kind === "ambiguous") {
    return {
      kind: "unresolved",
      message:
        "message" in result.reconciliation
          ? result.reconciliation.message
          : "bounded reconciliation did not prove a safe state",
    };
  }
  if (result.attachedExits === "rejected-110057") {
    if (
      await proveCleanState(options.transport, options.category, options.symbol)
    ) {
      return {
        kind: "contradiction",
        message:
          "Bybit rejected attached TP/SL with 110057; clean state was proven",
      };
    }
    return {
      kind: "unresolved",
      message: "attached-exit contradiction left state that is not clean",
    };
  }
  if (order && result.kind === "resting") {
    const cleanup = await cleanupOwnedEntry({
      runId: options.runId,
      attemptId: `${options.attemptId}-cancel`,
      accountId: options.accountId,
      category: options.category,
      symbol: options.symbol,
      order: {
        orderId: order.orderId,
        orderLinkId: order.orderLinkId,
        side: result.side,
        orderStatus: order.orderStatus,
      },
      entryOrderIds: new Set([order.orderId]),
      protectiveExitOrderIds: new Set(),
      store: options.store,
      transport: options.transport,
      approve: options.approve,
      readOwnership: async () => {
        const response = await options.transport.get("/v5/order/realtime", {
          category: options.category,
          symbol: options.symbol,
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
      clock: options.clock,
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    });
    return cleanup.kind === "confirmed-clean" || cleanup.kind === "already-flat"
      ? { kind: "clean", message: cleanup.message }
      : { kind: "unresolved", message: cleanup.message };
  }
  if (
    await proveCleanState(options.transport, options.category, options.symbol)
  ) {
    return {
      kind: "clean",
      message: "terminal state and clean account state reconciled",
    };
  }
  const ownedOrderIdentities = new Map<string, string>(
    order ? [[order.orderId, order.orderLinkId]] : [],
  );
  const exposure = await readOwnedExposure(
    options.transport,
    options.category,
    options.symbol,
    ownedOrderIdentities,
    options.baselineSignedQty,
  );
  if (!exposure)
    return {
      kind: "unresolved",
      message: "filled order lacks validated execution evidence",
    };
  const flattened = await flattenOwnedExposure({
    runId: options.runId,
    attemptId: `${options.attemptId}-flatten`,
    accountId: options.accountId,
    category: options.category,
    symbol: options.symbol,
    baselineSignedQty: exposure.baselineSignedQty,
    currentState: exposure.currentState,
    executions: exposure.executions,
    store: options.store,
    transport: options.transport,
    approve: options.approve,
    ownedOrderIdentities,
    readOwnership: async () => {
      const latest = await readOwnedExposure(
        options.transport,
        options.category,
        options.symbol,
        ownedOrderIdentities,
        options.baselineSignedQty,
      );
      if (!latest) throw new Error("owned exposure could not be revalidated");
      return latest.currentState;
    },
    clock: options.clock,
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  });
  return flattened.kind === "confirmed-clean" ||
    flattened.kind === "already-flat"
    ? { kind: "clean", message: flattened.message }
    : { kind: "unresolved", message: flattened.message };
}

function findingFromResult(
  name: string,
  result: EntryScenarioResult,
): SanitizedScenarioFinding {
  if (result.kind === "refused") {
    return {
      name,
      requestAccepted: false,
      acknowledgement: "rejected",
      terminalState: undefined,
      exchangeOrderId: undefined,
      orderLinkId: undefined,
      attachedExits: "unverified",
      protectionAfterFill: "unverified",
    };
  }
  return {
    name,
    requestAccepted: result.kind === "resting" || result.kind === "terminal",
    acknowledgement: result.kind === "rejected" ? "rejected" : "pending",
    terminalState: result.reconciliation.terminalState,
    exchangeOrderId: result.exchangeOrderId,
    orderLinkId: result.orderLinkId,
    attachedExits:
      result.attachedExits === "not-observed"
        ? "unverified"
        : result.attachedExits,
    protectionAfterFill:
      result.protectionAfterFill === "not-tested" ? "unverified" : "observed",
  };
}

function defaultApproval(
  input: PromptInput,
  output: Output,
  clock: () => number,
): (plan: Parameters<typeof approveProbePlan>[0]) => Promise<ProbeApproval> {
  return (plan) => approveProbePlan(plan, { input, output, clock });
}

async function recordVerdict(
  store: ProbeStore,
  runId: string,
  verdict: ProbeVerdict,
  message: string,
): Promise<ProbeRunResult> {
  if (verdict === "UNRESOLVED") {
    await store.writeVerdict(runId, verdict, {
      runId,
      lastConfirmedState: message,
      uncertainty: message,
      nextAction:
        "Reconcile this saved run with the manual fallback in SECURITY.md before any new write.",
    });
  } else {
    await store.writeVerdict(runId, verdict);
  }
  return { verdict, message, runId };
}

export async function runCapabilityProbe(
  options: CapabilityProbeOptions = {},
): Promise<ProbeRunResult> {
  const clock = options.clock ?? Date.now;
  const output = options.output ?? process.stdout;
  const input = options.input ?? process.stdin;
  const runId = options.runId ?? newRunId(clock);
  const store = options.store ?? new ProbeStore();
  try {
    const config = resolveProbeConfig(options.environment ?? process.env);
    let credentials = options.credentials;
    if (!credentials && !options.transport) {
      const provider =
        options.credentialProvider ?? createMacOSKeychainProvider();
      credentials = await provider.load("testnet");
    }
    const accountId = options.accountId ?? credentials?.accountId;
    if (!accountId)
      throw new Error("the Testnet account identity is unavailable");
    const transport =
      options.transport ??
      new BybitProbeTransport({
        baseUrl: config.baseUrl,
        ...(credentials === undefined ? {} : { credentials }),
        ...(options.request === undefined ? {} : { request: options.request }),
        clock,
      });

    const priorRuns = (await store.listSavedRuns()).filter(
      (run) =>
        run.runId !== runId &&
        run.verdict !== "CONFIRMED_CLEAN" &&
        run.verdict !== "REFUSED" &&
        (run.verdict !== "PRECONDITION_FAILED" || run.intents.length > 0),
    );
    await store.assertNoBlockingPriorRuns(runId, priorRuns);
    for (const prior of priorRuns) {
      const recovered = await recoverInterruptedRun({
        runId: prior.runId,
        accountId,
        store,
        transport,
        approve: options.approve ?? defaultApproval(input, output, clock),
        clock,
        ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
        ...(options.realtimeAttempts === undefined
          ? {}
          : { realtimeAttempts: options.realtimeAttempts }),
        ...(options.historyAttempts === undefined
          ? {}
          : { historyAttempts: options.historyAttempts }),
        readOwnedExposure: async (intent, ownedOrderIdentities) => {
          const category = intent.plan.params.category;
          const symbol = intent.plan.params.symbol;
          if (typeof category !== "string" || typeof symbol !== "string") {
            throw new Error("saved run lacks category or symbol");
          }
          if (intent.baselineSignedQty === undefined) {
            throw new Error("saved run lacks a flat baseline");
          }
          const exposure = await readOwnedExposure(
            transport,
            category,
            symbol,
            ownedOrderIdentities,
            intent.baselineSignedQty,
          );
          if (!exposure) throw new Error("owned exposure could not be read");
          return exposure;
        },
      });
      if (recovered.verdict !== "CONFIRMED_CLEAN")
        return { ...recovered, runId };
    }

    await store.acquireLock(runId);
    try {
      const preflight = await runReadOnlyPreflight({
        transport,
        symbol: config.symbol,
        confirmExclusiveUse:
          options.confirmExclusiveUse ??
          (() => confirmExclusiveUse(input, output)),
      });
      const approve = options.approve ?? defaultApproval(input, output, clock);
      const findings: SanitizedScenarioFinding[] = [];
      const runScenario = async (
        side: "Buy" | "Sell",
        attemptId: string,
        scenario: string,
        orderLinkId: string,
        discardAcknowledgement = false,
      ): Promise<{
        kind: "clean" | "refused" | "unresolved" | "contradiction";
        message: string;
      }> => {
        const size = preflight.sizes[side];
        const plan = buildAttachedEntryPlan({
          environment: "testnet",
          accountId,
          scenario,
          expiresAt: clock() + 120_000,
          category: preflight.category,
          symbol: preflight.symbol,
          side,
          orderLinkId,
          price: size.price,
          qty: size.qty,
          takeProfit: size.takeProfit,
          stopLoss: size.stopLoss,
        });
        const result = await runEntryScenario({
          runId,
          attemptId,
          plan,
          transport,
          store,
          approve,
          baselineSignedQty: preflight.baseline.positionSize,
          discardAcknowledgement,
          clock,
          ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
          ...(options.realtimeAttempts === undefined
            ? {}
            : { realtimeAttempts: options.realtimeAttempts }),
          ...(options.historyAttempts === undefined
            ? {}
            : { historyAttempts: options.historyAttempts }),
        });
        findings.push(findingFromResult(scenario, result));
        if (result.kind === "refused")
          return { kind: "refused", message: result.approval.message };
        const cleanup = await cleanupScenario(result, {
          runId,
          attemptId,
          accountId,
          category: preflight.category,
          symbol: preflight.symbol,
          baselineSignedQty: preflight.baseline.positionSize,
          store,
          transport,
          approve,
          clock,
          ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
        });
        return cleanup;
      };

      const long = await runScenario(
        "Buy",
        "long-1",
        "long-entry",
        `${runId}-long`.slice(0, 36),
      );
      if (long.kind !== "clean") {
        return recordVerdict(
          store,
          runId,
          long.kind === "refused"
            ? "REFUSED"
            : long.kind === "contradiction"
              ? "CONTRADICTION"
              : "UNRESOLVED",
          long.message,
        );
      }
      const short = await runScenario(
        "Sell",
        "short-1",
        "short-entry",
        `${runId}-short`.slice(0, 36),
      );
      if (short.kind !== "clean") {
        return recordVerdict(
          store,
          runId,
          short.kind === "refused"
            ? "REFUSED"
            : short.kind === "contradiction"
              ? "CONTRADICTION"
              : "UNRESOLVED",
          short.message,
        );
      }
      const lostAcknowledgement = await runScenario(
        "Buy",
        "lost-ack-1",
        "timeout-after-accept",
        `${runId}-lost-ack`.slice(0, 36),
        true,
      );
      if (lostAcknowledgement.kind !== "clean") {
        return recordVerdict(
          store,
          runId,
          lostAcknowledgement.kind === "refused"
            ? "REFUSED"
            : lostAcknowledgement.kind === "contradiction"
              ? "CONTRADICTION"
              : "UNRESOLVED",
          lostAcknowledgement.message,
        );
      }
      const duplicate = await runScenario(
        "Buy",
        "duplicate-1",
        "duplicate-client-order-id",
        `${runId}-long`.slice(0, 36),
      );
      if (duplicate.kind !== "clean") {
        return recordVerdict(
          store,
          runId,
          duplicate.kind === "refused"
            ? "REFUSED"
            : duplicate.kind === "contradiction"
              ? "CONTRADICTION"
              : "UNRESOLVED",
          duplicate.message,
        );
      }
      const verdict: ProbeVerdict = "CONFIRMED_CLEAN";
      output.write(
        renderSanitizedFindings({
          runId,
          verdict,
          accountId,
          scenarios: findings,
        }),
      );
      await store.writeVerdict(runId, verdict);
      return {
        verdict,
        message: "all deterministic/live probe scenarios reconciled clean",
        runId,
      };
    } finally {
      await store.releaseLock(runId);
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "the probe could not start";
    try {
      return await recordVerdict(store, runId, "PRECONDITION_FAILED", message);
    } catch {
      return { verdict: "PRECONDITION_FAILED", message, runId };
    }
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  const result = await runCapabilityProbe();
  console.log(`${result.verdict}: ${result.message}`);
  process.exitCode = EXIT_CODES[result.verdict];
}
