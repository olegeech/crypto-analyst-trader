import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createSqliteHistoryStore } from "../src/adapters/sqlite/history-store.js";
import { applyMigrations } from "../src/adapters/sqlite/migrations.js";
import { registerTrustedClock } from "../src/adapters/sqlite/sqlite-helpers.js";
import { createHistorySourceFact } from "../src/domain/accounting/history-source-fact.js";
import type { HistoryStorePageRequest } from "../src/ports/history-store.js";
import type { SqliteConnection } from "../src/adapters/sqlite/connection.js";
import type { UtcTimestamp } from "../src/domain/shared/time.js";

const now = "2026-10-27T12:00:00.000Z" as UtcTimestamp;
const scope = {
  exchange: "bybit",
  environment: "demo" as const,
  accountId: `sha256:${"a".repeat(64)}`,
};
const window = {
  fromMs: Date.parse("2026-10-20T00:00:00.000Z"),
  toMs: Date.parse("2026-10-27T00:00:00.000Z"),
};
const filters = { category: "linear" };

function openStore() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  assert.equal(applyMigrations(db).ok, true);
  const clock = { now: () => now };
  registerTrustedClock(db, clock);
  const connection: SqliteConnection = {
    db,
    path: ":memory:",
    environment: "demo",
    runtime: { nodeVersion: "22.22.3", sqliteVersion: "3.51.3" },
    clock,
    close: () => db.close(),
  };
  const store = createSqliteHistoryStore(connection);
  return { db, store };
}

function orderFact(
  orderStatus: string,
  providerRevisionTime: string | null,
  collectedAt = now,
) {
  const result = createHistorySourceFact({
    factKind: "order",
    source: "order-history",
    category: "linear",
    symbol: "DOGEUSDT",
    orderId: "order-1",
    orderLinkId: null,
    parentOrderLinkId: null,
    side: "Buy",
    orderType: "Limit",
    orderStatus,
    timeInForce: "GTC",
    qty: "10",
    price: "0.1",
    avgPrice: null,
    cumExecQty: "0",
    cumExecValue: "0",
    cumExecFee: null,
    feeDetails: [],
    leavesQty: "10",
    leavesValue: "1",
    createType: null,
    cancelType: null,
    rejectReason: null,
    tpslMode: null,
    tpTriggerBy: null,
    slTriggerBy: null,
    triggerBy: null,
    triggerPrice: null,
    takeProfit: null,
    stopLoss: null,
    stopOrderType: null,
    marketUnit: null,
    isLeverage: null,
    blockTradeId: null,
    reduceOnly: false,
    closeOnTrigger: false,
    positionIdx: "0",
    providerEventTime: "2026-10-26T12:00:00.000Z",
    providerRevisionTime,
    collectedAt,
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function executionFact(execPrice: string) {
  const result = createHistorySourceFact({
    factKind: "execution",
    source: "executions",
    category: "linear",
    symbol: "DOGEUSDT",
    orderId: "order-1",
    orderLinkId: null,
    execId: "exec-1",
    side: "Buy",
    execType: "Trade",
    execPrice,
    execQty: "10",
    execValue: "1",
    execFee: "0.001",
    execFeeV2: null,
    feeCurrency: "USDT",
    feeRate: null,
    execPnl: null,
    closedSize: null,
    isMaker: true,
    seq: "1",
    leavesQty: null,
    markPrice: null,
    indexPrice: null,
    underlyingPrice: null,
    createType: null,
    blockTradeId: null,
    extraFees: null,
    orderPrice: null,
    orderQty: null,
    providerEventTime: "2026-10-26T12:00:00.000Z",
    providerRevisionTime: null,
    collectedAt: now,
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function closedPnlFact(createdAt: string) {
  const result = createHistorySourceFact({
    factKind: "closed-pnl",
    source: "closed-pnl",
    category: "linear",
    symbol: "DOGEUSDT",
    orderId: "shared-order",
    side: "Sell",
    orderType: "Market",
    execType: "Trade",
    qty: "10",
    orderPrice: "0.1",
    closedSize: "10",
    cumEntryValue: "1",
    avgEntryPrice: "0.1",
    cumExitValue: "1.1",
    avgExitPrice: "0.11",
    closedPnl: "0.1",
    openFee: "0.001",
    closeFee: "0.001",
    fundingFee: "0",
    fillCount: "1",
    leverage: "1",
    providerEventTime: createdAt,
    providerRevisionTime: null,
    collectedAt: now,
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function basePage(
  overrides: Partial<HistoryStorePageRequest> = {},
): HistoryStorePageRequest {
  return {
    scope,
    source: "order-history",
    filters,
    window,
    expectedRevision: 0,
    cursor: null,
    nextCursor: null,
    facts: [orderFact("New", "2026-10-26T12:00:00.000Z")],
    ...overrides,
  };
}

test("history page facts and terminal coverage commit atomically and replay idempotently", () => {
  const { db, store } = openStore();
  const first = store.commitPage(basePage());
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.value.inserted, 1);
  assert.equal(first.value.duplicates, 0);
  assert.equal(first.value.checkpoint.status, "traversed");
  assert.equal(first.value.checkpoint.revision, 1);

  const replay = store.commitPage(
    basePage({
      expectedRevision: 1,
      facts: [
        orderFact(
          "New",
          "2026-10-26T12:00:00.000Z",
          "2026-10-27T12:01:00.000Z" as UtcTimestamp,
        ),
      ],
    }),
  );
  assert.equal(replay.ok, true);
  if (replay.ok) {
    assert.equal(replay.value.inserted, 0);
    assert.equal(replay.value.duplicates, 1);
    assert.equal(replay.value.checkpoint.revision, 1);
  }
  const facts = store.readFacts(scope);
  assert.equal(facts.ok, true);
  if (facts.ok) assert.equal(facts.value.length, 1);
  db.close();
});

test("interrupted windows can replay from the beginning and continue with the saved cursor", () => {
  const { db, store } = openStore();
  const first = store.commitPage(basePage({ nextCursor: "cursor-1" }));
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.value.checkpoint.status, "paging");
  assert.equal(first.value.checkpoint.cursor, "cursor-1");

  const replay = store.commitPage(
    basePage({ expectedRevision: 1, nextCursor: "cursor-1" }),
  );
  assert.equal(replay.ok, true);
  if (!replay.ok) return;
  assert.equal(replay.value.inserted, 0);
  assert.equal(replay.value.checkpoint.revision, 2);
  assert.equal(replay.value.checkpoint.cursor, "cursor-1");

  const terminal = store.commitPage(
    basePage({
      expectedRevision: 2,
      cursor: "cursor-1",
      facts: [],
      nextCursor: null,
    }),
  );
  assert.equal(terminal.ok, true);
  if (terminal.ok) assert.equal(terminal.value.checkpoint.status, "traversed");
  db.close();
});

test("mutable order revisions append while equal revision conflicts stay visible", () => {
  const { db, store } = openStore();
  const first = store.commitPage(
    basePage({ facts: [orderFact("New", "2026-10-26T12:00:00.000Z")] }),
  );
  assert.equal(first.ok, true);
  const revision = store.commitPage(
    basePage({
      expectedRevision: 1,
      facts: [orderFact("PartiallyFilled", "2026-10-26T12:01:00.000Z")],
    }),
  );
  assert.equal(revision.ok, true);
  if (revision.ok) assert.equal(revision.value.inserted, 1);

  const conflicting = store.commitPage(
    basePage({
      expectedRevision: 2,
      facts: [orderFact("Filled", "2026-10-26T12:01:00.000Z")],
    }),
  );
  assert.equal(conflicting.ok, true);
  if (conflicting.ok) assert.equal(conflicting.value.conflicts.length, 1);
  const facts = store.readFacts(scope, "order-history");
  const conflicts = store.readConflicts(scope);
  const checkpoints = store.listCoverage(scope, "order-history");
  assert.equal(facts.ok, true);
  assert.equal(conflicts.ok, true);
  assert.equal(checkpoints.ok, true);
  if (facts.ok) assert.equal(facts.value.length, 3);
  if (conflicts.ok) {
    assert.equal(conflicts.value.length, 1);
    assert.equal(conflicts.value[0]?.windows?.length, 1);
    assert.deepEqual(conflicts.value[0]?.windows?.[0]?.window, window);
    if (checkpoints.ok)
      assert.equal(
        conflicts.value[0]?.windows?.[0]?.filterHash,
        checkpoints.value[0]?.filterHash,
      );
  }
  db.close();
});

test("immutable execution identity conflicts are retained as evidence", () => {
  const { db, store } = openStore();
  const first = store.commitPage(
    basePage({ source: "executions", facts: [executionFact("0.1")] }),
  );
  assert.equal(first.ok, true);
  const conflict = store.commitPage(
    basePage({
      source: "executions",
      expectedRevision: 1,
      facts: [executionFact("0.2")],
    }),
  );
  assert.equal(conflict.ok, true);
  if (conflict.ok) {
    assert.equal(conflict.value.conflicts.length, 1);
    assert.equal(conflict.value.checkpoint.conflictCount, 1);
  }
  const replay = store.commitPage(
    basePage({
      source: "executions",
      expectedRevision: 2,
      facts: [executionFact("0.2")],
    }),
  );
  assert.equal(replay.ok, true);
  if (replay.ok) {
    assert.equal(replay.value.inserted, 0);
    assert.equal(replay.value.checkpoint.conflictCount, 1);
    assert.equal(replay.value.checkpoint.revision, 2);
  }
  const facts = store.readFacts(scope, "executions");
  const conflicts = store.readConflicts(scope);
  const checkpoints = store.listCoverage(scope, "executions");
  assert.equal(facts.ok, true);
  assert.equal(conflicts.ok, true);
  assert.equal(checkpoints.ok, true);
  if (facts.ok) assert.equal(facts.value.length, 2);
  if (conflicts.ok) {
    assert.equal(conflicts.value.length, 1);
    assert.equal(conflicts.value[0]?.windows?.length, 1);
    assert.deepEqual(conflicts.value[0]?.windows?.[0]?.window, window);
    if (checkpoints.ok)
      assert.equal(
        conflicts.value[0]?.windows?.[0]?.filterHash,
        checkpoints.value[0]?.filterHash,
      );
  }
  db.close();
});

test("closed-PnL rows sharing an order ID remain distinct by grouping provenance", () => {
  const { db, store } = openStore();
  const first = store.commitPage(
    basePage({
      source: "closed-pnl",
      facts: [closedPnlFact("2026-10-25T12:00:00.000Z")],
    }),
  );
  assert.equal(first.ok, true);
  const second = store.commitPage(
    basePage({
      source: "closed-pnl",
      expectedRevision: 1,
      facts: [closedPnlFact("2026-10-26T12:00:00.000Z")],
    }),
  );
  assert.equal(second.ok, true);
  const facts = store.readFacts(scope, "closed-pnl");
  assert.equal(facts.ok, true);
  if (facts.ok) assert.equal(facts.value.length, 2);
  const conflicts = store.readConflicts(scope, "closed-pnl");
  assert.equal(conflicts.ok, true);
  if (conflicts.ok) assert.equal(conflicts.value.length, 0);
  db.close();
});

test("stale revisions and mismatched account, environment, stream, window or filter cannot advance a checkpoint", () => {
  const { db, store } = openStore();
  assert.equal(store.commitPage(basePage()).ok, true);
  const stale = store.commitPage(
    basePage({
      expectedRevision: 0,
      facts: [orderFact("Filled", "2026-10-26T13:00:00.000Z")],
    }),
  );
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.error.code, "CHECKPOINT_STALE");

  const otherAccount = store.commitPage(
    basePage({
      scope: { ...scope, accountId: `sha256:${"b".repeat(64)}` },
      expectedRevision: 1,
    }),
  );
  assert.equal(otherAccount.ok, false);
  if (!otherAccount.ok)
    assert.equal(otherAccount.error.code, "CHECKPOINT_STALE");

  const otherFilter = store.commitPage(
    basePage({ filters: { category: "inverse" }, expectedRevision: 1 }),
  );
  assert.equal(otherFilter.ok, false);
  if (!otherFilter.ok) assert.equal(otherFilter.error.code, "CHECKPOINT_STALE");

  const otherStream = store.commitPage(
    basePage({
      source: "executions",
      expectedRevision: 1,
      facts: [executionFact("0.1")],
    }),
  );
  assert.equal(otherStream.ok, false);
  if (!otherStream.ok) assert.equal(otherStream.error.code, "CHECKPOINT_STALE");

  const skippedFirstPage = store.commitPage(
    basePage({
      source: "transaction-log",
      cursor: "skip-ahead",
      expectedRevision: 0,
      facts: [],
    }),
  );
  assert.equal(skippedFirstPage.ok, false);
  if (!skippedFirstPage.ok) {
    assert.equal(skippedFirstPage.error.code, "CHECKPOINT_STALE");
  }

  const otherWindow = store.commitPage(
    basePage({
      window: { ...window, fromMs: window.fromMs + 1 },
      expectedRevision: 1,
    }),
  );
  assert.equal(otherWindow.ok, false);
  if (!otherWindow.ok) assert.equal(otherWindow.error.code, "CHECKPOINT_STALE");

  const otherEnvironment = store.commitPage(
    basePage({
      scope: { ...scope, environment: "testnet" },
      expectedRevision: 0,
    }),
  );
  assert.equal(otherEnvironment.ok, false);
  if (!otherEnvironment.ok) {
    assert.equal(otherEnvironment.error.code, "PERSISTENCE_ENVIRONMENT");
  }

  const rawAccountIdentity = store.readFacts({
    ...scope,
    accountId: "raw-bybit-uid",
  });
  assert.equal(rawAccountIdentity.ok, false);
  if (!rawAccountIdentity.ok) {
    assert.equal(rawAccountIdentity.error.code, "INVALID_HASH");
  }

  const otherExchange = store.readFacts({ ...scope, exchange: "other" });
  assert.equal(otherExchange.ok, false);
  if (!otherExchange.ok) {
    assert.equal(otherExchange.error.code, "UNSUPPORTED_CONTRACT");
  }
  db.close();
});

test("mid-page SQLite failure rolls back observations and checkpoint together", () => {
  const { db, store } = openStore();
  const first = orderFact("New", "2026-10-26T12:00:00.000Z");
  const second = orderFact("Filled", "2026-10-26T12:01:00.000Z");
  db.prepare(
    `CREATE TRIGGER fail_second_history_fact BEFORE INSERT ON history_source_observations
     WHEN NEW.content_hash = '${second.contentHash}'
     BEGIN SELECT RAISE(ABORT, 'synthetic page failure'); END`,
  ).run();
  const failed = store.commitPage(basePage({ facts: [first, second] }));
  assert.equal(failed.ok, false);
  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS count FROM history_source_observations")
      .get()?.count,
    0,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM history_window_checkpoints").get()
      ?.count,
    0,
  );
  db.close();
});

test("partial coverage is scoped and active HALT does not block local history writes", () => {
  const { db, store } = openStore();
  const haltAccount = scope.accountId;
  db.prepare(
    `INSERT INTO halt_state
     (exchange, environment, account_id, category, position_mode, active, revision,
      reason, raised_at, reconciliation_required)
     VALUES ('bybit', 'demo', ?, 'linear', 'one-way', 1, 1, 'test', ?, 0)`,
  ).run(haltAccount, now);
  const partial = store.markCoverage({
    scope,
    source: "order-history",
    filters,
    window,
    expectedRevision: 0,
    status: "partial",
    reasonCode: "REQUEST_BUDGET_EXHAUSTED",
  });
  assert.equal(partial.ok, true);
  const page = store.commitPage(
    basePage({
      expectedRevision: 1,
      facts: [orderFact("New", "2026-10-26T12:00:00.000Z")],
    }),
  );
  assert.equal(page.ok, true);
  assert.equal(
    db
      .prepare("SELECT active FROM halt_state WHERE account_id = ?")
      .get(haltAccount)?.active,
    1,
  );
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM operator_mainnet_test_write_intents",
      )
      .get()?.count,
    0,
  );
  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS count FROM operator_mainnet_recovery_grants")
      .get()?.count,
    0,
  );
  db.close();
});
