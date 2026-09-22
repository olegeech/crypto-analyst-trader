import assert from "node:assert/strict";
import test from "node:test";

import {
  BybitPublicMarketClient,
  PUBLIC_OPEN_INTEREST_PATH,
} from "../src/adapters/bybit-v5/public-market-client.js";
import type { BybitPublicResponse } from "../src/adapters/bybit-v5/public-response.js";
import {
  BybitPublicPaginationError,
  readCursorPages,
} from "../src/adapters/bybit-v5/public-market-pagination.js";

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
  assert.equal((requests[1]?.query as Record<string, string>).cursor, "next-1");
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
});
