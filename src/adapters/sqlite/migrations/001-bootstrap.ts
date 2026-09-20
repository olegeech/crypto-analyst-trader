import type { DatabaseSync } from "node:sqlite";

export const bootstrapMigration = {
  version: 1,
  name: "bootstrap",
  apply(database: DatabaseSync): void {
    database.exec(`
      CREATE TABLE schema_meta (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        schema_version INTEGER NOT NULL CHECK (schema_version >= 0),
        updated_at TEXT NOT NULL
      );

      CREATE TABLE database_identity (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        environment TEXT NOT NULL CHECK (environment IN ('demo', 'testnet', 'mainnet')),
        created_at TEXT NOT NULL
      );
    `);
  },
} as const;
