import assert from "node:assert/strict";
import test from "node:test";
import { BybitAccountReadClient } from "../src/adapters/bybit-v5/account-read-client.js";
import type { AccountEvidencePartition } from "../src/domain/account/account-evidence-policy.js";
const partition: AccountEvidencePartition = {
  endpoint: "executions",
  pass: "auxiliary",
  category: "option",
  baseCoin: "ETH",
  symbol: null,
  settleCoin: null,
};
test("empty cursor pages continue and every page retains the exact option window", async () => {
  const queries: Readonly<Record<string, string>>[] = [];
  const client = new BybitAccountReadClient({
    transport: {
      get: async (_path, query = {}) => {
        queries.push(query);
        return {
          time: 1700000000000,
          result: {
            category: "option",
            list: queries.length === 1 ? [] : [{ execId: "second" }],
            nextPageCursor: queries.length === 1 ? "next" : "",
          },
        };
      },
      readExchangeTime: async () => 1700000000000,
    },
    utcClock: () => 1700000000000,
  });
  const result = await client.readPartition(partition, {
    from: 1699996400000,
    to: 1700000000000,
  });
  assert.equal(result.coverage.status, "traversed");
  assert.equal(result.coverage.pages, 2);
  assert.equal(result.coverage.rows, 1);
  for (const query of queries) {
    assert.equal(query.baseCoin, "ETH");
    assert.equal(query.startTime, "1699996400000");
    assert.equal(query.endTime, "1700000000000");
    assert.equal(query.execType, undefined);
  }
});
test("repeated cursor and page exhaustion are failed coverage, not terminal empty success", async () => {
  for (const repeat of [true, false]) {
    let calls = 0;
    const client = new BybitAccountReadClient({
      transport: {
        get: async () => ({
          time: 1700000000000,
          result: {
            list: [],
            nextPageCursor: repeat ? "same" : String(++calls),
          },
        }),
        readExchangeTime: async () => 1700000000000,
      },
      utcClock: () => 1700000000000,
    });
    const result = await client.readPartition(partition, {
      from: 1699996400000,
      to: 1700000000000,
    });
    assert.equal(result.coverage.status, "failed");
    assert.ok(
      result.coverage.reasonCodes.includes(
        repeat ? "INVALID_RESPONSE" : "PAGE_BUDGET_EXCEEDED",
      ),
    );
  }
});
test("route failure preserves stable reason without leaking private exception text", async () => {
  const client = new BybitAccountReadClient({
    transport: {
      get: async () => {
        throw new Error("private-sentinel");
      },
      readExchangeTime: async () => 1700000000000,
    },
    utcClock: () => 1700000000000,
  });
  const result = await client.readPartition({
    ...partition,
    endpoint: "open-orders",
    pass: "A",
  });
  assert.equal(result.coverage.status, "failed");
  assert.doesNotMatch(JSON.stringify(result), /private-sentinel/u);
  assert.deepEqual(result.coverage.reasonCodes, ["TRANSPORT_FAILED"]);
});
