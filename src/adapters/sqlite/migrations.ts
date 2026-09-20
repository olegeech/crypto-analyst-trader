import type { DatabaseSync } from "node:sqlite";

import { domainError } from "../../domain/shared/errors.js";
import { fail, ok, type Result } from "../../domain/shared/result.js";
import { runInTransaction, sqliteError } from "./transaction.js";
import { bootstrapMigration } from "./migrations/001-bootstrap.js";
import { executionOperationalMigration } from "./migrations/002-execution-operational.js";
import { accountingCheckpointsMigration } from "./migrations/003-accounting-checkpoints.js";

export interface SqliteMigration {
  readonly version: number;
  readonly name: string;
  readonly apply: (database: DatabaseSync) => void;
}

export const MIGRATIONS: readonly SqliteMigration[] = [
  bootstrapMigration,
  executionOperationalMigration,
  accountingCheckpointsMigration,
];

export const CURRENT_SCHEMA_VERSION = MIGRATIONS.at(-1)?.version ?? 0;

interface SchemaVersionRow {
  readonly singleton?: unknown;
  readonly schema_version?: unknown;
}

function tableExists(database: DatabaseSync, tableName: string): boolean {
  const row = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { name?: unknown } | undefined;
  return row?.name === tableName;
}

function currentSchemaVersion(database: DatabaseSync): Result<number> {
  if (!tableExists(database, "schema_meta")) return ok(0);
  const rows = database
    .prepare("SELECT singleton, schema_version FROM schema_meta")
    .all() as SchemaVersionRow[];
  if (rows.length !== 1) {
    return fail(
      domainError(
        "PERSISTENCE_SCHEMA",
        "SQLite schema marker is missing or not singleton",
      ),
    );
  }
  const [row] = rows;
  if (
    row === undefined ||
    row.singleton !== 1 ||
    typeof row.schema_version !== "number" ||
    !Number.isSafeInteger(row.schema_version) ||
    row.schema_version < 0
  ) {
    return fail(
      domainError("PERSISTENCE_SCHEMA", "SQLite schema marker is invalid"),
    );
  }
  return ok(row.schema_version);
}

function validateMigrations(
  migrations: readonly SqliteMigration[],
): Result<void> {
  for (const [index, migration] of migrations.entries()) {
    if (
      migration.version !== index + 1 ||
      !Number.isSafeInteger(migration.version) ||
      migration.version < 1 ||
      migration.name.length === 0 ||
      typeof migration.apply !== "function"
    ) {
      return fail(
        domainError(
          "PERSISTENCE_SCHEMA",
          "SQLite migration sequence is invalid",
        ),
      );
    }
  }
  return ok(undefined);
}

function recordSchemaVersion(
  database: DatabaseSync,
  version: number,
): Result<void> {
  const updatedAt = new Date().toISOString();
  try {
    database
      .prepare(
        `INSERT INTO schema_meta (singleton, schema_version, updated_at)
         VALUES (1, ?, ?)
         ON CONFLICT (singleton) DO UPDATE SET
           schema_version = excluded.schema_version,
           updated_at = excluded.updated_at`,
      )
      .run(version, updatedAt);
    return ok(undefined);
  } catch (error) {
    return fail(sqliteError(error, "PERSISTENCE_SCHEMA"));
  }
}

export function applyMigrations(
  database: DatabaseSync,
  migrations: readonly SqliteMigration[] = MIGRATIONS,
): Result<void> {
  const validMigrations = validateMigrations(migrations);
  if (!validMigrations.ok) return validMigrations;
  const current = (() => {
    try {
      return currentSchemaVersion(database);
    } catch (error) {
      return fail(sqliteError(error, "PERSISTENCE_SCHEMA"));
    }
  })();
  if (!current.ok) return current;
  const highestSupportedVersion = migrations.at(-1)?.version ?? 0;
  if (current.value > highestSupportedVersion) {
    return fail(
      domainError(
        "PERSISTENCE_SCHEMA",
        "SQLite schema is newer than this adapter supports",
      ),
    );
  }
  const pending = migrations.filter(
    (migration) => migration.version > current.value,
  );
  if (pending.length === 0) return ok(undefined);

  return runInTransaction(
    database,
    (transactionDatabase) => {
      for (const migration of pending) {
        migration.apply(transactionDatabase);
        const recorded = recordSchemaVersion(
          transactionDatabase,
          migration.version,
        );
        if (!recorded.ok) return recorded;
      }
      return ok(undefined);
    },
    "PERSISTENCE_SCHEMA",
  );
}
