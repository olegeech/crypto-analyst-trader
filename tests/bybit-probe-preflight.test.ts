import assert from "node:assert/strict";
import test from "node:test";

import {
  PreflightError,
  runReadOnlyPreflight,
} from "../scripts/bybit-probe/preflight.js";
import {
  compareDecimals,
  parseDecimal,
} from "../scripts/bybit-probe/decimal.js";
import {
  BybitProbeTransportError,
  type BybitResponse,
  type QueryInput,
} from "../scripts/bybit-probe/transport.js";

function response(result: Record<string, unknown>): BybitResponse {
  return { retCode: 0, retMsg: "OK", result };
}

function recordQuery(
  query: QueryInput | undefined,
): query is Record<string, string> {
  return (
    typeof query === "object" &&
    query !== null &&
    !Array.isArray(query) &&
    !(query instanceof URLSearchParams)
  );
}

function transportFor(overrides: Record<string, Record<string, unknown>> = {}) {
  const requests: string[] = [];
  const queries: Array<{ path: string; query: QueryInput | undefined }> = [];
  const transport = {
    async get(path: string, query?: QueryInput): Promise<BybitResponse> {
      requests.push(path);
      queries.push({ path, query });
      const result =
        overrides[path] ??
        {
          "/v5/market/instruments-info": {
            list: [
              {
                status: "Trading",
                priceFilter: { tickSize: "0.0001" },
                lotSizeFilter: {
                  qtyStep: "1",
                  minOrderQty: "1",
                  minNotionalValue: "5",
                },
              },
            ],
          },
          "/v5/market/tickers": {
            list: [{ bid1Price: "0.1000", ask1Price: "0.1001" }],
          },
          "/v5/position/list": {
            list: [{ symbol: "DOGEUSDT", side: "", size: "0", positionIdx: 0 }],
          },
          "/v5/order/realtime": { list: [] },
          "/v5/account/wallet-balance": {
            list: [{ totalAvailableBalance: "100" }],
          },
        }[path] ??
        {};
      return response(result);
    },
  };
  return { transport, requests, queries };
}

test("read-only preflight sizes DOGEUSDT within the exact notional cap", async () => {
  const { transport, requests } = transportFor();
  const result = await runReadOnlyPreflight({
    transport,
    symbol: "DOGEUSDT",
  });
  assert.equal(result.baseline.flat, true);
  assert.equal(result.baseline.openOrders, 0);
  assert.equal(result.sizes.Buy.qty, "51");
  assert.equal(result.sizes.Buy.notional, "5.0898");
  assert.ok(
    compareDecimals(
      parseDecimal(result.sizes.Sell.notional),
      parseDecimal("10"),
    ) <= 0,
  );
  assert.deepEqual(requests, [
    "/v5/market/instruments-info",
    "/v5/market/tickers",
    "/v5/position/list",
    "/v5/order/realtime",
    "/v5/account/wallet-balance",
  ]);
});

test("Demo preflight checks reconciliation reads before allowing a write", async () => {
  const { transport, requests, queries } = transportFor({
    "/v5/order/history": { list: [] },
    "/v5/execution/list": { list: [] },
  });
  const result = await runReadOnlyPreflight({
    transport,
    symbol: "DOGEUSDT",
    environment: "demo",
  });

  assert.equal(result.baseline.flat, true);
  const historyIndex = requests.indexOf("/v5/order/history");
  const executionIndex = requests.indexOf("/v5/execution/list");
  assert.ok(historyIndex >= 0);
  assert.equal(executionIndex, historyIndex + 1);
  assert.ok(executionIndex < requests.indexOf("/v5/account/wallet-balance"));
  for (const path of [
    "/v5/order/realtime",
    "/v5/order/history",
    "/v5/execution/list",
  ]) {
    const query = queries.find(
      (entry) =>
        entry.path === path &&
        recordQuery(entry.query) &&
        entry.query.orderLinkId === "capability-probe-no-match",
    )?.query;
    assert.ok(query && !Array.isArray(query));
    assert.equal(
      (query as Record<string, string>).orderLinkId,
      "capability-probe-no-match",
    );
  }
});

test("unsupported Demo reconciliation reads produce a limitation before writes", async () => {
  const { transport } = transportFor({
    "/v5/order/history": {},
  });
  const originalGet = transport.get;
  const limitedTransport = {
    async get(path: string) {
      if (path === "/v5/order/history") {
        throw new Error("unsupported Demo endpoint");
      }
      return originalGet(path);
    },
  };

  await assert.rejects(
    runReadOnlyPreflight({
      transport: limitedTransport,
      symbol: "DOGEUSDT",
      environment: "demo",
    }),
    (error: unknown) => {
      assert.ok(error instanceof PreflightError);
      assert.equal(error.kind, "invalid-response");
      assert.match(error.message, /Demo.*reconciliation/);
      assert.match(error.message, /no exchange write was attempted/);
      return true;
    },
  );
});

test("Demo preflight rejects reconciliation reads that ignore ownership filters", async () => {
  const { transport } = transportFor({
    "/v5/order/history": {
      list: [{ orderLinkId: "unrelated-order" }],
    },
  });

  await assert.rejects(
    runReadOnlyPreflight({
      transport,
      symbol: "DOGEUSDT",
      environment: "demo",
    }),
    (error: unknown) => {
      assert.ok(error instanceof PreflightError);
      assert.match(
        error.message,
        /did not honor the synthetic ownership filter/,
      );
      assert.match(error.message, /no exchange write was attempted/);
      return true;
    },
  );
});

test("Demo credential failures keep their setup guidance during capability reads", async () => {
  const { transport } = transportFor();
  const credentialFailure = new BybitProbeTransportError(
    "permission-denied",
    "The Demo credential lacks the required permission. Verify it with credentials:setup:demo.",
    { retCode: 10005, recommendReconnect: true },
  );
  const limitedTransport = {
    async get(path: string) {
      if (path === "/v5/order/history") throw credentialFailure;
      return transport.get(path);
    },
  };

  await assert.rejects(
    runReadOnlyPreflight({
      transport: limitedTransport,
      symbol: "DOGEUSDT",
      environment: "demo",
    }),
    (error: unknown) => {
      assert.equal(error, credentialFailure);
      assert.match((error as Error).message, /credentials:setup:demo/);
      return true;
    },
  );
});

test("minimum notional above 10 USDT fails before any write path", async () => {
  const { transport } = transportFor({
    "/v5/market/instruments-info": {
      list: [
        {
          status: "Trading",
          priceFilter: { tickSize: "0.01" },
          lotSizeFilter: {
            qtyStep: "1",
            minOrderQty: "1",
            minNotionalValue: "11",
          },
        },
      ],
    },
  });
  await assert.rejects(
    runReadOnlyPreflight({
      transport,
      symbol: "BTCUSDT",
    }),
    (error: unknown) =>
      error instanceof PreflightError && error.kind === "precondition-failed",
  );
});

test("PendingOpen, hedge mode, dirty baseline, and low balance are all hard stops", async () => {
  const cases = [
    {
      name: "PendingOpen",
      override: {
        "/v5/market/instruments-info": {
          list: [
            {
              status: "PendingOpen",
              priceFilter: { tickSize: "0.01" },
              lotSizeFilter: {
                qtyStep: "1",
                minOrderQty: "1",
                minNotionalValue: "5",
              },
            },
          ],
        },
      },
    },
    {
      name: "hedge",
      override: {
        "/v5/position/list": {
          list: [
            { symbol: "DOGEUSDT", side: "Buy", size: "0", positionIdx: 1 },
          ],
        },
      },
    },
    {
      name: "dirty order",
      override: {
        "/v5/order/realtime": {
          list: [{ symbol: "DOGEUSDT", orderId: "other-order" }],
        },
      },
    },
    {
      name: "low balance",
      override: {
        "/v5/account/wallet-balance": {
          list: [{ totalAvailableBalance: "1" }],
        },
      },
    },
  ];
  for (const item of cases) {
    const { transport } = transportFor(item.override);
    await assert.rejects(
      runReadOnlyPreflight({
        transport,
        symbol: "DOGEUSDT",
      }),
      (error: unknown) =>
        error instanceof PreflightError && error.kind === "precondition-failed",
      item.name,
    );
  }
});

test("low balance reports the exact requirement and actionable shortfall", async () => {
  const { transport } = transportFor({
    "/v5/account/wallet-balance": {
      list: [{ totalAvailableBalance: "1.250" }],
    },
  });

  await assert.rejects(
    runReadOnlyPreflight({
      transport,
      symbol: "DOGEUSDT",
    }),
    (error: unknown) => {
      assert.ok(error instanceof PreflightError);
      assert.equal(error.kind, "precondition-failed");
      assert.equal(
        error.message,
        "Available Testnet USDT is 1.25; at least 25.449 USDT is required (five times the planned probe notional). Add at least 24.199 USDT using the Bybit Testnet faucet, then rerun the probe.",
      );
      assert.equal(
        error.guidance,
        "Add at least 24.199 USDT using the Bybit Testnet faucet, then rerun the read-only preflight.",
      );
      return true;
    },
  );
});

test("preflight does not require an exclusive-use confirmation prompt", async () => {
  const { transport, requests } = transportFor();
  await runReadOnlyPreflight({ transport, symbol: "DOGEUSDT" });
  assert.ok(
    !requests.some(
      (path) => path.includes("switch") || path.includes("position-mode"),
    ),
  );
});
