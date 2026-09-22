import { type BybitPublicTransport } from "./public-transport.js";
import type { BybitPublicResponse } from "./public-response.js";
import {
  BybitPublicMarketMappingError,
  mapFundingHistory,
  mapInstrumentInfo,
  mapKline,
  mapOpenInterest,
  mapTicker,
  sortChronological,
} from "./public-market-mappers.js";
import {
  DEFAULT_PUBLIC_PAGE_BUDGET,
  assertPublicPaginationBudget,
  nextCursorFromResponse,
  readCursorPages,
  type PublicPaginationBudget,
} from "./public-market-pagination.js";
import {
  type FundingObservation,
  type MarketEvidenceSymbol,
  type MarketInstrumentEvidence,
  type MarketSeriesInterval,
  type MarketTickerEvidence,
  type OhlcvObservation,
  type OpenInterestInterval,
  type OpenInterestObservation,
} from "../../domain/market/market-evidence-bundle.js";
import {
  timestampFromEpochMs,
  type UtcTimestamp,
} from "../../domain/shared/time.js";

export const BYBIT_LINEAR_CATEGORY = "linear" as const;
export const PUBLIC_INSTRUMENTS_INFO_PATH = "/v5/market/instruments-info";
export const PUBLIC_TICKERS_PATH = "/v5/market/tickers";
export const PUBLIC_KLINE_PATH = "/v5/market/kline";
export const PUBLIC_FUNDING_HISTORY_PATH = "/v5/market/funding/history";
export const PUBLIC_OPEN_INTEREST_PATH = "/v5/market/open-interest";

const BYBIT_INTERVAL: Readonly<Record<MarketSeriesInterval, string>> = {
  "1h": "60",
  "4h": "240",
  "1d": "D",
  "1w": "W",
};

export type BybitPublicMarketTransport = Pick<
  BybitPublicTransport,
  "get" | "getExchangeTime"
>;

export interface BybitPublicMarketClientOptions {
  readonly transport: BybitPublicMarketTransport;
  readonly pagination?: PublicPaginationBudget;
}

export class BybitPublicMarketClient {
  private readonly transport: BybitPublicMarketTransport;
  private readonly pagination: PublicPaginationBudget;

  constructor(options: BybitPublicMarketClientOptions) {
    this.transport = options.transport;
    this.pagination = assertPublicPaginationBudget(
      options.pagination ?? DEFAULT_PUBLIC_PAGE_BUDGET,
    );
  }

  async readExchangeTime(): Promise<UtcTimestamp> {
    const epoch = await this.transport.getExchangeTime();
    const parsed = timestampFromEpochMs(epoch);
    if (!parsed.ok) {
      throw new BybitPublicMarketMappingError(
        "invalid-response",
        "Bybit public exchange time was invalid.",
      );
    }
    return parsed.value;
  }

  async readInstrument(
    symbol: MarketEvidenceSymbol,
  ): Promise<MarketInstrumentEvidence> {
    const response = await this.transport.get(PUBLIC_INSTRUMENTS_INFO_PATH, {
      category: BYBIT_LINEAR_CATEGORY,
      symbol,
    });
    return mapInstrumentInfo(response, symbol);
  }

  async readTicker(
    symbol: MarketEvidenceSymbol,
  ): Promise<MarketTickerEvidence> {
    const response = await this.transport.get(PUBLIC_TICKERS_PATH, {
      category: BYBIT_LINEAR_CATEGORY,
      symbol,
    });
    return mapTicker(response, symbol);
  }

  async readOhlcv(
    symbol: MarketEvidenceSymbol,
    interval: MarketSeriesInterval,
    requestedCount: number,
    exchangeTime: UtcTimestamp,
  ): Promise<readonly OhlcvObservation[]> {
    const target = validateRequestedCount(requestedCount, "OHLCV");
    const limit = Math.min(target + 1, 1_000);
    return this.readTimePaged({
      label: `kline-${interval}`,
      target,
      limit,
      request: (endTime) =>
        this.transport.get(PUBLIC_KLINE_PATH, {
          category: BYBIT_LINEAR_CATEGORY,
          symbol,
          interval: BYBIT_INTERVAL[interval],
          limit: String(limit),
          ...(endTime === undefined ? {} : { end: String(endTime) }),
        }),
      map: (response) => mapKline(response, symbol, interval, exchangeTime),
    });
  }

  async readFunding(
    symbol: MarketEvidenceSymbol,
    requestedCount: number,
  ): Promise<readonly FundingObservation[]> {
    const target = validateRequestedCount(requestedCount, "funding");
    const limit = Math.min(target + 1, 200);
    return this.readTimePaged({
      label: "funding-rate",
      target,
      limit,
      request: (endTime) =>
        this.transport.get(PUBLIC_FUNDING_HISTORY_PATH, {
          category: BYBIT_LINEAR_CATEGORY,
          symbol,
          limit: String(limit),
          ...(endTime === undefined ? {} : { endTime: String(endTime) }),
        }),
      map: (response) => mapFundingHistory(response, symbol),
    });
  }

  async readOpenInterest(
    symbol: MarketEvidenceSymbol,
    interval: OpenInterestInterval,
    requestedCount: number,
  ): Promise<readonly OpenInterestObservation[]> {
    const target = validateRequestedCount(requestedCount, "open-interest");
    const limit = Math.min(target + 1, 200);
    const rows = await readCursorPages<OpenInterestObservation>({
      label: `open-interest-${interval}`,
      budget: this.pagination,
      minRows: target,
      read: async (cursor) => {
        const response = await this.transport.get(PUBLIC_OPEN_INTEREST_PATH, {
          category: BYBIT_LINEAR_CATEGORY,
          symbol,
          intervalTime: interval,
          limit: String(limit),
          ...(cursor === undefined ? {} : { cursor }),
        });
        const next = nextCursorFromResponse(
          response,
          `open-interest-${interval}`,
        );
        return {
          rows: mapOpenInterest(response, symbol, interval),
          ...(next === undefined ? {} : { nextCursor: next }),
        };
      },
    });
    return sortChronological(rows, `open-interest-${interval}`);
  }

  private async readTimePaged<T extends { timestamp: UtcTimestamp }>({
    label,
    target,
    limit,
    request,
    map,
  }: {
    readonly label: string;
    readonly target: number;
    readonly limit: number;
    readonly request: (endTime?: number) => Promise<BybitPublicResponse>;
    readonly map: (response: BybitPublicResponse) => readonly T[];
  }): Promise<readonly T[]> {
    const rows: T[] = [];
    const seenTimestamps = new Set<string>();
    let endTime: number | undefined;
    for (let page = 0; page < this.pagination.maxPages; page += 1) {
      const response = await request(endTime);
      const mapped = map(response);
      for (const row of mapped) {
        if (seenTimestamps.has(row.timestamp)) {
          throw new BybitPublicMarketMappingError(
            "pagination",
            `Bybit ${label} pagination returned a duplicate timestamp.`,
          );
        }
        seenTimestamps.add(row.timestamp);
        rows.push(row);
      }
      if (rows.length > this.pagination.maxRows) {
        throw new BybitPublicMarketMappingError(
          "pagination",
          `Bybit ${label} row budget was exhausted.`,
        );
      }
      const sorted = sortChronological(rows, label);
      if (sorted.length >= target || mapped.length < limit) {
        return Object.freeze([...sorted]);
      }
      const oldest = sorted[0];
      if (oldest === undefined) {
        return Object.freeze([...sorted]);
      }
      endTime = Date.parse(oldest.timestamp) - 1;
      if (!Number.isSafeInteger(endTime) || endTime < 0) {
        return Object.freeze([...sorted]);
      }
    }
    throw new BybitPublicMarketMappingError(
      "pagination",
      `Bybit ${label} page budget was exhausted.`,
    );
  }
}

function validateRequestedCount(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 5_000) {
    throw new TypeError(`${label} requested count must be between 1 and 5000`);
  }
  return value;
}
