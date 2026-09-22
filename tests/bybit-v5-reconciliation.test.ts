import assert from "node:assert/strict";
import test from "node:test";

import { BybitDemoReadClient } from "../src/adapters/bybit-v5/client.js";
import {
  listOwnedFills,
  reconcileOrder,
} from "../src/adapters/bybit-v5/reconciliation.js";
import type { BybitResponse } from "../src/adapters/bybit-v5/transport.js";

const observedAt = "2026-09-21T10:00:00.000Z" as never;
const lookup = {
  instrument: "DOGEUSDT",
  clientOrderId: "owned-client",
};

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
    avgPrice: "0",
    ...overrides,
  };
}

function execution(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    symbol: "DOGEUSDT",
    execId: "execution-1",
    orderId: "exchange-1",
    orderLinkId: "owned-client",
    side: "Buy",
    execQty: "12",
    execPrice: "0.0887",
    execFee: "0.0001",
    feeCurrency: "USDT",
    execTime: String(Date.parse("2026-09-21T09:59:59.000Z")),
    ...overrides,
  };
}

function makeClient(get: (path: string) => BybitResponse): BybitDemoReadClient {
  return new BybitDemoReadClient({
    transport: {
      async get(path) {
        return get(path);
      },
      async getServerTime() {
        return Date.parse("2026-09-21T10:00:00.000Z");
      },
    },
  });
}

test("reconciliation prefers realtime and normalizes terminal order state", async () => {
  const client = makeClient((path) =>
    path === "/v5/order/realtime"
      ? response({
          list: [
            order({
              orderStatus: "Filled",
              cumExecQty: "57",
              avgPrice: "0.0887",
            }),
          ],
        })
      : response({ list: [] }),
  );
  const result = await reconcileOrder(client, lookup, observedAt);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.status, "filled");
    assert.equal(result.value.filledQuantity.toString(), "57");
    assert.equal(result.value.source, "bybit-demo/realtime");
  }
});

test("history is terminal fallback and cancelled-with-fill remains executable evidence", async () => {
  const client = makeClient((path) =>
    path === "/v5/order/history"
      ? response({
          list: [order({ orderStatus: "Cancelled", cumExecQty: "12" })],
        })
      : response({ list: [] }),
  );
  const result = await reconcileOrder(client, lookup, observedAt);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.status, "cancelled");
    assert.equal(result.value.filledQuantity.toString(), "12");
    assert.equal(result.value.source, "bybit-demo/history");
  }
});

test("execution identity is deduplicated and retained outside the domain Fill attempt id", async () => {
  const client = makeClient((path) =>
    path === "/v5/execution/list"
      ? response({ list: [execution(), execution()] })
      : response({ list: [] }),
  );
  const result = await listOwnedFills(client, lookup);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.length, 1);
    assert.equal(result.value[0]?.executionId, "execution-1");
    assert.equal(result.value[0]?.feeCurrency, "USDT");
  }
});

test("missing order evidence and identity mismatches remain unresolved", async () => {
  const missing = await reconcileOrder(
    makeClient(() => response({ list: [] })),
    lookup,
    observedAt,
  );
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.error.kind, "ambiguous");
    assert.equal(missing.error.retry, "reconcile");
  }

  const foreign = await reconcileOrder(
    makeClient((path) =>
      path === "/v5/order/realtime"
        ? response({ list: [order({ orderLinkId: "foreign-client" })] })
        : response({ list: [] }),
    ),
    lookup,
    observedAt,
  );
  assert.equal(foreign.ok, false);
  if (!foreign.ok) assert.equal(foreign.error.kind, "ownership");
});

test("realtime ambiguity does not fall through to history", async () => {
  const client = makeClient((path) =>
    path === "/v5/order/realtime"
      ? response({
          list: [
            order({ orderStatus: "New", cumExecQty: "0" }),
            order({
              orderId: "exchange-2",
              orderStatus: "Filled",
              cumExecQty: "57",
            }),
          ],
        })
      : response({ list: [] }),
  );
  const result = await reconcileOrder(client, lookup, observedAt);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.kind, "ambiguous");
});

test("realtime, history and execution evidence must identify one consistent order", async () => {
  const contradictory = await reconcileOrder(
    makeClient((path) => {
      if (path === "/v5/order/realtime") {
        return response({
          list: [order({ orderStatus: "New", cumExecQty: "0" })],
        });
      }
      if (path === "/v5/order/history") {
        return response({
          list: [order({ orderStatus: "Filled", cumExecQty: "57" })],
        });
      }
      return response({ list: [] });
    }),
    lookup,
    observedAt,
  );
  assert.equal(contradictory.ok, false);
  if (!contradictory.ok) assert.equal(contradictory.error.kind, "ambiguous");

  const mismatchedExecution = await reconcileOrder(
    makeClient((path) => {
      if (path === "/v5/order/realtime") {
        return response({ list: [order()] });
      }
      if (path === "/v5/execution/list") {
        return response({
          list: [execution({ orderId: "different-exchange-order" })],
        });
      }
      return response({ list: [] });
    }),
    lookup,
    observedAt,
  );
  assert.equal(mismatchedExecution.ok, false);
  if (!mismatchedExecution.ok)
    assert.equal(mismatchedExecution.error.kind, "ambiguous");
});
