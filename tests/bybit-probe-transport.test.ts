import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  buildSignaturePayload,
  classifyRetCode,
  createBybitProbeTransport,
  hmacSha256,
  validateBybitResponse,
} from "../scripts/bybit-probe/transport.js";

const credentials = {
  apiKey: "synthetic-api-key",
  apiSecret: "synthetic-api-secret",
  accountId: "Trading",
};

test("Bybit HMAC pre-sign strings preserve the exact GET and POST bytes", () => {
  assert.equal(
    buildSignaturePayload(
      "1672052955758",
      "api-key",
      "5000",
      "category=linear&symbol=BTCUSDT",
    ),
    "1672052955758api-key5000category=linear&symbol=BTCUSDT",
  );
  const body = '{"category":"linear","symbol":"BTCUSDT","qty":"1"}';
  assert.equal(
    buildSignaturePayload("1672052955758", "api-key", "5000", body),
    `1672052955758api-key5000${body}`,
  );
});

test("HMAC digest is the independently calculated lowercase hexadecimal value", () => {
  const payload =
    "1672052955758synthetic-api-key5000category=linear&symbol=BTCUSDT";
  const expected = createHmac("sha256", credentials.apiSecret)
    .update(payload)
    .digest("hex");
  assert.equal(hmacSha256(payload, credentials.apiSecret), expected);
});

test("retCode classification keeps signing defects separate from credential recovery", () => {
  const expectations = new Map([
    [10000, ["exchange-failure", false]],
    [10002, ["clock-skew", false]],
    [10004, ["signing-defect", false]],
    [10003, ["invalid-credentials", true]],
    [33004, ["expired-credentials", true]],
    [10005, ["permission-denied", true]],
    [10010, ["ip-restriction", false]],
    [10024, ["exchange-failure", false]],
  ] as const);
  for (const [code, [kind, reconnect]] of expectations) {
    const failure = classifyRetCode(code);
    assert.equal(failure.kind, kind);
    assert.equal(failure.recommendReconnect, reconnect);
  }
  assert.equal(classifyRetCode(99999).kind, "exchange-failure");
  assert.equal(
    classifyRetCode(10004).message.includes("credentials:connect:testnet"),
    false,
  );
  assert.match(classifyRetCode(10003).message, /credentials:connect:testnet/);
  assert.match(classifyRetCode(10024).message, /compliance rules/i);
  assert.match(classifyRetCode(10000).message, /ambiguous/i);
});

test("invalid response shapes fail before evidence can be consumed", () => {
  assert.deepEqual(
    validateBybitResponse({ retCode: 0, retMsg: "OK", result: { list: [] } }),
    { retCode: 0, retMsg: "OK", result: { list: [] } },
  );
  for (const payload of [
    null,
    [],
    { retCode: "zero", retMsg: "OK", result: {} },
    { retCode: 0, result: {} },
    { retCode: 0, retMsg: "OK", result: null },
  ]) {
    assert.throws(
      () => validateBybitResponse(payload),
      /invalid Bybit response/,
    );
  }
});

test("the transmitted POST body is the body that was signed", async () => {
  const requests: Array<{ body: string; headers: Headers }> = [];
  const clock = () => 1_672_052_955_758;
  const transport = createBybitProbeTransport({
    baseUrl: new URL("https://api-testnet.bybit.com/"),
    credentials,
    clock,
    request: async (_url, init) => {
      requests.push({
        body: String(init?.body ?? ""),
        headers: new Headers(init?.headers),
      });
      return new Response(
        JSON.stringify({
          retCode: 0,
          retMsg: "OK",
          result: { orderId: "safe-id" },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    },
    clockOffsetMs: 0,
  });
  const body = { category: "linear", symbol: "BTCUSDT", qty: "1" };
  await transport.post("/v5/order/create", body);

  assert.equal(requests[0]?.body, JSON.stringify(body));
  assert.equal(
    requests[0]?.headers.get("X-BAPI-SIGN"),
    hmacSha256(
      buildSignaturePayload(
        String(clock()),
        credentials.apiKey,
        "5000",
        requests[0]?.body ?? "",
      ),
      credentials.apiSecret,
    ),
  );
});

test("a measured server offset is applied to later signed timestamps", async () => {
  for (const delta of [450, -450]) {
    const timestamps: string[] = [];
    let call = 0;
    const localTime = 1_700_000_000_000;
    const transport = createBybitProbeTransport({
      baseUrl: new URL("https://api-testnet.bybit.com/"),
      credentials,
      clock: () => localTime,
      request: async (_url, init) => {
        call += 1;
        if (call === 2) {
          timestamps.push(
            String(new Headers(init?.headers).get("X-BAPI-TIMESTAMP")),
          );
        }
        return new Response(
          JSON.stringify(
            call === 1
              ? {
                  retCode: 0,
                  retMsg: "OK",
                  time: localTime + delta,
                  result: {},
                }
              : { retCode: 0, retMsg: "OK", result: {} },
          ),
          { status: 200 },
        );
      },
    });
    await transport.post("/v5/order/create", "{}");
    assert.equal(Number(timestamps[0]), localTime + delta);
  }
});
