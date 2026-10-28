import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { captureHistoryAccountingAnchor } from "../src/application/history-accounting-anchor-capture.js";
import { openSqliteConnection } from "../src/adapters/sqlite/connection.js";
import { createSqliteHistoryAccountingWalletAnchorStore } from "../src/adapters/sqlite/history-accounting-anchor-store.js";
import type { CredentialProvider } from "../src/ports/credential-provider.js";
import { ok } from "../src/domain/shared/result.js";
import type { UtcTimestamp } from "../src/domain/shared/time.js";
import { HISTORY_ACCOUNTING_TEST_AUTH_KEY } from "./history-accounting-fixtures.js";

const serverStart = Date.parse("2026-10-28T09:00:00.000Z");
const runtime = { nodeVersion: "22.22.3", sqliteVersion: "3.51.3" } as const;
const credentials: Pick<CredentialProvider, "load"> = {
  async load(environment) {
    assert.equal(environment, "demo");
    return {
      apiKey: "fixture-api-key",
      apiSecret: "fixture-api-secret",
      accountId: "12345",
    };
  },
};
const anchorKeyProvider = {
  async getOrCreate() {
    return ok(HISTORY_ACCOUNTING_TEST_AUTH_KEY);
  },
};

function response(result: Record<string, unknown>, time: number): Response {
  return new Response(
    JSON.stringify({ retCode: 0, retMsg: "OK", result, time }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

// Sanitized response shapes follow the official wallet and API-key info docs.
// `isFixApi` is retained here as a documented newer extra field.
// https://bybit-exchange.github.io/docs/v5/account/wallet-balance
// https://bybit-exchange.github.io/docs/v5/user/apikey-info
function walletResult(balance = "100"): Record<string, unknown> {
  return {
    list: [
      {
        accountType: "UNIFIED",
        totalEquity: balance,
        totalWalletBalance: balance,
        totalMarginBalance: balance,
        totalPerpUPL: "0",
        totalAvailableBalance: balance,
        totalInitialMargin: "0",
        totalInitialMarginByMp: "0",
        totalMaintenanceMargin: "0",
        totalMaintenanceMarginByMp: "0",
        accountIMRate: "0",
        accountIMRateByMp: "0",
        accountMMRate: "0",
        accountMMRateByMp: "0",
        accountLTV: "0",
        coin: [
          {
            coin: "USDT",
            walletBalance: balance,
            equity: balance,
            usdValue: balance,
            locked: "0",
            spotHedgingQty: "0",
            bonus: "0",
            borrowAmount: "0",
            spotBorrow: "0",
            accruedInterest: "0",
            totalOrderIM: "0",
            totalPositionIM: "0",
            totalPositionMM: "0",
            unrealisedPnl: "0",
            cumRealisedPnl: "0",
            availableToBorrow: "",
            availableToWithdraw: "0",
            marginCollateral: true,
            collateralSwitch: true,
            colRes: "0",
          },
        ],
      },
    ],
  };
}

function fakeExchange(
  options: {
    readonly identity?: string;
    readonly walletTimeDelta?: number;
  } = {},
) {
  let gets = 0;
  let writes = 0;
  const seenPaths: string[] = [];
  const request: typeof fetch = async (input, init) => {
    gets += 1;
    if ((init?.method ?? "GET") !== "GET") writes += 1;
    const url = new URL(String(input));
    seenPaths.push(url.pathname);
    assert.equal(url.origin, "https://api-demo.bybit.com");
    assert.equal(init?.redirect, "error");
    const time = serverStart + (gets - 1) * 10;
    if (url.pathname === "/v5/market/time")
      return response(
        {
          timeSecond: String(Math.floor(time / 1_000)),
          timeNano: String(BigInt(time) * 1_000_000n),
        },
        time,
      );
    if (url.pathname === "/v5/user/query-api")
      return response(
        {
          id: "fixture-key-id",
          note: "sanitized fixture",
          apiKey: "fixture-provider-api-key",
          readOnly: 1,
          secret: "",
          permissions: {
            ContractTrade: ["Order", "Position"],
            Spot: ["SpotTrade"],
            Wallet: ["AccountTransfer"],
            Options: [],
            Derivatives: ["DerivativesTrade"],
            Exchange: [],
            Earn: [],
            FiatP2P: [],
            FiatBitPay: [],
            FiatConvertBroker: [],
            BitCard: [],
            ByXPost: [],
            Affiliate: [],
            BlockTrade: [],
            NFT: [],
            CopyTrading: [],
          },
          ips: ["192.0.2.10"],
          type: 1,
          deadlineDay: 30,
          expiredAt: "0",
          createdAt: "2026-10-01T00:00:00Z",
          uta: 1,
          userID: options.identity ?? 12345,
          userIDInt64: options.identity ?? "12345",
          parentUid: "0",
          isMaster: true,
          isFixApi: false,
        },
        time,
      );
    if (url.pathname === "/v5/account/wallet-balance")
      return response(walletResult(), time + (options.walletTimeDelta ?? 0));
    throw new Error(`unexpected route ${url.pathname}`);
  };
  return {
    request,
    seenPaths,
    get gets() {
      return gets;
    },
    get writes() {
      return writes;
    },
  };
}

function tempDb() {
  const root = mkdtempSync(join(tmpdir(), "history-accounting-capture-"));
  const databasePath = join(root, "account.db");
  const clock = {
    now: () => new Date(serverStart + 10_000).toISOString() as UtcTimestamp,
  };
  return { root, databasePath, clock };
}

test("explicit anchor capture uses only authenticated GETs and survives SQLite reopen", async () => {
  const temp = tempDb();
  const exchange = fakeExchange();
  try {
    const captured = await captureHistoryAccountingAnchor(
      { environment: "demo", databasePath: temp.databasePath, kind: "opening" },
      {
        credentialProvider: credentials,
        anchorKeyProvider,
        request: exchange.request,
        utcClock: () => serverStart - 5_000,
        monotonicClock: (() => {
          let value = 0;
          return () => ++value;
        })(),
        openConnection: (options) =>
          openSqliteConnection({
            ...options,
            runtime,
            clock: temp.clock,
          }),
        createAnchorId: () => "capture-opening-1",
      },
    );
    assert.equal(captured.ok, true, captured.ok ? "" : captured.error.message);
    if (!captured.ok) return;
    assert.equal(captured.value.getAttempts, 5);
    assert.equal(exchange.gets, 5);
    assert.equal(exchange.writes, 0);
    assert.deepEqual(exchange.seenPaths, [
      "/v5/market/time",
      "/v5/market/time",
      "/v5/user/query-api",
      "/v5/account/wallet-balance",
      "/v5/market/time",
    ]);
    const anchor = captured.value.anchor;
    assert.equal(
      anchor.capture.collectionStartedAt,
      anchor.capture.providerTimeBefore,
    );
    assert.ok(
      Date.parse(anchor.capture.collectionStartedAt) <=
        Date.parse(anchor.capture.identityObservedAt),
    );
    assert.ok(
      Date.parse(anchor.capture.identityObservedAt) <=
        Date.parse(anchor.capture.providerResponseTime),
    );
    assert.ok(
      Date.parse(anchor.capture.providerResponseTime) <=
        Date.parse(anchor.capture.collectionEndedAt),
    );
    assert.equal(anchor.assets[0]?.coin, "USDT");
    assert.equal(anchor.assets[0]?.walletBalance.state, "known");

    const reopened = openSqliteConnection({
      environment: "demo",
      databasePath: temp.databasePath,
      runtime,
      clock: temp.clock,
    });
    assert.equal(reopened.ok, true);
    if (!reopened.ok) return;
    const read = createSqliteHistoryAccountingWalletAnchorStore(
      reopened.value,
      HISTORY_ACCOUNTING_TEST_AUTH_KEY,
    ).readById("capture-opening-1");
    assert.equal(read.ok, true);
    assert.equal(read.ok && JSON.stringify(read.value), JSON.stringify(anchor));
    assert.equal(read.ok && read.value?.recordedAt, temp.clock.now());
    const raw = readFileSync(temp.databasePath, "utf8");
    assert.equal(raw.includes("fixture-api-secret"), false);
    assert.equal(raw.includes("fixture-provider-api-key"), false);
    assert.equal(raw.includes("12345"), false);
    reopened.value.close();
  } finally {
    rmSync(temp.root, { recursive: true, force: true });
  }
});

test("identity mismatch stops before opening SQLite and never writes", async () => {
  let opens = 0;
  const exchange = fakeExchange({ identity: "99999" });
  const result = await captureHistoryAccountingAnchor(
    { environment: "demo", databasePath: "/tmp/no-open.db", kind: "opening" },
    {
      credentialProvider: credentials,
      anchorKeyProvider,
      request: exchange.request,
      utcClock: () => serverStart - 5_000,
      monotonicClock: (() => {
        let value = 0;
        return () => ++value;
      })(),
      openConnection: (() => {
        opens += 1;
        throw new Error("must not open");
      }) as typeof openSqliteConnection,
    },
  );
  assert.equal(result.ok, false);
  assert.equal(exchange.writes, 0);
  assert.equal(opens, 0);
  assert.equal(exchange.gets, 3);
});

test("ambiguous provider-time order blocks persistence", async () => {
  let opens = 0;
  const exchange = fakeExchange({ walletTimeDelta: -100 });
  const result = await captureHistoryAccountingAnchor(
    { environment: "demo", databasePath: "/tmp/no-open.db", kind: "opening" },
    {
      credentialProvider: credentials,
      anchorKeyProvider,
      request: exchange.request,
      utcClock: () => serverStart - 5_000,
      monotonicClock: (() => {
        let value = 0;
        return () => ++value;
      })(),
      openConnection: (() => {
        opens += 1;
        throw new Error("must not open");
      }) as typeof openSqliteConnection,
    },
  );
  assert.equal(result.ok, false);
  assert.equal(exchange.writes, 0);
  assert.equal(opens, 0);
  assert.equal(exchange.gets, 5);
});
