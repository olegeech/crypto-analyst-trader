import type { DatabaseSync } from "node:sqlite";

/** Add a local, account-scoped source-observation journal and window progress. */
export const historyIngestionMigration = {
  version: 11,
  name: "history-ingestion",
  apply(database: DatabaseSync): void {
    database.exec(`
      CREATE TABLE history_source_observations (
        observation_id TEXT PRIMARY KEY,
        exchange TEXT NOT NULL,
        environment TEXT NOT NULL CHECK (environment IN ('demo', 'testnet', 'mainnet')),
        account_id TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN (
          'order-history', 'executions', 'closed-pnl', 'transaction-log'
        )),
        event_identity TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        canonical_hash TEXT NOT NULL,
        provider_event_time TEXT NOT NULL,
        provider_revision_time TEXT,
        collected_at TEXT NOT NULL,
        canonical_json TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        UNIQUE (exchange, environment, account_id, source, event_identity, content_hash)
      );

      CREATE INDEX history_source_observations_scope_idx
        ON history_source_observations
          (exchange, environment, account_id, source, provider_event_time, event_identity);

      CREATE INDEX history_source_observations_identity_idx
        ON history_source_observations
          (exchange, environment, account_id, source, event_identity, provider_revision_time);

      CREATE TABLE history_source_conflicts (
        conflict_id TEXT PRIMARY KEY,
        exchange TEXT NOT NULL,
        environment TEXT NOT NULL CHECK (environment IN ('demo', 'testnet', 'mainnet')),
        account_id TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN (
          'order-history', 'executions', 'closed-pnl', 'transaction-log'
        )),
        event_identity TEXT NOT NULL,
        existing_hash TEXT NOT NULL,
        incoming_hash TEXT NOT NULL,
        reason TEXT NOT NULL CHECK (reason IN (
          'IMMUTABLE_ID_CONTENT_CHANGED', 'ORDER_REVISION_CONTENT_CHANGED'
        )),
        recorded_at TEXT NOT NULL,
        UNIQUE (exchange, environment, account_id, source, event_identity,
                existing_hash, incoming_hash, reason)
      );

      CREATE INDEX history_source_conflicts_scope_idx
        ON history_source_conflicts
          (exchange, environment, account_id, source, recorded_at);

      CREATE TABLE history_window_conflicts (
        exchange TEXT NOT NULL,
        environment TEXT NOT NULL CHECK (environment IN ('demo', 'testnet', 'mainnet')),
        account_id TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN (
          'order-history', 'executions', 'closed-pnl', 'transaction-log'
        )),
        filter_hash TEXT NOT NULL,
        window_from_ms INTEGER NOT NULL CHECK (window_from_ms >= 0),
        window_to_ms INTEGER NOT NULL CHECK (window_to_ms > window_from_ms),
        conflict_id TEXT NOT NULL REFERENCES history_source_conflicts (conflict_id) ON DELETE RESTRICT,
        PRIMARY KEY (exchange, environment, account_id, source, filter_hash,
                     window_from_ms, window_to_ms, conflict_id)
      );

      CREATE INDEX history_window_conflicts_scope_idx
        ON history_window_conflicts
          (exchange, environment, account_id, source, filter_hash, window_from_ms);

      CREATE TABLE history_window_checkpoints (
        exchange TEXT NOT NULL,
        environment TEXT NOT NULL CHECK (environment IN ('demo', 'testnet', 'mainnet')),
        account_id TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN (
          'order-history', 'executions', 'closed-pnl', 'transaction-log'
        )),
        filter_hash TEXT NOT NULL,
        filters_json TEXT NOT NULL,
        window_from_ms INTEGER NOT NULL CHECK (window_from_ms >= 0),
        window_to_ms INTEGER NOT NULL CHECK (window_to_ms > window_from_ms),
        cursor TEXT,
        status TEXT NOT NULL CHECK (status IN (
          'paging', 'partial', 'traversed', 'unavailable'
        )),
        row_count INTEGER NOT NULL DEFAULT 0 CHECK (row_count >= 0),
        inserted_count INTEGER NOT NULL DEFAULT 0 CHECK (inserted_count >= 0),
        duplicate_count INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_count >= 0),
        conflict_count INTEGER NOT NULL DEFAULT 0 CHECK (conflict_count >= 0),
        reason_code TEXT,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        PRIMARY KEY (exchange, environment, account_id, source, filter_hash,
                    window_from_ms, window_to_ms)
      );

      CREATE INDEX history_window_checkpoints_scope_idx
        ON history_window_checkpoints
          (exchange, environment, account_id, source, window_from_ms, status);
    `);
  },
} as const;
