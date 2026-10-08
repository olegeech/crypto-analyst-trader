import assert from "node:assert/strict";
import test from "node:test";

import {
  BYBIT_CANONICAL_ORIGINS,
  BYBIT_DEMO_ORIGIN,
  BYBIT_MAINNET_ORIGIN,
  BybitDemoTransportError,
  BybitPrivateTransportError,
  buildSignaturePayload,
  classifyRetCode,
  createBybitDemoTransport,
  createBybitPrivateTransport,
  hmacSha256,
  validateBybitResponse,
} from "../src/adapters/bybit-v5/transport.js";
import { ACCOUNT_READ_ORIGINS } from "../src/adapters/bybit-v5/account-read-transport.js";

const credentials = {
  apiKey: "synthetic-api-key",
  apiSecret: "synthetic-api-secret",
  accountId: "demo-account",
};

test("Demo transport preserves exact signing bytes", async () => {
  const requests: Array<{ body: string; headers: Headers; url: string }> = [];
  const transport = createBybitDemoTransport({
    credentials,
    clock: () => 1_672_052_955_758,
    clockOffsetMs: 0,
    request: async (url, init) => {
      requests.push({
        body: String(init?.body ?? ""),
        headers: new Headers(init?.headers),
        url: String(url),
      });
      return new Response(
        JSON.stringify({ retCode: 0, retMsg: "", result: {} }),
        { status: 200 },
      );
    },
  });

  await transport.post("/v5/order/create", {
    category: "linear",
    symbol: "BTCUSDT",
    qty: "1",
  });

  const request = requests[0];
  assert.ok(request);
  assert.equal(request.url, `${BYBIT_DEMO_ORIGIN}/v5/order/create`);
  assert.equal(
    request.headers.get("X-BAPI-SIGN"),
    hmacSha256(
      buildSignaturePayload(
        "1672052955758",
        credentials.apiKey,
        "5000",
        request.body,
      ),
      credentials.apiSecret,
    ),
  );
});

test("Demo transport validates the final origin and rejects redirects", async () => {
  const transport = createBybitDemoTransport({
    credentials,
    request: async () =>
      new Response(JSON.stringify({ retCode: 0, retMsg: "", result: {} }), {
        status: 200,
      }),
  });
  await assert.rejects(
    transport.get("https://api-testnet.bybit.com/v5/market/time"),
    (error: unknown) =>
      error instanceof BybitDemoTransportError &&
      error.kind === "invalid-request",
  );

  const redirected = createBybitDemoTransport({
    credentials,
    request: async () => {
      const response = new Response(
        JSON.stringify({ retCode: 0, retMsg: "", result: {} }),
        { status: 200 },
      );
      Object.defineProperty(response, "url", {
        value: "https://api-testnet.bybit.com/v5/market/time",
      });
      return response;
    },
  });
  await assert.rejects(
    redirected.get("/v5/market/time"),
    (error: unknown) =>
      error instanceof BybitDemoTransportError &&
      error.kind === "invalid-response",
  );
});

test("private transport signs Demo and Mainnet requests only for canonical origins", async () => {
  const cases = [
    { environment: "demo" as const, origin: BYBIT_DEMO_ORIGIN },
    { environment: "mainnet" as const, origin: BYBIT_MAINNET_ORIGIN },
  ];

  for (const { environment, origin } of cases) {
    const requests: Array<{ headers: Headers; url: string }> = [];
    const transport = createBybitPrivateTransport({
      environment,
      credentials,
      clock: () => 1_672_052_955_758,
      clockOffsetMs: 0,
      request: async (url, init) => {
        requests.push({
          headers: new Headers(init?.headers),
          url: String(url),
        });
        return new Response(
          JSON.stringify({ retCode: 0, retMsg: "", result: {} }),
          { status: 200 },
        );
      },
    });

    await transport.post("/v5/order/create", {
      category: "linear",
      symbol: "BTCUSDT",
      qty: "1",
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.url, `${origin}/v5/order/create`);
    assert.equal(
      requests[0]?.headers.get("X-BAPI-SIGN"),
      hmacSha256(
        buildSignaturePayload(
          "1672052955758",
          credentials.apiKey,
          "5000",
          JSON.stringify({
            category: "linear",
            symbol: "BTCUSDT",
            qty: "1",
          }),
        ),
        credentials.apiSecret,
      ),
    );
  }
});

test("canonical origin registry is shared with the budgeted account reader", () => {
  assert.strictEqual(ACCOUNT_READ_ORIGINS, BYBIT_CANONICAL_ORIGINS);
  assert.deepEqual(BYBIT_CANONICAL_ORIGINS, {
    demo: "https://api-demo.bybit.com",
    testnet: "https://api-testnet.bybit.com",
    mainnet: "https://api.bybit.com",
  });
});

test("Mainnet redirect is rejected without following or disclosing its target", async () => {
  let calls = 0;
  let redirectMode: RequestRedirect | undefined;
  const transport = createBybitPrivateTransport({
    environment: "mainnet",
    credentials,
    clockOffsetMs: 0,
    request: async (_url, init) => {
      calls += 1;
      redirectMode = init?.redirect;
      return new Response("", {
        status: 302,
        headers: { Location: "https://attacker.invalid/collect" },
      });
    },
  });

  await assert.rejects(
    transport.get("/v5/market/time"),
    (error: unknown) =>
      error instanceof BybitPrivateTransportError &&
      error.kind === "transport-failed" &&
      !error.message.includes("attacker.invalid"),
  );
  assert.equal(redirectMode, "error");
  assert.equal(calls, 1);
});

test("Mainnet final-origin mismatch and caller origin/path injection fail closed", async () => {
  let calls = 0;
  const transport = createBybitPrivateTransport({
    environment: "mainnet",
    credentials,
    clockOffsetMs: 0,
    request: async () => {
      calls += 1;
      const response = new Response(
        JSON.stringify({ retCode: 0, retMsg: "", result: {} }),
        { status: 200 },
      );
      Object.defineProperty(response, "url", {
        value: "https://attacker.invalid/v5/market/time",
      });
      return response;
    },
  });

  await assert.rejects(
    transport.get("/v5/market/time"),
    (error: unknown) =>
      error instanceof BybitPrivateTransportError &&
      error.kind === "invalid-response" &&
      !error.message.includes("attacker.invalid"),
  );
  assert.equal(calls, 1);

  const noRequestTransport = createBybitPrivateTransport({
    environment: "mainnet",
    credentials,
    request: async () => {
      calls += 1;
      return new Response();
    },
  });
  for (const path of [
    "https://api-demo.bybit.com/v5/market/time",
    "//api.bybit.com/v5/market/time",
    "/v5/market/../order/create",
    "/v5/market/time?origin=https://attacker.invalid",
    "/\\api.bybit.com/v5/market/time",
  ]) {
    await assert.rejects(
      noRequestTransport.get(path),
      (error: unknown) =>
        error instanceof BybitPrivateTransportError &&
        error.kind === "invalid-request",
    );
  }
  assert.equal(calls, 1);

  assert.throws(
    () =>
      createBybitPrivateTransport({
        environment: "https://attacker.invalid" as "mainnet",
        credentials,
      }),
    (error: unknown) =>
      error instanceof BybitPrivateTransportError &&
      error.kind === "invalid-request",
  );
});

test("Mainnet timeout, malformed body, 429 and clock-skew keep sanitized classifications", async () => {
  const makeTransport = (request: typeof fetch, timeoutMs = 10_000) =>
    createBybitPrivateTransport({
      environment: "mainnet",
      credentials,
      clockOffsetMs: 0,
      timeoutMs,
      request,
    });

  const timeoutTransport = makeTransport(
    async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new Error("private timeout detail")),
          { once: true },
        );
      }),
    5,
  );
  await assert.rejects(
    timeoutTransport.get("/v5/market/time"),
    (error: unknown) =>
      error instanceof BybitPrivateTransportError &&
      error.kind === "transport-failed" &&
      !error.message.includes("private timeout detail"),
  );

  const malformedTransport = makeTransport(
    async () => new Response("not-json", { status: 200 }),
  );
  await assert.rejects(
    malformedTransport.get("/v5/market/time"),
    (error: unknown) =>
      error instanceof BybitPrivateTransportError &&
      error.kind === "invalid-response",
  );

  const rateLimitedTransport = makeTransport(
    async () => new Response("{}", { status: 429 }),
  );
  await assert.rejects(
    rateLimitedTransport.get("/v5/market/time"),
    (error: unknown) =>
      error instanceof BybitPrivateTransportError &&
      error.kind === "rate-limited" &&
      error.httpStatus === 429,
  );

  const clockSkewTransport = makeTransport(
    async () =>
      new Response(
        JSON.stringify({
          retCode: 10002,
          retMsg: "clock detail must not leak",
          result: {},
        }),
        { status: 200 },
      ),
  );
  await assert.rejects(
    clockSkewTransport.get("/v5/market/time"),
    (error: unknown) =>
      error instanceof BybitPrivateTransportError &&
      error.kind === "clock-skew" &&
      error.retCode === 10002,
  );

  const invalidCredentialsTransport = makeTransport(
    async () =>
      new Response(
        JSON.stringify({
          retCode: 10003,
          retMsg: "credential detail must not leak",
          result: {},
        }),
        { status: 200 },
      ),
  );
  await assert.rejects(
    invalidCredentialsTransport.get("/v5/market/time"),
    (error: unknown) =>
      error instanceof BybitPrivateTransportError &&
      error.kind === "invalid-credentials" &&
      error.message.includes("Mainnet API credentials") &&
      !error.message.includes("Demo"),
  );
});

test("successful empty retMsg is valid and malformed envelopes fail closed", () => {
  assert.deepEqual(
    validateBybitResponse({ retCode: 0, retMsg: "", result: {} }),
    { retCode: 0, retMsg: "", result: {} },
  );
  for (const payload of [
    null,
    [],
    { retCode: 0, result: {} },
    { retCode: 0, retMsg: "", result: null },
  ]) {
    assert.throws(
      () => validateBybitResponse(payload),
      (error: unknown) =>
        error instanceof BybitDemoTransportError &&
        error.kind === "invalid-response",
    );
  }
});

test("Demo ret-code classification keeps ambiguity and rate limiting distinct", () => {
  assert.equal(classifyRetCode(10000).kind, "ambiguous-server");
  assert.equal(classifyRetCode(10016).kind, "ambiguous-server");
  assert.equal(classifyRetCode(10006).kind, "rate-limited");
  assert.equal(classifyRetCode(110072).kind, "ownership-conflict");
  assert.equal(classifyRetCode(110003).kind, "validation-failed");
});
