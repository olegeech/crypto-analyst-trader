import type { Result } from "../domain/shared/result.js";
import type { UtcTimestamp } from "../domain/shared/time.js";
import type { HistoryStoreScope } from "./history-store.js";

export interface HistoryAccountingReportRecord {
  readonly reportId: string;
  readonly scope: HistoryStoreScope;
  readonly evaluatedAt: UtcTimestamp;
  readonly openingAnchorId: string;
  readonly closingAnchorId: string;
  readonly status: "ACCOUNTING_READY" | "NOT_READY";
  readonly dependencyHash: string;
  readonly contentHash: string;
  /** Canonical, source-backed report JSON. This database is private local data. */
  readonly canonicalJson: string;
}

export interface HistoryAccountingReportStorePort {
  /** Append is idempotent for byte-identical report IDs and rejects changed reuse. */
  append(
    record: HistoryAccountingReportRecord,
  ): Result<HistoryAccountingReportRecord>;
  readById(reportId: string): Result<HistoryAccountingReportRecord | undefined>;
}
