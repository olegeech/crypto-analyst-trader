import assert from "node:assert/strict";
import test from "node:test";
import {
  createBybitAccountReadTransport,
  BybitAccountReadError,
} from "../src/adapters/bybit-v5/account-read-transport.js";
import {
  buildSignaturePayload,
  hmacSha256,
} from "../src/adapters/bybit-v5/request-signing.js";

const credentials = {
  apiKey: "synthetic-key",
  apiSecret: "synthetic-secret",
  accountId: "123",
};
const envelope = (result: unknown = {}, retCode = 0) =>
  new Response(
    JSON.stringify({
      retCode,
      retMsg: "private-sentinel",
      result,
      time: 1700000000000,
    }),
  );
const budget = () => ({
  deadline: performance.now() + 30000,
  attempts: 0,
  maxAttempts: 80,
  maxResponseBytes: 1048576,
  maxObservedResponseBytes: 0,
});

test("account transport uses pinned GET signing bytes and a private credential copy", async () => {
  const source = { ...credentials };
  const seen: { url: string; init: RequestInit }[] = [];
  const transport = createBybitAccountReadTransport({
    environment: "demo",
    credentials: source,
    budget: budget(),
    clock: () => 1700000000000,
    clockOffsetMs: 0,
    request: async (url, init) => {
      seen.push({ url: String(url), init: init! });
      return envelope();
    },
  });
  source.apiKey = "changed";
  source.apiSecret = "changed";
  await transport.get("/v5/order/history", {
    category: "linear",
    cursor: "next+/=",
  });
  const call = seen[0]!;
  const query = new URL(call.url).search.slice(1);
  const headers = new Headers(call.init.headers);
  assert.equal(call.init.method, "GET");
  assert.equal(call.init.redirect, "error");
  assert.equal(headers.get("X-BAPI-API-KEY"), credentials.apiKey);
  assert.equal(
    headers.get("X-BAPI-SIGN"),
    hmacSha256(
      buildSignaturePayload("1700000000000", credentials.apiKey, "5000", query),
      credentials.apiSecret,
    ),
  );
  assert.equal("post" in transport, false);
});

test("account transport rejects unknown paths, missing environment and foreign origins without dispatch", async () => {
  let calls = 0;
  const transport = createBybitAccountReadTransport({
    environment: "testnet",
    credentials,
    budget: budget(),
    clockOffsetMs: 0,
    request: async () => {
      calls++;
      return envelope();
    },
  });
  for (const path of [
    "/v5/order/create",
    "/v5/order/cancel",
    "https://evil.example/v5/user/query-api",
    "/v5/account/info?secret=bad",
    "/v5/account/../order/create",
  ]) {
    await assert.rejects(transport.get(path), BybitAccountReadError);
  }
  assert.equal(calls, 0);
  assert.throws(() =>
    createBybitAccountReadTransport({ credentials, budget: budget() } as never),
  );
});

test("unsigned discovery and time use the selected origin without signing headers", async () => {
  const calls: Headers[] = [];
  const transport = createBybitAccountReadTransport({
    environment: "mainnet",
    credentials,
    budget: budget(),
    request: async (url, init) => {
      assert.equal(new URL(String(url)).origin, "https://api.bybit.com");
      calls.push(new Headers(init?.headers));
      return envelope({ timeNano: "1700000000000000000" });
    },
  });
  assert.equal(await transport.readExchangeTime(), 1700000000000);
  await transport.get("/v5/market/option-base-coins");
  assert.ok(
    calls.every((h) => !h.has("X-BAPI-API-KEY") && !h.has("X-BAPI-SIGN")),
  );
});

test("redirect and foreign response origins fail closed without another request", async () => {
  for (const response of [
    new Response(null, {
      status: 302,
      headers: { location: "https://evil.example" },
    }),
    Object.defineProperty(envelope(), "url", {
      value: "https://evil.example/v5/account/info",
    }),
  ]) {
    let calls = 0;
    const transport = createBybitAccountReadTransport({
      environment: "demo",
      credentials,
      budget: budget(),
      clockOffsetMs: 0,
      request: async () => {
        calls++;
        return response;
      },
    });
    await assert.rejects(
      transport.get("/v5/account/info"),
      BybitAccountReadError,
    );
    assert.equal(calls, 1);
  }
});

test("skew, permission and provider payload errors expose only stable safe codes", async () => {
  for (const [retCode, code] of [
    [10002, "TIMESTAMP_SKEW"],
    [10005, "READ_PERMISSION_DENIED"],
    [10003, "AUTHENTICATION_FAILED"],
  ] as const) {
    const transport = createBybitAccountReadTransport({
      environment: "demo",
      credentials,
      budget: budget(),
      clockOffsetMs: 0,
      request: async () => envelope({}, retCode),
    });
    await assert.rejects(
      transport.get("/v5/account/info"),
      (e: unknown) =>
        e instanceof BybitAccountReadError &&
        e.code === code &&
        !JSON.stringify(e).includes("private-sentinel"),
    );
  }
});

test("stream byte budget cancels oversized bodies even with misleading Content-Length", async () => {
  let cancelled = false;
  const state = budget();
  state.maxResponseBytes = 16;
  const transport = createBybitAccountReadTransport({
    environment: "demo",
    credentials,
    budget: state,
    clockOffsetMs: 0,
    request: async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode("x".repeat(17)));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-length": "1" } },
      ),
  });
  await assert.rejects(
    transport.get("/v5/account/info"),
    (e: unknown) =>
      e instanceof BybitAccountReadError &&
      e.code === "RESPONSE_BYTE_LIMIT_EXCEEDED",
  );
  assert.equal(cancelled, true);
});

test("deadline interrupts a stalled body even when the fake fetch ignores abort", async () => {
  const state = budget();
  state.deadline = performance.now() + 30;
  let cancelled = false;
  const transport = createBybitAccountReadTransport({
    environment: "demo",
    credentials,
    budget: state,
    clockOffsetMs: 0,
    request: async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      ),
  });
  await assert.rejects(
    transport.get("/v5/account/info"),
    (e: unknown) =>
      e instanceof BybitAccountReadError &&
      e.code === "COLLECTION_DEADLINE_EXCEEDED",
  );
  assert.equal(cancelled, true);
});

test("one bounded retry refreshes signatures and consumes shared attempts", async () => {
  const headers: Headers[] = [];
  let now = 1700000000000;
  const state = budget();
  const transport = createBybitAccountReadTransport({
    environment: "demo",
    credentials,
    budget: state,
    clock: () => now++,
    clockOffsetMs: 0,
    request: async (_u, init) => {
      headers.push(new Headers(init?.headers));
      return headers.length === 1
        ? new Response(null, { status: 503 })
        : envelope();
    },
  });
  await transport.get("/v5/account/info");
  assert.equal(state.attempts, 2);
  assert.notEqual(
    headers[0]?.get("X-BAPI-SIGN"),
    headers[1]?.get("X-BAPI-SIGN"),
  );
  state.attempts = 80;
  await assert.rejects(
    transport.get("/v5/account/info"),
    (e: unknown) =>
      e instanceof BybitAccountReadError &&
      e.code === "ATTEMPT_BUDGET_EXCEEDED",
  );
});

test("exchange time preserves millisecond precision when timeSecond is also present", async () => {
  const transport = createBybitAccountReadTransport({
    environment: "demo",
    credentials,
    budget: budget(),
    request: async () =>
      envelope({ timeSecond: "1700000000", timeNano: "1700000000123456789" }),
  });
  assert.equal(await transport.readExchangeTime(), 1700000000123);
});

test("a regressing monotonic clock cannot extend the collection deadline", async () => {
  let monotonic = 100;
  const state = budget();
  state.deadline = 1000;
  const transport = createBybitAccountReadTransport({
    environment: "demo",
    credentials,
    budget: state,
    clockOffsetMs: 0,
    monotonicClock: () => monotonic,
    request: async () => envelope(),
  });
  await transport.get("/v5/account/info");
  monotonic = 90;
  await assert.rejects(
    transport.get("/v5/account/info"),
    (e: unknown) =>
      e instanceof BybitAccountReadError &&
      e.code === "COLLECTION_DEADLINE_EXCEEDED",
  );
});

test("transport serialization cannot expose the collection credential snapshot", () => {
  const transport = createBybitAccountReadTransport({
    environment: "demo",
    credentials,
    budget: budget(),
    clockOffsetMs: 0,
  });
  assert.doesNotMatch(
    JSON.stringify(transport),
    /synthetic-key|synthetic-secret|accountId/u,
  );
});
