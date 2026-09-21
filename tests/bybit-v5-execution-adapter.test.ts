import assert from "node:assert/strict";
import test from "node:test";

import { BybitDemoExecutionAdapter } from "../src/adapters/bybit-v5/execution-adapter.js";
import type { BybitResponse } from "../src/adapters/bybit-v5/transport.js";
import { createOrderIntent } from "../src/domain/planning/order-intent.js";
import { DecimalValue } from "../src/domain/shared/decimal.js";
import { fixedClock } from "../src/domain/shared/time.js";

function response(result: Record<string, unknown>): BybitResponse {
  return { retCode: 0, retMsg: "OK", result };
}

function baseResponse(path: string): BybitResponse {
  switch (path) {
    case "/v5/market/instruments-info":
      return response({
        list: [
          {
            symbol: "DOGEUSDT",
            status: "Trading",
            contractType: "LinearPerpetual",
            quoteCoin: "USDT",
            settleCoin: "USDT",
            priceFilter: { tickSize: "0.0001" },
            lotSizeFilter: {
              qtyStep: "1",
              minOrderQty: "1",
              minNotionalValue: "5",
            },
          },
        ],
      });
    case "/v5/market/tickers":
      return response({
        list: [
          {
            symbol: "DOGEUSDT",
            bid1Price: "0.0886",
            ask1Price: "0.0887",
            lastPrice: "0.08865",
          },
        ],
      });
    case "/v5/position/list":
      return response({
        list: [{ symbol: "DOGEUSDT", positionIdx: 0, side: "", size: "0" }],
      });
    case "/v5/account/wallet-balance":
      return response({
        list: [{ accountType: "UNIFIED", totalAvailableBalance: "100" }],
      });
    case "/v5/order/realtime":
    case "/v5/order/history":
    case "/v5/execution/list":
      return response({ list: [] });
    default:
      return response({});
  }
}

function orderRequest() {
  const price = DecimalValue.fromString("0.0887");
  const quantity = DecimalValue.fromString("57");
  const notional = DecimalValue.fromString("5.0559");
  const takeProfit = DecimalValue.fromString("0.1");
  assert.equal(price.ok, true);
  assert.equal(quantity.ok, true);
  assert.equal(notional.ok, true);
  assert.equal(takeProfit.ok, true);
  if (!price.ok || !quantity.ok || !notional.ok || !takeProfit.ok) {
    throw new Error("order fixture");
  }
  const intent = createOrderIntent({
    intentId: "intent-adapter",
    instrument: "DOGEUSDT",
    orderType: "limit",
    side: "buy",
    positionEffect: "open",
    price: price.value,
    quantity: quantity.value,
    notional: notional.value,
    normalization: {
      price: "floor",
      quantity: "floor",
      constraintVersion: "bybit-v5:DOGEUSDT:instrument",
    },
    protection: { takeProfit: takeProfit.value },
  });
  assert.equal(intent.ok, true);
  if (!intent.ok) throw new Error("order fixture");
  return {
    intent: intent.value,
    clientOrderId: "owned-client",
    timeInForce: "GTC" as const,
    reduceOnly: false,
  };
}

test("execution adapter exposes normalized snapshots and owned lifecycle evidence", async () => {
  const posts: Array<{ path: string; body: Record<string, unknown> | string }> =
    [];
  const clock = fixedClock("2026-09-21T10:00:00.000Z");
  assert.equal(clock.ok, true);
  if (!clock.ok) return;
  const adapter = new BybitDemoExecutionAdapter({
    accountId: "demo-account",
    clock: clock.value,
    transport: {
      async get(path) {
        return baseResponse(path);
      },
      async getServerTime() {
        return Date.parse("2026-09-21T10:00:00.000Z");
      },
      async post(path, body) {
        posts.push({ path, body });
        return response({ orderId: "exchange-1", orderLinkId: "owned-client" });
      },
    },
  });

  const state = await adapter.readState({ instrument: "DOGEUSDT" });
  assert.equal(state.ok, true);
  if (!state.ok) return;
  assert.equal(state.value.market.scope.environment, "demo");
  assert.equal(state.value.account.positions[0]?.side, "flat");
  assert.equal(state.value.account.evidence[0]?.kind, "account-snapshot");

  const created = await adapter.createOrder(orderRequest());
  assert.equal(created.ok, true);
  if (created.ok) {
    assert.equal(created.value.exchangeOrderId, "exchange-1");
    assert.equal(created.value.status, "accepted");
  }
  assert.equal(posts[0]?.path, "/v5/order/create");

  const observed = await adapter.observeOrder({
    instrument: "DOGEUSDT",
    clientOrderId: "owned-client",
    exchangeOrderId: "exchange-1",
  });
  assert.equal(observed.ok, false);
  if (!observed.ok) assert.equal(observed.error.kind, "ambiguous");
});
