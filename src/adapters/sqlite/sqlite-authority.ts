import type { DatabaseSync } from "node:sqlite";

import { domainError } from "../../domain/shared/errors.js";
import { fail, ok, type Result } from "../../domain/shared/result.js";
import type { UtcTimestamp } from "../../domain/shared/time.js";
import {
  requireFiniteInteger,
  requireIdentifier,
  requireSafeText,
} from "../../domain/shared/validation.js";
import type {
  HaltState,
  LeaseAuthority,
  LeaseState,
  PersistenceScope,
} from "../../ports/persistence.js";
import {
  deterministicId,
  persistenceFailure,
  SCOPE_WHERE,
  scopeValues,
  storedBoolean,
  storedIdentifier,
  storedOptionalString,
  storedTimestamp,
  type SqliteRow,
} from "./sqlite-helpers.js";

export interface LeaseRow {
  readonly ownerRunId: string;
  readonly epoch: number;
  readonly acquiredAt: UtcTimestamp;
  readonly expiresAt: UtcTimestamp;
  readonly reconciliationRequired: boolean;
}

export function leaseRow(
  database: DatabaseSync,
  scope: PersistenceScope,
): Result<LeaseRow | undefined> {
  const row = database
    .prepare(
      `SELECT owner_run_id, epoch, acquired_at, expires_at, reconciliation_required
       FROM leases WHERE ${SCOPE_WHERE}`,
    )
    .get(...scopeValues(scope)) as SqliteRow | undefined;
  if (row === undefined) return ok(undefined);
  const ownerRunId = storedIdentifier(row, "owner_run_id");
  const acquiredAt = storedTimestamp(row, "acquired_at");
  const expiresAt = storedTimestamp(row, "expires_at");
  const reconciliationRequired = storedBoolean(row, "reconciliation_required");
  if (
    !ownerRunId.ok ||
    typeof row.epoch !== "number" ||
    !Number.isSafeInteger(row.epoch) ||
    row.epoch < 1 ||
    !acquiredAt.ok ||
    !expiresAt.ok ||
    !reconciliationRequired.ok
  ) {
    return persistenceFailure("persisted SQLite lease is invalid");
  }
  return ok({
    ownerRunId: ownerRunId.value,
    epoch: row.epoch,
    acquiredAt: acquiredAt.value,
    expiresAt: expiresAt.value,
    reconciliationRequired: reconciliationRequired.value,
  });
}

export function leaseState(scope: PersistenceScope, row: LeaseRow): LeaseState {
  return { scope, ...row };
}

export function haltRow(
  database: DatabaseSync,
  scope: PersistenceScope,
): Result<HaltState> {
  const row = database
    .prepare(
      `SELECT active, revision, reason, raised_at, reconciliation_required
       FROM halt_state WHERE ${SCOPE_WHERE}`,
    )
    .get(...scopeValues(scope)) as SqliteRow | undefined;
  if (row === undefined) {
    return ok({
      scope,
      active: false,
      revision: 0,
      reconciliationRequired: false,
    });
  }
  const active = storedBoolean(row, "active");
  const reconciliationRequired = storedBoolean(row, "reconciliation_required");
  const reason = storedOptionalString(row, "reason");
  const raisedAtValue = row.raised_at;
  const raisedAt =
    raisedAtValue === null || raisedAtValue === undefined
      ? ok<UtcTimestamp | undefined>(undefined)
      : storedTimestamp(row, "raised_at");
  if (
    !active.ok ||
    !reconciliationRequired.ok ||
    !reason.ok ||
    !raisedAt.ok ||
    typeof row.revision !== "number" ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 0
  ) {
    return persistenceFailure("persisted SQLite HALT state is invalid");
  }
  return ok({
    scope,
    active: active.value,
    revision: row.revision,
    ...(reason.value === undefined ? {} : { reason: reason.value }),
    ...(raisedAt.value === undefined ? {} : { raisedAt: raisedAt.value }),
    reconciliationRequired: reconciliationRequired.value,
  });
}

export function validateAuthority(
  authority: LeaseAuthority,
): Result<LeaseAuthority> {
  const ownerRunId = requireIdentifier(authority.ownerRunId, "ownerRunId");
  const epoch = requireFiniteInteger(authority.epoch, "epoch", 1);
  if (!ownerRunId.ok || !epoch.ok) {
    return fail(domainError("RUN_LEASE_LOST", "lease authority is invalid"));
  }
  return ok({ ownerRunId: ownerRunId.value, epoch: epoch.value });
}

export function assertCurrentAuthorityWithinTransaction(
  database: DatabaseSync,
  scope: PersistenceScope,
  authority: LeaseAuthority,
  now: UtcTimestamp,
): Result<LeaseRow> {
  const parsedAuthority = validateAuthority(authority);
  if (!parsedAuthority.ok) return parsedAuthority;
  const current = leaseRow(database, scope);
  if (!current.ok) return current;
  if (
    current.value === undefined ||
    current.value.ownerRunId !== parsedAuthority.value.ownerRunId ||
    current.value.epoch !== parsedAuthority.value.epoch ||
    Date.parse(now) >= Date.parse(current.value.expiresAt)
  ) {
    return fail(
      domainError(
        "RUN_LEASE_LOST",
        "current run lease is no longer authoritative",
      ),
    );
  }
  return ok(current.value);
}

export function raiseHaltWithinTransaction(
  database: DatabaseSync,
  scope: PersistenceScope,
  reason: string,
  recordedAt: UtcTimestamp,
  evidenceJson?: string,
): Result<HaltState> {
  const safeReason = requireSafeText(reason, "reason");
  if (!safeReason.ok) return safeReason;
  const current = haltRow(database, scope);
  if (!current.ok) return current;
  const revision = current.value.revision + 1;
  if (!Number.isSafeInteger(revision)) {
    return persistenceFailure("HALT revision exceeded the safe integer range");
  }
  const eventId = deterministicId(
    "halt",
    `${scopeValues(scope).join("\u0000")}:${revision}:${safeReason.value}`,
  );
  database
    .prepare(
      `INSERT INTO halt_state
       (exchange, environment, account_id, category, position_mode, active, revision, reason, raised_at, reconciliation_required)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, 1)
       ON CONFLICT (exchange, environment, account_id, category, position_mode)
       DO UPDATE SET active = 1, revision = excluded.revision, reason = excluded.reason,
         raised_at = excluded.raised_at, reconciliation_required = 1`,
    )
    .run(...scopeValues(scope), revision, safeReason.value, recordedAt);
  database
    .prepare(
      `INSERT INTO halt_events
       (event_id, exchange, environment, account_id, category, position_mode, revision, active, reason, recorded_at, evidence_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    )
    .run(
      eventId,
      ...scopeValues(scope),
      revision,
      safeReason.value,
      recordedAt,
      evidenceJson ?? null,
    );
  return haltRow(database, scope);
}
