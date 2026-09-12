import {
  addDecimals,
  ceilRatioToStep,
  ceilToStep,
  compareDecimals,
  decimal,
  decimalIsPositive,
  floorToStep,
  multiplyByRational,
  multiplyDecimals,
  parseDecimal,
  subtractDecimals,
  toDecimalString,
  type Decimal,
} from "./decimal.js";
import type { QueryInput, BybitResponse } from "./transport.js";

const MAX_NOTIONAL = parseDecimal("10");
const BALANCE_MULTIPLIER = parseDecimal("5");
const DEFAULT_TICK_OFFSET = 2n;

export interface ReadOnlyTransport {
  get(path: string, query?: QueryInput): Promise<BybitResponse>;
}

export class PreflightError extends Error {
  readonly kind: "precondition-failed" | "invalid-response";
  readonly guidance: string;

  constructor(
    kind: PreflightError["kind"],
    message: string,
    guidance = "No exchange write was attempted.",
  ) {
    super(message);
    this.name = "PreflightError";
    this.kind = kind;
    this.guidance = guidance;
  }
}

export interface InstrumentFilters {
  readonly status: string;
  readonly tickSize: string;
  readonly qtyStep: string;
  readonly minOrderQty: string;
  readonly minNotionalValue: string;
}

export interface BookSnapshot {
  readonly bid: string;
  readonly ask: string;
}

export interface ProbeSize {
  readonly side: "Buy" | "Sell";
  readonly price: string;
  readonly qty: string;
  readonly notional: string;
  readonly takeProfit: string;
  readonly stopLoss: string;
}

export interface PreflightBaseline {
  readonly flat: true;
  readonly openOrders: number;
  readonly positionSize: string;
  readonly positionIdx: 0;
  readonly availableBalance: string;
  readonly exclusiveUseConfirmed: true;
}

export interface PreflightResult {
  readonly symbol: string;
  readonly category: string;
  readonly instrument: InstrumentFilters;
  readonly book: BookSnapshot;
  readonly baseline: PreflightBaseline;
  readonly sizes: Readonly<{ Buy: ProbeSize; Sell: ProbeSize }>;
  readonly requestPaths: readonly string[];
}

interface JsonObject {
  readonly [key: string]: unknown;
}

type ConfirmExclusiveUse = () => boolean | Promise<boolean>;

export interface PreflightOptions {
  readonly transport: ReadOnlyTransport;
  readonly symbol: string;
  readonly category?: string;
  readonly tickOffsetTicks?: bigint;
  readonly confirmExclusiveUse?: ConfirmExclusiveUse;
}

function asObject(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PreflightError(
      "invalid-response",
      `Bybit ${label} response has an invalid shape.`,
    );
  }
  return value as JsonObject;
}

function listFrom(
  response: BybitResponse,
  label: string,
): readonly JsonObject[] {
  const list = asObject(response.result, label).list;
  if (
    !Array.isArray(list) ||
    list.some(
      (item) =>
        typeof item !== "object" || item === null || Array.isArray(item),
    )
  ) {
    throw new PreflightError(
      "invalid-response",
      `Bybit ${label} response did not contain a validated list.`,
    );
  }
  return list as readonly JsonObject[];
}

function stringField(object: JsonObject, field: string, label: string): string {
  const value = object[field];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    /[\u0000-\u001f\u007f\r\n]/.test(value)
  ) {
    throw new PreflightError(
      "invalid-response",
      `Bybit ${label} response has an invalid ${field}.`,
    );
  }
  return value;
}

function decimalField(
  object: JsonObject,
  field: string,
  label: string,
): Decimal {
  try {
    const value = parseDecimal(stringField(object, field, label));
    if (!decimalIsPositive(value)) throw new Error("not positive");
    return value;
  } catch {
    throw new PreflightError(
      "invalid-response",
      `Bybit ${label} response has an invalid ${field}.`,
    );
  }
}

function nonNegativeDecimalField(
  object: JsonObject,
  field: string,
  label: string,
): Decimal {
  try {
    const value = parseDecimal(stringField(object, field, label));
    if (value.coefficient < 0n) throw new Error("negative");
    return value;
  } catch {
    throw new PreflightError(
      "invalid-response",
      `Bybit ${label} response has an invalid ${field}.`,
    );
  }
}

function firstListItem(response: BybitResponse, label: string): JsonObject {
  const list = listFrom(response, label);
  const item = list[0];
  if (!item)
    throw new PreflightError(
      "invalid-response",
      `Bybit ${label} response was empty.`,
    );
  return item;
}

function precondition(message: string, guidance?: string): PreflightError {
  return new PreflightError("precondition-failed", message, guidance);
}

function parseInstrument(response: BybitResponse): InstrumentFilters {
  const item = firstListItem(response, "instruments-info");
  const priceFilter = asObject(item.priceFilter, "instruments-info");
  const lotSizeFilter = asObject(item.lotSizeFilter, "instruments-info");
  const status = stringField(item, "status", "instruments-info");
  const tickSize = toDecimalString(
    decimalField(priceFilter, "tickSize", "instruments-info"),
  );
  const qtyStep = toDecimalString(
    decimalField(lotSizeFilter, "qtyStep", "instruments-info"),
  );
  const minOrderQty = toDecimalString(
    decimalField(lotSizeFilter, "minOrderQty", "instruments-info"),
  );
  const minNotionalRaw =
    lotSizeFilter.minNotionalValue ?? lotSizeFilter.minOrderAmt;
  if (typeof minNotionalRaw !== "string") {
    throw new PreflightError(
      "invalid-response",
      "Bybit instruments-info response has no minimum notional.",
    );
  }
  const minNotionalValue = toDecimalString(parseDecimal(minNotionalRaw));
  if (!decimalIsPositive(parseDecimal(minNotionalValue))) {
    throw new PreflightError(
      "invalid-response",
      "Bybit instruments-info response has an invalid minimum notional.",
    );
  }
  if (status !== "Trading") {
    throw precondition(
      `Configured instrument is ${status}, not Trading.`,
      "Choose an instrument whose Bybit status is Trading.",
    );
  }
  return { status, tickSize, qtyStep, minOrderQty, minNotionalValue };
}

function parseBook(response: BybitResponse): BookSnapshot {
  const item = firstListItem(response, "tickers");
  return {
    bid: toDecimalString(decimalField(item, "bid1Price", "tickers")),
    ask: toDecimalString(decimalField(item, "ask1Price", "tickers")),
  };
}

function parsePositionBaseline(response: BybitResponse): {
  size: string;
  positionIdx: 0;
} {
  const positions = listFrom(response, "position/list");
  let size = parseDecimal("0");
  for (const position of positions) {
    const positionIdxRaw = position.positionIdx;
    const positionIdx =
      typeof positionIdxRaw === "number"
        ? positionIdxRaw
        : typeof positionIdxRaw === "string" && /^\d+$/.test(positionIdxRaw)
          ? Number(positionIdxRaw)
          : -1;
    if (positionIdx !== 0) {
      throw precondition(
        "The configured account is not in one-way mode for this symbol.",
        "Switch the symbol to one-way mode in Bybit and rerun the probe; the probe never changes account configuration.",
      );
    }
    const currentSize = nonNegativeDecimalField(
      position,
      "size",
      "position/list",
    );
    const side = position.side;
    if (!decimalIsPositive(currentSize)) continue;
    if (side !== "" && side !== "None" && side !== undefined) {
      throw precondition(
        "The configured symbol has a non-flat position baseline.",
        "Close or reconcile existing symbol exposure outside the probe, then rerun.",
      );
    }
    size = addDecimals(size, currentSize);
  }
  if (decimalIsPositive(size)) {
    throw precondition(
      "The configured symbol has a non-flat position baseline.",
      "Close or reconcile existing symbol exposure outside the probe, then rerun.",
    );
  }
  return { size: "0", positionIdx: 0 };
}

function parseAvailableBalance(response: BybitResponse): Decimal {
  const item = firstListItem(response, "wallet-balance");
  const value = item.totalAvailableBalance ?? item.availableToWithdraw;
  if (typeof value !== "string") {
    throw new PreflightError(
      "invalid-response",
      "Bybit wallet-balance response has no available USDT balance.",
    );
  }
  try {
    return parseDecimal(value);
  } catch {
    throw new PreflightError(
      "invalid-response",
      "Bybit wallet-balance response has an invalid available USDT balance.",
    );
  }
}

function deriveSize(
  side: "Buy" | "Sell",
  book: BookSnapshot,
  filters: InstrumentFilters,
  tickOffsetTicks: bigint,
): ProbeSize {
  const tick = parseDecimal(filters.tickSize);
  const rawPrice =
    side === "Buy"
      ? subtractDecimals(
          parseDecimal(book.bid),
          multiplyDecimals(tick, decimal(tickOffsetTicks, 0)),
        )
      : addDecimals(
          parseDecimal(book.ask),
          multiplyDecimals(tick, decimal(tickOffsetTicks, 0)),
        );
  const price =
    side === "Buy" ? floorToStep(rawPrice, tick) : ceilToStep(rawPrice, tick);
  if (!decimalIsPositive(price))
    throw precondition(
      "The book cannot produce a positive PostOnly probe price.",
    );

  const minNotional = parseDecimal(filters.minNotionalValue);
  const minQty = parseDecimal(filters.minOrderQty);
  const qtyStep = parseDecimal(filters.qtyStep);
  const quantity = ceilToStep(
    compareDecimals(minQty, ceilRatioToStep(minNotional, price, qtyStep)) >= 0
      ? minQty
      : ceilRatioToStep(minNotional, price, qtyStep),
    qtyStep,
  );
  const notional = multiplyDecimals(price, quantity);
  if (compareDecimals(notional, MAX_NOTIONAL) > 0) {
    throw precondition(
      "The exchange minimum does not fit the 10 USDT probe cap.",
      "Choose a lower-minimum Testnet symbol; the probe will not increase the cap.",
    );
  }

  const profitableFactor =
    side === "Buy"
      ? multiplyByRational(price, 102n, 100n)
      : multiplyByRational(price, 98n, 100n);
  const adverseFactor =
    side === "Buy"
      ? multiplyByRational(price, 98n, 100n)
      : multiplyByRational(price, 102n, 100n);
  const takeProfit =
    side === "Buy"
      ? ceilToStep(profitableFactor, tick)
      : floorToStep(profitableFactor, tick);
  const stopLoss =
    side === "Buy"
      ? floorToStep(adverseFactor, tick)
      : ceilToStep(adverseFactor, tick);
  if (
    !decimalIsPositive(takeProfit) ||
    !decimalIsPositive(stopLoss) ||
    (side === "Buy" && compareDecimals(takeProfit, stopLoss) <= 0) ||
    (side === "Sell" && compareDecimals(takeProfit, stopLoss) >= 0)
  ) {
    throw precondition(
      "The derived protective levels are invalid for the current instrument filters.",
    );
  }
  return {
    side,
    price: toDecimalString(price),
    qty: toDecimalString(quantity),
    notional: toDecimalString(notional),
    takeProfit: toDecimalString(takeProfit),
    stopLoss: toDecimalString(stopLoss),
  };
}

export async function runReadOnlyPreflight(
  options: PreflightOptions,
): Promise<PreflightResult> {
  const category = options.category ?? "linear";
  const tickOffsetTicks = options.tickOffsetTicks ?? DEFAULT_TICK_OFFSET;
  const requestPaths: string[] = [];
  const get = async (
    path: string,
    query: QueryInput,
  ): Promise<BybitResponse> => {
    requestPaths.push(path);
    return options.transport.get(path, query);
  };

  const instrument = parseInstrument(
    await get("/v5/market/instruments-info", {
      category,
      symbol: options.symbol,
    }),
  );
  const book = parseBook(
    await get("/v5/market/tickers", { category, symbol: options.symbol }),
  );
  const position = parsePositionBaseline(
    await get("/v5/position/list", { category, symbol: options.symbol }),
  );
  const openOrders = listFrom(
    await get("/v5/order/realtime", {
      category,
      symbol: options.symbol,
      openOnly: "0",
      limit: "1",
    }),
    "order/realtime",
  );
  if (openOrders.length > 0) {
    throw precondition(
      "The configured symbol has existing open orders.",
      "Cancel or reconcile unrelated symbol orders outside the probe; the probe never bulk-cancels them.",
    );
  }

  const sizes = {
    Buy: deriveSize("Buy", book, instrument, tickOffsetTicks),
    Sell: deriveSize("Sell", book, instrument, tickOffsetTicks),
  } as const;
  const plannedNotional =
    compareDecimals(
      parseDecimal(sizes.Buy.notional),
      parseDecimal(sizes.Sell.notional),
    ) >= 0
      ? parseDecimal(sizes.Buy.notional)
      : parseDecimal(sizes.Sell.notional);
  const availableBalance = parseAvailableBalance(
    await get("/v5/account/wallet-balance", {
      accountType: "UNIFIED",
      coin: "USDT",
    }),
  );
  const requiredBalance = multiplyDecimals(plannedNotional, BALANCE_MULTIPLIER);
  if (compareDecimals(availableBalance, requiredBalance) < 0) {
    const availableBalanceText = toDecimalString(availableBalance);
    const requiredBalanceText = toDecimalString(requiredBalance);
    const shortfallText = toDecimalString(
      subtractDecimals(requiredBalance, availableBalance),
    );
    throw precondition(
      `Available Testnet USDT is ${availableBalanceText}; at least ${requiredBalanceText} USDT is required (five times the planned probe notional). Add at least ${shortfallText} USDT using the Bybit Testnet faucet, then rerun the probe.`,
      `Add at least ${shortfallText} USDT using the Bybit Testnet faucet, then rerun the read-only preflight.`,
    );
  }

  const confirmExclusiveUse = options.confirmExclusiveUse;
  const confirmed =
    confirmExclusiveUse === undefined ? false : await confirmExclusiveUse();
  if (!confirmed) {
    throw precondition(
      "exclusive account/symbol use was not confirmed for the run.",
      "Reserve the configured Testnet account and symbol against other clients and rerun.",
    );
  }
  return {
    symbol: options.symbol,
    category,
    instrument,
    book,
    baseline: {
      flat: true,
      openOrders: 0,
      positionSize: position.size,
      positionIdx: 0,
      availableBalance: toDecimalString(availableBalance),
      exclusiveUseConfirmed: true,
    },
    sizes,
    requestPaths,
  };
}

export const runPreflight = runReadOnlyPreflight;
