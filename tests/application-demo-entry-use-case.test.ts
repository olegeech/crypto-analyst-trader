import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { openSqlitePersistence } from "../src/adapters/sqlite/sqlite-persistence.js";
import { createAdapterCapabilityObservation } from "../src/domain/capabilities/capability.js";
import { createEvidenceRef } from "../src/domain/evidence/evidence-ref.js";
import { createExchangeOrder } from "../src/domain/execution/exchange-order.js";
import { DecimalValue } from "../src/domain/shared/decimal.js";
import { fixedClock, type UtcTimestamp } from "../src/domain/shared/time.js";
import {
  createAccountSnapshot,
  createMarketSnapshot,
} from "../src/domain/market/snapshots.js";
import type {
  ExchangeExecutionFailure,
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
import type {
  PersistencePort,
  PersistenceScope,
} from "../src/ports/persistence.js";
import { createDemoEntryUseCase } from "../src/application/demo-entry-use-case.js";
import type { Result } from "../src/domain/shared/result.js";

const runtime = { nodeVersion: "22.22.3", sqliteVersion: "3.51.3" } as const;

function unwrap<T>(result: Result<T>): T {
  if (!result.ok)
    throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function decimal(value: string): DecimalValue {
  return unwrap(DecimalValue.fromString(value));
}

function scope(): PersistenceScope {
  return {
    exchange: "bybit",
    environment: "demo",
    accountId: "demo:account",
    category: "linear",
    positionMode: "one-way",
  };
}

function persistence(clock: { now: () => UtcTimestamp }): PersistencePort {
  const root = mkdtempSync(join(tmpdir(), "demo-entry-use-case-"));
  return unwrap(
    openSqlitePersistence({
      environment: "demo",
      databasePath: join(root, "execution.db"),
      runtime,
      clock,
      scope: scope(),
    }),
  );
}

function state(clock: { now: () => UtcTimestamp }): ExchangeReadState {
  const current = clock.now();
  const readScope = {
    exchange: "bybit",
    environment: "demo",
    category: "linear",
    positionMode: "one-way" as const,
  };
  const marketEvidence = unwrap(
    createEvidenceRef({
      kind: "market-snapshot",
      schemaVersion: "fixture/v1",
      producer: "fixture",
      sourceId: "market",
      asOf: current,
      validForMs: 120_000,
      contentHash: `sha256:${"1".repeat(64)}`,
    }),
  );
  const accountEvidence = unwrap(
    createEvidenceRef({
      kind: "account-snapshot",
      schemaVersion: "fixture/v1",
      producer: "fixture",
      sourceId: "account",
      asOf: current,
      validForMs: 120_000,
      contentHash: `sha256:${"2".repeat(64)}`,
    }),
  );
  const market = unwrap(
    createMarketSnapshot({
      snapshotId: "market",
      instrument: "DOGEUSDT",
      scope: readScope,
      asOf: current,
      bid: "0.0999",
      ask: "0.1",
      last: "0.1",
      constraints: {
        instrument: "DOGEUSDT",
        version: "fixture-constraints",
        priceTickSize: "0.0001",
        quantityStep: "1",
        minQuantity: "1",
        minNotional: "5",
      },
      evidence: [marketEvidence],
    }),
  );
  const account = unwrap(
    createAccountSnapshot({
      snapshotId: "account",
      accountScope: "demo:account",
      scope: readScope,
      asOf: current,
      availableBalance: "1000",
      positions: [{ instrument: "DOGEUSDT", side: "flat", quantity: "0" }],
      ownedOrders: [],
      evidence: [accountEvidence],
    }),
  );
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
        observedAt: current,
        source: "fixture-adapter",
        evidence: unwrap(
          createEvidenceRef({
            kind: "capability-probe",
            schemaVersion: "fixture/v1",
            producer: "fixture-adapter",
            sourceId: `cap-${capability}`,
            asOf: current,
            validForMs: 120_000,
            contentHash: `sha256:${"3".repeat(64)}`,
          }),
        ),
        scope: readScope,
      }),
    ),
  );
  return {
    serverTime: current,
    market,
    account,
    openOrders: [],
    accountReadiness: { status: "ready" },
    leverage: {
      buy: decimal("1"),
      sell: decimal("1"),
      effective: decimal("1"),
    },
    accountMetadata: {
      accountId: "demo:account",
      userId: "demo:account",
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

class FakeExchange implements ExchangeExecutionPort {
  readonly createRequests: ExchangeOrderRequest[] = [];
  readonly setLeverageRequests: ExchangeSetLeverageRequest[] = [];
  readonly cancelRequests: string[] = [];
  readonly states: ExchangeReadState[];
  readonly acknowledgement: ExchangeResult<ExchangeOrderAcknowledgement>;
  readonly observation: ExchangeResult<ExchangeOrderObservation>;
  readonly protection: readonly ExchangeOrderObservation[];
  readonly fills: readonly ExchangeFillObservation[];
  private lastClientOrderId = "placeholder";

  constructor(options: {
    readonly state: ExchangeReadState;
    readonly acknowledgement: ExchangeResult<ExchangeOrderAcknowledgement>;
    readonly observation: ExchangeResult<ExchangeOrderObservation>;
    readonly protection?: readonly ExchangeOrderObservation[];
    readonly fills?: readonly ExchangeFillObservation[];
  }) {
    this.states = [options.state, options.state, options.state, options.state];
    this.acknowledgement = options.acknowledgement;
    this.observation = options.observation;
    this.protection = options.protection ?? [];
    this.fills = options.fills ?? [];
  }

  async readState(): Promise<ExchangeResult<ExchangeReadState>> {
    return { ok: true, value: this.states.shift() ?? this.states[0]! };
  }

  async createOrder(
    request: ExchangeOrderRequest,
  ): Promise<ExchangeResult<ExchangeOrderAcknowledgement>> {
    this.createRequests.push(request);
    this.lastClientOrderId = request.clientOrderId;
    return this.acknowledgement;
  }

  async observeOrder(): Promise<ExchangeResult<ExchangeOrderObservation>> {
    if (!this.observation.ok) return this.observation;
    const source = this.observation.value;
    if (source.clientOrderId === this.lastClientOrderId)
      return this.observation;
    return {
      ok: true,
      value: unwrap(
        createExchangeOrder({
          exchangeOrderId: source.exchangeOrderId,
          clientOrderId: this.lastClientOrderId,
          instrument: source.instrument,
          side: source.side,
          requestedQuantity: source.requestedQuantity.toString(),
          filledQuantity: source.filledQuantity.toString(),
          status: source.status,
          observedAt: source.observedAt,
          source: source.source,
          ...(source.parentOrderLinkId === undefined
            ? {}
            : { parentOrderLinkId: source.parentOrderLinkId }),
          ...(source.protectionType === undefined
            ? {}
            : { protectionType: source.protectionType }),
        }),
      ),
    };
  }

  async listAttachedProtection(): Promise<
    ExchangeResult<readonly ExchangeOrderObservation[]>
  > {
    return {
      ok: true,
      value: this.protection.map((source) =>
        unwrap(
          createExchangeOrder({
            exchangeOrderId: source.exchangeOrderId,
            clientOrderId: source.clientOrderId,
            parentOrderLinkId: this.lastClientOrderId,
            instrument: source.instrument,
            side: source.side,
            requestedQuantity: source.requestedQuantity.toString(),
            filledQuantity: source.filledQuantity.toString(),
            status: source.status,
            observedAt: source.observedAt,
            source: source.source,
            ...(source.protectionType === undefined
              ? {}
              : { protectionType: source.protectionType }),
          }),
        ),
      ),
    };
  }

  async listFills(): Promise<
    ExchangeResult<readonly ExchangeFillObservation[]>
  > {
    return { ok: true, value: this.fills };
  }

  async setLeverage(
    request: ExchangeSetLeverageRequest,
  ): Promise<ExchangeResult<ExchangeSetLeverageResult>> {
    this.setLeverageRequests.push(request);
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
        verifiedAt: "2026-09-22T10:00:00.000Z" as UtcTimestamp,
      },
    };
  }

  async cancelOrder(request: {
    readonly clientOrderId: string;
  }): Promise<ExchangeResult<ExchangeOrderAcknowledgement>> {
    this.cancelRequests.push(request.clientOrderId);
    return {
      ok: false,
      error: { kind: "precondition", message: "not expected", retry: "never" },
    };
  }
}

function configuredOrder(
  clock: { now: () => UtcTimestamp },
  status: "open" | "filled",
  clientOrderId: string,
): ExchangeOrderObservation {
  return unwrap(
    createExchangeOrder({
      exchangeOrderId: "exchange-1",
      clientOrderId,
      instrument: "DOGEUSDT",
      side: "buy",
      requestedQuantity: "100",
      filledQuantity: status === "filled" ? "100" : "0",
      status,
      observedAt: clock.now(),
      source: "fixture/order",
    }),
  );
}

function fill(
  clock: { now: () => UtcTimestamp },
  clientOrderId: string,
): ExchangeFillObservation {
  return {
    executionId: "execution-1",
    exchangeOrderId: "exchange-1",
    clientOrderId,
    instrument: "DOGEUSDT",
    side: "buy",
    quantity: decimal("100"),
    price: decimal("0.1"),
    executedAt: clock.now(),
    source: "fixture/execution",
    fee: decimal("0.01"),
    feeCurrency: "USDT",
  };
}

function createAcknowledgement(
  clock: { now: () => UtcTimestamp },
  exchangeOrderId?: string,
): ExchangeResult<ExchangeOrderAcknowledgement> {
  return {
    ok: true,
    value: {
      clientOrderId: "placeholder",
      acknowledgedAt: clock.now(),
      status: "accepted",
      ...(exchangeOrderId === undefined ? {} : { exchangeOrderId }),
    },
  };
}

function failure(
  kind: ExchangeExecutionFailure["kind"],
): ExchangeResult<never> {
  return {
    ok: false,
    error: { kind, message: `fixture ${kind}`, retry: "reconcile" },
  };
}

test("approved Demo entry preserves an owned open order and never cleans it up", async () => {
  const clock = unwrap(fixedClock("2026-09-22T10:00:00.000Z"));
  const exchange = new FakeExchange({
    state: state(clock),
    acknowledgement: createAcknowledgement(clock),
    observation: {
      ok: true,
      value: configuredOrder(clock, "open", "placeholder"),
    },
  });
  const store = persistence(clock);
  const app = createDemoEntryUseCase({
    exchange,
    persistence: store,
    clock,
  });
  const prep = await app.prepare({
    symbol: "DOGEUSDT",
    side: "buy",
    notional: "10",
    takeProfitPercent: "3",
  });
  const result = prep.ok ? await app.execute(prep.value, true) : prep;
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.verdict, "CONFIRMED_OPEN");
    assert.equal(result.value.acknowledgement, "accepted");
  }
  assert.equal(exchange.createRequests.length, 1);
  assert.equal(exchange.createRequests[0]?.timeInForce, "GTC");
  assert.deepEqual(exchange.cancelRequests, []);
  assert.equal(unwrap(store.readHalt()).active, true);
  assert.equal(unwrap(store.readRuns()).length, 1);
  store.close();
});

test("filled Demo entry requires exact protection and durable accounting before confirmation", async () => {
  const clock = unwrap(fixedClock("2026-09-22T10:00:00.000Z"));
  const exchange = new FakeExchange({
    state: state(clock),
    acknowledgement: createAcknowledgement(clock, "exchange-1"),
    observation: {
      ok: true,
      value: configuredOrder(clock, "filled", "placeholder"),
    },
    protection: [
      unwrap(
        createExchangeOrder({
          exchangeOrderId: "tp-1",
          clientOrderId: "tp-client",
          parentOrderLinkId: "placeholder",
          instrument: "DOGEUSDT",
          side: "sell",
          requestedQuantity: "100",
          filledQuantity: "0",
          status: "open",
          observedAt: clock.now(),
          source: "fixture/protection",
          protectionType: "take-profit",
        }),
      ),
    ],
    fills: [fill(clock, "placeholder")],
  });
  const store = persistence(clock);
  const result = await createDemoEntryUseCase({
    exchange,
    persistence: store,
    clock,
  }).run(
    {
      symbol: "DOGEUSDT",
      side: "buy",
      notional: "10",
      takeProfitPercent: "3",
    },
    () => true,
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.verdict, "CONFIRMED_FILLED");
  assert.equal(exchange.createRequests.length, 1);
  assert.equal(exchange.cancelRequests.length, 0);
  assert.equal(unwrap(store.readHalt()).active, false);
  const facts = unwrap(store.readFacts());
  assert.ok(facts.some((fact) => fact.factKind === "fill"));
  assert.ok(facts.some((fact) => fact.factKind === "ledger-entry"));
  assert.ok(facts.some((fact) => fact.eventIdentity.includes("protection")));
  store.close();
});

test("ambiguous create becomes unresolved and cannot trigger a replacement order", async () => {
  const clock = unwrap(fixedClock("2026-09-22T10:00:00.000Z"));
  const exchange = new FakeExchange({
    state: state(clock),
    acknowledgement: failure("ambiguous"),
    observation: failure("ambiguous"),
  });
  const store = persistence(clock);
  const result = await createDemoEntryUseCase({
    exchange,
    persistence: store,
    clock,
  }).run(
    {
      symbol: "DOGEUSDT",
      side: "buy",
      notional: "10",
      takeProfitPercent: "3",
    },
    () => true,
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.verdict, "UNRESOLVED");
    assert.equal(result.value.reconciliationStatus, "UNRESOLVED");
  }
  assert.equal(exchange.createRequests.length, 1);
  assert.equal(unwrap(store.readHalt()).active, true);
  store.close();
});
