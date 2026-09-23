import assert from "node:assert/strict";
import test from "node:test";

import {
  BYBIT_PUBLIC_ORIGIN,
  BybitPublicTransportError,
  createBybitPublicTransport,
} from "../src/adapters/bybit-v5/public-transport.js";
import {
  responseServerTimeMs,
  validateBybitPublicResponse,
} from "../src/adapters/bybit-v5/public-response.js";

test("public transport sends unsigned GET requests to the pinned mainnet origin", async () => {
  const requests: Array<{ headers: Headers; method: string; url: string }> = [];
  const transport = createBybitPublicTransport({
    request: async (url, init) => {
      requests.push({
        headers: new Headers(init?.headers),
        method: String(init?.method),
        url: String(url),
      });
      return new Response(
        JSON.stringify({
          retCode: 0,
          retMsg: "OK",
          result: { timeSecond: "1720000000" },
          time: 1720000000123,
        }),
        { status: 200 },
      );
    },
  });

  assert.equal(await transport.getExchangeTime(), 1_720_000_000_000);
  assert.equal(requests[0]?.url, `${BYBIT_PUBLIC_ORIGIN}/v5/market/time`);
  assert.equal(requests[0]?.method, "GET");
  assert.equal(requests[0]?.headers.has("X-BAPI-API-KEY"), false);
  assert.equal(requests[0]?.headers.has("X-BAPI-SIGN"), false);
});

test("public transport rejects alternate origins and redirected responses", async () => {
  const transport = createBybitPublicTransport({
    request: async () =>
      new Response(JSON.stringify({ retCode: 0, retMsg: "OK", result: {} }), {
        status: 200,
      }),
  });
  await assert.rejects(
    transport.get("https://api-demo.bybit.com/v5/market/time"),
    (error: unknown) =>
      error instanceof BybitPublicTransportError &&
      error.kind === "invalid-request",
  );

  const redirected = createBybitPublicTransport({
    request: async () => {
      const response = new Response(
        JSON.stringify({ retCode: 0, retMsg: "OK", result: {} }),
        { status: 200 },
      );
      Object.defineProperty(response, "url", {
        value: "https://api-demo.bybit.com/v5/market/time",
      });
      return response;
    },
  });
  await assert.rejects(
    redirected.get("/v5/market/time"),
    (error: unknown) =>
      error instanceof BybitPublicTransportError &&
      error.kind === "invalid-response",
  );
});

test("public response validation rejects malformed envelopes and preserves exchange time", () => {
  assert.equal(
    responseServerTimeMs(
      validateBybitPublicResponse({
        retCode: 0,
        retMsg: "OK",
        result: { timeNano: "1720000000123000000" },
      }),
    ),
    1_720_000_000_123,
  );
  for (const payload of [
    null,
    [],
    { retCode: 0, result: {} },
    { retCode: 0, retMsg: "OK", result: null },
  ]) {
    assert.throws(() => validateBybitPublicResponse(payload));
  }
});

test("public transport classifies provider rate limits without retrying unboundedly", async () => {
  let calls = 0;
  const transport = createBybitPublicTransport({
    request: async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          retCode: 10006,
          retMsg: "Too many visits",
          result: {},
        }),
        { status: 200 },
      );
    },
  });
  await assert.rejects(
    transport.get("/v5/market/tickers", { category: "linear" }),
    (error: unknown) =>
      error instanceof BybitPublicTransportError &&
      error.kind === "rate-limited" &&
      error.retCode === 10006,
  );
  assert.equal(calls, 1);
});
