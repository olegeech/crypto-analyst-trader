import { createSqliteHistoryAccountingWalletAnchorStore } from "../adapters/sqlite/history-accounting-anchor-store.js";
import { createMacOSHistoryAccountingAnchorKeyProvider } from "../adapters/macos-keychain-history-accounting-anchor-key-provider.js";
import { createSqliteHistoryAccountingReportStore } from "../adapters/sqlite/history-accounting-report-store.js";
import {
  openSqliteConnection,
  type SqliteConnection,
} from "../adapters/sqlite/connection.js";
import { createSqliteHistoryStore } from "../adapters/sqlite/history-store.js";
import { domainError } from "../domain/shared/errors.js";
import { fail, type Result } from "../domain/shared/result.js";
import type { CredentialEnvironment } from "../ports/credential-provider.js";
import type { HistoryAccountingAnchorKeyProvider } from "../ports/history-accounting-anchor-key-provider.js";
import type { HistoryAccountingWalletAnchor } from "../ports/history-accounting-anchor-store.js";
import type { HistoryStoreScope } from "../ports/history-store.js";
import { resolveHistoryAccountingScope } from "./history-accounting-scope.js";
import type { HistoryAccountingReconciliationReport } from "./history-accounting-report.js";
import {
  createHistoryAccountingReport,
  decodeHistoryAccountingReport,
  encodeHistoryAccountingReport,
} from "./history-accounting-report.js";
import { loadHistoryAttributionLineageSnapshots } from "./history-ingestion-composition.js";

export interface ReconcileHistoryAccountingInput {
  readonly environment: CredentialEnvironment;
  readonly databasePath: string;
  readonly openingAnchorId: string;
  readonly closingAnchorId: string;
  /** Explicitly selects the scoped v2 accounting contract. */
  readonly accountingPolicyVersion?: string;
}

export interface ReconcileHistoryAccountingDependencies {
  readonly anchorKeyProvider?: Pick<HistoryAccountingAnchorKeyProvider, "read">;
  readonly openConnection?: typeof openSqliteConnection;
}

function error(code: string, message: string, stage: string): Result<never> {
  return fail(
    domainError("INVALID_ACCOUNTING", `${code}: ${message}`, {
      stage,
      exchangeReads: 0,
      exchangeWrites: 0,
    }),
  );
}

function sameScope(
  left: {
    readonly exchange: string;
    readonly environment: string;
    readonly accountId: string;
  },
  right: {
    readonly exchange: string;
    readonly environment: string;
    readonly accountId: string;
  },
): boolean {
  return (
    left.exchange === right.exchange &&
    left.environment === right.environment &&
    left.accountId === right.accountId
  );
}

/** Rebuild a report from the current local journal without persisting it. */
export function calculateHistoryAccountingReportFromLocalEvidence(
  connection: SqliteConnection,
  scope: HistoryStoreScope,
  opening: HistoryAccountingWalletAnchor,
  closing: HistoryAccountingWalletAnchor,
  accountingPolicyVersion?: string,
): Result<HistoryAccountingReconciliationReport> {
  if (
    connection.environment !== scope.environment ||
    opening.kind !== "opening" ||
    closing.kind !== "closing" ||
    !sameScope(scope, opening.scope) ||
    !sameScope(scope, closing.scope)
  )
    return error(
      "ANCHOR_SCOPE_MISMATCH",
      "selected anchors must match the report account and environment",
      "anchor-validation",
    );

  const accountingScope =
    accountingPolicyVersion === undefined
      ? undefined
      : resolveHistoryAccountingScope(accountingPolicyVersion);
  if (accountingScope !== undefined && !accountingScope.ok)
    return error(
      "INVALID_ACCOUNTING_POLICY",
      "select a supported accounting policy version",
      "request-validation",
    );

  const historyStore = createSqliteHistoryStore(connection);
  const observations = historyStore.readFacts(scope);
  const conflicts = historyStore.readConflicts(scope);
  const coverage = historyStore.listCoverage(scope);
  if (!observations.ok || !conflicts.ok || !coverage.ok)
    return error(
      "HISTORY_READ_FAILED",
      "local history evidence failed integrity validation",
      "history-read",
    );
  const lineage = loadHistoryAttributionLineageSnapshots(
    connection,
    scope.accountId,
  );
  if (!lineage.ok)
    return error(
      lineage.error.code,
      "local strategy ownership evidence failed validation",
      "lineage-read",
    );

  const report = createHistoryAccountingReport({
    scope,
    opening,
    closing,
    observations: observations.value,
    conflicts: conflicts.value,
    coverage: coverage.value,
    operatorSources: lineage.value.operatorSources,
    preparedSources: lineage.value.preparedSources,
    // Instrument settlement metadata is not persisted by #26 today. Leave
    // denomination unknown until verified metadata is supplied in a later
    // bounded addition; never infer it from the symbol suffix.
    settlementCurrencyBySymbol: {},
    ...(accountingScope?.ok ? { accountingScope: accountingScope.value } : {}),
  });
  return report.ok
    ? report
    : error(
        report.error.code,
        "the bounded account report could not be calculated",
        "projection",
      );
}

/** Rebuild and persist an exact offline report from local immutable evidence. */
export async function reconcileHistoryAccounting(
  input: ReconcileHistoryAccountingInput,
  dependencies: ReconcileHistoryAccountingDependencies = {},
): Promise<Result<HistoryAccountingReconciliationReport>> {
  if (
    !input ||
    !["demo", "testnet", "mainnet"].includes(input.environment) ||
    typeof input.databasePath !== "string" ||
    !input.databasePath.startsWith("/") ||
    input.databasePath.length > 2_048 ||
    /[\u0000-\u001f\u007f]/u.test(input.databasePath) ||
    typeof input.openingAnchorId !== "string" ||
    typeof input.closingAnchorId !== "string" ||
    input.openingAnchorId.length === 0 ||
    input.closingAnchorId.length === 0 ||
    (input.accountingPolicyVersion !== undefined &&
      typeof input.accountingPolicyVersion !== "string")
  )
    return error(
      "INVALID_REQUEST",
      "environment, database and anchor IDs are required",
      "request-validation",
    );

  let connection: SqliteConnection | undefined;
  try {
    const anchorKeyProvider =
      dependencies.anchorKeyProvider ??
      createMacOSHistoryAccountingAnchorKeyProvider();
    const authenticationKey = await anchorKeyProvider.read(input.environment);
    if (!authenticationKey.ok)
      return error(
        "ANCHOR_AUTHENTICATOR_UNAVAILABLE",
        "local wallet-anchor authentication key is unavailable",
        "anchor-authentication",
      );
    const opened = (dependencies.openConnection ?? openSqliteConnection)({
      environment: input.environment,
      databasePath: input.databasePath,
    });
    if (!opened.ok)
      return error(
        opened.error.code,
        "local evidence database could not be opened",
        "local-database-open",
      );
    connection = opened.value;

    const anchorStore = createSqliteHistoryAccountingWalletAnchorStore(
      connection,
      authenticationKey.value,
    );
    const opening = anchorStore.readById(input.openingAnchorId);
    const closing = anchorStore.readById(input.closingAnchorId);
    if (!opening.ok || !closing.ok)
      return error(
        "ANCHOR_READ_FAILED",
        "selected wallet anchors failed integrity validation",
        "anchor-read",
      );
    if (!opening.value || !closing.value)
      return error(
        "ANCHOR_NOT_FOUND",
        "select existing persisted opening and closing wallet anchors",
        "anchor-read",
      );
    const scope = opening.value.scope;
    if (
      scope.environment !== input.environment ||
      opening.value.kind !== "opening" ||
      closing.value.kind !== "closing" ||
      !sameScope(scope, closing.value.scope)
    )
      return error(
        "ANCHOR_SCOPE_MISMATCH",
        "selected anchors must be opening and closing evidence for the same account and environment",
        "anchor-validation",
      );

    const report = calculateHistoryAccountingReportFromLocalEvidence(
      connection,
      scope,
      opening.value,
      closing.value,
      input.accountingPolicyVersion,
    );
    if (!report.ok) return report;
    const encoded = encodeHistoryAccountingReport(report.value);
    if (!encoded.ok)
      return error(
        encoded.error.code,
        "the calculated report could not be encoded",
        "report-encoding",
      );
    const reportStore = createSqliteHistoryAccountingReportStore(connection);
    const persisted = reportStore.append(encoded.value);
    if (!persisted.ok)
      return error(
        persisted.error.code,
        "the immutable report could not be persisted",
        "report-persistence",
      );
    const verifiedRecord = reportStore.readById(persisted.value.reportId);
    if (!verifiedRecord.ok || !verifiedRecord.value)
      return error(
        "REPORT_READBACK_FAILED",
        "the persisted report could not be verified",
        "report-readback",
      );
    return decodeHistoryAccountingReport(verifiedRecord.value);
  } catch {
    return error(
      "RECONCILIATION_FAILED",
      "the local account report could not be produced",
      "reconciliation",
    );
  } finally {
    connection?.close();
  }
}
