import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  applyMigrations,
  CURRENT_SCHEMA_VERSION,
  MIGRATIONS,
  type SqliteMigration,
} from "../src/adapters/sqlite/migrations.js";
import {
  openSqliteConnection,
  type SqliteConnection,
  type SqliteRuntimeVersions,
} from "../src/adapters/sqlite/connection.js";
import { createSqliteExecutionStore } from "../src/adapters/sqlite/execution-store.js";
import { createSqlitePreparedLegStore } from "../src/adapters/sqlite/prepared-leg-store.js";
import { createPreparedLegExecution } from "../src/domain/execution/prepared-leg-execution.js";
import { encodeCanonicalArtifact } from "../src/domain/identity/canonical-artifact.js";
import { registerTrustedClock } from "../src/adapters/sqlite/sqlite-helpers.js";
import { parseUtcTimestamp } from "../src/domain/shared/time.js";
import { preparedLegExecutionFixture } from "./fixtures/prepared-leg-execution-fixtures.js";
import { requireDailyFixture } from "./fixtures/daily-planning-evidence-fixtures.js";

const supportedRuntime: SqliteRuntimeVersions = {
  nodeVersion: "22.22.3",
  sqliteVersion: "3.51.3",
};

function temporaryDatabase(): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), "sqlite-migrations-"));
  return { root, path: join(root, "execution.db") };
}

function openDatabase(path: string): DatabaseSync {
  return new DatabaseSync(path, { allowExtension: false });
}

test("fresh and reopened journals configure verified SQLite durability state", () => {
  const { root, path } = temporaryDatabase();
  const first = openSqliteConnection({
    environment: "demo",
    databasePath: path,
    runtime: supportedRuntime,
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(
    first.value.db.prepare("PRAGMA journal_mode").get()?.journal_mode,
    "wal",
  );
  assert.equal(
    first.value.db.prepare("PRAGMA foreign_keys").get()?.foreign_keys,
    1,
  );
  assert.equal(
    first.value.db.prepare("PRAGMA synchronous").get()?.synchronous,
    2,
  );
  assert.equal(
    first.value.db.prepare("PRAGMA busy_timeout").get()?.timeout,
    5000,
  );
  assert.equal(
    first.value.db
      .prepare("SELECT schema_version FROM schema_meta WHERE singleton = 1")
      .get()?.schema_version,
    CURRENT_SCHEMA_VERSION,
  );
  first.value.close();

  const second = openSqliteConnection({
    environment: "demo",
    databasePath: path,
    runtime: supportedRuntime,
  });
  assert.equal(second.ok, true);
  if (second.ok) second.value.close();
  assert.equal(statSync(root).isDirectory(), true);
});

test("operator Mainnet journal uses v9 lease-free schema with empty tables", () => {
  assert.equal(CURRENT_SCHEMA_VERSION, 9);
  const { path } = temporaryDatabase();
  const opened = openSqliteConnection({
    environment: "mainnet",
    databasePath: path,
    runtime: supportedRuntime,
  });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const { db } = opened.value;
  for (const table of [
    "operator_mainnet_test_sources",
    "operator_mainnet_test_write_intents",
    "operator_mainnet_test_attempts",
    "operator_mainnet_test_reconciliations",
    "operator_mainnet_test_manual_actions",
  ]) {
    assert.equal(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .get(table)?.name,
      table,
    );
  }
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM prepared_leg_sources").get()
      ?.count,
    0,
  );
  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS count FROM operator_mainnet_test_sources")
      .get()?.count,
    0,
  );
  const intentColumns = db
    .prepare("PRAGMA table_info(operator_mainnet_test_write_intents)")
    .all()
    .map((column) => column.name);
  assert.equal(intentColumns.includes("lease_owner_run_id"), false);
  assert.equal(intentColumns.includes("lease_epoch"), false);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  opened.value.close();
});

test("v8 migration preserves populated v7 daily artifacts and prepared-leg source bytes", () => {
  const { path } = temporaryDatabase();
  const database = openDatabase(path);
  database.exec("PRAGMA foreign_keys = ON");
  assert.equal(applyMigrations(database, MIGRATIONS.slice(0, 7)).ok, true);
  database
    .prepare(
      "INSERT INTO database_identity (singleton, environment, created_at) VALUES (1, 'mainnet', ?)",
    )
    .run("2026-10-22T12:00:00.000Z");

  const fixture = preparedLegExecutionFixture();
  const now = requireDailyFixture(parseUtcTimestamp(fixture.now));
  const execution = requireDailyFixture(
    createPreparedLegExecution({
      approval: fixture.approval,
      approvalHash: fixture.approval.contentHash,
      legId: fixture.legId,
      now: fixture.now,
    }),
  );
  const clock = { now: () => now };
  registerTrustedClock(database, clock);
  const connection: SqliteConnection = {
    db: database,
    path,
    environment: "mainnet",
    runtime: supportedRuntime,
    clock,
    close: () => database.close(),
  };
  const scope = {
    exchange: "bybit",
    environment: "mainnet" as const,
    accountId: execution.accountIdentityHash,
    category: "linear",
    positionMode: "one-way" as const,
  };
  const artifacts = requireDailyFixture(
    createSqliteExecutionStore(connection, scope),
  );
  requireDailyFixture(
    artifacts.writeArtifact({
      artifactId: `prepared:${fixture.prepared.contentHash}`,
      artifactKind: "prepared-daily-plan",
      envelope: requireDailyFixture(
        encodeCanonicalArtifact("prepared-daily-plan", fixture.prepared),
      ),
      materialHash: fixture.prepared.contentHash,
    }),
  );
  requireDailyFixture(
    artifacts.writeArtifact({
      artifactId: `prepared-consent:${fixture.approval.contentHash}`,
      artifactKind: "prepared-plan-approval",
      envelope: requireDailyFixture(
        encodeCanonicalArtifact("prepared-plan-approval", fixture.approval),
      ),
      materialHash: fixture.approval.contentHash,
    }),
  );
  const preparedLegs = requireDailyFixture(
    createSqlitePreparedLegStore(connection, scope),
  );
  const lease = requireDailyFixture(
    artifacts.acquireLease({
      scope,
      ownerRunId: "migration-v7-fixture",
      now,
      ttlMs: 60_000,
    }),
  );
  requireDailyFixture(
    preparedLegs.preparePreparedLegCreate({
      authority: { ownerRunId: lease.ownerRunId, epoch: lease.epoch },
      runId: lease.ownerRunId,
      execution,
      preparedAt: now,
    }),
  );

  const preservedArtifactBytes = database
    .prepare(
      `SELECT artifact_id, artifact_kind, schema_version, canonical_json,
              canonical_hash, material_hash, exchange, environment, account_id,
              category, position_mode
       FROM artifacts ORDER BY artifact_id`,
    )
    .all();
  const preservedPreparedSourceBytes = database
    .prepare(
      `SELECT source_id, exchange, environment, account_id, category,
              position_mode, prepared_hash, prepared_artifact_id, leg_id,
              client_order_id, selection_json, selection_hash, created_at
       FROM prepared_leg_sources ORDER BY source_id`,
    )
    .all();
  assert.ok(preservedPreparedSourceBytes.length > 0);
  database.close();

  const migrated = openSqliteConnection({
    environment: "mainnet",
    databasePath: path,
    runtime: supportedRuntime,
  });
  assert.equal(migrated.ok, true);
  if (!migrated.ok) return;
  assert.deepEqual(
    migrated.value.db
      .prepare(
        `SELECT artifact_id, artifact_kind, schema_version, canonical_json,
                canonical_hash, material_hash, exchange, environment, account_id,
                category, position_mode
         FROM artifacts ORDER BY artifact_id`,
      )
      .all(),
    preservedArtifactBytes,
  );
  assert.deepEqual(
    migrated.value.db
      .prepare(
        `SELECT source_id, exchange, environment, account_id, category,
                position_mode, prepared_hash, prepared_artifact_id, leg_id,
                client_order_id, selection_json, selection_hash, created_at
         FROM prepared_leg_sources ORDER BY source_id`,
      )
      .all(),
    preservedPreparedSourceBytes,
  );
  assert.equal(
    migrated.value.db
      .prepare("SELECT COUNT(*) AS count FROM operator_mainnet_test_sources")
      .get()?.count,
    0,
  );
  assert.deepEqual(
    migrated.value.db.prepare("PRAGMA foreign_key_check").all(),
    [],
  );
  migrated.value.close();
});

test("identity-binding migration is additive and starts without fabricated bindings", () => {
  const { path } = temporaryDatabase();
  const db = openDatabase(path);
  assert.equal(applyMigrations(db, MIGRATIONS.slice(0, 4)).ok, true);
  db.close();

  const opened = openSqliteConnection({
    environment: "demo",
    databasePath: path,
    runtime: supportedRuntime,
  });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  assert.equal(
    opened.value.db
      .prepare("SELECT COUNT(*) AS count FROM execution_identity_bindings")
      .get()?.count,
    0,
  );
  assert.equal(
    opened.value.db
      .prepare("SELECT schema_version FROM schema_meta WHERE singleton = 1")
      .get()?.schema_version,
    CURRENT_SCHEMA_VERSION,
  );
  opened.value.close();
});

test("prepared-leg v006 migrates a populated v005 journal without changing legacy rows", () => {
  const { path } = temporaryDatabase();
  const db = openDatabase(path);
  assert.equal(applyMigrations(db, MIGRATIONS.slice(0, 5)).ok, true);
  db.prepare(
    `INSERT INTO halt_state
     (exchange, environment, account_id, category, position_mode, active, revision,
      reason, raised_at, reconciliation_required)
     VALUES ('bybit', 'mainnet', ?, 'linear', 'one-way', 0, 0, NULL, NULL, 0)`,
  ).run(`sha256:${"a".repeat(64)}`);
  db.close();

  const migrated = openSqliteConnection({
    environment: "mainnet",
    databasePath: path,
    runtime: supportedRuntime,
  });
  assert.equal(migrated.ok, true);
  if (!migrated.ok) return;
  const { db: migratedDb } = migrated.value;
  assert.equal(
    migratedDb
      .prepare("SELECT schema_version FROM schema_meta WHERE singleton = 1")
      .get()?.schema_version,
    CURRENT_SCHEMA_VERSION,
  );
  assert.equal(
    migratedDb
      .prepare("SELECT COUNT(*) AS count FROM prepared_leg_sources")
      .get()?.count,
    0,
  );
  assert.equal(
    migratedDb
      .prepare("SELECT reason FROM halt_state WHERE environment = 'mainnet'")
      .get()?.reason,
    null,
  );
  assert.deepEqual(migratedDb.prepare("PRAGMA foreign_key_check").all(), []);
  migrated.value.close();
});

test("supported older schema migrates forward without losing committed rows", () => {
  const { path } = temporaryDatabase();
  const db = openDatabase(path);
  assert.equal(applyMigrations(db, MIGRATIONS.slice(0, 1)).ok, true);
  db.exec("CREATE TABLE preserved_rows (value TEXT NOT NULL)");
  db.prepare("INSERT INTO preserved_rows (value) VALUES (?)").run("kept");
  db.close();

  const opened = openSqliteConnection({
    environment: "testnet",
    databasePath: path,
    runtime: supportedRuntime,
  });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  assert.equal(
    opened.value.db.prepare("SELECT value FROM preserved_rows").get()?.value,
    "kept",
  );
  opened.value.close();
});

test("non-empty unmarked databases fail before migration or identity adoption", () => {
  const { path } = temporaryDatabase();
  const db = openDatabase(path);
  db.exec("CREATE TABLE unmarked_state (value TEXT NOT NULL)");
  db.prepare("INSERT INTO unmarked_state (value) VALUES (?)").run("keep");
  db.close();

  const opened = openSqliteConnection({
    environment: "demo",
    databasePath: path,
    runtime: supportedRuntime,
  });
  assert.equal(opened.ok, false);
  if (!opened.ok) assert.equal(opened.error.code, "PERSISTENCE_SCHEMA");

  const unchanged = openDatabase(path);
  assert.equal(
    unchanged
      .prepare("SELECT name FROM sqlite_master WHERE name = ?")
      .get("schema_meta"),
    undefined,
  );
  assert.equal(
    unchanged.prepare("SELECT value FROM unmarked_state").get()?.value,
    "keep",
  );
  unchanged.close();
});

test("environment mismatch is rejected before pending migrations mutate the database", () => {
  const { path } = temporaryDatabase();
  const db = openDatabase(path);
  assert.equal(applyMigrations(db, MIGRATIONS.slice(0, 1)).ok, true);
  db.prepare(
    "INSERT INTO database_identity (singleton, environment, created_at) VALUES (1, ?, ?)",
  ).run("demo", "2026-09-19T10:00:00.000Z");
  db.close();

  const opened = openSqliteConnection({
    environment: "testnet",
    databasePath: path,
    runtime: supportedRuntime,
  });
  assert.equal(opened.ok, false);
  if (!opened.ok) assert.equal(opened.error.code, "PERSISTENCE_ENVIRONMENT");

  const unchanged = openDatabase(path);
  assert.equal(
    unchanged.prepare("SELECT schema_version FROM schema_meta").get()
      ?.schema_version,
    1,
  );
  assert.equal(
    unchanged
      .prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get("execution_lineages")?.count,
    0,
  );
  unchanged.close();
});

test("newer schema markers fail closed before execution authority", () => {
  const { path } = temporaryDatabase();
  const db = openDatabase(path);
  db.exec(
    "CREATE TABLE schema_meta (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), schema_version INTEGER NOT NULL)",
  );
  db.prepare(
    "INSERT INTO schema_meta (singleton, schema_version) VALUES (1, ?)",
  ).run(CURRENT_SCHEMA_VERSION + 1);
  db.close();

  const opened = openSqliteConnection({
    environment: "mainnet",
    databasePath: path,
    runtime: supportedRuntime,
  });
  assert.equal(opened.ok, false);
  if (!opened.ok) assert.equal(opened.error.code, "PERSISTENCE_SCHEMA");
});

test("failed pending migration rolls back its DDL and schema marker", () => {
  const { path } = temporaryDatabase();
  const db = openDatabase(path);
  assert.equal(applyMigrations(db, MIGRATIONS.slice(0, 1)).ok, true);
  db.exec("CREATE TABLE preserved_rows (value TEXT NOT NULL)");
  db.prepare("INSERT INTO preserved_rows (value) VALUES (?)").run("kept");
  const failingMigration: SqliteMigration = {
    version: 5,
    name: "synthetic failure",
    apply(database) {
      database.exec("CREATE TABLE should_rollback (value TEXT NOT NULL)");
      throw new Error("synthetic migration failure");
    },
  };
  const result = applyMigrations(db, [...MIGRATIONS, failingMigration]);
  assert.equal(result.ok, false);
  assert.equal(
    db
      .prepare("SELECT schema_version FROM schema_meta WHERE singleton = 1")
      .get()?.schema_version,
    1,
  );
  assert.equal(
    db.prepare("SELECT value FROM preserved_rows").get()?.value,
    "kept",
  );
  assert.throws(() => db.prepare("SELECT * FROM should_rollback").all());
  db.close();
});

test("environment identity prevents a database from being reopened under another environment", () => {
  const { path } = temporaryDatabase();
  const first = openSqliteConnection({
    environment: "demo",
    databasePath: path,
    runtime: supportedRuntime,
  });
  assert.equal(first.ok, true);
  if (first.ok) first.value.close();

  const wrongEnvironment = openSqliteConnection({
    environment: "testnet",
    databasePath: path,
    runtime: supportedRuntime,
  });
  assert.equal(wrongEnvironment.ok, false);
  if (!wrongEnvironment.ok) {
    assert.equal(wrongEnvironment.error.code, "PERSISTENCE_ENVIRONMENT");
  }
});

test("invalid environment and below-floor runtime fail before opening a journal", () => {
  const { path } = temporaryDatabase();
  const invalidEnvironment = openSqliteConnection({
    environment: "sandbox",
    databasePath: path,
    runtime: supportedRuntime,
  });
  assert.equal(invalidEnvironment.ok, false);
  if (!invalidEnvironment.ok) {
    assert.equal(invalidEnvironment.error.code, "PERSISTENCE_ENVIRONMENT");
  }

  const unsupportedRuntime = openSqliteConnection({
    environment: "demo",
    databasePath: path,
    runtime: { nodeVersion: "22.22.2", sqliteVersion: "3.51.2" },
  });
  assert.equal(unsupportedRuntime.ok, false);
  if (!unsupportedRuntime.ok) {
    assert.equal(unsupportedRuntime.error.code, "PERSISTENCE_RUNTIME");
  }
});

test("migration contention is bounded and typed", () => {
  const { path } = temporaryDatabase();
  const seed = openDatabase(path);
  assert.equal(applyMigrations(seed, MIGRATIONS.slice(0, 1)).ok, true);
  seed.exec("BEGIN IMMEDIATE");
  const result = openSqliteConnection({
    environment: "demo",
    databasePath: path,
    runtime: supportedRuntime,
    busyTimeoutMs: 10,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "PERSISTENCE_BUSY");
  seed.exec("ROLLBACK");
  seed.close();
});

test("default filesystem permissions are private and extensions remain disabled", () => {
  const root = mkdtempSync(join(tmpdir(), "sqlite-permissions-"));
  chmodSync(root, 0o700);
  const path = join(root, "nested", "execution.db");
  writeFileSync(join(root, "placeholder"), "safe\n", { mode: 0o600 });
  const opened = openSqliteConnection({
    environment: "demo",
    databasePath: path,
    runtime: supportedRuntime,
  });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const databaseMode = statSync(path).mode & 0o777;
  const directoryMode = statSync(join(root, "nested")).mode & 0o777;
  assert.equal(databaseMode, 0o600);
  assert.equal(directoryMode, 0o700);
  assert.throws(() => opened.value.db.enableLoadExtension(true));
  assert.throws(() =>
    opened.value.db.loadExtension("/tmp/not-a-real-extension"),
  );
  opened.value.close();
});

test("default root paths enforce private directory and database modes", () => {
  const root = mkdtempSync(join(tmpdir(), "sqlite-default-permissions-"));
  const privateRoot = join(root, "execution-root");
  const opened = openSqliteConnection({
    environment: "demo",
    rootDirectory: privateRoot,
    runtime: supportedRuntime,
  });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  assert.equal(statSync(privateRoot).mode & 0o777, 0o700);
  assert.equal(statSync(join(privateRoot, "demo.db")).mode & 0o777, 0o600);
  opened.value.close();
});
