import { DecimalValue } from "../../domain/shared/decimal.js";
import type { LiquidationEvidenceDiagnosticInput } from "../../domain/liquidation/liquidation-evidence-bundle.js";
import { isCoinalyzeRecord } from "./coinalyze-response.js";
import type {
  CoinalyzeLiquidationObservation,
  CoinalyzeMarket,
  CoinalyzeMarketHistory,
} from "./coinalyze-response.js";

export interface CoinalyzeCatalogueMapping {
  readonly markets: readonly CoinalyzeMarket[];
  readonly complete: boolean;
  readonly diagnostics: readonly LiquidationEvidenceDiagnosticInput[];
}

export interface CoinalyzeHistoryMapping {
  readonly histories: readonly CoinalyzeMarketHistory[];
  readonly responseValid: boolean;
  readonly diagnostics: readonly LiquidationEvidenceDiagnosticInput[];
}

function diagnostic(
  code: LiquidationEvidenceDiagnosticInput["code"],
  operation: LiquidationEvidenceDiagnosticInput["operation"],
  providerSymbol?: string,
  bucketTimestamp?: string,
): LiquidationEvidenceDiagnosticInput {
  return Object.freeze({
    code,
    operation,
    ...(providerSymbol === undefined ? {} : { providerSymbol }),
    ...(bucketTimestamp === undefined ? {} : { bucketTimestamp }),
  });
}

function providerText(value: unknown, maxLength = 128): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return undefined;
  }
  return value.normalize("NFC");
}

function decimalText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = DecimalValue.fromString(value);
  if (!parsed.ok || parsed.value.isNegative()) return undefined;
  return parsed.value.toString();
}

function unixSeconds(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d+$/u.test(value)) return undefined;
  const seconds = Number(value);
  if (
    !Number.isSafeInteger(seconds) ||
    seconds < 0 ||
    seconds * 1_000 > 8_640_000_000_000_000
  ) {
    return undefined;
  }
  return seconds;
}

function marketFromRow(value: unknown): CoinalyzeMarket | undefined {
  if (!isCoinalyzeRecord(value)) return undefined;
  const symbol = providerText(value.symbol);
  const exchange = providerText(value.exchange, 64);
  const symbolOnExchange = providerText(value.symbol_on_exchange);
  const baseAsset = providerText(value.base_asset, 64);
  const quoteAsset = providerText(value.quote_asset, 64);
  const marginType = providerText(value.margined, 64);
  const expireAt = unixSeconds(value.expire_at);
  const notionalDenominatedIn = providerText(
    value.oi_lq_vol_denominated_in,
    64,
  );
  if (
    symbol === undefined ||
    exchange === undefined ||
    symbolOnExchange === undefined ||
    baseAsset === undefined ||
    quoteAsset === undefined ||
    marginType === undefined ||
    expireAt === undefined ||
    notionalDenominatedIn === undefined ||
    typeof value.is_perpetual !== "boolean"
  ) {
    return undefined;
  }
  return Object.freeze({
    symbol,
    exchange,
    symbolOnExchange,
    baseAsset,
    quoteAsset,
    isPerpetual: value.is_perpetual,
    marginType,
    expireAt,
    notionalDenominatedIn,
  });
}

function contractKey(market: CoinalyzeMarket): string {
  return JSON.stringify([
    market.exchange,
    market.symbolOnExchange,
    market.baseAsset,
    market.quoteAsset,
    market.marginType,
    market.expireAt,
  ]);
}

function sameMarket(left: CoinalyzeMarket, right: CoinalyzeMarket): boolean {
  return (
    left.symbol === right.symbol &&
    left.exchange === right.exchange &&
    left.symbolOnExchange === right.symbolOnExchange &&
    left.baseAsset === right.baseAsset &&
    left.quoteAsset === right.quoteAsset &&
    left.isPerpetual === right.isPerpetual &&
    left.marginType === right.marginType &&
    left.expireAt === right.expireAt &&
    left.notionalDenominatedIn === right.notionalDenominatedIn
  );
}

export function mapCoinalyzeFutureMarkets(
  payload: unknown,
): CoinalyzeCatalogueMapping {
  const diagnostics: LiquidationEvidenceDiagnosticInput[] = [];
  if (!Array.isArray(payload)) {
    return Object.freeze({
      markets: Object.freeze([]),
      complete: false,
      diagnostics: Object.freeze([
        diagnostic("invalid-catalogue", "discover-markets"),
      ]),
    });
  }

  let complete = true;
  const bySymbol = new Map<string, CoinalyzeMarket>();
  const byContract = new Map<string, CoinalyzeMarket>();
  const blockedSymbols = new Set<string>();
  const blockedContracts = new Set<string>();

  for (const row of payload) {
    const market = marketFromRow(row);
    if (market === undefined) {
      complete = false;
      diagnostics.push(diagnostic("invalid-catalogue", "discover-markets"));
      continue;
    }
    const key = contractKey(market);
    if (blockedSymbols.has(market.symbol) || blockedContracts.has(key)) {
      complete = false;
      continue;
    }
    const previousBySymbol = bySymbol.get(market.symbol);
    const previousByContract = byContract.get(key);
    if (previousBySymbol !== undefined || previousByContract !== undefined) {
      complete = false;
      diagnostics.push(
        diagnostic("duplicate-market", "discover-markets", market.symbol),
      );
      const previous = previousBySymbol ?? previousByContract;
      if (previous !== undefined && sameMarket(previous, market)) continue;

      if (previousBySymbol !== undefined) {
        bySymbol.delete(previousBySymbol.symbol);
        byContract.delete(contractKey(previousBySymbol));
        blockedSymbols.add(previousBySymbol.symbol);
        blockedContracts.add(contractKey(previousBySymbol));
      }
      if (previousByContract !== undefined) {
        bySymbol.delete(previousByContract.symbol);
        byContract.delete(contractKey(previousByContract));
        blockedSymbols.add(previousByContract.symbol);
        blockedContracts.add(contractKey(previousByContract));
      }
      blockedSymbols.add(market.symbol);
      blockedContracts.add(key);
      continue;
    }
    bySymbol.set(market.symbol, market);
    byContract.set(key, market);
  }

  const markets = [...bySymbol.values()].sort((left, right) =>
    left.symbol.localeCompare(right.symbol),
  );
  return Object.freeze({
    markets: Object.freeze(markets),
    complete,
    diagnostics: Object.freeze(diagnostics),
  });
}

function historyObservation(
  value: unknown,
  from: number,
  to: number,
): CoinalyzeLiquidationObservation | undefined {
  if (!isCoinalyzeRecord(value)) return undefined;
  const seconds = unixSeconds(value.t);
  const longUsd = decimalText(value.l);
  const shortUsd = decimalText(value.s);
  if (
    seconds === undefined ||
    seconds < from ||
    seconds > to ||
    longUsd === undefined ||
    shortUsd === undefined
  ) {
    return undefined;
  }
  return Object.freeze({
    timestamp: new Date(seconds * 1_000).toISOString(),
    longUsd,
    shortUsd,
  });
}

function sameObservation(
  left: CoinalyzeLiquidationObservation,
  right: CoinalyzeLiquidationObservation,
): boolean {
  return (
    left.timestamp === right.timestamp &&
    left.longUsd === right.longUsd &&
    left.shortUsd === right.shortUsd
  );
}

export function mapCoinalyzeLiquidationHistory(
  payload: unknown,
  requestedSymbols: readonly string[],
  from: number,
  to: number,
): CoinalyzeHistoryMapping {
  const diagnostics: LiquidationEvidenceDiagnosticInput[] = [];
  const requested = new Set(requestedSymbols);
  if (
    !Array.isArray(payload) ||
    requested.size !== requestedSymbols.length ||
    requestedSymbols.length === 0 ||
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    from < 0 ||
    to < from
  ) {
    return Object.freeze({
      histories: Object.freeze([]),
      responseValid: false,
      diagnostics: Object.freeze([
        diagnostic("invalid-observation", "fetch-liquidation-history"),
      ]),
    });
  }

  let complete = true;
  const histories = new Map<string, CoinalyzeMarketHistory>();
  const conflictedSymbols = new Set<string>();
  for (const row of payload) {
    if (!isCoinalyzeRecord(row)) {
      complete = false;
      diagnostics.push(
        diagnostic("invalid-observation", "fetch-liquidation-history"),
      );
      continue;
    }
    const symbol = providerText(row.symbol);
    if (symbol === undefined || !requested.has(symbol)) {
      complete = false;
      diagnostics.push(
        diagnostic("invalid-observation", "fetch-liquidation-history"),
      );
      continue;
    }
    if (conflictedSymbols.has(symbol)) continue;
    if (histories.has(symbol)) {
      complete = false;
      diagnostics.push(
        diagnostic("invalid-observation", "fetch-liquidation-history", symbol),
      );
      histories.delete(symbol);
      conflictedSymbols.add(symbol);
      continue;
    }
    if (!Array.isArray(row.history)) {
      complete = false;
      diagnostics.push(
        diagnostic("invalid-observation", "fetch-liquidation-history", symbol),
      );
      histories.set(
        symbol,
        Object.freeze({ symbol, observations: Object.freeze([]) }),
      );
      continue;
    }

    const byTimestamp = new Map<string, CoinalyzeLiquidationObservation>();
    const conflictedBuckets = new Set<string>();
    let previousTimestamp = -1;
    for (const rawObservation of row.history) {
      const observation = historyObservation(rawObservation, from, to);
      if (observation === undefined) {
        complete = false;
        diagnostics.push(
          diagnostic(
            "invalid-observation",
            "fetch-liquidation-history",
            symbol,
          ),
        );
        continue;
      }
      const epoch = Date.parse(observation.timestamp);
      if (epoch <= previousTimestamp) {
        complete = false;
        diagnostics.push(
          diagnostic(
            "invalid-observation",
            "fetch-liquidation-history",
            symbol,
            observation.timestamp,
          ),
        );
      }
      previousTimestamp = epoch;

      if (conflictedBuckets.has(observation.timestamp)) continue;
      const previous = byTimestamp.get(observation.timestamp);
      if (previous !== undefined) {
        complete = false;
        diagnostics.push(
          diagnostic(
            "invalid-observation",
            "fetch-liquidation-history",
            symbol,
            observation.timestamp,
          ),
        );
        if (!sameObservation(previous, observation)) {
          byTimestamp.delete(observation.timestamp);
          conflictedBuckets.add(observation.timestamp);
        }
        continue;
      }
      byTimestamp.set(observation.timestamp, observation);
    }
    const observations = [...byTimestamp.values()].sort(
      (left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp),
    );
    histories.set(
      symbol,
      Object.freeze({ symbol, observations: Object.freeze(observations) }),
    );
  }

  for (const symbol of requestedSymbols) {
    if (histories.has(symbol)) continue;
    complete = false;
    diagnostics.push(
      diagnostic("history-unavailable", "fetch-liquidation-history", symbol),
    );
    histories.set(
      symbol,
      Object.freeze({ symbol, observations: Object.freeze([]) }),
    );
  }

  return Object.freeze({
    histories: Object.freeze(
      requestedSymbols
        .map((symbol) => histories.get(symbol))
        .filter(
          (history): history is CoinalyzeMarketHistory => history !== undefined,
        ),
    ),
    responseValid: complete,
    diagnostics: Object.freeze(diagnostics),
  });
}
