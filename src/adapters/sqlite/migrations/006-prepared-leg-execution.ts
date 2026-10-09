import type { DatabaseSync } from "node:sqlite";

export const preparedLegExecutionMigration = {
  version: 6,
  name: "prepared-leg-execution",
  apply(database: DatabaseSync): void {
    database.exec(`
      CREATE TABLE prepared_leg_sources (
        source_id TEXT PRIMARY KEY,
        exchange TEXT NOT NULL CHECK (exchange = 'bybit'),
        environment TEXT NOT NULL CHECK (environment = 'mainnet'),
        account_id TEXT NOT NULL,
        category TEXT NOT NULL CHECK (category = 'linear'),
        position_mode TEXT NOT NULL CHECK (position_mode = 'one-way'),
        prepared_hash TEXT NOT NULL,
        prepared_artifact_id TEXT NOT NULL REFERENCES artifacts (artifact_id) ON DELETE RESTRICT,
        leg_id TEXT NOT NULL,
        client_order_id TEXT NOT NULL,
        selection_json TEXT NOT NULL,
        selection_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (exchange, environment, account_id, category, position_mode, prepared_hash, leg_id),
        UNIQUE (exchange, environment, account_id, category, position_mode, client_order_id)
      );

      CREATE INDEX prepared_leg_sources_scope_idx
        ON prepared_leg_sources (exchange, environment, account_id, category, position_mode, created_at);

      CREATE TABLE prepared_leg_approvals (
        source_id TEXT NOT NULL REFERENCES prepared_leg_sources (source_id) ON DELETE RESTRICT,
        approval_hash TEXT NOT NULL,
        approval_artifact_id TEXT NOT NULL REFERENCES artifacts (artifact_id) ON DELETE RESTRICT,
        associated_at TEXT NOT NULL,
        PRIMARY KEY (source_id, approval_hash)
      );

      CREATE TABLE prepared_leg_write_intents (
        write_intent_id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES prepared_leg_sources (source_id) ON DELETE RESTRICT,
        operation TEXT NOT NULL CHECK (operation IN ('create', 'cancel')),
        run_id TEXT NOT NULL,
        lease_epoch INTEGER NOT NULL CHECK (lease_epoch > 0),
        client_order_id TEXT NOT NULL,
        exchange_order_id TEXT,
        canonical_json TEXT NOT NULL,
        canonical_hash TEXT NOT NULL,
        prepared_at TEXT NOT NULL,
        CHECK ((operation = 'create' AND exchange_order_id IS NULL) OR
               (operation = 'cancel' AND exchange_order_id IS NOT NULL)),
        UNIQUE (source_id, operation)
      );

      CREATE TABLE prepared_leg_attempts (
        attempt_id TEXT PRIMARY KEY,
        write_intent_id TEXT NOT NULL UNIQUE REFERENCES prepared_leg_write_intents (write_intent_id) ON DELETE RESTRICT,
        operation TEXT NOT NULL CHECK (operation IN ('create', 'cancel')),
        canonical_json TEXT NOT NULL,
        canonical_hash TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );

      CREATE TABLE prepared_leg_reconciliations (
        reconciliation_id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES prepared_leg_sources (source_id) ON DELETE RESTRICT,
        revision INTEGER NOT NULL CHECK (revision > 0),
        status TEXT NOT NULL CHECK (status IN ('CONFIRMED_OPEN', 'PROTECTION_PENDING', 'CANCELLED', 'REJECTED', 'UNRESOLVED')),
        observed_at TEXT NOT NULL,
        exchange_order_id TEXT,
        canonical_json TEXT NOT NULL,
        canonical_hash TEXT NOT NULL,
        UNIQUE (source_id, revision)
      );

      CREATE INDEX prepared_leg_reconciliations_source_idx
        ON prepared_leg_reconciliations (source_id, revision);
    `);
  },
} as const;
