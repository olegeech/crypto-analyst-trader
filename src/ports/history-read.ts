import type { HistorySourceFact } from "../domain/accounting/history-source-fact.js";

export const HISTORY_READ_SOURCES = [
  "order-history",
  "executions",
  "closed-pnl",
  "transaction-log",
] as const;
export type HistoryReadSource = (typeof HISTORY_READ_SOURCES)[number];

export interface HistoryReadWindow {
  readonly fromMs: number;
  readonly toMs: number;
}

export interface HistoryReadPageRequest {
  readonly source: HistoryReadSource;
  readonly window: HistoryReadWindow;
  /** Opaque Bybit nextPageCursor from the preceding page. */
  readonly cursor?: string;
}

export interface HistoryReadPage {
  readonly source: HistoryReadSource;
  readonly window: HistoryReadWindow;
  readonly cursor: string | null;
  readonly nextCursor: string | null;
  /** Number of raw provider rows received, before identical-row collapse. */
  readonly receivedRowCount: number;
  readonly facts: readonly HistorySourceFact[];
}

/**
 * Read-only provider page boundary. The caller binds the transport to a
 * verified account/environment and persists each yielded page before asking
 * for the next one.
 */
export interface HistoryReadPort {
  readPage(request: HistoryReadPageRequest): Promise<HistoryReadPage>;
  readPages(
    request: Omit<HistoryReadPageRequest, "cursor">,
  ): AsyncIterable<HistoryReadPage>;
}
