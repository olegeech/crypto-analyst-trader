import type { DatabaseSync } from "node:sqlite";

/** Persist direct-command evidence while retaining the v13 legacy source bytes. */
export const operatorMainnetTradeCommandMigration = {
  version: 14,
  name: "operator-mainnet-trade-command",
  apply(database: DatabaseSync): void {
    database.exec(`
      ALTER TABLE operator_mainnet_test_sources
        ADD COLUMN authorization_kind TEXT NOT NULL DEFAULT 'approval'
        CHECK (authorization_kind IN ('approval', 'trade-command'));
      ALTER TABLE operator_mainnet_test_sources
        ADD COLUMN authorization_hash TEXT;
      ALTER TABLE operator_mainnet_test_sources
        ADD COLUMN authorization_artifact_id TEXT
          REFERENCES artifacts (artifact_id) ON DELETE RESTRICT;

      UPDATE operator_mainnet_test_sources
      SET authorization_hash = approval_hash,
          authorization_artifact_id = approval_artifact_id;

      CREATE TRIGGER operator_mainnet_test_sources_authorization_insert
        BEFORE INSERT ON operator_mainnet_test_sources
        WHEN NEW.authorization_hash IS NULL
          OR NEW.authorization_artifact_id IS NULL
          OR (NEW.authorization_kind = 'approval' AND
              (NEW.authorization_hash <> NEW.approval_hash OR
               NEW.authorization_artifact_id <> NEW.approval_artifact_id))
          OR (NEW.authorization_kind = 'trade-command' AND
              (NEW.authorization_hash <> NEW.approval_hash OR
               NEW.authorization_artifact_id <> NEW.approval_artifact_id))
        BEGIN
          SELECT RAISE(ABORT, 'operator authorization reference is invalid');
        END;

      CREATE TRIGGER operator_mainnet_test_sources_authorization_update
        BEFORE UPDATE OF authorization_kind, authorization_hash,
          authorization_artifact_id, approval_hash, approval_artifact_id
        ON operator_mainnet_test_sources
        BEGIN
          SELECT RAISE(ABORT, 'operator authorization references are immutable');
        END;

      CREATE TABLE operator_mainnet_trade_command_receipts (
        command_id TEXT PRIMARY KEY,
        exchange TEXT NOT NULL CHECK (exchange = 'bybit'),
        environment TEXT NOT NULL CHECK (environment = 'mainnet'),
        account_id TEXT NOT NULL,
        category TEXT NOT NULL CHECK (category = 'linear'),
        position_mode TEXT NOT NULL CHECK (position_mode = 'one-way'),
        receipt_hash TEXT NOT NULL UNIQUE,
        receipt_artifact_id TEXT NOT NULL UNIQUE
          REFERENCES artifacts (artifact_id) ON DELETE RESTRICT,
        accepted_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        CHECK (expires_at > accepted_at),
        UNIQUE (exchange, environment, account_id, command_id)
      );

      CREATE TABLE operator_mainnet_trade_command_bindings (
        command_id TEXT PRIMARY KEY
          REFERENCES operator_mainnet_trade_command_receipts (command_id) ON DELETE RESTRICT,
        exchange TEXT NOT NULL CHECK (exchange = 'bybit'),
        environment TEXT NOT NULL CHECK (environment = 'mainnet'),
        account_id TEXT NOT NULL,
        category TEXT NOT NULL CHECK (category = 'linear'),
        position_mode TEXT NOT NULL CHECK (position_mode = 'one-way'),
        binding_hash TEXT NOT NULL UNIQUE,
        binding_artifact_id TEXT NOT NULL UNIQUE
          REFERENCES artifacts (artifact_id) ON DELETE RESTRICT,
        plan_hash TEXT NOT NULL,
        plan_artifact_id TEXT NOT NULL
          REFERENCES artifacts (artifact_id) ON DELETE RESTRICT,
        source_id TEXT NOT NULL UNIQUE,
        client_order_id TEXT NOT NULL,
        create_payload_hash TEXT NOT NULL,
        bound_at TEXT NOT NULL,
        UNIQUE (exchange, environment, account_id, client_order_id)
      );

      CREATE INDEX operator_mainnet_trade_command_bindings_source_idx
        ON operator_mainnet_trade_command_bindings (source_id);

      CREATE TABLE operator_mainnet_trade_command_consumptions (
        command_id TEXT PRIMARY KEY
          REFERENCES operator_mainnet_trade_command_bindings (command_id) ON DELETE RESTRICT,
        receipt_hash TEXT NOT NULL,
        binding_hash TEXT NOT NULL,
        source_id TEXT NOT NULL UNIQUE
          REFERENCES operator_mainnet_test_sources (source_id) ON DELETE RESTRICT,
        write_intent_id TEXT NOT NULL UNIQUE
          REFERENCES operator_mainnet_test_write_intents (write_intent_id) ON DELETE RESTRICT,
        consumed_at TEXT NOT NULL
      );

      CREATE TABLE operator_mainnet_trade_command_outcomes (
        outcome_id TEXT PRIMARY KEY,
        command_id TEXT NOT NULL
          REFERENCES operator_mainnet_trade_command_receipts (command_id) ON DELETE RESTRICT,
        revision INTEGER NOT NULL CHECK (revision > 0),
        stage TEXT NOT NULL CHECK (stage IN (
          'plan-derivation', 'precheck', 'binding', 'admission'
        )),
        code TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        diagnostics_json TEXT NOT NULL,
        canonical_json TEXT NOT NULL,
        canonical_hash TEXT NOT NULL,
        UNIQUE (command_id, revision)
      );

      CREATE INDEX operator_mainnet_trade_command_outcomes_latest_idx
        ON operator_mainnet_trade_command_outcomes (command_id, revision DESC);

      CREATE TRIGGER operator_mainnet_trade_command_receipts_no_update
        BEFORE UPDATE ON operator_mainnet_trade_command_receipts
        BEGIN
          SELECT RAISE(ABORT, 'operator trade-command receipts are immutable');
        END;
      CREATE TRIGGER operator_mainnet_trade_command_receipts_no_delete
        BEFORE DELETE ON operator_mainnet_trade_command_receipts
        BEGIN
          SELECT RAISE(ABORT, 'operator trade-command receipts are append-only');
        END;
      CREATE TRIGGER operator_mainnet_trade_command_bindings_no_update
        BEFORE UPDATE ON operator_mainnet_trade_command_bindings
        BEGIN
          SELECT RAISE(ABORT, 'operator trade-command bindings are immutable');
        END;
      CREATE TRIGGER operator_mainnet_trade_command_bindings_no_delete
        BEFORE DELETE ON operator_mainnet_trade_command_bindings
        BEGIN
          SELECT RAISE(ABORT, 'operator trade-command bindings are append-only');
        END;
      CREATE TRIGGER operator_mainnet_trade_command_consumptions_no_update
        BEFORE UPDATE ON operator_mainnet_trade_command_consumptions
        BEGIN
          SELECT RAISE(ABORT, 'operator trade-command consumptions are immutable');
        END;
      CREATE TRIGGER operator_mainnet_trade_command_consumptions_no_delete
        BEFORE DELETE ON operator_mainnet_trade_command_consumptions
        BEGIN
          SELECT RAISE(ABORT, 'operator trade-command consumptions are append-only');
        END;
      CREATE TRIGGER operator_mainnet_trade_command_outcomes_no_update
        BEFORE UPDATE ON operator_mainnet_trade_command_outcomes
        BEGIN
          SELECT RAISE(ABORT, 'operator trade-command outcomes are immutable');
        END;
      CREATE TRIGGER operator_mainnet_trade_command_outcomes_no_delete
        BEFORE DELETE ON operator_mainnet_trade_command_outcomes
        BEGIN
          SELECT RAISE(ABORT, 'operator trade-command outcomes are append-only');
        END;
    `);
  },
} as const;
