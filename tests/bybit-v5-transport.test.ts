import assert from "node:assert/strict";
import test from "node:test";

import {
  BYBIT_DEMO_ORIGIN,
  BybitDemoTransportError,
  buildSignaturePayload,
  classifyRetCode,
  createBybitDemoTransport,
  hmacSha256,
  validateBybitResponse,
} from "../src/adapters/bybit-v5/transport.js";

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
