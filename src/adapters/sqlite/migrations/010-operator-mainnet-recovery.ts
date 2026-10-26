import type { DatabaseSync } from "node:sqlite";

/** Add append-only, plan-bound recovery evidence without rewriting prior history. */
export const operatorMainnetRecoveryMigration = {
  version: 10,
  name: "operator-mainnet-recovery",
  apply(database: DatabaseSync): void {
    database.exec(`
      CREATE TABLE operator_mainnet_recovery_attestations (
        attestation_hash TEXT PRIMARY KEY,
        attestation_id TEXT NOT NULL UNIQUE,
        exchange TEXT NOT NULL CHECK (exchange = 'bybit'),
        environment TEXT NOT NULL CHECK (environment = 'mainnet'),
        account_id TEXT NOT NULL,
        category TEXT NOT NULL CHECK (category = 'linear'),
        position_mode TEXT NOT NULL CHECK (position_mode = 'one-way'),
        source_id TEXT NOT NULL
          REFERENCES operator_mainnet_test_sources (source_id) ON DELETE RESTRICT,
        source_revision INTEGER NOT NULL CHECK (source_revision >= 0),
        observed_at TEXT NOT NULL,
        canonical_json TEXT NOT NULL,
        canonical_hash TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        UNIQUE (exchange, environment, account_id, canonical_hash)
      );

      CREATE INDEX operator_mainnet_recovery_attestations_source_idx
        ON operator_mainnet_recovery_attestations
          (exchange, environment, account_id, source_id, source_revision);

      CREATE TABLE operator_mainnet_recovery_grants (
        grant_id TEXT PRIMARY KEY,
        exchange TEXT NOT NULL CHECK (exchange = 'bybit'),
        environment TEXT NOT NULL CHECK (environment = 'mainnet'),
        account_id TEXT NOT NULL,
        category TEXT NOT NULL CHECK (category = 'linear'),
        position_mode TEXT NOT NULL CHECK (position_mode = 'one-way'),
        source_id TEXT NOT NULL
          REFERENCES operator_mainnet_test_sources (source_id) ON DELETE RESTRICT,
        source_revision INTEGER NOT NULL CHECK (source_revision >= 0),
        plan_hash TEXT NOT NULL,
        plan_artifact_id TEXT NOT NULL REFERENCES artifacts (artifact_id) ON DELETE RESTRICT,
        resolution_kind TEXT NOT NULL CHECK (resolution_kind IN ('api-resolved', 'manual-attested')),
        evidence_hash TEXT,
        attestation_hash TEXT
          REFERENCES operator_mainnet_recovery_attestations (attestation_hash) ON DELETE RESTRICT,
        halt_revision INTEGER NOT NULL CHECK (halt_revision >= 0),
        halt_origin_event_id TEXT REFERENCES halt_events (event_id) ON DELETE RESTRICT,
        halt_origin_revision INTEGER CHECK (halt_origin_revision > 0),
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        canonical_json TEXT NOT NULL,
        canonical_hash TEXT NOT NULL,
        CHECK (
          (resolution_kind = 'api-resolved' AND evidence_hash IS NOT NULL AND attestation_hash IS NULL)
          OR
          (resolution_kind = 'manual-attested' AND evidence_hash IS NULL AND attestation_hash IS NOT NULL)
        ),
        CHECK (
          (halt_origin_event_id IS NULL AND halt_origin_revision IS NULL)
          OR
          (halt_origin_event_id IS NOT NULL AND halt_origin_revision IS NOT NULL)
        ),
        UNIQUE (attestation_hash)
      );

      CREATE INDEX operator_mainnet_recovery_grants_scope_idx
        ON operator_mainnet_recovery_grants
          (exchange, environment, account_id, source_id, issued_at);

      CREATE TABLE operator_mainnet_recovery_grant_consumptions (
        grant_id TEXT PRIMARY KEY
          REFERENCES operator_mainnet_recovery_grants (grant_id) ON DELETE RESTRICT,
        exchange TEXT NOT NULL CHECK (exchange = 'bybit'),
        environment TEXT NOT NULL CHECK (environment = 'mainnet'),
        account_id TEXT NOT NULL,
        new_source_id TEXT NOT NULL UNIQUE
          REFERENCES operator_mainnet_test_sources (source_id) ON DELETE RESTRICT,
        new_write_intent_id TEXT NOT NULL UNIQUE
          REFERENCES operator_mainnet_test_write_intents (write_intent_id) ON DELETE RESTRICT,
        consumed_at TEXT NOT NULL,
        canonical_json TEXT NOT NULL,
        canonical_hash TEXT NOT NULL
      );

      CREATE TABLE operator_mainnet_test_source_dispositions (
        disposition_id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL UNIQUE
          REFERENCES operator_mainnet_test_sources (source_id) ON DELETE RESTRICT,
        revision INTEGER NOT NULL CHECK (revision > 0),
        disposition TEXT NOT NULL CHECK (disposition = 'human-attested'),
        grant_id TEXT NOT NULL UNIQUE
          REFERENCES operator_mainnet_recovery_grants (grant_id) ON DELETE RESTRICT,
        next_source_id TEXT NOT NULL UNIQUE
          REFERENCES operator_mainnet_test_sources (source_id) ON DELETE RESTRICT,
        next_write_intent_id TEXT NOT NULL UNIQUE
          REFERENCES operator_mainnet_test_write_intents (write_intent_id) ON DELETE RESTRICT,
        canonical_json TEXT NOT NULL,
        canonical_hash TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        CHECK (source_id <> next_source_id)
      );
    `);
  },
} as const;
