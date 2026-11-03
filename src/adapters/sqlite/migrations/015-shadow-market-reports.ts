import type { DatabaseSync } from "node:sqlite";

export const shadowMarketReportsMigration = {
  version: 15,
  name: "shadow-market-reports",
  apply(database: DatabaseSync): void {
    database.exec(`
      CREATE TABLE shadow_market_reports (
        content_hash TEXT PRIMARY KEY,
        environment TEXT NOT NULL CHECK (environment IN ('demo', 'testnet', 'mainnet')),
        canonical_json TEXT NOT NULL,
        canonical_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX shadow_market_reports_environment_idx
        ON shadow_market_reports (environment, content_hash);

      CREATE TRIGGER shadow_market_reports_no_update
      BEFORE UPDATE ON shadow_market_reports
      BEGIN
        SELECT RAISE(ABORT, 'shadow reports are immutable');
      END;

      CREATE TRIGGER shadow_market_reports_no_delete
      BEFORE DELETE ON shadow_market_reports
      BEGIN
        SELECT RAISE(ABORT, 'shadow reports are immutable');
      END;
    `);
  },
} as const;
