import { randomBytes } from "node:crypto";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { createMacOSKeychainProvider } from "../src/adapters/macos-keychain.js";
import {
  BybitDemoExecutionAdapter,
  type BybitDemoExecutionAdapterOptions,
} from "../src/adapters/bybit-v5/execution-adapter.js";
import { createBybitDemoTransport } from "../src/adapters/bybit-v5/transport.js";
import {
  ceilToStep,
  DecimalValue,
  floorToStep,
  RoundingMode,
} from "../src/domain/shared/decimal.js";
import {
  createOrderIntent,
  type OrderIntent,
  type OrderSide,
  type PositionEffect,
} from "../src/domain/planning/order-intent.js";
import type { Clock } from "../src/domain/shared/time.js";
import { systemClock } from "../src/domain/shared/time.js";
import type {
  ExchangeExecutionFailure,
  ExchangeExecutionPort,
  ExchangeFillObservation,
  ExchangeOrderLookup,
  ExchangeOrderObservation,
  ExchangeReadState,
  ExchangeResult,
} from "../src/ports/exchange-execution.js";
import type {
  ExchangeCredentials,
  CredentialProvider,
} from "../src/ports/credential-provider.js";
import {
  accountHash,
  DEMO_EVIDENCE_SCHEMA_VERSION,
  sanitizeEvidence,
  stageFromObservation,
  writeEvidence,
  type DemoStageEvidence,
  type DemoVerificationEvidence,
  type DemoVerificationVerdict,
} from "./bybit-demo-adapter/evidence.js";

export const DEFAULT_DEMO_SYMBOL = "DOGEUSDT";
export const DEFAULT_EVIDENCE_DIRECTORY = "data/reports/bybit-demo-adapter";
const MAX_PROBE_NOTIONAL = "10";
const DEFAULT_RECONCILIATION_ATTEMPTS = 8;

type Output = { write(message: string): void };

export interface DemoVerificationOptions {
  readonly port: ExchangeExecutionPort;
  readonly symbol: string;
  readonly accountId: string;
  readonly runId?: string;
  readonly clock?: Clock;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly reconciliationAttempts?: number;
  readonly evidenceDirectory?: string;
  readonly writeEvidence?: boolean;
  readonly output?: Output;
}

export interface DemoVerificationResult {
  readonly verdict: DemoVerificationVerdict;
  readonly runId: string;
  readonly evidence: DemoVerificationEvidence;
  readonly evidencePath?: string;
}

class VerificationFailure extends Error {
  readonly failure: ExchangeExecutionFailure;

  constructor(failure: ExchangeExecutionFailure) {
    super(failure.message);
    this.name = "VerificationFailure";
    this.failure = failure;
  }
}

function failure(
  kind: ExchangeExecutionFailure["kind"],
  message: string,
  operation: NonNullable<ExchangeExecutionFailure["operation"]>,
  retry: ExchangeExecutionFailure["retry"] = "never",
  identity: Pick<
    ExchangeExecutionFailure,
    "clientOrderId" | "exchangeOrderId"
  > = {},
): VerificationFailure {
  return new VerificationFailure({
    kind,
    message,
    operation,
    retry,
    ...(identity.clientOrderId === undefined
      ? {}
      : { clientOrderId: identity.clientOrderId }),
    ...(identity.exchangeOrderId === undefined
      ? {}
      : { exchangeOrderId: identity.exchangeOrderId }),
  });
}

function resultValue<T>(result: ExchangeResult<T>): T {
  if (!result.ok) throw new VerificationFailure(result.error);
  return result.value;
}

function runIdFor(clock: Clock): string {
  return `demo-${Date.parse(clock.now())}-${randomBytes(4).toString("hex")}`;
}

function clientOrderId(runId: string, suffix: string): string {
  const value = `${runId}-${suffix}`;
  if (!/^[A-Za-z0-9_-]{1,36}$/u.test(value)) {
    throw failure(
      "configuration",
      "verification run identity is too long for Bybit client-order identity.",
      "create",
    );
  }
  return value;
}

function validateRunId(runId: string): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(runId)) {
    throw new TypeError("runId must contain only safe filename characters.");
  }
}

function decimal(value: string): DecimalValue {
  const parsed = DecimalValue.fromString(value);
  if (!parsed.ok) {
    throw failure(
      "configuration",
      "verification decimal could not be constructed.",
      "create",
    );
  }
  return parsed.value;
}

function statePosition(state: ExchangeReadState, symbol: string) {
  const positions = state.account.positions.filter(
    (position) => position.instrument === symbol,
  );
  if (positions.length !== 1 || positions[0] === undefined) {
    throw failure(
      "precondition",
      "selected Demo state did not contain exactly one position record.",
      "read",
    );
  }
  return positions[0];
}

function assertDemoScope(state: ExchangeReadState, symbol: string): void {
  const scopes = [state.market.scope, state.account.scope];
  if (
    state.market.instrument !== symbol ||
    scopes.some(
      (scope) =>
        scope.exchange !== "bybit" ||
        scope.environment !== "demo" ||
        scope.category !== "linear" ||
        scope.positionMode !== "one-way",
    )
  ) {
    throw failure(
      "precondition",
      "normalized Demo state is outside the fixed linear one-way scope.",
      "read",
    );
  }
}

function assertCleanState(state: ExchangeReadState, symbol: string): void {
  assertDemoScope(state, symbol);
  const position = statePosition(state, symbol);
  if (position.side !== "flat" || !position.quantity.isZero()) {
    throw failure(
      "precondition",
      "selected Demo symbol is not flat at the required clean-baseline stage.",
      "read",
    );
  }
  if (state.openOrders.length !== 0) {
    throw failure(
      "precondition",
      "selected Demo symbol has open orders at the required clean-baseline stage.",
      "read",
    );
  }
}

function assertOwnedExposureState(
  state: ExchangeReadState,
  symbol: string,
  side: OrderSide,
  quantity: DecimalValue,
  allowedClientOrderIds: ReadonlySet<string>,
): void {
  assertDemoScope(state, symbol);
  const position = statePosition(state, symbol);
  const expectedSide = side === "buy" ? "long" : "short";
  if (
    position.side !== expectedSide ||
    position.quantity.compare(quantity) !== 0
  ) {
    throw failure(
      "ownership",
      "current Demo position is not explained by the owned execution evidence.",
      "read",
      "reconcile",
    );
  }
  if (
    state.openOrders.some(
      (order) => !allowedClientOrderIds.has(order.clientOrderId),
    )
  ) {
    throw failure(
      "ownership",
      "current Demo open orders include an identity outside the verification run.",
      "read",
      "reconcile",
    );
  }
}

function orderQuantity(
  price: DecimalValue,
  state: ExchangeReadState,
): { readonly quantity: DecimalValue; readonly notional: DecimalValue } {
  const constraints = state.market.constraints;
  let quantity = constraints.minQuantity;
  if (constraints.minNotional !== undefined) {
    const ratio = constraints.minNotional.divide(price, 1000, RoundingMode.UP);
    if (!ratio.ok) {
      throw failure(
        "precondition",
        "instrument minimum notional could not be sized.",
        "read",
      );
    }
    const rounded = ceilToStep(ratio.value, constraints.quantityStep);
    if (!rounded.ok) {
      throw failure(
        "precondition",
        "instrument quantity step could not be applied.",
        "read",
      );
    }
    if (rounded.value.compare(quantity) > 0) quantity = rounded.value;
  }
  const aligned = ceilToStep(quantity, constraints.quantityStep);
  if (!aligned.ok) {
    throw failure(
      "precondition",
      "instrument quantity step could not be applied.",
      "read",
    );
  }
  const notional = price.multiply(aligned.value);
  if (notional.compare(decimal(MAX_PROBE_NOTIONAL)) > 0) {
    throw failure(
      "precondition",
      "the instrument minimum does not fit the bounded 10 USDT Demo verification cap.",
      "read",
    );
  }
  return { quantity: aligned.value, notional };
}

function alignedPrice(
  price: DecimalValue,
  state: ExchangeReadState,
  direction: "floor" | "ceil",
): DecimalValue {
  const aligned =
    direction === "floor"
      ? floorToStep(price, state.market.constraints.priceTickSize)
      : ceilToStep(price, state.market.constraints.priceTickSize);
  if (!aligned.ok || !aligned.value.isPositive()) {
    throw failure(
      "precondition",
      "the selected Demo book cannot produce a valid verification price.",
      "read",
    );
  }
  return aligned.value;
}

function buildIntent(
  state: ExchangeReadState,
  intentId: string,
  instrument: string,
  side: OrderSide,
  positionEffect: PositionEffect,
  price: DecimalValue,
  quantity: DecimalValue,
): OrderIntent {
  const created = createOrderIntent({
    intentId,
    instrument,
    orderType: "limit",
    side,
    positionEffect,
    price,
    quantity,
    notional: price.multiply(quantity),
    normalization: {
      price: "floor",
      quantity: "floor",
      constraintVersion: state.market.constraints.version,
    },
  });
  if (!created.ok) {
    throw failure(
      "precondition",
      "verification order intent failed domain validation.",
      "create",
    );
  }
  return created.value;
}

function lookupFor(
  symbol: string,
  clientId: string,
  exchangeOrderId?: string,
): ExchangeOrderLookup {
  return {
    instrument: symbol,
    clientOrderId: clientId,
    ...(exchangeOrderId === undefined ? {} : { exchangeOrderId }),
  };
}

function sumFills(fills: readonly ExchangeFillObservation[]): DecimalValue {
  return fills.reduce((total, fill) => total.add(fill.quantity), decimal("0"));
}

interface ReconciledOwnedOrder {
  readonly observation: ExchangeOrderObservation;
  readonly fills: readonly ExchangeFillObservation[];
}

async function reconcileOwnedOrder(
  port: ExchangeExecutionPort,
  request: ExchangeOrderLookup,
  attempts: number,
  sleep: (milliseconds: number) => Promise<void>,
  requireFill: boolean,
): Promise<ReconciledOwnedOrder> {
  let lastFailure: ExchangeExecutionFailure | undefined;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const observed = await port.observeOrder(request);
    if (!observed.ok) {
      lastFailure = observed.error;
      if (
        observed.error.retry !== "reconcile" &&
        observed.error.retry !== "read-only"
      ) {
        throw new VerificationFailure(observed.error);
      }
      await sleep(250 * Math.min(attempt + 1, 4));
      continue;
    }
    const lookup = lookupFor(
      request.instrument,
      observed.value.clientOrderId,
      observed.value.exchangeOrderId,
    );
    const fills = await port.listFills(lookup);
    if (!fills.ok) {
      lastFailure = fills.error;
      if (
        fills.error.retry !== "reconcile" &&
        fills.error.retry !== "read-only"
      ) {
        throw new VerificationFailure(fills.error);
      }
      await sleep(250 * Math.min(attempt + 1, 4));
      continue;
    }
    const filledQuantity = sumFills(fills.value);
    if (filledQuantity.compare(observed.value.filledQuantity) > 0) {
      throw failure(
        "ambiguous",
        "execution evidence exceeds the reconciled order quantity.",
        "fills",
        "reconcile",
        {
          clientOrderId: request.clientOrderId,
          exchangeOrderId: observed.value.exchangeOrderId,
        },
      );
    }
    const hasTerminalState =
      observed.value.status === "filled" ||
      observed.value.status === "cancelled" ||
      observed.value.status === "rejected";
    const hasActiveState =
      observed.value.status === "open" ||
      observed.value.status === "partially-filled";
    if (
      (!requireFill && (hasTerminalState || hasActiveState)) ||
      (requireFill &&
        filledQuantity.isPositive() &&
        (hasTerminalState || hasActiveState))
    ) {
      return { observation: observed.value, fills: fills.value };
    }
    await sleep(250 * Math.min(attempt + 1, 4));
  }
  throw new VerificationFailure(
    lastFailure ?? {
      kind: "ambiguous",
      message:
        "bounded Demo reconciliation did not reach a sufficient terminal state.",
      retry: "reconcile",
      operation: "observe",
      clientOrderId: request.clientOrderId,
      ...(request.exchangeOrderId === undefined
        ? {}
        : { exchangeOrderId: request.exchangeOrderId }),
    },
  );
}

async function cancelOpenOwnedOrder(
  port: ExchangeExecutionPort,
  order: ReconciledOwnedOrder,
  attempts: number,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<ReconciledOwnedOrder> {
  if (
    order.observation.status !== "open" &&
    order.observation.status !== "partially-filled"
  ) {
    return order;
  }
  const request = lookupFor(
    order.observation.instrument,
    order.observation.clientOrderId,
    order.observation.exchangeOrderId,
  );
  const acknowledgement = await port.cancelOrder(request);
  if (!acknowledgement.ok) throw new VerificationFailure(acknowledgement.error);
  return reconcileOwnedOrder(port, request, attempts, sleep, false);
}

async function cleanupOwnedExposure(
  port: ExchangeExecutionPort,
  state: ExchangeReadState,
  symbol: string,
  sourceOrder: ReconciledOwnedOrder,
  runId: string,
  suffix: string,
  attempts: number,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<{
  readonly observation: ExchangeOrderObservation;
  readonly fills: readonly ExchangeFillObservation[];
}> {
  const filledQuantity = sumFills(sourceOrder.fills);
  if (!filledQuantity.isPositive()) {
    throw failure(
      "ambiguous",
      "owned order has no execution evidence to clean up.",
      "fills",
      "reconcile",
    );
  }
  const side: OrderSide =
    sourceOrder.observation.side === "buy" ? "sell" : "buy";
  const price = alignedPrice(
    side === "sell" ? state.market.bid : state.market.ask,
    state,
    side === "sell" ? "floor" : "ceil",
  );
  const intent = buildIntent(
    state,
    `${runId}-${suffix}-intent`,
    symbol,
    side,
    "close",
    price,
    filledQuantity,
  );
  const clientId = clientOrderId(runId, suffix);
  const acknowledgement = await port.createOrder({
    intent,
    clientOrderId: clientId,
    timeInForce: "IOC",
    reduceOnly: true,
  });
  if (!acknowledgement.ok) throw new VerificationFailure(acknowledgement.error);
  const cleaned = await reconcileOwnedOrder(
    port,
    lookupFor(symbol, clientId, acknowledgement.value.exchangeOrderId),
    attempts,
    sleep,
    true,
  );
  const cleanedQuantity = sumFills(cleaned.fills);
  if (cleanedQuantity.compare(filledQuantity) !== 0) {
    throw failure(
      "ambiguous",
      "owned cleanup did not reconcile the exact executed quantity.",
      "fills",
      "reconcile",
      {
        clientOrderId: clientId,
        exchangeOrderId: cleaned.observation.exchangeOrderId,
      },
    );
  }
  return cleaned;
}

function stageFailure(
  name: string,
  error: VerificationFailure,
  status: "blocked" | "unresolved",
): DemoStageEvidence {
  return {
    name,
    status,
    ...(error.failure.clientOrderId === undefined
      ? {}
      : { clientOrderId: error.failure.clientOrderId }),
    ...(error.failure.exchangeOrderId === undefined
      ? {}
      : { exchangeOrderId: error.failure.exchangeOrderId }),
    message: error.failure.message,
  };
}

export async function runBybitDemoAdapterVerification(
  options: DemoVerificationOptions,
): Promise<DemoVerificationResult> {
  const clock = options.clock ?? systemClock;
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const attempts =
    options.reconciliationAttempts ?? DEFAULT_RECONCILIATION_ATTEMPTS;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 20) {
    throw new TypeError("reconciliationAttempts must be between 1 and 20");
  }
  const runId = options.runId ?? runIdFor(clock);
  validateRunId(runId);
  const startedAt = clock.now();
  const stages: DemoStageEvidence[] = [];
  let verdict: DemoVerificationVerdict = "UNRESOLVED";
  let finalFailure: ExchangeExecutionFailure | undefined;
  let writeStarted = false;
  const output = options.output;
  const writeResult = async (): Promise<DemoVerificationResult> => {
    const evidence = sanitizeEvidence({
      schemaVersion: DEMO_EVIDENCE_SCHEMA_VERSION,
      environment: "demo",
      verdict,
      runId,
      accountHash: accountHash(options.accountId),
      symbol: options.symbol,
      startedAt,
      finishedAt: clock.now(),
      stages,
      ...(finalFailure === undefined ? {} : { failure: finalFailure }),
    });
    let evidencePath: string | undefined;
    if (options.writeEvidence === true) {
      evidencePath = await writeEvidence(
        options.evidenceDirectory ?? DEFAULT_EVIDENCE_DIRECTORY,
        evidence,
      );
    }
    output?.write(`result: ${evidence.verdict}\n`);
    output?.write(`run: ${evidence.runId}\n`);
    output?.write(`account: ${evidence.accountHash}\n`);
    output?.write(`symbol: ${evidence.symbol}\n`);
    if (evidencePath !== undefined)
      output?.write(`evidence: ${evidencePath}\n`);
    return {
      verdict: evidence.verdict,
      runId: evidence.runId,
      evidence,
      ...(evidencePath === undefined ? {} : { evidencePath }),
    };
  };

  try {
    const preflight = resultValue(
      await options.port.readState({ instrument: options.symbol }),
    );
    assertCleanState(preflight, options.symbol);
    stages.push({
      name: "preflight",
      status: "passed",
      message:
        "Demo scope, reconciliation reads and clean selected-symbol baseline proven.",
    });

    const fillPrice = alignedPrice(preflight.market.ask, preflight, "ceil");
    const fillSize = orderQuantity(fillPrice, preflight);
    const fillClientId = clientOrderId(runId, "fill");
    const fillIntent = buildIntent(
      preflight,
      `${runId}-fill-intent`,
      options.symbol,
      "buy",
      "open",
      fillPrice,
      fillSize.quantity,
    );
    writeStarted = true;
    const fillAcknowledgement = resultValue(
      await options.port.createOrder({
        intent: fillIntent,
        clientOrderId: fillClientId,
        timeInForce: "IOC",
        reduceOnly: false,
      }),
    );
    const fillRequest = lookupFor(
      options.symbol,
      fillClientId,
      fillAcknowledgement.exchangeOrderId,
    );
    let fillOrder = await reconcileOwnedOrder(
      options.port,
      fillRequest,
      attempts,
      sleep,
      true,
    );
    if (
      fillOrder.observation.status === "open" ||
      fillOrder.observation.status === "partially-filled"
    ) {
      fillOrder = await cancelOpenOwnedOrder(
        options.port,
        fillOrder,
        attempts,
        sleep,
      );
    }
    const fillQuantity = sumFills(fillOrder.fills);
    if (!fillQuantity.isPositive()) {
      throw failure(
        "ambiguous",
        "marketable Demo verification order did not produce execution evidence.",
        "fills",
        "reconcile",
        {
          clientOrderId: fillClientId,
          exchangeOrderId: fillOrder.observation.exchangeOrderId,
        },
      );
    }
    stages.push(
      stageFromObservation("fill", fillOrder.observation, {
        clientOrderId: fillClientId,
        fillCount: fillOrder.fills.length,
      }),
    );

    const beforeCleanup = resultValue(
      await options.port.readState({ instrument: options.symbol }),
    );
    assertOwnedExposureState(
      beforeCleanup,
      options.symbol,
      fillOrder.observation.side,
      fillQuantity,
      new Set([fillClientId]),
    );
    const cleanup = await cleanupOwnedExposure(
      options.port,
      beforeCleanup,
      options.symbol,
      fillOrder,
      runId,
      "fill-cleanup",
      attempts,
      sleep,
    );
    stages.push(
      stageFromObservation("fill-cleanup", cleanup.observation, {
        fillCount: cleanup.fills.length,
        cleanup: "exact-owned-reduce-only",
      }),
    );
    const cleanAfterFill = resultValue(
      await options.port.readState({ instrument: options.symbol }),
    );
    assertCleanState(cleanAfterFill, options.symbol);

    const passivePrice = alignedPrice(
      cleanAfterFill.market.bid.subtract(
        cleanAfterFill.market.constraints.priceTickSize.multiply(decimal("2")),
      ),
      cleanAfterFill,
      "floor",
    );
    const passiveSize = orderQuantity(passivePrice, cleanAfterFill);
    const passiveClientId = clientOrderId(runId, "passive");
    const passiveIntent = buildIntent(
      cleanAfterFill,
      `${runId}-passive-intent`,
      options.symbol,
      "buy",
      "open",
      passivePrice,
      passiveSize.quantity,
    );
    const passiveAcknowledgement = resultValue(
      await options.port.createOrder({
        intent: passiveIntent,
        clientOrderId: passiveClientId,
        timeInForce: "PostOnly",
        reduceOnly: false,
      }),
    );
    let passiveOrder = await reconcileOwnedOrder(
      options.port,
      lookupFor(
        options.symbol,
        passiveClientId,
        passiveAcknowledgement.exchangeOrderId,
      ),
      attempts,
      sleep,
      false,
    );
    if (
      passiveOrder.observation.status === "open" ||
      passiveOrder.observation.status === "partially-filled"
    ) {
      const cancelRequest = lookupFor(
        options.symbol,
        passiveClientId,
        passiveOrder.observation.exchangeOrderId,
      );
      const cancelled = resultValue(
        await options.port.cancelOrder(cancelRequest),
      );
      passiveOrder = await reconcileOwnedOrder(
        options.port,
        lookupFor(
          options.symbol,
          passiveClientId,
          cancelled.exchangeOrderId ?? passiveOrder.observation.exchangeOrderId,
        ),
        attempts,
        sleep,
        false,
      );
      if (passiveOrder.observation.status !== "cancelled") {
        throw failure(
          "ambiguous",
          "exact-owned passive cancellation did not reconcile as cancelled.",
          "observe",
          "reconcile",
          {
            clientOrderId: passiveClientId,
            exchangeOrderId: passiveOrder.observation.exchangeOrderId,
          },
        );
      }
      stages.push(
        stageFromObservation("passive-cancel", passiveOrder.observation, {
          clientOrderId: passiveClientId,
          fillCount: passiveOrder.fills.length,
          cleanup: "exact-owned-cancel",
        }),
      );
    } else if (
      passiveOrder.observation.status === "cancelled" ||
      passiveOrder.observation.status === "filled"
    ) {
      stages.push(
        stageFromObservation("passive-cancel", passiveOrder.observation, {
          clientOrderId: passiveClientId,
          fillCount: passiveOrder.fills.length,
          cleanup:
            passiveOrder.observation.status === "filled"
              ? "fill-race-before-cancel"
              : passiveOrder.fills.length === 0
                ? "immediate-cancel"
                : "cancelled-with-fill",
        }),
      );
    } else {
      throw failure(
        "ambiguous",
        "passive Demo order did not reach an open or cancelled terminal state.",
        "observe",
        "reconcile",
        {
          clientOrderId: passiveClientId,
          exchangeOrderId: passiveOrder.observation.exchangeOrderId,
        },
      );
    }
    if (passiveOrder.fills.length > 0) {
      const beforePassiveCleanup = resultValue(
        await options.port.readState({ instrument: options.symbol }),
      );
      assertOwnedExposureState(
        beforePassiveCleanup,
        options.symbol,
        passiveOrder.observation.side,
        sumFills(passiveOrder.fills),
        new Set([passiveClientId]),
      );
      const passiveCleanup = await cleanupOwnedExposure(
        options.port,
        beforePassiveCleanup,
        options.symbol,
        passiveOrder,
        runId,
        "passive-cleanup",
        attempts,
        sleep,
      );
      stages.push(
        stageFromObservation("passive-cleanup", passiveCleanup.observation, {
          fillCount: passiveCleanup.fills.length,
          cleanup: "exact-owned-reduce-only",
        }),
      );
    }
    const finalState = resultValue(
      await options.port.readState({ instrument: options.symbol }),
    );
    assertCleanState(finalState, options.symbol);
    stages.push({
      name: "final-clean-state",
      status: "passed",
      message: "selected Demo symbol is flat with no open orders",
    });
    verdict = "CONFIRMED_CLEAN";
  } catch (error) {
    const normalized =
      error instanceof VerificationFailure
        ? error
        : failure(
            "transport",
            "Demo verification stopped without a safe normalized diagnostic.",
            writeStarted ? "observe" : "read",
            "reconcile",
          );
    finalFailure = normalized.failure;
    stages.push(
      stageFailure(
        writeStarted ? "unresolved" : "preflight",
        normalized,
        writeStarted ? "unresolved" : "blocked",
      ),
    );
    verdict = writeStarted ? "UNRESOLVED" : "BLOCKED";
  }
  return writeResult();
}

function usage(): string {
  return "Usage: npm run verify:bybit:demo-adapter -- [--symbol DOGEUSDT]";
}

function parseSymbol(argv: readonly string[]): string {
  if (argv.length === 0) return DEFAULT_DEMO_SYMBOL;
  if (
    argv.length !== 2 ||
    argv[0] !== "--symbol" ||
    !/^[A-Z0-9]+$/u.test(argv[1] ?? "")
  ) {
    throw new Error(usage());
  }
  return argv[1]!;
}

export async function runBybitDemoAdapterCli(
  argv: readonly string[],
  {
    provider = createMacOSKeychainProvider(),
    output = process.stdout,
  }: { provider?: Pick<CredentialProvider, "load">; output?: Output } = {},
): Promise<number> {
  let symbol: string;
  try {
    symbol = parseSymbol(argv);
  } catch (error) {
    output.write(`${error instanceof Error ? error.message : usage()}\n`);
    return 2;
  }
  let credentials: ExchangeCredentials;
  try {
    credentials = await provider.load("demo");
  } catch {
    output.write(
      "Bybit Demo credentials could not be loaded from the approved credential provider.\n",
    );
    return 2;
  }
  const transport = createBybitDemoTransport({ credentials });
  const adapterOptions: BybitDemoExecutionAdapterOptions = {
    accountId: credentials.accountId,
    transport,
  };
  const result = await runBybitDemoAdapterVerification({
    port: new BybitDemoExecutionAdapter(adapterOptions),
    symbol,
    accountId: credentials.accountId,
    writeEvidence: true,
    output,
  });
  return result.verdict === "CONFIRMED_CLEAN"
    ? 0
    : result.verdict === "BLOCKED"
      ? 2
      : 5;
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = await runBybitDemoAdapterCli(process.argv.slice(2));
}
