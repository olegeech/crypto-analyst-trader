import {
  type MarketDiscoveryInstrument,
  type MarketDiscoverySnapshot,
  type MarketDiscoveryTicker,
} from "../../domain/market/market-discovery.js";
import { DecimalValue } from "../../domain/shared/decimal.js";
import { timestampFromEpochMs } from "../../domain/shared/time.js";
import {
  DEFAULT_PUBLIC_PAGE_BUDGET,
  nextCursorFromResponse,
  readCursorPages,
  type PublicPaginationBudget,
} from "./public-market-pagination.js";
import {
  responseList,
  responseServerTimeMs,
  type BybitPublicResponse,
} from "./public-response.js";
import type { BybitPublicTransport } from "./public-transport.js";

type JsonObject = Record<string, unknown>;
type MarketDiscoveryTransport = Pick<BybitPublicTransport, "get">;

const BYBIT_LINEAR_CATEGORY = "linear";
const PUBLIC_INSTRUMENTS_INFO_PATH = "/v5/market/instruments-info";
const PUBLIC_TICKERS_PATH = "/v5/market/tickers";

export interface MarketDiscoveryReaderOptions {
  readonly transport: MarketDiscoveryTransport;
  readonly symbol?: string;
  readonly pagination?: PublicPaginationBudget;
}

function requiredLinearCategory(
  response: BybitPublicResponse,
  label: string,
): void {
  if (response.result.category !== BYBIT_LINEAR_CATEGORY) {
    throw new Error(`Bybit ${label} response did not confirm linear category.`);
  }
}

function responseRecords(
  response: BybitPublicResponse,
  label: string,
): readonly JsonObject[] {
  const list = responseList(response);
  if (list === undefined) {
    throw new Error(`Bybit ${label} response did not contain a valid list.`);
  }
  return list;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    !/[\u0000-\u001f\u007f\r\n]/u.test(value)
    ? value
    : undefined;
}

function optionalDecimal(value: unknown): DecimalValue | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = DecimalValue.fromString(value);
  return parsed.ok ? parsed.value : undefined;
}

function mapInstrument(record: JsonObject): MarketDiscoveryInstrument {
  const symbol = optionalText(record.symbol);
  const status = optionalText(record.status);
  const contractType = optionalText(record.contractType);
  const quoteCoin = optionalText(record.quoteCoin);
  const settleCoin = optionalText(record.settleCoin);
  return {
    ...(symbol === undefined ? {} : { symbol }),
    ...(status === undefined ? {} : { status }),
    ...(contractType === undefined ? {} : { contractType }),
    ...(quoteCoin === undefined ? {} : { quoteCoin }),
    ...(settleCoin === undefined ? {} : { settleCoin }),
  };
}

function mapTicker(record: JsonObject): MarketDiscoveryTicker {
  const symbol = optionalText(record.symbol);
  const turnover24h = optionalDecimal(record.turnover24h);
  const bid = optionalDecimal(record.bid1Price);
  const ask = optionalDecimal(record.ask1Price);
  const priceChange24h = optionalDecimal(record.price24hPcnt);
  const highPrice24h = optionalDecimal(record.highPrice24h);
  const lowPrice24h = optionalDecimal(record.lowPrice24h);
  return {
    ...(symbol === undefined ? {} : { symbol }),
    ...(turnover24h === undefined ? {} : { turnover24h }),
    ...(bid === undefined ? {} : { bid }),
    ...(ask === undefined ? {} : { ask }),
    ...(priceChange24h === undefined ? {} : { priceChange24h }),
    ...(highPrice24h === undefined ? {} : { highPrice24h }),
    ...(lowPrice24h === undefined ? {} : { lowPrice24h }),
  };
}

/** Reads paginated linear instruments and one timestamped bulk ticker response. */
export async function readMarketDiscoverySnapshot({
  transport,
  symbol,
  pagination = DEFAULT_PUBLIC_PAGE_BUDGET,
}: MarketDiscoveryReaderOptions): Promise<MarketDiscoverySnapshot> {
  let requestCount = 0;
  const instruments = await readCursorPages({
    label: "market-discovery-instruments",
    budget: pagination,
    read: async (cursor) => {
      const response = await transport.get(PUBLIC_INSTRUMENTS_INFO_PATH, {
        category: BYBIT_LINEAR_CATEGORY,
        limit: "1000",
        ...(symbol === undefined ? {} : { symbol }),
        ...(cursor === undefined ? {} : { cursor }),
      });
      requestCount += 1;
      requiredLinearCategory(response, "instruments-info");
      const nextCursor = nextCursorFromResponse(response, "instruments-info");
      return {
        rows: responseRecords(response, "instruments-info").map(mapInstrument),
        ...(nextCursor === undefined ? {} : { nextCursor }),
      };
    },
  });

  const tickerResponse = await transport.get(PUBLIC_TICKERS_PATH, {
    category: BYBIT_LINEAR_CATEGORY,
    ...(symbol === undefined ? {} : { symbol }),
  });
  requestCount += 1;
  requiredLinearCategory(tickerResponse, "tickers");
  const epochMs = responseServerTimeMs(tickerResponse);
  if (epochMs === undefined) {
    throw new Error(
      "Bybit bulk ticker response did not contain a valid timestamp.",
    );
  }
  const asOf = timestampFromEpochMs(epochMs);
  if (!asOf.ok) {
    throw new Error("Bybit bulk ticker response timestamp was invalid.");
  }

  const tickers = responseRecords(tickerResponse, "tickers").map(mapTicker);
  if (symbol === undefined && instruments.length > 0 && tickers.length === 0) {
    throw new Error(
      "Bybit bulk ticker response was empty while instrument metadata was nonempty.",
    );
  }

  return Object.freeze({
    asOf: asOf.value,
    instruments,
    tickers: Object.freeze(tickers),
    requestCount,
  });
}
