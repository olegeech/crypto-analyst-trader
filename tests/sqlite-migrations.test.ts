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
  type SqliteRuntimeVersions,
} from "../src/adapters/sqlite/connection.js";

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
    version: 4,
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
