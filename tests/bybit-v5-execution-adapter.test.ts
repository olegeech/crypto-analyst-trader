import assert from "node:assert/strict";
import test from "node:test";

import {
  BybitDemoExecutionAdapter,
  BybitMainnetExecutionAdapter,
} from "../src/adapters/bybit-v5/execution-adapter.js";
import {
  BYBIT_MAINNET_ORIGIN,
  createBybitPrivateTransport,
  type BybitResponse,
} from "../src/adapters/bybit-v5/transport.js";
import { BYBIT_MAINNET_CAPABILITY_PROFILE } from "../src/adapters/bybit-v5/capability-profile.js";
import { requireCapability } from "../src/domain/capabilities/capability.js";
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
    case "/v5/user/query-api":
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
  assert.equal(state.value.leverage.effective.toString(), "1");
  assert.equal(state.value.accountMetadata.accountId, "demo-account");
  assert.equal(state.value.account.accountScope, "demo-account");
  assert.deepEqual(
    state.value.capabilities.map((item) => item.capability),
    [
      "order-create",
      "attached-protection",
      "reconciliation-reads",
      "set-leverage",
    ],
  );

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

const mainnetCredentials = {
  apiKey: "synthetic-mainnet-key",
  apiSecret: "synthetic-mainnet-secret",
  accountId: "synthetic-mainnet-account",
};
const mainnetObservedAt = "2026-10-07T12:00:00.000Z" as const;

function mainnetOrder(
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
    avgPrice: "0",
    ...overrides,
  };
}

function mainnetFixture(
  options: {
    readonly ambiguousCreate?: boolean;
    readonly mismatchedAcknowledgement?: boolean;
    readonly mismatchedOrderSymbol?: boolean;
  } = {},
) {
  const calls: Array<{
    readonly url: string;
    readonly method: string;
    readonly body?: string;
  }> = [];
  let leverage = "1";
  let includeFill = false;
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({
      url: url.toString(),
      method,
      ...(body === undefined ? {} : { body }),
    });

    if (method === "POST") {
      const requestBody =
        body === undefined ? {} : (JSON.parse(body) as Record<string, unknown>);
      if (url.pathname === "/v5/order/create" && options.ambiguousCreate) {
        return new Response(
          JSON.stringify({
            retCode: 10000,
            retMsg: "private exchange details",
            result: {},
          }),
          { status: 200 },
        );
      }
      if (url.pathname === "/v5/position/set-leverage") {
        leverage = String(requestBody.buyLeverage);
      }
      return new Response(
        JSON.stringify({
          retCode: 0,
          retMsg: "OK",
          result: {
            orderId: "exchange-1",
            orderLinkId: options.mismatchedAcknowledgement
              ? "foreign-client"
              : "owned-client",
          },
        }),
        { status: 200 },
      );
    }

    const query = url.searchParams;
    let result: Record<string, unknown>;
    switch (url.pathname) {
      case "/v5/market/time":
        result = { timeSecond: String(Date.parse(mainnetObservedAt) / 1000) };
        break;
      case "/v5/market/instruments-info":
        result = {
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
        };
        break;
      case "/v5/market/tickers":
        result = {
          list: [
            {
              symbol: "DOGEUSDT",
              bid1Price: "0.0886",
              ask1Price: "0.0887",
              lastPrice: "0.08865",
            },
          ],
        };
        break;
      case "/v5/position/list":
        result = {
          list: [
            {
              symbol: "DOGEUSDT",
              positionIdx: 0,
              side: "",
              size: "0",
              leverage,
            },
          ],
        };
        break;
      case "/v5/order/realtime":
        if (query.has("orderLinkId")) {
          result = {
            list: [
              mainnetOrder({
                symbol: options.mismatchedOrderSymbol ? "ETHUSDT" : "DOGEUSDT",
              }),
            ],
          };
        } else {
          result = { list: [] };
        }
        break;
      case "/v5/order/history":
        result = query.has("orderLinkId")
          ? { list: [] }
          : {
              list: [
                mainnetOrder({
                  orderId: "protection-1",
                  orderLinkId: "protection-client",
                  parentOrderLinkId: "owned-client",
                  stopOrderType: "TakeProfit",
                }),
              ],
            };
        break;
      case "/v5/execution/list":
        result = {
          list: includeFill
            ? [
                {
                  symbol: "DOGEUSDT",
                  execId: "execution-1",
                  orderId: "exchange-1",
                  orderLinkId: "owned-client",
                  side: "Buy",
                  execQty: "2",
                  execPrice: "0.0887",
                  execFee: "0.0001",
                  feeCurrency: "USDT",
                  execTime: String(Date.parse(mainnetObservedAt)),
                },
              ]
            : [],
        };
        break;
      default:
        throw new Error(`Unexpected fixture path: ${url.pathname}`);
    }
    return new Response(JSON.stringify({ retCode: 0, retMsg: "OK", result }), {
      status: 200,
    });
  };
  const transport = createBybitPrivateTransport({
    environment: "mainnet",
    credentials: mainnetCredentials,
    request,
    clock: () => Date.parse(mainnetObservedAt),
    clockOffsetMs: 0,
  });
  const clock = fixedClock(mainnetObservedAt);
  assert.equal(clock.ok, true);
  if (!clock.ok) throw new Error("Mainnet fixture clock");
  const adapter = new BybitMainnetExecutionAdapter({
    transport,
    clock: clock.value,
  });
  return {
    adapter,
    calls,
    includeFill: (value: boolean) => {
      includeFill = value;
    },
    transport,
  };
}

test("Mainnet adapter exposes sanitized symbol state and all supported single operations", async () => {
  const fixture = mainnetFixture();
  const state = await fixture.adapter.readState({ instrument: "DOGEUSDT" });
  assert.equal(state.ok, true);
  if (!state.ok) return;
  assert.equal(state.value.market.scope.environment, "mainnet");
  assert.equal(state.value.position.side, "flat");
  assert.equal(state.value.position.quantity.toString(), "0");
  assert.equal(state.value.leverage.effective.toString(), "1");
  assert.equal("account" in state.value, false);
  assert.equal("accountMetadata" in state.value, false);
  assert.equal("accountScope" in state.value, false);
  assert.equal(
    JSON.stringify(state.value).includes("synthetic-mainnet-account"),
    false,
  );
  assert.equal(JSON.stringify(state.value).includes("127.0.0.1"), false);
  assert.equal(
    fixture.calls.some(
      (call) => new URL(call.url).pathname === "/v5/user/query-api",
    ),
    false,
  );
  assert.equal(
    fixture.calls.some(
      (call) => new URL(call.url).pathname === "/v5/account/wallet-balance",
    ),
    false,
  );
  assert.ok(
    fixture.calls.every(
      (call) => new URL(call.url).origin === BYBIT_MAINNET_ORIGIN,
    ),
  );

  const capabilities = state.value.capabilities;
  const cancel = capabilities.find(
    (item) => item.capability === "cancel-order",
  );
  assert.ok(cancel);
  assert.equal(cancel.status, "supported");
  assert.equal(cancel.scope.environment, "mainnet");
  assert.equal("liveProven" in cancel, false);
  assert.equal(
    BYBIT_MAINNET_CAPABILITY_PROFILE.version,
    "bybit-mainnet-capability-profile/v1",
  );
  const wrongScope = requireCapability(cancel, {
    capability: "cancel-order",
    scope: { ...cancel.scope, environment: "demo" },
  });
  assert.equal(wrongScope.ok, false);

  const created = await fixture.adapter.createOrder(orderRequest());
  assert.equal(created.ok, true);
  if (created.ok) assert.equal(created.value.exchangeOrderId, "exchange-1");

  const observed = await fixture.adapter.observeOrder({
    instrument: "DOGEUSDT",
    clientOrderId: "owned-client",
    exchangeOrderId: "exchange-1",
  });
  assert.equal(observed.ok, true);
  if (observed.ok)
    assert.equal(observed.value.source, "bybit-mainnet/realtime");

  fixture.includeFill(true);
  const fills = await fixture.adapter.listFills({
    instrument: "DOGEUSDT",
    clientOrderId: "owned-client",
  });
  assert.equal(fills.ok, true);
  if (fills.ok) {
    assert.equal(fills.value.length, 1);
    assert.equal(fills.value[0]?.source, "bybit-mainnet/execution");
  }

  const protection = await fixture.adapter.listAttachedProtection({
    instrument: "DOGEUSDT",
    parentClientOrderId: "owned-client",
  });
  assert.equal(protection.ok, true);
  if (protection.ok) {
    assert.equal(protection.value.length, 1);
    assert.equal(protection.value[0]?.protectionType, "take-profit");
    assert.equal(protection.value[0]?.source, "bybit-mainnet/protection");
  }

  const target = DecimalValue.fromString("2");
  assert.equal(target.ok, true);
  if (!target.ok) return;
  const leverage = await fixture.adapter.setLeverage({
    instrument: "DOGEUSDT",
    target: target.value,
  });
  assert.equal(leverage.ok, true);
  if (leverage.ok)
    assert.equal(leverage.value.effective.effective.toString(), "2");

  const cancelled = await fixture.adapter.cancelOrder({
    instrument: "DOGEUSDT",
    clientOrderId: "owned-client",
    exchangeOrderId: "exchange-1",
  });
  assert.equal(cancelled.ok, true);
  assert.deepEqual(
    fixture.calls
      .filter((call) => call.method === "POST")
      .map((call) => new URL(call.url).pathname),
    ["/v5/order/create", "/v5/position/set-leverage", "/v5/order/cancel"],
  );
});

test("Mainnet adapter refuses a Demo-scoped transport before any request", () => {
  const demoTransport = createBybitPrivateTransport({
    environment: "demo",
    credentials: mainnetCredentials,
    request: async () => {
      throw new Error("should not dispatch");
    },
  });
  assert.throws(
    () =>
      new BybitMainnetExecutionAdapter({ transport: demoTransport as never }),
    /canonical Mainnet/u,
  );
});

test("Mainnet adapter fails closed on identity mismatch and classifies ambiguity without a second create", async () => {
  const mismatchedAck = mainnetFixture({ mismatchedAcknowledgement: true });
  const rejected = await mismatchedAck.adapter.createOrder(orderRequest());
  assert.equal(rejected.ok, false);
  if (!rejected.ok) {
    assert.equal(rejected.error.kind, "precondition");
    assert.match(rejected.error.message, /Mainnet/u);
    assert.doesNotMatch(rejected.error.message, /Demo/u);
  }
  assert.equal(
    mismatchedAck.calls.filter(
      (call) => new URL(call.url).pathname === "/v5/order/create",
    ).length,
    1,
  );

  const ambiguous = mainnetFixture({ ambiguousCreate: true });
  const result = await ambiguous.adapter.createOrder(orderRequest());
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, "ambiguous");
    assert.equal(result.error.retry, "reconcile");
    assert.match(result.error.message, /Mainnet/u);
    assert.doesNotMatch(result.error.message, /Demo/u);
  }
  assert.equal(
    ambiguous.calls.filter(
      (call) => new URL(call.url).pathname === "/v5/order/create",
    ).length,
    1,
  );
});

test("Mainnet reconciliation rejects a selected-symbol identity mismatch", async () => {
  const fixture = mainnetFixture({ mismatchedOrderSymbol: true });
  const result = await fixture.adapter.observeOrder({
    instrument: "DOGEUSDT",
    clientOrderId: "owned-client",
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, "invalid-response");
    assert.doesNotMatch(result.error.message, /Demo/u);
  }
});
