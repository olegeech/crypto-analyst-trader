import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  runHistoryIngestion,
  type HistorySyncBudget,
  type HistorySyncSelection,
} from "../src/application/history-ingestion.js";
import { runLiveHistorySync } from "../src/application/history-ingestion-composition.js";
import { historyMoneyComponents } from "../src/application/history-attribution.js";
import { createSqliteHistoryStore } from "../src/adapters/sqlite/history-store.js";
import { openSqliteConnection } from "../src/adapters/sqlite/connection.js";
import { runHistorySyncCli } from "../src/cli/history-sync.js";
import {
  HISTORY_READ_SOURCES,
  type HistoryReadPageRequest,
  type HistoryReadSource,
} from "../src/ports/history-read.js";
import type { HistorySyncReport } from "../src/application/history-ingestion.js";
import type { Result } from "../src/domain/shared/result.js";
import type { UtcTimestamp } from "../src/domain/shared/time.js";

const nowMs = Date.parse("2026-10-28T12:00:00.000Z");
const windowFromMs = nowMs - 24 * 60 * 60 * 1_000;
const eventMs = nowMs - 60 * 60 * 1_000;

// Synthetic provider-shaped rows based on Bybit's documented V5 examples.
const providerRows: Readonly<
  Record<HistoryReadSource, readonly Record<string, unknown>[]>
> = {
  "order-history": [
    {
      category: "linear",
      symbol: "DOGEUSDT",
      orderId: "order-entry-1",
      orderLinkId: "client-entry-1",
      side: "Buy",
      orderType: "Limit",
      orderStatus: "Filled",
      timeInForce: "GTC",
      qty: "1",
      price: "0.1",
      avgPrice: "0.1",
      cumExecQty: "1",
      cumExecValue: "0.1",
      cumExecFee: "0.0001",
      createdTime: String(eventMs),
      updatedTime: String(eventMs + 1_000),
    },
  ],
  executions: [
    {
      category: "linear",
      symbol: "DOGEUSDT",
      orderId: "order-entry-1",
      orderLinkId: "client-entry-1",
      execId: "exec-entry-1",
      orderPrice: "0.1",
      orderQty: "1",
      side: "Buy",
      execType: "Trade",
      execPrice: "0.1",
      execQty: "0.4",
      execValue: "0.04",
      execFee: "0.00004",
      feeCurrency: "USDT",
      execTime: String(eventMs),
      seq: "1",
    },
    {
      category: "linear",
      symbol: "DOGEUSDT",
      orderId: "order-entry-1",
      orderLinkId: "client-entry-1",
      execId: "exec-entry-2",
      orderPrice: "0.1",
      orderQty: "1",
      side: "Buy",
      execType: "Trade",
      execPrice: "0.1",
      execQty: "0.6",
      execValue: "0.06",
      execFee: "0.00006",
      feeCurrency: "USDT",
      execTime: String(eventMs),
      seq: "2",
    },
  ],
  "closed-pnl": [
    {
      category: "linear",
      symbol: "DOGEUSDT",
      orderId: "order-exit-1",
      side: "Sell",
      orderType: "Market",
      execType: "Trade",
      qty: "1",
      orderPrice: "0.101",
      closedSize: "1",
      cumEntryValue: "0.1",
      avgEntryPrice: "0.1",
      cumExitValue: "0.101",
      avgExitPrice: "0.101",
      closedPnl: "0.001",
      openFee: "0.0001",
      closeFee: "0.0001",
      fundingFee: "-0.00002",
      fillCount: "2",
      leverage: "1",
      createdTime: String(eventMs + 2_000),
      updatedTime: String(eventMs + 3_000),
    },
  ],
  "transaction-log": [
    {
      id: "tx-fee-rebate",
      type: "TRADE",
      transSubType: "",
      side: "None",
      category: "linear",
      symbol: "DOGEUSDT",
      currency: "USDT",
      qty: "0",
      cashFlow: "0",
      funding: "0",
      fee: "-0.00001",
      change: "0.00001",
      transactionTime: String(eventMs + 4_000),
      cashBalance: "10",
    },
    {
      id: "tx-funding-received",
      type: "SETTLEMENT",
      transSubType: "",
      side: "None",
      category: "linear",
      symbol: "DOGEUSDT",
      currency: "USDT",
      qty: "0",
      cashFlow: "0",
      funding: "0.00002",
      fee: "0",
      change: "0.00002",
      transactionTime: String(eventMs + 5_000),
      cashBalance: "10",
    },
    {
      id: "tx-transfer",
      type: "TRANSFER_IN",
      transSubType: "",
      side: "None",
      category: "",
      symbol: "",
      currency: "USDT",
      qty: "5",
      cashFlow: "5",
      funding: "0",
      fee: "0",
      change: "5",
      transactionTime: String(eventMs + 6_000),
      cashBalance: "15",
    },
  ],
};

function providerEnvelope(result: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      retCode: 0,
      retMsg: "OK",
      result,
      time: nowMs,
    }),
    { status: 200 },
  );
}

function openDatabase(path: string) {
  const opened = openSqliteConnection({
    environment: "mainnet",
    databasePath: path,
    clock: { now: () => "2026-10-28T12:00:00.000Z" as UtcTimestamp },
  });
  if (!opened.ok)
    throw new Error(`${opened.error.code}: ${opened.error.message}`);
  return opened.value;
}

test("Bybit fixtures pass through real mappers, SQLite restart, coverage projection and operator report", async () => {
  const directory = mkdtempSync(join(tmpdir(), "history-sync-integration-"));
  const databasePath = join(directory, "history.db");
  let exchangeWrites = 0;
  const request: typeof fetch = async (url, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "GET") exchangeWrites += 1;
    assert.equal(method, "GET");
    const path = new URL(String(url)).pathname;
    if (path === "/v5/market/time")
      return providerEnvelope({
        timeSecond: String(Math.floor(nowMs / 1_000)),
      });
    if (path === "/v5/user/query-api")
      return providerEnvelope({
        userID: "12345",
        readOnly: 0,
        permissions: {
          ContractTrade: ["Order", "Position"],
          Wallet: [],
          Spot: [],
        },
        ips: [],
        expiredAt: "0",
      });
    const source: HistoryReadSource =
      path === "/v5/order/history"
        ? "order-history"
        : path === "/v5/execution/list"
          ? "executions"
          : path === "/v5/position/closed-pnl"
            ? "closed-pnl"
            : "transaction-log";
    return providerEnvelope({
      ...(source === "transaction-log"
        ? { accountType: "UNIFIED" }
        : { category: "linear" }),
      list: providerRows[source],
      nextPageCursor: "",
    });
  };
  const provider = {
    async load() {
      return {
        apiKey: "synthetic-key",
        apiSecret: "synthetic-secret",
        accountId: "12345",
      };
    },
  };
  const wall = () => nowMs;
  const monotonic = (() => {
    let value = 0;
    return () => ++value;
  })();
  let result: Result<HistorySyncReport>;
  try {
    result = await runLiveHistorySync(
      {
        environment: "mainnet",
        databasePath,
        selection: {
          kind: "explicit-range",
          fromMs: windowFromMs,
          toMs: nowMs,
          replayId: "integration-replay-1",
        },
        budget: { maxGetAttempts: 20, maxDurationMs: 60_000 },
      },
      {
        credentialProvider: provider,
        request,
        utcClock: wall,
        monotonicClock: monotonic,
      },
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.status, "COMPLETE");
    assert.equal(result.value.getAttempts, 7);
    assert.equal(exchangeWrites, 0);
    assert.equal(
      result.value.sources.find((source) => source.source === "executions")
        ?.rowsReceived,
      2,
    );
    assert.equal(
      result.value.sources.find((source) => source.source === "executions")
        ?.unmatched,
      2,
    );
    assert.deepEqual(
      result.value.coverageLimitations.find(
        (item) => item.source === "order-history",
      )?.reasonCodes,
      [
        "TWO_YEAR_LOOKBACK_BOUNDARY",
        "OLDER_UNFILLED_ORDER_VISIBILITY_LIMITED",
        "CANCELLED_REJECTED_DEACTIVATED_ORDERS_VISIBLE_ONLY_LAST_24H",
      ],
    );

    const reopened = openDatabase(databasePath);
    try {
      const store = createSqliteHistoryStore(reopened);
      const observations = store.readFacts({
        exchange: "bybit",
        environment: "mainnet",
        accountId: result.value.scope.accountId,
      });
      assert.equal(observations.ok, true);
      if (!observations.ok) return;
      assert.equal(observations.value.length, 7);
      const executionIds = observations.value
        .filter((row) => row.fact.factKind === "execution")
        .map((row) =>
          row.fact.factKind === "execution" ? row.fact.execId : "",
        )
        .sort();
      assert.deepEqual(executionIds, ["exec-entry-1", "exec-entry-2"]);
      const money = observations.value.flatMap(historyMoneyComponents);
      assert.ok(
        money.some(
          (item) =>
            item.component === "execution-fee" && item.amount === "0.00004",
        ),
      );
      assert.ok(
        money.some(
          (item) => item.component === "fee" && item.amount === "-0.00001",
        ),
      );
      assert.ok(
        money.some(
          (item) => item.component === "funding" && item.amount === "0.00002",
        ),
      );
      assert.ok(
        money.some(
          (item) => item.component === "cash-flow" && item.amount === "5",
        ),
      );
      const coverage = store.listCoverage(observations.value[0]!.scope);
      assert.equal(coverage.ok, true);
      if (coverage.ok) assert.equal(coverage.value.length, 4);
      const noWrites = reopened.db
        .prepare(
          "SELECT COUNT(*) AS count FROM operator_mainnet_test_write_intents",
        )
        .get() as { count: number };
      assert.equal(noWrites.count, 0);
    } finally {
      reopened.close();
    }

    const output: string[] = [];
    const code = await runHistorySyncCli(
      [
        "--mode",
        "live",
        "--environment",
        "mainnet",
        "--database",
        databasePath,
        "--range",
        "resume",
      ],
      {
        output: { write: (text) => output.push(text) },
        runLive: async () => result,
      },
    );
    assert.equal(code, 0);
    const printed = output.join("");
    assert.match(printed, /STATUS=COMPLETE/u);
    assert.match(printed, /OPENING_BALANCE=UNKNOWN/u);
    assert.match(printed, /ACCOUNTING_READY=NOT_CLAIMED/u);
    assert.match(printed, /SOURCE=executions .*ROWS=2/u);
    assert.match(printed, /EXCHANGE_WRITES=0/u);
    assert.doesNotMatch(
      printed,
      /12345|synthetic-key|synthetic-secret|accountId/iu,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("bounded 31-day catch-up persists across a SQLite close and reopen", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "history-sync-catchup-restart-"),
  );
  const databasePath = join(directory, "history.db");
  const scope = {
    exchange: "bybit",
    environment: "mainnet" as const,
    accountId: `sha256:${"b".repeat(64)}`,
  };
  const targetUpper = nowMs + 31 * 24 * 60 * 60 * 1_000;
  const observed: {
    source: HistoryReadSource;
    fromMs: number;
    toMs: number;
  }[] = [];
  const reader = (record?: typeof observed) => ({
    async readPage(request: HistoryReadPageRequest) {
      record?.push({
        source: request.source,
        fromMs: request.window.fromMs,
        toMs: request.window.toMs,
      });
      return {
        source: request.source,
        window: request.window,
        cursor: request.cursor ?? null,
        nextCursor: null,
        receivedRowCount: 0,
        facts: [],
      };
    },
  });
  const run = (
    connection: ReturnType<typeof openDatabase>,
    selection: HistorySyncSelection,
    frozenUpperBoundMs: number,
    budget?: HistorySyncBudget,
    record?: typeof observed,
  ) =>
    runHistoryIngestion(
      {
        scope,
        selection,
        frozenUpperBoundMs,
        ...(budget === undefined ? {} : { budget }),
      },
      {
        store: createSqliteHistoryStore(connection),
        reader: reader(record),
        monotonicClock: (() => {
          let tick = 0;
          return () => ++tick;
        })(),
      },
    );

  try {
    let connection = openDatabase(databasePath);
    try {
      const initial = await run(
        connection,
        {
          kind: "explicit-range",
          fromMs: nowMs - 24 * 60 * 60 * 1_000,
          toMs: nowMs,
          replayId: "restart-catchup-seed",
        },
        nowMs,
      );
      assert.equal(initial.ok, true);
      if (!initial.ok) return;
      assert.equal(initial.value.status, "COMPLETE");
    } finally {
      connection.close();
    }

    connection = openDatabase(databasePath);
    try {
      const bounded = await run(
        connection,
        { kind: "resume" },
        targetUpper,
        { maxGetAttempts: 1 },
        observed,
      );
      assert.equal(bounded.ok, true);
      if (!bounded.ok) return;
      assert.equal(bounded.value.status, "PARTIAL");
      assert.ok(
        bounded.value.sources.every(
          (source) => source.nextResumeWindow !== undefined,
        ),
      );
    } finally {
      connection.close();
    }

    connection = openDatabase(databasePath);
    try {
      const store = createSqliteHistoryStore(connection);
      const persisted = store.listCoverage(scope);
      assert.equal(persisted.ok, true);
      if (persisted.ok)
        assert.ok(
          HISTORY_READ_SOURCES.every((source) =>
            persisted.value.some(
              (checkpoint) =>
                checkpoint.source === source &&
                checkpoint.filters.purpose === "recent-refresh" &&
                checkpoint.filters.rangeEndMs === targetUpper &&
                checkpoint.status !== "traversed",
            ),
          ),
        );

      const resumed = await run(
        connection,
        { kind: "resume" },
        targetUpper,
        undefined,
        observed,
      );
      assert.equal(resumed.ok, true);
      if (!resumed.ok) return;
      assert.equal(resumed.value.status, "COMPLETE");
      assert.ok(
        resumed.value.sources.every((source) => source.status === "traversed"),
      );

      const completed = store.listCoverage(scope);
      assert.equal(completed.ok, true);
      if (completed.ok)
        for (const source of HISTORY_READ_SOURCES) {
          const windows = completed.value
            .filter(
              (checkpoint) =>
                checkpoint.source === source &&
                checkpoint.filters.purpose === "recent-refresh" &&
                checkpoint.filters.rangeEndMs === targetUpper,
            )
            .sort((left, right) => left.window.fromMs - right.window.fromMs);
          assert.equal(windows.length, 5);
          assert.ok(
            windows.every((checkpoint) => checkpoint.status === "traversed"),
          );
          assert.equal(windows[0]?.window.fromMs, nowMs - 1);
          assert.equal(windows.at(-1)?.window.toMs, targetUpper);
          for (let index = 1; index < windows.length; index++)
            assert.ok(
              windows[index]!.window.fromMs <=
                windows[index - 1]!.window.toMs + 1,
            );

          const reads = observed
            .filter((request) => request.source === source)
            .sort((left, right) => left.fromMs - right.fromMs);
          assert.equal(reads.length, 5);
          assert.equal(reads[0]?.fromMs, nowMs - 1);
          assert.equal(reads.at(-1)?.toMs, targetUpper);
          for (let index = 1; index < reads.length; index++)
            assert.ok(reads[index]!.fromMs <= reads[index - 1]!.toMs + 1);
        }
    } finally {
      connection.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
