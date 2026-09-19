import { randomBytes } from "node:crypto";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  type CredentialProvider,
  type ExchangeCredentials,
} from "../src/ports/credential-provider.js";
import { createMacOSKeychainProvider } from "../src/adapters/macos-keychain.js";
import {
  authorizeProbePlan,
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
import {
  resolveProbeConfig,
  type ProbeEnvironment,
} from "./bybit-probe/config.js";
import {
  assertSanitizedOutput,
  renderSanitizedFindings,
  type SanitizedScenarioFinding,
} from "./bybit-probe/findings.js";
import { runReadOnlyPreflight } from "./bybit-probe/preflight.js";
import {
  runManualRecovery as executeManualRecovery,
  type ManualRecoveryResult,
} from "./bybit-probe/manual-recovery.js";
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
  isManualRecoveryClosedStatus,
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
  readonly currentRunId?: string;
}

type Output = { write(message: string): void };

export interface CapabilityProbeOptions {
  readonly environment?: Record<string, string | undefined>;
  readonly commandEnvironment?: ProbeEnvironment;
  readonly request?: typeof fetch;
  readonly credentials?: ExchangeCredentials;
  readonly accountId?: string;
  readonly credentialProvider?: Pick<CredentialProvider, "load">;
  readonly transport?: ScenarioTransport;
  readonly store?: ProbeStore;
  readonly clock?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly output?: Output;
  readonly authorize?: (
    plan: Parameters<typeof authorizeProbePlan>[0],
  ) => Promise<ProbeApproval>;
  readonly runId?: string;
  readonly realtimeAttempts?: number;
  readonly historyAttempts?: number;
}

export interface ManualRecoveryProbeOptions extends CapabilityProbeOptions {
  readonly runId: string;
}

function newRunId(clock: () => number): string {
  return `probe-${Math.trunc(clock())}-${randomBytes(4).toString("hex")}`;
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
    readonly environment: ProbeEnvironment;
    readonly runId: string;
    readonly attemptId: string;
    readonly accountId: string;
    readonly category: string;
    readonly symbol: string;
    readonly baselineSignedQty: string;
    readonly store: ProbeStore;
    readonly transport: CleanupTransport;
    readonly authorize: (
      plan: Parameters<typeof authorizeProbePlan>[0],
    ) => Promise<ProbeApproval>;
    readonly clock: () => number;
    readonly sleep?: (milliseconds: number) => Promise<void>;
  },
): Promise<{
  kind: "clean" | "unresolved" | "contradiction";
  message: string;
}> {
  const withDispatchContext = (message: string): string => {
    if (result.dispatchError === undefined) return message;
    return `${result.dispatchError.explanation} Reconciliation: ${message}`;
  };
  const order = result.reconciliation.order;
  if (result.kind === "unresolved" || result.kind === "ambiguous") {
    return {
      kind: "unresolved",
      message: withDispatchContext(
        "message" in result.reconciliation
          ? result.reconciliation.message
          : "bounded reconciliation did not prove a safe state",
      ),
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
      message: withDispatchContext(
        "attached-exit contradiction left state that is not clean",
      ),
    };
  }
  if (order && result.kind === "resting") {
    const cleanup = await cleanupOwnedEntry({
      environment: options.environment,
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
      authorize: options.authorize,
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
      message: withDispatchContext(
        "filled order lacks validated execution evidence",
      ),
    };
  const flattened = await flattenOwnedExposure({
    environment: options.environment,
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
    authorize: options.authorize,
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
    : {
        kind: "unresolved",
        message: withDispatchContext(flattened.message),
      };
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
      duplicateOutcome: "unverified",
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
    duplicateOutcome: result.duplicateOutcome ?? "unverified",
    ...(result.dispatchError === undefined
      ? {}
      : { dispatchError: result.dispatchError }),
  };
}

function defaultAuthorization(
  clock: () => number,
): (plan: Parameters<typeof authorizeProbePlan>[0]) => Promise<ProbeApproval> {
  return (plan) => authorizeProbePlan(plan, { clock });
}

function errorMessage(error: unknown): string {
  const message =
    error instanceof Error ? error.message : "the probe could not start";
  if (
    typeof error === "object" &&
    error !== null &&
    "guidance" in error &&
    typeof error.guidance === "string" &&
    error.guidance.length > 0
  ) {
    return `${message} Next action: ${error.guidance}`;
  }
  return message;
}

function nextActionForVerdict(
  verdict: ProbeVerdict,
  environment: ProbeEnvironment = "testnet",
): string {
  const label = environment === "demo" ? "Demo" : "Testnet";
  switch (verdict) {
    case "CONFIRMED_CLEAN":
      return "none; the bounded probe completed with clean state reconciled";
    case "REFUSED":
      return "inspect the refusal message; no further write was authorized";
    case "PRECONDITION_FAILED":
      return `correct the reported precondition, then rerun the ${label} probe`;
    case "CONTRADICTION":
      return "stop the probe and review the contradiction before any new scenario";
    case "UNRESOLVED":
      return `reconcile the saved run in ${label} through the SECURITY.md manual fallback before any new write`;
  }
}

export async function runManualRecovery(
  options: ManualRecoveryProbeOptions,
): Promise<ManualRecoveryResult> {
  const clock = options.clock ?? Date.now;
  const output = options.output ?? process.stdout;
  const authorize = options.authorize ?? defaultAuthorization(clock);
  try {
    const config = resolveProbeConfig(
      options.environment ?? process.env,
      options.commandEnvironment,
    );
    const store =
      options.store ?? new ProbeStore({ environment: config.environment });
    store.assertEnvironment(config.environment);
    let credentials = options.credentials;
    if (!credentials && !options.transport) {
      const provider =
        options.credentialProvider ?? createMacOSKeychainProvider();
      credentials = await provider.load(config.environment);
    }
    const accountId = options.accountId ?? credentials?.accountId;
    if (!accountId)
      throw new Error(`the ${config.label} account identity is unavailable`);
    const transport =
      options.transport ??
      new BybitProbeTransport({
        environment: config.environment,
        baseUrl: config.baseUrl,
        ...(credentials === undefined ? {} : { credentials }),
        ...(options.request === undefined ? {} : { request: options.request }),
        clock,
      });
    return await executeManualRecovery({
      runId: options.runId,
      accountId,
      store,
      transport,
      authorize,
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
      clock,
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      ...(options.realtimeAttempts === undefined
        ? {}
        : { realtimeAttempts: options.realtimeAttempts }),
      ...(options.historyAttempts === undefined
        ? {}
        : { historyAttempts: options.historyAttempts }),
      output,
    });
  } catch (error) {
    return {
      status: "PRECONDITION_FAILED",
      runId: options.runId,
      message:
        error instanceof Error
          ? error.message
          : "manual recovery could not start",
    };
  }
}

async function recordVerdict(
  store: ProbeStore,
  runId: string,
  verdict: ProbeVerdict,
  message: string,
  options: {
    readonly environment?: ProbeEnvironment;
    readonly accountId?: string;
    readonly scenarios?: readonly SanitizedScenarioFinding[];
    readonly secrets?: readonly string[];
    readonly output?: Output;
  } = {},
): Promise<ProbeRunResult> {
  await store.writeVerdict(
    runId,
    verdict,
    verdict === "UNRESOLVED"
      ? {
          runId,
          lastConfirmedState: message,
          uncertainty: message,
          nextAction:
            "Reconcile this saved run with the manual fallback in SECURITY.md before any new write.",
        }
      : undefined,
  );
  options.output?.write(
    `result: ${verdict}\nmessage: ${message}\nnext action: ${nextActionForVerdict(verdict, options.environment)}\n`,
  );
  if (options.accountId !== undefined) {
    const findings = renderSanitizedFindings({
      runId,
      environment: options.environment ?? "testnet",
      verdict,
      accountId: options.accountId,
      scenarios: options.scenarios ?? [],
    });
    assertSanitizedOutput(findings, options.secrets ?? []);
    await store.writeFindings(runId, verdict, findings);
    options.output?.write(findings);
  }
  return { verdict, message, runId };
}

export async function runCapabilityProbe(
  options: CapabilityProbeOptions = {},
): Promise<ProbeRunResult> {
  const clock = options.clock ?? Date.now;
  const output = options.output ?? process.stdout;
  const authorize = options.authorize ?? defaultAuthorization(clock);
  const runId = options.runId ?? newRunId(clock);
  const probeEnvironment = options.environment ?? process.env;
  const inferredEnvironment: ProbeEnvironment =
    options.commandEnvironment ??
    (probeEnvironment.TRADER_ENV === "demo" ? "demo" : "testnet");
  const store =
    options.store ?? new ProbeStore({ environment: inferredEnvironment });
  const findings: SanitizedScenarioFinding[] = [];
  let accountId: string | undefined;
  let secrets: readonly string[] = [];
  let writeDispatched = false;
  let trackCurrentRunWrites = false;
  let resolvedEnvironment: ProbeEnvironment = inferredEnvironment;
  try {
    const config = resolveProbeConfig(
      probeEnvironment,
      options.commandEnvironment,
    );
    resolvedEnvironment = config.environment;
    store.assertEnvironment(config.environment);
    let credentials = options.credentials;
    if (!credentials && !options.transport) {
      const provider =
        options.credentialProvider ?? createMacOSKeychainProvider();
      credentials = await provider.load(config.environment);
    }
    accountId = options.accountId ?? credentials?.accountId;
    if (!accountId)
      throw new Error(`the ${config.label} account identity is unavailable`);
    const verifiedAccountId = accountId;
    secrets =
      credentials === undefined
        ? []
        : [credentials.apiKey, credentials.apiSecret];
    const rawTransport =
      options.transport ??
      new BybitProbeTransport({
        environment: config.environment,
        baseUrl: config.baseUrl,
        ...(credentials === undefined ? {} : { credentials }),
        ...(options.request === undefined ? {} : { request: options.request }),
        clock,
      });
    const transport: ScenarioTransport = {
      get: (path, query) => rawTransport.get(path, query),
      post: async (path, body) => {
        if (trackCurrentRunWrites) writeDispatched = true;
        return rawTransport.post(path, body);
      },
    };

    const priorRuns = (await store.listSavedRuns()).filter(
      (run) =>
        run.runId !== runId &&
        run.verdict !== "CONFIRMED_CLEAN" &&
        run.verdict !== "REFUSED" &&
        !isManualRecoveryClosedStatus(run.manualRecovery?.status) &&
        (run.verdict !== "PRECONDITION_FAILED" || run.intents.length > 0),
    );
    await store.assertNoBlockingPriorRuns(runId, priorRuns);
    for (const prior of priorRuns) {
      output.write(`stage: recovery; reconciling saved run ${prior.runId}\n`);
      const recovered = await recoverInterruptedRun({
        runId: prior.runId,
        accountId,
        store,
        transport,
        authorize,
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
      if (recovered.verdict !== "CONFIRMED_CLEAN") {
        output.write(
          `result: ${recovered.verdict}\nmessage: ${recovered.message}\nnext action: ${nextActionForVerdict(recovered.verdict, config.environment)}\n`,
        );
        return { ...recovered, currentRunId: runId };
      }
    }

    await store.acquireLock(runId);
    trackCurrentRunWrites = true;
    try {
      output.write(
        `stage: preflight; reading ${config.label} instrument, account and symbol state\n`,
      );
      const preflight = await runReadOnlyPreflight({
        transport,
        symbol: config.symbol,
        environment: config.environment,
        fundingGuidance: config.fundingGuidance,
      });
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
        output.write(
          `stage: ${scenario}; dispatching ${side} probe write for ${preflight.symbol} (orderLinkId ${orderLinkId})\n`,
        );
        const plan = buildAttachedEntryPlan({
          environment: config.environment,
          accountId: verifiedAccountId,
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
          authorize,
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
        const dispatchContext =
          result.kind === "refused"
            ? result.approval.message
            : (result.dispatchError?.explanation ??
              `acknowledgement=${result.acknowledgement}; terminal=${result.reconciliation.terminalState ?? "unverified"}`);
        output.write(`stage: ${scenario}; ${dispatchContext}\n`);
        findings.push(findingFromResult(scenario, result));
        if (result.kind === "refused")
          return { kind: "refused", message: result.approval.message };
        const cleanup = await cleanupScenario(result, {
          environment: config.environment,
          runId,
          attemptId,
          accountId: verifiedAccountId,
          category: preflight.category,
          symbol: preflight.symbol,
          baselineSignedQty: preflight.baseline.positionSize,
          store,
          transport,
          authorize,
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
          {
            environment: config.environment,
            accountId,
            scenarios: findings,
            secrets,
            output,
          },
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
          {
            environment: config.environment,
            accountId,
            scenarios: findings,
            secrets,
            output,
          },
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
          {
            environment: config.environment,
            accountId,
            scenarios: findings,
            secrets,
            output,
          },
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
          {
            environment: config.environment,
            accountId,
            scenarios: findings,
            secrets,
            output,
          },
        );
      }
      const verdict: ProbeVerdict = "CONFIRMED_CLEAN";
      return await recordVerdict(
        store,
        runId,
        verdict,
        "all deterministic/live probe scenarios reconciled clean",
        {
          environment: config.environment,
          accountId,
          scenarios: findings,
          secrets,
          output,
        },
      );
    } finally {
      await store.releaseLock(runId);
    }
  } catch (error) {
    const message = errorMessage(error);
    try {
      return await recordVerdict(
        store,
        runId,
        writeDispatched ? "UNRESOLVED" : "PRECONDITION_FAILED",
        message,
        {
          environment: resolvedEnvironment,
          ...(accountId === undefined ? {} : { accountId }),
          scenarios: findings,
          secrets,
          output,
        },
      );
    } catch {
      return {
        verdict: writeDispatched ? "UNRESOLVED" : "PRECONDITION_FAILED",
        message,
        runId,
      };
    }
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  const commandEnvironmentIndex = process.argv.indexOf("--environment");
  const commandEnvironmentValue =
    commandEnvironmentIndex >= 0
      ? process.argv[commandEnvironmentIndex + 1]
      : undefined;
  const commandEnvironment: ProbeEnvironment | undefined =
    commandEnvironmentValue === "testnet" || commandEnvironmentValue === "demo"
      ? commandEnvironmentValue
      : undefined;
  if (commandEnvironmentIndex >= 0 && commandEnvironment === undefined) {
    console.error("Usage: --environment <testnet|demo>");
    process.exitCode = EXIT_CODES.PRECONDITION_FAILED;
  } else {
    const manualRecoveryIndex = process.argv.indexOf("--manual-recover");
    const commandOptions =
      commandEnvironment === undefined ? {} : { commandEnvironment };
    let runId: string | undefined;
    for (let index = 2; index < process.argv.length; index += 1) {
      const argument = process.argv[index];
      if (argument === "--environment") {
        index += 1;
        continue;
      }
      if (argument === "--manual-recover" || argument === "--") continue;
      if (argument && !argument.startsWith("--")) {
        runId = argument;
        break;
      }
    }
    if (manualRecoveryIndex >= 0) {
      if (!runId || runId.startsWith("--")) {
        console.error(
          "Usage: npm run probe:bybit:recover -- --environment <testnet|demo> <saved-run-id>",
        );
        process.exitCode = EXIT_CODES.PRECONDITION_FAILED;
      } else {
        const result = await runManualRecovery({
          runId,
          ...commandOptions,
        });
        console.log(`${result.status}: ${result.message}`);
        process.exitCode =
          result.status === "RECOVERED_CLEAN"
            ? EXIT_CODES.CONFIRMED_CLEAN
            : result.status === "PRECONDITION_FAILED"
              ? EXIT_CODES.PRECONDITION_FAILED
              : EXIT_CODES.UNRESOLVED;
      }
    } else {
      const result = await runCapabilityProbe(commandOptions);
      console.log(`${result.verdict}: ${result.message}`);
      process.exitCode = EXIT_CODES[result.verdict];
    }
  }
}
