import assert from "node:assert/strict";
import test from "node:test";

import {
  BybitDemoReadClient,
  BybitDemoExecutionClient,
  ORDER_HISTORY_PATH,
  ORDER_REALTIME_PATH,
  EXECUTION_LIST_PATH,
  SET_LEVERAGE_PATH,
  USER_QUERY_API_PATH,
} from "../src/adapters/bybit-v5/client.js";
import { createOrderIntent } from "../src/domain/planning/order-intent.js";
import { DecimalValue } from "../src/domain/shared/decimal.js";
import { fixedClock } from "../src/domain/shared/time.js";
import type {
  BybitResponse,
  QueryInput,
} from "../src/adapters/bybit-v5/transport.js";
import { BybitReadMappingError } from "../src/adapters/bybit-v5/read-mappers.js";

function response(result: Record<string, unknown>): BybitResponse {
  return { retCode: 0, retMsg: "OK", result };
}

function order(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    symbol: "DOGEUSDT",
    orderId: "exchange-1",
    orderLinkId: "owned-client",
    side: "Buy",
    qty: "57",
    cumExecQty: "0",
    orderStatus: "New",
    positionIdx: 0,
    reduceOnly: false,
    price: "0.0887",
    ...overrides,
  };
}

function defaultResponse(path: string): BybitResponse {
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
        list: [
          {
            symbol: "DOGEUSDT",
            positionIdx: 0,
            side: "",
            size: "0",
            leverage: "1",
          },
        ],
      });
    case USER_QUERY_API_PATH:
      return response({
        userID: "demo-account",
        readOnly: 0,
        permissions: {
          ContractTrade: ["Order", "Position"],
          Wallet: [],
        },
        ips: ["127.0.0.1"],
      });
    case "/v5/account/wallet-balance":
      return response({
        list: [{ accountType: "UNIFIED", totalAvailableBalance: "100" }],
      });
    case ORDER_REALTIME_PATH:
    case ORDER_HISTORY_PATH:
    case EXECUTION_LIST_PATH:
      return response({ list: [] });
    default:
      return response({});
  }
}

function makeClient(
  overrides: (path: string, query: QueryInput | undefined) => BybitResponse = (
    path,
  ) => defaultResponse(path),
) {
  const requests: Array<{ path: string; query: QueryInput | undefined }> = [];
  const client = new BybitDemoReadClient({
    expectedAccountId: "demo-account",
    transport: {
      async get(path, query) {
        requests.push({ path, query });
        return overrides(path, query);
      },
      async getServerTime() {
        return Date.parse("2026-09-21T10:00:00.000Z");
      },
    },
  });
  return { client, requests };
}

test("read client exhausts active-order pagination and preserves exact query filters", async () => {
  const { client, requests } = makeClient((path, query) => {
    if (path === ORDER_REALTIME_PATH) {
      const cursor =
        typeof query === "object" &&
        query !== null &&
        !Array.isArray(query) &&
        !(query instanceof URLSearchParams)
          ? (query as Record<string, string>).cursor
          : undefined;
      return cursor === undefined
        ? response({ list: [order()], nextPageCursor: "next-1" })
        : response({
            list: [
              order({ orderId: "exchange-2", orderLinkId: "owned-client-2" }),
            ],
          });
    }
    return defaultResponse(path);
  });

  const orders = await client.readOpenOrders("DOGEUSDT");
  assert.equal(orders.length, 2);
  assert.equal(requests[0]?.path, ORDER_REALTIME_PATH);
  assert.equal(requests[1]?.path, ORDER_REALTIME_PATH);
  assert.equal(
    typeof requests[1]?.query === "object" &&
      requests[1]?.query !== null &&
      !Array.isArray(requests[1]?.query)
      ? (requests[1]?.query as Record<string, string>).cursor
      : undefined,
    "next-1",
  );
});

test("Demo preflight proves ownership-filtered reconciliation reads before exposing a write boundary", async () => {
  const { client, requests } = makeClient();
  const result = await client.readPreflight("DOGEUSDT", "synthetic-no-match");
  assert.equal(result.position.side, "flat");
  assert.equal(result.position.leverage.toString(), "1");
  assert.equal(result.accountKey.userId, "demo-account");
  assert.equal(result.openOrders.length, 0);
  assert.deepEqual(result.reconciliationReads, {
    realtime: true,
    history: true,
    executions: true,
  });
  assert.deepEqual(
    requests.map((request) => request.path),
    [
      USER_QUERY_API_PATH,
      "/v5/market/instruments-info",
      "/v5/market/tickers",
      "/v5/position/list",
      ORDER_REALTIME_PATH,
      ORDER_REALTIME_PATH,
      ORDER_HISTORY_PATH,
      EXECUTION_LIST_PATH,
      "/v5/account/wallet-balance",
    ],
  );
});

test("preflight rejects ignored ownership filters", async () => {
  const { client } = makeClient((path) => {
    if (path === ORDER_HISTORY_PATH) {
      return response({ list: [order({ orderLinkId: "foreign-client" })] });
    }
    return defaultResponse(path);
  });
  await assert.rejects(
    client.readPreflight("DOGEUSDT", "synthetic-no-match"),
    (error: unknown) =>
      error instanceof BybitReadMappingError &&
      error.kind === "invalid-response" &&
      /ownership filter/u.test(error.message),
  );
});

test("execution client dispatches mapped create and exact cancel requests", async () => {
  const requests: Array<{
    path: string;
    body: Record<string, unknown> | string;
  }> = [];
  const price = DecimalValue.fromString("0.0887");
  const quantity = DecimalValue.fromString("57");
  const notional = DecimalValue.fromString("5.0559");
  const takeProfit = DecimalValue.fromString("0.1");
  assert.equal(price.ok, true);
  assert.equal(quantity.ok, true);
  assert.equal(notional.ok, true);
  assert.equal(takeProfit.ok, true);
  if (!price.ok || !quantity.ok || !notional.ok || !takeProfit.ok) return;
  const intent = createOrderIntent({
    intentId: "intent-client",
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
  const clock = fixedClock("2026-09-21T10:00:00.000Z");
  assert.equal(clock.ok, true);
  if (!intent.ok || !clock.ok) return;
  const client = new BybitDemoExecutionClient({
    expectedAccountId: "demo-account",
    clock: clock.value,
    transport: {
      async get(path) {
        return defaultResponse(path);
      },
      async getServerTime() {
        return Date.parse("2026-09-21T10:00:00.000Z");
      },
      async post(path, body) {
        requests.push({ path, body });
        return response({
          orderId:
            path === "/v5/order/create" ? "exchange-1" : "exchange-cleanup",
          orderLinkId:
            path === "/v5/order/create" ? "client-create" : "client-cleanup",
        });
      },
    },
  });
  const created = await client.createOrder({
    intent: intent.value,
    clientOrderId: "client-create",
    timeInForce: "GTC",
    reduceOnly: false,
  });
  const cancelled = await client.cancelOrder({
    instrument: "DOGEUSDT",
    clientOrderId: "client-cleanup",
    exchangeOrderId: "exchange-cleanup",
  });
  assert.equal(created.status, "accepted");
  assert.equal(cancelled.status, "accepted");
  assert.equal(requests[0]?.path, "/v5/order/create");
  assert.equal(requests[1]?.path, "/v5/order/cancel");
  assert.equal(
    (requests[0]?.body as Record<string, unknown>).orderLinkId,
    "client-create",
  );
  assert.equal(
    (requests[1]?.body as Record<string, unknown>).orderLinkId,
    "client-cleanup",
  );
  assert.equal(
    (requests[1]?.body as Record<string, unknown>).orderId,
    "exchange-cleanup",
  );
});

test("execution client posts equal Demo leverage values and proves the fresh readback", async () => {
  const requests: Array<{
    path: string;
    body: Record<string, unknown> | string;
  }> = [];
  const clock = fixedClock("2026-09-21T10:00:00.000Z");
  assert.equal(clock.ok, true);
  if (!clock.ok) return;
  const client = new BybitDemoExecutionClient({
    expectedAccountId: "demo-account",
    clock: clock.value,
    transport: {
      async get(path) {
        return defaultResponse(path);
      },
      async getServerTime() {
        return Date.parse("2026-09-21T10:00:00.000Z");
      },
      async post(path, body) {
        requests.push({ path, body });
        return response({});
      },
    },
  });

  const result = await client.setLeverage({
    instrument: "DOGEUSDT",
    target: decimalValue("1"),
  });
  assert.equal(result.effective.buy.toString(), "1");
  assert.equal(result.effective.sell.toString(), "1");
  assert.equal(requests[0]?.path, SET_LEVERAGE_PATH);
  assert.deepEqual(requests[0]?.body, {
    category: "linear",
    symbol: "DOGEUSDT",
    buyLeverage: "1",
    sellLeverage: "1",
  });
});

function decimalValue(value: string): DecimalValue {
  const result = DecimalValue.fromString(value);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("decimal fixture");
  return result.value;
}
