import type { DatabaseSync } from "node:sqlite";

export const accountingCheckpointsMigration = {
  version: 3,
  name: "accounting-checkpoints",
  apply(database: DatabaseSync): void {
    database.exec(`
      CREATE TABLE accounting_facts (
        fact_id TEXT PRIMARY KEY,
        fact_kind TEXT NOT NULL CHECK (fact_kind IN ('fill', 'fee', 'funding', 'ledger-entry', 'exchange-observation', 'reconciliation', 'audit')),
        exchange TEXT NOT NULL,
        environment TEXT NOT NULL CHECK (environment IN ('demo', 'testnet', 'mainnet')),
        account_id TEXT NOT NULL,
        category TEXT NOT NULL,
        position_mode TEXT NOT NULL CHECK (position_mode IN ('one-way', 'hedge')),
        event_identity TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        observation_revision TEXT,
        reference_id TEXT,
        linked_fact_id TEXT REFERENCES accounting_facts (fact_id),
        adjustment_reason TEXT,
        quantity TEXT,
        price TEXT,
        amount TEXT,
        fee TEXT,
        funding_amount TEXT,
        balance_before TEXT,
        balance_after TEXT,
        canonical_json TEXT NOT NULL,
        canonical_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (exchange, environment, account_id, category, position_mode, fact_kind, event_identity)
      );

      CREATE TABLE accounting_conflicts (
        conflict_id TEXT PRIMARY KEY,
        exchange TEXT NOT NULL,
        environment TEXT NOT NULL CHECK (environment IN ('demo', 'testnet', 'mainnet')),
        account_id TEXT NOT NULL,
        category TEXT NOT NULL,
        position_mode TEXT NOT NULL CHECK (position_mode IN ('one-way', 'hedge')),
        fact_kind TEXT NOT NULL,
        event_identity TEXT NOT NULL,
        existing_hash TEXT NOT NULL,
        incoming_hash TEXT NOT NULL,
        reason TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );

      CREATE TABLE checkpoints (
        stream TEXT NOT NULL,
        exchange TEXT NOT NULL,
        environment TEXT NOT NULL CHECK (environment IN ('demo', 'testnet', 'mainnet')),
        account_id TEXT NOT NULL,
        category TEXT NOT NULL,
        position_mode TEXT NOT NULL CHECK (position_mode IN ('one-way', 'hedge')),
        cursor TEXT,
        observed_through TEXT,
        overlap_from TEXT,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 0),
        PRIMARY KEY (stream, exchange, environment, account_id, category, position_mode)
      );

      CREATE TABLE audit_events (
        event_id TEXT PRIMARY KEY,
        exchange TEXT NOT NULL,
        environment TEXT NOT NULL CHECK (environment IN ('demo', 'testnet', 'mainnet')),
        account_id TEXT NOT NULL,
        category TEXT NOT NULL,
        position_mode TEXT NOT NULL CHECK (position_mode IN ('one-way', 'hedge')),
        event_kind TEXT NOT NULL,
        event_identity TEXT,
        recorded_at TEXT NOT NULL,
        canonical_json TEXT NOT NULL,
        canonical_hash TEXT NOT NULL
      );

      CREATE INDEX accounting_facts_scope_idx
        ON accounting_facts (exchange, environment, account_id, category, position_mode, observed_at);
      CREATE INDEX accounting_conflicts_scope_idx
        ON accounting_conflicts (exchange, environment, account_id, category, position_mode, recorded_at);
      CREATE INDEX audit_events_scope_idx
        ON audit_events (exchange, environment, account_id, category, position_mode, recorded_at);
    `);
  },
} as const;
