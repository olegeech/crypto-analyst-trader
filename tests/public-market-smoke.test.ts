import assert from "node:assert/strict";
import test from "node:test";

import {
  publicMarketConfig,
  runPublicMarketSmoke,
} from "../scripts/public-market-smoke.js";

test("public market smoke requires the canonical credential-free environment", () => {
  assert.throws(
    () => publicMarketConfig({ TRADER_ENV: "demo" }),
    /TRADER_ENV must be public-mainnet/u,
  );
  assert.throws(
    () =>
      publicMarketConfig({
        TRADER_ENV: "public-mainnet",
        BYBIT_API_BASE_URL: "https://api-demo.bybit.com",
      }),
    /public mainnet base URL/u,
  );
});

test("public market smoke fake transport uses only bounded GETs and emits a sanitized summary", async () => {
  const methods: string[] = [];
  const urls: string[] = [];
  const request = async (url: RequestInfo | URL, init?: RequestInit) => {
    methods.push(String(init?.method));
    urls.push(String(url));
    const parsed = new URL(String(url));
    const path = parsed.pathname;
    const symbol = parsed.searchParams.get("symbol") ?? "BTCUSDT";
    const interval =
      parsed.searchParams.get("interval") ??
      parsed.searchParams.get("intervalTime");
    const time = 1_800_000_000_000;
    if (path === "/v5/market/time") {
      return new Response(
        JSON.stringify({
          retCode: 0,
          retMsg: "OK",
          result: { timeSecond: "1800000000" },
          time,
        }),
      );
    }
    if (path === "/v5/market/instruments-info") {
      return new Response(
        JSON.stringify({
          retCode: 0,
          retMsg: "OK",
          result: {
            list: [
              {
                symbol,
                status: "Trading",
                baseCoin: symbol.replace("USDT", ""),
                contractType: "LinearPerpetual",
                quoteCoin: "USDT",
                settleCoin: "USDT",
                fundingInterval: "480",
                priceFilter: { tickSize: "0.01" },
                lotSizeFilter: {
                  qtyStep: "1",
                  minOrderQty: "1",
                  minNotionalValue: "5",
                },
              },
            ],
          },
          time,
        }),
      );
    }
    if (path === "/v5/market/tickers") {
      return new Response(
        JSON.stringify({
          retCode: 0,
          retMsg: "OK",
          result: {
            list: [
              {
                symbol,
                bid1Price: "100",
                ask1Price: "101",
                lastPrice: "100.5",
              },
            ],
          },
          time,
        }),
      );
    }
    if (path === "/v5/market/kline") {
      const step =
        interval === "60"
          ? 3_600_000
          : interval === "240"
            ? 14_400_000
            : interval === "D"
              ? 86_400_000
              : 604_800_000;
      const limit = Number(parsed.searchParams.get("limit") ?? "1");
      const end = time - step;
      const list = Array.from({ length: limit }, (_, index) => [
        String(end - (limit - 1 - index) * step),
        "99",
        "102",
        "98",
        "100",
        "10",
        "1000",
      ]);
      return new Response(
        JSON.stringify({
          retCode: 0,
          retMsg: "OK",
          result: { symbol, category: "linear", list },
          time,
        }),
      );
    }
    if (path === "/v5/market/funding/history") {
      const limit = Number(parsed.searchParams.get("limit") ?? "1");
      const list = Array.from({ length: limit }, (_, index) => ({
        symbol,
        fundingRate: "0.001",
        fundingRateTimestamp: String(time - (limit - index) * 28_800_000),
      }));
      return new Response(
        JSON.stringify({ retCode: 0, retMsg: "OK", result: { list }, time }),
      );
    }
    if (path === "/v5/market/open-interest") {
      const step =
        interval === "1h"
          ? 3_600_000
          : interval === "4h"
            ? 14_400_000
            : 86_400_000;
      const limit = Number(parsed.searchParams.get("limit") ?? "1");
      const list = Array.from({ length: limit }, (_, index) => ({
        symbol,
        openInterest: "100",
        timestamp: String(time - (limit - index) * step),
      }));
      return new Response(
        JSON.stringify({
          retCode: 0,
          retMsg: "OK",
          result: { symbol, list },
          time,
        }),
      );
    }
    throw new Error(`unexpected path ${path}`);
  };

  const summary = await runPublicMarketSmoke({
    environment: { TRADER_ENV: "public-mainnet" },
    request,
  });
  assert.equal(summary.environment, "public-mainnet");
  assert.equal(summary.status, "complete", JSON.stringify(summary));
  assert.equal(summary.symbols, 4);
  assert.match(summary.canonicalHash, /^sha256:[0-9a-f]{64}$/u);
  const paths = urls.map((url) => new URL(url).pathname);
  assert.deepEqual(
    Object.fromEntries(
      [
        "/v5/market/time",
        "/v5/market/instruments-info",
        "/v5/market/tickers",
        "/v5/market/kline",
        "/v5/market/funding/history",
        "/v5/market/open-interest",
      ].map((path) => [path, paths.filter((item) => item === path).length]),
    ),
    {
      "/v5/market/time": 2,
      "/v5/market/instruments-info": 4,
      "/v5/market/tickers": 4,
      "/v5/market/kline": 16,
      "/v5/market/funding/history": 4,
      "/v5/market/open-interest": 12,
    },
  );
  assert.equal(methods.length, 42);
  assert.equal(
    methods.every((method) => method === "GET"),
    true,
  );
  assert.equal(
    urls
      .filter((url) => new URL(url).pathname === "/v5/market/kline")
      .every((url) => {
        const parsed = new URL(url);
        return (
          parsed.searchParams.get("category") === "linear" &&
          Number(parsed.searchParams.get("limit")) >= 105 &&
          Number(parsed.searchParams.get("limit")) <= 251 &&
          parsed.searchParams.has("interval") &&
          !parsed.searchParams.has("cursor")
        );
      }),
    true,
  );
  assert.equal(
    urls
      .filter((url) => new URL(url).pathname === "/v5/market/open-interest")
      .every((url) => {
        const parsed = new URL(url);
        return (
          parsed.searchParams.get("category") === "linear" &&
          parsed.searchParams.has("intervalTime") &&
          Number(parsed.searchParams.get("limit")) <= 200
        );
      }),
    true,
  );
  assert.equal(
    urls.every((url) => new URL(url).origin === "https://api.bybit.com"),
    true,
  );
});
