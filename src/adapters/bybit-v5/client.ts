import type { Clock, UtcTimestamp } from "../../domain/shared/time.js";
import { systemClock, timestampFromEpochMs } from "../../domain/shared/time.js";
import type {
  ExchangeCancelOrderRequest,
  ExchangeOrderAcknowledgement,
  ExchangeOrderRequest,
} from "../../ports/exchange-execution.js";
import {
  BYBIT_DEMO_TIME_PATH,
  type BybitResponse,
  type QueryInput,
  type BybitDemoTransport,
} from "./transport.js";
import {
  CANCEL_ORDER_PATH,
  CREATE_ORDER_PATH,
  mapCancelOrderRequest,
  mapCreateOrderRequest,
  mapOrderAcknowledgement,
} from "./order-mappers.js";
import {
  BybitReadMappingError,
  mapInstrumentInfo,
  mapOrderRecords,
  mapPosition,
  mapTicker,
  mapWalletBalance,
  nextPageCursor,
  responseRecords,
  type BybitInstrumentInfo,
  type BybitOrderRecord,
  type BybitPositionState,
  type BybitTicker,
  type BybitWalletState,
} from "./read-mappers.js";

export const BYBIT_LINEAR_CATEGORY = "linear";
export const INSTRUMENTS_INFO_PATH = "/v5/market/instruments-info";
export const TICKERS_PATH = "/v5/market/tickers";
export const WALLET_BALANCE_PATH = "/v5/account/wallet-balance";
export const POSITION_LIST_PATH = "/v5/position/list";
export const ORDER_REALTIME_PATH = "/v5/order/realtime";
export const ORDER_HISTORY_PATH = "/v5/order/history";
export const EXECUTION_LIST_PATH = "/v5/execution/list";

const DEFAULT_PAGE_SIZE = "50";
const DEFAULT_MAX_PAGES = 20;

export interface BybitDemoReadTransport
  extends Pick<BybitDemoTransport, "get" | "getServerTime"> {}

export interface BybitDemoWriteTransport extends BybitDemoReadTransport {
  post(
    path: string,
    body: Record<string, unknown> | string,
  ): Promise<BybitResponse>;
}

export interface BybitDemoReadClientOptions {
  readonly transport: BybitDemoReadTransport;
  readonly maxPages?: number;
}

export interface BybitDemoExecutionClientOptions
  extends BybitDemoReadClientOptions {
  readonly transport: BybitDemoWriteTransport;
  readonly clock?: Clock;
}

export interface ReconciliationReadCapabilities {
  readonly realtime: true;
  readonly history: true;
  readonly executions: true;
}

export interface BybitDemoPreflightRead {
  readonly serverTime: UtcTimestamp;
  readonly instrument: BybitInstrumentInfo;
  readonly ticker: BybitTicker;
  readonly wallet: BybitWalletState;
  readonly position: BybitPositionState;
  readonly openOrders: readonly BybitOrderRecord[];
  readonly reconciliationReads: ReconciliationReadCapabilities;
}

function clientError(message: string): never {
  throw new BybitReadMappingError("invalid-response", message);
}

function precondition(message: string): never {
  throw new BybitReadMappingError("precondition", message);
}

export class BybitDemoReadClient {
  private readonly transport: BybitDemoReadTransport;
  private readonly maxPages: number;

  constructor(options: BybitDemoReadClientOptions) {
    const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    if (
      !Number.isSafeInteger(maxPages) ||
      maxPages < 1 ||
      maxPages > 100
    ) {
      throw new TypeError("maxPages must be a safe integer between 1 and 100");
    }
    this.transport = options.transport;
    this.maxPages = maxPages;
  }

  async readServerTime(): Promise<UtcTimestamp> {
    const epoch = await this.transport.getServerTime();
    const timestamp = timestampFromEpochMs(epoch);
    if (!timestamp.ok) {
      clientError("Bybit Demo returned an invalid server timestamp.");
    }
    return timestamp.value;
  }

  async readInstrument(symbol: string): Promise<BybitInstrumentInfo> {
    return mapInstrumentInfo(
      await this.get(INSTRUMENTS_INFO_PATH, {
        category: BYBIT_LINEAR_CATEGORY,
        symbol,
      }),
      symbol,
    );
  }

  async readTicker(symbol: string): Promise<BybitTicker> {
    return mapTicker(
      await this.get(TICKERS_PATH, {
        category: BYBIT_LINEAR_CATEGORY,
        symbol,
      }),
      symbol,
    );
  }

  async readWalletBalance(): Promise<BybitWalletState> {
    return mapWalletBalance(
      await this.get(WALLET_BALANCE_PATH, {
        accountType: "UNIFIED",
        coin: "USDT",
      }),
    );
  }

  async readPosition(symbol: string): Promise<BybitPositionState> {
    return mapPosition(
      await this.get(POSITION_LIST_PATH, {
        category: BYBIT_LINEAR_CATEGORY,
        symbol,
      }),
      symbol,
    );
  }

  async readOpenOrders(symbol: string): Promise<readonly BybitOrderRecord[]> {
    const records: BybitOrderRecord[] = [];
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    for (let page = 0; page < this.maxPages; page += 1) {
      const query: Record<string, string> = {
        category: BYBIT_LINEAR_CATEGORY,
        symbol,
        openOnly: "0",
        limit: DEFAULT_PAGE_SIZE,
      };
      if (cursor !== undefined) query.cursor = cursor;
      const response = await this.get(ORDER_REALTIME_PATH, query);
      records.push(...mapOrderRecords(response, symbol, "order/realtime"));
      const next = nextPageCursor(response, "order/realtime");
      if (next === undefined) return records;
      if (seenCursors.has(next)) {
        clientError("Bybit order/realtime pagination repeated a cursor.");
      }
      seenCursors.add(next);
      cursor = next;
    }
    precondition("Bybit order/realtime pagination exceeded the bounded read budget.");
  }

  /**
   * Proves that the selected Demo account honors exact ownership filters on
   * every read later used to reconcile a write. The synthetic ID must be
   * caller-owned and must not have been submitted to the exchange.
   */
  async verifyReconciliationReads(
    symbol: string,
    syntheticClientOrderId: string,
  ): Promise<ReconciliationReadCapabilities> {
    for (const [path, label] of [
      [ORDER_REALTIME_PATH, "order/realtime"],
      [ORDER_HISTORY_PATH, "order/history"],
      [EXECUTION_LIST_PATH, "execution/list"],
    ] as const) {
      await this.assertEmptyFilteredRead(path, label, symbol, syntheticClientOrderId);
    }
    return { realtime: true, history: true, executions: true };
  }

  async readPreflight(
    symbol: string,
    syntheticClientOrderId: string,
  ): Promise<BybitDemoPreflightRead> {
    const serverTime = await this.readServerTime();
    const instrument = await this.readInstrument(symbol);
    const ticker = await this.readTicker(symbol);
    const position = await this.readPosition(symbol);
    const openOrders = await this.readOpenOrders(symbol);
    const reconciliationReads = await this.verifyReconciliationReads(
      symbol,
      syntheticClientOrderId,
    );
    const wallet = await this.readWalletBalance();
    return {
      serverTime,
      instrument,
      ticker,
      wallet,
      position,
      openOrders,
      reconciliationReads,
    };
  }

  private async assertEmptyFilteredRead(
    path: string,
    label: string,
    symbol: string,
    syntheticClientOrderId: string,
  ): Promise<void> {
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    for (let page = 0; page < this.maxPages; page += 1) {
      const query: Record<string, string> = {
        category: BYBIT_LINEAR_CATEGORY,
        symbol,
        orderLinkId: syntheticClientOrderId,
        limit: "1",
      };
      if (cursor !== undefined) query.cursor = cursor;
      const response = await this.get(path, query);
      if (responseRecords(response, label).length > 0) {
        clientError(
          `Bybit Demo ${label} did not honor the synthetic ownership filter; no write is allowed.`,
        );
      }
      const next = nextPageCursor(response, label);
      if (next === undefined) return;
      if (seenCursors.has(next)) {
        clientError(`Bybit ${label} pagination repeated a cursor.`);
      }
      seenCursors.add(next);
      cursor = next;
    }
    precondition(`Bybit ${label} pagination exceeded the bounded read budget.`);
  }

  private get(path: string, query: QueryInput): Promise<BybitResponse> {
    return this.transport.get(path, query);
  }
}

export class BybitDemoExecutionClient extends BybitDemoReadClient {
  private readonly writeTransport: BybitDemoWriteTransport;
  private readonly clock: Clock;

  constructor(options: BybitDemoExecutionClientOptions) {
    super(options);
    this.writeTransport = options.transport;
    this.clock = options.clock ?? systemClock;
  }

  async createOrder(
    request: ExchangeOrderRequest,
  ): Promise<ExchangeOrderAcknowledgement> {
    const body = mapCreateOrderRequest(request);
    const response = await this.writeTransport.post(CREATE_ORDER_PATH, body);
    return mapOrderAcknowledgement(
      response,
      request.clientOrderId,
      this.clock.now(),
    );
  }

  async cancelOrder(
    request: ExchangeCancelOrderRequest,
  ): Promise<ExchangeOrderAcknowledgement> {
    const body = mapCancelOrderRequest(request);
    const response = await this.writeTransport.post(CANCEL_ORDER_PATH, body);
    return mapOrderAcknowledgement(
      response,
      request.clientOrderId,
      this.clock.now(),
    );
  }
}

export function requireCleanExposureBaseline(
  read: Pick<BybitDemoPreflightRead, "position" | "openOrders">,
): void {
  if (read.position.side !== "flat" || !read.position.quantity.isZero()) {
    precondition(
      "The selected Demo symbol is not flat; no exposure-increasing write is allowed.",
    );
  }
  if (read.openOrders.length !== 0) {
    precondition(
      "The selected Demo symbol has pre-existing open orders; no exposure-increasing write is allowed.",
    );
  }
}
