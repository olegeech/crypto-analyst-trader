import type { DatabaseSync } from "node:sqlite";

/** Store immutable, mapped wallet-anchor evidence without exchange payloads. */
export const historyAccountingAnchorsMigration = {
  version: 12,
  name: "history-accounting-anchors",
  apply(database: DatabaseSync): void {
    database.exec(`
      CREATE TABLE history_accounting_wallet_anchors (
        anchor_id TEXT PRIMARY KEY,
        exchange TEXT NOT NULL CHECK (exchange = 'bybit'),
        environment TEXT NOT NULL CHECK (environment IN ('demo', 'testnet', 'mainnet')),
        account_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('opening', 'closing')),
        identity_origin TEXT NOT NULL,
        identity_observed_at TEXT NOT NULL,
        collection_started_at TEXT NOT NULL,
        collection_ended_at TEXT NOT NULL,
        provider_time_before TEXT NOT NULL,
        provider_response_time TEXT NOT NULL,
        provider_time_after TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        canonical_hash TEXT NOT NULL,
        canonical_json TEXT NOT NULL,
        capture_mac TEXT NOT NULL
      );

      CREATE INDEX history_accounting_wallet_anchors_scope_idx
        ON history_accounting_wallet_anchors
          (exchange, environment, account_id, recorded_at, anchor_id);

      CREATE TRIGGER history_accounting_wallet_anchors_no_update
        BEFORE UPDATE ON history_accounting_wallet_anchors
        BEGIN
          SELECT RAISE(ABORT, 'history accounting wallet anchors are append-only');
        END;

      CREATE TRIGGER history_accounting_wallet_anchors_no_delete
        BEFORE DELETE ON history_accounting_wallet_anchors
        BEGIN
          SELECT RAISE(ABORT, 'history accounting wallet anchors are append-only');
        END;
    `);
  },
} as const;
