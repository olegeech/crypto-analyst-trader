import { createSqliteHistoryAccountingWalletAnchorStore } from "../adapters/sqlite/history-accounting-anchor-store.js";
import { createMacOSHistoryAccountingAnchorKeyProvider } from "../adapters/macos-keychain-history-accounting-anchor-key-provider.js";
import { createSqliteHistoryAccountingReportStore } from "../adapters/sqlite/history-accounting-report-store.js";
import { openSqliteConnection } from "../adapters/sqlite/connection.js";
import type { SqliteConnection } from "../adapters/sqlite/connection.js";
import {
  decodeHistoryAccountingScope,
  type HistoryAccountingScope,
} from "../domain/accounting/accounting-scope.js";
import { hashCanonical } from "../domain/identity/canonical-serialization.js";
import { domainError } from "../domain/shared/errors.js";
import { fail, ok, type Result } from "../domain/shared/result.js";
import { parseUtcTimestamp, type UtcTimestamp } from "../domain/shared/time.js";
import { requireHash, requireIdentifier } from "../domain/shared/validation.js";
import type { CredentialEnvironment } from "../ports/credential-provider.js";
import type { HistoryAccountingAnchorKeyProvider } from "../ports/history-accounting-anchor-key-provider.js";
import type { HistoryStoreScope } from "../ports/history-store.js";
import { calculateHistoryAccountingReportFromLocalEvidence } from "./history-accounting-composition.js";
import { decodeHistoryAccountingReport } from "./history-accounting-report.js";
import { resolveHistoryAccountingScope } from "./history-accounting-scope.js";

export type HistoryAccountingProofReasonCode =
  | "INVALID_REQUEST"
  | "REPORT_NOT_FOUND"
  | "REPORT_INTEGRITY_INVALID"
  | "ANCHOR_NOT_FOUND"
  | "ANCHOR_INTEGRITY_INVALID"
  | "SCOPE_MISMATCH"
  | "ACCOUNTING_SCOPE_INVALID"
  | "ACCOUNTING_SCOPE_MISMATCH"
  | "REPORT_VERSION_MISMATCH"
  | "UNSUPPORTED_PROOF_VERSION"
  | "EPOCH_MISMATCH"
  | "DEPENDENCY_MISMATCH"
  | "REPORT_NOT_READY"
  | "RELEVANT_EVIDENCE_CHANGED"
  | "CURRENT_EVIDENCE_UNAVAILABLE"
  | "COVERAGE_THROUGH_NOT_MET"
  | "FRESHNESS_INVALID"
  | "FRESHNESS_EXCEEDED";

interface HistoryAccountingProofRequestBase {
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

/** Existing account-wide v1 request; absence of schemaVersion preserves it. */
export interface HistoryAccountingProofRequestV1 extends HistoryAccountingProofRequestBase {
  readonly schemaVersion?: never;
  readonly accountingScope?: never;
  readonly accountingScopeHash?: never;
}

/** Explicit policy-bound request for a scoped v2 report. */
export interface HistoryAccountingProofRequestV2 extends HistoryAccountingProofRequestBase {
  readonly schemaVersion: "history-accounting-proof-request/v2";
  readonly accountingScope: HistoryAccountingScope;
  readonly accountingScopeHash: string;
}

export type HistoryAccountingProofRequest =
  HistoryAccountingProofRequestV1 | HistoryAccountingProofRequestV2;

interface HistoryAccountingProofValidationBase {
  readonly decision: "ACCEPT" | "REFUSE";
  readonly authority: "evidence-only";
  readonly reportId: string | null;
  readonly scope: HistoryStoreScope | null;
  readonly openingBoundary: UtcTimestamp | null;
  readonly closingBoundary: UtcTimestamp | null;
  readonly reasonCodes: readonly HistoryAccountingProofReasonCode[];
}

/** Existing account-wide result shape, kept unchanged for v1 callers. */
export interface HistoryAccountingProofValidationV1 extends HistoryAccountingProofValidationBase {
  readonly schemaVersion?: never;
  readonly accountingScope?: never;
  readonly accountingScopeHash?: never;
}

/** Scoped result names the exact accounting descriptor that was checked. */
export interface HistoryAccountingProofValidationV2 extends HistoryAccountingProofValidationBase {
  readonly schemaVersion: "history-accounting-proof-validation/v2";
  readonly accountingScope: HistoryAccountingScope | null;
  readonly accountingScopeHash: string | null;
}

export type HistoryAccountingProofValidation =
  HistoryAccountingProofValidationV1 | HistoryAccountingProofValidationV2;

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
): HistoryAccountingProofValidationV1 {
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
): HistoryAccountingProofValidationV1 {
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

function isScopedRequest(
  input: unknown,
): input is HistoryAccountingProofRequestV2 {
  return (
    typeof input === "object" &&
    input !== null &&
    "schemaVersion" in input &&
    input.schemaVersion === "history-accounting-proof-request/v2"
  );
}

function hasUnsupportedRequestVersion(input: unknown): boolean {
  return (
    typeof input === "object" &&
    input !== null &&
    "schemaVersion" in input &&
    input.schemaVersion !== "history-accounting-proof-request/v2"
  );
}

function expectedScopedAccountingScope(
  input: HistoryAccountingProofRequestV2,
): HistoryAccountingScope | null {
  const decoded = decodeHistoryAccountingScope(input.accountingScope);
  if (!decoded.ok) return null;
  const resolved = resolveHistoryAccountingScope(decoded.value.policyVersion);
  if (!resolved.ok) return null;
  if (
    input.accountingScopeHash !== resolved.value.scopeHash ||
    decoded.value.scopeHash !== resolved.value.scopeHash ||
    !canonicalValuesEqual(decoded.value, resolved.value)
  )
    return null;
  return resolved.value;
}

function canonicalValuesEqual(left: unknown, right: unknown): boolean {
  const leftHash = hashCanonical(left);
  const rightHash = hashCanonical(right);
  return leftHash.ok && rightHash.ok && leftHash.value === rightHash.value;
}

function reportReferencesMissingAnchor(
  connection: SqliteConnection,
  input: HistoryAccountingProofRequest,
): boolean {
  try {
    const row = connection.db
      .prepare(
        `SELECT COUNT(*) AS count FROM history_accounting_wallet_anchors
         WHERE anchor_id IN (?, ?)`,
      )
      .get(input.openingAnchorId, input.closingAnchorId) as
      { readonly count?: unknown } | undefined;
    return typeof row?.count === "number" && row.count < 2;
  } catch {
    return false;
  }
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
    !requireHash(input.dependencyHash, "dependencyHash").ok ||
    ("schemaVersion" in input &&
      input.schemaVersion !== "history-accounting-proof-request/v2")
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
  input: HistoryAccountingProofRequest,
  code: HistoryAccountingProofReasonCode,
  reportId: string | null = null,
  scope: HistoryStoreScope | null = null,
  openingBoundary: UtcTimestamp | null = null,
  closingBoundary: UtcTimestamp | null = null,
): Result<HistoryAccountingProofValidation> {
  if (isScopedRequest(input)) {
    const accountingScope = expectedScopedAccountingScope(input);
    return ok(
      Object.freeze({
        schemaVersion: "history-accounting-proof-validation/v2",
        decision: "REFUSE",
        authority: "evidence-only",
        reportId,
        scope,
        openingBoundary,
        closingBoundary,
        accountingScope,
        accountingScopeHash: accountingScope?.scopeHash ?? null,
        reasonCodes: Object.freeze([code]),
      }),
    );
  }
  return ok(refusal(code, reportId, scope, openingBoundary, closingBoundary));
}

function acceptedResult(
  input: HistoryAccountingProofRequest,
  reportId: string,
  scope: HistoryStoreScope,
  openingBoundary: UtcTimestamp,
  closingBoundary: UtcTimestamp,
): Result<HistoryAccountingProofValidation> {
  if (isScopedRequest(input)) {
    const accountingScope = expectedScopedAccountingScope(input);
    if (!accountingScope)
      return refusalResult(input, "ACCOUNTING_SCOPE_INVALID", reportId, scope);
    return ok(
      Object.freeze({
        schemaVersion: "history-accounting-proof-validation/v2",
        decision: "ACCEPT",
        authority: "evidence-only",
        reportId,
        scope: Object.freeze({ ...scope }),
        openingBoundary,
        closingBoundary,
        accountingScope,
        accountingScopeHash: accountingScope.scopeHash,
        reasonCodes: Object.freeze([]),
      }),
    );
  }
  return ok(accepted(reportId, scope, openingBoundary, closingBoundary));
}

function validateWithinConnection(
  connection: SqliteConnection,
  input: HistoryAccountingProofRequest,
  authenticationKey: Uint8Array,
): Result<HistoryAccountingProofValidation> {
  const scopedAccountingScope = isScopedRequest(input)
    ? expectedScopedAccountingScope(input)
    : undefined;
  if (isScopedRequest(input) && !scopedAccountingScope)
    return refusalResult(input, "ACCOUNTING_SCOPE_INVALID", input.reportId);
  const refuse = (
    code: HistoryAccountingProofReasonCode,
    reportId: string | null = null,
    scope: HistoryStoreScope | null = null,
    openingBoundary: UtcTimestamp | null = null,
    closingBoundary: UtcTimestamp | null = null,
  ) =>
    refusalResult(
      input,
      code,
      reportId,
      scope,
      openingBoundary,
      closingBoundary,
    );

  const reportStore = createSqliteHistoryAccountingReportStore(connection);
  const stored = reportStore.readById(input.reportId);
  if (!stored.ok)
    return refuse(
      reportReferencesMissingAnchor(connection, input)
        ? "ANCHOR_NOT_FOUND"
        : "REPORT_INTEGRITY_INVALID",
      input.reportId,
    );
  if (!stored.value) return refuse("REPORT_NOT_FOUND", input.reportId);
  const decoded = decodeHistoryAccountingReport(stored.value);
  if (!decoded.ok) return refuse("REPORT_INTEGRITY_INVALID", input.reportId);
  const report = decoded.value;
  const reportIsScoped =
    report.schemaVersion === "history-accounting-reconciliation-report/v2";
  if (reportIsScoped !== isScopedRequest(input))
    return refuse("REPORT_VERSION_MISMATCH", report.reportId, report.scope);
  if (
    isScopedRequest(input) &&
    report.schemaVersion === "history-accounting-reconciliation-report/v2" &&
    (report.accountingScopeHash !== scopedAccountingScope?.scopeHash ||
      !canonicalValuesEqual(report.accountingScope, scopedAccountingScope))
  )
    return refuse("ACCOUNTING_SCOPE_MISMATCH", report.reportId, report.scope);

  const openingBoundary = parseUtcTimestamp(report.epoch.epoch.openingBoundary);
  const closingBoundary = parseUtcTimestamp(report.epoch.epoch.closingBoundary);
  if (!openingBoundary.ok || !closingBoundary.ok)
    return refuse("REPORT_INTEGRITY_INVALID", report.reportId, report.scope);

  if (!sameScope(report.scope, input.expectedScope))
    return refuse(
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
    return refuse(
      "EPOCH_MISMATCH",
      report.reportId,
      report.scope,
      openingBoundary.value,
      closingBoundary.value,
    );
  if (report.dependencyHash !== input.dependencyHash)
    return refuse(
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
    return refuse(
      "ANCHOR_INTEGRITY_INVALID",
      report.reportId,
      report.scope,
      openingBoundary.value,
      closingBoundary.value,
    );
  if (!opening.value || !closing.value)
    return refuse(
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
    return refuse(
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
    return refuse(
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
      return refuse(
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
      return refuse(
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
      return refuse(
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
    scopedAccountingScope?.policyVersion,
  );
  if (!current.ok)
    return refuse(
      "CURRENT_EVIDENCE_UNAVAILABLE",
      report.reportId,
      report.scope,
      openingBoundary.value,
      closingBoundary.value,
    );
  if (
    current.value.schemaVersion !== report.schemaVersion ||
    current.value.dependencyHash !== report.dependencyHash ||
    // Scoped report content can list newly observed independent exclusions;
    // the scope-bound dependency hash intentionally excludes those details.
    (report.schemaVersion === "history-accounting-reconciliation-report/v1" &&
      current.value.contentHash !== report.contentHash) ||
    current.value.status !== "ACCOUNTING_READY"
  )
    return refuse(
      "RELEVANT_EVIDENCE_CHANGED",
      report.reportId,
      report.scope,
      openingBoundary.value,
      closingBoundary.value,
    );

  return acceptedResult(
    input,
    report.reportId,
    report.scope,
    openingBoundary.value,
    closingBoundary.value,
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
  if (hasUnsupportedRequestVersion(input))
    return ok(refusal("UNSUPPORTED_PROOF_VERSION"));
  if (!validInput(input)) return invalidRequest();
  if (isScopedRequest(input) && !expectedScopedAccountingScope(input))
    return refusalResult(input, "ACCOUNTING_SCOPE_INVALID", input.reportId);
  let connection: SqliteConnection | undefined;
  try {
    const anchorKeyProvider =
      dependencies.anchorKeyProvider ??
      createMacOSHistoryAccountingAnchorKeyProvider();
    const authenticationKey = await anchorKeyProvider.read(input.environment);
    if (!authenticationKey.ok)
      return refusalResult(input, "ANCHOR_INTEGRITY_INVALID", input.reportId);
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
