import type {
  HistoryReadPage,
  HistoryReadPageRequest,
  HistoryReadPort,
  HistoryReadSource,
  HistoryReadWindow,
} from "../../ports/history-read.js";
import { HISTORY_READ_LIMITS } from "../../ports/history-read.js";
import {
  BybitAccountReadError,
  type AccountReadResponse,
} from "./account-read-transport.js";
import { mapBybitHistoryResponse } from "./history-read-mappers.js";

const SOURCE_ROUTES: Readonly<
  Record<
    HistoryReadSource,
    {
      readonly path: string;
      readonly limit: number;
      readonly category: boolean;
    }
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
    window.toMs - window.fromMs > HISTORY_READ_LIMITS.maxWindowMs
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

  constructor(options: BybitHistoryReadClientOptions) {
    if (
      !options ||
      !options.transport ||
      typeof options.transport.get !== "function"
    )
      invalid();
    this.transport = options.transport;
    this.clock = options.utcClock ?? Date.now;
  }

  async readPage(request: HistoryReadPageRequest): Promise<HistoryReadPage> {
    try {
      validateWindow(request.window);
      const cursor = validateCursor(request.cursor);
      if (!Object.hasOwn(SOURCE_ROUTES, request.source)) invalid();
      const source = SOURCE_ROUTES[request.source];
      const query: Record<string, string> = {
        ...(source.category
          ? { category: "linear" }
          : { accountType: "UNIFIED" }),
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
      return Object.freeze({
        source: request.source,
        window: Object.freeze({ ...request.window }),
        cursor: cursor ?? null,
        nextCursor,
        receivedRowCount: rowCount,
        facts,
      });
    } catch (error) {
      return failure(error);
    }
  }
}
