import type { DatabaseSync } from "node:sqlite";

/** Additive source-native journal for the isolated #31 operator experiment. */
export const operatorMainnetTestMigration = {
  version: 8,
  name: "operator-mainnet-test",
  apply(database: DatabaseSync): void {
    database.exec(`
      CREATE TABLE operator_mainnet_test_sources (
        source_id TEXT PRIMARY KEY,
        exchange TEXT NOT NULL CHECK (exchange = 'bybit'),
        environment TEXT NOT NULL CHECK (environment = 'mainnet'),
        account_id TEXT NOT NULL,
        category TEXT NOT NULL CHECK (category = 'linear'),
        position_mode TEXT NOT NULL CHECK (position_mode = 'one-way'),
        plan_hash TEXT NOT NULL,
        plan_artifact_id TEXT NOT NULL REFERENCES artifacts (artifact_id) ON DELETE RESTRICT,
        approval_hash TEXT NOT NULL,
        approval_artifact_id TEXT NOT NULL REFERENCES artifacts (artifact_id) ON DELETE RESTRICT,
        client_order_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (exchange, environment, account_id, category, position_mode, plan_hash),
        UNIQUE (exchange, environment, account_id, category, position_mode, client_order_id)
      );

      CREATE INDEX operator_mainnet_test_sources_scope_idx
        ON operator_mainnet_test_sources
          (exchange, environment, account_id, category, position_mode, created_at);

      CREATE TABLE operator_mainnet_test_write_intents (
        write_intent_id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL UNIQUE
          REFERENCES operator_mainnet_test_sources (source_id) ON DELETE RESTRICT,
        operation TEXT NOT NULL CHECK (operation = 'CREATE'),
        run_id TEXT NOT NULL,
        lease_owner_run_id TEXT NOT NULL,
        lease_epoch INTEGER NOT NULL CHECK (lease_epoch > 0),
        canonical_json TEXT NOT NULL,
        canonical_hash TEXT NOT NULL,
        prepared_at TEXT NOT NULL
      );

      CREATE TABLE operator_mainnet_test_attempts (
        attempt_id TEXT PRIMARY KEY,
        write_intent_id TEXT NOT NULL UNIQUE
          REFERENCES operator_mainnet_test_write_intents (write_intent_id) ON DELETE RESTRICT,
        outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'rejected', 'ambiguous')),
        exchange_order_id TEXT,
        provider_reason_code TEXT,
        canonical_json TEXT NOT NULL,
        canonical_hash TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );

      CREATE TABLE operator_mainnet_test_reconciliations (
        reconciliation_id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL
          REFERENCES operator_mainnet_test_sources (source_id) ON DELETE RESTRICT,
        revision INTEGER NOT NULL CHECK (revision > 0),
        lifecycle_outcome TEXT NOT NULL CHECK (lifecycle_outcome IN (
          'ENTRY_TP_PROVEN', 'TP_LIFECYCLE_PASS', 'NOT_EXERCISED',
          'PARTIAL_EVIDENCE', 'UNKNOWN', 'MANUAL_CLEANUP'
        )),
        cleanup_status TEXT NOT NULL CHECK (cleanup_status IN (
          'pending', 'verified-clean', 'unknown'
        )),
        canonical_json TEXT NOT NULL,
        canonical_hash TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        UNIQUE (source_id, revision)
      );

      CREATE TABLE operator_mainnet_test_manual_actions (
        action_id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL
          REFERENCES operator_mainnet_test_sources (source_id) ON DELETE RESTRICT,
        revision INTEGER NOT NULL CHECK (revision > 0),
        action TEXT NOT NULL CHECK (action IN (
          'entry-remainder-cancelled', 'position-closed', 'other'
        )),
        canonical_json TEXT NOT NULL,
        canonical_hash TEXT NOT NULL,
        declared_at TEXT NOT NULL,
        UNIQUE (source_id, revision)
      );

    `);
  },
} as const;
