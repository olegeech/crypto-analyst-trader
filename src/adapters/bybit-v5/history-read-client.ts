import type {
  HistoryReadPage,
  HistoryReadPageRequest,
  HistoryReadPort,
  HistoryReadSource,
  HistoryReadWindow,
} from "../../ports/history-read.js";
import {
  BybitAccountReadError,
  type AccountReadResponse,
} from "./account-read-transport.js";
import { mapBybitHistoryResponse } from "./history-read-mappers.js";

const MAX_HISTORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_PAGES_PER_WINDOW = 20;
const MAX_ROWS_PER_WINDOW = 10_000;

const SOURCE_ROUTES: Readonly<
  Record<
    HistoryReadSource,
    { readonly path: string; readonly limit: number; readonly category: boolean }
  >
> = Object.freeze({
  "order-history": {
    path: "/v5/order/history",
    limit: 50,
    category: true,
  },
  executions: {
    path: "/v5/execution/list",
    limit: 100,
    category: true,
  },
  "closed-pnl": {
    path: "/v5/position/closed-pnl",
    limit: 100,
    category: true,
  },
  "transaction-log": {
    path: "/v5/account/transaction-log",
    limit: 50,
    category: false,
  },
});

interface HistoryTransport {
  get(
    path: string,
    query?: Readonly<Record<string, string>>,
  ): Promise<AccountReadResponse>;
}

export interface BybitHistoryReadClientOptions {
  readonly transport: HistoryTransport;
  readonly utcClock?: () => number;
  readonly maxPagesPerWindow?: number;
  readonly maxRowsPerWindow?: number;
}

function invalid(): never {
  throw new BybitAccountReadError("INVALID_RESPONSE");
}

function validateWindow(window: HistoryReadWindow): void {
  if (
    !window ||
    !Number.isSafeInteger(window.fromMs) ||
    !Number.isSafeInteger(window.toMs) ||
    window.fromMs < 0 ||
    window.toMs <= window.fromMs ||
    window.toMs - window.fromMs > MAX_HISTORY_WINDOW_MS
  )
    invalid();
}

function validateCursor(cursor: unknown): string | undefined {
  if (cursor === undefined) return undefined;
  if (
    typeof cursor !== "string" ||
    cursor.length === 0 ||
    cursor.length > 8192 ||
    /[\u0000-\u001f\u007f]/u.test(cursor)
  )
    invalid();
  return cursor;
}

function validatePageCursor(response: AccountReadResponse): string | null {
  const result = response.result;
  if (
    result === null ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    Object.getPrototypeOf(result) !== Object.prototype
  )
    invalid();
  const cursor = result.nextPageCursor;
  if (
    typeof cursor !== "string" ||
    cursor.length > 8192 ||
    /[\u0000-\u001f\u007f]/u.test(cursor)
  )
    invalid();
  return cursor === "" ? null : cursor;
}

function validateListLength(
  response: AccountReadResponse,
  limit: number,
): number {
  const result = response.result;
  if (
    result === null ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    Object.getPrototypeOf(result) !== Object.prototype ||
    !Array.isArray(result.list) ||
    result.list.length > limit
  )
    invalid();
  return result.list.length;
}

function failure(error: unknown): never {
  if (error instanceof BybitAccountReadError) throw error;
  throw new BybitAccountReadError("TRANSPORT_FAILED");
}

export class BybitHistoryReadClient implements HistoryReadPort {
  private readonly transport: HistoryTransport;
  private readonly clock: () => number;
  private readonly maxPagesPerWindow: number;
  private readonly maxRowsPerWindow: number;

  constructor(options: BybitHistoryReadClientOptions) {
    if (
      !options ||
      !options.transport ||
      typeof options.transport.get !== "function"
    )
      invalid();
    const maxPages =
      options.maxPagesPerWindow ?? DEFAULT_MAX_PAGES_PER_WINDOW;
    const maxRows = options.maxRowsPerWindow ?? MAX_ROWS_PER_WINDOW;
    if (
      !Number.isSafeInteger(maxPages) ||
      maxPages < 1 ||
      maxPages > DEFAULT_MAX_PAGES_PER_WINDOW ||
      !Number.isSafeInteger(maxRows) ||
      maxRows < 1 ||
      maxRows > MAX_ROWS_PER_WINDOW
    )
      invalid();
    this.transport = options.transport;
    this.clock = options.utcClock ?? Date.now;
    this.maxPagesPerWindow = maxPages;
    this.maxRowsPerWindow = maxRows;
  }

  async readPage(request: HistoryReadPageRequest): Promise<HistoryReadPage> {
    try {
      validateWindow(request.window);
      const cursor = validateCursor(request.cursor);
      const source = SOURCE_ROUTES[request.source];
      if (!source) invalid();
      const query: Record<string, string> = {
        ...(source.category ? { category: "linear" } : { accountType: "UNIFIED" }),
        startTime: String(request.window.fromMs),
        endTime: String(request.window.toMs),
        limit: String(source.limit),
        ...(cursor === undefined ? {} : { cursor }),
      };
      const response = await this.transport.get(source.path, query);
      const rowCount = validateListLength(response, source.limit);
      const nextCursor = validatePageCursor(response);
      const collectedAt = this.clock();
      if (!Number.isSafeInteger(collectedAt) || collectedAt <= 0) invalid();
      const facts = mapBybitHistoryResponse(
        request.source,
        response,
        collectedAt,
      );
      if (facts.length !== rowCount) invalid();
      return Object.freeze({
        source: request.source,
        window: Object.freeze({ ...request.window }),
        cursor: cursor ?? null,
        nextCursor,
        facts,
      });
    } catch (error) {
      return failure(error);
    }
  }

  async *readPages(
    request: Omit<HistoryReadPageRequest, "cursor">,
  ): AsyncIterable<HistoryReadPage> {
    validateWindow(request.window);
    let cursor: string | undefined;
    let pageCount = 0;
    let rowCount = 0;
    const seenNextCursors = new Set<string>();
    while (true) {
      if (pageCount >= this.maxPagesPerWindow)
        throw new BybitAccountReadError("PAGE_BUDGET_EXCEEDED");
      const page = await this.readPage({
        source: request.source,
        window: request.window,
        ...(cursor === undefined ? {} : { cursor }),
      });
      pageCount++;
      rowCount += page.facts.length;
      if (rowCount > this.maxRowsPerWindow)
        throw new BybitAccountReadError("ROW_BUDGET_EXCEEDED");
      if (page.nextCursor && seenNextCursors.has(page.nextCursor))
        throw new BybitAccountReadError("INVALID_RESPONSE");
      yield page;
      if (page.nextCursor === null) return;
      seenNextCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
  }
}
