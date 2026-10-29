import {
  canonicalSerialize,
  hashCanonical,
} from "../../domain/identity/canonical-serialization.js";
import { domainError } from "../../domain/shared/errors.js";
import { fail, ok, type Result } from "../../domain/shared/result.js";
import { parseUtcTimestamp } from "../../domain/shared/time.js";
import {
  requireHash,
  requireIdentifier,
} from "../../domain/shared/validation.js";
import type {
  HistoryAccountingReportStorePort,
  HistoryAccountingReportRecord,
} from "../../ports/history-accounting-report-store.js";
import type { HistoryStoreScope } from "../../ports/history-store.js";
import type { SqliteConnection } from "./connection.js";
import { runInTransaction, sqliteError } from "./transaction.js";
import { storedHash, storedString, type SqliteRow } from "./sqlite-helpers.js";

const MAX_REPORT_JSON_CHARS = 32 * 1024 * 1024;
type PlainRecord = Record<string, unknown>;

function plainRecord(value: unknown): value is PlainRecord {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every((d) =>
      Object.hasOwn(d, "value"),
    )
  );
}

function invalid(): Result<never> {
  return fail(
    domainError("INVALID_EVIDENCE", "history accounting report is invalid"),
  );
}

function integrityFailure(): Result<never> {
  return fail(
    domainError(
      "PERSISTENCE_INTEGRITY",
      "stored history accounting report failed verification",
    ),
  );
}

function validateScope(
  value: unknown,
  environment: string,
): Result<HistoryStoreScope> {
  if (!plainRecord(value) || Reflect.ownKeys(value).length !== 3)
    return invalid();
  const exchange = requireIdentifier(value.exchange, "exchange");
  const accountId = requireHash(value.accountId, "accountId");
  if (!exchange.ok || !accountId.ok) return invalid();
  if (
    exchange.value !== "bybit" ||
    value.environment !== environment ||
    !["demo", "testnet", "mainnet"].includes(String(value.environment))
  )
    return fail(
      domainError(
        "PERSISTENCE_ENVIRONMENT",
        "report scope does not match the open SQLite journal",
      ),
    );
  return ok({
    exchange: exchange.value,
    environment: value.environment as HistoryStoreScope["environment"],
    accountId: accountId.value,
  });
}

function validateAnchorReferences(
  record: Pick<
    HistoryAccountingReportRecord,
    "scope" | "openingAnchorId" | "closingAnchorId"
  >,
  connection: SqliteConnection,
): Result<void> {
  const rows = connection.db
    .prepare(
      `SELECT anchor_id, exchange, environment, account_id, kind
     FROM history_accounting_wallet_anchors WHERE anchor_id IN (?, ?)`,
    )
    .all(record.openingAnchorId, record.closingAnchorId) as {
    readonly anchor_id?: unknown;
    readonly exchange?: unknown;
    readonly environment?: unknown;
    readonly account_id?: unknown;
    readonly kind?: unknown;
  }[];
  if (
    record.openingAnchorId === record.closingAnchorId ||
    rows.length !== 2 ||
    rows.some(
      (row) =>
        row.exchange !== record.scope.exchange ||
        row.environment !== record.scope.environment ||
        row.account_id !== record.scope.accountId ||
        (row.anchor_id === record.openingAnchorId && row.kind !== "opening") ||
        (row.anchor_id === record.closingAnchorId && row.kind !== "closing"),
    )
  )
    return invalid();
  return ok(undefined);
}

function validateRecord(
  value: unknown,
  connection: SqliteConnection,
): Result<HistoryAccountingReportRecord> {
  if (
    !plainRecord(value) ||
    Reflect.ownKeys(value).length !== 9 ||
    Object.keys(value).some(
      (key) =>
        ![
          "reportId",
          "scope",
          "evaluatedAt",
          "openingAnchorId",
          "closingAnchorId",
          "status",
          "dependencyHash",
          "contentHash",
          "canonicalJson",
        ].includes(key),
    )
  )
    return invalid();
  const reportId = requireIdentifier(value.reportId, "reportId");
  const scope = validateScope(value.scope, connection.environment);
  const evaluatedAt = parseUtcTimestamp(value.evaluatedAt);
  const openingAnchorId = requireIdentifier(
    value.openingAnchorId,
    "openingAnchorId",
  );
  const closingAnchorId = requireIdentifier(
    value.closingAnchorId,
    "closingAnchorId",
  );
  const dependencyHash = requireHash(value.dependencyHash, "dependencyHash");
  const contentHash = requireHash(value.contentHash, "contentHash");
  if (
    !reportId.ok ||
    !scope.ok ||
    !evaluatedAt.ok ||
    !openingAnchorId.ok ||
    !closingAnchorId.ok ||
    !dependencyHash.ok ||
    !contentHash.ok ||
    (value.status !== "ACCOUNTING_READY" && value.status !== "NOT_READY") ||
    typeof value.canonicalJson !== "string" ||
    value.canonicalJson.length === 0 ||
    value.canonicalJson.length > MAX_REPORT_JSON_CHARS
  )
    return invalid();
  let decoded: unknown;
  try {
    decoded = JSON.parse(value.canonicalJson) as unknown;
  } catch {
    return invalid();
  }
  if (!plainRecord(decoded) || decoded.contentHash !== contentHash.value)
    return invalid();
  const canonicalJson = canonicalSerialize(decoded);
  if (!canonicalJson.ok || canonicalJson.value !== value.canonicalJson)
    return invalid();
  const { contentHash: _contentHash, ...payload } = decoded;
  void _contentHash;
  const calculatedHash = hashCanonical(payload);
  if (!calculatedHash.ok || calculatedHash.value !== contentHash.value)
    return invalid();
  const calculatedReportId = hashCanonical({
    schemaVersion: decoded.schemaVersion,
    scope: decoded.scope,
    dependencyHash: decoded.dependencyHash,
  });
  const reportScope = validateScope(decoded.scope, connection.environment);
  if (!reportScope.ok) return invalid();
  const expectedScopeHash = hashCanonical(scope.value);
  const actualScopeHash = hashCanonical(reportScope.value);
  if (
    decoded.schemaVersion !== "history-accounting-reconciliation-report/v1" ||
    !calculatedReportId.ok ||
    !expectedScopeHash.ok ||
    !actualScopeHash.ok ||
    reportId.value !==
      `history-accounting-report:${calculatedReportId.value.slice(7)}` ||
    decoded.reportId !== reportId.value ||
    decoded.status !== value.status ||
    decoded.dependencyHash !== dependencyHash.value ||
    decoded.evaluatedAt !== evaluatedAt.value ||
    actualScopeHash.value !== expectedScopeHash.value ||
    (decoded.epoch as { epoch?: unknown } | null)?.epoch === null ||
    typeof (decoded.epoch as { epoch?: unknown } | null)?.epoch !== "object"
  )
    return invalid();
  const epochProjection = decoded.epoch as Record<string, unknown>;
  const epoch = epochProjection.epoch as Record<string, unknown>;
  if (
    epoch.openingAnchorId !== openingAnchorId.value ||
    epoch.closingAnchorId !== closingAnchorId.value ||
    decoded.status !==
      (epochProjection.readiness === "ACCOUNTING_READY"
        ? "ACCOUNTING_READY"
        : "NOT_READY") ||
    (epochProjection.status !== "RECONCILED" &&
      epochProjection.status !== "NOT_READY")
  )
    return invalid();
  const normalized = {
    reportId: reportId.value,
    scope: scope.value,
    evaluatedAt: evaluatedAt.value,
    openingAnchorId: openingAnchorId.value,
    closingAnchorId: closingAnchorId.value,
    status: value.status,
    dependencyHash: dependencyHash.value,
    contentHash: contentHash.value,
    canonicalJson: value.canonicalJson,
  } satisfies HistoryAccountingReportRecord;
  const references = validateAnchorReferences(normalized, connection);
  if (!references.ok) return references;
  return ok(normalized);
}

interface ReportRow extends SqliteRow {
  readonly report_id?: unknown;
  readonly exchange?: unknown;
  readonly environment?: unknown;
  readonly account_id?: unknown;
  readonly evaluated_at?: unknown;
  readonly opening_anchor_id?: unknown;
  readonly closing_anchor_id?: unknown;
  readonly status?: unknown;
  readonly dependency_hash?: unknown;
  readonly content_hash?: unknown;
  readonly canonical_json?: unknown;
}

function parseRow(
  row: ReportRow,
  connection: SqliteConnection,
): Result<HistoryAccountingReportRecord> {
  const reportId = storedString(row, "report_id");
  const exchange = storedString(row, "exchange");
  const environment = storedString(row, "environment");
  const accountId = storedString(row, "account_id");
  const evaluatedAt = storedString(row, "evaluated_at");
  const openingAnchorId = storedString(row, "opening_anchor_id");
  const closingAnchorId = storedString(row, "closing_anchor_id");
  const status = storedString(row, "status");
  const dependencyHash = storedHash(row, "dependency_hash");
  const contentHash = storedHash(row, "content_hash");
  const canonicalJson = storedString(row, "canonical_json");
  if (
    !reportId.ok ||
    !exchange.ok ||
    !environment.ok ||
    !accountId.ok ||
    !evaluatedAt.ok ||
    !openingAnchorId.ok ||
    !closingAnchorId.ok ||
    !status.ok ||
    !dependencyHash.ok ||
    !contentHash.ok ||
    !canonicalJson.ok
  )
    return integrityFailure();
  const record = validateRecord(
    {
      reportId: reportId.value,
      scope: {
        exchange: exchange.value,
        environment: environment.value,
        accountId: accountId.value,
      },
      evaluatedAt: evaluatedAt.value,
      openingAnchorId: openingAnchorId.value,
      closingAnchorId: closingAnchorId.value,
      status: status.value,
      dependencyHash: dependencyHash.value,
      contentHash: contentHash.value,
      canonicalJson: canonicalJson.value,
    },
    connection,
  );
  return record.ok ? record : integrityFailure();
}

class SqliteHistoryAccountingReportStore implements HistoryAccountingReportStorePort {
  constructor(private readonly connection: SqliteConnection) {}

  append(
    value: HistoryAccountingReportRecord,
  ): Result<HistoryAccountingReportRecord> {
    const record = validateRecord(value, this.connection);
    if (!record.ok) return record;
    return runInTransaction(
      this.connection.db,
      (database) => {
        const existing = database
          .prepare(
            "SELECT * FROM history_accounting_reports WHERE report_id = ?",
          )
          .get(record.value.reportId) as ReportRow | undefined;
        if (existing !== undefined) {
          const parsed = parseRow(existing, this.connection);
          if (!parsed.ok) return parsed;
          return parsed.value.contentHash === record.value.contentHash &&
            parsed.value.canonicalJson === record.value.canonicalJson
            ? parsed
            : fail(
                domainError(
                  "PERSISTENCE_CONFLICT",
                  "report ID already identifies different evidence",
                ),
              );
        }
        database
          .prepare(
            `INSERT INTO history_accounting_reports
        (report_id, exchange, environment, account_id, evaluated_at, opening_anchor_id,
         closing_anchor_id, status, dependency_hash, content_hash, canonical_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            record.value.reportId,
            record.value.scope.exchange,
            record.value.scope.environment,
            record.value.scope.accountId,
            record.value.evaluatedAt,
            record.value.openingAnchorId,
            record.value.closingAnchorId,
            record.value.status,
            record.value.dependencyHash,
            record.value.contentHash,
            record.value.canonicalJson,
          );
        return ok(record.value);
      },
      "PERSISTENCE_INTEGRITY",
    );
  }

  readById(
    reportId: string,
  ): Result<HistoryAccountingReportRecord | undefined> {
    const id = requireIdentifier(reportId, "reportId");
    if (!id.ok)
      return fail(domainError("INVALID_IDENTIFIER", "report ID is invalid"));
    try {
      const row = this.connection.db
        .prepare("SELECT * FROM history_accounting_reports WHERE report_id = ?")
        .get(id.value) as ReportRow | undefined;
      return row === undefined ? ok(undefined) : parseRow(row, this.connection);
    } catch (error) {
      return fail(sqliteError(error, "PERSISTENCE_INTEGRITY"));
    }
  }
}

export function createSqliteHistoryAccountingReportStore(
  connection: SqliteConnection,
): HistoryAccountingReportStorePort {
  return new SqliteHistoryAccountingReportStore(connection);
}
