import assert from "node:assert/strict";
import test from "node:test";

import { createOrderIntent } from "../src/domain/planning/order-intent.js";
import { DecimalValue } from "../src/domain/shared/decimal.js";
import { parseUtcTimestamp } from "../src/domain/shared/time.js";
import type {
  ExchangeOrderRequest,
  ExchangeTimeInForce,
} from "../src/ports/exchange-execution.js";
import type { BybitResponse } from "../src/adapters/bybit-v5/transport.js";
import {
  BybitOrderMappingError,
  mapCancelOrderRequest,
  mapCreateOrderRequest,
  mapOrderAcknowledgement,
} from "../src/adapters/bybit-v5/order-mappers.js";

function decimal(value: string): DecimalValue {
  const result = DecimalValue.fromString(value);
  assert.equal(result.ok, true);
  return result.value;
}

function timestamp() {
  const result = parseUtcTimestamp("2026-09-21T10:00:00.000Z");
  assert.equal(result.ok, true);
  return result.value;
}

function request(
  side: "buy" | "sell" = "buy",
  options: {
    clientOrderId?: string;
    timeInForce?: ExchangeTimeInForce;
    reduceOnly?: boolean;
    protection?: { takeProfit?: string; stopLoss?: string };
    positionEffect?: "open" | "close";
  } = {},
): ExchangeOrderRequest {
  const intentInput = {
    intentId: "intent-mapping",
    instrument: "DOGEUSDT",
    orderType: "limit" as const,
    side,
    positionEffect: options.positionEffect ?? "open",
    price: decimal(side === "buy" ? "0.0887" : "0.0887"),
    quantity: decimal("57"),
    notional: decimal("5.0559"),
    normalization: {
      price: "floor" as const,
      quantity: "floor" as const,
      constraintVersion: "bybit-v5:DOGEUSDT:instrument",
    },
    ...(options.protection === undefined
      ? {}
      : {
          protection: {
            ...(options.protection.takeProfit === undefined
              ? {}
              : { takeProfit: decimal(options.protection.takeProfit) }),
            ...(options.protection.stopLoss === undefined
              ? {}
              : { stopLoss: decimal(options.protection.stopLoss) }),
          },
        }),
  };
  const intent = createOrderIntent(intentInput);
  assert.equal(intent.ok, true);
  if (!intent.ok) throw new Error("invalid order fixture");
  return {
    intent: intent.value,
    clientOrderId: options.clientOrderId ?? "run-1-long",
    timeInForce: options.timeInForce ?? "GTC",
    reduceOnly: options.reduceOnly ?? false,
  };
}

function response(result: Record<string, unknown>): BybitResponse {
  return { retCode: 0, retMsg: "OK", result };
}

test("create mapping preserves caller identity and exact TP-only protection", () => {
  const mapped = mapCreateOrderRequest(
    request("buy", { protection: { takeProfit: "0.1" } }),
  );
  assert.deepEqual(mapped, {
    category: "linear",
    symbol: "DOGEUSDT",
    side: "Buy",
    orderType: "Limit",
    qty: "57",
    price: "0.0887",
    timeInForce: "GTC",
    positionIdx: 0,
    orderLinkId: "run-1-long",
    reduceOnly: false,
    takeProfit: "0.1",
    tpslMode: "Full",
  });
});

test("cleanup mapping is reduce-only IOC and cannot carry attached exits", () => {
  const mapped = mapCreateOrderRequest(
    request("sell", {
      clientOrderId: "run-1-cleanup",
      timeInForce: "IOC",
      reduceOnly: true,
      positionEffect: "close",
    }),
  );
  assert.equal(mapped.orderLinkId, "run-1-cleanup");
  assert.equal(mapped.timeInForce, "IOC");
  assert.equal(mapped.positionIdx, 0);
  assert.equal(mapped.reduceOnly, true);
  assert.equal(mapped.takeProfit, undefined);
  assert.equal(mapped.stopLoss, undefined);

  assert.deepEqual(
    mapCancelOrderRequest({
      instrument: "DOGEUSDT",
      clientOrderId: "run-1-cleanup",
      exchangeOrderId: "exchange-cleanup",
    }),
    {
      category: "linear",
      symbol: "DOGEUSDT",
      orderLinkId: "run-1-cleanup",
      orderId: "exchange-cleanup",
    },
  );
});

test("mapping rejects mutated identities, wrong-side exits and protection on cleanup", () => {
  assert.throws(
    () => mapCreateOrderRequest(request("buy", { clientOrderId: "bad:id" })),
    (error: unknown) =>
      error instanceof BybitOrderMappingError &&
      error.kind === "invalid-request",
  );
  assert.throws(
    () =>
      mapCreateOrderRequest(
        request("buy", { protection: { takeProfit: "0.08" } }),
      ),
    BybitOrderMappingError,
  );
  assert.throws(
    () =>
      mapCreateOrderRequest(
        request("sell", {
          reduceOnly: true,
          positionEffect: "close",
          protection: { stopLoss: "0.09" },
        }),
      ),
    BybitOrderMappingError,
  );
});

test("acknowledgement mapping separates accepted, pending and identity conflict", () => {
  const accepted = mapOrderAcknowledgement(
    response({ orderId: "exchange-1", orderLinkId: "run-1-long" }),
    "run-1-long",
    timestamp(),
  );
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.exchangeOrderId, "exchange-1");

  const pending = mapOrderAcknowledgement(
    response({}),
    "run-1-long",
    timestamp(),
  );
  assert.equal(pending.status, "pending");
  assert.equal(pending.exchangeOrderId, undefined);

  assert.throws(
    () =>
      mapOrderAcknowledgement(
        response({ orderId: "exchange-1", orderLinkId: "foreign" }),
        "run-1-long",
        timestamp(),
      ),
    (error: unknown) =>
      error instanceof BybitOrderMappingError && error.kind === "precondition",
  );
});
