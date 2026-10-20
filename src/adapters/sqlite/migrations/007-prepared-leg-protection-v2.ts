import type { DatabaseSync } from "node:sqlite";

/** Adds v2 protection facts beside the immutable prepared-leg v1 journal. */
export const preparedLegProtectionV2Migration = {
  version: 7,
  name: "prepared-leg-protection-v2",
  apply(database: DatabaseSync): void {
    database.exec(`
      CREATE TABLE prepared_leg_reconciliation_v2 (
        reconciliation_id TEXT PRIMARY KEY
          REFERENCES prepared_leg_reconciliations (reconciliation_id) ON DELETE RESTRICT,
        source_id TEXT NOT NULL
          REFERENCES prepared_leg_sources (source_id) ON DELETE RESTRICT,
        revision INTEGER NOT NULL CHECK (revision > 0),
        status TEXT NOT NULL CHECK (status IN (
          'PROTECTION_PENDING', 'PROTECTION_CONFIRMED', 'VERIFIED_CLOSED'
        )),
        canonical_json TEXT NOT NULL,
        canonical_hash TEXT NOT NULL,
        UNIQUE (source_id, revision)
      );

      CREATE INDEX prepared_leg_reconciliation_v2_source_idx
        ON prepared_leg_reconciliation_v2 (source_id, revision);
    `);
  },
} as const;
