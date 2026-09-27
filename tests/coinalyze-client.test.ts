import assert from "node:assert/strict";
import test from "node:test";

import {
  CoinalyzeClient,
  COINALYZE_API_CALLS_PER_MINUTE,
  DEFAULT_COINALYZE_MAX_RATE_WAIT_MS,
  type CoinalyzeTransportPort,
} from "../src/adapters/coinalyze/coinalyze-client.js";
import {
  CoinalyzeTransportError,
  type CoinalyzeHistoryRequest,
} from "../src/adapters/coinalyze/coinalyze-transport.js";

const API_KEY = "coinalyze-client-sentinel";

function market(symbol = "BTCUSDT_PERP.BINANCE") {
  return {
    symbol,
    exchange: "BINANCE",
    symbol_on_exchange: symbol.startsWith("BTC") ? "BTCUSDT" : symbol,
    base_asset: symbol.startsWith("BTC") ? "BTC" : "ETH",
    quote_asset: "USDT",
    is_perpetual: true,
    margined: "STABLE",
    expire_at: "0",
    oi_lq_vol_denominated_in: "USD",
  };
}

function historyPayload(symbols: readonly string[]): unknown {
  return symbols.map((symbol) => ({ symbol, history: [] }));
}

function fakeTransport(overrides: Partial<CoinalyzeTransportPort> = {}) {
  const requests: Array<{
    kind: "catalogue" | "history";
    apiKey: string;
    symbols?: readonly string[];
    from?: number;
    to?: number;
  }> = [];
  const transport: CoinalyzeTransportPort = {
    async getFutureMarkets(apiKey) {
      requests.push({ kind: "catalogue", apiKey });
      return [market()];
    },
    async getLiquidationHistory(apiKey, request: CoinalyzeHistoryRequest) {
      requests.push({
        kind: "history",
        apiKey,
        symbols: request.symbols,
        from: request.from,
        to: request.to,
      });
      return historyPayload(request.symbols);
    },
    ...overrides,
  };
  return { transport, requests };
}

test("catalogue fetch maps the whole provider response and reports sanitized failures", async (t) => {
  const valid = fakeTransport();
  const client = new CoinalyzeClient({ transport: valid.transport });
  const result = await client.fetchFutureMarkets(API_KEY);
  assert.equal(result.complete, true);
  assert.equal(result.markets[0]?.symbol, "BTCUSDT_PERP.BINANCE");
  assert.deepEqual(valid.requests, [{ kind: "catalogue", apiKey: API_KEY }]);

  await t.test("transport failure", async () => {
    const failed = fakeTransport({
      getFutureMarkets: async () => {
        throw new CoinalyzeTransportError(
          "unauthorized",
          `private error ${API_KEY}`,
          { httpStatus: 401 },
        );
      },
    });
    const failure = await new CoinalyzeClient({
      transport: failed.transport,
    }).fetchFutureMarkets(API_KEY);
    assert.equal(failure.complete, false);
    assert.equal(failure.markets.length, 0);
    assert.equal(failure.diagnostics[0]?.code, "catalogue-unavailable");
    assert.equal(JSON.stringify(failure).includes(API_KEY), false);
  });
});

test("history collection batches all symbols at 20 and preserves explicitly empty histories", async () => {
  const { transport, requests } = fakeTransport();
  let clock = 100_000;
  const waits: number[] = [];
  const client = new CoinalyzeClient({
    transport,
    now: () => clock,
    sleep: async (milliseconds) => {
      waits.push(milliseconds);
      clock += milliseconds;
    },
  });
  const symbols = Array.from({ length: 41 }, (_, index) => `S${index}.VENUE`);

  const result = await client.fetchLiquidationHistory(
    API_KEY,
    symbols,
    1_790_000_000,
    1_790_082_800,
  );

  assert.equal(result.responseValid, true);
  assert.equal(result.histories.length, 41);
  assert.equal(
    result.histories.every(({ observations }) => observations.length === 0),
    true,
  );
  assert.deepEqual(
    requests.map(({ symbols: batch }) => batch?.length),
    [20, 20, 1],
  );
  assert.deepEqual(waits, [60_000]);
  assert.equal(
    requests.every(
      (request) => request.kind === "history" && request.apiKey === API_KEY,
    ),
    true,
  );
});

test("provider rate accounting charges one quota unit per requested symbol and stays bounded", async (t) => {
  const tooMany = Array.from({ length: 41 }, (_, index) => `S${index}.VENUE`);
  const { transport: waitingTransport, requests } = fakeTransport();
  let clock = 0;
  const waits: number[] = [];
  const waitingClient = new CoinalyzeClient({
    transport: waitingTransport,
    now: () => clock,
    sleep: async (milliseconds) => {
      waits.push(milliseconds);
      clock += milliseconds;
    },
  });

  const result = await waitingClient.fetchLiquidationHistory(
    API_KEY,
    tooMany,
    10,
    82_810,
  );

  assert.equal(result.responseValid, true);
  assert.equal(requests.length, 3);
  assert.equal(waits[0], 60_000);
  assert.equal(COINALYZE_API_CALLS_PER_MINUTE, 40);

  await t.test("quota wait budget stops further requests", async () => {
    const { transport, requests: boundedRequests } = fakeTransport();
    const boundedClient = new CoinalyzeClient({
      transport,
      now: () => 0,
      sleep: async () => undefined,
      maxRateWaitMs: 0,
    });
    const bounded = await boundedClient.fetchLiquidationHistory(
      API_KEY,
      tooMany,
      10,
      82_810,
    );
    assert.equal(bounded.responseValid, false);
    assert.ok(bounded.diagnostics.some(({ code }) => code === "rate-limited"));
    assert.equal(boundedRequests.length, 2);
  });
});

test("honors one bounded Retry-After, then stops on absent or over-budget retry guidance", async (t) => {
  await t.test("one retry", async () => {
    let calls = 0;
    let clock = 1;
    const waits: number[] = [];
    const transport: CoinalyzeTransportPort = {
      async getFutureMarkets() {
        calls += 1;
        if (calls === 1) {
          throw new CoinalyzeTransportError("rate-limited", "safe", {
            httpStatus: 429,
            retryAfterSeconds: 3,
          });
        }
        return [market()];
      },
      async getLiquidationHistory(_apiKey, request) {
        return historyPayload(request.symbols);
      },
    };
    const client = new CoinalyzeClient({
      transport,
      now: () => clock,
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
        clock += milliseconds;
      },
    });

    const result = await client.fetchFutureMarkets(API_KEY);
    assert.equal(result.complete, true);
    assert.equal(calls, 2);
    assert.deepEqual(waits, [3_000]);
  });

  await t.test("missing retry guidance", async () => {
    let calls = 0;
    const { transport } = fakeTransport({
      getFutureMarkets: async () => {
        calls += 1;
        throw new CoinalyzeTransportError("rate-limited", "safe", {
          httpStatus: 429,
        });
      },
    });
    const result = await new CoinalyzeClient({ transport }).fetchFutureMarkets(
      API_KEY,
    );
    assert.equal(result.complete, false);
    assert.equal(calls, 1);
    assert.equal(result.diagnostics[0]?.code, "rate-limited");
  });

  await t.test("retry delay exceeds configured wait budget", async () => {
    let calls = 0;
    const { transport } = fakeTransport({
      getFutureMarkets: async () => {
        calls += 1;
        throw new CoinalyzeTransportError("rate-limited", "safe", {
          httpStatus: 429,
          retryAfterSeconds: 10,
        });
      },
    });
    const result = await new CoinalyzeClient({
      transport,
      maxRateWaitMs: 1_000,
    }).fetchFutureMarkets(API_KEY);
    assert.equal(result.complete, false);
    assert.equal(calls, 1);
  });
});

test("a failed history batch is preserved as incomplete while later batches continue", async () => {
  const requests: string[][] = [];
  let count = 0;
  const transport: CoinalyzeTransportPort = {
    async getFutureMarkets() {
      return [market()];
    },
    async getLiquidationHistory(_apiKey, request) {
      count += 1;
      requests.push([...request.symbols]);
      if (count === 1) {
        throw new CoinalyzeTransportError("http-failed", "safe", {
          httpStatus: 500,
        });
      }
      return historyPayload(request.symbols);
    },
  };
  const symbols = Array.from({ length: 21 }, (_, index) => `M${index}.VENUE`);
  const client = new CoinalyzeClient({
    transport,
    now: () => 0,
    sleep: async () => undefined,
  });

  const result = await client.fetchLiquidationHistory(API_KEY, symbols, 1, 2);

  assert.equal(result.responseValid, false);
  assert.deepEqual(
    requests.map((batch) => batch.length),
    [20, 1],
  );
  assert.equal(result.histories.length, 21);
  assert.equal(
    result.histories
      .slice(0, 20)
      .every(({ observations }) => observations.length === 0),
    true,
  );
  assert.equal(result.histories[20]?.symbol, "M20.VENUE");
  assert.ok(
    result.diagnostics.some(({ code }) => code === "history-unavailable"),
  );
});

test("authentication rejection stops later history batches", async () => {
  let calls = 0;
  const transport: CoinalyzeTransportPort = {
    async getFutureMarkets() {
      return [market()];
    },
    async getLiquidationHistory() {
      calls += 1;
      throw new CoinalyzeTransportError("unauthorized", "safe", {
        httpStatus: 401,
      });
    },
  };
  const symbols = Array.from({ length: 41 }, (_, index) => `M${index}.VENUE`);
  const result = await new CoinalyzeClient({
    transport,
    now: () => 0,
    sleep: async () => undefined,
  }).fetchLiquidationHistory(API_KEY, symbols, 1, 2);

  assert.equal(calls, 1);
  assert.equal(result.responseValid, false);
  assert.equal(result.histories.length, symbols.length);
  assert.ok(
    result.histories.every(({ observations }) => observations.length === 0),
  );
});

test("default wait budget is bounded and invalid query identities never select a prefix", async () => {
  let requests = 0;
  const transport = fakeTransport({
    getLiquidationHistory: async (_apiKey, request) => {
      requests += 1;
      return historyPayload(request.symbols);
    },
  });
  const result = await new CoinalyzeClient({
    transport: transport.transport,
  }).fetchLiquidationHistory(API_KEY, ["BTC", "BTC"], 1, 2);

  assert.equal(result.responseValid, false);
  assert.equal(result.histories.length, 0);
  assert.equal(requests, 0);
  assert.equal(DEFAULT_COINALYZE_MAX_RATE_WAIT_MS, 300_000);
});
