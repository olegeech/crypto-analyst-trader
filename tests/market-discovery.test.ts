import assert from "node:assert/strict";
import test from "node:test";

import {
  estimateMarketDiscoveryBuyCost,
  rankMarketDiscovery,
} from "../src/domain/market/market-discovery.js";
import type {
  MarketDiscoveryInstrument,
  MarketDiscoveryOrderbook,
  MarketDiscoverySnapshot,
  MarketDiscoveryTicker,
} from "../src/domain/market/market-discovery.js";
import { DecimalValue } from "../src/domain/shared/decimal.js";
import type { UtcTimestamp } from "../src/domain/shared/time.js";

const AS_OF = "2026-11-15T08:00:00.000Z" as UtcTimestamp;

function decimal(value: string): DecimalValue {
  const parsed = DecimalValue.fromString(value);
  if (!parsed.ok) throw new Error(`invalid test decimal: ${value}`);
  return parsed.value;
}

function instrument(
  symbol: string,
  overrides: Partial<MarketDiscoveryInstrument> = {},
): MarketDiscoveryInstrument {
  return {
    symbol,
    status: "Trading",
    contractType: "LinearPerpetual",
    quoteCoin: "USDT",
    settleCoin: "USDT",
    ...overrides,
  };
}

function ticker(
  symbol: string,
  overrides: Partial<MarketDiscoveryTicker> = {},
): MarketDiscoveryTicker {
  return {
    symbol,
    turnover24h: decimal("1000"),
    bid: decimal("100"),
    ask: decimal("101"),
    ...overrides,
  };
}

function snapshot(
  instruments: readonly MarketDiscoveryInstrument[],
  tickers: readonly MarketDiscoveryTicker[],
): MarketDiscoverySnapshot {
  return { asOf: AS_OF, instruments, tickers, requestCount: 2 };
}

test("discovery ranks by turnover, breaks exact ties by spread and symbol, and returns five", () => {
  const instruments = [
    instrument("AUSDT"),
    instrument("CUSDT"),
    instrument("BUSDT"),
    instrument("DUSDT"),
    instrument("EUSDT"),
    instrument("FUSDT"),
  ];
  const tickers = [
    ticker("AUSDT", { turnover24h: decimal("300"), ask: decimal("102") }),
    ticker("BUSDT", { turnover24h: decimal("200"), ask: decimal("101") }),
    ticker("CUSDT", { turnover24h: decimal("200"), ask: decimal("101") }),
    ticker("DUSDT", { turnover24h: decimal("100"), ask: decimal("100.1") }),
    ticker("EUSDT", {
      turnover24h: decimal("200"),
      bid: decimal("1000"),
      ask: decimal("1002"),
    }),
    ticker("FUSDT", { turnover24h: decimal("50"), ask: decimal("100.01") }),
  ];
  const rank = (items: typeof instruments, quotes: typeof tickers) =>
    rankMarketDiscovery(snapshot(items, quotes));
  const result = rank(instruments, tickers);
  const reverse = rank([...instruments].reverse(), [...tickers].reverse());

  assert.equal(result.status, "READY");
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.symbol),
    ["AUSDT", "EUSDT", "BUSDT", "CUSDT", "DUSDT"],
  );
  assert.equal(result.eligibleCount, 6);
  assert.equal(result.candidates.length, 5);
  assert.deepEqual(
    reverse.candidates.map((candidate) => candidate.symbol),
    result.candidates.map((candidate) => candidate.symbol),
  );
  assert.equal(
    result.candidates[2]?.relativeSpread.toString(),
    "0.009950248756218905",
  );
  assert.match(result.candidates[0]?.reasons.join(" ") ?? "", /turnover/u);
});

test("targeted symbol can be inspected outside the default top five", () => {
  const symbols = [
    "HIGH1USDT",
    "HIGH2USDT",
    "HIGH3USDT",
    "HIGH4USDT",
    "HIGH5USDT",
    "HIGH6USDT",
    "OUTSIDEUSDT",
  ];
  const data = snapshot(
    symbols.map((symbol) => instrument(symbol)),
    symbols.map((symbol, index) =>
      ticker(symbol, { turnover24h: decimal(String(1000 - index)) }),
    ),
  );

  const topFive = rankMarketDiscovery(data);
  const targeted = rankMarketDiscovery(data, { symbol: "OUTSIDEUSDT" });

  assert.deepEqual(
    topFive.candidates.map((candidate) => candidate.symbol),
    symbols.slice(0, 5),
  );
  assert.deepEqual(
    targeted.candidates.map((candidate) => candidate.symbol),
    ["OUTSIDEUSDT"],
  );
  assert.equal(targeted.target?.candidate?.symbol, "OUTSIDEUSDT");
});

test("targeted ineligible symbol reports its exclusion reason", () => {
  const result = rankMarketDiscovery(
    snapshot(
      [instrument("HALTEDUSDT", { status: "Settling" })],
      [ticker("HALTEDUSDT")],
    ),
    { symbol: "HALTEDUSDT" },
  );

  assert.equal(result.status, "NO_CANDIDATES");
  assert.equal(result.target?.candidate, undefined);
  assert.deepEqual(result.target?.reasons, ["INSTRUMENT_NOT_TRADING"]);
});

test("result limit returns the requested number when enough candidates are eligible", () => {
  const symbols = Array.from({ length: 10 }, (_, index) => `M${index}USDT`);
  const data = snapshot(
    symbols.map((symbol) => instrument(symbol)),
    symbols.map((symbol, index) =>
      ticker(symbol, { turnover24h: decimal(String(1000 - index)) }),
    ),
  );

  const result = rankMarketDiscovery(data, { resultLimit: 8 });

  assert.equal(result.eligibleCount, 10);
  assert.equal(result.candidates.length, 8);
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.symbol),
    symbols.slice(0, 8),
  );
});

test("result limit must be an integer from 1 to 100", () => {
  const data = snapshot([instrument("AUSDT")], [ticker("AUSDT")]);

  for (const resultLimit of [0, 101, 1.5]) {
    assert.throws(
      () => rankMarketDiscovery(data, { resultLimit }),
      /resultLimit must be an integer from 1 to 100/u,
    );
  }
});

test("ineligible instruments and unusable quotes are excluded with reason counts", () => {
  const completeMissingQuote = ticker("MISSINGQUOTEUSDT");
  const { ask: _ask, ...missingQuote } = completeMissingQuote;
  void _ask;
  const result = rankMarketDiscovery(
    snapshot(
      [
        instrument("HALTEDUSDT", { status: "Settling" }),
        instrument("FUTUREUSDT", { contractType: "LinearFutures" }),
        instrument("WRONGQUOTEUSDT", { quoteCoin: "USDC" }),
        instrument("WRONGSETTLEUSDT", { settleCoin: "USDC" }),
        instrument("ZEROUSDT"),
        instrument("CROSSEDUSDT"),
        instrument("MISSINGQUOTEUSDT"),
        instrument("MISSINGUSDT"),
      ],
      [
        ticker("ZEROUSDT", { turnover24h: decimal("0") }),
        ticker("CROSSEDUSDT", {
          bid: decimal("101"),
          ask: decimal("100"),
        }),
        missingQuote,
      ],
    ),
  );

  assert.equal(result.status, "NO_CANDIDATES");
  assert.equal(result.exclusionCounts.INSTRUMENT_NOT_TRADING, 1);
  assert.equal(result.exclusionCounts.NOT_LINEAR_PERPETUAL, 1);
  assert.equal(result.exclusionCounts.NON_USDT_QUOTE, 1);
  assert.equal(result.exclusionCounts.NON_USDT_SETTLEMENT, 1);
  assert.equal(result.exclusionCounts.NON_POSITIVE_TURNOVER, 1);
  assert.equal(result.exclusionCounts.CROSSED_QUOTES, 1);
  assert.equal(result.exclusionCounts.MISSING_QUOTES, 1);
  assert.equal(result.exclusionCounts.MISSING_TICKER, 1);
});

test("negative 24h context and missing optional history do not affect eligibility", () => {
  const result = rankMarketDiscovery(
    snapshot(
      [instrument("DOWNUSDT"), instrument("UNKNOWNUSDT")],
      [
        ticker("DOWNUSDT", { priceChange24h: decimal("-0.05") }),
        ticker("UNKNOWNUSDT"),
      ],
    ),
  );

  assert.deepEqual(
    result.candidates.map((candidate) => candidate.symbol),
    ["DOWNUSDT", "UNKNOWNUSDT"],
  );
  assert.equal(result.candidates[0]?.priceChange24h?.toString(), "-0.05");
  assert.equal(result.candidates[1]?.priceChange24h, undefined);
});

test("known exposures are grouped before the result limit with the turnover leader retained", () => {
  const bases = ["XAU", "PAXG", "XAUT", "BTC", "BTC", "ETH"];
  const symbols = [
    "XAUUSDT",
    "PAXGUSDT",
    "XAUTUSDT",
    "BTCUSDT",
    "BTCALTUSDT",
    "ETHUSDT",
  ];
  const data = snapshot(
    symbols.map((symbol, i) => instrument(symbol, { baseCoin: bases[i]! })),
    symbols.map((symbol, i) =>
      ticker(symbol, { turnover24h: decimal(String(1000 - i)) }),
    ),
  );
  for (const instruments of [
    data.instruments,
    [...data.instruments].reverse(),
  ]) {
    const result = rankMarketDiscovery(
      { ...data, instruments },
      { resultLimit: 3 },
    );
    assert.deepEqual(
      result.candidates.map((row) => row.symbol),
      ["XAUUSDT", "BTCUSDT", "ETHUSDT"],
    );
    assert.equal(result.duplicateCount, 3);
    assert.equal(result.candidates[0]?.exposureGroup, "GOLD");
    assert.match(result.representativeRule, /turnover/u);
  }
  const targeted = rankMarketDiscovery(data, { symbol: "XAUTUSDT" });
  assert.equal(targeted.target?.candidate?.symbol, "XAUTUSDT");
});

test("unverified pairs and unknown base coins stay distinct", () => {
  const bases = ["SKHYNIX", "SKHY", "MU", "MUU", "QQQ", "TQQQ", "SOXL", "SOXS"];
  const symbols = bases.map((base) => `${base}USDT`);
  const result = rankMarketDiscovery(
    snapshot(
      symbols.map((symbol, i) => instrument(symbol, { baseCoin: bases[i]! })),
      symbols.map((symbol) => ticker(symbol)),
    ),
    { resultLimit: 100 },
  );
  assert.equal(result.candidates.length, 8);
  assert.equal(result.duplicateCount, 0);
  const unknown = rankMarketDiscovery(
    snapshot(
      [
        instrument("AUSDT", { baseCoin: "bad base" }),
        instrument("BUSDT", { baseCoin: "bad base" }),
      ],
      [ticker("AUSDT"), ticker("BUSDT")],
    ),
  );
  assert.equal(unknown.candidates.length, 2);
});

test("recognized reference markets warn only on usual weekends", () => {
  const data = snapshot(
    [
      instrument("XAUUSDT", { baseCoin: "XAU" }),
      instrument("QQQUSDT", { baseCoin: "QQQ", symbolType: "ETF" }),
      instrument("BTCUSDT", { baseCoin: "BTC" }),
    ],
    [ticker("XAUUSDT"), ticker("QQQUSDT"), ticker("BTCUSDT")],
  );
  const weekend = rankMarketDiscovery(data);
  for (const row of weekend.candidates)
    assert.equal(
      row.referenceSession,
      row.symbol === "BTCUSDT"
        ? "session unknown"
        : "possible reference closure (usual weekend)",
    );
  const weekday = rankMarketDiscovery({
    ...data,
    asOf: "2026-11-18T08:00:00.000Z" as UtcTimestamp,
  });
  assert.ok(
    weekday.candidates.every(
      (row) => row.referenceSession === "session unknown",
    ),
  );
});

function orderbook(
  asks: readonly (readonly [string, string])[],
  bids: readonly (readonly [string, string])[] = [["9", "10"]],
): MarketDiscoveryOrderbook {
  return {
    asOf: AS_OF,
    asks: asks.map(([price, size]) => [decimal(price), decimal(size)]),
    bids: bids.map(([price, size]) => [decimal(price), decimal(size)]),
  };
}

test("100-USDT buy cost sweeps asks and measures VWAP relative to the book midpoint", () => {
  const estimate = estimateMarketDiscoveryBuyCost(
    orderbook([
      ["11", "5"],
      ["15", "10"],
    ]),
  );
  assert.equal(estimate.status, "available");
  if (estimate.status !== "available") return;
  assert.equal(estimate.availableAskNotional.toString(), "205");
  // Spend 55 at 11 and 45 at 15, acquiring 8 units. VWAP 12.5 / mid 10.
  assert.equal(estimate.estimatedBuyCostBps.toString(), "2500");
  assert.equal(estimate.asOf, AS_OF);
});

test("book diagnostics distinguish insufficient depth from invalid quotes and levels", () => {
  const insufficient = estimateMarketDiscoveryBuyCost(orderbook([["11", "9"]]));
  assert.equal(insufficient.status, "insufficient");
  if (insufficient.status !== "insufficient") return;
  assert.equal(insufficient.availableAskNotional.toString(), "99");
  assert.equal(insufficient.asOf, AS_OF);
  for (const book of [
    orderbook([], []),
    orderbook([["11", "100"]], []),
    orderbook([["11", "0"]]),
    orderbook([["11", "-1"]]),
    orderbook([["0", "100"]]),
    orderbook([
      ["11", "100"],
      ["10", "100"],
    ]),
    orderbook([["11", "100"]], [["12", "1"]]),
    orderbook(
      [["11", "100"]],
      [
        ["9", "1"],
        ["10", "1"],
      ],
    ),
  ])
    assert.deepEqual(estimateMarketDiscoveryBuyCost(book), {
      status: "unavailable",
    });
});
