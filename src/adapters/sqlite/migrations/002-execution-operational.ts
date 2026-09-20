import type { DatabaseSync } from "node:sqlite";

export const executionOperationalMigration = {
  version: 2,
  name: "execution-operational",
  apply(database: DatabaseSync): void {
    database.exec(`
      CREATE TABLE artifacts (
        artifact_id TEXT PRIMARY KEY,
        artifact_kind TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        canonical_json TEXT NOT NULL,
        canonical_hash TEXT NOT NULL,
        material_hash TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE execution_lineages (
        lineage_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        plan_id TEXT NOT NULL,
        plan_hash TEXT NOT NULL,
        exchange TEXT NOT NULL,
        environment TEXT NOT NULL CHECK (environment IN ('demo', 'testnet', 'mainnet')),
        account_id TEXT NOT NULL,
        category TEXT NOT NULL,
        position_mode TEXT NOT NULL CHECK (position_mode IN ('one-way', 'hedge')),
        created_at TEXT NOT NULL,
        status TEXT NOT NULL,
        UNIQUE (exchange, environment, account_id, category, position_mode, plan_hash)
      );

      CREATE INDEX execution_lineages_scope_idx
        ON execution_lineages (exchange, environment, account_id, category, position_mode);

      CREATE TABLE approvals (
        approval_id TEXT PRIMARY KEY,
        lineage_id TEXT NOT NULL REFERENCES execution_lineages (lineage_id),
        plan_hash TEXT NOT NULL,
        actor TEXT NOT NULL,
        approved_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        note TEXT
      );

      CREATE TABLE owned_intents (
        intent_record_id TEXT PRIMARY KEY,
        lineage_id TEXT NOT NULL REFERENCES execution_lineages (lineage_id),
        intent_id TEXT NOT NULL,
        plan_hash TEXT NOT NULL,
        client_order_id TEXT NOT NULL,
        exchange TEXT NOT NULL,
        environment TEXT NOT NULL CHECK (environment IN ('demo', 'testnet', 'mainnet')),
        account_id TEXT NOT NULL,
        category TEXT NOT NULL,
        position_mode TEXT NOT NULL CHECK (position_mode IN ('one-way', 'hedge')),
        prepared_at TEXT NOT NULL,
        status TEXT NOT NULL,
        UNIQUE (lineage_id, intent_id),
        UNIQUE (exchange, environment, account_id, category, position_mode, client_order_id)
      );

      CREATE TABLE execution_attempts (
        attempt_id TEXT PRIMARY KEY,
        lineage_id TEXT NOT NULL REFERENCES execution_lineages (lineage_id),
        intent_record_id TEXT NOT NULL REFERENCES owned_intents (intent_record_id),
        attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
        plan_hash TEXT NOT NULL,
        intent_id TEXT NOT NULL,
        client_order_id TEXT NOT NULL,
        submitted_at TEXT NOT NULL,
        acknowledgement TEXT NOT NULL CHECK (acknowledgement IN ('pending', 'accepted', 'rejected')),
        terminal_status TEXT NOT NULL CHECK (terminal_status IN ('unverified', 'open', 'filled', 'cancelled', 'rejected')),
        exchange_order_id TEXT,
        canonical_json TEXT NOT NULL,
        canonical_hash TEXT NOT NULL,
        UNIQUE (lineage_id, attempt_number)
      );

      CREATE TABLE exchange_observations (
        observation_id TEXT PRIMARY KEY,
        lineage_id TEXT REFERENCES execution_lineages (lineage_id),
        attempt_id TEXT REFERENCES execution_attempts (attempt_id),
        exchange TEXT NOT NULL,
        environment TEXT NOT NULL CHECK (environment IN ('demo', 'testnet', 'mainnet')),
        account_id TEXT NOT NULL,
        category TEXT NOT NULL,
        position_mode TEXT NOT NULL CHECK (position_mode IN ('one-way', 'hedge')),
        event_identity TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        canonical_json TEXT NOT NULL,
        canonical_hash TEXT NOT NULL,
        UNIQUE (exchange, environment, account_id, category, position_mode, event_identity)
      );

      CREATE TABLE reconciliation_results (
        reconciliation_id TEXT PRIMARY KEY,
        lineage_id TEXT NOT NULL REFERENCES execution_lineages (lineage_id),
        attempt_id TEXT NOT NULL REFERENCES execution_attempts (attempt_id),
        intent_id TEXT NOT NULL,
        plan_hash TEXT NOT NULL,
        client_order_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('RECONCILED', 'PARTIAL', 'FAILED', 'PENDING', 'UNRESOLVED')),
        observed_at TEXT NOT NULL,
        exchange_order_id TEXT,
        canonical_json TEXT NOT NULL,
        canonical_hash TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        UNIQUE (lineage_id, revision)
      );

      CREATE TABLE leases (
        exchange TEXT NOT NULL,
        environment TEXT NOT NULL CHECK (environment IN ('demo', 'testnet', 'mainnet')),
        account_id TEXT NOT NULL,
        category TEXT NOT NULL,
        position_mode TEXT NOT NULL CHECK (position_mode IN ('one-way', 'hedge')),
        owner_run_id TEXT NOT NULL,
        epoch INTEGER NOT NULL CHECK (epoch > 0),
        acquired_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        reconciliation_required INTEGER NOT NULL CHECK (reconciliation_required IN (0, 1)),
        PRIMARY KEY (exchange, environment, account_id, category, position_mode)
      );

      CREATE TABLE halt_state (
        exchange TEXT NOT NULL,
        environment TEXT NOT NULL CHECK (environment IN ('demo', 'testnet', 'mainnet')),
        account_id TEXT NOT NULL,
        category TEXT NOT NULL,
        position_mode TEXT NOT NULL CHECK (position_mode IN ('one-way', 'hedge')),
        active INTEGER NOT NULL CHECK (active IN (0, 1)),
        revision INTEGER NOT NULL CHECK (revision >= 0),
        reason TEXT,
        raised_at TEXT,
        reconciliation_required INTEGER NOT NULL CHECK (reconciliation_required IN (0, 1)),
        PRIMARY KEY (exchange, environment, account_id, category, position_mode)
      );

      CREATE TABLE halt_events (
        event_id TEXT PRIMARY KEY,
        exchange TEXT NOT NULL,
        environment TEXT NOT NULL CHECK (environment IN ('demo', 'testnet', 'mainnet')),
        account_id TEXT NOT NULL,
        category TEXT NOT NULL,
        position_mode TEXT NOT NULL CHECK (position_mode IN ('one-way', 'hedge')),
        revision INTEGER NOT NULL CHECK (revision > 0),
        active INTEGER NOT NULL CHECK (active IN (0, 1)),
        reason TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        evidence_json TEXT,
        UNIQUE (exchange, environment, account_id, category, position_mode, revision)
      );

      CREATE INDEX execution_attempts_lineage_idx
        ON execution_attempts (lineage_id, attempt_number);
      CREATE INDEX reconciliation_results_lineage_idx
        ON reconciliation_results (lineage_id, revision);
      CREATE INDEX exchange_observations_lineage_idx
        ON exchange_observations (lineage_id, observed_at);
    `);
  },
} as const;
