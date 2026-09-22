import assert from "node:assert/strict";
import test from "node:test";

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
        priceFilter: { tickSize: "0.0001" },
        lotSizeFilter: {
          qtyStep: "1",
          minOrderQty: "1",
          minNotionalValue: "5",
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

test("public mappings normalize reverse kline ordering and exclude only after cutoff normalization", () => {
  const cutoff = "2024-08-01T19:30:00.000Z";
  const mapped = mapKline(
    response({
      list: [
        ["1722535200000", "101", "102", "100", "101.5", "20", "2030"],
        ["1722531600000", "99", "101", "98", "100", "10", "1000"],
      ],
    }),
    "DOGEUSDT",
    "1h",
    cutoff as UtcTimestamp,
  );
  assert.deepEqual(
    mapped.map((row) => row.timestamp),
    ["2024-08-01T17:00:00.000Z", "2024-08-01T18:00:00.000Z"],
  );
  assert.equal(
    mapped.every((row) => row.closed),
    true,
  );
  assert.equal(mapped[0]?.close.toString(), "100");
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
