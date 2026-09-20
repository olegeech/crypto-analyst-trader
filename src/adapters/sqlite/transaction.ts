import type { DatabaseSync } from "node:sqlite";

import {
  domainError,
  domainErrorCodes,
  type DomainError,
  type DomainErrorCode,
} from "../../domain/shared/errors.js";
import { fail, ok, type Result } from "../../domain/shared/result.js";

function isDomainError(value: unknown): value is DomainError {
  if (value instanceof Error || typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { code?: unknown; message?: unknown };
  return (
    typeof candidate.code === "string" &&
    Object.values(domainErrorCodes).includes(
      candidate.code as DomainErrorCode,
    ) &&
    typeof candidate.message === "string"
  );
}

function isBusyError(value: unknown): boolean {
  const message = value instanceof Error ? value.message : String(value);
  return /\b(?:busy|locked)\b/iu.test(message);
}

export function sqliteError(
  value: unknown,
  fallbackCode: DomainErrorCode,
): DomainError {
  if (isDomainError(value)) return value;
  if (isBusyError(value)) {
    return domainError(
      "PERSISTENCE_BUSY",
      "SQLite could not obtain the required lock within the configured bound",
    );
  }
  return domainError(fallbackCode, "SQLite persistence operation failed");
}

export type SqliteTransactionOperation<T> = (
  database: DatabaseSync,
) => Result<T>;

/**
 * Own the complete SQLite transaction boundary for a short local operation.
 * Callers return typed results; they never receive a transaction callback from
 * the persistence port and migration modules never start nested transactions.
 */
export function runInTransaction<T>(
  database: DatabaseSync,
  operation: SqliteTransactionOperation<T>,
  fallbackCode: DomainErrorCode = "PERSISTENCE_INTEGRITY",
): Result<T> {
  let began = false;
  try {
    database.exec("BEGIN IMMEDIATE");
    began = true;
    const result = operation(database);
    if (!result.ok) {
      database.exec("ROLLBACK");
      began = false;
      return result;
    }
    database.exec("COMMIT");
    began = false;
    return ok(result.value);
  } catch (error) {
    if (began) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the original safe classification; rollback errors contain
        // no additional recovery signal for callers.
      }
    }
    return fail(sqliteError(error, fallbackCode));
  }
}
