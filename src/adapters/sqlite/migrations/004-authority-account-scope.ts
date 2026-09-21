import type { DatabaseSync } from "node:sqlite";

export const authorityAccountScopeMigration = {
  version: 4,
  name: "authority-account-scope",
  apply(database: DatabaseSync): void {
    database.exec(`
      CREATE TABLE leases_account_scoped (
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
        PRIMARY KEY (exchange, environment, account_id)
      );

      INSERT INTO leases_account_scoped
        (exchange, environment, account_id, category, position_mode, owner_run_id, epoch, acquired_at, expires_at, reconciliation_required)
      SELECT exchange, environment, account_id, category, position_mode, owner_run_id, epoch, acquired_at, expires_at, reconciliation_required
      FROM leases;

      DROP TABLE leases;
      ALTER TABLE leases_account_scoped RENAME TO leases;

      CREATE TABLE halt_state_account_scoped (
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
        PRIMARY KEY (exchange, environment, account_id)
      );

      INSERT INTO halt_state_account_scoped
        (exchange, environment, account_id, category, position_mode, active, revision, reason, raised_at, reconciliation_required)
      SELECT exchange, environment, account_id, category, position_mode, active, revision, reason, raised_at, reconciliation_required
      FROM halt_state;

      DROP TABLE halt_state;
      ALTER TABLE halt_state_account_scoped RENAME TO halt_state;

      CREATE TABLE halt_events_account_scoped (
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
        UNIQUE (exchange, environment, account_id, revision)
      );

      INSERT INTO halt_events_account_scoped
        (event_id, exchange, environment, account_id, category, position_mode, revision, active, reason, recorded_at, evidence_json)
      SELECT event_id, exchange, environment, account_id, category, position_mode, revision, active, reason, recorded_at, evidence_json
      FROM halt_events;

      DROP TABLE halt_events;
      ALTER TABLE halt_events_account_scoped RENAME TO halt_events;

      CREATE INDEX halt_events_authority_scope_idx
        ON halt_events (exchange, environment, account_id, revision);

      ALTER TABLE execution_attempts ADD COLUMN dispatched_at TEXT;
      UPDATE execution_attempts
      SET dispatched_at = submitted_at
      WHERE dispatched_at IS NULL;

      ALTER TABLE reconciliation_results ADD COLUMN recorded_at TEXT;
      UPDATE reconciliation_results
      SET recorded_at = observed_at
      WHERE recorded_at IS NULL;

      ALTER TABLE artifacts ADD COLUMN exchange TEXT;
      ALTER TABLE artifacts ADD COLUMN environment TEXT;
      ALTER TABLE artifacts ADD COLUMN account_id TEXT;
      ALTER TABLE artifacts ADD COLUMN category TEXT;
      ALTER TABLE artifacts ADD COLUMN position_mode TEXT;

      UPDATE artifacts
      SET exchange = (SELECT l.exchange FROM execution_lineages l WHERE l.plan_id = artifacts.artifact_id LIMIT 1),
          environment = (SELECT l.environment FROM execution_lineages l WHERE l.plan_id = artifacts.artifact_id LIMIT 1),
          account_id = (SELECT l.account_id FROM execution_lineages l WHERE l.plan_id = artifacts.artifact_id LIMIT 1),
          category = (SELECT l.category FROM execution_lineages l WHERE l.plan_id = artifacts.artifact_id LIMIT 1),
          position_mode = (SELECT l.position_mode FROM execution_lineages l WHERE l.plan_id = artifacts.artifact_id LIMIT 1)
      WHERE artifact_kind = 'execution-plan' AND exchange IS NULL;

      UPDATE artifacts
      SET exchange = (SELECT l.exchange FROM approvals p INNER JOIN execution_lineages l ON l.lineage_id = p.lineage_id WHERE p.approval_id = artifacts.artifact_id LIMIT 1),
          environment = (SELECT l.environment FROM approvals p INNER JOIN execution_lineages l ON l.lineage_id = p.lineage_id WHERE p.approval_id = artifacts.artifact_id LIMIT 1),
          account_id = (SELECT l.account_id FROM approvals p INNER JOIN execution_lineages l ON l.lineage_id = p.lineage_id WHERE p.approval_id = artifacts.artifact_id LIMIT 1),
          category = (SELECT l.category FROM approvals p INNER JOIN execution_lineages l ON l.lineage_id = p.lineage_id WHERE p.approval_id = artifacts.artifact_id LIMIT 1),
          position_mode = (SELECT l.position_mode FROM approvals p INNER JOIN execution_lineages l ON l.lineage_id = p.lineage_id WHERE p.approval_id = artifacts.artifact_id LIMIT 1)
      WHERE artifact_kind = 'approval' AND exchange IS NULL;

      UPDATE artifacts
      SET exchange = (SELECT l.exchange FROM execution_attempts ea INNER JOIN execution_lineages l ON l.lineage_id = ea.lineage_id WHERE ea.attempt_id = artifacts.artifact_id LIMIT 1),
          environment = (SELECT l.environment FROM execution_attempts ea INNER JOIN execution_lineages l ON l.lineage_id = ea.lineage_id WHERE ea.attempt_id = artifacts.artifact_id LIMIT 1),
          account_id = (SELECT l.account_id FROM execution_attempts ea INNER JOIN execution_lineages l ON l.lineage_id = ea.lineage_id WHERE ea.attempt_id = artifacts.artifact_id LIMIT 1),
          category = (SELECT l.category FROM execution_attempts ea INNER JOIN execution_lineages l ON l.lineage_id = ea.lineage_id WHERE ea.attempt_id = artifacts.artifact_id LIMIT 1),
          position_mode = (SELECT l.position_mode FROM execution_attempts ea INNER JOIN execution_lineages l ON l.lineage_id = ea.lineage_id WHERE ea.attempt_id = artifacts.artifact_id LIMIT 1)
      WHERE artifact_kind = 'execution-attempt' AND exchange IS NULL;

      UPDATE artifacts
      SET exchange = (SELECT l.exchange FROM reconciliation_results rr INNER JOIN execution_lineages l ON l.lineage_id = rr.lineage_id WHERE rr.canonical_hash = artifacts.canonical_hash LIMIT 1),
          environment = (SELECT l.environment FROM reconciliation_results rr INNER JOIN execution_lineages l ON l.lineage_id = rr.lineage_id WHERE rr.canonical_hash = artifacts.canonical_hash LIMIT 1),
          account_id = (SELECT l.account_id FROM reconciliation_results rr INNER JOIN execution_lineages l ON l.lineage_id = rr.lineage_id WHERE rr.canonical_hash = artifacts.canonical_hash LIMIT 1),
          category = (SELECT l.category FROM reconciliation_results rr INNER JOIN execution_lineages l ON l.lineage_id = rr.lineage_id WHERE rr.canonical_hash = artifacts.canonical_hash LIMIT 1),
          position_mode = (SELECT l.position_mode FROM reconciliation_results rr INNER JOIN execution_lineages l ON l.lineage_id = rr.lineage_id WHERE rr.canonical_hash = artifacts.canonical_hash LIMIT 1)
      WHERE artifact_kind = 'reconciliation-result' AND exchange IS NULL;

      UPDATE artifacts
      SET exchange = (SELECT f.exchange FROM accounting_facts f WHERE f.reference_id = artifacts.artifact_id LIMIT 1),
          environment = (SELECT f.environment FROM accounting_facts f WHERE f.reference_id = artifacts.artifact_id LIMIT 1),
          account_id = (SELECT f.account_id FROM accounting_facts f WHERE f.reference_id = artifacts.artifact_id LIMIT 1),
          category = (SELECT f.category FROM accounting_facts f WHERE f.reference_id = artifacts.artifact_id LIMIT 1),
          position_mode = (SELECT f.position_mode FROM accounting_facts f WHERE f.reference_id = artifacts.artifact_id LIMIT 1)
      WHERE exchange IS NULL;

      UPDATE artifacts
      SET exchange = (SELECT h.exchange FROM halt_events h WHERE h.evidence_json = artifacts.canonical_json LIMIT 1),
          environment = (SELECT h.environment FROM halt_events h WHERE h.evidence_json = artifacts.canonical_json LIMIT 1),
          account_id = (SELECT h.account_id FROM halt_events h WHERE h.evidence_json = artifacts.canonical_json LIMIT 1),
          category = (SELECT h.category FROM halt_events h WHERE h.evidence_json = artifacts.canonical_json LIMIT 1),
          position_mode = (SELECT h.position_mode FROM halt_events h WHERE h.evidence_json = artifacts.canonical_json LIMIT 1)
      WHERE artifact_kind = 'clearance-evidence' AND exchange IS NULL;
    `);
    const unscoped = database
      .prepare(
        `SELECT COUNT(*) AS count FROM artifacts
         WHERE exchange IS NULL OR environment IS NULL OR account_id IS NULL OR category IS NULL OR position_mode IS NULL`,
      )
      .get() as { readonly count?: unknown } | undefined;
    if (unscoped?.count !== 0) {
      throw new Error("existing SQLite artifacts cannot be bound to a scope");
    }
  },
} as const;
