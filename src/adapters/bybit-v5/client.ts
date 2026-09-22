import { isDecimalValue } from "../../domain/shared/decimal.js";
import type { Clock, UtcTimestamp } from "../../domain/shared/time.js";
import { systemClock, timestampFromEpochMs } from "../../domain/shared/time.js";
import type {
  ExchangeCancelOrderRequest,
  ExchangeSetLeverageRequest,
  ExchangeSetLeverageResult,
  ExchangeOrderLookup,
  ExchangeOrderAcknowledgement,
  ExchangeOrderRequest,
} from "../../ports/exchange-execution.js";
import {
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
  mapAccountKeyMetadata,
  mapExecutionRecords,
  mapOrderRecords,
  mapPosition,
  mapTicker,
  mapWalletBalance,
  nextPageCursor,
  responseRecords,
  type BybitInstrumentInfo,
  type BybitExecutionRecord,
  type BybitOrderRecord,
  type BybitPositionState,
  type BybitTicker,
  type BybitWalletState,
  type BybitAccountKeyMetadata,
} from "./read-mappers.js";

export const BYBIT_LINEAR_CATEGORY = "linear";
export const INSTRUMENTS_INFO_PATH = "/v5/market/instruments-info";
export const TICKERS_PATH = "/v5/market/tickers";
export const WALLET_BALANCE_PATH = "/v5/account/wallet-balance";
export const POSITION_LIST_PATH = "/v5/position/list";
export const ORDER_REALTIME_PATH = "/v5/order/realtime";
export const ORDER_HISTORY_PATH = "/v5/order/history";
export const EXECUTION_LIST_PATH = "/v5/execution/list";
export const USER_QUERY_API_PATH = "/v5/user/query-api";
export const SET_LEVERAGE_PATH = "/v5/position/set-leverage";

const DEFAULT_PAGE_SIZE = "50";
const DEFAULT_MAX_PAGES = 20;

export type BybitDemoReadTransport = Pick<
  BybitDemoTransport,
  "get" | "getServerTime"
>;

export interface BybitDemoWriteTransport extends BybitDemoReadTransport {
  post(
    path: string,
    body: Record<string, unknown> | string,
  ): Promise<BybitResponse>;
}

export interface BybitDemoReadClientOptions {
  readonly transport: BybitDemoReadTransport;
  readonly maxPages?: number;
  readonly expectedAccountId?: string;
}

export interface BybitDemoExecutionClientOptions extends BybitDemoReadClientOptions {
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
  readonly accountKey: BybitAccountKeyMetadata;
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
  private readonly expectedAccountId: string | undefined;

  constructor(options: BybitDemoReadClientOptions) {
    const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100) {
      throw new TypeError("maxPages must be a safe integer between 1 and 100");
    }
    this.transport = options.transport;
    this.maxPages = maxPages;
    this.expectedAccountId = options.expectedAccountId;
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

  async readAccountKeyMetadata(
    expectedAccountId = this.expectedAccountId,
  ): Promise<BybitAccountKeyMetadata> {
    if (expectedAccountId === undefined || expectedAccountId.length === 0) {
      precondition(
        "Bybit Demo account preflight requires an expected account identity.",
      );
    }
    return mapAccountKeyMetadata(
      await this.get(USER_QUERY_API_PATH, {}),
      expectedAccountId,
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
    precondition(
      "Bybit order/realtime pagination exceeded the bounded read budget.",
    );
  }

  async readRealtimeOrder(
    request: ExchangeOrderLookup,
  ): Promise<readonly BybitOrderRecord[]> {
    return this.readOrderRecords(
      ORDER_REALTIME_PATH,
      "order/realtime",
      request,
      { openOnly: "0" },
    );
  }

  async readOrderHistory(
    request: ExchangeOrderLookup,
  ): Promise<readonly BybitOrderRecord[]> {
    return this.readOrderRecords(ORDER_HISTORY_PATH, "order/history", request);
  }

  async readExecutions(
    request: ExchangeOrderLookup,
  ): Promise<readonly BybitExecutionRecord[]> {
    const records: BybitExecutionRecord[] = [];
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    for (let page = 0; page < this.maxPages; page += 1) {
      const query = this.lookupQuery(request, "50");
      if (cursor !== undefined) query.cursor = cursor;
      const response = await this.get(EXECUTION_LIST_PATH, query);
      records.push(...mapExecutionRecords(response, request.instrument));
      const next = nextPageCursor(response, "execution/list");
      if (next === undefined) return records;
      if (seenCursors.has(next)) {
        clientError("Bybit execution/list pagination repeated a cursor.");
      }
      seenCursors.add(next);
      cursor = next;
    }
    precondition(
      "Bybit execution/list pagination exceeded the bounded read budget.",
    );
  }

  async readAttachedProtectionOrders(
    instrument: string,
    parentClientOrderId: string,
  ): Promise<readonly BybitOrderRecord[]> {
    const records: BybitOrderRecord[] = [];
    for (const [path, label] of [
      [ORDER_REALTIME_PATH, "order/realtime"],
      [ORDER_HISTORY_PATH, "order/history"],
    ] as const) {
      records.push(
        ...(await this.readSymbolOrderRecords(path, label, instrument)),
      );
    }
    const byExchangeId = new Map<string, BybitOrderRecord>();
    for (const record of records) {
      const previous = byExchangeId.get(record.exchangeOrderId);
      if (
        previous !== undefined &&
        (previous.parentOrderLinkId !== record.parentOrderLinkId ||
          previous.status !== record.status ||
          previous.filledQuantity.compare(record.filledQuantity) !== 0)
      ) {
        precondition(
          "Bybit attached-protection reads returned contradictory order evidence.",
        );
      }
      byExchangeId.set(record.exchangeOrderId, record);
    }
    return [...byExchangeId.values()].filter(
      (record) => record.parentOrderLinkId === parentClientOrderId,
    );
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
      await this.assertEmptyFilteredRead(
        path,
        label,
        symbol,
        syntheticClientOrderId,
      );
    }
    return { realtime: true, history: true, executions: true };
  }

  async readPreflight(
    symbol: string,
    syntheticClientOrderId: string,
  ): Promise<BybitDemoPreflightRead> {
    const serverTime = await this.readServerTime();
    const accountKey = await this.readAccountKeyMetadata();
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
      accountKey,
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

  private async readOrderRecords(
    path: string,
    label: string,
    request: ExchangeOrderLookup,
    extra: Record<string, string> = {},
  ): Promise<readonly BybitOrderRecord[]> {
    const records: BybitOrderRecord[] = [];
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    for (let page = 0; page < this.maxPages; page += 1) {
      const query = this.lookupQuery(request, DEFAULT_PAGE_SIZE, extra);
      if (cursor !== undefined) query.cursor = cursor;
      const response = await this.get(path, query);
      records.push(...mapOrderRecords(response, request.instrument, label));
      const next = nextPageCursor(response, label);
      if (next === undefined) return records;
      if (seenCursors.has(next)) {
        clientError(`Bybit ${label} pagination repeated a cursor.`);
      }
      seenCursors.add(next);
      cursor = next;
    }
    precondition(`Bybit ${label} pagination exceeded the bounded read budget.`);
  }

  private async readSymbolOrderRecords(
    path: string,
    label: string,
    symbol: string,
  ): Promise<readonly BybitOrderRecord[]> {
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
      const response = await this.get(path, query);
      records.push(...mapOrderRecords(response, symbol, label));
      const next = nextPageCursor(response, label);
      if (next === undefined) return records;
      if (seenCursors.has(next)) {
        clientError(`Bybit ${label} pagination repeated a cursor.`);
      }
      seenCursors.add(next);
      cursor = next;
    }
    precondition(`Bybit ${label} pagination exceeded the bounded read budget.`);
  }

  private lookupQuery(
    request: ExchangeOrderLookup,
    limit: string,
    extra: Record<string, string> = {},
  ): Record<string, string> {
    return {
      category: BYBIT_LINEAR_CATEGORY,
      symbol: request.instrument,
      orderLinkId: request.clientOrderId,
      limit,
      ...(request.exchangeOrderId === undefined
        ? {}
        : { orderId: request.exchangeOrderId }),
      ...extra,
    };
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

  async setLeverage(
    request: ExchangeSetLeverageRequest,
  ): Promise<ExchangeSetLeverageResult> {
    if (!isDecimalValue(request.target) || !request.target.isPositive()) {
      precondition(
        "Demo leverage target must be a positive validated decimal.",
      );
    }
    const target = request.target.toString();
    await this.writeTransport.post(SET_LEVERAGE_PATH, {
      category: BYBIT_LINEAR_CATEGORY,
      symbol: request.instrument,
      buyLeverage: target,
      sellLeverage: target,
    });
    const readback = await this.readPosition(request.instrument);
    if (readback.leverage.compare(request.target) !== 0) {
      precondition(
        "Bybit Demo leverage readback did not prove the requested target.",
      );
    }
    return Object.freeze({
      instrument: request.instrument,
      target: request.target,
      effective: {
        buy: readback.leverage,
        sell: readback.leverage,
        effective: readback.leverage,
      },
      verifiedAt: this.clock.now(),
    });
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
