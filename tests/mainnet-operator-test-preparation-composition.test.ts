import assert from "node:assert/strict";
import test from "node:test";
import { prepareMainnetOperatorTest } from "../src/application/mainnet-operator-test-preparation-composition.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqlitePersistence } from "../src/adapters/sqlite/sqlite-persistence.js";
import {
  createOperatorMainnetRecoveryAttestation,
  type OperatorMainnetRecoveryAttestation,
} from "../src/domain/execution/operator-mainnet-recovery.js";
import { hashCanonical } from "../src/domain/identity/canonical-serialization.js";
import {
  accountInfoResponse,
  walletResponse,
  collateralResponse,
  tierResponse,
} from "./fixtures/bybit-account/read-fixtures.js";

const roots: string[] = [];
test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const now = Date.parse("2026-10-25T12:00:00.000Z");
const input = {
  symbol: "DOGEUSDT",
  allocation: "10",
  grossNotionalCap: "10",
  maxDeviationBps: "10",
};

function groupedFromFetchAttempts(paths: readonly string[]) {
  const groups: Readonly<Record<string, string>> = {
    "/v5/market/time": "time",
    "/v5/user/query-api": "identity",
    "/v5/account/info": "account",
    "/v5/account/wallet-balance": "wallet",
    "/v5/account/collateral-info": "collateral",
    "/v5/spot-margin-trade/collateral": "collateral-tiers",
    "/v5/position/list": "positions",
    "/v5/order/realtime": "open-orders",
    "/v5/order/history": "order-history",
    "/v5/execution/list": "executions",
    "/v5/market/instruments-info": "instruments",
    "/v5/market/option-base-coins": "option-discovery",
    "/v5/market/tickers": "quote",
    "/v5/account/fee-rate": "fees",
  };
  const counts: Record<string, number> = {};
  for (const path of paths) {
    const group = groups[path] ?? "other";
    counts[group] = (counts[group] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
  );
}

async function prepare(options: {
  balance: string;
  fee?: string;
  feeReadThrows?: boolean;
  feeAge?: number;
  balanceAge?: number;
  unknownFirstBalance?: boolean;
  readOnly?: boolean;
  changingBalance?: boolean;
  changingAssetSnapshot?: boolean;
  nonTargetPositionUnknownMargin?: boolean;
  nonTargetActiveOrderUnknownPrice?: boolean;
  accountInfoStatus?: 5 | 6;
  accountInfoNoTime?: boolean;
  accountInfoUpdatedTime?: string;
  stageCostPerAttemptMs?: number;
  failPositionRead?: boolean;
  failOpenOrdersRead?: boolean;
  recoveryAttestation?: OperatorMainnetRecoveryAttestation;
  stageMonotonicClock?: () => number;
}) {
  const root = mkdtempSync(join(tmpdir(), "operator-prepare-capacity-"));
  roots.push(root);
  const paths: string[] = [];
  const attempts: Array<{
    readonly path: string;
    readonly cursorPage: boolean;
    readonly retry: boolean;
    outcome: "ok" | "rejected";
  }> = [];
  let opened = 0;
  let wallets = 0;
  let feeAttempts = 0;
  let stageClockCalls = 0;
  const stageStart = 10_000;
  const stageMonotonicClock =
    options.stageMonotonicClock ??
    (options.stageCostPerAttemptMs === undefined
      ? undefined
      : () =>
          stageClockCalls++ === 0
            ? stageStart
            : stageStart + paths.length * options.stageCostPerAttemptMs!);
  const result = await prepareMainnetOperatorTest(
    {
      ...input,
      ...(options.recoveryAttestation
        ? {
            recoveryAttestationHash: options.recoveryAttestation.contentHash,
            recoveryAttestation: options.recoveryAttestation,
          }
        : {}),
    },
    {
      utcClock: () => now,
      ...(stageMonotonicClock === undefined ? {} : { stageMonotonicClock }),
      credentialProvider: {
        load: async () => ({
          apiKey: "synthetic-key",
          apiSecret: "synthetic-secret",
          accountId: "123",
        }),
      },
      openPersistence: (settings) => {
        opened++;
        return openSqlitePersistence({
          ...settings,
          rootDirectory: root,
          runtime: { nodeVersion: "22.22.3", sqliteVersion: "3.51.3" },
        });
      },
      request: async (url, init) => {
        assert.equal(init?.method ?? "GET", "GET");
        const target = new URL(String(url));
        const path = target.pathname;
        paths.push(path);
        if (
          ![
            "/v5/market/time",
            "/v5/user/query-api",
            "/v5/account/info",
            "/v5/account/wallet-balance",
            "/v5/account/fee-rate",
            "/v5/market/instruments-info",
            "/v5/market/tickers",
            "/v5/position/list",
            "/v5/account/collateral-info",
            "/v5/spot-margin-trade/collateral",
            "/v5/market/option-base-coins",
            "/v5/order/realtime",
            "/v5/order/history",
            "/v5/execution/list",
          ].includes(path)
        ) {
          attempts.push({
            path,
            cursorPage: target.searchParams.has("cursor"),
            retry: false,
            outcome: "rejected",
          });
          throw new Error("unmatched synthetic fetch path");
        }
        const retry = path === "/v5/account/fee-rate" && feeAttempts > 0;
        const attempt: (typeof attempts)[number] = {
          path,
          cursorPage: target.searchParams.has("cursor"),
          retry,
          outcome: "ok" as const,
        };
        attempts.push(attempt);
        if (
          (options.failPositionRead && path === "/v5/position/list") ||
          (options.failOpenOrdersRead && path === "/v5/order/realtime")
        ) {
          attempt.outcome = "rejected";
          throw new Error("synthetic target-state read failure");
        }
        let time = now;
        let result: Record<string, unknown> = { list: [], nextPageCursor: "" };
        switch (path) {
          case "/v5/market/time":
            result = {
              timeSecond: String(now / 1000),
              timeNano: String(BigInt(now) * 1_000_000n),
            };
            break;
          case "/v5/user/query-api":
            result = {
              userID: 123,
              readOnly: options.readOnly ? 1 : 0,
              permissions: {
                ContractTrade: ["Order", "Position"],
                Spot: [],
                Wallet: [],
              },
              ips: ["127.0.0.1"],
              expiredAt: "",
            };
            break;
          case "/v5/account/info":
            result = structuredClone(accountInfoResponse.result);
            result.unifiedMarginStatus = options.accountInfoStatus ?? 5;
            if (options.accountInfoUpdatedTime !== undefined)
              result.updatedTime = options.accountInfoUpdatedTime;
            break;
          case "/v5/account/wallet-balance": {
            wallets++;
            result = structuredClone(walletResponse.result);
            const rows = result.list as Record<string, unknown>[];
            const changedAssetSnapshot =
              options.changingAssetSnapshot && wallets === 2;
            rows[0]!.coin = options.changingAssetSnapshot
              ? [
                  {
                    coin: "USDC",
                    walletBalance: changedAssetSnapshot ? "99" : "100",
                    equity: changedAssetSnapshot ? "99" : "100",
                    usdValue: changedAssetSnapshot ? "99" : "100",
                    locked: "0",
                    bonus: "0",
                    borrowAmount: "0",
                    spotBorrow: "0",
                    accruedInterest: "0",
                    totalOrderIM: "0",
                    totalPositionIM: "0",
                    totalPositionMM: "0",
                    unrealisedPnl: "0",
                    marginCollateral: true,
                    collateralSwitch: true,
                  },
                ]
              : [];
            if (changedAssetSnapshot) {
              rows[0]!.totalEquity = "99";
              rows[0]!.totalWalletBalance = "99";
              rows[0]!.totalMarginBalance = "99";
            }
            rows[0]!.totalAvailableBalance =
              options.unknownFirstBalance && wallets === 1
                ? ""
                : options.changingBalance && wallets === 2
                  ? "12"
                  : options.balance;
            time -= options.balanceAge ?? 0;
            break;
          }
          case "/v5/account/fee-rate":
            feeAttempts++;
            if (options.feeReadThrows) {
              attempt.outcome = "rejected";
              throw new Error("PRIVATE_FEE_RESPONSE");
            }
            result = {
              list: [
                {
                  symbol: input.symbol,
                  makerFeeRate: "0.0002",
                  takerFeeRate: options.fee ?? "0.001",
                },
              ],
            };
            time -= options.feeAge ?? 0;
            break;
          case "/v5/market/instruments-info":
            result = {
              category: "linear",
              list: [
                {
                  symbol: input.symbol,
                  status: "Trading",
                  contractType: "LinearPerpetual",
                  quoteCoin: "USDT",
                  settleCoin: "USDT",
                  priceFilter: {
                    tickSize: "0.0001",
                    minPrice: "0.0001",
                    maxPrice: "1000",
                  },
                  lotSizeFilter: {
                    qtyStep: "1",
                    minOrderQty: "1",
                    maxOrderQty: "100000",
                    minNotionalValue: "5",
                  },
                },
              ],
              nextPageCursor: "",
            };
            break;
          case "/v5/market/tickers":
            result = {
              category: "linear",
              list: [
                {
                  symbol: input.symbol,
                  bid1Price: "0.1",
                  ask1Price: "0.1001",
                  lastPrice: "0.1",
                },
              ],
            };
            break;
          case "/v5/position/list": {
            const targetSymbol = target.searchParams.get("symbol");
            const includeNonTarget =
              options.nonTargetPositionUnknownMargin &&
              target.searchParams.get("category") === "linear" &&
              target.searchParams.get("settleCoin") === "USDT" &&
              targetSymbol === null;
            result = {
              category: target.searchParams.get("category"),
              list: [
                ...(targetSymbol === input.symbol
                  ? [
                      {
                        symbol: input.symbol,
                        positionIdx: 0,
                        side: "",
                        size: "0",
                        leverage: "1",
                      },
                    ]
                  : []),
                ...(includeNonTarget
                  ? [
                      {
                        symbol: "BTCUSDT",
                        positionIdx: 0,
                        side: "Buy",
                        size: "1",
                        avgPrice: "100",
                        positionValue: "100",
                        positionIM: "",
                        leverage: "2",
                      },
                    ]
                  : []),
              ],
              nextPageCursor: "",
            };
            break;
          }
          case "/v5/account/collateral-info":
            result = structuredClone(collateralResponse.result);
            break;
          case "/v5/spot-margin-trade/collateral":
            result = structuredClone(tierResponse.result);
            break;
          case "/v5/market/option-base-coins":
            result = { list: [{ baseCoin: "ETH", hasSymbol: 0 }] };
            break;
        }
        if (
          path === "/v5/market/instruments-info" &&
          target.searchParams.get("category") === "option"
        )
          result = { category: "option", list: [], nextPageCursor: "" };
        if (
          [
            "/v5/order/realtime",
            "/v5/order/history",
            "/v5/execution/list",
          ].includes(path)
        )
          result.category = target.searchParams.get("category");
        if (
          options.nonTargetActiveOrderUnknownPrice &&
          path === "/v5/order/realtime" &&
          target.searchParams.get("category") === "linear" &&
          target.searchParams.get("settleCoin") === "USDT"
        )
          result.list = [
            {
              symbol: "BTCUSDT",
              orderId: "other-linear-order",
              orderLinkId: "",
              orderStatus: "New",
              side: "Buy",
              orderType: "Limit",
              qty: "1",
              price: "",
              cumExecQty: "0",
              leavesQty: "1",
              positionIdx: 0,
              reduceOnly: false,
              createdTime: String(now),
            },
          ];
        attempt.outcome = "ok";
        return new Response(
          JSON.stringify({
            retCode: 0,
            retMsg: "OK",
            ...(options.accountInfoNoTime && path === "/v5/account/info"
              ? {}
              : { time }),
            result,
          }),
          { status: 200 },
        );
      },
    },
  );
  return { result, paths, attempts, opened, root };
}

function manualRecoveryAttestation(
  observedAt = new Date(now - 1_000).toISOString(),
): OperatorMainnetRecoveryAttestation {
  const accountIdentity = hashCanonical({
    exchange: "bybit",
    environment: "mainnet",
    userID: "123",
  });
  assert.equal(accountIdentity.ok, true);
  if (!accountIdentity.ok) throw new Error("synthetic account hash failed");
  const result = createOperatorMainnetRecoveryAttestation({
    provenance: "MANUAL_ATTESTED_NOT_API_VERIFIED",
    exchange: "bybit",
    environment: "mainnet",
    accountIdentityHash: accountIdentity.value,
    sourceId: "operator-mainnet-test:prior-source",
    sourcePlanHash: `sha256:${"b".repeat(64)}`,
    sourceIntentId: "prior-intent",
    sourceRevision: 1,
    actor: "operator-test",
    observedAt,
    inspection: {
      accountOpenOrdersInspected: true,
      accountOpenOrders: [],
      accountPositionsInspected: true,
      accountPositions: [],
      sourceOrderHistoryInspected: true,
      sourceOrders: [
        {
          orderId: "prior-entry",
          clientOrderId: "prior-entry-client",
          symbol: input.symbol,
          side: "Buy",
          orderType: "Limit",
          quantity: "1",
          price: "0.1",
          status: "Cancelled",
        },
      ],
      sourceFillsInspected: true,
      sourceFills: [],
      sourcePositionInspected: true,
      sourcePosition: null,
      targetLeverage: "1",
      sourceTakeProfitInspected: true,
      sourceTakeProfitOrders: [],
    },
    manualActions: ["none"],
    acceptedUncertainty: ["manual-ui-may-be-stale"],
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("synthetic recovery attestation invalid");
  return result.value;
}

test("prepare blocks fee-inclusive insufficiency before target state and prepared persistence", async () => {
  for (const balance of ["0", "10"]) {
    const run = await prepare({ balance });
    assert.equal(run.result.ok, false);
    if (run.result.ok) return;
    assert.equal(
      run.result.error.details?.reasonCode,
      "AVAILABLE_MARGIN_OR_FEE_RESERVE_INSUFFICIENT",
    );
    assert.equal(run.result.error.details?.availableBalance, balance);
    assert.equal(
      run.result.error.details?.requiredAvailableBalance,
      balance === "0" ? undefined : "10.02002",
    );
    assert.equal(
      run.result.error.details?.shortfall,
      balance === "0" ? undefined : "0.02002",
    );
    if (balance === "0") {
      assert.equal(run.paths.includes("/v5/market/tickers"), false);
      assert.equal(run.paths.includes("/v5/market/instruments-info"), false);
    }
    assert.equal(run.opened, 0);
    assert.equal(run.paths.length, balance === "0" ? 7 : 11);
    assert.equal(run.paths.includes("/v5/position/list"), false);
    assert.equal(run.paths.includes("/v5/order/history"), false);
    assert.match(
      String(run.result.error.details?.exchangeGetCounts),
      /"fees":1/u,
    );
  }
});

test("prepare with sufficient fresh funds reaches persistence through production GET mappers", async () => {
  const run = await prepare({ balance: "11" });
  assert.equal(run.opened, 1, JSON.stringify(run.result));
  assert.equal(run.paths.length, 17);
  assert.equal(run.result.ok, true, JSON.stringify(run.result));
  if (!run.result.ok) return;
  assert.deepEqual(
    JSON.parse(run.result.value.exchangeGetCounts!),
    groupedFromFetchAttempts(run.paths),
  );
  assert.equal(run.result.value.exchangeGetCountsStatus, "available");
  assert.equal(run.result.value.exchangeEvidencePath, "compact");
  assert.equal(run.result.value.exchangeStage, "prepare");
  const reopened = openSqlitePersistence({
    environment: "mainnet",
    rootDirectory: run.root,
    scope: {
      exchange: "bybit",
      environment: "mainnet",
      accountId: run.result.value.plan.accountIdentityHash,
      category: "linear",
      positionMode: "one-way",
    },
    runtime: { nodeVersion: "22.22.3", sqliteVersion: "3.51.3" },
  });
  assert.equal(reopened.ok, true);
  if (reopened.ok) {
    try {
      assert.deepEqual(
        reopened.value.operatorMainnetTest?.readPreparedPlan(
          run.result.value.plan.contentHash,
        ),
        { ok: true, value: run.result.value.plan },
      );
    } finally {
      reopened.value.close();
    }
  }
  assert.equal(run.paths.filter((p) => p === "/v5/account/fee-rate").length, 1);
  assert.equal(run.paths.includes("/v5/order/history"), false);
});

test("U2 profiles match compact success and account-info no-time full fallback", async () => {
  const oldUpdatedTime = "1600000000000";
  const native5 = await prepare({
    balance: "11",
    accountInfoStatus: 5,
    accountInfoUpdatedTime: oldUpdatedTime,
    stageCostPerAttemptMs: 2,
  });
  const native6 = await prepare({
    balance: "11",
    accountInfoStatus: 6,
    accountInfoUpdatedTime: oldUpdatedTime,
    stageCostPerAttemptMs: 2,
  });
  const noTime6 = await prepare({
    balance: "11",
    accountInfoStatus: 6,
    accountInfoNoTime: true,
    accountInfoUpdatedTime: oldUpdatedTime,
    stageCostPerAttemptMs: 2,
  });

  for (const run of [native5, native6]) {
    assert.equal(run.result.ok, true, JSON.stringify(run.result));
    if (!run.result.ok) continue;
    assert.equal(run.result.value.exchangeEvidencePath, "compact");
    assert.equal(run.result.value.compactFallbackReason, undefined);
    assert.equal(run.result.value.exchangeGetCountsStatus, "available");
    const groups = JSON.parse(run.result.value.exchangeGetCounts!) as Record<
      string,
      number
    >;
    assert.deepEqual(groups, groupedFromFetchAttempts(run.paths));
    assert.equal(
      Object.values(groups).reduce((sum, count) => sum + count, 0),
      run.attempts.length,
    );
    assert.equal(run.result.value.exchangeReads, run.attempts.length);
    assert.equal(
      run.result.value.exchangeStageElapsedMs,
      run.attempts.length * 2,
    );
  }

  if (native6.result.ok) {
    const value = native6.result.value;
    const groups = JSON.parse(value.exchangeGetCounts!) as Record<
      string,
      number
    >;
    const profile = {
      baselineSha: "f107f0fc4b5ef5f0af9874fea68e754ac1fa0b20",
      fixture: "synthetic-uta6-regular-margin-old-updatedTime",
      stage: value.exchangeStage,
      stageTimingModel: "2 ms per independently logged stub fetch attempt",
      stageStartMs: 10_000,
      stageEndMs: 10_000 + native6.attempts.length * 2,
      physicalGetAttempts: value.exchangeReads,
      groups: { ...groups, other: groups.other ?? 0 },
      independentAttemptLogEntries: native6.attempts.length,
      retryAttempts: native6.attempts.filter((attempt) => attempt.retry).length,
      cursorPages: native6.attempts.filter((attempt) => attempt.cursorPage)
        .length,
      evidencePath: value.exchangeEvidencePath,
      compactFallbackReason: value.compactFallbackReason ?? null,
      acceptedUtaStatus: 6,
    };
    console.log(`U2_PREP_PROFILE ${JSON.stringify(profile)}`);
  }

  assert.equal(noTime6.result.ok, true, JSON.stringify(noTime6.result));
  if (noTime6.result.ok) {
    const value = noTime6.result.value;
    const groups = JSON.parse(value.exchangeGetCounts!) as Record<
      string,
      number
    >;
    assert.equal(value.exchangeEvidencePath, "compact-to-full");
    assert.equal(value.compactFallbackReason, "ACCOUNT_EVIDENCE_INVALID");
    assert.equal(
      value.exchangeCoverageWarningCode,
      "UNRELATED_AUXILIARY_HISTORY_NOT_COLLECTED",
    );
    assert.equal(value.exchangeStageElapsedMs, noTime6.attempts.length * 2);
    assert.equal(value.exchangeReads, noTime6.attempts.length);
    assert.equal(value.exchangeReads, 51);
    assert.equal(57 - value.exchangeReads, 6);
    assert.equal(groups["order-history"], 1);
    assert.equal(groups.executions, 1);
    assert.equal(groups.positions, 10);
    assert.equal(groups["open-orders"], 10);
    assert.equal(groups.account, 3);
    assert.equal(groups.wallet, 2);
    assert.equal(groups.collateral, 2);
    assert.equal(groups["collateral-tiers"], 1);
    assert.equal(groups["option-discovery"], 2);
    assert.deepEqual(groups, groupedFromFetchAttempts(noTime6.paths));
    assert.equal(
      Object.values(groups).reduce((sum, count) => sum + count, 0),
      noTime6.attempts.length,
    );
    assert.equal(groups.other ?? 0, 0);
    assert.equal(
      noTime6.attempts.filter((attempt) => attempt.cursorPage).length,
      0,
    );
    assert.equal(noTime6.attempts.filter((attempt) => attempt.retry).length, 0);
    assert.doesNotMatch(
      JSON.stringify(noTime6.result),
      /1600000000000|updatedTime|secret|PRIVATE/u,
    );
    const profile = {
      baselineSha: "a3817b1884bcca2efa11d8bdfbc53107c0355377",
      baselinePhysicalGetAttempts: 57,
      candidatePhysicalGetAttempts: value.exchangeReads,
      savedPhysicalGetAttempts: 6,
      fixture: "synthetic-uta6-regular-margin-old-updatedTime",
      stage: value.exchangeStage,
      stageTimingModel: "2 ms per independently logged stub fetch attempt",
      stageStartMs: 10_000,
      stageEndMs: 10_000 + noTime6.attempts.length * 2,
      physicalGetAttempts: value.exchangeReads,
      groups: { ...groups, other: groups.other ?? 0 },
      independentAttemptLogEntries: noTime6.attempts.length,
      retryAttempts: noTime6.attempts.filter((attempt) => attempt.retry).length,
      cursorPages: noTime6.attempts.filter((attempt) => attempt.cursorPage)
        .length,
      evidencePath: value.exchangeEvidencePath,
      coverageWarning: value.exchangeCoverageWarningCode,
      compactFallbackReason: value.compactFallbackReason,
      failedPredicate:
        "account-info-observation-requires-response-envelope-time",
      failedPass: "A",
      failedStage: "compact-account",
    };
    console.log(`U2_PREP_PROFILE ${JSON.stringify(profile)}`);
  }
});

test("R4 operator fallback preserves account-wide A/B blocks while skipping only optional history", async () => {
  const scenarios = [
    {
      options: { changingBalance: true },
      reasonCode: "AVAILABLE_BALANCE_SNAPSHOTS_DIFFER",
    },
    {
      options: { changingAssetSnapshot: true },
      reasonCode: "CRITICAL_STATE_CHANGED",
    },
    {
      options: { nonTargetPositionUnknownMargin: true },
      reasonCode: "READINESS_CRITICAL_STATE_UNPROVEN",
    },
    {
      options: { nonTargetActiveOrderUnknownPrice: true },
      reasonCode: "READINESS_CRITICAL_STATE_UNPROVEN",
    },
  ];
  for (const { options, reasonCode } of scenarios) {
    const run = await prepare({
      balance: "11",
      accountInfoNoTime: true,
      stageCostPerAttemptMs: 2,
      ...options,
    });
    assert.equal(run.result.ok, false, JSON.stringify(run.result));
    assert.equal(run.opened, 0);
    if (!run.result.ok) {
      assert.equal(
        run.result.error.details?.exchangeEvidencePath,
        "compact-to-full",
      );
      assert.equal(
        run.result.error.details?.exchangeCoverageWarningCode,
        "UNRELATED_AUXILIARY_HISTORY_NOT_COLLECTED",
      );
      assert.equal(run.result.error.details?.exchangeWrites, 0);
      assert.equal(
        run.result.error.details?.reasonCode,
        reasonCode,
        JSON.stringify(run.result.error.details),
      );
      if (options.changingAssetSnapshot) {
        assert.equal(
          run.result.error.details?.reasonCode,
          "CRITICAL_STATE_CHANGED",
        );
        assert.equal(run.result.error.details?.criticalChangedGroups, "assets");
      }
    }
    const groups = groupedFromFetchAttempts(run.paths);
    assert.equal(groups.positions, 10);
    assert.equal(groups["open-orders"], 10);
    assert.equal(groups["order-history"], 1);
    assert.equal(groups.executions, 1);
    assert.equal(run.paths.includes("/v5/order/history"), true);
    assert.equal(run.paths.includes("/v5/execution/list"), true);
    assert.equal(run.attempts.length, run.paths.length);
  }
});

test("R4 characterizes compact and full-fallback account-commitment differences", async () => {
  const scenarios = [
    {
      options: { changingAssetSnapshot: true },
      fallbackReason: "CRITICAL_STATE_CHANGED",
    },
    {
      options: { nonTargetPositionUnknownMargin: true },
      fallbackReason: "READINESS_CRITICAL_STATE_UNPROVEN",
    },
    {
      options: { nonTargetActiveOrderUnknownPrice: true },
      fallbackReason: "READINESS_CRITICAL_STATE_UNPROVEN",
    },
  ];
  for (const { options, fallbackReason } of scenarios) {
    const compact = await prepare({ balance: "11", ...options });
    const fallback = await prepare({
      balance: "11",
      accountInfoNoTime: true,
      ...options,
    });
    assert.equal(compact.result.ok, true, JSON.stringify(compact.result));
    assert.equal(compact.opened, 1);
    if (compact.result.ok)
      assert.equal(compact.result.value.exchangeEvidencePath, "compact");
    assert.equal(fallback.result.ok, false, JSON.stringify(fallback.result));
    assert.equal(fallback.opened, 0);
    if (!fallback.result.ok)
      assert.equal(fallback.result.error.details?.reasonCode, fallbackReason);
  }
});

test("U2 capacity-unknown preparation remains blocked before plan persistence", async () => {
  const run = await prepare({ balance: "", stageCostPerAttemptMs: 2 });
  assert.equal(run.result.ok, false);
  assert.equal(run.opened, 0);
  if (run.result.ok) return;
  const details = run.result.error.details;
  assert.equal(details?.compactFallbackReason, "WALLET_A_BALANCE_UNPROVEN");
  assert.equal(details?.exchangeEvidencePath, "compact-to-full");
  assert.equal(details?.exchangeGetCountsStatus, "available");
  const groups = JSON.parse(String(details?.exchangeGetCounts)) as Record<
    string,
    number
  >;
  assert.deepEqual(groups, groupedFromFetchAttempts(run.paths));
  assert.equal(details?.exchangeReads, run.attempts.length);
  assert.equal(
    Object.values(groups).reduce((sum, count) => sum + count, 0),
    run.attempts.length,
  );
  assert.equal(details?.exchangeStageElapsedMs, run.attempts.length * 2);
  assert.equal(run.paths.includes("/v5/order/history"), true);
  const profile = {
    baselineSha: "f107f0fc4b5ef5f0af9874fea68e754ac1fa0b20",
    fixture: "synthetic-uta5-regular-margin-missing-compact-balance",
    stage: "prepare",
    stageTimingModel: "2 ms per independently logged stub fetch attempt",
    physicalGetAttempts: details?.exchangeReads,
    groups: { ...groups, other: groups.other ?? 0 },
    independentAttemptLogEntries: run.attempts.length,
    retryAttempts: run.attempts.filter((attempt) => attempt.retry).length,
    cursorPages: run.attempts.filter((attempt) => attempt.cursorPage).length,
    evidencePath: details?.exchangeEvidencePath,
    compactFallbackReason: details?.compactFallbackReason,
    finalPredicate: details?.reasonCode,
    noPreparedPlan: run.opened === 0,
    writes: details?.exchangeWrites,
  };
  console.log(`U2_PREP_PROFILE ${JSON.stringify(profile)}`);
});

test("manual recovery preparation survives unavailable target GETs while retaining machine gates", async () => {
  const recoveryAttestation = manualRecoveryAttestation();
  const run = await prepare({
    balance: "11",
    failPositionRead: true,
    failOpenOrdersRead: true,
    recoveryAttestation,
  });

  assert.equal(run.result.ok, true, JSON.stringify(run.result));
  assert.equal(run.opened, 1);
  assert.equal(
    run.paths.every((path) => path !== "/v5/order/history"),
    true,
  );
  assert.equal(
    run.paths.every((path) => path !== "/v5/execution/list"),
    true,
  );
  assert.equal(
    run.paths.filter((path) => path === "/v5/position/list").length,
    1,
  );
  assert.equal(
    run.paths.filter((path) => path === "/v5/order/realtime").length,
    1,
  );
  if (run.result.ok) {
    assert.equal(
      run.result.value.plan.recoveryAttestationHash,
      recoveryAttestation.contentHash,
    );
    assert.equal(
      run.result.value.plan.schemaVersion,
      "operator-mainnet-execution-test/v2",
    );
  }

  const denied = await prepare({
    balance: "11",
    readOnly: true,
    recoveryAttestation,
  });
  assert.equal(denied.result.ok, false);
  if (!denied.result.ok)
    assert.equal(
      denied.result.error.details?.reasonCode,
      "CREDENTIAL_PERMISSION_BLOCKED",
    );
  assert.equal(denied.opened, 0);
});

test("manual recovery preparation rejects a UI observation older than five minutes", async () => {
  const recoveryAttestation = manualRecoveryAttestation(
    new Date(now - 300_001).toISOString(),
  );
  const run = await prepare({
    balance: "11",
    failPositionRead: true,
    failOpenOrdersRead: true,
    recoveryAttestation,
  });

  assert.equal(run.result.ok, false);
  if (run.result.ok) return;
  assert.equal(
    run.result.error.details?.reasonCode,
    "MANUAL_TARGET_EVIDENCE_STALE",
  );
  assert.equal(run.opened, 0, "stale manual evidence must not persist a plan");
  assert.equal(
    run.paths.filter((path) => path === "/v5/position/list").length,
    1,
  );
  assert.equal(
    run.paths.filter((path) => path === "/v5/order/realtime").length,
    1,
  );
});

test("unknown or stale fee cannot establish affordability or persist a plan", async () => {
  for (const options of [{ fee: "" }, { feeAge: 61_000 }]) {
    const run = await prepare({ balance: "11", ...options });
    assert.equal(run.opened, 0);
    assert.equal(run.result.ok, false);
    if (!run.result.ok)
      assert.notEqual(
        run.result.error.details?.reasonCode,
        "AVAILABLE_MARGIN_OR_FEE_RESERVE_INSUFFICIENT",
      );
  }
});

test("manual recovery prepare keeps account-info no-time terminal without full fallback", async () => {
  const recoveryAttestation = manualRecoveryAttestation();
  const run = await prepare({
    balance: "11",
    accountInfoNoTime: true,
    recoveryAttestation,
    stageCostPerAttemptMs: 2,
  });

  assert.equal(run.result.ok, false);
  assert.equal(run.opened, 0);
  if (run.result.ok) return;
  assert.equal(
    run.result.error.details?.reasonCode,
    "ACCOUNT_EVIDENCE_INVALID",
  );
  assert.equal(
    run.result.error.details?.compactFallbackReason,
    "ACCOUNT_EVIDENCE_INVALID",
  );
  assert.equal(run.result.error.details?.exchangeEvidencePath, "compact");
  assert.equal(run.result.error.details?.exchangeWrites, 0);
  assert.equal(run.paths.includes("/v5/order/history"), false);
  assert.equal(run.paths.includes("/v5/execution/list"), false);
  assert.equal(
    run.paths.every((path) => !path.startsWith("/v5/market/option")),
    true,
  );
});

test("unknown or stale compact balance records fallback and cannot reuse it as proven capacity", async () => {
  for (const options of [
    { balance: "" },
    { balance: "0", balanceAge: 61_000 },
  ]) {
    const run = await prepare(options);
    assert.equal(run.opened, 0);
    assert.equal(run.result.ok, false);
    if (run.result.ok) return;
    assert.ok(run.result.error.details?.compactFallbackReason);
    assert.ok(run.result.error.details?.exchangeGetCounts);
    assert.notEqual(
      run.result.error.details?.reasonCode,
      "AVAILABLE_MARGIN_OR_FEE_RESERVE_INSUFFICIENT",
    );
    assert.ok(
      run.paths.includes("/v5/order/history"),
      JSON.stringify(run.paths),
    );
    assert.deepEqual(
      JSON.parse(String(run.result.error.details?.exchangeGetCounts)),
      groupedFromFetchAttempts(run.paths),
    );
    assert.equal(
      run.result.error.details?.exchangeGetCountsStatus,
      "available",
    );
    assert.equal(
      run.result.error.details?.exchangeEvidencePath,
      "compact-to-full",
    );
  }
});

test("full fallback uses its own balance and preserves fee-inclusive insufficiency", async () => {
  const run = await prepare({ balance: "0", unknownFirstBalance: true });
  assert.equal(run.opened, 0);
  assert.equal(run.result.ok, false);
  if (!run.result.ok) {
    assert.equal(
      run.result.error.details?.compactFallbackReason,
      "WALLET_A_BALANCE_UNPROVEN",
    );
    assert.equal(
      run.result.error.details?.reasonCode,
      "AVAILABLE_MARGIN_OR_FEE_RESERVE_INSUFFICIENT",
      JSON.stringify(run.result),
    );
    assert.equal(run.result.error.details?.availableBalance, "0");
    assert.deepEqual(
      JSON.parse(String(run.result.error.details?.exchangeGetCounts)),
      groupedFromFetchAttempts(run.paths),
    );
    assert.equal(
      run.result.error.details?.exchangeEvidencePath,
      "compact-to-full",
    );
  }
});

test("successful full fallback preserves its reason and endpoint counts", async () => {
  let clockCalls = 0;
  const run = await prepare({
    balance: "11",
    unknownFirstBalance: true,
    stageMonotonicClock: () => (clockCalls++ === 0 ? 100 : 147),
  });
  assert.equal(run.result.ok, true, JSON.stringify(run.result));
  if (!run.result.ok) return;
  assert.equal(run.opened, 1);
  assert.equal(
    run.result.value.compactFallbackReason,
    "WALLET_A_BALANCE_UNPROVEN",
  );
  const counts = JSON.parse(run.result.value.exchangeGetCounts!) as Record<
    string,
    number
  >;
  assert.ok(counts["order-history"]! > 0);
  assert.equal(
    Object.values(counts).reduce((sum, count) => sum + count, 0),
    run.paths.length,
  );
  assert.deepEqual(counts, groupedFromFetchAttempts(run.paths));
  assert.equal(run.result.value.exchangeStage, "prepare");
  assert.equal(run.result.value.exchangeStageElapsedMs, 47);
  assert.equal(run.result.value.exchangeEvidencePath, "compact-to-full");
  assert.equal(run.result.value.exchangeGetCountsStatus, "available");
});

test("proven compact permission and balance-change blockers do not trigger a full audit", async () => {
  for (const options of [{ readOnly: true }, { changingBalance: true }]) {
    const run = await prepare({ balance: "11", ...options });
    assert.equal(run.result.ok, false);
    assert.equal(run.opened, 0);
    if (!run.result.ok) {
      assert.equal(
        run.result.error.details?.reasonCode,
        options.readOnly
          ? "CREDENTIAL_PERMISSION_BLOCKED"
          : "AVAILABLE_BALANCE_SNAPSHOTS_DIFFER",
      );
      if (options.changingBalance) {
        assert.equal(run.result.error.details?.pass, "A/B");
        assert.equal(
          run.result.error.details?.predicate,
          "totalAvailableBalance",
        );
      }
      assert.equal(run.result.error.details?.compactFallbackReason, undefined);
    }
    assert.equal(run.paths.includes("/v5/order/history"), false);
  }
});

test("failed preparation fee read reports its source without target reads or a full audit", async () => {
  const run = await prepare({ balance: "11", feeReadThrows: true });
  assert.equal(run.result.ok, false);
  assert.equal(run.opened, 0);
  if (!run.result.ok) {
    assert.equal(run.result.error.details?.reasonCode, "FEE_RATE_READ_FAILED");
    assert.equal(run.result.error.details?.source, "fee");
    assert.equal(run.result.error.details?.compactFallbackReason, undefined);
    assert.doesNotMatch(JSON.stringify(run.result), /PRIVATE_FEE_RESPONSE/u);
    const counts = JSON.parse(
      String(run.result.error.details?.exchangeGetCounts),
    ) as Record<string, number>;
    assert.deepEqual(counts, groupedFromFetchAttempts(run.paths));
    assert.equal(
      run.result.error.details?.exchangeGetCountsStatus,
      "available",
    );
    assert.equal(run.result.error.details?.exchangeEvidencePath, "compact");
  }
  assert.equal(
    run.paths.filter((path) => path === "/v5/account/fee-rate").length,
    2, // Existing transport retry policy; preparation does not start a full audit.
  );
  for (const path of [
    "/v5/position/list",
    "/v5/order/history",
    "/v5/market/instruments-info",
  ])
    assert.equal(run.paths.includes(path), false);
});

test("pre-fetch preparation failure reports a measured zero and keeps timing diagnostic-only", async () => {
  let clockCalls = 0;
  const result = await prepareMainnetOperatorTest(
    {
      symbol: "INVALID",
      allocation: "10",
      grossNotionalCap: "10",
      maxDeviationBps: "10",
    },
    {
      stageMonotonicClock: () => (clockCalls++ === 0 ? 50 : 61),
    },
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.details?.exchangeReads, 0);
  assert.equal(result.error.details?.exchangeGetCounts, "{}");
  assert.equal(result.error.details?.exchangeGetCountsStatus, "available");
  assert.equal(result.error.details?.exchangeStage, "prepare");
  assert.equal(result.error.details?.exchangeStageElapsedMs, 11);
  assert.equal(result.error.details?.exchangeEvidencePath, "none");
});
