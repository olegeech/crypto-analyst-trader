import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { openSqlitePersistence } from "../src/adapters/sqlite/sqlite-persistence.js";
import { runTraderDemoCli } from "../src/cli/trader-demo.js";
import { createAdapterCapabilityObservation } from "../src/domain/capabilities/capability.js";
import { createExchangeOrder } from "../src/domain/execution/exchange-order.js";
import { DecimalValue } from "../src/domain/shared/decimal.js";
import { fixedClock, type Clock } from "../src/domain/shared/time.js";
import type {
  ExchangeExecutionPort,
  ExchangeFillObservation,
  ExchangeOrderAcknowledgement,
  ExchangeOrderObservation,
  ExchangeOrderRequest,
  ExchangeReadState,
  ExchangeResult,
  ExchangeSetLeverageRequest,
  ExchangeSetLeverageResult,
} from "../src/ports/exchange-execution.js";
import type { ExchangeCredentials } from "../src/ports/credential-provider.js";
import type {
  PersistencePort,
  PersistenceScope,
} from "../src/ports/persistence.js";
import type { Result } from "../src/domain/shared/result.js";
import { createPlanFixture } from "./domain-plan-fixture.js";

const runtime = { nodeVersion: "22.22.3", sqliteVersion: "3.51.3" } as const;

function unwrap<T>(result: Result<T>): T {
  if (!result.ok)
    throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function decimal(value: string): DecimalValue {
  return unwrap(DecimalValue.fromString(value));
}

function tty(value: boolean): NodeJS.ReadableStream & { isTTY: boolean } {
  return { isTTY: value } as unknown as NodeJS.ReadableStream & {
    isTTY: boolean;
  };
}

function output(): NodeJS.WritableStream & {
  isTTY: boolean;
  readonly text: string;
} {
  const chunks: string[] = [];
  return {
    isTTY: true,
    get text() {
      return chunks.join("");
    },
    write(chunk: string) {
      chunks.push(String(chunk));
      return true;
    },
  } as unknown as NodeJS.WritableStream & {
    isTTY: boolean;
    readonly text: string;
  };
}

function credentials(): ExchangeCredentials {
  return {
    apiKey: "sentinel-api-key",
    apiSecret: "sentinel-api-secret",
    accountId: "demo:fixture",
  };
}

function validState(clock: Clock): ExchangeReadState {
  const plan = createPlanFixture();
  const capabilities = [
    "order-create",
    "attached-protection",
    "reconciliation-reads",
    "set-leverage",
  ].map((capability) =>
    unwrap(
      createAdapterCapabilityObservation({
        capability,
        status: "supported",
        observedAt: clock.now(),
        source: "cli-fixture-adapter",
        evidence: plan.material.evidence[0],
        scope: plan.material.executionScope,
      }),
    ),
  );
  return {
    serverTime: clock.now(),
    market: plan.material.marketSnapshot,
    account: plan.material.accountSnapshot,
    openOrders: [],
    accountReadiness: { status: "ready" },
    leverage: {
      buy: decimal("1"),
      sell: decimal("1"),
      effective: decimal("1"),
    },
    accountMetadata: {
      accountId: "demo:fixture",
      userId: "demo:fixture",
      apiKey: {
        readOnly: false,
        contractTrade: { order: true, position: true },
        wallet: { withdraw: false, transfer: false },
        ips: [],
        ipBinding: "unbound",
        warningCodes: ["API_KEY_IP_UNBOUND"],
      },
    },
    capabilities,
  };
}

class OpenOrderExchange implements ExchangeExecutionPort {
  readonly createRequests: ExchangeOrderRequest[] = [];
  private readonly state: ExchangeReadState;
  private readonly clock: Clock;
  private latestRequest: ExchangeOrderRequest | undefined;

  constructor(state: ExchangeReadState, clock: Clock) {
    this.state = state;
    this.clock = clock;
  }

  async readState(): Promise<ExchangeResult<ExchangeReadState>> {
    return { ok: true, value: this.state };
  }

  async createOrder(
    request: ExchangeOrderRequest,
  ): Promise<ExchangeResult<ExchangeOrderAcknowledgement>> {
    this.latestRequest = request;
    this.createRequests.push(request);
    return {
      ok: true,
      value: {
        clientOrderId: request.clientOrderId,
        exchangeOrderId: "exchange-open-1",
        acknowledgedAt: this.clock.now(),
        status: "accepted",
      },
    };
  }

  async observeOrder(request: {
    readonly clientOrderId: string;
    readonly exchangeOrderId?: string;
  }): Promise<ExchangeResult<ExchangeOrderObservation>> {
    const order = this.latestRequest;
    if (order === undefined) {
      return {
        ok: false,
        error: {
          kind: "ownership",
          message: "missing fixture order",
          retry: "never",
        },
      };
    }
    return {
      ok: true,
      value: unwrap(
        createExchangeOrder({
          exchangeOrderId: request.exchangeOrderId ?? "exchange-open-1",
          clientOrderId: request.clientOrderId,
          instrument: order.intent.instrument,
          side: order.intent.side,
          requestedQuantity: order.intent.quantity.toString(),
          filledQuantity: "0",
          status: "open",
          observedAt: this.clock.now(),
          source: "cli-fixture-order",
        }),
      ),
    };
  }

  async listAttachedProtection(): Promise<
    ExchangeResult<readonly ExchangeOrderObservation[]>
  > {
    return { ok: true, value: [] };
  }

  async listFills(): Promise<
    ExchangeResult<readonly ExchangeFillObservation[]>
  > {
    return { ok: true, value: [] };
  }

  async setLeverage(
    request: ExchangeSetLeverageRequest,
  ): Promise<ExchangeResult<ExchangeSetLeverageResult>> {
    return {
      ok: true,
      value: {
        instrument: request.instrument,
        target: request.target,
        effective: {
          buy: decimal("1"),
          sell: decimal("1"),
          effective: decimal("1"),
        },
        verifiedAt: this.clock.now(),
      },
    };
  }

  async cancelOrder(): Promise<ExchangeResult<ExchangeOrderAcknowledgement>> {
    return {
      ok: false,
      error: {
        kind: "precondition",
        message: "fixture does not cancel",
        retry: "never",
      },
    };
  }
}

function persistenceFactory(
  root: string,
  events: string[],
): (options: {
  scope: PersistenceScope;
  clock: Clock;
}) => Result<PersistencePort & { close(): void }> {
  return (options) => {
    events.push("persistence");
    return openSqlitePersistence({
      environment: "demo",
      databasePath: join(root, "demo.db"),
      runtime,
      clock: options.clock,
      scope: options.scope,
    });
  };
}

test("invalid Demo flags are rejected before credentials or persistence", async () => {
  const stream = output();
  let loads = 0;
  let opens = 0;
  const result = await runTraderDemoCli(
    [
      "--environment",
      "testnet",
      "--symbol",
      "DOGEUSDT",
      "--side",
      "buy",
      "--notional",
      "10",
      "--take-profit-percent",
      "3",
    ],
    {
      output: stream,
      input: tty(true),
      credentialProvider: {
        async load() {
          loads += 1;
          return credentials();
        },
      },
      openPersistence: () => {
        opens += 1;
        throw new Error("must not open persistence");
      },
    },
  );
  assert.equal(result, 2);
  assert.equal(loads, 0);
  assert.equal(opens, 0);
  assert.match(stream.text, /INVALID_ARGUMENT/);
  assert.doesNotMatch(stream.text, /testnet/);
});

test("write-capable Demo flow requires both TTYs before Keychain access", async () => {
  const stream = output();
  let loads = 0;
  const result = await runTraderDemoCli(
    [
      "--symbol",
      "DOGEUSDT",
      "--side",
      "buy",
      "--notional",
      "10",
      "--take-profit-price",
      "0.1",
    ],
    {
      output: stream,
      input: tty(false),
      credentialProvider: {
        async load() {
          loads += 1;
          return credentials();
        },
      },
    },
  );
  assert.equal(result, 4);
  assert.equal(loads, 0);
  assert.match(stream.text, /NOT_TTY/);
});

test("preflight failure is redacted and happens before SQLite opens", async () => {
  const stream = output();
  const events: string[] = [];
  const root = mkdtempSync(join(tmpdir(), "trader-demo-cli-preflight-"));
  let loads = 0;
  const result = await runTraderDemoCli(
    [
      "--symbol",
      "DOGEUSDT",
      "--side",
      "buy",
      "--notional",
      "10",
      "--take-profit-percent",
      "3",
    ],
    {
      output: stream,
      input: tty(true),
      credentialProvider: {
        async load() {
          events.push("credentials");
          loads += 1;
          return credentials();
        },
      },
      createExchange: () => {
        events.push("adapter");
        return {
          readState: async () => ({
            ok: false,
            error: {
              kind: "invalid-response",
              message: "\u001b[31msentinel-api-secret raw response\u001b[0m",
              retry: "never",
            },
          }),
        } as unknown as ExchangeExecutionPort;
      },
      openPersistence: persistenceFactory(root, events),
    },
  );
  assert.equal(result, 4);
  assert.equal(loads, 1);
  assert.deepEqual(events, ["credentials", "adapter"]);
  assert.doesNotMatch(stream.text, /sentinel-api-(?:key|secret)/);
  assert.doesNotMatch(stream.text, /\u001b/);
});

test("classified exchange preconditions use the stable NOT_READY exit", async () => {
  const stream = output();
  const root = mkdtempSync(join(tmpdir(), "trader-demo-cli-precondition-"));
  const result = await runTraderDemoCli(
    [
      "--symbol",
      "DOGEUSDT",
      "--side",
      "buy",
      "--notional",
      "10",
      "--take-profit-percent",
      "3",
    ],
    {
      output: stream,
      input: tty(true),
      credentialProvider: {
        async load() {
          return credentials();
        },
      },
      createExchange: () =>
        ({
          readState: async () => ({
            ok: false,
            error: {
              kind: "precondition",
              message: "private exchange detail",
              retry: "never",
            },
          }),
        }) as unknown as ExchangeExecutionPort,
      openPersistence: persistenceFactory(root, []),
    },
  );
  assert.equal(result, 4);
  assert.match(stream.text, /VERDICT=NOT_READY/);
  assert.match(stream.text, /REASON_CODE=EXCHANGE_PRECONDITION/);
});

test("approved CLI flow is fixed to Demo Limit+GTC and leaves an owned open order", async () => {
  const clock = unwrap(fixedClock("2026-09-19T10:00:01.000Z"));
  const state = validState(clock);
  const exchange = new OpenOrderExchange(state, clock);
  const stream = output();
  const root = mkdtempSync(join(tmpdir(), "trader-demo-cli-happy-"));
  const events: string[] = [];
  let prompts = 0;
  const result = await runTraderDemoCli(
    [
      "--symbol",
      "DOGEUSDT",
      "--side",
      "buy",
      "--notional",
      "10",
      "--take-profit-percent",
      "3",
    ],
    {
      clock,
      actor: "fixture-operator",
      output: stream,
      input: tty(true),
      credentialProvider: {
        async load() {
          events.push("credentials");
          return credentials();
        },
      },
      createExchange: () => {
        events.push("adapter");
        return exchange;
      },
      openPersistence: persistenceFactory(root, events),
      prompt: async () => {
        prompts += 1;
        return "yes";
      },
    },
  );
  assert.equal(result, 0);
  assert.equal(prompts, 1);
  assert.equal(exchange.createRequests.length, 1);
  assert.equal(exchange.createRequests[0]?.timeInForce, "GTC");
  assert.equal(exchange.createRequests[0]?.reduceOnly, false);
  assert.ok(events.indexOf("adapter") < events.indexOf("persistence"));
  assert.match(stream.text, /ORDER_TYPE=Limit/);
  assert.match(stream.text, /TIME_IN_FORCE=GTC/);
  assert.match(stream.text, /VERDICT=CONFIRMED_OPEN/);
  assert.match(stream.text, /WARNING=API_KEY_IP_UNBOUND/);
  assert.doesNotMatch(stream.text, /demo:fixture|sentinel-api-/);
  assert.deepEqual(readdirSync(root).sort(), ["demo.db"]);
});

test("a single no answer declines before the first exchange write", async () => {
  const clock = unwrap(fixedClock("2026-09-19T10:00:01.000Z"));
  const exchange = new OpenOrderExchange(validState(clock), clock);
  const stream = output();
  const root = mkdtempSync(join(tmpdir(), "trader-demo-cli-decline-"));
  const result = await runTraderDemoCli(
    [
      "--symbol",
      "DOGEUSDT",
      "--side",
      "buy",
      "--notional",
      "10",
      "--take-profit-percent",
      "3",
    ],
    {
      clock,
      actor: "fixture-operator",
      output: stream,
      input: tty(true),
      credentialProvider: { load: async () => credentials() },
      createExchange: () => exchange,
      openPersistence: persistenceFactory(root, []),
      prompt: async () => "no",
    },
  );
  assert.equal(result, 3);
  assert.equal(exchange.createRequests.length, 0);
  assert.match(stream.text, /VERDICT=DECLINED/);
});
