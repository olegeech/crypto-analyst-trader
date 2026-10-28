import {
  canonicalSerialize,
  hashCanonical,
} from "../../domain/identity/canonical-serialization.js";
import {
  createHistorySourceFact,
  HISTORY_SOURCE_FACT_SCHEMA,
  type HistorySourceFact,
  type HistorySourceFactInput,
} from "../../domain/accounting/history-source-fact.js";
import {
  domainError,
  type DomainErrorCode,
} from "../../domain/shared/errors.js";
import { fail, ok, type Result } from "../../domain/shared/result.js";
import {
  parseUtcTimestamp,
  timestampFromEpochMs,
  type UtcTimestamp,
} from "../../domain/shared/time.js";
import {
  isRecord,
  requireHash,
  requireIdentifier,
} from "../../domain/shared/validation.js";
import {
  HISTORY_READ_LIMITS,
  HISTORY_READ_SOURCES,
  type HistoryReadSource,
} from "../../ports/history-read.js";
import type { SqliteConnection } from "./connection.js";
import {
  deterministicId,
  storedString,
  type SqliteRow,
} from "./sqlite-helpers.js";
import { runInTransaction, sqliteError } from "./transaction.js";
import type {
  HistoryCheckpoint,
  HistoryConflictSummary,
  HistoryCoverageKey,
  HistoryCoverageStatus,
  HistoryFilterValue,
  HistoryStoredObservation,
  HistoryStorePageRequest,
  HistoryStorePort,
  HistoryStoreScope,
  MarkHistoryCoverageRequest,
} from "../../ports/history-store.js";

const MAX_CURSOR_LENGTH = 4_096;
const ALLOWED_SOURCES = new Set<string>(HISTORY_READ_SOURCES);

interface ValidatedKey extends HistoryCoverageKey {
  readonly filtersJson: string;
  readonly filterHash: string;
}

interface ObservationInput {
  readonly observationId: string;
  readonly eventIdentity: string;
  readonly contentHash: string;
  readonly canonicalHash: string;
  readonly canonicalJson: string;
  readonly providerEventTime: UtcTimestamp;
  readonly providerRevisionTime: UtcTimestamp | null;
  readonly collectedAt: UtcTimestamp;
}

interface CheckpointRow extends SqliteRow {
  readonly exchange?: unknown;
  readonly environment?: unknown;
  readonly account_id?: unknown;
  readonly source?: unknown;
  readonly filter_hash?: unknown;
  readonly filters_json?: unknown;
  readonly window_from_ms?: unknown;
  readonly window_to_ms?: unknown;
  readonly cursor?: unknown;
  readonly status?: unknown;
  readonly row_count?: unknown;
  readonly inserted_count?: unknown;
  readonly duplicate_count?: unknown;
  readonly conflict_count?: unknown;
  readonly reason_code?: unknown;
  readonly updated_at?: unknown;
  readonly revision?: unknown;
}

interface ObservationRow extends SqliteRow {
  readonly observation_id?: unknown;
  readonly exchange?: unknown;
  readonly environment?: unknown;
  readonly account_id?: unknown;
  readonly source?: unknown;
  readonly event_identity?: unknown;
  readonly content_hash?: unknown;
  readonly canonical_hash?: unknown;
  readonly provider_event_time?: unknown;
  readonly provider_revision_time?: unknown;
  readonly collected_at?: unknown;
  readonly canonical_json?: unknown;
}

function inputError(
  message: string,
  code: DomainErrorCode = "INVALID_ARGUMENT",
) {
  return fail(domainError(code, message));
}

function validTimestamp(value: unknown): value is UtcTimestamp {
  return typeof value === "string" && parseUtcTimestamp(value).ok;
}

function sourceFactInput(
  value: Record<string, unknown>,
): Result<HistorySourceFact> {
  if (
    value.schemaVersion !== HISTORY_SOURCE_FACT_SCHEMA ||
    typeof value.contentHash !== "string"
  ) {
    return fail(
      domainError(
        "PERSISTENCE_INTEGRITY",
        "stored history fact envelope is invalid",
      ),
    );
  }
  const claimedHash = value.contentHash;
  const input: Record<string, unknown> = { ...value };
  delete input.schemaVersion;
  delete input.contentHash;
  delete input.groupingKey;
  const created = createHistorySourceFact(input as HistorySourceFactInput);
  if (!created.ok || created.value.contentHash !== claimedHash) {
    return fail(
      domainError(
        "PERSISTENCE_INTEGRITY",
        "stored history fact failed domain validation",
      ),
    );
  }
  const originalCanonical = canonicalSerialize(value);
  const normalizedCanonical = canonicalSerialize(created.value);
  if (
    !originalCanonical.ok ||
    !normalizedCanonical.ok ||
    originalCanonical.value !== normalizedCanonical.value
  ) {
    return fail(
      domainError(
        "PERSISTENCE_INTEGRITY",
        "stored history fact is not canonical",
      ),
    );
  }
  return created;
}

function parseStoredFact(
  value: unknown,
  expectedCanonicalHash: unknown,
): Result<HistorySourceFact> {
  if (typeof value !== "string" || typeof expectedCanonicalHash !== "string") {
    return fail(
      domainError("PERSISTENCE_INTEGRITY", "stored history fact is incomplete"),
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return fail(
      domainError(
        "PERSISTENCE_INTEGRITY",
        "stored history fact JSON is invalid",
      ),
    );
  }
  if (!isRecord(parsed)) {
    return fail(
      domainError(
        "PERSISTENCE_INTEGRITY",
        "stored history fact is not an object",
      ),
    );
  }
  const rehydrated = sourceFactInput(parsed);
  if (!rehydrated.ok) return rehydrated;
  const canonicalHash = hashCanonical(rehydrated.value);
  if (!canonicalHash.ok || canonicalHash.value !== expectedCanonicalHash) {
    return fail(
      domainError(
        "PERSISTENCE_INTEGRITY",
        "stored history fact hash does not match",
      ),
    );
  }
  return rehydrated;
}

function sourceOfFact(fact: HistorySourceFact): HistoryReadSource {
  return fact.source;
}

function eventIdentity(fact: HistorySourceFact): Result<string> {
  switch (fact.factKind) {
    case "order":
      return ok(`order:${fact.orderId}`);
    case "execution":
      return ok(`execution:${fact.execId}`);
    case "transaction":
      return ok(`transaction:${fact.transactionId}`);
    case "closed-pnl": {
      const groupingHash = hashCanonical(fact.groupingKey);
      return groupingHash.ok
        ? ok(`closed-pnl-group:${groupingHash.value}`)
        : groupingHash;
    }
  }
}

function observationInput(
  key: ValidatedKey,
  fact: HistorySourceFact,
): Result<ObservationInput> {
  const factSource = sourceOfFact(fact);
  if (factSource !== key.source) {
    return inputError("history fact source does not match page stream");
  }
  const factJson = canonicalSerialize(fact);
  const canonicalHash = hashCanonical(fact);
  const identity = eventIdentity(fact);
  if (!factJson.ok) return factJson;
  if (!canonicalHash.ok) return canonicalHash;
  if (!identity.ok) return identity;
  const observationId = deterministicId(
    "history-observation",
    `${key.scope.exchange}\u0000${key.scope.environment}\u0000${key.scope.accountId}\u0000${key.source}\u0000${identity.value}\u0000${fact.contentHash}`,
  );
  return ok({
    observationId,
    eventIdentity: identity.value,
    contentHash: fact.contentHash,
    canonicalHash: canonicalHash.value,
    canonicalJson: factJson.value,
    providerEventTime: fact.providerEventTime,
    providerRevisionTime: fact.providerRevisionTime,
    collectedAt: fact.collectedAt,
  });
}

function validateKey(
  connection: SqliteConnection,
  key: HistoryCoverageKey,
): Result<ValidatedKey> {
  const exchange = requireIdentifier(key.scope.exchange, "exchange");
  const accountId = requireHash(key.scope.accountId, "accountId");
  if (!exchange.ok) return exchange;
  if (!accountId.ok) return accountId;
  if (exchange.value !== "bybit") {
    return inputError(
      "history ingestion supports only the Bybit provider",
      "UNSUPPORTED_CONTRACT",
    );
  }
  if (key.scope.environment !== connection.environment) {
    return inputError(
      "history store environment does not match the open SQLite journal",
      "PERSISTENCE_ENVIRONMENT",
    );
  }
  if (!ALLOWED_SOURCES.has(key.source)) {
    return inputError("history source is unsupported");
  }
  if (
    !timestampFromEpochMs(key.window.fromMs).ok ||
    !timestampFromEpochMs(key.window.toMs).ok ||
    key.window.fromMs < 0 ||
    key.window.toMs <= key.window.fromMs ||
    key.window.toMs - key.window.fromMs > HISTORY_READ_LIMITS.maxWindowMs
  ) {
    return inputError(
      "history window must be a valid positive range of at most seven days",
    );
  }
  if (!isRecord(key.filters)) {
    return inputError("history filters must be a canonical object");
  }
  const filtersJson = canonicalSerialize(key.filters);
  const filterHash = hashCanonical(key.filters);
  if (!filtersJson.ok) return filtersJson;
  if (!filterHash.ok) return filterHash;
  return ok({
    scope: {
      exchange: exchange.value,
      environment: key.scope.environment,
      accountId: accountId.value,
    },
    source: key.source,
    filters: key.filters,
    window: { fromMs: key.window.fromMs, toMs: key.window.toMs },
    filtersJson: filtersJson.value,
    filterHash: filterHash.value,
  });
}

function validCursor(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" &&
      value.length > 0 &&
      value.length <= MAX_CURSOR_LENGTH &&
      !/[\u0000-\u001f\u007f]/u.test(value))
  );
}

function rowInteger(row: SqliteRow, field: string): number | undefined {
  const value = row[field];
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : undefined;
}

function checkpointFromRow(row: CheckpointRow): Result<HistoryCheckpoint> {
  const exchange = storedString(row, "exchange");
  const environment = storedString(row, "environment");
  const accountId = storedString(row, "account_id");
  const source = storedString(row, "source");
  const filterHash = storedString(row, "filter_hash");
  const filtersJson = storedString(row, "filters_json");
  const updatedAt = storedString(row, "updated_at");
  if (
    !exchange.ok ||
    !environment.ok ||
    !accountId.ok ||
    !source.ok ||
    !filterHash.ok ||
    !filtersJson.ok ||
    !updatedAt.ok
  ) {
    return fail(
      domainError(
        "PERSISTENCE_INTEGRITY",
        "stored history checkpoint is incomplete",
      ),
    );
  }
  let filters: unknown;
  try {
    filters = JSON.parse(filtersJson.value) as unknown;
  } catch {
    return fail(
      domainError(
        "PERSISTENCE_INTEGRITY",
        "stored history filters are invalid",
      ),
    );
  }
  const canonicalFilters = canonicalSerialize(filters);
  const actualFilterHash = hashCanonical(filters);
  if (
    !isRecord(filters) ||
    !canonicalFilters.ok ||
    canonicalFilters.value !== filtersJson.value ||
    !actualFilterHash.ok ||
    actualFilterHash.value !== filterHash.value
  ) {
    return fail(
      domainError(
        "PERSISTENCE_INTEGRITY",
        "stored history filter hash is invalid",
      ),
    );
  }
  const fromMs = rowInteger(row, "window_from_ms");
  const toMs = rowInteger(row, "window_to_ms");
  const rowCount = rowInteger(row, "row_count");
  const insertedCount = rowInteger(row, "inserted_count");
  const duplicateCount = rowInteger(row, "duplicate_count");
  const conflictCount = rowInteger(row, "conflict_count");
  const revision = rowInteger(row, "revision");
  const status = row.status;
  const cursor = row.cursor;
  const reasonCode = row.reason_code;
  if (
    fromMs === undefined ||
    toMs === undefined ||
    rowCount === undefined ||
    insertedCount === undefined ||
    duplicateCount === undefined ||
    conflictCount === undefined ||
    revision === undefined ||
    typeof status !== "string" ||
    !["paging", "partial", "traversed", "unavailable"].includes(status) ||
    (cursor !== null && typeof cursor !== "string") ||
    !validCursor(cursor) ||
    (reasonCode !== null && typeof reasonCode !== "string") ||
    !validTimestamp(updatedAt.value) ||
    !ALLOWED_SOURCES.has(source.value)
  ) {
    return fail(
      domainError(
        "PERSISTENCE_INTEGRITY",
        "stored history checkpoint fields are invalid",
      ),
    );
  }
  if (
    revision < 1 ||
    rowCount < 0 ||
    insertedCount < 0 ||
    duplicateCount < 0 ||
    conflictCount < 0 ||
    !["demo", "testnet", "mainnet"].includes(environment.value)
  ) {
    return fail(
      domainError(
        "PERSISTENCE_INTEGRITY",
        "stored history checkpoint counts or scope are invalid",
      ),
    );
  }
  return ok({
    scope: {
      exchange: exchange.value,
      environment: environment.value as HistoryStoreScope["environment"],
      accountId: accountId.value,
    },
    source: source.value as HistoryReadSource,
    filters: filters as Readonly<Record<string, HistoryFilterValue>>,
    window: { fromMs, toMs },
    filterHash: filterHash.value,
    cursor,
    status: status as HistoryCoverageStatus,
    rowCount,
    insertedCount,
    duplicateCount,
    conflictCount,
    reasonCode,
    updatedAt: updatedAt.value,
    revision,
  });
}

function checkpointWhere(): string {
  return `exchange = ? AND environment = ? AND account_id = ? AND source = ?
          AND filter_hash = ? AND window_from_ms = ? AND window_to_ms = ?`;
}

function checkpointValues(key: ValidatedKey): readonly (string | number)[] {
  return [
    key.scope.exchange,
    key.scope.environment,
    key.scope.accountId,
    key.source,
    key.filterHash,
    key.window.fromMs,
    key.window.toMs,
  ];
}

function readCheckpointWithinTransaction(
  database: SqliteConnection["db"],
  key: ValidatedKey,
): Result<HistoryCheckpoint | undefined> {
  const row = database
    .prepare(
      `SELECT * FROM history_window_checkpoints WHERE ${checkpointWhere()}`,
    )
    .get(...checkpointValues(key)) as CheckpointRow | undefined;
  if (row === undefined) return ok(undefined);
  const parsed = checkpointFromRow(row);
  if (!parsed.ok) return parsed;
  return ok(parsed.value);
}

function checkExpectedRevision(
  current: HistoryCheckpoint | undefined,
  expectedRevision: number,
): Result<void> {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    return inputError("expected history checkpoint revision is invalid");
  }
  if ((current?.revision ?? 0) !== expectedRevision) {
    return fail(
      domainError("CHECKPOINT_STALE", "history checkpoint revision changed"),
    );
  }
  return ok(undefined);
}

function observationConflictReason(
  fact: HistorySourceFact,
  existing: readonly ObservationRow[],
): HistoryConflictSummary["reason"] | undefined {
  if (fact.factKind === "closed-pnl") return undefined;
  if (fact.factKind === "order") {
    const sameRevision = existing.some(
      (row) => row.provider_revision_time === fact.providerRevisionTime,
    );
    return sameRevision ? "ORDER_REVISION_CONTENT_CHANGED" : undefined;
  }
  const isImmutable =
    fact.factKind === "execution" || fact.factKind === "transaction";
  if (!isImmutable) return undefined;
  return existing.length > 0 ? "IMMUTABLE_ID_CONTENT_CHANGED" : undefined;
}

function listConflictPairs(
  existing: readonly ObservationRow[],
  incomingHash: string,
  fact: HistorySourceFact,
): readonly { existingHash: string; incomingHash: string }[] {
  const output: { existingHash: string; incomingHash: string }[] = [];
  for (const row of existing) {
    if (row.content_hash === incomingHash) continue;
    if (
      fact.factKind === "order" &&
      row.provider_revision_time !== fact.providerRevisionTime
    )
      continue;
    if (fact.factKind === "closed-pnl") continue;
    if (
      fact.factKind === "execution" ||
      fact.factKind === "transaction" ||
      fact.factKind === "order"
    ) {
      output.push({
        existingHash: String(row.content_hash),
        incomingHash,
      });
    }
  }
  return output;
}

function conflictId(
  key: ValidatedKey,
  identity: string,
  existingHash: string,
  incomingHash: string,
  reason: HistoryConflictSummary["reason"],
): string {
  const hashes = [existingHash, incomingHash].sort();
  return deterministicId(
    "history-conflict",
    `${key.scope.exchange}\u0000${key.scope.environment}\u0000${key.scope.accountId}\u0000${key.source}\u0000${identity}\u0000${hashes.join("\u0000")}\u0000${reason}`,
  );
}

function insertConflict(
  database: SqliteConnection["db"],
  key: ValidatedKey,
  identity: string,
  pair: { readonly existingHash: string; readonly incomingHash: string },
  reason: HistoryConflictSummary["reason"],
  recordedAt: UtcTimestamp,
): Result<HistoryConflictSummary> {
  const id = conflictId(
    key,
    identity,
    pair.existingHash,
    pair.incomingHash,
    reason,
  );
  const sortedHashes = [pair.existingHash, pair.incomingHash].sort();
  const existingHash = sortedHashes[0];
  const incomingHash = sortedHashes[1];
  if (existingHash === undefined || incomingHash === undefined) {
    return fail(
      domainError(
        "PERSISTENCE_INTEGRITY",
        "history conflict hashes are missing",
      ),
    );
  }
  database
    .prepare(
      `INSERT OR IGNORE INTO history_source_conflicts
       (conflict_id, exchange, environment, account_id, source, event_identity,
        existing_hash, incoming_hash, reason, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      key.scope.exchange,
      key.scope.environment,
      key.scope.accountId,
      key.source,
      identity,
      existingHash,
      incomingHash,
      reason,
      recordedAt,
    );
  database
    .prepare(
      `INSERT OR IGNORE INTO history_window_conflicts
       (exchange, environment, account_id, source, filter_hash,
        window_from_ms, window_to_ms, conflict_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      key.scope.exchange,
      key.scope.environment,
      key.scope.accountId,
      key.source,
      key.filterHash,
      key.window.fromMs,
      key.window.toMs,
      id,
    );
  return ok({
    conflictId: id,
    source: key.source,
    eventIdentity: identity,
    existingHash,
    incomingHash,
    reason,
    recordedAt,
  });
}

function insertObservation(
  database: SqliteConnection["db"],
  key: ValidatedKey,
  fact: HistorySourceFact,
  input: ObservationInput,
  recordedAt: UtcTimestamp,
): Result<"inserted" | "duplicate"> {
  const matching = database
    .prepare(
      `SELECT observation_id FROM history_source_observations
       WHERE exchange = ? AND environment = ? AND account_id = ?
         AND source = ? AND event_identity = ? AND content_hash = ?`,
    )
    .get(
      key.scope.exchange,
      key.scope.environment,
      key.scope.accountId,
      key.source,
      input.eventIdentity,
      input.contentHash,
    ) as { observation_id?: unknown } | undefined;
  if (matching !== undefined) return ok("duplicate");

  database
    .prepare(
      `INSERT INTO history_source_observations
       (observation_id, exchange, environment, account_id, source, event_identity,
        content_hash, canonical_hash, provider_event_time, provider_revision_time,
        collected_at, canonical_json, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.observationId,
      key.scope.exchange,
      key.scope.environment,
      key.scope.accountId,
      key.source,
      input.eventIdentity,
      input.contentHash,
      input.canonicalHash,
      input.providerEventTime,
      input.providerRevisionTime,
      input.collectedAt,
      input.canonicalJson,
      recordedAt,
    );
  return ok("inserted");
}

function writeCheckpoint(
  database: SqliteConnection["db"],
  key: ValidatedKey,
  input: {
    readonly current: HistoryCheckpoint | undefined;
    readonly cursor: string | null;
    readonly status: HistoryCoverageStatus;
    readonly rowCount: number;
    readonly insertedCount: number;
    readonly duplicateCount: number;
    readonly conflictCount: number;
    readonly reasonCode: string | null;
    readonly updatedAt: UtcTimestamp;
  },
): Result<HistoryCheckpoint> {
  const revision = (input.current?.revision ?? 0) + 1;
  try {
    database
      .prepare(
        `INSERT INTO history_window_checkpoints
         (exchange, environment, account_id, source, filter_hash, filters_json,
          window_from_ms, window_to_ms, cursor, status, row_count, inserted_count,
          duplicate_count, conflict_count, reason_code, updated_at, revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (exchange, environment, account_id, source, filter_hash,
                      window_from_ms, window_to_ms)
         DO UPDATE SET cursor = excluded.cursor, status = excluded.status,
           row_count = excluded.row_count, inserted_count = excluded.inserted_count,
           duplicate_count = excluded.duplicate_count, conflict_count = excluded.conflict_count,
           reason_code = excluded.reason_code, updated_at = excluded.updated_at,
           revision = excluded.revision`,
      )
      .run(
        key.scope.exchange,
        key.scope.environment,
        key.scope.accountId,
        key.source,
        key.filterHash,
        key.filtersJson,
        key.window.fromMs,
        key.window.toMs,
        input.cursor,
        input.status,
        input.rowCount,
        input.insertedCount,
        input.duplicateCount,
        input.conflictCount,
        input.reasonCode,
        input.updatedAt,
        revision,
      );
    const row = database
      .prepare(
        `SELECT * FROM history_window_checkpoints WHERE ${checkpointWhere()}`,
      )
      .get(...checkpointValues(key)) as CheckpointRow | undefined;
    if (row === undefined) {
      return fail(
        domainError(
          "PERSISTENCE_INTEGRITY",
          "history checkpoint write was not visible",
        ),
      );
    }
    return checkpointFromRow(row);
  } catch (error) {
    return fail(sqliteError(error, "PERSISTENCE_INTEGRITY"));
  }
}

function countWindowConflicts(
  database: SqliteConnection["db"],
  key: ValidatedKey,
): number {
  const row = database
    .prepare(
      `SELECT COUNT(*) AS count FROM history_window_conflicts
       WHERE exchange = ? AND environment = ? AND account_id = ? AND source = ?
         AND filter_hash = ? AND window_from_ms = ? AND window_to_ms = ?`,
    )
    .get(...checkpointValues(key)) as { count?: unknown } | undefined;
  return typeof row?.count === "number" && Number.isSafeInteger(row.count)
    ? row.count
    : 0;
}

function parseConflict(row: SqliteRow): Result<HistoryConflictSummary> {
  const conflictId = storedString(row, "conflict_id");
  const source = storedString(row, "source");
  const eventIdentity = storedString(row, "event_identity");
  const existingHash = storedString(row, "existing_hash");
  const incomingHash = storedString(row, "incoming_hash");
  const reason = storedString(row, "reason");
  const recordedAt = storedString(row, "recorded_at");
  if (
    !conflictId.ok ||
    !source.ok ||
    !eventIdentity.ok ||
    !existingHash.ok ||
    !incomingHash.ok ||
    !reason.ok ||
    !recordedAt.ok ||
    !ALLOWED_SOURCES.has(source.value) ||
    (reason.value !== "IMMUTABLE_ID_CONTENT_CHANGED" &&
      reason.value !== "ORDER_REVISION_CONTENT_CHANGED") ||
    !validTimestamp(recordedAt.value)
  ) {
    return fail(
      domainError(
        "PERSISTENCE_INTEGRITY",
        "stored history conflict is invalid",
      ),
    );
  }
  return ok({
    conflictId: conflictId.value,
    source: source.value as HistoryReadSource,
    eventIdentity: eventIdentity.value,
    existingHash: existingHash.value,
    incomingHash: incomingHash.value,
    reason: reason.value,
    recordedAt: recordedAt.value,
  });
}

class SqliteHistoryStore implements HistoryStorePort {
  public constructor(private readonly connection: SqliteConnection) {}

  public readCheckpoint(
    key: HistoryCoverageKey,
  ): Result<HistoryCheckpoint | undefined> {
    const validated = validateKey(this.connection, key);
    if (!validated.ok) return validated;
    try {
      return readCheckpointWithinTransaction(
        this.connection.db,
        validated.value,
      );
    } catch (error) {
      return fail(sqliteError(error, "PERSISTENCE_INTEGRITY"));
    }
  }

  public commitPage(request: HistoryStorePageRequest): Result<{
    readonly checkpoint: HistoryCheckpoint;
    readonly inserted: number;
    readonly duplicates: number;
    readonly conflicts: readonly HistoryConflictSummary[];
  }> {
    const key = validateKey(this.connection, request);
    if (!key.ok) return key;
    if (
      !Number.isSafeInteger(request.expectedRevision) ||
      request.expectedRevision < 0 ||
      !validCursor(request.cursor) ||
      !validCursor(request.nextCursor) ||
      (request.cursor !== null && request.cursor === request.nextCursor) ||
      !Array.isArray(request.facts) ||
      request.facts.length > 10_000
    ) {
      return inputError(
        "history page cursor, revision or row count is invalid",
      );
    }
    const prepared: { fact: HistorySourceFact; input: ObservationInput }[] = [];
    for (const fact of request.facts) {
      const serialized = canonicalSerialize(fact);
      if (!serialized.ok) return serialized;
      const rehydrated = sourceFactInput(
        fact as unknown as Record<string, unknown>,
      );
      if (!rehydrated.ok) return rehydrated;
      if (rehydrated.value.contentHash !== fact.contentHash) {
        return inputError("history page fact content hash is invalid");
      }
      const input = observationInput(key.value, rehydrated.value);
      if (!input.ok) return input;
      prepared.push({ fact: rehydrated.value, input: input.value });
    }
    const parsedNow = parseUtcTimestamp(this.connection.clock.now());
    if (!parsedNow.ok)
      return inputError("history page collection time is invalid");

    return runInTransaction(
      this.connection.db,
      (database) => {
        const currentResult = readCheckpointWithinTransaction(
          database,
          key.value,
        );
        if (!currentResult.ok) return currentResult;
        const current = currentResult.value;
        const expected = checkExpectedRevision(
          current,
          request.expectedRevision,
        );
        if (!expected.ok) return expected;
        if (current === undefined && request.cursor !== null) {
          return fail(
            domainError(
              "CHECKPOINT_STALE",
              "history window must start with its first page",
            ),
          );
        }
        if (
          current !== undefined &&
          request.cursor !== current.cursor &&
          request.cursor !== null
        ) {
          return fail(
            domainError(
              "CHECKPOINT_STALE",
              "history page cursor does not match the saved window progress",
            ),
          );
        }

        let inserted = 0;
        let duplicates = 0;
        const conflictsById = new Map<string, HistoryConflictSummary>();
        for (const entry of prepared) {
          const write = insertObservation(
            database,
            key.value,
            entry.fact,
            entry.input,
            parsedNow.value,
          );
          if (!write.ok) return write;
          if (write.value === "inserted") inserted += 1;
          else duplicates += 1;

          if (entry.fact.factKind === "closed-pnl") continue;
          const rows = database
            .prepare(
              `SELECT content_hash, provider_revision_time
               FROM history_source_observations
               WHERE exchange = ? AND environment = ? AND account_id = ?
                 AND source = ? AND event_identity = ?`,
            )
            .all(
              key.value.scope.exchange,
              key.value.scope.environment,
              key.value.scope.accountId,
              key.value.source,
              entry.input.eventIdentity,
            ) as ObservationRow[];
          const reason = observationConflictReason(entry.fact, rows);
          if (reason !== undefined) {
            const pairs = listConflictPairs(
              rows,
              entry.input.contentHash,
              entry.fact,
            );
            for (const pair of pairs) {
              const conflict = insertConflict(
                database,
                key.value,
                entry.input.eventIdentity,
                pair,
                reason,
                parsedNow.value,
              );
              if (!conflict.ok) return conflict;
              conflictsById.set(conflict.value.conflictId, conflict.value);
            }
          }
        }

        const rowCount = (current?.rowCount ?? 0) + request.facts.length;
        const insertedCount = (current?.insertedCount ?? 0) + inserted;
        const duplicateCount = (current?.duplicateCount ?? 0) + duplicates;
        const conflicts = [...conflictsById.values()];
        const conflictCount = countWindowConflicts(database, key.value);
        const status: HistoryCoverageStatus =
          request.nextCursor === null ? "traversed" : "paging";
        const reasonCode =
          conflicts.length > 0
            ? "SOURCE_CONFLICT"
            : current?.status === "unavailable"
              ? null
              : (current?.reasonCode ?? null);
        if (
          current !== undefined &&
          request.cursor === current.cursor &&
          request.nextCursor === current.cursor &&
          status === current.status &&
          inserted === 0 &&
          conflictCount === current.conflictCount &&
          reasonCode === current.reasonCode
        ) {
          return ok({
            checkpoint: current,
            inserted,
            duplicates,
            conflicts,
          });
        }
        const checkpoint = writeCheckpoint(database, key.value, {
          current,
          cursor: request.nextCursor,
          status,
          rowCount,
          insertedCount,
          duplicateCount,
          conflictCount,
          reasonCode,
          updatedAt: parsedNow.value,
        });
        if (!checkpoint.ok) return checkpoint;
        return ok({
          checkpoint: checkpoint.value,
          inserted,
          duplicates,
          conflicts,
        });
      },
      "PERSISTENCE_INTEGRITY",
    );
  }

  public markCoverage(
    request: MarkHistoryCoverageRequest,
  ): Result<HistoryCheckpoint> {
    const key = validateKey(this.connection, request);
    if (!key.ok) return key;
    if (
      !Number.isSafeInteger(request.expectedRevision) ||
      request.expectedRevision < 0 ||
      !/^[A-Z0-9_]{1,64}$/u.test(request.reasonCode) ||
      (request.cursor !== undefined && !validCursor(request.cursor))
    ) {
      return inputError("history coverage status input is invalid");
    }
    const updatedAt = parseUtcTimestamp(this.connection.clock.now());
    if (!updatedAt.ok) return updatedAt;
    return runInTransaction(
      this.connection.db,
      (database) => {
        const currentResult = readCheckpointWithinTransaction(
          database,
          key.value,
        );
        if (!currentResult.ok) return currentResult;
        const current = currentResult.value;
        const expected = checkExpectedRevision(
          current,
          request.expectedRevision,
        );
        if (!expected.ok) return expected;
        return writeCheckpoint(database, key.value, {
          current,
          cursor:
            request.cursor === undefined
              ? (current?.cursor ?? null)
              : request.cursor,
          status: request.status,
          rowCount: current?.rowCount ?? 0,
          insertedCount: current?.insertedCount ?? 0,
          duplicateCount: current?.duplicateCount ?? 0,
          conflictCount: current?.conflictCount ?? 0,
          reasonCode: request.reasonCode,
          updatedAt: updatedAt.value,
        });
      },
      "PERSISTENCE_INTEGRITY",
    );
  }

  public readFacts(
    scope: HistoryStoreScope,
    source?: HistoryReadSource,
  ): Result<readonly HistoryStoredObservation[]> {
    const validated = validateStandaloneScope(this.connection, scope, source);
    if (!validated.ok) return validated;
    try {
      const sourceFilter = source === undefined ? "" : " AND source = ?";
      const params =
        source === undefined
          ? [scope.exchange, scope.environment, scope.accountId]
          : [scope.exchange, scope.environment, scope.accountId, source];
      const rows = this.connection.db
        .prepare(
          `SELECT observation_id, exchange, environment, account_id, source,
                  event_identity, content_hash, canonical_hash, provider_event_time,
                  provider_revision_time, collected_at, canonical_json
           FROM history_source_observations
           WHERE exchange = ? AND environment = ? AND account_id = ?${sourceFilter}
           ORDER BY source, provider_event_time, event_identity, provider_revision_time`,
        )
        .all(...params) as ObservationRow[];
      const output: HistoryStoredObservation[] = [];
      for (const row of rows) {
        const fact = parseStoredFact(row.canonical_json, row.canonical_hash);
        if (!fact.ok) return fact;
        const observationId = storedString(row, "observation_id");
        const eventIdentityValue = storedString(row, "event_identity");
        const contentHash = storedString(row, "content_hash");
        const canonicalHash = storedString(row, "canonical_hash");
        const providerEventTime = storedString(row, "provider_event_time");
        const collectedAt = storedString(row, "collected_at");
        if (
          !observationId.ok ||
          !eventIdentityValue.ok ||
          !contentHash.ok ||
          !canonicalHash.ok ||
          contentHash.value !== fact.value.contentHash ||
          row.source !== fact.value.source ||
          !providerEventTime.ok ||
          !collectedAt.ok ||
          !validTimestamp(providerEventTime.value) ||
          !validTimestamp(collectedAt.value) ||
          (row.provider_revision_time !== null &&
            !validTimestamp(row.provider_revision_time))
        ) {
          return fail(
            domainError(
              "PERSISTENCE_INTEGRITY",
              "stored history observation fields are invalid",
            ),
          );
        }
        output.push({
          observationId: observationId.value,
          scope,
          source: fact.value.source,
          eventIdentity: eventIdentityValue.value,
          contentHash: contentHash.value,
          canonicalHash: canonicalHash.value,
          providerEventTime: providerEventTime.value,
          providerRevisionTime:
            row.provider_revision_time as UtcTimestamp | null,
          collectedAt: collectedAt.value,
          fact: fact.value,
        });
      }
      return ok(output);
    } catch (error) {
      return fail(sqliteError(error, "PERSISTENCE_INTEGRITY"));
    }
  }

  public readConflicts(
    scope: HistoryStoreScope,
    source?: HistoryReadSource,
  ): Result<readonly HistoryConflictSummary[]> {
    const validation = validateStandaloneScope(this.connection, scope, source);
    if (!validation.ok) return validation;
    try {
      const sourceFilter = source === undefined ? "" : " AND source = ?";
      const params =
        source === undefined
          ? [scope.exchange, scope.environment, scope.accountId]
          : [scope.exchange, scope.environment, scope.accountId, source];
      const rows = this.connection.db
        .prepare(
          `SELECT conflict_id, source, event_identity, existing_hash, incoming_hash,
                  reason, recorded_at
           FROM history_source_conflicts
           WHERE exchange = ? AND environment = ? AND account_id = ?${sourceFilter}
           ORDER BY source, recorded_at, event_identity`,
        )
        .all(...params) as SqliteRow[];
      const windowRows = this.connection.db
        .prepare(
          `SELECT conflict_id, filter_hash, window_from_ms, window_to_ms
           FROM history_window_conflicts
           WHERE exchange = ? AND environment = ? AND account_id = ?${sourceFilter}
           ORDER BY conflict_id, filter_hash, window_from_ms, window_to_ms`,
        )
        .all(...params) as SqliteRow[];
      const windowsByConflict = new Map<
        string,
        { filterHash: string; window: { fromMs: number; toMs: number } }[]
      >();
      for (const windowRow of windowRows) {
        const conflictId = storedString(windowRow, "conflict_id");
        const filterHash = storedString(windowRow, "filter_hash");
        const fromMs = rowInteger(windowRow, "window_from_ms");
        const toMs = rowInteger(windowRow, "window_to_ms");
        if (
          !conflictId.ok ||
          !filterHash.ok ||
          fromMs === undefined ||
          toMs === undefined ||
          fromMs < 0 ||
          toMs <= fromMs
        )
          return fail(
            domainError(
              "PERSISTENCE_INTEGRITY",
              "stored history conflict window is invalid",
            ),
          );
        const windows = windowsByConflict.get(conflictId.value) ?? [];
        windows.push({
          filterHash: filterHash.value,
          window: { fromMs, toMs },
        });
        windowsByConflict.set(conflictId.value, windows);
      }
      const output: HistoryConflictSummary[] = [];
      for (const row of rows) {
        const conflict = parseConflict(row);
        if (!conflict.ok) return conflict;
        output.push({
          ...conflict.value,
          windows: Object.freeze(
            windowsByConflict.get(conflict.value.conflictId) ?? [],
          ),
        });
      }
      return ok(output);
    } catch (error) {
      return fail(sqliteError(error, "PERSISTENCE_INTEGRITY"));
    }
  }

  public listCoverage(
    scope: HistoryStoreScope,
    source?: HistoryReadSource,
  ): Result<readonly HistoryCheckpoint[]> {
    const validation = validateStandaloneScope(this.connection, scope, source);
    if (!validation.ok) return validation;
    try {
      const sourceFilter = source === undefined ? "" : " AND source = ?";
      const params =
        source === undefined
          ? [scope.exchange, scope.environment, scope.accountId]
          : [scope.exchange, scope.environment, scope.accountId, source];
      const rows = this.connection.db
        .prepare(
          `SELECT * FROM history_window_checkpoints
           WHERE exchange = ? AND environment = ? AND account_id = ?${sourceFilter}
           ORDER BY source, window_from_ms, filter_hash`,
        )
        .all(...params) as CheckpointRow[];
      const output: HistoryCheckpoint[] = [];
      for (const row of rows) {
        const checkpoint = checkpointFromRow(row);
        if (!checkpoint.ok) return checkpoint;
        output.push(checkpoint.value);
      }
      return ok(output);
    } catch (error) {
      return fail(sqliteError(error, "PERSISTENCE_INTEGRITY"));
    }
  }
}

function validateStandaloneScope(
  connection: SqliteConnection,
  scope: HistoryStoreScope,
  source?: HistoryReadSource,
): Result<void> {
  const exchange = requireIdentifier(scope.exchange, "exchange");
  const accountId = requireHash(scope.accountId, "accountId");
  if (!exchange.ok) return exchange;
  if (!accountId.ok) return accountId;
  if (exchange.value !== "bybit") {
    return inputError(
      "history ingestion supports only the Bybit provider",
      "UNSUPPORTED_CONTRACT",
    );
  }
  if (scope.environment !== connection.environment) {
    return inputError(
      "history store environment does not match the open SQLite journal",
      "PERSISTENCE_ENVIRONMENT",
    );
  }
  if (source !== undefined && !ALLOWED_SOURCES.has(source)) {
    return inputError("history source is unsupported");
  }
  return ok(undefined);
}

export function createSqliteHistoryStore(
  connection: SqliteConnection,
): HistoryStorePort {
  return new SqliteHistoryStore(connection);
}
