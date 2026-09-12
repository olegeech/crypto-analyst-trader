import assert from "node:assert/strict";
import test from "node:test";

import {
  PreflightError,
  runReadOnlyPreflight,
} from "../scripts/bybit-probe/preflight.js";
import { compareDecimals, parseDecimal } from "../scripts/bybit-probe/decimal.js";
import type { BybitResponse } from "../scripts/bybit-probe/transport.js";

function response(result: Record<string, unknown>): BybitResponse {
  return { retCode: 0, retMsg: "OK", result };
}

function transportFor(overrides: Record<string, Record<string, unknown>> = {}) {
  const requests: string[] = [];
  const transport = {
    async get(path: string): Promise<BybitResponse> {
      requests.push(path);
      const result = overrides[path] ?? {
        "/v5/market/instruments-info": {
          list: [
            {
              status: "Trading",
              priceFilter: { tickSize: "0.0001" },
              lotSizeFilter: { qtyStep: "1", minOrderQty: "1", minNotionalValue: "5" },
            },
          ],
        },
        "/v5/market/tickers": { list: [{ bid1Price: "0.1000", ask1Price: "0.1001" }] },
        "/v5/position/list": { list: [{ symbol: "DOGEUSDT", side: "", size: "0", positionIdx: 0 }] },
        "/v5/order/realtime": { list: [] },
        "/v5/account/wallet-balance": { list: [{ totalAvailableBalance: "100" }] },
      }[path] ?? {};
      return response(result);
    },
  };
  return { transport, requests };
}

test("read-only preflight sizes DOGEUSDT within the exact notional cap", async () => {
  const { transport, requests } = transportFor();
  const result = await runReadOnlyPreflight({
    transport,
    symbol: "DOGEUSDT",
    confirmExclusiveUse: async () => true,
  });
  assert.equal(result.baseline.flat, true);
  assert.equal(result.baseline.openOrders, 0);
  assert.equal(result.sizes.Buy.qty, "51");
  assert.equal(result.sizes.Buy.notional, "5.0898");
  assert.ok(compareDecimals(parseDecimal(result.sizes.Sell.notional), parseDecimal("10")) <= 0);
  assert.deepEqual(requests, [
    "/v5/market/instruments-info",
    "/v5/market/tickers",
    "/v5/position/list",
    "/v5/order/realtime",
    "/v5/account/wallet-balance",
  ]);
});

test("minimum notional above 10 USDT fails before any write path", async () => {
  const { transport } = transportFor({
    "/v5/market/instruments-info": {
      list: [
        {
          status: "Trading",
          priceFilter: { tickSize: "0.01" },
          lotSizeFilter: { qtyStep: "1", minOrderQty: "1", minNotionalValue: "11" },
        },
      ],
    },
  });
  await assert.rejects(
    runReadOnlyPreflight({ transport, symbol: "BTCUSDT", confirmExclusiveUse: async () => true }),
    (error: unknown) => error instanceof PreflightError && error.kind === "precondition-failed",
  );
});

test("PendingOpen, hedge mode, dirty baseline, and low balance are all hard stops", async () => {
  const cases = [
    {
      name: "PendingOpen",
      override: {
        "/v5/market/instruments-info": {
          list: [{ status: "PendingOpen", priceFilter: { tickSize: "0.01" }, lotSizeFilter: { qtyStep: "1", minOrderQty: "1", minNotionalValue: "5" } }],
        },
      },
    },
    {
      name: "hedge",
      override: { "/v5/position/list": { list: [{ symbol: "DOGEUSDT", side: "Buy", size: "0", positionIdx: 1 }] } },
    },
    {
      name: "dirty order",
      override: { "/v5/order/realtime": { list: [{ symbol: "DOGEUSDT", orderId: "other-order" }] } },
    },
    {
      name: "low balance",
      override: { "/v5/account/wallet-balance": { list: [{ totalAvailableBalance: "1" }] } },
    },
  ];
  for (const item of cases) {
    const { transport } = transportFor(item.override);
    await assert.rejects(
      runReadOnlyPreflight({ transport, symbol: "DOGEUSDT", confirmExclusiveUse: async () => true }),
      (error: unknown) => error instanceof PreflightError && error.kind === "precondition-failed",
      item.name,
    );
  }
});

test("exclusive-use refusal makes no account configuration call", async () => {
  const { transport, requests } = transportFor();
  await assert.rejects(
    runReadOnlyPreflight({ transport, symbol: "DOGEUSDT", confirmExclusiveUse: async () => false }),
    /exclusive account\/symbol use/,
  );
  assert.ok(!requests.some((path) => path.includes("switch") || path.includes("position-mode")));
});
