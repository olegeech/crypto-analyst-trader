import type { DatabaseSync } from "node:sqlite";

/** Add immutable, dependency-bound account reconciliation reports. */
export const historyAccountingReportsMigration = {
  version: 13,
  name: "history-accounting-reports",
  apply(database: DatabaseSync): void {
    database.exec(`
      CREATE TABLE history_accounting_reports (
        report_id TEXT PRIMARY KEY,
        exchange TEXT NOT NULL CHECK (exchange = 'bybit'),
        environment TEXT NOT NULL CHECK (environment IN ('demo', 'testnet', 'mainnet')),
        account_id TEXT NOT NULL,
        evaluated_at TEXT NOT NULL,
        opening_anchor_id TEXT NOT NULL REFERENCES history_accounting_wallet_anchors(anchor_id) ON DELETE RESTRICT,
        closing_anchor_id TEXT NOT NULL REFERENCES history_accounting_wallet_anchors(anchor_id) ON DELETE RESTRICT,
        status TEXT NOT NULL CHECK (status IN ('ACCOUNTING_READY', 'NOT_READY')),
        dependency_hash TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        canonical_json TEXT NOT NULL,
        UNIQUE (exchange, environment, account_id, opening_anchor_id, closing_anchor_id, dependency_hash)
      );

      CREATE INDEX history_accounting_reports_scope_idx
        ON history_accounting_reports
          (exchange, environment, account_id, evaluated_at, report_id);

      CREATE TRIGGER history_accounting_reports_no_update
        BEFORE UPDATE ON history_accounting_reports
        BEGIN
          SELECT RAISE(ABORT, 'history accounting reports are append-only');
        END;

      CREATE TRIGGER history_accounting_reports_no_delete
        BEFORE DELETE ON history_accounting_reports
        BEGIN
          SELECT RAISE(ABORT, 'history accounting reports are append-only');
        END;
    `);
  },
} as const;
