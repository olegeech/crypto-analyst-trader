import type { DatabaseSync } from "node:sqlite";

export const executionIdentityBindingsMigration = {
  version: 5,
  name: "execution-identity-bindings",
  apply(database: DatabaseSync): void {
    database.exec(`
      CREATE TABLE execution_identity_bindings (
        binding_id TEXT PRIMARY KEY,
        lineage_id TEXT NOT NULL REFERENCES execution_lineages (lineage_id),
        attempt_id TEXT NOT NULL REFERENCES execution_attempts (attempt_id),
        intent_id TEXT NOT NULL,
        plan_hash TEXT NOT NULL,
        client_order_id TEXT NOT NULL,
        instrument TEXT NOT NULL,
        side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
        requested_quantity TEXT NOT NULL,
        exchange_order_id TEXT NOT NULL,
        exchange TEXT NOT NULL,
        environment TEXT NOT NULL CHECK (environment IN ('demo', 'testnet', 'mainnet')),
        account_id TEXT NOT NULL,
        category TEXT NOT NULL,
        position_mode TEXT NOT NULL CHECK (position_mode IN ('one-way', 'hedge')),
        bound_at TEXT NOT NULL,
        UNIQUE (lineage_id, attempt_id),
        UNIQUE (exchange, environment, account_id, category, position_mode, client_order_id),
        UNIQUE (exchange, environment, account_id, category, position_mode, exchange_order_id)
      );

      CREATE INDEX execution_identity_bindings_lineage_idx
        ON execution_identity_bindings (lineage_id, bound_at);
      CREATE INDEX execution_identity_bindings_scope_idx
        ON execution_identity_bindings (exchange, environment, account_id, category, position_mode, bound_at);
    `);
  },
} as const;
