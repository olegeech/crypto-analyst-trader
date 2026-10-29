import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createSqliteHistoryAccountingWalletAnchorStore } from "../src/adapters/sqlite/history-accounting-anchor-store.js";
import { createSqliteHistoryAccountingReportStore } from "../src/adapters/sqlite/history-accounting-report-store.js";
import { applyMigrations } from "../src/adapters/sqlite/migrations.js";
import { registerTrustedClock } from "../src/adapters/sqlite/sqlite-helpers.js";
import {
  createHistoryAccountingReport,
  decodeHistoryAccountingReport,
  encodeHistoryAccountingReport,
} from "../src/application/history-accounting-report.js";
import type { UtcTimestamp } from "../src/domain/shared/time.js";
import type { SqliteConnection } from "../src/adapters/sqlite/connection.js";
import {
  HISTORY_ACCOUNTING_TEST_AUTH_KEY,
  completeReportInput,
  capturedWalletAnchorForStoreTest,
  closingBoundary,
  openingBoundary,
  walletAnchor,
} from "./history-accounting-fixtures.js";

const runtime = { nodeVersion: "22.22.3", sqliteVersion: "3.51.3" } as const;

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const migrations = applyMigrations(db);
  assert.equal(migrations.ok, true);
  registerTrustedClock(db, {
    now: () => "2026-10-28T09:00:00.000Z" as UtcTimestamp,
  });
  const connection: SqliteConnection = {
    db,
    path: ":memory:",
    environment: "demo",
    runtime,
    clock: { now: () => "2026-10-28T09:00:00.000Z" as UtcTimestamp },
    close: () => db.close(),
  };
  return { db, connection };
}

function insertAnchors(connection: SqliteConnection) {
  const store = createSqliteHistoryAccountingWalletAnchorStore(
    connection,
    HISTORY_ACCOUNTING_TEST_AUTH_KEY,
  );
  const opening = store.append({
    anchor: capturedWalletAnchorForStoreTest({
      ...walletAnchor("opening", openingBoundary),
      anchorId: "opening-store-anchor",
    }),
  });
  const closing = store.append({
    anchor: capturedWalletAnchorForStoreTest({
      ...walletAnchor("closing", closingBoundary),
      anchorId: "closing-store-anchor",
    }),
  });
  assert.equal(opening.ok, true, opening.ok ? "" : opening.error.message);
  assert.equal(closing.ok, true, closing.ok ? "" : closing.error.message);
  if (!opening.ok || !closing.ok)
    throw new Error("fixture anchor persistence failed");
  return { opening: opening.value, closing: closing.value };
}

function persistedReport(connection: SqliteConnection) {
  const anchors = insertAnchors(connection);
  const report = createHistoryAccountingReport(
    completeReportInput({ opening: anchors.opening, closing: anchors.closing }),
  );
  assert.equal(report.ok, true, report.ok ? "" : report.error.message);
  if (!report.ok) throw new Error("fixture report calculation failed");
  const encoded = encodeHistoryAccountingReport(report.value);
  assert.equal(encoded.ok, true, encoded.ok ? "" : encoded.error.message);
  if (!encoded.ok) throw new Error("fixture report encoding failed");
  return { ...anchors, report: report.value, record: encoded.value };
}

test("report store is append-only, idempotent, scope-bound and verifies readback", () => {
  const { db, connection } = database();
  try {
    const { record, report } = persistedReport(connection);
    const store = createSqliteHistoryAccountingReportStore(connection);
    const appended = store.append(record);
    assert.equal(appended.ok, true, appended.ok ? "" : appended.error.message);
    assert.deepEqual(appended.ok && appended.value, record);
    const replay = store.append(record);
    assert.deepEqual(replay.ok && replay.value, record);
    const read = store.readById(record.reportId);
    assert.equal(read.ok, true, read.ok ? "" : read.error.message);
    assert.deepEqual(read.ok && read.value, record);
    const decoded =
      read.ok && read.value
        ? decodeHistoryAccountingReport(read.value)
        : undefined;
    assert.equal(decoded?.ok, true);
    assert.deepEqual(decoded?.ok && decoded.value, report);
    assert.throws(() =>
      db
        .prepare("UPDATE history_accounting_reports SET status = 'NOT_READY'")
        .run(),
    );
    assert.throws(() =>
      db.prepare("DELETE FROM history_accounting_reports").run(),
    );
  } finally {
    db.close();
  }
});

test("report append rolls back an injected SQLite insert failure", () => {
  const { db, connection } = database();
  try {
    const { record } = persistedReport(connection);
    const store = createSqliteHistoryAccountingReportStore(connection);
    db.exec(`
      CREATE TRIGGER reject_history_report_insert
      BEFORE INSERT ON history_accounting_reports
      BEGIN
        SELECT RAISE(ABORT, 'injected report insert failure');
      END;
    `);

    assert.equal(store.append(record).ok, false);
    assert.equal(
      db
        .prepare("SELECT COUNT(*) AS count FROM history_accounting_reports")
        .get()?.count,
      0,
    );

    db.exec("DROP TRIGGER reject_history_report_insert");
    assert.equal(store.append(record).ok, true);
    assert.equal(
      db
        .prepare("SELECT COUNT(*) AS count FROM history_accounting_reports")
        .get()?.count,
      1,
    );
  } finally {
    db.close();
  }
});

test("report store refuses absent, wrong-scope, reversed, or same anchors", () => {
  const { db, connection } = database();
  try {
    const { opening, closing, record } = persistedReport(connection);
    const store = createSqliteHistoryAccountingReportStore(connection);
    assert.equal(
      store.append({ ...record, openingAnchorId: "not-persisted" }).ok,
      false,
    );
    assert.equal(
      store.append({ ...record, openingAnchorId: record.closingAnchorId }).ok,
      false,
    );

    assert.equal(
      store.append({
        ...record,
        scope: { ...record.scope, accountId: `sha256:${"d".repeat(64)}` },
      }).ok,
      false,
    );

    const reversed = createHistoryAccountingReport(
      completeReportInput({ opening: closing, closing: opening }),
    );
    assert.equal(reversed.ok, true);
    if (!reversed.ok) return;
    const reversedRecord = encodeHistoryAccountingReport(reversed.value);
    assert.equal(reversedRecord.ok, true);
    if (!reversedRecord.ok) return;
    assert.equal(store.append(reversedRecord.value).ok, false);
  } finally {
    db.close();
  }
});

test("a caller-created self-hashed report is not proof without trusted persisted anchors", () => {
  const { db, connection } = database();
  try {
    const forged = createHistoryAccountingReport(completeReportInput());
    assert.equal(forged.ok, true);
    if (!forged.ok) return;
    const selfConsistent = encodeHistoryAccountingReport(forged.value);
    assert.equal(selfConsistent.ok, true);
    if (!selfConsistent.ok) return;
    const result = createSqliteHistoryAccountingReportStore(connection).append(
      selfConsistent.value,
    );
    assert.equal(result.ok, false);
    const count = db
      .prepare("SELECT COUNT(*) AS count FROM history_accounting_reports")
      .get() as { count: number };
    assert.equal(count.count, 0);
  } finally {
    db.close();
  }
});
