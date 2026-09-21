import assert from "node:assert/strict";
import test from "node:test";

import { runBybitDemoAdapterVerification } from "../scripts/bybit-demo-adapter-verification.js";
import { DecimalValue } from "../src/domain/shared/decimal.js";
import type {
  ExchangeExecutionPort,
  ExchangeFillObservation,
  ExchangeOrderAcknowledgement,
  ExchangeOrderLookup,
  ExchangeOrderObservation,
  ExchangeOrderRequest,
  ExchangeReadState,
} from "../src/ports/exchange-execution.js";
import { createEvidenceRef } from "../src/domain/evidence/evidence-ref.js";
import { createInstrumentConstraints } from "../src/domain/market/instrument-constraints.js";
import { createMarketSnapshot } from "../src/domain/market/snapshots.js";
import { fixedClock } from "../src/domain/shared/time.js";

const scope = {
  exchange: "bybit",
  environment: "demo",
  category: "linear",
  positionMode: "one-way" as const,
};

function decimal(value: string): DecimalValue {
  const result = DecimalValue.fromString(value);
  assert.equal(result.ok, true);
  return result.value;
}

function fixtureMarket() {
  const evidence = createEvidenceRef({
    kind: "market-snapshot",
    schemaVersion: "fixture/v1",
    producer: "fixture",
    sourceId: "verification",
    asOf: "2026-09-21T10:00:00.000Z",
    validForMs: 60_000,
    contentHash: `sha256:${"a".repeat(64)}`,
  });
  const constraints = createInstrumentConstraints({
    instrument: "DOGEUSDT",
    version: "fixture:v1",
    priceTickSize: "0.0001",
    quantityStep: "1",
    minQuantity: "1",
    minNotional: "5",
  });
  assert.equal(evidence.ok, true);
  assert.equal(constraints.ok, true);
  if (!evidence.ok || !constraints.ok) throw new Error("fixture");
  const market = createMarketSnapshot({
    snapshotId: "market-verification",
    instrument: "DOGEUSDT",
    scope,
    asOf: "2026-09-21T10:00:00.000Z",
    bid: "0.0886",
    ask: "0.0887",
    last: "0.08865",
    constraints: {
      instrument: constraints.value.instrument,
      version: constraints.value.version,
      priceTickSize: constraints.value.priceTickSize.toString(),
      quantityStep: constraints.value.quantityStep.toString(),
      minQuantity: constraints.value.minQuantity.toString(),
      minNotional: constraints.value.minNotional?.toString(),
    },
    evidence: [evidence.value],
  });
  assert.equal(market.ok, true);
  if (!market.ok) throw new Error("fixture");
  return market.value;
}

class FakeVerificationPort implements ExchangeExecutionPort {
  readonly creates: string[] = [];
  readonly cancels: string[] = [];
  private readonly market = fixtureMarket();
  private readonly orders = new Map<
    string,
    {
      observation: ExchangeOrderObservation;
      fills: readonly ExchangeFillObservation[];
    }
  >();
  private position: { side: "long" | "short" | "flat"; quantity: DecimalValue };
  private orderSequence = 0;
  private readonly fillPassive: boolean;

  constructor({ dirty = false, fillPassive = false } = {}) {
    this.position = dirty
      ? { side: "long", quantity: decimal("1") }
      : { side: "flat", quantity: decimal("0") };
    this.fillPassive = fillPassive;
  }

  async readState() {
    const accountEvidence = this.market.evidence;
    const openOrders = [...this.orders.values()]
      .filter(
        ({ observation }) =>
          observation.status === "open" ||
          observation.status === "partially-filled",
      )
      .map(({ observation }) => observation);
    return {
      ok: true as const,
      value: {
        serverTime:
          "2026-09-21T10:00:00.000Z" as ExchangeReadState["serverTime"],
        market: this.market,
        account: {
          snapshotId: "account-verification",
          accountScope: "demo:fixture",
          scope,
          asOf: "2026-09-21T10:00:00.000Z" as ExchangeReadState["serverTime"],
          availableBalance: decimal("100"),
          positions: [
            {
              instrument: "DOGEUSDT",
              side: this.position.side,
              quantity: this.position.quantity,
            },
          ],
          ownedOrders: [],
          evidence: accountEvidence,
        },
        openOrders,
        accountReadiness: { status: "ready" as const },
      },
    };
  }

  async createOrder(request: ExchangeOrderRequest): Promise<{
    readonly ok: true;
    readonly value: ExchangeOrderAcknowledgement;
  }> {
    this.creates.push(request.clientOrderId);
    this.orderSequence += 1;
    const exchangeOrderId = `exchange-${this.orderSequence}`;
    const isCleanup = request.reduceOnly;
    const isPassive = request.timeInForce === "PostOnly";
    const quantity = request.intent.quantity;
    const fillNow = !isPassive || this.fillPassive;
    const fill: ExchangeFillObservation | undefined = fillNow
      ? {
          executionId: `execution-${this.orderSequence}`,
          exchangeOrderId,
          clientOrderId: request.clientOrderId,
          instrument: "DOGEUSDT",
          side: request.intent.side,
          quantity,
          price: request.intent.price,
          executedAt:
            "2026-09-21T10:00:00.000Z" as ExchangeFillObservation["executedAt"],
          source: "fake-demo",
        }
      : undefined;
    const status = isCleanup || fillNow ? "filled" : "open";
    const observation: ExchangeOrderObservation = {
      exchangeOrderId,
      clientOrderId: request.clientOrderId,
      instrument: "DOGEUSDT",
      side: request.intent.side,
      requestedQuantity: quantity,
      filledQuantity: fillNow ? quantity : decimal("0"),
      status,
      observedAt:
        "2026-09-21T10:00:00.000Z" as ExchangeOrderObservation["observedAt"],
      source: "fake-demo",
      averagePrice: request.intent.price,
    };
    this.orders.set(request.clientOrderId, {
      observation,
      fills: fill === undefined ? [] : [fill],
    });
    if (fillNow) {
      this.position = isCleanup
        ? { side: "flat", quantity: decimal("0") }
        : {
            side: request.intent.side === "buy" ? "long" : "short",
            quantity,
          };
    }
    return {
      ok: true,
      value: {
        clientOrderId: request.clientOrderId,
        exchangeOrderId,
        acknowledgedAt:
          "2026-09-21T10:00:00.000Z" as ExchangeOrderAcknowledgement["acknowledgedAt"],
        status: "accepted",
      },
    };
  }

  async observeOrder(request: ExchangeOrderLookup) {
    const found = this.orders.get(request.clientOrderId);
    if (found === undefined) {
      return {
        ok: false as const,
        error: {
          kind: "ambiguous" as const,
          message: "fake order not found",
          retry: "reconcile" as const,
          operation: "observe" as const,
          clientOrderId: request.clientOrderId,
        },
      };
    }
    return { ok: true as const, value: found.observation };
  }

  async listFills(request: ExchangeOrderLookup) {
    return {
      ok: true as const,
      value: this.orders.get(request.clientOrderId)?.fills ?? [],
    };
  }

  async cancelOrder(request: ExchangeOrderLookup) {
    this.cancels.push(request.clientOrderId);
    const found = this.orders.get(request.clientOrderId);
    if (found === undefined) {
      return {
        ok: false as const,
        error: {
          kind: "ownership" as const,
          message: "fake cancel identity not found",
          retry: "never" as const,
          operation: "cancel" as const,
          clientOrderId: request.clientOrderId,
        },
      };
    }
    this.orders.set(request.clientOrderId, {
      ...found,
      observation: { ...found.observation, status: "cancelled" },
    });
    return {
      ok: true as const,
      value: {
        clientOrderId: request.clientOrderId,
        exchangeOrderId: found.observation.exchangeOrderId,
        acknowledgedAt:
          "2026-09-21T10:00:00.000Z" as ExchangeOrderAcknowledgement["acknowledgedAt"],
        status: "accepted" as const,
      },
    };
  }
}

const clock = fixedClock("2026-09-21T10:00:00.000Z");
assert.equal(clock.ok, true);
if (!clock.ok) throw new Error("clock fixture");

test("verification harness proves fill, exact cleanup, passive open and exact cancel", async () => {
  const port = new FakeVerificationPort();
  const result = await runBybitDemoAdapterVerification({
    port,
    accountId: "fixture-account",
    symbol: "DOGEUSDT",
    runId: "run-1",
    clock: clock.value,
    sleep: async () => {},
    writeEvidence: false,
  });
  assert.equal(result.verdict, "CONFIRMED_CLEAN");
  assert.deepEqual(
    port.creates.map((id) => id.replace(/run-1-/u, "")),
    ["fill", "fill-cleanup", "passive"],
  );
  assert.deepEqual(port.cancels, ["run-1-passive"]);
  assert.equal(result.evidence.stages.at(-1)?.name, "final-clean-state");
});

test("dirty selected-symbol baseline blocks before the first write", async () => {
  const port = new FakeVerificationPort({ dirty: true });
  const result = await runBybitDemoAdapterVerification({
    port,
    accountId: "fixture-account",
    symbol: "DOGEUSDT",
    runId: "run-dirty",
    clock: clock.value,
    sleep: async () => {},
    writeEvidence: false,
  });
  assert.equal(result.verdict, "BLOCKED");
  assert.deepEqual(port.creates, []);
  assert.match(result.evidence.stages.at(-1)?.message ?? "", /not flat/iu);
});

test("passive fill race is cleaned only through the owned reduce-only path", async () => {
  const port = new FakeVerificationPort({ fillPassive: true });
  const result = await runBybitDemoAdapterVerification({
    port,
    accountId: "fixture-account",
    symbol: "DOGEUSDT",
    runId: "run-race",
    clock: clock.value,
    sleep: async () => {},
    writeEvidence: false,
  });
  assert.equal(result.verdict, "CONFIRMED_CLEAN");
  assert.ok(port.creates.includes("run-race-passive-cleanup"));
  assert.deepEqual(port.cancels, []);
});

test("unsafe run IDs are rejected before exchange access", async () => {
  const port = new FakeVerificationPort();
  await assert.rejects(
    runBybitDemoAdapterVerification({
      port,
      accountId: "fixture-account",
      symbol: "DOGEUSDT",
      runId: "../outside",
      clock: clock.value,
      writeEvidence: true,
    }),
    /runId must contain only safe filename characters/u,
  );
  assert.deepEqual(port.creates, []);
});
