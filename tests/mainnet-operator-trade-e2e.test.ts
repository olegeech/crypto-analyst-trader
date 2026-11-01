import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  accountInfoResponse,
  collateralResponse,
  tierResponse,
  walletResponse,
} from "./fixtures/bybit-account/read-fixtures.js";
import { openSqlitePersistence } from "../src/adapters/sqlite/sqlite-persistence.js";
import { configuredBybitAccountIdentityHash } from "../src/adapters/bybit-v5/account-key-mapper.js";
import {
  resolveOperatorMainnetSource,
  resolveOperatorMainnetTradeCommand,
} from "../src/adapters/sqlite/operator-mainnet-test-lookup.js";
import { runMainnetOperatorTestComposition } from "../src/application/mainnet-operator-test-composition.js";
import { prepareMainnetOperatorTest } from "../src/application/mainnet-operator-test-preparation-composition.js";
import { runMainnetOperatorTestStatusComposition } from "../src/application/mainnet-operator-test-status-composition.js";
import {
  readMainnetOperatorTradeCommandStatus,
  runMainnetOperatorTrade,
} from "../src/application/mainnet-operator-trade.js";
import { runMainnetOperatorTestCli } from "../src/cli/mainnet-operator-test.js";
import { mainnetOperatorTestPersistenceScope } from "../src/application/mainnet-operator-test-scope.js";
import { createOperatorMainnetTradeCommandReceipt } from "../src/domain/execution/operator-mainnet-trade-command.js";
import { hashCanonical } from "../src/domain/identity/canonical-serialization.js";
import type { SqlitePersistenceOptions } from "../src/adapters/sqlite/sqlite-persistence.js";
import type { UtcTimestamp } from "../src/domain/shared/time.js";
import type { MainnetOperatorTestStatusResult } from "../src/application/mainnet-operator-test-status.js";
import type { Result } from "../src/domain/shared/result.js";

const NOW = Date.parse("2026-10-31T12:00:00.000Z");
const NOW_ISO = new Date(NOW).toISOString() as UtcTimestamp;
const RUNTIME = { nodeVersion: "22.22.3", sqliteVersion: "3.51.3" } as const;

function response(
  result: Record<string, unknown>,
  time = NOW,
  includeTime = true,
): Response {
  return new Response(
    JSON.stringify({
      retCode: 0,
      retMsg: "OK",
      ...(includeTime ? { time } : {}),
      result,
    }),
    { status: 200 },
  );
}

function providerTimeResult(timeMs = NOW) {
  return {
    timeSecond: String(Math.floor(timeMs / 1_000)),
    timeNano: String(BigInt(timeMs) * 1_000_000n),
  };
}

function orderRows(clientOrderId: string, quantity: string, tp: string) {
  return [
    {
      orderId: "entry-order-1",
      orderLinkId: clientOrderId,
      parentOrderLinkId: "",
      symbol: "INJUSDT",
      side: "Buy",
      orderType: "Limit",
      timeInForce: "GTC",
      qty: quantity,
      cumExecQty: quantity,
      leavesQty: "0",
      orderStatus: "Filled",
      price: "0.0753",
      avgPrice: "0.0753",
      takeProfit: tp,
      stopLoss: "0",
      stopOrderType: "",
      tpslMode: "Partial",
      triggerBy: "",
      tpTriggerBy: "LastPrice",
      reduceOnly: false,
      positionIdx: 0,
      createdTime: String(NOW - 1_000),
      updatedTime: String(NOW),
    },
    {
      orderId: "tp-order-1",
      orderLinkId: "",
      parentOrderLinkId: clientOrderId,
      symbol: "INJUSDT",
      side: "Sell",
      orderType: "Market",
      timeInForce: "IOC",
      qty: quantity,
      cumExecQty: quantity,
      leavesQty: "0",
      orderStatus: "Filled",
      price: "0.0757",
      avgPrice: "0.0757",
      triggerPrice: tp,
      takeProfit: "0",
      stopLoss: "0",
      stopOrderType: "PartialTakeProfit",
      tpslMode: "Partial",
      triggerBy: "LastPrice",
      tpTriggerBy: "",
      reduceOnly: true,
      positionIdx: 0,
      createdTime: String(NOW - 500),
      updatedTime: String(NOW),
    },
  ];
}

async function runOperatorTradeE2e(
  t: TestContext,
  accountInfoNoTime: boolean,
  initialTargetLeverage = "1",
  walletAmountDrift = false,
  staleAccountHandoff = false,
  advancingQuoteTime = false,
  preparationOnly = false,
  failWalletRefresh = false,
  futureQuoteHandoff = false,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "operator-trade-e2e-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const databasePath = join(root, "mainnet.db");
  let eventTime = NOW;
  const clock = {
    now: () => new Date(eventTime).toISOString() as UtcTimestamp,
  };
  const openPersistence = (options: SqlitePersistenceOptions) =>
    openSqlitePersistence({
      ...options,
      databasePath,
      runtime: RUNTIME,
      clock,
    });
  const credentials = {
    apiKey: "synthetic-key",
    apiSecret: "synthetic-secret",
    accountId: "123",
  };
  const credentialProvider = { load: async () => credentials };
  const attempts: Array<{ method: string; path: string }> = [];
  let tickerReads = 0;
  let initialQuoteCollectionStartedAt: number | undefined;
  let initialQuoteObservedAt: number | undefined;
  let initialQuoteCollectionCompletedAt: number | undefined;
  let walletReads = 0;
  let createCalls = 0;
  let createBody: Record<string, unknown> | undefined;
  let created = false;
  let createdClientOrderId = "";
  let createdQuantity = "";
  let createdTakeProfit = "";
  let targetLeverage = initialTargetLeverage;
  let leverageSetCalls = 0;
  let executeReadReport:
    | {
        readonly count: number;
        readonly paths: Readonly<Record<string, number>>;
      }
    | undefined;

  const request: typeof fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const target = new URL(url);
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    attempts.push({ method, path: target.pathname });
    if (method === "POST") {
      assert.equal(target.origin, "https://api.bybit.com");
      const rawBody = init?.body;
      assert.equal(typeof rawBody, "string");
      const body = JSON.parse(rawBody as string) as Record<string, unknown>;
      if (target.pathname === "/v5/position/set-leverage") {
        leverageSetCalls += 1;
        assert.equal(body.category, "linear");
        assert.equal(body.symbol, "INJUSDT");
        assert.equal(body.buyLeverage, "1");
        assert.equal(body.sellLeverage, "1");
        targetLeverage = "1";
        return response({});
      }
      assert.equal(target.pathname, "/v5/order/create");
      createCalls += 1;
      createBody = body;
      assert.equal(createBody.category, "linear");
      assert.equal(createBody.symbol, "INJUSDT");
      assert.equal(createBody.side, "Buy");
      assert.equal(createBody.orderType, "Limit");
      assert.equal(createBody.timeInForce, "GTC");
      assert.equal(createBody.price, "0.0753");
      assert.equal(createBody.tpOrderType, "Market");
      assert.equal(createBody.tpslMode, "Partial");
      assert.equal(createBody.tpTriggerBy, "LastPrice");
      assert.equal(createBody.reduceOnly, false);
      createdClientOrderId = String(createBody.orderLinkId);
      createdQuantity = String(createBody.qty);
      createdTakeProfit = String(createBody.takeProfit);
      created = true;
      return response({
        orderId: "entry-order-1",
        orderLinkId: createdClientOrderId,
      });
    }
    assert.equal(method, "GET", `unexpected provider method ${method}`);

    switch (target.pathname) {
      case "/v5/market/time": {
        const providerTime = advancingQuoteTime ? NOW + tickerReads * 300 : NOW;
        eventTime = Math.max(eventTime, providerTime);
        if (advancingQuoteTime && tickerReads === 0)
          initialQuoteCollectionStartedAt = providerTime;
        if (
          advancingQuoteTime &&
          tickerReads === 1 &&
          initialQuoteCollectionCompletedAt === undefined
        )
          initialQuoteCollectionCompletedAt = providerTime;
        return response(providerTimeResult(providerTime), providerTime);
      }
      case "/v5/user/query-api":
        return response({
          userID: 123,
          readOnly: 0,
          permissions: {
            ContractTrade: ["Order", "Position"],
            Spot: [],
            Wallet: [],
          },
          ips: ["127.0.0.1"],
          expiredAt: "",
        });
      case "/v5/account/info":
        return response(
          structuredClone(accountInfoResponse.result),
          NOW,
          !accountInfoNoTime,
        );
      case "/v5/account/wallet-balance":
        walletReads += 1;
        if (failWalletRefresh && staleAccountHandoff && walletReads === 2)
          return new Response(
            JSON.stringify({
              retCode: 10001,
              retMsg: "invalid parameter",
              result: {},
            }),
            { status: 200 },
          );
        {
          const result = structuredClone(walletResponse.result);
          if (walletAmountDrift && walletReads === 1) {
            const account = (result.list as Record<string, unknown>[])[0]!;
            account.totalAvailableBalance = "90";
            const coins = account.coin as Record<string, unknown>[];
            coins[0]!.walletBalance = "90";
          }
          return response(result);
        }
      case "/v5/account/fee-rate":
        return response({
          list: [
            {
              symbol: "INJUSDT",
              makerFeeRate: "0.0002",
              takerFeeRate: "0.001",
              rpiMakerFeeRate: "",
            },
          ],
        });
      case "/v5/market/instruments-info": {
        if (target.searchParams.get("category") === "option")
          return response({ category: "option", list: [], nextPageCursor: "" });
        return response({
          category: "linear",
          list: [
            {
              symbol: "INJUSDT",
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
                maxOrderQty: "1000000",
                minNotionalValue: "5",
              },
              leverageFilter: {
                minLeverage: "1",
                maxLeverage: "100",
                leverageStep: "0.01",
              },
            },
          ],
          nextPageCursor: "",
        });
      }
      case "/v5/market/tickers": {
        tickerReads += 1;
        const tickerTime = advancingQuoteTime
          ? NOW + 100 + (tickerReads - 1) * 300
          : NOW;
        eventTime = Math.max(eventTime, tickerTime);
        if (advancingQuoteTime && tickerReads === 1)
          initialQuoteObservedAt = tickerTime;
        const bid = tickerReads === 1 ? "0.07537" : "0.07529";
        const ask = tickerReads === 1 ? "0.07538" : "0.0753";
        return response(
          {
            category: "linear",
            list: [
              {
                symbol: "INJUSDT",
                bid1Price: bid,
                ask1Price: ask,
                lastPrice: bid,
              },
            ],
          },
          tickerTime,
        );
      }
      case "/v5/account/collateral-info":
        return response(structuredClone(collateralResponse.result));
      case "/v5/spot-margin-trade/collateral":
        return response(structuredClone(tierResponse.result));
      case "/v5/market/option-base-coins":
        return response({ list: [{ baseCoin: "ETH", hasSymbol: 0 }] });
      case "/v5/position/list":
        return response({
          category: target.searchParams.get("category"),
          list:
            target.searchParams.get("symbol") === "INJUSDT"
              ? [
                  {
                    symbol: "INJUSDT",
                    positionIdx: 0,
                    side: "",
                    size: "0",
                    leverage: targetLeverage,
                  },
                ]
              : [],
          nextPageCursor: "",
        });
      case "/v5/order/realtime":
      case "/v5/order/history": {
        const rows =
          created && target.searchParams.get("symbol") === "INJUSDT"
            ? orderRows(
                createdClientOrderId,
                createdQuantity,
                createdTakeProfit,
              )
            : [];
        const orderLinkId = target.searchParams.get("orderLinkId");
        return response({
          category: target.searchParams.get("category"),
          list:
            orderLinkId === null
              ? rows
              : rows.filter((row) => row.orderLinkId === orderLinkId),
          nextPageCursor: "",
        });
      }
      case "/v5/execution/list": {
        const orderId = target.searchParams.get("orderId");
        const fills = !created
          ? []
          : orderId === "tp-order-1"
            ? [
                {
                  execId: "tp-exec-1",
                  orderId: "tp-order-1",
                  orderLinkId: "",
                  symbol: "INJUSDT",
                  side: "Sell",
                  execQty: createdQuantity,
                  execPrice: "0.0757",
                  execTime: String(NOW),
                  execFee: "0.0001",
                  feeCurrency: "USDT",
                },
              ]
            : [
                {
                  execId: "entry-exec-1",
                  orderId: "entry-order-1",
                  orderLinkId: createdClientOrderId,
                  symbol: "INJUSDT",
                  side: "Buy",
                  execQty: createdQuantity,
                  execPrice: "0.0753",
                  execTime: String(NOW - 500),
                  execFee: "0.0001",
                  feeCurrency: "USDT",
                },
              ];
        return response({
          category: target.searchParams.get("category"),
          list: fills,
          nextPageCursor: "",
        });
      }
      default:
        throw new Error(
          `unmatched synthetic provider endpoint ${target.pathname}`,
        );
    }
  };

  if (preparationOnly) {
    const accountIdentity = configuredBybitAccountIdentityHash(
      "123",
      "mainnet",
    );
    const actorIdentity = hashCanonical({
      localOperatorIdentity: "test-owner",
    });
    assert.equal(accountIdentity.ok, true);
    assert.equal(actorIdentity.ok, true);
    if (!accountIdentity.ok || !actorIdentity.ok) return;

    const receipt = createOperatorMainnetTradeCommandReceipt({
      commandId: "advancing-quote-preparation-01",
      actorIdentityHash: actorIdentity.value,
      accountIdentityHash: accountIdentity.value,
      symbol: "INJUSDT",
      allocation: "10",
      grossNotionalCap: "10",
      maxDeviationBps: "10",
      takeProfitMode: "percent",
      takeProfitValue: "0.50",
      acceptedAt: NOW_ISO,
    });
    assert.equal(receipt.ok, true);
    if (!receipt.ok) return;

    const prepared = await prepareMainnetOperatorTest(
      {
        symbol: "INJUSDT",
        allocation: "10",
        grossNotionalCap: "10",
        maxDeviationBps: "10",
        tradeCommandReceipt: receipt.value,
      },
      {
        credentialProvider,
        openPersistence,
        request,
        utcClock: () => eventTime,
      },
    );
    assert.equal(prepared.ok, true, JSON.stringify(prepared));
    assert.equal(createCalls, 0, "preparation must remain GET-only");
    assert.equal(
      attempts.some(({ method }) => method === "POST"),
      false,
      "preparation must not issue provider writes",
    );
    if (!prepared.ok) return;

    const { plan } = prepared.value;
    assert.equal(prepared.value.exchangeWrites, 0);
    assert.equal(plan.schemaVersion, "operator-mainnet-execution-test/v3");
    assert.equal(plan.commandId, receipt.value.commandId);
    assert.deepEqual(
      [
        initialQuoteCollectionStartedAt,
        initialQuoteObservedAt,
        initialQuoteCollectionCompletedAt,
      ],
      [NOW, NOW + 100, NOW + 300],
      "the quote must preserve its advancing provider-time bracket",
    );
    assert.ok(
      Date.parse(plan.quote.collectionStartedAt) <
        Date.parse(plan.quote.observedAt) &&
        Date.parse(plan.quote.observedAt) <
          Date.parse(plan.quote.collectionCompletedAt),
      "the plan quote must retain its advancing provider-time bracket",
    );
    assert.ok(
      Date.parse(plan.preparedAt) >=
        Date.parse(plan.quote.collectionCompletedAt),
      "preparedAt must not precede quote collection completion",
    );
    return;
  }

  const compositionDependencies = {
    credentialProvider,
    openPersistence,
    request,
    wallClock: () => eventTime,
  };
  const statusDependencies = {
    ...compositionDependencies,
    resolveSource: (sourceId: unknown) =>
      resolveOperatorMainnetSource(sourceId, { databasePath, clock }),
  };
  const getCommandStatus = (
    statusInput: Parameters<typeof runMainnetOperatorTestStatusComposition>[0],
  ): Promise<Result<MainnetOperatorTestStatusResult>> =>
    runMainnetOperatorTestStatusComposition(
      statusInput,
      statusDependencies,
    ) as Promise<Result<MainnetOperatorTestStatusResult>>;
  const tradeStatus = (commandId: unknown) =>
    readMainnetOperatorTradeCommandStatus(commandId, {
      resolveCommand: (id, options) =>
        resolveOperatorMainnetTradeCommand(id, {
          ...options,
          databasePath,
          clock,
        }),
      status: getCommandStatus,
    });
  const tradeDependencies = {
    credentialProvider,
    openPersistence,
    request,
    clock: () => eventTime,
    prepare: async (
      prepareInput: Parameters<typeof prepareMainnetOperatorTest>[0],
    ) => {
      const prepared = await prepareMainnetOperatorTest(prepareInput, {
        credentialProvider,
        openPersistence,
        request,
        utcClock: () => eventTime,
      });
      assert.equal(createCalls, 0, "preparation must remain GET-only");
      assert.equal(prepared.ok, true, JSON.stringify(prepared));
      assert.equal(prepared.ok && prepared.value.exchangeWrites, 0);
      assert.equal(
        prepared.ok && prepared.value.exchangeEvidencePath,
        "compact",
      );
      return prepared;
    },
    execute: async (
      executeInput: Parameters<typeof runMainnetOperatorTestComposition>[0],
      preparedDirectTradeAdmission: NonNullable<
        Parameters<typeof runMainnetOperatorTestComposition>[1]
      >["preparedDirectTradeAdmission"],
    ) => {
      let handoff =
        staleAccountHandoff && preparedDirectTradeAdmission
          ? {
              ...preparedDirectTradeAdmission,
              capturedAtMonotonic: performance.now() - 301_000,
            }
          : preparedDirectTradeAdmission;
      if (futureQuoteHandoff && handoff) {
        assert.ok("compactAccount" in handoff.evidence);
        handoff = {
          ...handoff,
          evidence: {
            ...handoff.evidence,
            quote: {
              ...handoff.evidence.quote,
              observedAt: new Date(NOW + 1_000).toISOString() as UtcTimestamp,
            },
          },
        };
      }
      const executeGetBaseline = attempts.filter(
        ({ method }) => method === "GET",
      ).length;
      const executeAttemptStart = attempts.length;
      const executed = await runMainnetOperatorTestComposition(executeInput, {
        ...compositionDependencies,
        preparedDirectTradeAdmission: handoff,
      });
      const executeGetAttempts = attempts
        .slice(executeAttemptStart)
        .filter(({ method }) => method === "GET");
      const pathCounts: Record<string, number> = {};
      for (const attempt of executeGetAttempts)
        pathCounts[attempt.path] = (pathCounts[attempt.path] ?? 0) + 1;
      executeReadReport = {
        count:
          attempts.filter(({ method }) => method === "GET").length -
          executeGetBaseline,
        paths: pathCounts,
      };
      if (failWalletRefresh || futureQuoteHandoff) {
        assert.equal(executed.ok, false, JSON.stringify(executed));
        if (!executed.ok) {
          assert.equal(
            executed.error.details?.reasonCode,
            failWalletRefresh
              ? "TARGETED_EVIDENCE_REFRESH_FAILED"
              : "MAINNET_EVIDENCE_STALE",
          );
          assert.equal(
            executed.error.details?.source,
            futureQuoteHandoff
              ? "quote"
              : failWalletRefresh
                ? "balance"
                : undefined,
          );
          if (futureQuoteHandoff)
            assert.ok(Number(executed.error.details?.futureByMs) > 0);
        }
        assert.equal(
          createCalls,
          0,
          "invalid or unrefreshable evidence must stop before CREATE",
        );
        assert.equal(walletReads, staleAccountHandoff ? 2 : 1);
        if (futureQuoteHandoff)
          assert.equal(tickerReads, 1, "future quote must not be refreshed");
        assert.equal(
          attempts.some(({ path }) =>
            [
              "/v5/account/collateral-info",
              "/v5/spot-margin-trade/collateral",
              "/v5/market/option-base-coins",
              "/v5/order/history",
              "/v5/execution/list",
            ].includes(path),
          ),
          false,
          "direct v3 refresh must not restart the full account scan",
        );
        return executed;
      }
      assert.equal(executed.ok, true, JSON.stringify(executed));
      if (executed.ok)
        executeReadReport = {
          count:
            attempts.filter(({ method }) => method === "GET").length -
            executeGetBaseline,
          paths: pathCounts,
        };
      return executed;
    },
    status: getCommandStatus,
    monotonicClock: () => performance.now(),
  };

  const tradeOutput: string[] = [];
  const tradeCode = await runMainnetOperatorTestCli(
    [
      "trade",
      "--symbol",
      "INJUSDT",
      "--allocation",
      "10",
      "--gross-cap",
      "10",
      "--max-deviation-bps",
      "10",
      "--tp-percent",
      "0.50",
    ],
    {
      trade: (input, callbacks) =>
        runMainnetOperatorTrade(input, {
          ...tradeDependencies,
          ...callbacks,
        }),
      output: {
        isTTY: false,
        write: (chunk: string | Uint8Array) => {
          tradeOutput.push(String(chunk));
          return true;
        },
      } as NodeJS.WritableStream & { readonly isTTY: boolean },
    },
  );
  const tradeText = tradeOutput.join("");
  if (failWalletRefresh || futureQuoteHandoff) {
    assert.equal(createCalls, 0);
    assert.equal(
      attempts.filter(
        ({ method, path }) => method === "POST" && path === "/v5/order/create",
      ).length,
      0,
    );
    const commandId = tradeText.match(/^COMMAND_ID=([\w-]+)$/mu)?.[1];
    assert.ok(commandId, tradeText);
    const accountIdentity = configuredBybitAccountIdentityHash(
      "123",
      "mainnet",
    );
    assert.equal(accountIdentity.ok, true);
    if (accountIdentity.ok) {
      const reopened = openPersistence({
        environment: "mainnet",
        scope: mainnetOperatorTestPersistenceScope(accountIdentity.value),
      });
      assert.equal(reopened.ok, true);
      if (reopened.ok) {
        try {
          const command =
            reopened.value.operatorMainnetTest?.readOperatorMainnetTradeCommand(
              commandId!,
            );
          assert.equal(command?.ok, true);
          assert.equal(
            command?.ok && command.value?.source,
            undefined,
            "failed refresh must not create a source intent",
          );
        } finally {
          reopened.value.close();
        }
      }
    }
    return;
  }
  assert.equal(
    tradeCode,
    0,
    `${tradeText}\nEXECUTE_READS=${JSON.stringify(executeReadReport)}`,
  );
  assert.match(tradeText, /CREATE_OUTCOME=accepted/u);
  assert.match(tradeText, /LIFECYCLE_OUTCOME=TP_LIFECYCLE_PASS/u);
  assert.match(
    tradeText,
    new RegExp(
      `LEVERAGE_CONFIG_STATUS=${initialTargetLeverage === "1" ? "ALREADY_1X" : "CONFIRMED_1X"}`,
      "u",
    ),
  );
  assert.equal(leverageSetCalls, initialTargetLeverage === "1" ? 0 : 1);
  assert.equal(createCalls, 1);
  assert.ok(createBody);
  assert.equal(createBody!.price, "0.0753");
  assert.equal(createBody!.takeProfit, "0.0757");
  assert.match(tradeText, /^TP_EFFECTIVE_PERCENT=0\.531208499335989/mu);
  assert.equal(tickerReads, staleAccountHandoff ? 4 : 2);
  assert.ok(executeReadReport);
  if (executeReadReport) {
    assert.equal(
      executeReadReport.count,
      staleAccountHandoff ? 16 : 1,
      JSON.stringify(executeReadReport),
    );
    if (staleAccountHandoff) {
      assert.equal(
        walletReads,
        2,
        "the one stale wallet fact is refreshed once",
      );
      assert.deepEqual(executeReadReport.paths, {
        "/v5/account/fee-rate": 1,
        "/v5/account/info": 1,
        "/v5/account/wallet-balance": 1,
        "/v5/market/instruments-info": 1,
        "/v5/market/tickers": 2,
        "/v5/market/time": 7,
        "/v5/order/realtime": 1,
        "/v5/position/list": 1,
        "/v5/user/query-api": 1,
      });
      assert.equal(
        attempts.filter(({ path }) => path === "/v5/account/collateral-info")
          .length,
        0,
        "bounded direct refresh must not restart the account-wide scan",
      );
    } else assert.deepEqual(executeReadReport.paths, { "/v5/market/time": 1 });
  }
  const readsAfterTrade = attempts.filter(
    ({ method }) => method === "GET",
  ).length;
  assert.equal(
    readsAfterTrade,
    Number(tradeText.match(/^EXCHANGE_READS_TOTAL=(\d+)$/mu)?.[1]),
    "trade output must report actual GET attempts across prepare, execute, and immediate status",
  );
  assert.ok(
    attempts.some(
      ({ method, path }) => method === "POST" && path === "/v5/order/create",
    ),
  );
  assert.equal(
    attempts.filter(({ method }) => method === "POST").length,
    initialTargetLeverage === "1" ? 1 : 2,
  );
  const leveragePostIndex = attempts.findIndex(
    ({ path }) => path === "/v5/position/set-leverage",
  );
  const createPostIndex = attempts.findIndex(
    ({ path }) => path === "/v5/order/create",
  );
  const preCreateGets = attempts
    .slice(0, createPostIndex)
    .filter(({ method }) => method === "GET").length;
  assert.ok(
    preCreateGets < 116,
    `v3 must use fewer than the 116 GETs observed before CREATE in the duplicated admission flow; got ${preCreateGets}`,
  );
  if (initialTargetLeverage !== "1")
    assert.ok(leveragePostIndex >= 0 && leveragePostIndex < createPostIndex);

  const commandId = tradeText.match(/^COMMAND_ID=([\w-]+)$/mu)?.[1];
  assert.ok(commandId, tradeText);
  const commandStatusOutput: string[] = [];
  const statusCode = await runMainnetOperatorTestCli(
    ["status", "--command-id", commandId!],
    {
      tradeStatus,
      output: {
        isTTY: false,
        write: (chunk: string | Uint8Array) => {
          commandStatusOutput.push(String(chunk));
          return true;
        },
      } as NodeJS.WritableStream & { readonly isTTY: boolean },
    },
  );
  const statusText = commandStatusOutput.join("");
  assert.equal(statusCode, 0, statusText);
  assert.match(statusText, /COMMAND_STATUS=INTENT_PRESENT/u);
  assert.match(statusText, /LIFECYCLE_OUTCOME=TP_LIFECYCLE_PASS/u);
  assert.match(statusText, /CLEANUP_STATUS=verified-clean/u);
  assert.match(statusText, /ENTRY_REMAINDER_QUANTITY=0/u);
  assert.equal(
    attempts.filter(({ method }) => method === "GET").length - readsAfterTrade,
    Number(statusText.match(/^EXCHANGE_READS=(\d+)$/mu)?.[1]),
    "command status must report actual GET attempts",
  );
  assert.equal(createCalls, 1, "status must not dispatch another CREATE");
  assert.equal(
    attempts.filter(({ method }) => method === "POST").length,
    initialTargetLeverage === "1" ? 1 : 2,
    "the entire command-id status path must remain GET-only",
  );

  const identity = configuredBybitAccountIdentityHash("123", "mainnet");
  assert.equal(identity.ok, true);
  if (identity.ok) {
    const scope = mainnetOperatorTestPersistenceScope(identity.value);
    const reopened = openPersistence({ environment: "mainnet", scope });
    assert.equal(reopened.ok, true);
    if (reopened.ok) {
      try {
        const journal = reopened.value.operatorMainnetTest;
        assert.ok(journal);
        const command = journal.readOperatorMainnetTradeCommand(commandId!);
        assert.equal(command.ok, true);
        assert.equal(command.ok && command.value?.source !== undefined, true);
        assert.equal(
          command.ok && command.value?.outcomes.length,
          initialTargetLeverage === "1" ? 1 : 2,
        );
        const latestReconciliation =
          command.ok && command.value?.source
            ? command.value.source.reconciliations.at(-1)
            : undefined;
        assert.equal(
          latestReconciliation?.lifecycleOutcome,
          "TP_LIFECYCLE_PASS",
        );
        assert.equal(latestReconciliation?.cleanupStatus, "verified-clean");
      } finally {
        reopened.value.close();
      }
    }
  }
  assert.ok(created, "the synthetic CREATE acknowledgement was reached");
  assert.ok(createBody, "the captured immutable CREATE payload exists");
  assert.match(String(createBody?.orderLinkId), /^omt-[a-f0-9]{32}$/u);
  assert.equal(createdTakeProfit, "0.0757");
  assert.equal(createdQuantity, String(createBody?.qty));
  assert.equal(
    attempts.some(({ path }) => path === "/v5/order/create"),
    true,
  );
}

test("U5 production path: INJUSDT .50% command keeps frozen Limit after lower bid and reconciles TP fills", async (t) =>
  runOperatorTradeE2e(t, false));

test("v3 command uses provider-time brackets for account-info without envelope time", async (t) =>
  runOperatorTradeE2e(t, true));

test("U5 production path: non-1x flat INJUSDT is set once to 1x before one +0.50% CREATE", async (t) =>
  runOperatorTradeE2e(t, false, "2"));

test("v3 accepts one current available-balance observation without A/B equality", async (t) =>
  runOperatorTradeE2e(t, false, "1", true));

test("v3 refreshes stale direct facts once, then creates with the frozen plan", async (t) =>
  runOperatorTradeE2e(t, false, "1", false, true));

test("v3 fails closed when a bounded account refresh fails, with no intent or CREATE", async (t) =>
  runOperatorTradeE2e(t, false, "1", false, true, false, false, true));

test("v3 does not let targeted refresh mask a future quote timestamp", async (t) =>
  runOperatorTradeE2e(t, false, "1", false, false, false, false, false, true));

test("v3 production preparation accepts an advancing quote bracket without writes", async (t) =>
  runOperatorTradeE2e(t, false, "1", false, false, true, true));
