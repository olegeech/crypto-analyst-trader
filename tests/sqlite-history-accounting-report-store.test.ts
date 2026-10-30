import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSqliteHistoryAccountingWalletAnchorStore } from "../src/adapters/sqlite/history-accounting-anchor-store.js";
import { createSqliteHistoryStore } from "../src/adapters/sqlite/history-store.js";
import { createSqliteHistoryAccountingReportStore } from "../src/adapters/sqlite/history-accounting-report-store.js";
import { applyMigrations } from "../src/adapters/sqlite/migrations.js";
import { registerTrustedClock } from "../src/adapters/sqlite/sqlite-helpers.js";
import { calculateHistoryAccountingReportFromLocalEvidence } from "../src/application/history-accounting-composition.js";
import {
  canonicalSerialize,
  hashCanonical,
} from "../src/domain/identity/canonical-serialization.js";
import {
  createHistoryAccountingReport,
  decodeHistoryAccountingReport,
  encodeHistoryAccountingReport,
} from "../src/application/history-accounting-report.js";
import type { UtcTimestamp } from "../src/domain/shared/time.js";
import type { SqliteConnection } from "../src/adapters/sqlite/connection.js";
import type { HistoryAccountingReportRecord } from "../src/ports/history-accounting-report-store.js";
import { OPERATOR_MAINNET_TEST_POLICY_VERSION } from "../src/domain/execution/operator-mainnet-test-plan.js";
import {
  HISTORY_ACCOUNTING_TEST_AUTH_KEY,
  completeReportInput,
  capturedWalletAnchorForStoreTest,
  closingBoundary,
  completeHistoryCoverage,
  openingBoundary,
  historyAccountingScope,
  walletAnchor,
} from "./history-accounting-fixtures.js";

const runtime = { nodeVersion: "22.22.3", sqliteVersion: "3.51.3" } as const;

function rehashedReportRecord(
  record: HistoryAccountingReportRecord,
  mutate: (report: Record<string, unknown>) => void,
) {
  const report = JSON.parse(record.canonicalJson) as Record<string, unknown>;
  mutate(report);
  delete report.contentHash;
  const identity = hashCanonical({
    schemaVersion: report.schemaVersion,
    scope: report.scope,
    accountingScope: report.accountingScope,
    dependencyHash: report.dependencyHash,
  });
  assert.equal(identity.ok, true);
  if (!identity.ok)
    throw new Error("mutated report identity could not be hashed");
  report.reportId = `history-accounting-report:${identity.value.slice(7)}`;
  const contentHash = hashCanonical(report);
  assert.equal(contentHash.ok, true);
  if (!contentHash.ok)
    throw new Error("mutated report content could not be hashed");
  report.contentHash = contentHash.value;
  const canonicalJson = canonicalSerialize(report);
  assert.equal(canonicalJson.ok, true);
  if (!canonicalJson.ok)
    throw new Error("mutated report could not be serialized");
  return {
    ...record,
    reportId: report.reportId as string,
    dependencyHash: report.dependencyHash as string,
    contentHash: contentHash.value,
    canonicalJson: canonicalJson.value,
  };
}

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

test("composition persists and reopens a scoped v2 report with MNT excluded", () => {
  const root = mkdtempSync(join(tmpdir(), "history-accounting-v2-store-"));
  const path = join(root, "reports.sqlite");
  const makeConnection = (db: DatabaseSync): SqliteConnection => ({
    db,
    path,
    environment: "demo",
    runtime,
    clock: { now: () => "2026-10-28T09:00:00.000Z" as UtcTimestamp },
    close: () => db.close(),
  });
  let db = new DatabaseSync(path);
  let connection = makeConnection(db);
  try {
    db.exec("PRAGMA foreign_keys = ON");
    const migrations = applyMigrations(db);
    assert.equal(migrations.ok, true);
    registerTrustedClock(db, {
      now: () => "2026-10-28T09:00:00.000Z" as UtcTimestamp,
    });
    const anchorStore = createSqliteHistoryAccountingWalletAnchorStore(
      connection,
      HISTORY_ACCOUNTING_TEST_AUTH_KEY,
    );
    const openingBase = walletAnchor("opening", openingBoundary);
    const closingBase = walletAnchor("closing", closingBoundary);
    const openingMnt = { ...openingBase.assets[0]!, coin: "MNT" as const };
    const closingMnt = { ...closingBase.assets[0]!, coin: "MNT" as const };
    const opening = anchorStore.append({
      anchor: capturedWalletAnchorForStoreTest({
        ...openingBase,
        anchorId: "scoped-opening-anchor",
        assets: [...openingBase.assets, openingMnt],
      }),
    });
    const closing = anchorStore.append({
      anchor: capturedWalletAnchorForStoreTest({
        ...closingBase,
        anchorId: "scoped-closing-anchor",
        assets: [...closingBase.assets, closingMnt],
      }),
    });
    assert.equal(opening.ok, true, opening.ok ? "" : opening.error.message);
    assert.equal(closing.ok, true, closing.ok ? "" : closing.error.message);
    if (!opening.ok || !closing.ok) return;

    const history = createSqliteHistoryStore(connection);
    for (const checkpoint of completeHistoryCoverage()) {
      const committed = history.commitPage({
        scope: checkpoint.scope,
        source: checkpoint.source,
        filters: checkpoint.filters,
        window: checkpoint.window,
        expectedRevision: 0,
        cursor: null,
        nextCursor: null,
        facts: [],
      });
      assert.equal(
        committed.ok,
        true,
        committed.ok ? "" : committed.error.message,
      );
    }

    const calculated = calculateHistoryAccountingReportFromLocalEvidence(
      connection,
      historyAccountingScope,
      opening.value,
      closing.value,
      OPERATOR_MAINNET_TEST_POLICY_VERSION,
    );
    assert.equal(
      calculated.ok,
      true,
      calculated.ok ? "" : calculated.error.message,
    );
    if (!calculated.ok) return;
    assert.equal(
      calculated.value.schemaVersion,
      "history-accounting-reconciliation-report/v2",
    );
    assert.equal(calculated.value.status, "ACCOUNTING_READY");
    assert.deepEqual(
      calculated.value.epoch.currencies.map(({ currency }) => currency),
      ["USDT"],
    );
    const encoded = encodeHistoryAccountingReport(calculated.value);
    assert.equal(encoded.ok, true, encoded.ok ? "" : encoded.error.message);
    if (!encoded.ok) return;
    const store = createSqliteHistoryAccountingReportStore(connection);
    const mixedVersion = rehashedReportRecord(encoded.value, (report) => {
      const epoch = report.epoch as Record<string, unknown>;
      report.epoch = {
        ...epoch,
        schemaVersion: "history-accounting-epoch-projection/v1",
      };
    });
    assert.equal(store.append(mixedVersion).ok, false);
    assert.equal(
      db
        .prepare("SELECT COUNT(*) AS count FROM history_accounting_reports")
        .get()?.count,
      0,
    );
    const persisted = store.append(encoded.value);
    assert.equal(
      persisted.ok,
      true,
      persisted.ok ? "" : persisted.error.message,
    );

    connection.close();
    db = new DatabaseSync(path);
    connection = makeConnection(db);
    const reopenedStore = createSqliteHistoryAccountingReportStore(connection);
    const reopened = reopenedStore.readById(encoded.value.reportId);
    assert.equal(reopened.ok, true, reopened.ok ? "" : reopened.error.message);
    assert.ok(reopened.ok && reopened.value);
    if (!reopened.ok || !reopened.value) return;
    const decoded = decodeHistoryAccountingReport(reopened.value);
    assert.equal(decoded.ok, true, decoded.ok ? "" : decoded.error.message);
    assert.deepEqual(decoded.ok && decoded.value, calculated.value);

    const reopenedAnchors = createSqliteHistoryAccountingWalletAnchorStore(
      connection,
      HISTORY_ACCOUNTING_TEST_AUTH_KEY,
    );
    const replayOpening = reopenedAnchors.readById(opening.value.anchorId);
    const replayClosing = reopenedAnchors.readById(closing.value.anchorId);
    assert.equal(replayOpening.ok, true);
    assert.equal(replayClosing.ok, true);
    if (
      !replayOpening.ok ||
      !replayOpening.value ||
      !replayClosing.ok ||
      !replayClosing.value
    )
      return;
    const replay = calculateHistoryAccountingReportFromLocalEvidence(
      connection,
      historyAccountingScope,
      replayOpening.value,
      replayClosing.value,
      OPERATOR_MAINNET_TEST_POLICY_VERSION,
    );
    assert.equal(replay.ok, true, replay.ok ? "" : replay.error.message);
    const replayRecord = replay.ok
      ? encodeHistoryAccountingReport(replay.value)
      : undefined;
    assert.equal(
      replayRecord?.ok,
      true,
      replayRecord?.ok ? "" : replayRecord?.error.message,
    );
    assert.equal(
      replayRecord?.ok && replayRecord.value.canonicalJson,
      encoded.value.canonicalJson,
    );

    const legacy = createHistoryAccountingReport(
      completeReportInput({ opening: opening.value, closing: closing.value }),
    );
    assert.equal(legacy.ok, true, legacy.ok ? "" : legacy.error.message);
    const legacyRecord = legacy.ok
      ? encodeHistoryAccountingReport(legacy.value)
      : undefined;
    assert.equal(legacyRecord?.ok, true);
    if (legacyRecord?.ok) {
      assert.notEqual(legacyRecord.value.reportId, encoded.value.reportId);
      assert.equal(reopenedStore.append(legacyRecord.value).ok, true);
      assert.equal(
        db
          .prepare("SELECT COUNT(*) AS count FROM history_accounting_reports")
          .get()?.count,
        2,
      );
    }
  } finally {
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
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
