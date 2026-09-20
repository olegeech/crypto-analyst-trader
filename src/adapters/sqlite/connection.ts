import { DatabaseSync } from "node:sqlite";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  mkdirSync,
  openSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { domainError, type DomainError } from "../../domain/shared/errors.js";
import { fail, ok, type Result } from "../../domain/shared/result.js";
import { applyMigrations } from "./migrations.js";
import { runInTransaction, sqliteError } from "./transaction.js";

export const MIN_NODE_VERSION = "22.22.3";
export const MIN_SQLITE_VERSION = "3.51.3";
export const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
export const MAX_BUSY_TIMEOUT_MS = 60_000;

const VALID_ENVIRONMENTS = ["demo", "testnet", "mainnet"] as const;

export interface SqliteRuntimeVersions {
  readonly nodeVersion: string;
  readonly sqliteVersion: string;
}

export interface SqliteConnectionOptions {
  readonly environment: string;
  readonly databasePath?: string;
  readonly rootDirectory?: string;
  readonly runtime?: SqliteRuntimeVersions;
  readonly busyTimeoutMs?: number;
}

export interface SqliteConnection {
  readonly db: DatabaseSync;
  readonly path: string;
  readonly environment: (typeof VALID_ENVIRONMENTS)[number];
  readonly runtime: SqliteRuntimeVersions;
  close(): void;
}

interface IdentityRow {
  readonly environment?: unknown;
}

interface PragmaRow {
  readonly [key: string]: unknown;
}

function isEnvironment(
  value: string,
): value is (typeof VALID_ENVIRONMENTS)[number] {
  return (VALID_ENVIRONMENTS as readonly string[]).includes(value);
}

function invalidEnvironment(): DomainError {
  return domainError(
    "PERSISTENCE_ENVIRONMENT",
    "persistence environment must be demo, testnet or mainnet",
  );
}

function parseVersion(
  value: string,
): readonly [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(value);
  if (match === null) return undefined;
  const [, major, minor, patch] = match;
  if (major === undefined || minor === undefined || patch === undefined) {
    return undefined;
  }
  return [Number(major), Number(minor), Number(patch)];
}

function versionAtLeast(actual: string, minimum: string): boolean {
  const parsedActual = parseVersion(actual);
  const parsedMinimum = parseVersion(minimum);
  if (parsedActual === undefined || parsedMinimum === undefined) return false;
  for (let index = 0; index < parsedMinimum.length; index += 1) {
    const actualPart = parsedActual[index] ?? 0;
    const minimumPart = parsedMinimum[index] ?? 0;
    if (actualPart !== minimumPart) return actualPart > minimumPart;
  }
  return true;
}

function processRuntimeVersions(): SqliteRuntimeVersions {
  const processVersions = process.versions as NodeJS.ProcessVersions & {
    sqlite?: string;
  };
  return {
    nodeVersion: processVersions.node,
    sqliteVersion: processVersions.sqlite ?? "",
  };
}

function validateRuntime(
  runtime: SqliteRuntimeVersions,
): Result<SqliteRuntimeVersions> {
  if (
    !versionAtLeast(runtime.nodeVersion, MIN_NODE_VERSION) ||
    !versionAtLeast(runtime.sqliteVersion, MIN_SQLITE_VERSION)
  ) {
    return fail(
      domainError(
        "PERSISTENCE_RUNTIME",
        "Node and bundled SQLite versions are below the persistence safety floor",
      ),
    );
  }
  return ok(runtime);
}

function validateBusyTimeout(value: number): Result<number> {
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_BUSY_TIMEOUT_MS
  ) {
    return fail(
      domainError(
        "INVALID_ARGUMENT",
        "busy timeout must be a positive bounded integer",
        { field: "busyTimeoutMs" },
      ),
    );
  }
  return ok(value);
}

function databasePath(
  options: SqliteConnectionOptions,
  environment: string,
): string {
  if (options.databasePath !== undefined) return resolve(options.databasePath);
  const rootDirectory =
    options.rootDirectory ?? join(process.cwd(), "data/private/execution");
  return resolve(join(rootDirectory, `${environment}.db`));
}

function ensurePrivateDirectory(
  directory: string,
  enforcePrivateMode: boolean,
): Result<void> {
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (enforcePrivateMode) chmodSync(directory, 0o700);
    const stats = statSync(directory);
    if (!stats.isDirectory() || (stats.mode & 0o777) !== 0o700) {
      return fail(
        domainError(
          "PERSISTENCE_INTEGRITY",
          "SQLite persistence directory is not a private directory",
        ),
      );
    }
    return ok(undefined);
  } catch (error) {
    return fail(sqliteError(error, "PERSISTENCE_ENVIRONMENT"));
  }
}

function ensurePrivateDatabaseFile(path: string): Result<void> {
  try {
    try {
      const descriptor = openSync(
        path,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR,
        0o600,
      );
      closeSync(descriptor);
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? (error as { code?: unknown }).code
          : undefined;
      if (code !== "EEXIST") throw error;
    }
    chmodSync(path, 0o600);
    const stats = statSync(path);
    if (!stats.isFile() || (stats.mode & 0o777) !== 0o600) {
      return fail(
        domainError(
          "PERSISTENCE_INTEGRITY",
          "SQLite persistence file is not a private regular file",
        ),
      );
    }
    return ok(undefined);
  } catch (error) {
    return fail(sqliteError(error, "PERSISTENCE_ENVIRONMENT"));
  }
}

function pragmaValue(
  database: DatabaseSync,
  sql: string,
  key: string,
): unknown {
  const row = database.prepare(sql).get() as PragmaRow | undefined;
  return row?.[key];
}

function verifyPragmas(
  database: DatabaseSync,
  busyTimeoutMs: number,
): Result<void> {
  if (pragmaValue(database, "PRAGMA foreign_keys", "foreign_keys") !== 1) {
    return fail(
      domainError(
        "PERSISTENCE_RUNTIME",
        "SQLite foreign-key enforcement is not active",
      ),
    );
  }
  const journalMode = pragmaValue(
    database,
    "PRAGMA journal_mode",
    "journal_mode",
  );
  if (typeof journalMode !== "string" || journalMode.toLowerCase() !== "wal") {
    return fail(
      domainError("PERSISTENCE_RUNTIME", "SQLite WAL mode is not active"),
    );
  }
  if (pragmaValue(database, "PRAGMA synchronous", "synchronous") !== 2) {
    return fail(
      domainError(
        "PERSISTENCE_RUNTIME",
        "SQLite full synchronous durability is not active",
      ),
    );
  }
  if (
    pragmaValue(database, "PRAGMA busy_timeout", "timeout") !== busyTimeoutMs
  ) {
    return fail(
      domainError(
        "PERSISTENCE_RUNTIME",
        "SQLite busy timeout is not configured as requested",
      ),
    );
  }
  return ok(undefined);
}

function configurePragmas(
  database: DatabaseSync,
  busyTimeoutMs: number,
): Result<void> {
  try {
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA synchronous = FULL");
    // SQLite does not accept a bound parameter for PRAGMA assignments. The
    // value is validated as a safe integer before this static interpolation.
    database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    return verifyPragmas(database, busyTimeoutMs);
  } catch (error) {
    return fail(sqliteError(error, "PERSISTENCE_RUNTIME"));
  }
}

function ensureEnvironmentIdentity(
  database: DatabaseSync,
  environment: (typeof VALID_ENVIRONMENTS)[number],
): Result<void> {
  const rows = database
    .prepare("SELECT environment FROM database_identity WHERE singleton = 1")
    .all() as IdentityRow[];
  if (rows.length > 1) {
    return fail(
      domainError(
        "PERSISTENCE_SCHEMA",
        "SQLite environment identity is not singleton",
      ),
    );
  }
  const [row] = rows;
  if (row === undefined) {
    database
      .prepare(
        "INSERT INTO database_identity (singleton, environment, created_at) VALUES (1, ?, ?)",
      )
      .run(environment, new Date().toISOString());
    return ok(undefined);
  }
  if (row.environment !== environment) return fail(invalidEnvironment());
  return ok(undefined);
}

function closeQuietly(database: DatabaseSync | undefined): void {
  if (database === undefined) return;
  try {
    database.close();
  } catch {
    // The connection is not returned to the caller after an open failure.
  }
}

export function openSqliteConnection(
  options: SqliteConnectionOptions,
): Result<SqliteConnection> {
  const environment = options.environment;
  if (!isEnvironment(environment)) return fail(invalidEnvironment());

  const runtime = options.runtime ?? processRuntimeVersions();
  const supportedRuntime = validateRuntime(runtime);
  if (!supportedRuntime.ok) return supportedRuntime;

  const busyTimeout = validateBusyTimeout(
    options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
  );
  if (!busyTimeout.ok) return busyTimeout;

  const path = databasePath(options, environment);
  const directoryReady = ensurePrivateDirectory(
    dirname(path),
    options.databasePath === undefined,
  );
  if (!directoryReady.ok) return directoryReady;
  const fileReady = ensurePrivateDatabaseFile(path);
  if (!fileReady.ok) return fileReady;

  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path, { allowExtension: false });
    const configured = configurePragmas(database, busyTimeout.value);
    if (!configured.ok) {
      closeQuietly(database);
      return configured;
    }

    const migrated = applyMigrations(database);
    if (!migrated.ok) {
      closeQuietly(database);
      return migrated;
    }

    const identity = runInTransaction(
      database,
      (transactionDatabase) =>
        ensureEnvironmentIdentity(transactionDatabase, environment),
      "PERSISTENCE_INTEGRITY",
    );
    if (!identity.ok) {
      closeQuietly(database);
      return identity;
    }

    const reverified = verifyPragmas(database, busyTimeout.value);
    if (!reverified.ok) {
      closeQuietly(database);
      return reverified;
    }

    let closed = false;
    return ok({
      db: database,
      path,
      environment,
      runtime,
      close(): void {
        if (closed) return;
        closed = true;
        database?.close();
      },
    });
  } catch (error) {
    closeQuietly(database);
    return fail(sqliteError(error, "PERSISTENCE_INTEGRITY"));
  }
}

export const openSqliteJournal = openSqliteConnection;
