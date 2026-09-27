import assert from "node:assert/strict";
import test from "node:test";

import {
  COINALYZE_API_ORIGIN,
  COINALYZE_FUTURE_MARKETS_PATH,
  COINALYZE_HISTORY_SYMBOL_LIMIT,
  CoinalyzeTransport,
  CoinalyzeTransportError,
  DEFAULT_COINALYZE_MAX_RESPONSE_BYTES,
} from "../src/adapters/coinalyze/coinalyze-transport.js";

const API_KEY = "coinalyze-secret-sentinel";

test("uses only the canonical origin, GET, api_key header, and documented history query", async () => {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const transport = new CoinalyzeTransport({
    request: async (input, init) => {
      calls.push({ url: new URL(String(input)), init: init ?? {} });
      return new Response("[]", { status: 200 });
    },
  });

  await transport.getFutureMarkets(API_KEY);
  await transport.getLiquidationHistory(API_KEY, {
    symbols: ["BTCUSDT_PERP.BINANCE", "ETHUSDT_PERP.BYBIT"],
    from: 1_790_000_000,
    to: 1_790_082_800,
  });

  assert.equal(calls[0]?.url.origin, COINALYZE_API_ORIGIN);
  assert.equal(calls[0]?.url.pathname, COINALYZE_FUTURE_MARKETS_PATH);
  assert.equal(calls[0]?.url.search, "");
  assert.equal(calls[0]?.init.method, "GET");
  assert.equal(new Headers(calls[0]?.init.headers).get("api_key"), API_KEY);
  assert.equal(calls[1]?.url.pathname, "/v1/liquidation-history");
  assert.equal(
    calls[1]?.url.searchParams.get("symbols"),
    "BTCUSDT_PERP.BINANCE,ETHUSDT_PERP.BYBIT",
  );
  assert.equal(calls[1]?.url.searchParams.get("interval"), "1hour");
  assert.equal(calls[1]?.url.searchParams.get("from"), "1790000000");
  assert.equal(calls[1]?.url.searchParams.get("to"), "1790082800");
  assert.equal(calls[1]?.url.searchParams.get("convert_to_usd"), "true");
  assert.equal(calls[1]?.init.method, "GET");
  assert.equal(new Headers(calls[1]?.init.headers).get("api_key"), API_KEY);
  assert.equal(
    calls.some(({ url }) => url.href.includes(API_KEY)),
    false,
  );
  assert.equal(
    calls.some(({ init }) => JSON.stringify(init).includes("X-BAPI")),
    false,
  );
});

test("rejects oversized batches, duplicate symbols, invalid time ranges, and unsafe credentials before fetch", async () => {
  let requestCount = 0;
  const transport = new CoinalyzeTransport({
    request: async () => {
      requestCount += 1;
      return new Response("[]", { status: 200 });
    },
  });
  const symbols = Array.from(
    { length: COINALYZE_HISTORY_SYMBOL_LIMIT + 1 },
    (_, index) => `S${index}`,
  );

  const invalidRequests = [
    () => transport.getLiquidationHistory(API_KEY, { symbols, from: 1, to: 2 }),
    () =>
      transport.getLiquidationHistory(API_KEY, {
        symbols: ["BTC", "BTC"],
        from: 1,
        to: 2,
      }),
    () =>
      transport.getLiquidationHistory(API_KEY, {
        symbols: ["BTC"],
        from: 3,
        to: 2,
      }),
    () =>
      transport.getLiquidationHistory(API_KEY, {
        symbols: ["BTC"],
        from: 1,
        to: 82_802,
      }),
    () => transport.getFutureMarkets(`${API_KEY}\nX-Injected: true`),
  ];
  for (const invalidRequest of invalidRequests) {
    await assert.rejects(invalidRequest, (error: unknown) => {
      assert.ok(error instanceof CoinalyzeTransportError);
      assert.equal(error.kind, "invalid-request");
      assert.doesNotMatch(error.message, /coinalyze-secret-sentinel/);
      return true;
    });
  }
  assert.equal(requestCount, 0);
});

test("HTTP failures are classified without exposing provider bodies or API keys", async (t) => {
  const cases = [
    { status: 401, headers: {}, kind: "unauthorized", retryAfter: undefined },
    {
      status: 429,
      headers: { "retry-after": "7" },
      kind: "rate-limited",
      retryAfter: 7,
    },
    { status: 206, headers: {}, kind: "http-failed", retryAfter: undefined },
    { status: 500, headers: {}, kind: "http-failed", retryAfter: undefined },
  ] as const;

  for (const item of cases) {
    await t.test(String(item.status), async () => {
      const transport = new CoinalyzeTransport({
        request: async () =>
          new Response(`private ${API_KEY} response`, {
            status: item.status,
            headers: item.headers,
          }),
      });
      await assert.rejects(
        transport.getFutureMarkets(API_KEY),
        (error: unknown) => {
          assert.ok(error instanceof CoinalyzeTransportError);
          assert.equal(error.kind, item.kind);
          assert.equal(error.httpStatus, item.status);
          assert.equal(error.retryAfterSeconds, item.retryAfter);
          assert.doesNotMatch(
            `${error.message}${error.stack ?? ""}`,
            new RegExp(API_KEY),
          );
          assert.doesNotMatch(
            `${error.message}${error.stack ?? ""}`,
            /private .* response/,
          );
          return true;
        },
      );
    });
  }
});

test("aborts off-origin responses, transport errors, malformed JSON, and incomplete UTF-8", async (t) => {
  await t.test("off-origin response URL", async () => {
    const response = new Response("[]", { status: 200 });
    Object.defineProperty(response, "url", {
      value: "https://attacker.invalid/v1/future-markets",
    });
    const transport = new CoinalyzeTransport({ request: async () => response });
    await assert.rejects(
      transport.getFutureMarkets(API_KEY),
      (error: unknown) => {
        assert.ok(error instanceof CoinalyzeTransportError);
        assert.equal(error.kind, "invalid-response");
        return true;
      },
    );
  });

  await t.test("network exception", async () => {
    const transport = new CoinalyzeTransport({
      request: async () => {
        throw new Error(`private ${API_KEY}`);
      },
    });
    await assert.rejects(
      transport.getFutureMarkets(API_KEY),
      (error: unknown) => {
        assert.ok(error instanceof CoinalyzeTransportError);
        assert.equal(error.kind, "transport-failed");
        assert.doesNotMatch(error.message, new RegExp(API_KEY));
        return true;
      },
    );
  });

  for (const body of ["not-json", new Uint8Array([0xff, 0xfe])]) {
    const transport = new CoinalyzeTransport({
      request: async () => new Response(body, { status: 200 }),
    });
    await assert.rejects(
      transport.getFutureMarkets(API_KEY),
      (error: unknown) => {
        assert.ok(error instanceof CoinalyzeTransportError);
        assert.equal(error.kind, "invalid-response");
        return true;
      },
    );
  }
});

test("response bytes are bounded both by declared size and streamed size", async (t) => {
  await t.test("oversized content-length", async () => {
    const transport = new CoinalyzeTransport({
      maxResponseBytes: 1_024,
      request: async () =>
        new Response("[]", {
          status: 200,
          headers: { "content-length": "2048" },
        }),
    });
    await assert.rejects(
      transport.getFutureMarkets(API_KEY),
      (error: unknown) => {
        assert.ok(error instanceof CoinalyzeTransportError);
        assert.equal(error.kind, "response-too-large");
        return true;
      },
    );
  });

  await t.test("streamed bytes exceed the budget", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1_025));
        controller.close();
      },
    });
    const transport = new CoinalyzeTransport({
      maxResponseBytes: 1_024,
      request: async () => new Response(body, { status: 200 }),
    });
    await assert.rejects(
      transport.getFutureMarkets(API_KEY),
      (error: unknown) => {
        assert.ok(error instanceof CoinalyzeTransportError);
        assert.equal(error.kind, "response-too-large");
        return true;
      },
    );
  });

  assert.equal(DEFAULT_COINALYZE_MAX_RESPONSE_BYTES, 16 * 1024 * 1024);
});
