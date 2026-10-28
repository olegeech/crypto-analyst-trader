import assert from "node:assert/strict";
import test from "node:test";

import { runLiveHistorySync } from "../src/application/history-ingestion-composition.js";
import { domainError } from "../src/domain/shared/errors.js";
import type { CredentialProvider } from "../src/ports/credential-provider.js";
import { CredentialProviderError } from "../src/ports/credential-provider.js";
import { runHistorySyncCli } from "../src/cli/history-sync.js";
import type { openSqliteConnection } from "../src/adapters/sqlite/connection.js";

const serverMs = Date.parse("2026-10-28T12:00:00.000Z");

function response(result: Record<string, unknown>) {
  return new Response(
    JSON.stringify({
      retCode: 0,
      retMsg: "OK",
      result,
      time: serverMs,
    }),
    { status: 200 },
  );
}

function rejectedResponse(retCode: number, retMsg: string) {
  return new Response(
    JSON.stringify({ retCode, retMsg, result: {}, time: serverMs }),
    { status: 200 },
  );
}

function apiResponse(userId: string) {
  return response({
    userID: userId,
    readOnly: 0,
    permissions: { ContractTrade: ["Order", "Position"], Wallet: [], Spot: [] },
    ips: [],
    expiredAt: "0",
  });
}

function fakeProvider(accountId: string): Pick<CredentialProvider, "load"> {
  return {
    async load() {
      return {
        apiKey: "fixture-api-key",
        apiSecret: "fixture-api-secret",
        accountId,
      };
    },
  };
}

function clock() {
  let value = 0;
  return () => {
    value += 1;
    return value;
  };
}

test("verified identity mismatch stops before opening or mutating SQLite", async () => {
  let opens = 0;
  let writes = 0;
  const request: typeof fetch = async (url, init) => {
    assert.equal((init?.method ?? "GET").toUpperCase(), "GET");
    if ((init?.method ?? "GET").toUpperCase() !== "GET") writes += 1;
    const pathname = new URL(String(url)).pathname;
    if (pathname === "/v5/market/time")
      return response({ timeSecond: String(Math.floor(serverMs / 1_000)) });
    if (pathname === "/v5/user/query-api") return apiResponse("99999");
    throw new Error("unexpected route");
  };
  const result = await runLiveHistorySync(
    {
      environment: "mainnet",
      databasePath: "/tmp/history-test.db",
      selection: { kind: "resume" },
    },
    {
      credentialProvider: fakeProvider("12345"),
      request,
      utcClock: () => serverMs,
      monotonicClock: clock(),
      openConnection: (() => {
        opens += 1;
        return {
          ok: false,
          error: domainError("INVALID_VALUE", "unexpected open"),
        };
      }) as typeof openSqliteConnection,
    },
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error.message, /ACCOUNT_IDENTITY_MISMATCH/u);
    assert.equal(result.error.details?.reasonCode, "ACCOUNT_IDENTITY_MISMATCH");
    assert.equal(result.error.details?.stage, "account-identity-validation");
    assert.equal(
      result.error.details?.attemptedAction,
      "validate Bybit account identity and read permissions",
    );
    assert.equal(
      result.error.details?.nextAction,
      "Verify the selected environment and configured account ID; do not resume until they identify the same account.",
    );
  }
  assert.equal(opens, 0);
  assert.equal(writes, 0);
});

test("invalid explicit range is rejected after identity verification but before database open", async () => {
  let opens = 0;
  let getRequests = 0;
  const request: typeof fetch = async (url, init) => {
    assert.equal((init?.method ?? "GET").toUpperCase(), "GET");
    getRequests += 1;
    const pathname = new URL(String(url)).pathname;
    if (pathname === "/v5/market/time")
      return response({ timeSecond: String(Math.floor(serverMs / 1_000)) });
    if (pathname === "/v5/user/query-api") return apiResponse("12345");
    throw new Error("unexpected route");
  };
  const result = await runLiveHistorySync(
    {
      environment: "mainnet",
      databasePath: "/tmp/history-test.db",
      selection: {
        kind: "explicit-range",
        fromMs: serverMs,
        toMs: serverMs - 1,
        replayId: "invalid-range",
      },
    },
    {
      credentialProvider: fakeProvider("12345"),
      request,
      utcClock: () => serverMs,
      monotonicClock: clock(),
      openConnection: (() => {
        opens += 1;
        return {
          ok: false,
          error: domainError("INVALID_VALUE", "unexpected open"),
        };
      }) as typeof openSqliteConnection,
    },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error.message, /INVALID_ARGUMENT/u);
  assert.equal(getRequests, 3);
  assert.equal(opens, 0);
});

test("credential denial stops before any provider request or database open", async () => {
  let requests = 0;
  let opens = 0;
  const result = await runLiveHistorySync(
    {
      environment: "mainnet",
      databasePath: "/tmp/history-test.db",
      selection: { kind: "resume" },
    },
    {
      credentialProvider: {
        async load() {
          throw new Error("private keychain failure");
        },
      },
      request: async () => {
        requests += 1;
        return response({});
      },
      utcClock: () => serverMs,
      monotonicClock: clock(),
      openConnection: (() => {
        opens += 1;
        return {
          ok: false,
          error: domainError("INVALID_VALUE", "unexpected open"),
        };
      }) as typeof openSqliteConnection,
    },
  );
  assert.equal(result.ok, false);
  assert.equal(requests, 0);
  assert.equal(opens, 0);
});

test("typed credential failures retain distinct safe operator guidance", async () => {
  for (const [credentialCode, reasonCode, nextAction] of [
    [
      "missing",
      "CREDENTIALS_MISSING",
      "Configure the mainnet Bybit credentials, then rerun history sync.",
    ],
    [
      "inaccessible",
      "CREDENTIALS_INACCESSIBLE",
      "Unlock the macOS Keychain or approve its prompt, then rerun history sync.",
    ],
  ] as const) {
    const result = await runLiveHistorySync(
      {
        environment: "mainnet",
        databasePath: "/tmp/history-test.db",
        selection: { kind: "resume" },
      },
      {
        credentialProvider: {
          async load() {
            throw new CredentialProviderError(
              credentialCode,
              "private keychain detail must not be printed",
            );
          },
        },
        request: async () => {
          throw new Error("credential failure must precede network access");
        },
        utcClock: () => serverMs,
        monotonicClock: clock(),
      },
    );
    assert.equal(result.ok, false);
    if (result.ok) continue;
    assert.equal(result.error.details?.reasonCode, reasonCode);
    assert.equal(result.error.details?.stage, "credential-load");
    assert.equal(result.error.details?.exchangeReads, 0);
    assert.equal(result.error.details?.nextAction, nextAction);
    assert.doesNotMatch(result.error.message, /private keychain detail/u);
  }
});

test("Bybit rejection code and safe explanation survive composition into CLI", async () => {
  let opens = 0;
  const result = await runLiveHistorySync(
    {
      environment: "mainnet",
      databasePath: "/tmp/history-test.db",
      selection: { kind: "resume" },
    },
    {
      credentialProvider: fakeProvider("12345"),
      request: async () =>
        rejectedResponse(10006, "private account payload must not be printed"),
      utcClock: () => serverMs,
      monotonicClock: clock(),
      openConnection: (() => {
        opens += 1;
        return {
          ok: false,
          error: domainError("INVALID_VALUE", "unexpected open"),
        };
      }) as typeof openSqliteConnection,
    },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.details?.stage, "server-time-read");
  assert.equal(
    result.error.details?.attemptedAction,
    "read Bybit server time for signed requests",
  );
  assert.equal(result.error.details?.providerRetCode, 10006);
  assert.equal(result.error.details?.httpStatus, 200);
  assert.equal(result.error.details?.exchangeReads, 1);

  let output = "";
  const code = await runHistorySyncCli(
    [
      "--mode",
      "live",
      "--environment",
      "mainnet",
      "--database",
      "/tmp/history-test.db",
      "--range",
      "resume",
    ],
    {
      output: { write: (text) => (output += text) },
      runLive: async () => result,
    },
  );
  assert.equal(code, 1);
  assert.match(output, /REASON=RATE_LIMITED/u);
  assert.match(output, /STAGE=server-time-read/u);
  assert.match(output, /PROVIDER_RET_CODE=10006/u);
  assert.match(output, /HTTP_STATUS=200/u);
  assert.match(output, /EXCHANGE_READS=1/u);
  assert.match(output, /NEXT_ACTION=Wait for the Bybit rate window/u);
  assert.doesNotMatch(output, /private account payload/u);
  assert.equal(opens, 0);
});
