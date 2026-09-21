import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { ExchangeOrderObservation } from "../src/domain/execution/exchange-order.js";
import { DecimalValue } from "../src/domain/shared/decimal.js";
import { parseUtcTimestamp } from "../src/domain/shared/time.js";
import type {
  ExchangeExecutionPort,
  ExchangeFillObservation,
  ExchangeOrderAcknowledgement,
  ExchangeReadState,
} from "../src/ports/exchange-execution.js";
import {
  exchangeFailure,
  exchangeSuccess,
} from "../src/ports/exchange-execution.js";

const timestampResult = parseUtcTimestamp("2026-09-21T10:00:00.000Z");
assert.equal(timestampResult.ok, true);
const timestamp: ExchangeReadState["serverTime"] = timestampResult.value;

function decimal(value: string): DecimalValue {
  const result = DecimalValue.fromString(value);
  assert.equal(result.ok, true);
  return result.value;
}

test("exchange port represents acknowledgement, observation and fill evidence separately", async () => {
  const acknowledgement: ExchangeOrderAcknowledgement = {
    clientOrderId: "owned-client",
    exchangeOrderId: "exchange-1",
    acknowledgedAt: timestamp,
    status: "accepted",
  };
  const observation: ExchangeOrderObservation = {
    exchangeOrderId: "exchange-1",
    clientOrderId: "owned-client",
    instrument: "DOGEUSDT",
    side: "buy",
    requestedQuantity: decimal("57"),
    filledQuantity: decimal("57"),
    status: "filled",
    observedAt: timestamp,
    source: "demo-realtime",
  };
  const fill: ExchangeFillObservation = {
    executionId: "execution-1",
    exchangeOrderId: "exchange-1",
    clientOrderId: "owned-client",
    instrument: "DOGEUSDT",
    side: "buy",
    quantity: decimal("57"),
    price: decimal("0.0887"),
    executedAt: timestamp,
    source: "demo-execution",
    fee: decimal("0.0001"),
    feeCurrency: "USDT",
  };

  const port: ExchangeExecutionPort = {
    async readState() {
      return exchangeFailure({
        kind: "precondition",
        message: "fixture does not implement account reads",
        retry: "never",
        operation: "read",
      });
    },
    async createOrder() {
      return exchangeSuccess(acknowledgement);
    },
    async observeOrder() {
      return exchangeSuccess(observation);
    },
    async listFills() {
      return exchangeSuccess([fill]);
    },
    async cancelOrder() {
      return exchangeSuccess({
        clientOrderId: "owned-cleanup",
        exchangeOrderId: "exchange-cleanup",
        acknowledgedAt: timestamp,
        status: "pending",
      });
    },
  };

  const created = await port.createOrder({} as never);
  const observed = await port.observeOrder({} as never);
  const fills = await port.listFills({} as never);
  const read = await port.readState({ instrument: "DOGEUSDT" });

  assert.equal(created.ok, true);
  assert.equal(created.ok && created.value.exchangeOrderId, "exchange-1");
  assert.equal(observed.ok && observed.value.status, "filled");
  assert.equal(fills.ok && fills.value[0]?.executionId, "execution-1");
  assert.equal(read.ok, false);
  assert.equal(!read.ok && read.error.kind, "precondition");
});

test("cancelled observations can retain executed quantity without collapsing into a clean cancel", () => {
  const cancelledWithFill: ExchangeOrderObservation = {
    exchangeOrderId: "exchange-2",
    clientOrderId: "owned-passive",
    instrument: "DOGEUSDT",
    side: "sell",
    requestedQuantity: decimal("57"),
    filledQuantity: decimal("12"),
    status: "cancelled",
    observedAt: timestamp,
    source: "demo-history",
  };

  assert.equal(cancelledWithFill.status, "cancelled");
  assert.equal(cancelledWithFill.filledQuantity.toString(), "12");
});

test("the public port has no adapter, persistence or secret-bearing imports", async () => {
  const source = await readFile("src/ports/exchange-execution.ts", "utf8");
  const imports = source
    .split("\n")
    .filter((line) => /^(?:import|\s*\} from)/u.test(line))
    .join("\n");
  assert.doesNotMatch(imports, /bybit|sqlite|persistence|secret|signature|header/iu);
  assert.doesNotMatch(imports, /node:/u);
});
