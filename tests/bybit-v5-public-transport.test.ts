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

  assert.equal(await transport.getExchangeTime(), 1_720_000_000_123);
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

test("provider time preserves nanoseconds as exact milliseconds and checks redundant fields", () => {
  for (const [result, time, expected] of [
    [
      { timeSecond: "1792754592", timeNano: "1792754592968361437" },
      1792754592968,
      1792754592968,
    ],
    [
      { timeSecond: "1792754592", timeNano: "1792754592999999999" },
      1792754593000,
      1792754592999,
    ],
    [{ timeSecond: "1792754592" }, 1792754592968, 1792754592968],
    [{}, 1792754592968, 1792754592968],
  ] as const) {
    assert.equal(
      responseServerTimeMs({ retCode: 0, retMsg: "OK", result, time }),
      expected,
    );
  }
  for (const result of [
    { timeNano: "bad", timeSecond: "1792754592" },
    { timeNano: 1792754592968361437 },
    { timeNano: "9007199254740992000000" },
    { timeNano: "0" },
    { timeNano: "-1" },
    { timeSecond: "bad" },
    { timeSecond: "9007199254740992" },
    { timeSecond: "1792754591", timeNano: "1792754592968361437" },
    { timeSecond: "1792754591" },
    { timeNano: "1792754590968361437" },
  ]) {
    assert.equal(
      responseServerTimeMs({
        retCode: 0,
        retMsg: "OK",
        result,
        time: 1792754592968,
      }),
      undefined,
    );
  }
  for (const time of ["bad", null, -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() =>
      validateBybitPublicResponse({
        retCode: 0,
        retMsg: "OK",
        result: { timeNano: "1792754592968361437" },
        time,
      }),
    );
  }
});

test("public quote-time reads explicitly reject second-only precision and contradictory time", async () => {
  for (const [result, time, reasonCode] of [
    [
      { timeSecond: "1792754592" },
      undefined,
      "PROVIDER_TIME_PRECISION_INSUFFICIENT",
    ],
    [
      { timeSecond: "1792754591", timeNano: "1792754592968361437" },
      1792754592968,
      "PROVIDER_TIME_INVALID_OR_INCONSISTENT",
    ],
    [
      { timeNano: "bad" },
      1792754592968,
      "PROVIDER_TIME_INVALID_OR_INCONSISTENT",
    ],
  ] as const) {
    const transport = createBybitPublicTransport({
      request: async () =>
        new Response(
          JSON.stringify({
            retCode: 0,
            retMsg: "OK",
            result,
            ...(time === undefined ? {} : { time }),
          }),
        ),
    });
    await assert.rejects(
      transport.getExchangeTime(),
      (error) =>
        error instanceof BybitPublicTransportError &&
        error.reasonCode === reasonCode,
    );
  }
});
