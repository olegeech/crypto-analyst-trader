import type { HistorySourceFact } from "../domain/accounting/history-source-fact.js";
import type { HistoryReadSource, HistoryReadWindow } from "./history-read.js";
import type { PersistenceEnvironment } from "./persistence.js";
import type { Result } from "../domain/shared/result.js";
import type { UtcTimestamp } from "../domain/shared/time.js";

export interface HistoryStoreScope {
  readonly exchange: string;
  readonly environment: PersistenceEnvironment;
  /** Verified account identity hash. Never store API credentials here. */
  readonly accountId: string;
}

export type HistoryFilterValue =
  | string
  | number
  | boolean
  | null
  | readonly HistoryFilterValue[]
  | { readonly [key: string]: HistoryFilterValue };

export type HistoryWindow = HistoryReadWindow;

export type HistoryCoverageStatus =
  "paging" | "partial" | "traversed" | "unavailable";

export interface HistoryCoverageKey {
  readonly scope: HistoryStoreScope;
  readonly source: HistoryReadSource;
  readonly filters: Readonly<Record<string, HistoryFilterValue>>;
  readonly window: HistoryWindow;
}

export interface HistoryCheckpoint extends HistoryCoverageKey {
  readonly filterHash: string;
  /** Opaque Bybit cursor for the next page, when this window is paging. */
  readonly cursor: string | null;
  readonly status: HistoryCoverageStatus;
  readonly rowCount: number;
  readonly insertedCount: number;
  readonly duplicateCount: number;
  readonly conflictCount: number;
  readonly reasonCode: string | null;
  readonly updatedAt: UtcTimestamp;
  readonly revision: number;
}

export interface HistoryStorePageRequest extends HistoryCoverageKey {
  /** Revision read with readCheckpoint; zero means no checkpoint exists. */
  readonly expectedRevision: number;
  /** Cursor used for this page, null for the first page or an explicit replay. */
  readonly cursor: string | null;
  readonly nextCursor: string | null;
  readonly facts: readonly HistorySourceFact[];
}

export interface HistoryConflictSummary {
  readonly conflictId: string;
  readonly source: HistoryReadSource;
  readonly eventIdentity: string;
  readonly existingHash: string;
  readonly incomingHash: string;
  readonly reason:
    "IMMUTABLE_ID_CONTENT_CHANGED" | "ORDER_REVISION_CONTENT_CHANGED";
  readonly recordedAt: UtcTimestamp;
  /** Exact ingestion windows that recorded this conflict, when available. */
  readonly windows?: readonly {
    readonly filterHash: string;
    readonly window: HistoryWindow;
  }[];
}

export interface HistoryStorePageResult {
  readonly checkpoint: HistoryCheckpoint;
  readonly inserted: number;
  readonly duplicates: number;
  readonly conflicts: readonly HistoryConflictSummary[];
}

export interface HistoryStoredObservation {
  readonly observationId: string;
  readonly scope: HistoryStoreScope;
  readonly source: HistoryReadSource;
  readonly eventIdentity: string;
  readonly contentHash: string;
  readonly canonicalHash: string;
  readonly providerEventTime: UtcTimestamp;
  readonly providerRevisionTime: UtcTimestamp | null;
  readonly collectedAt: UtcTimestamp;
  readonly fact: HistorySourceFact;
}

export interface MarkHistoryCoverageRequest extends HistoryCoverageKey {
  readonly expectedRevision: number;
  readonly status: "partial" | "unavailable";
  readonly reasonCode: string;
  /** Preserve the stored cursor by omitting this field; null restarts the window. */
  readonly cursor?: string | null;
}

export interface HistoryStorePort {
  readCheckpoint(
    key: HistoryCoverageKey,
  ): Result<HistoryCheckpoint | undefined>;
  commitPage(request: HistoryStorePageRequest): Result<HistoryStorePageResult>;
  markCoverage(request: MarkHistoryCoverageRequest): Result<HistoryCheckpoint>;
  readFacts(
    scope: HistoryStoreScope,
    source?: HistoryReadSource,
  ): Result<readonly HistoryStoredObservation[]>;
  readConflicts(
    scope: HistoryStoreScope,
    source?: HistoryReadSource,
  ): Result<readonly HistoryConflictSummary[]>;
  listCoverage(
    scope: HistoryStoreScope,
    source?: HistoryReadSource,
  ): Result<readonly HistoryCheckpoint[]>;
}
