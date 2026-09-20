import { createHash } from "node:crypto";

import { domainError } from "../../domain/shared/errors.js";
import { fail, ok, type Result } from "../../domain/shared/result.js";
import {
  parseUtcTimestamp,
  type UtcTimestamp,
} from "../../domain/shared/time.js";
import {
  requireHash,
  requireIdentifier,
} from "../../domain/shared/validation.js";
import type {
  PersistenceEnvironment,
  PersistenceScope,
} from "../../ports/persistence.js";

export const SCOPE_WHERE =
  "exchange = ? AND environment = ? AND account_id = ? AND category = ? AND position_mode = ?";

export type SqliteRow = Record<string, unknown>;

export function persistenceFailure(message: string): Result<never> {
  return fail(domainError("PERSISTENCE_INTEGRITY", message));
}

export function isEnvironment(value: unknown): value is PersistenceEnvironment {
  return value === "demo" || value === "testnet" || value === "mainnet";
}

export function scopeValues(scope: PersistenceScope): readonly string[] {
  return [
    scope.exchange,
    scope.environment,
    scope.accountId,
    scope.category,
    scope.positionMode,
  ];
}

export function scopesEqual(
  left: PersistenceScope,
  right: PersistenceScope,
): boolean {
  return (
    left.exchange === right.exchange &&
    left.environment === right.environment &&
    left.accountId === right.accountId &&
    left.category === right.category &&
    left.positionMode === right.positionMode
  );
}

export function deterministicId(prefix: string, value: string): string {
  const digest = createHash("sha256").update(value, "utf8").digest("hex");
  return `${prefix}-${digest.slice(0, 40)}`;
}

export function storedString(row: SqliteRow, field: string): Result<string> {
  const value = row[field];
  return typeof value === "string"
    ? ok(value)
    : persistenceFailure(`persisted SQLite field ${field} is invalid`);
}

export function storedIdentifier(
  row: SqliteRow,
  field: string,
): Result<string> {
  const value = storedString(row, field);
  if (!value.ok) return value;
  const parsed = requireIdentifier(value.value, field);
  return parsed.ok
    ? parsed
    : persistenceFailure(`persisted SQLite identifier ${field} is invalid`);
}

export function storedHash(row: SqliteRow, field: string): Result<string> {
  const value = storedString(row, field);
  if (!value.ok) return value;
  const parsed = requireHash(value.value, field);
  return parsed.ok
    ? parsed
    : persistenceFailure(`persisted SQLite hash ${field} is invalid`);
}

export function storedTimestamp(
  row: SqliteRow,
  field: string,
): Result<UtcTimestamp> {
  const value = storedString(row, field);
  if (!value.ok) return value;
  const parsed = parseUtcTimestamp(value.value);
  return parsed.ok
    ? parsed
    : persistenceFailure(`persisted SQLite timestamp ${field} is invalid`);
}

export function storedOptionalString(
  row: SqliteRow,
  field: string,
): Result<string | undefined> {
  const value = row[field];
  if (value === null || value === undefined) return ok(undefined);
  return typeof value === "string"
    ? ok(value)
    : persistenceFailure(`persisted SQLite optional field ${field} is invalid`);
}

export function storedBoolean(row: SqliteRow, field: string): Result<boolean> {
  const value = row[field];
  if (value !== 0 && value !== 1) {
    return persistenceFailure(`persisted SQLite boolean ${field} is invalid`);
  }
  return ok(value === 1);
}
