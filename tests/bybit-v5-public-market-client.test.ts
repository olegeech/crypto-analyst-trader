import assert from "node:assert/strict";
import test from "node:test";

import {
  BybitPublicMarketClient,
  PUBLIC_FUNDING_HISTORY_PATH,
  PUBLIC_INSTRUMENTS_INFO_PATH,
  PUBLIC_KLINE_PATH,
  PUBLIC_OPEN_INTEREST_PATH,
  PUBLIC_TICKERS_PATH,
} from "../src/adapters/bybit-v5/public-market-client.js";
import type { BybitPublicResponse } from "../src/adapters/bybit-v5/public-response.js";
import {
  BybitPublicPaginationError,
  nextCursorFromResponse,
  readCursorPages,
} from "../src/adapters/bybit-v5/public-market-pagination.js";
import type { UtcTimestamp } from "../src/domain/shared/time.js";

function response(result: Record<string, unknown>): BybitPublicResponse {
  return { retCode: 0, retMsg: "OK", result, time: 1_725_000_000_000 };
}

test("public market client propagates bounded OI cursors and keeps delayed observations valid", async () => {
  const requests: Array<{
    path: string;
    query: Record<string, string> | undefined;
  }> = [];
  const client = new BybitPublicMarketClient({
    pagination: { maxPages: 3, maxRows: 20 },
    transport: {
      async get(path, query) {
        requests.push({
          path,
          query: query as Record<string, string> | undefined,
        });
        const cursor =
          typeof query === "object" && query !== null && !Array.isArray(query)
            ? (query as Record<string, string>).cursor
            : undefined;
        return cursor === undefined
          ? response({
              symbol: "DOGEUSDT",
              list: [
                {
                  symbol: "DOGEUSDT",
                  timestamp: "1722531600000",
                  openInterest: "1",
                },
              ],
              nextPageCursor: "next-1",
            })
          : response({
              symbol: "DOGEUSDT",
              list: [
                {
                  symbol: "DOGEUSDT",
                  timestamp: "1722528000000",
                  openInterest: "0.9",
                },
              ],
            });
      },
      async getExchangeTime() {
        return 1_725_000_000_000;
      },
    },
  });
  const rows = await client.readOpenInterest("DOGEUSDT", "1h", 2);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.timestamp, "2024-08-01T16:00:00.000Z");
  assert.equal(requests[0]?.path, PUBLIC_OPEN_INTEREST_PATH);
  assert.deepEqual(requests[0]?.query, {
    category: "linear",
    symbol: "DOGEUSDT",
    intervalTime: "1h",
    limit: "3",
  });
  assert.equal((requests[1]?.query as Record<string, string>).cursor, "next-1");
});

test("public market client uses the endpoint-specific bounded query contracts", async () => {
  const requests: Array<{
    path: string;
    query: Record<string, string> | undefined;
  }> = [];
  const transport = {
    async get(path: string, query?: unknown) {
      requests.push({
        path,
        query: query as Record<string, string> | undefined,
      });
      if (path === PUBLIC_INSTRUMENTS_INFO_PATH) {
        return response({
          list: [
            {
              symbol: "DOGEUSDT",
              status: "Trading",
              baseCoin: "DOGE",
              contractType: "LinearPerpetual",
              quoteCoin: "USDT",
              settleCoin: "USDT",
              fundingInterval: "480",
              priceFilter: { tickSize: "0.0001" },
              lotSizeFilter: {
                qtyStep: "1",
                minOrderQty: "1",
                minNotionalValue: "5",
              },
            },
          ],
        });
      }
      if (path === PUBLIC_TICKERS_PATH) {
        return response({
          list: [
            {
              symbol: "DOGEUSDT",
              bid1Price: "1",
              ask1Price: "2",
              lastPrice: "1.5",
            },
          ],
        });
      }
      if (path === PUBLIC_KLINE_PATH) {
        return response({
          symbol: "DOGEUSDT",
          category: "linear",
          list: [["1722535200000", "1", "2", "0.5", "1.5", "1", "1.5"]],
        });
      }
      if (path === PUBLIC_FUNDING_HISTORY_PATH) {
        return response({
          list: [
            {
              symbol: "DOGEUSDT",
              fundingRate: "0.001",
              fundingRateTimestamp: "1722535200000",
            },
          ],
        });
      }
      if (path === PUBLIC_OPEN_INTEREST_PATH) {
        return response({
          symbol: "DOGEUSDT",
          list: [
            {
              symbol: "DOGEUSDT",
              timestamp: "1722535200000",
              openInterest: "1",
            },
          ],
        });
      }
      throw new Error(`unexpected path ${path}`);
    },
    async getExchangeTime() {
      return 1_722_535_200_000;
    },
  };
  const client = new BybitPublicMarketClient({ transport });

  await client.readInstrument("DOGEUSDT");
  await client.readTicker("DOGEUSDT");
  await client.readOhlcv(
    "DOGEUSDT",
    "1h",
    1,
    "2024-08-01T19:00:00.000Z" as UtcTimestamp,
  );
  await client.readFunding("DOGEUSDT", 1);
  await client.readOpenInterest("DOGEUSDT", "4h", 1);

  assert.deepEqual(requests, [
    {
      path: PUBLIC_INSTRUMENTS_INFO_PATH,
      query: { category: "linear", symbol: "DOGEUSDT" },
    },
    {
      path: PUBLIC_TICKERS_PATH,
      query: { category: "linear", symbol: "DOGEUSDT" },
    },
    {
      path: PUBLIC_KLINE_PATH,
      query: {
        category: "linear",
        symbol: "DOGEUSDT",
        interval: "60",
        limit: "2",
      },
    },
    {
      path: PUBLIC_FUNDING_HISTORY_PATH,
      query: { category: "linear", symbol: "DOGEUSDT", limit: "2" },
    },
    {
      path: PUBLIC_OPEN_INTEREST_PATH,
      query: {
        category: "linear",
        symbol: "DOGEUSDT",
        intervalTime: "4h",
        limit: "2",
      },
    },
  ]);
});

test("cursor pagination fails closed on repeated cursors and page exhaustion", async () => {
  await assert.rejects(
    readCursorPages({
      label: "fixture",
      budget: { maxPages: 3, maxRows: 10 },
      read: async () => ({ rows: ["row"], nextCursor: "same" }),
    }),
    (error: unknown) =>
      error instanceof BybitPublicPaginationError &&
      error.kind === "repeated-cursor",
  );
  await assert.rejects(
    readCursorPages({
      label: "fixture",
      budget: { maxPages: 1, maxRows: 10 },
      read: async () => ({ rows: ["row"], nextCursor: "next" }),
    }),
    (error: unknown) =>
      error instanceof BybitPublicPaginationError &&
      error.kind === "page-budget-exhausted",
  );
  await assert.rejects(
    async () =>
      nextCursorFromResponse(
        response({ nextPageCursor: "bad\nvalue" }),
        "fixture",
      ),
    (error: unknown) =>
      error instanceof BybitPublicPaginationError &&
      error.kind === "invalid-cursor",
  );
});
