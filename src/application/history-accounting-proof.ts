import { createSqliteHistoryAccountingWalletAnchorStore } from "../adapters/sqlite/history-accounting-anchor-store.js";
import { createMacOSHistoryAccountingAnchorKeyProvider } from "../adapters/macos-keychain-history-accounting-anchor-key-provider.js";
import { createSqliteHistoryAccountingReportStore } from "../adapters/sqlite/history-accounting-report-store.js";
import { openSqliteConnection } from "../adapters/sqlite/connection.js";
import type { SqliteConnection } from "../adapters/sqlite/connection.js";
import { domainError } from "../domain/shared/errors.js";
import { fail, ok, type Result } from "../domain/shared/result.js";
import { parseUtcTimestamp, type UtcTimestamp } from "../domain/shared/time.js";
import { requireHash, requireIdentifier } from "../domain/shared/validation.js";
import type { CredentialEnvironment } from "../ports/credential-provider.js";
import type { HistoryAccountingAnchorKeyProvider } from "../ports/history-accounting-anchor-key-provider.js";
import type { HistoryStoreScope } from "../ports/history-store.js";
import { calculateHistoryAccountingReportFromLocalEvidence } from "./history-accounting-composition.js";
import { decodeHistoryAccountingReport } from "./history-accounting-report.js";

export type HistoryAccountingProofReasonCode =
  | "INVALID_REQUEST"
  | "REPORT_NOT_FOUND"
  | "REPORT_INTEGRITY_INVALID"
  | "ANCHOR_NOT_FOUND"
  | "ANCHOR_INTEGRITY_INVALID"
  | "SCOPE_MISMATCH"
  | "EPOCH_MISMATCH"
  | "DEPENDENCY_MISMATCH"
  | "REPORT_NOT_READY"
  | "RELEVANT_EVIDENCE_CHANGED"
  | "CURRENT_EVIDENCE_UNAVAILABLE"
  | "COVERAGE_THROUGH_NOT_MET"
  | "FRESHNESS_INVALID"
  | "FRESHNESS_EXCEEDED";

export interface HistoryAccountingProofRequest {
  readonly environment: CredentialEnvironment;
  readonly databasePath: string;
  readonly reportId: string;
  readonly expectedScope: HistoryStoreScope;
  readonly openingAnchorId: string;
  readonly closingAnchorId: string;
  readonly dependencyHash: string;
  readonly coverageThrough?: UtcTimestamp;
  /** Report age is checked only when an eventual caller explicitly asks. */
  readonly freshness?: {
    readonly now: UtcTimestamp;
    readonly maxAgeMs: number;
  };
}

export interface HistoryAccountingProofValidation {
  readonly decision: "ACCEPT" | "REFUSE";
  readonly authority: "evidence-only";
  readonly reportId: string | null;
  readonly scope: HistoryStoreScope | null;
  readonly openingBoundary: UtcTimestamp | null;
  readonly closingBoundary: UtcTimestamp | null;
  readonly reasonCodes: readonly HistoryAccountingProofReasonCode[];
}

export interface ValidateHistoryAccountingProofDependencies {
  readonly anchorKeyProvider?: Pick<HistoryAccountingAnchorKeyProvider, "read">;
  readonly openConnection?: typeof openSqliteConnection;
}

function refusal(
  code: HistoryAccountingProofReasonCode,
  reportId: string | null = null,
  scope: HistoryStoreScope | null = null,
  openingBoundary: UtcTimestamp | null = null,
  closingBoundary: UtcTimestamp | null = null,
): HistoryAccountingProofValidation {
  return Object.freeze({
    decision: "REFUSE",
    authority: "evidence-only",
    reportId,
    scope,
    openingBoundary,
    closingBoundary,
    reasonCodes: Object.freeze([code]),
  });
}

function accepted(
  reportId: string,
  scope: HistoryStoreScope,
  openingBoundary: UtcTimestamp,
  closingBoundary: UtcTimestamp,
): HistoryAccountingProofValidation {
  return Object.freeze({
    decision: "ACCEPT",
    authority: "evidence-only",
    reportId,
    scope: Object.freeze({ ...scope }),
    openingBoundary,
    closingBoundary,
    reasonCodes: Object.freeze([]),
  });
}

function invalidRequest(): Result<never> {
  return fail(
    domainError(
      "INVALID_VALUE",
      "history accounting proof request is invalid",
      {
        exchangeReads: 0,
        exchangeWrites: 0,
      },
    ),
  );
}

function sameScope(left: HistoryStoreScope, right: HistoryStoreScope): boolean {
  return (
    left.exchange === right.exchange &&
    left.environment === right.environment &&
    left.accountId === right.accountId
  );
}

function validInput(input: HistoryAccountingProofRequest): boolean {
  if (
    !input ||
    !["demo", "testnet", "mainnet"].includes(input.environment) ||
    typeof input.databasePath !== "string" ||
    !input.databasePath.startsWith("/") ||
    input.databasePath.length > 2_048 ||
    /[\u0000-\u001f\u007f]/u.test(input.databasePath) ||
    input.expectedScope?.exchange !== "bybit" ||
    input.expectedScope.environment !== input.environment ||
    !requireHash(input.expectedScope.accountId, "accountId").ok ||
    !requireIdentifier(input.reportId, "reportId").ok ||
    !requireIdentifier(input.openingAnchorId, "openingAnchorId").ok ||
    !requireIdentifier(input.closingAnchorId, "closingAnchorId").ok ||
    !requireHash(input.dependencyHash, "dependencyHash").ok
  )
    return false;
  if (
    input.coverageThrough !== undefined &&
    !parseUtcTimestamp(input.coverageThrough).ok
  )
    return false;
  return (
    input.freshness === undefined ||
    (parseUtcTimestamp(input.freshness.now).ok &&
      Number.isSafeInteger(input.freshness.maxAgeMs) &&
      input.freshness.maxAgeMs >= 0)
  );
}

function refusalResult(
  code: HistoryAccountingProofReasonCode,
  reportId: string | null = null,
  scope: HistoryStoreScope | null = null,
  openingBoundary: UtcTimestamp | null = null,
  closingBoundary: UtcTimestamp | null = null,
): Result<HistoryAccountingProofValidation> {
  return ok(refusal(code, reportId, scope, openingBoundary, closingBoundary));
}

function validateWithinConnection(
  connection: SqliteConnection,
  input: HistoryAccountingProofRequest,
  authenticationKey: Uint8Array,
): Result<HistoryAccountingProofValidation> {
  const reportStore = createSqliteHistoryAccountingReportStore(connection);
  const stored = reportStore.readById(input.reportId);
  if (!stored.ok)
    return refusalResult("REPORT_INTEGRITY_INVALID", input.reportId);
  if (!stored.value) return refusalResult("REPORT_NOT_FOUND", input.reportId);
  const decoded = decodeHistoryAccountingReport(stored.value);
  if (!decoded.ok)
    return refusalResult("REPORT_INTEGRITY_INVALID", input.reportId);
  const report = decoded.value;
  const openingBoundary = parseUtcTimestamp(report.epoch.epoch.openingBoundary);
  const closingBoundary = parseUtcTimestamp(report.epoch.epoch.closingBoundary);
  if (!openingBoundary.ok || !closingBoundary.ok)
    return refusalResult(
      "REPORT_INTEGRITY_INVALID",
      report.reportId,
      report.scope,
    );

  if (!sameScope(report.scope, input.expectedScope))
    return refusalResult(
      "SCOPE_MISMATCH",
      report.reportId,
      report.scope,
      openingBoundary.value,
      closingBoundary.value,
    );
  if (
    report.epoch.epoch.openingAnchorId !== input.openingAnchorId ||
    report.epoch.epoch.closingAnchorId !== input.closingAnchorId
  )
    return refusalResult(
      "EPOCH_MISMATCH",
      report.reportId,
      report.scope,
      openingBoundary.value,
      closingBoundary.value,
    );
  if (report.dependencyHash !== input.dependencyHash)
    return refusalResult(
      "DEPENDENCY_MISMATCH",
      report.reportId,
      report.scope,
      openingBoundary.value,
      closingBoundary.value,
    );

  const anchorStore = createSqliteHistoryAccountingWalletAnchorStore(
    connection,
    authenticationKey,
  );
  const opening = anchorStore.readById(input.openingAnchorId);
  const closing = anchorStore.readById(input.closingAnchorId);
  if (!opening.ok || !closing.ok)
    return refusalResult(
      "ANCHOR_INTEGRITY_INVALID",
      report.reportId,
      report.scope,
      openingBoundary.value,
      closingBoundary.value,
    );
  if (!opening.value || !closing.value)
    return refusalResult(
      "ANCHOR_NOT_FOUND",
      report.reportId,
      report.scope,
      openingBoundary.value,
      closingBoundary.value,
    );
  if (
    opening.value.kind !== "opening" ||
    closing.value.kind !== "closing" ||
    !sameScope(opening.value.scope, input.expectedScope) ||
    !sameScope(closing.value.scope, input.expectedScope)
  )
    return refusalResult(
      "SCOPE_MISMATCH",
      report.reportId,
      report.scope,
      openingBoundary.value,
      closingBoundary.value,
    );

  if (
    report.status !== "ACCOUNTING_READY" ||
    report.epoch.status !== "RECONCILED" ||
    report.epoch.readiness !== "ACCOUNTING_READY"
  )
    return refusalResult(
      "REPORT_NOT_READY",
      report.reportId,
      report.scope,
      openingBoundary.value,
      closingBoundary.value,
    );

  if (input.coverageThrough !== undefined) {
    const requestedThrough = parseUtcTimestamp(input.coverageThrough);
    if (
      !requestedThrough.ok ||
      Date.parse(requestedThrough.value) <= Date.parse(openingBoundary.value) ||
      Date.parse(requestedThrough.value) > Date.parse(closingBoundary.value) ||
      report.epoch.sourceCoverage.some((source) => !source.covered)
    )
      return refusalResult(
        "COVERAGE_THROUGH_NOT_MET",
        report.reportId,
        report.scope,
        openingBoundary.value,
        closingBoundary.value,
      );
  }

  if (input.freshness !== undefined) {
    const now = parseUtcTimestamp(input.freshness.now);
    if (!now.ok || Date.parse(now.value) < Date.parse(report.evaluatedAt))
      return refusalResult(
        "FRESHNESS_INVALID",
        report.reportId,
        report.scope,
        openingBoundary.value,
        closingBoundary.value,
      );
    if (
      Date.parse(now.value) - Date.parse(report.evaluatedAt) >
      input.freshness.maxAgeMs
    )
      return refusalResult(
        "FRESHNESS_EXCEEDED",
        report.reportId,
        report.scope,
        openingBoundary.value,
        closingBoundary.value,
      );
  }

  const current = calculateHistoryAccountingReportFromLocalEvidence(
    connection,
    input.expectedScope,
    opening.value,
    closing.value,
  );
  if (!current.ok)
    return refusalResult(
      "CURRENT_EVIDENCE_UNAVAILABLE",
      report.reportId,
      report.scope,
      openingBoundary.value,
      closingBoundary.value,
    );
  if (
    current.value.dependencyHash !== report.dependencyHash ||
    current.value.contentHash !== report.contentHash ||
    current.value.status !== "ACCOUNTING_READY"
  )
    return refusalResult(
      "RELEVANT_EVIDENCE_CHANGED",
      report.reportId,
      report.scope,
      openingBoundary.value,
      closingBoundary.value,
    );

  return ok(
    accepted(
      report.reportId,
      report.scope,
      openingBoundary.value,
      closingBoundary.value,
    ),
  );
}

/**
 * Validate an exact, persisted period report against the current local evidence.
 * Acceptance is evidence-only and never grants exchange-write authority.
 */
export async function validateHistoryAccountingProof(
  input: HistoryAccountingProofRequest,
  dependencies: ValidateHistoryAccountingProofDependencies = {},
): Promise<Result<HistoryAccountingProofValidation>> {
  if (!validInput(input)) return invalidRequest();
  let connection: SqliteConnection | undefined;
  try {
    const anchorKeyProvider =
      dependencies.anchorKeyProvider ??
      createMacOSHistoryAccountingAnchorKeyProvider();
    const authenticationKey = await anchorKeyProvider.read(input.environment);
    if (!authenticationKey.ok)
      return refusalResult("ANCHOR_INTEGRITY_INVALID", input.reportId);
    const opened = (dependencies.openConnection ?? openSqliteConnection)({
      environment: input.environment,
      databasePath: input.databasePath,
    });
    if (!opened.ok)
      return fail(
        domainError(
          "PERSISTENCE_INTEGRITY",
          "local report database is unavailable",
          {
            exchangeReads: 0,
            exchangeWrites: 0,
          },
        ),
      );
    connection = opened.value;
    return validateWithinConnection(connection, input, authenticationKey.value);
  } catch {
    return fail(
      domainError(
        "PERSISTENCE_INTEGRITY",
        "local accounting proof could not be validated",
        {
          exchangeReads: 0,
          exchangeWrites: 0,
        },
      ),
    );
  } finally {
    connection?.close();
  }
}
