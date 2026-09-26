import assert from "node:assert/strict";
import test from "node:test";

import {
  mapCoinalyzeFutureMarkets,
  mapCoinalyzeLiquidationHistory,
} from "../src/adapters/coinalyze/coinalyze-mappers.js";
import { parseCoinalyzeJson } from "../src/adapters/coinalyze/coinalyze-response.js";

function market(overrides: Record<string, unknown> = {}) {
  return {
    symbol: "BTCUSDT_PERP.BINANCE",
    exchange: "BINANCE",
    symbol_on_exchange: "BTCUSDT",
    base_asset: "BTC",
    quote_asset: "USDT",
    is_perpetual: true,
    margined: "STABLE",
    expire_at: "0",
    oi_lq_vol_denominated_in: "USD",
    has_ohlcv_data: true,
    ...overrides,
  };
}

test("maps the complete unpaginated catalogue without requiring a liquidation capability flag", () => {
  const mapped = mapCoinalyzeFutureMarkets([
    market(),
    market({
      symbol: "BTCUSD_PERP.BYBIT",
      exchange: "BYBIT",
      symbol_on_exchange: "BTCUSD",
      quote_asset: "USD",
      margined: "COIN",
      oi_lq_vol_denominated_in: "BASE_ASSET",
    }),
    market({
      symbol: "BTCUSDT.OLD",
      is_perpetual: false,
      expire_at: "1700000000",
    }),
  ]);

  assert.equal(mapped.complete, true);
  assert.equal(mapped.markets.length, 3);
  assert.equal(mapped.diagnostics.length, 0);
  const binance = mapped.markets.find(
    ({ symbol }) => symbol === "BTCUSDT_PERP.BINANCE",
  );
  assert.equal(binance?.expireAt, 0);
  assert.equal(binance?.notionalDenominatedIn, "USD");
  assert.equal(binance?.isPerpetual, true);
});

test("invalid rows make coverage incomplete while preserving every trustworthy row", () => {
  const mapped = mapCoinalyzeFutureMarkets([
    market(),
    market({ symbol: "ETHUSDT_PERP.BINANCE", base_asset: "ETH" }),
    { symbol: "malformed" },
  ]);

  assert.equal(mapped.complete, false);
  assert.deepEqual(
    mapped.markets.map(({ symbol }) => symbol),
    ["BTCUSDT_PERP.BINANCE", "ETHUSDT_PERP.BINANCE"],
  );
  assert.equal(mapped.diagnostics[0]?.code, "invalid-catalogue");
});

test("duplicate identities never become complete and contradictory identities are not first-match-wins", () => {
  const identical = mapCoinalyzeFutureMarkets([market(), market()]);
  assert.equal(identical.complete, false);
  assert.equal(identical.markets.length, 1);
  assert.equal(identical.diagnostics[0]?.code, "duplicate-market");

  const contradictory = mapCoinalyzeFutureMarkets([
    market(),
    market({ exchange: "OTHER", symbol_on_exchange: "BTCUSDT-OTHER" }),
    market({ symbol: "ETHUSDT_PERP.BINANCE", base_asset: "ETH" }),
  ]);
  assert.equal(contradictory.complete, false);
  assert.deepEqual(
    contradictory.markets.map(({ symbol }) => symbol),
    ["ETHUSDT_PERP.BINANCE"],
  );
});

test("non-array future catalogue shape fails closed without inventing continuation semantics", () => {
  const mapped = mapCoinalyzeFutureMarkets({
    data: [market()],
    next_cursor: "unrecognized",
  });

  assert.equal(mapped.complete, false);
  assert.deepEqual(mapped.markets, []);
  assert.equal(mapped.diagnostics[0]?.code, "invalid-catalogue");
});

test("maps ascending exact USD history and preserves omitted buckets without zero fill", () => {
  const payload = parseCoinalyzeJson(
    '[{"symbol":"BTCUSDT_PERP.BINANCE","history":[{"t":1790000000,"l":0,"s":0.00000000000000001},{"t":1790003600,"l":1.25,"s":2}]}]',
  );
  const mapped = mapCoinalyzeLiquidationHistory(
    payload,
    ["BTCUSDT_PERP.BINANCE"],
    1_790_000_000,
    1_790_003_600,
  );

  assert.equal(mapped.responseValid, true);
  assert.deepEqual(mapped.histories[0]?.observations, [
    {
      timestamp: new Date(1_790_000_000_000).toISOString(),
      longUsd: "0",
      shortUsd: "0.00000000000000001",
    },
    {
      timestamp: new Date(1_790_003_600_000).toISOString(),
      longUsd: "1.25",
      shortUsd: "2",
    },
  ]);
  assert.equal(mapped.histories[0]?.observations.length, 2);
});

test("valid empty history stays empty; missing symbols and malformed observations stay incomplete", () => {
  const mapped = mapCoinalyzeLiquidationHistory(
    [
      { symbol: "BTCUSDT_PERP.BINANCE", history: [] },
      {
        symbol: "ETHUSDT_PERP.BINANCE",
        history: [{ t: "1790000000", l: "1", s: "-1" }],
      },
    ],
    ["BTCUSDT_PERP.BINANCE", "ETHUSDT_PERP.BINANCE", "SOLUSDT_PERP.BINANCE"],
    1_790_000_000,
    1_790_003_600,
  );

  assert.equal(mapped.responseValid, false);
  assert.deepEqual(
    mapped.histories.map((history) => [
      history.symbol,
      history.observations.length,
    ]),
    [
      ["BTCUSDT_PERP.BINANCE", 0],
      ["ETHUSDT_PERP.BINANCE", 0],
      ["SOLUSDT_PERP.BINANCE", 0],
    ],
  );
  assert.ok(
    mapped.diagnostics.some(({ code }) => code === "invalid-observation"),
  );
  assert.ok(
    mapped.diagnostics.some(({ code }) => code === "history-unavailable"),
  );
});

test("out-of-order, duplicate, contradictory and out-of-window observations are diagnosed", () => {
  const mapped = mapCoinalyzeLiquidationHistory(
    [
      {
        symbol: "BTCUSDT_PERP.BINANCE",
        history: [
          { t: "1790003600", l: "1", s: "2" },
          { t: "1790000000", l: "3", s: "4" },
          { t: "1790000000", l: "5", s: "6" },
          { t: "1790007200", l: "1", s: "1" },
        ],
      },
    ],
    ["BTCUSDT_PERP.BINANCE"],
    1_790_000_000,
    1_790_003_600,
  );

  assert.equal(mapped.responseValid, false);
  assert.deepEqual(
    mapped.histories[0]?.observations.map(({ timestamp }) => timestamp),
    [new Date(1_790_003_600_000).toISOString()],
  );
  assert.ok(mapped.diagnostics.length >= 3);
});

test("duplicate provider symbols remove the ambiguous history rather than selecting the first row", () => {
  const mapped = mapCoinalyzeLiquidationHistory(
    [
      {
        symbol: "BTCUSDT_PERP.BINANCE",
        history: [{ t: "1790000000", l: "1", s: "2" }],
      },
      {
        symbol: "BTCUSDT_PERP.BINANCE",
        history: [{ t: "1790000000", l: "1", s: "2" }],
      },
    ],
    ["BTCUSDT_PERP.BINANCE"],
    1_790_000_000,
    1_790_000_000,
  );

  assert.equal(mapped.responseValid, false);
  assert.equal(mapped.histories[0]?.observations.length, 0);
});
