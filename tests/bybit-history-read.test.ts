import assert from "node:assert/strict";
import test from "node:test";
import {
  BybitAccountReadError,
  createBybitAccountReadTransport,
} from "../src/adapters/bybit-v5/account-read-transport.js";
import { BybitHistoryReadClient } from "../src/adapters/bybit-v5/history-read-client.js";
import type { HistoryReadSource } from "../src/ports/history-read.js";

const credentials = {
  apiKey: "synthetic-key",
  apiSecret: "synthetic-secret",
  accountId: "synthetic-account",
};
const window = {
  fromMs: Date.parse("2026-10-20T00:00:00.000Z"),
  toMs: Date.parse("2026-10-27T00:00:00.000Z"),
};
const envelope = (result: unknown) =>
  new Response(
    JSON.stringify({
      retCode: 0,
      retMsg: "OK",
      result,
      time: Date.parse("2026-10-27T00:00:00.000Z"),
    }),
  );
const syntheticSourceResponses: Readonly<Record<HistoryReadSource, unknown>> = {
  "order-history": {
    category: "linear",
    list: [
      {
        category: "linear",
        symbol: "DOGEUSDT",
        orderId: "order-1",
        orderLinkId: "",
        side: "Buy",
        orderType: "Limit",
        orderStatus: "Filled",
        qty: "1",
        price: "0.07699",
        avgPrice: "0.07699",
        cumExecQty: "1",
        cumExecValue: "0.07699",
        cumExecFee: "",
        createdTime: "1792497600000",
        updatedTime: "1792497660000",
        extraProviderField: "ignored",
      },
    ],
    nextPageCursor: "",
  },
  executions: {
    category: "linear",
    list: [
      {
        category: "linear",
        symbol: "DOGEUSDT",
        orderId: "order-2",
        orderLinkId: "",
        execId: "exec-2",
        side: "Buy",
        execType: "Trade",
        execPrice: "0.07699",
        execQty: "0.4",
        execValue: "0.030796",
        execFee: "-0.000030796",
        feeCurrency: "USDT",
        feeRate: "0.001",
        execPnl: "0",
        closedSize: "0",
        execTime: "1792497600000",
        seq: "999",
      },
      {
        category: "linear",
        symbol: "DOGEUSDT",
        orderId: "order-2",
        orderLinkId: "",
        execId: "exec-1",
        side: "Buy",
        execType: "Trade",
        execPrice: "0.07699",
        execQty: "0.6",
        execValue: "0.046194",
        execFee: "-0.000046194",
        feeCurrency: "USDT",
        feeRate: "0.001",
        execPnl: "0",
        closedSize: "0",
        execTime: "1792497600000",
        seq: "1000",
      },
    ],
    nextPageCursor: "",
  },
  "closed-pnl": {
    category: "linear",
    list: [
      {
        category: "linear",
        symbol: "DOGEUSDT",
        orderId: "close-1",
        side: "Sell",
        orderType: "Market",
        execType: "Trade",
        qty: "1",
        orderPrice: "0.07715",
        closedSize: "1",
        cumEntryValue: "0.07699",
        avgEntryPrice: "0.07699",
        cumExitValue: "0.07715",
        avgExitPrice: "0.07715",
        closedPnl: "0.00016",
        openFee: "",
        closeFee: "",
        fundingFee: "",
        fillCount: "1",
        leverage: "1",
        createdTime: "1792497600000",
        updatedTime: "1792497660000",
      },
    ],
    nextPageCursor: "",
  },
  "transaction-log": {
    accountType: "UNIFIED",
    list: [
      {
        id: "tx-1",
        type: "Future unknown type",
        transSubType: "Future subtype",
        side: "None",
        businessType: "TRADE",
        category: "linear",
        symbol: "DOGEUSDT",
        currency: "USDT",
        qty: "0",
        cashFlow: "0",
        funding: "-0.0001",
        fee: "-0.0002",
        feeRate: "",
        change: "-0.0002",
        bonusChange: "",
        availableBalance: "10",
        tradeId: "",
        orderId: "",
        transactionTime: "1792497600000",
        cashBalance: "10",
        size: "0",
        tradePrice: "0",
        orderLinkId: "",
        displayType: "Future display value",
        extraFees: '{"feeType":"TRADE","subFeeType":"EXTRA"}',
        futureProviderField: true,
      },
    ],
    nextPageCursor: "",
  },
};

test("each Bybit history stream uses its GET route, native scope and documented page limit", async () => {
  const calls: {
    path: string;
    query: URLSearchParams;
    method: string | undefined;
  }[] = [];
  const transport = createBybitAccountReadTransport({
    environment: "demo",
    credentials,
    budget: {
      deadline: performance.now() + 30000,
      attempts: 0,
      maxAttempts: 20,
      maxResponseBytes: 1024 * 1024,
      maxObservedResponseBytes: 0,
    },
    clockOffsetMs: 0,
    request: async (url, init) => {
      const parsed = new URL(String(url));
      calls.push({
        path: parsed.pathname,
        query: parsed.searchParams,
        method: init?.method,
      });
      const source =
        parsed.pathname === "/v5/order/history"
          ? "order-history"
          : parsed.pathname === "/v5/execution/list"
            ? "executions"
            : parsed.pathname === "/v5/position/closed-pnl"
              ? "closed-pnl"
              : "transaction-log";
      return envelope(syntheticSourceResponses[source]);
    },
  });
  const client = new BybitHistoryReadClient({
    transport,
    utcClock: () => Date.parse("2026-10-27T00:00:01.000Z"),
  });
  const sources: readonly [HistoryReadSource, string, string][] = [
    ["order-history", "/v5/order/history", "50"],
    ["executions", "/v5/execution/list", "100"],
    ["closed-pnl", "/v5/position/closed-pnl", "100"],
    ["transaction-log", "/v5/account/transaction-log", "50"],
  ];
  for (const [source] of sources) {
    const page = await client.readPage({ source, window });
    assert.equal(page.facts.length, source === "executions" ? 2 : 1);
  }
  assert.deepEqual(
    calls.map(({ path, query, method }) => [
      path,
      query.get("limit"),
      method,
    ]),
    sources.map(([, path, limit]) => [path, limit, "GET"]),
  );
  for (const { query } of calls) {
    assert.equal(query.get("startTime"), String(window.fromMs));
    assert.equal(query.get("endTime"), String(window.toMs));
    assert.equal(query.has("symbol"), false);
  }
  for (const { query } of calls.slice(0, 3)) {
    assert.equal(query.get("category"), "linear");
  }
  assert.equal(calls[3]?.query.get("accountType"), "UNIFIED");
  assert.equal(calls[3]?.query.has("category"), false);
});

test("historical source facts retain exact source semantics and unknown provider values", async () => {
  const client = new BybitHistoryReadClient({
    transport: {
      get: async (path) => {
        const source =
          path === "/v5/account/transaction-log"
            ? "transaction-log"
            : "order-history";
        return {
          time: Date.parse("2026-10-27T00:00:00.000Z"),
          result: syntheticSourceResponses[source] as Record<string, unknown>,
        };
      },
    },
    utcClock: () => Date.parse("2026-10-27T00:00:01.000Z"),
  });
  const order = await client.readPage({ source: "order-history", window });
  const orderFact = order.facts[0];
  assert.ok(orderFact && orderFact.factKind === "order");
  if (!orderFact || orderFact.factKind !== "order") return;
  assert.equal(orderFact.providerEventTime, "2026-10-20T12:00:00.000Z");
  assert.equal(orderFact.providerRevisionTime, "2026-10-20T12:01:00.000Z");
  assert.equal(orderFact.orderLinkId, null);
  assert.equal(orderFact.cumExecFee, null);
  const transaction = await client.readPage({
    source: "transaction-log",
    window,
  });
  const transactionFact = transaction.facts[0];
  assert.ok(transactionFact && transactionFact.factKind === "transaction");
  if (!transactionFact || transactionFact.factKind !== "transaction") return;
  assert.equal(transactionFact.type, "Future unknown type");
  assert.equal(transactionFact.transSubType, "Future subtype");
  assert.equal(transactionFact.funding, "-0.0001");
  assert.equal(transactionFact.fee, "-0.0002");
  assert.equal(transactionFact.currency, "USDT");
  assert.equal(transactionFact.tradeId, null);
  assert.equal(transactionFact.cashBalance, "10");
  assert.equal(transactionFact.orderLinkId, null);
  assert.equal(
    transactionFact.extraFees,
    '{"feeType":"TRADE","subFeeType":"EXTRA"}',
  );
});

test("equal-time fills with the same order remain distinct and stable by execId", async () => {
  const client = new BybitHistoryReadClient({
    transport: {
      get: async () => ({
        time: Date.parse("2026-10-27T00:00:00.000Z"),
        result: syntheticSourceResponses.executions as Record<string, unknown>,
      }),
    },
    utcClock: () => Date.parse("2026-10-27T00:00:01.000Z"),
  });
  const page = await client.readPage({ source: "executions", window });
  assert.deepEqual(
    page.facts.map((fact) =>
      fact.factKind === "execution" ? fact.execId : null,
    ),
    ["exec-1", "exec-2"],
  );
});

test("the same immutable execId with contradictory source facts is rejected", async () => {
  const response = structuredClone(
    syntheticSourceResponses.executions,
  ) as { list: Record<string, unknown>[]; nextPageCursor: string };
  const duplicate = { ...response.list[0], execId: response.list[1]?.execId };
  response.list.push(duplicate);
  const client = new BybitHistoryReadClient({
    transport: {
      get: async () => ({
        time: Date.parse("2026-10-27T00:00:00.000Z"),
        result: response,
      }),
    },
    utcClock: () => Date.parse("2026-10-27T00:00:01.000Z"),
  });
  await assert.rejects(
    client.readPage({ source: "executions", window }),
    (error: unknown) =>
      error instanceof BybitAccountReadError &&
      error.code === "INVALID_RESPONSE",
  );
});

test("opaque cursors traverse pages, while cursor loops and page exhaustion fail boundedly", async () => {
  const queries: Readonly<Record<string, string>>[] = [];
  const client = new BybitHistoryReadClient({
    transport: {
      get: async (_path, query = {}) => {
        queries.push(query);
        return {
          time: Date.parse("2026-10-27T00:00:00.000Z"),
          result: {
            category: "linear",
            list: [],
            nextPageCursor: queries.length === 1 ? "opaque+/=" : "",
          },
        };
      },
    },
    utcClock: () => Date.parse("2026-10-27T00:00:01.000Z"),
  });
  const pages: unknown[] = [];
  for await (const page of client.readPages({
    source: "order-history",
    window,
  })) pages.push(page);
  assert.equal(pages.length, 2);
  assert.equal(queries[1]?.cursor, "opaque+/=");

  for (const mode of ["loop", "budget"] as const) {
    let calls = 0;
    const bounded = new BybitHistoryReadClient({
      transport: {
        get: async () => ({
          time: Date.parse("2026-10-27T00:00:00.000Z"),
          result: {
            category: "linear",
            list: [],
            nextPageCursor: mode === "loop" ? "repeat" : String(++calls),
          },
        }),
      },
      maxPagesPerWindow: 2,
      utcClock: () => Date.parse("2026-10-27T00:00:01.000Z"),
    });
    await assert.rejects(
      async () => {
        for await (const _page of bounded.readPages({
          source: "order-history",
          window,
        })) {
          /* exhaust the provider-shaped page stream */
        }
      },
      (error: unknown) =>
        error instanceof BybitAccountReadError &&
        error.code ===
          (mode === "loop" ? "INVALID_RESPONSE" : "PAGE_BUDGET_EXCEEDED"),
    );
  }
});

test("windows over seven days and malformed critical source facts are rejected before coverage", async () => {
  let calls = 0;
  const client = new BybitHistoryReadClient({
    transport: {
      get: async () => {
        calls++;
        return {
          time: Date.parse("2026-10-27T00:00:00.000Z"),
          result: {
            category: "linear",
            list: [
              {
                category: "linear",
                symbol: "DOGEUSDT",
                orderId: "",
                side: "Buy",
                orderType: "Limit",
                orderStatus: "Filled",
                qty: "1e-3",
                price: "1",
                createdTime: "1792497600000",
                updatedTime: "1792497660000",
              },
            ],
            nextPageCursor: "",
          },
        };
      },
    },
    utcClock: () => Date.parse("2026-10-27T00:00:01.000Z"),
  });
  await assert.rejects(
    client.readPage({
      source: "order-history",
      window: {
        fromMs: window.fromMs,
        toMs: window.toMs + 1,
      },
    }),
    BybitAccountReadError,
  );
  await assert.rejects(
    client.readPage({ source: "order-history", window }),
    (error: unknown) =>
      error instanceof BybitAccountReadError &&
      error.code === "INVALID_RESPONSE",
  );
  assert.equal(calls, 1);
});

test("Bybit history client reports only safe transport reason codes", async () => {
  const client = new BybitHistoryReadClient({
    transport: {
      get: async () => {
        throw new Error("private-sentinel");
      },
    },
    utcClock: () => Date.parse("2026-10-27T00:00:01.000Z"),
  });
  await assert.rejects(
    client.readPage({ source: "order-history", window }),
    (error: unknown) =>
      error instanceof BybitAccountReadError &&
      error.code === "TRANSPORT_FAILED" &&
      !JSON.stringify(error).includes("private-sentinel"),
  );
});

test("the real account transport admits only the four history GET routes", async () => {
  const seen: { path: string; method: string | undefined }[] = [];
  const transport = createBybitAccountReadTransport({
    environment: "demo",
    credentials,
    budget: {
      deadline: performance.now() + 30000,
      attempts: 0,
      maxAttempts: 20,
      maxResponseBytes: 1024 * 1024,
      maxObservedResponseBytes: 0,
    },
    clockOffsetMs: 0,
    request: async (url, init) => {
      seen.push({
        path: new URL(String(url)).pathname,
        method: init?.method,
      });
      return envelope({ list: [], nextPageCursor: "" });
    },
  });
  for (const path of [
    "/v5/order/history",
    "/v5/execution/list",
    "/v5/position/closed-pnl",
    "/v5/account/transaction-log",
  ]) {
    await transport.get(path, {
      category: "linear",
      accountType: "UNIFIED",
      startTime: String(window.fromMs),
      endTime: String(window.toMs),
      limit: "50",
    });
  }
  assert.deepEqual(
    seen,
    [
      "/v5/order/history",
      "/v5/execution/list",
      "/v5/position/closed-pnl",
      "/v5/account/transaction-log",
    ].map((path) => ({ path, method: "GET" })),
  );
  assert.equal("post" in transport, false);
});
