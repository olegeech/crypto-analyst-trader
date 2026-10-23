import assert from "node:assert/strict";
import test from "node:test";
import { createBybitPublicTransport } from "../src/adapters/bybit-v5/public-transport.js";
import { createOperatorMainnetTestPlan } from "../src/domain/execution/operator-mainnet-test-plan.js";

import type { BybitPublicResponse } from "../src/adapters/bybit-v5/public-response.js";
import {
  BybitPublicMarketMappingError,
  mapFundingHistory,
  mapInstrumentInfo,
  mapKline,
  mapOpenInterest,
  mapTicker,
} from "../src/adapters/bybit-v5/public-market-mappers.js";
import type { UtcTimestamp } from "../src/domain/shared/time.js";
import {
  BybitPublicMarketClient,
  PUBLIC_TICKERS_PATH,
} from "../src/adapters/bybit-v5/public-market-client.js";

function response(
  result: Record<string, unknown>,
  time = 1_722_535_200_000,
): BybitPublicResponse {
  return { retCode: 0, retMsg: "OK", result, time };
}

function instrumentResponse(
  overrides: Record<string, unknown> = {},
): BybitPublicResponse {
  return response({
    list: [
      {
        symbol: "DOGEUSDT",
        status: "Trading",
        baseCoin: "DOGE",
        contractType: "LinearPerpetual",
        quoteCoin: "USDT",
        settleCoin: "USDT",
        fundingInterval: "480",
        priceFilter: {
          tickSize: "0.0001",
          minPrice: "0.0001",
          maxPrice: "100",
        },
        lotSizeFilter: {
          qtyStep: "1",
          minOrderQty: "1",
          minNotionalValue: "5",
          maxOrderQty: "100000",
          maxMktOrderQty: "1000",
        },
        ...overrides,
      },
    ],
  });
}

test("public mappings validate instrument identity, funding interval and ticker envelope time", () => {
  const instrument = mapInstrumentInfo(instrumentResponse(), "DOGEUSDT");
  assert.equal(instrument.status, "trading");
  assert.equal(instrument.fundingInterval, 480);
  assert.equal(instrument.constraints.priceTickSize.toString(), "0.0001");
  assert.equal(instrument.constraints.version, "bybit-v5:public-instrument/v2");
  assert.equal(instrument.constraints.minPrice?.toString(), "0.0001");
  assert.equal(instrument.constraints.maxPrice?.toString(), "100");
  assert.equal(instrument.constraints.maxLimitQuantity?.toString(), "100000");

  const ticker = mapTicker(
    response({
      list: [
        {
          symbol: "DOGEUSDT",
          bid1Price: "0.0886",
          ask1Price: "0.0887",
          lastPrice: "0.08865",
          markPrice: "0.08864",
          indexPrice: "0.08863",
          fundingRate: "-0.0001",
          openInterest: "1000",
          volume24h: "2000",
          turnover24h: "176000",
        },
      ],
    }),
    "DOGEUSDT",
  );
  assert.equal(ticker.observedAt, "2024-08-01T18:00:00.000Z");
  assert.equal(ticker.fundingRate?.toString(), "-0.0001");
});

test("ticker mapping rejects contradictory returned scope and unusable best books", () => {
  const ticker = {
    symbol: "DOGEUSDT",
    bid1Price: "1",
    ask1Price: "2",
    lastPrice: "1.5",
  };
  for (const invalid of [
    response({ category: "spot", list: [ticker] }),
    response({ symbol: "BTCUSDT", list: [ticker] }),
    response({ list: [{ ...ticker, bid1Price: "0" }] }),
    response({ list: [{ ...ticker, bid1Price: "2", ask1Price: "1.9" }] }),
  ]) {
    assert.throws(
      () => mapTicker(invalid, "DOGEUSDT"),
      (error: unknown) =>
        error instanceof BybitPublicMarketMappingError &&
        (error.kind === "precondition" || error.kind === "invalid-response"),
    );
  }
});

test("public mappings normalize reverse kline ordering and exclude only after cutoff normalization", () => {
  const cutoff = "2024-08-01T19:30:00.000Z";
  const mapped = mapKline(
    response({
      symbol: "DOGEUSDT",
      category: "linear",
      list: [
        ["1722535200000", "101", "102", "100", "101.5", "20", "2030"],
        ["1722531600000", "99", "101", "98", "100", "10", "1000"],
        ["1722538800000", "100", "103", "99", "102", "15", "1500"],
      ],
    }),
    "DOGEUSDT",
    "1h",
    cutoff as UtcTimestamp,
  );
  assert.deepEqual(
    mapped.map((row) => row.timestamp),
    [
      "2024-08-01T17:00:00.000Z",
      "2024-08-01T18:00:00.000Z",
      "2024-08-01T19:00:00.000Z",
    ],
  );
  assert.deepEqual(
    mapped.map((row) => row.closed),
    [true, true, false],
  );
  assert.equal(mapped[0]?.close.toString(), "100");
});

test("kline mapping rejects a response for another symbol or category", () => {
  const row = ["1722535200000", "101", "102", "100", "101.5", "20", "2030"];
  assert.throws(
    () =>
      mapKline(
        response({ symbol: "BTCUSDT", category: "linear", list: [row] }),
        "DOGEUSDT",
        "1h",
        "2024-08-01T19:30:00.000Z" as UtcTimestamp,
      ),
    (error: unknown) =>
      error instanceof BybitPublicMarketMappingError &&
      error.kind === "precondition",
  );
  assert.throws(
    () =>
      mapKline(
        response({ symbol: "DOGEUSDT", category: "spot", list: [row] }),
        "DOGEUSDT",
        "1h",
        "2024-08-01T19:30:00.000Z" as UtcTimestamp,
      ),
    (error: unknown) =>
      error instanceof BybitPublicMarketMappingError &&
      error.kind === "precondition",
  );
});

test("funding and open-interest mappings reject wrong identity, duplicates and malformed fields", () => {
  assert.throws(
    () =>
      mapFundingHistory(
        response({
          symbol: "DOGEUSDT",
          list: [
            {
              symbol: "BTCUSDT",
              fundingRate: "0.001",
              fundingRateTimestamp: "1722531600000",
            },
          ],
        }),
        "DOGEUSDT",
      ),
    (error: unknown) =>
      error instanceof BybitPublicMarketMappingError &&
      error.kind === "precondition",
  );
  assert.throws(
    () =>
      mapOpenInterest(
        response({
          symbol: "DOGEUSDT",
          list: [
            {
              symbol: "DOGEUSDT",
              timestamp: "1722531600000",
              openInterest: "1",
            },
            {
              symbol: "DOGEUSDT",
              timestamp: "1722531600000",
              openInterest: "1",
            },
          ],
        }),
        "DOGEUSDT",
        "1h",
      ),
    (error: unknown) =>
      error instanceof BybitPublicMarketMappingError &&
      error.kind === "precondition",
  );
  assert.throws(
    () =>
      mapTicker({ retCode: 0, retMsg: "OK", result: { list: [] } }, "DOGEUSDT"),
    (error: unknown) =>
      error instanceof BybitPublicMarketMappingError &&
      error.kind === "missing-data",
  );
  assert.throws(
    () =>
      mapTicker(
        {
          retCode: 0,
          retMsg: "OK",
          result: {
            list: [
              {
                symbol: "DOGEUSDT",
                bid1Price: "1",
                ask1Price: "2",
                lastPrice: "1",
              },
            ],
          },
        },
        "DOGEUSDT",
      ),
    (error: unknown) =>
      error instanceof BybitPublicMarketMappingError &&
      error.kind === "missing-data",
  );
});

test("operator quote client binds the linear ticker to Bybit mainnet and provider-time bounds", async () => {
  const exchangeTimes = [
    Date.parse("2026-10-22T10:00:00.000Z"),
    Date.parse("2026-10-22T10:00:00.020Z"),
  ];
  const requests: Array<{ path: string; query: Record<string, string> }> = [];
  const client = new BybitPublicMarketClient({
    transport: {
      async get(path, query) {
        requests.push({ path, query: query as Record<string, string> });
        return response(
          {
            list: [
              {
                symbol: "DOGEUSDT",
                bid1Price: "0.0886",
                ask1Price: "0.0887",
                lastPrice: "0.08865",
              },
            ],
          },
          Date.parse("2026-10-22T10:00:00.010Z"),
        );
      },
      async getExchangeTime() {
        const next = exchangeTimes.shift();
        if (next === undefined) throw new Error("unexpected time read");
        return next;
      },
    },
  });

  const quote = await client.readOperatorQuote("DOGEUSDT");
  assert.deepEqual(requests, [
    {
      path: PUBLIC_TICKERS_PATH,
      query: { category: "linear", symbol: "DOGEUSDT" },
    },
  ]);
  assert.equal(quote.schemaVersion, "bybit-linear-operator-quote/v1");
  assert.equal(quote.exchange, "bybit");
  assert.equal(quote.environment, "mainnet");
  assert.equal(quote.category, "linear");
  assert.equal(quote.origin, "https://api.bybit.com");
  assert.equal(quote.symbol, "DOGEUSDT");
  assert.equal(quote.observedAt, "2026-10-22T10:00:00.010Z");
  assert.equal(quote.collectionStartedAt, "2026-10-22T10:00:00.000Z");
  assert.equal(quote.collectionCompletedAt, "2026-10-22T10:00:00.020Z");
  assert.match(quote.contentHash, /^sha256:[0-9a-f]{64}$/u);
});

test("real public time envelopes preserve subsecond quote bounds through operator-plan construction", async () => {
  const base = Date.parse("2026-10-23T12:00:00.000Z");
  for (const [start, tick, end, valid] of [
    [100, 350, 500, true],
    [900, 1050, 1100, true],
    [100, 600, 500, false],
    [350, 100, 500, false],
    [0, 100, 6000, false],
  ] as const) {
    let timeReads = 0;
    let requests = 0;
    const client = new BybitPublicMarketClient({
      transport: createBybitPublicTransport({
        request: async (input, init) => {
          requests++;
          assert.equal(init?.method, "GET");
          const isTime = new URL(String(input)).pathname === "/v5/market/time";
          const at = base + (isTime ? (timeReads++ === 0 ? start : end) : tick);
          return new Response(
            JSON.stringify({
              retCode: 0,
              retMsg: "OK",
              time: at,
              result: isTime
                ? {
                    timeSecond: String(Math.floor(at / 1000)),
                    timeNano: String(BigInt(at) * 1000000n + 361437n),
                  }
                : {
                    category: "linear",
                    list: [
                      {
                        symbol: "DOGEUSDT",
                        bid1Price: "0.0886",
                        ask1Price: "0.0887",
                        lastPrice: "0.0886",
                      },
                    ],
                  },
            }),
          );
        },
      }),
    });
    if (!valid) {
      await assert.rejects(
        client.readOperatorQuote("DOGEUSDT"),
        (error) =>
          error instanceof BybitPublicMarketMappingError &&
          error.kind === "precondition",
      );
    } else {
      const quote = await client.readOperatorQuote("DOGEUSDT");
      assert.equal(Date.parse(quote.collectionStartedAt), base + start);
      assert.equal(Date.parse(quote.collectionCompletedAt), base + end);
      const plan = createOperatorMainnetTestPlan({
        accountIdentityHash: `sha256:${"a".repeat(64)}`,
        symbol: "DOGEUSDT",
        nonce: "time-precision-integration",
        allocation: "10",
        grossNotionalCap: "10",
        maxDeviationBps: "10",
        quote,
        constraints: mapInstrumentInfo(instrumentResponse(), "DOGEUSDT")
          .constraints,
        warningCodes: [],
        preparedAt: new Date(base + end + 100).toISOString(),
      });
      assert.ok(plan.ok, plan.ok ? undefined : plan.error.message);
      assert.equal(plan.value.quoteFreshnessMs, 5000);
      assert.equal(plan.value.entry.orderType, "Limit");
    }
    assert.equal(requests, 3);
  }
});
