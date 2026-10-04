import assert from "node:assert/strict";
import test from "node:test";

import { createBybitRiskEvidenceReader } from "../src/adapters/bybit-v5/risk-evidence-reader.js";
import { BybitAccountReadError } from "../src/adapters/bybit-v5/account-read-transport.js";

const credentials = {
  apiKey: "synthetic-key",
  apiSecret: "synthetic-secret",
  accountId: "123",
};
const observedAt = Date.parse("2026-10-02T12:00:03.000Z");

function response(result: Record<string, unknown>, time = observedAt) {
  return new Response(
    JSON.stringify({ retCode: 0, retMsg: "private-sentinel", result, time }),
    { headers: { "content-type": "application/json" } },
  );
}

function scriptedReader(position: Record<string, unknown> = {}) {
  const requests: { url: string; init: RequestInit }[] = [];
  const reader = createBybitRiskEvidenceReader({
    environment: "demo",
    credentials,
    request: async (input, init) => {
      const url = String(input);
      requests.push({ url, init: init ?? {} });
      const path = new URL(url).pathname;
      if (path === "/v5/market/time")
        return response({ timeNano: String(BigInt(observedAt) * 1000000n) });
      if (path === "/v5/user/query-api")
        return response({
          userID: 123,
          readOnly: 1,
          permissions: { ContractTrade: [], Spot: [], Wallet: [] },
          ips: [],
          expiredAt: "",
        });
      if (path === "/v5/position/list")
        return response({
          category: "linear",
          list: [
            {
              symbol: "BTCUSDT",
              positionIdx: 0,
              side: "",
              size: "0",
              leverage: "1",
              seq: "-1",
              ...position,
            },
          ],
          nextPageCursor: "",
        });
      return response({});
    },
  });
  return { reader, requests };
}

test("reader uses only pinned GET endpoints and preserves provider position time", async () => {
  const { reader, requests } = scriptedReader();
  const identity = await reader.readIdentity();
  assert.equal(identity.result.userID, 123);
  const snapshot = await reader.readTargetPositions("BTCUSDT");
  assert.equal(snapshot.rows.length, 1);
  assert.equal(snapshot.rows[0]?.symbol, "BTCUSDT");
  assert.equal(snapshot.rows[0]?.leverage.state, "known");
  assert.equal(snapshot.observedAt, "2026-10-02T12:00:03.000Z");
  assert.equal(await reader.readExchangeTime(), "2026-10-02T12:00:03.000Z");

  assert.deepEqual(
    requests.map(({ url }) => new URL(url).pathname),
    [
      "/v5/market/time",
      "/v5/user/query-api",
      "/v5/position/list",
      "/v5/market/time",
    ],
  );
  for (const request of requests) {
    assert.equal(request.init.method, "GET");
    assert.equal(request.init.redirect, "error");
    assert.equal(new URL(request.url).origin, "https://api-demo.bybit.com");
  }
  const positionRequest = requests.find((request) =>
    request.url.includes("/v5/position/list"),
  );
  assert.ok(positionRequest);
  const query = new URL(positionRequest.url).searchParams;
  assert.equal(query.get("category"), "linear");
  assert.equal(query.get("symbol"), "BTCUSDT");
  assert.equal(query.has("cursor"), false);
  assert.equal(reader.requestCount(), requests.length);
  assert.equal(
    requests.some(({ url }) =>
      /order|execution|create|cancel|amend/u.test(url),
    ),
    false,
  );
  assert.doesNotMatch(
    JSON.stringify({ identity, snapshot }),
    /private-sentinel|synthetic-secret/u,
  );
});

test("selected account environment controls origin and private signing only", async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const reader = createBybitRiskEvidenceReader({
    environment: "testnet",
    credentials,
    request: async (input, init) => {
      const url = String(input);
      requests.push({ url, init: init ?? {} });
      const path = new URL(url).pathname;
      if (path === "/v5/market/time")
        return response({ timeNano: String(BigInt(observedAt) * 1000000n) });
      if (path === "/v5/user/query-api")
        return response({
          userID: 123,
          readOnly: 1,
          permissions: { ContractTrade: [], Spot: [], Wallet: [] },
          ips: [],
          expiredAt: "",
        });
      return response({ category: "linear", list: [], nextPageCursor: "" });
    },
  });
  await reader.readIdentity();
  assert.equal(reader.environment, "testnet");
  assert.equal(reader.origin, "https://api-testnet.bybit.com");
  assert.ok(
    requests.every(
      ({ url }) => new URL(url).origin === "https://api-testnet.bybit.com",
    ),
  );
  const publicTimeHeaders = requests
    .filter(({ url }) => new URL(url).pathname === "/v5/market/time")
    .map(({ init }) => new Headers(init.headers));
  assert.ok(
    publicTimeHeaders.every(
      (headers) =>
        !headers.has("X-BAPI-API-KEY") && !headers.has("X-BAPI-SIGN"),
    ),
  );
});

test("position identity mismatch and missing exact provider time fail closed", async () => {
  const wrong = scriptedReader({ symbol: "ETHUSDT" });
  await assert.rejects(
    wrong.reader.readTargetPositions("BTCUSDT"),
    (error: unknown) =>
      error instanceof BybitAccountReadError &&
      error.code === "INVALID_RESPONSE",
  );

  const missingTime = createBybitRiskEvidenceReader({
    environment: "demo",
    credentials,
    request: async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v5/market/time")
        return response({ timeNano: String(BigInt(observedAt) * 1000000n) });
      return new Response(
        JSON.stringify({
          retCode: 0,
          retMsg: "OK",
          result: { category: "linear", list: [], nextPageCursor: "" },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  await assert.rejects(
    missingTime.readTargetPositions("BTCUSDT"),
    (error: unknown) =>
      error instanceof BybitAccountReadError &&
      error.code === "INVALID_RESPONSE",
  );
});
