import assert from "node:assert/strict";
import test from "node:test";

import {
  PUBLIC_INSTRUMENTS_INFO_PATH,
  PUBLIC_TICKERS_PATH,
} from "../src/adapters/bybit-v5/public-market-client.js";
import {
  BybitPublicTransportError,
  createBybitPublicTransport,
} from "../src/adapters/bybit-v5/public-transport.js";
import {
  readMarketDiscoveryBooks,
  readMarketDiscoverySnapshot,
} from "../src/adapters/bybit-v5/public-market-discovery.js";

import { RoundingMode } from "../src/domain/shared/decimal.js";
import { rankMarketDiscovery } from "../src/domain/market/market-discovery.js";

type FixtureResponse = { readonly status?: number; readonly body: unknown };

function fixtureRequest(respond: (url: URL) => FixtureResponse): typeof fetch {
  return async (input, init) => {
    assert.equal(init?.method, "GET");
    const response = respond(new URL(String(input)));
    return new Response(JSON.stringify(response.body), {
      status: response.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
}

// Synthetic fixtures model the public Bybit V5 instrument-info and tickers
// response fields: https://bybit-exchange.github.io/docs/v5/market/instrument
// and https://bybit-exchange.github.io/docs/v5/market/tickers.
function instrument(symbol: string): Record<string, unknown> {
  return {
    symbol,
    status: "Trading",
    contractType: "LinearPerpetual",
    quoteCoin: "USDT",
    settleCoin: "USDT",
    baseCoin: symbol.replace("USDT", ""),
    symbolType: "stock",
    additiveProviderField: "accepted",
  };
}

function ticker(symbol: string): Record<string, unknown> {
  return {
    symbol,
    turnover24h: "12345.67",
    bid1Price: "10",
    ask1Price: "10.1",
    price24hPcnt: "-0.025",
    highPrice24h: "11",
    lowPrice24h: "9",
    optionalProviderField: "accepted",
  };
}

test("discovery reads every instrument page and one timestamped bulk ticker snapshot", async () => {
  const urls: URL[] = [];
  const transport = createBybitPublicTransport({
    request: fixtureRequest((url) => {
      urls.push(url);
      if (url.pathname === PUBLIC_INSTRUMENTS_INFO_PATH) {
        const cursor = url.searchParams.get("cursor");
        return {
          body: {
            retCode: 0,
            retMsg: "OK",
            result:
              cursor === null
                ? {
                    category: "linear",
                    list: [instrument("INJUSDT")],
                    nextPageCursor: "page-2",
                  }
                : { category: "linear", list: [instrument("NEARUSDT")] },
            // Instrument-page time is optional for discovery.
          },
        };
      }
      assert.equal(url.pathname, PUBLIC_TICKERS_PATH);
      return {
        body: {
          retCode: 0,
          retMsg: "OK",
          result: {
            category: "linear",
            list: [
              ticker("INJUSDT"),
              {
                ...ticker("NEARUSDT"),
                price24hPcnt: undefined,
                highPrice24h: undefined,
                lowPrice24h: undefined,
              },
            ],
          },
          time: 1_800_000_000_000,
        },
      };
    }),
  });

  const snapshot = await readMarketDiscoverySnapshot({ transport });

  assert.equal(snapshot.instruments.length, 2);
  assert.equal(snapshot.instruments[0]?.baseCoin, "INJ");
  assert.equal(snapshot.instruments[0]?.symbolType, "stock");
  assert.equal(snapshot.tickers.length, 2);
  assert.equal(snapshot.asOf, "2027-01-15T08:00:00.000Z");
  assert.equal(snapshot.requestCount, 3);
  assert.deepEqual(
    urls.map((url) => url.pathname),
    [
      PUBLIC_INSTRUMENTS_INFO_PATH,
      PUBLIC_INSTRUMENTS_INFO_PATH,
      PUBLIC_TICKERS_PATH,
    ],
  );
  assert.equal(urls[0]?.searchParams.get("category"), "linear");
  assert.equal(urls[0]?.searchParams.get("limit"), "1000");
  assert.equal(urls[1]?.searchParams.get("cursor"), "page-2");
  assert.equal(urls[2]?.searchParams.has("symbol"), false);
  assert.equal(snapshot.tickers[0]?.turnover24h?.toString(), "12345.67");
  assert.equal(snapshot.tickers[0]?.priceChange24h?.toString(), "-0.025");
  assert.equal(snapshot.tickers[1]?.priceChange24h, undefined);
});

test("targeted discovery uses the same parsers with a symbol filter", async () => {
  const urls: URL[] = [];
  const transport = createBybitPublicTransport({
    request: fixtureRequest((url) => {
      urls.push(url);
      return {
        body: {
          retCode: 0,
          retMsg: "OK",
          result: {
            category: "linear",
            list: [
              url.pathname === PUBLIC_INSTRUMENTS_INFO_PATH
                ? instrument("INJUSDT")
                : ticker("INJUSDT"),
            ],
          },
          ...(url.pathname === PUBLIC_TICKERS_PATH
            ? { time: 1_800_000_000_000 }
            : {}),
        },
      };
    }),
  });

  const snapshot = await readMarketDiscoverySnapshot({
    transport,
    symbol: "INJUSDT",
  });

  assert.equal(snapshot.instruments.length, 1);
  assert.equal(snapshot.tickers.length, 1);
  assert.equal(snapshot.requestCount, 2);
  assert.equal(urls.length, 2);
  assert.ok(urls.every((url) => url.searchParams.get("symbol") === "INJUSDT"));
});

test("empty bulk tickers are unavailable when instrument metadata is nonempty", async () => {
  const transport = createBybitPublicTransport({
    request: fixtureRequest((url) => ({
      body: {
        retCode: 0,
        retMsg: "OK",
        result: {
          category: "linear",
          list:
            url.pathname === PUBLIC_INSTRUMENTS_INFO_PATH
              ? [instrument("INJUSDT")]
              : [],
        },
        ...(url.pathname === PUBLIC_TICKERS_PATH
          ? { time: 1_800_000_000_000 }
          : {}),
      },
    })),
  });

  await assert.rejects(
    readMarketDiscoverySnapshot({ transport }),
    /ticker response was empty/u,
  );
});

test("symbol-filtered invalid-symbol responses retain their provider code and message", async () => {
  const transport = createBybitPublicTransport({
    request: fixtureRequest((url) => {
      assert.equal(url.pathname, PUBLIC_INSTRUMENTS_INFO_PATH);
      assert.equal(url.searchParams.get("symbol"), "NOPEXYZUSDT");
      return {
        body: {
          retCode: 10001,
          retMsg: "params error: symbol invalid",
          result: { category: "linear", list: [] },
        },
      };
    }),
  });

  await assert.rejects(
    readMarketDiscoverySnapshot({ transport, symbol: "NOPEXYZUSDT" }),
    (error: unknown) =>
      error instanceof BybitPublicTransportError &&
      error.retCode === 10001 &&
      error.retMsg === "params error: symbol invalid" &&
      error.message === "Bybit public API returned an unsuccessful response.",
  );
});

test("discovery rejects incomplete provider pages, missing ticker time, rate limits and exhausted pagination", async () => {
  const base = (result: Record<string, unknown>, time?: number) => ({
    retCode: 0,
    retMsg: "OK",
    result,
    ...(time === undefined ? {} : { time }),
  });
  const transportFor = (
    respond: (path: string, cursor: string | null) => unknown,
  ) =>
    createBybitPublicTransport({
      request: fixtureRequest((url) => ({
        body: respond(url.pathname, url.searchParams.get("cursor")),
      })),
    });

  await assert.rejects(
    readMarketDiscoverySnapshot({
      transport: transportFor((path) =>
        path === PUBLIC_INSTRUMENTS_INFO_PATH
          ? base({ category: "linear" })
          : base({ category: "linear", list: [] }, 1_800_000_000_000),
      ),
    }),
  );
  await assert.rejects(
    readMarketDiscoverySnapshot({
      transport: transportFor((path) =>
        path === PUBLIC_INSTRUMENTS_INFO_PATH
          ? { retCode: 0, retMsg: "OK" }
          : base({ category: "linear", list: [] }, 1_800_000_000_000),
      ),
    }),
  );
  await assert.rejects(
    readMarketDiscoverySnapshot({
      transport: transportFor((path) =>
        path === PUBLIC_INSTRUMENTS_INFO_PATH
          ? base({ category: "spot", list: [] })
          : base({ category: "linear", list: [] }, 1_800_000_000_000),
      ),
    }),
  );
  await assert.rejects(
    readMarketDiscoverySnapshot({
      transport: transportFor((path) =>
        path === PUBLIC_INSTRUMENTS_INFO_PATH
          ? base({ category: "linear", list: [] })
          : base({ category: "linear", list: [] }),
      ),
    }),
  );

  const rateLimitedTransport = createBybitPublicTransport({
    request: fixtureRequest(() => ({ status: 429, body: {} })),
  });
  await assert.rejects(
    readMarketDiscoverySnapshot({ transport: rateLimitedTransport }),
  );

  const paginatedTransport = transportFor((path) =>
    path === PUBLIC_INSTRUMENTS_INFO_PATH
      ? base({ category: "linear", list: [], nextPageCursor: "next" })
      : base({ category: "linear", list: [] }, 1_800_000_000_000),
  );
  await assert.rejects(
    readMarketDiscoverySnapshot({
      transport: paginatedTransport,
      pagination: { maxPages: 1, maxRows: 10 },
    }),
  );
});

// Synthetic Bybit orderbook snapshot fields from
// https://bybit-exchange.github.io/docs/v5/market/orderbook.
function book(symbol: string) {
  return {
    s: symbol,
    b: [["99", "10"]],
    a: [
      ["100", "0.5"],
      ["102", "10"],
    ],
    ts: 1_800_000_000_000,
  };
}

test("books are fetched once per final displayed candidate and never alter the shortlist", async () => {
  const urls: URL[] = [];
  const instruments = ["XAU", "PAXG", "NEAR", "INJ"].map((base) =>
    instrument(base + "USDT"),
  );
  const tickers = ["XAU", "PAXG", "NEAR", "INJ"].map((base, index) => ({
    ...ticker(base + "USDT"),
    turnover24h: String(1000 - index),
  }));
  const transport = createBybitPublicTransport({
    request: fixtureRequest((url) => {
      urls.push(url);
      if (url.pathname === "/v5/market/orderbook") {
        const symbol = url.searchParams.get("symbol")!;
        return symbol === "NEARUSDT"
          ? { status: 429, body: {} }
          : { body: { retCode: 0, retMsg: "OK", result: book(symbol) } };
      }
      return {
        body: {
          retCode: 0,
          retMsg: "OK",
          result: {
            category: "linear",
            list:
              url.pathname === PUBLIC_INSTRUMENTS_INFO_PATH
                ? instruments
                : tickers,
          },
          ...(url.pathname === PUBLIC_TICKERS_PATH
            ? { time: 1_800_000_000_000 }
            : {}),
        },
      };
    }),
  });
  const snapshot = await readMarketDiscoverySnapshot({ transport });
  const analysis = rankMarketDiscovery(snapshot, { resultLimit: 2 });
  const symbols = analysis.candidates.map((candidate) => candidate.symbol);
  assert.deepEqual(symbols, ["XAUUSDT", "NEARUSDT"]);
  const books = await readMarketDiscoveryBooks({ transport, symbols });
  assert.equal(books.requestCount, 2);
  assert.equal(snapshot.requestCount + books.requestCount, urls.length);
  assert.deepEqual(
    urls
      .filter((url) => url.pathname === "/v5/market/orderbook")
      .map((url) => url.searchParams.get("symbol")),
    symbols,
  );
  for (const url of urls.filter(
    (url) => url.pathname === "/v5/market/orderbook",
  )) {
    assert.equal(url.searchParams.get("category"), "linear");
    assert.equal(url.searchParams.get("limit"), "50");
  }
  const estimate = books.estimates.get("XAUUSDT");
  assert.equal(estimate?.status, "available");
  if (estimate?.status !== "available") return;
  assert.equal(estimate.asOf, "2027-01-15T08:00:00.000Z");
  assert.equal(estimate.availableAskNotional.toString(), "1070");
  assert.equal(
    estimate.estimatedBuyCostBps
      .roundToScale(4, RoundingMode.HALF_UP)
      .toString(),
    "149.7587",
  );
  assert.equal(books.estimates.get("NEARUSDT")?.status, "unavailable");
  assert.deepEqual(
    analysis.candidates.map((candidate) => candidate.symbol),
    symbols,
  );
});

test("targeted symbol gets one book; invalid books stay unavailable and short depth is explicit", async () => {
  const responses = [
    { ...book("INJUSDT"), a: [["100", "0.1"]] },
    { ...book("INJUSDT"), a: [["100", "broken"]] },
    { ...book("INJUSDT"), b: [["103", "1"]] },
    { ...book("OTHERUSDT") },
    { ...book("INJUSDT"), ts: undefined },
  ];
  for (const [index, result] of responses.entries()) {
    const urls: URL[] = [];
    const transport = createBybitPublicTransport({
      request: fixtureRequest((url) => {
        urls.push(url);
        return { body: { retCode: 0, retMsg: "OK", result } };
      }),
    });
    const books = await readMarketDiscoveryBooks({
      transport,
      symbols: ["INJUSDT"],
    });
    assert.equal(urls.length, 1);
    assert.equal(urls[0]?.pathname, "/v5/market/orderbook");
    assert.equal(urls[0]?.searchParams.get("symbol"), "INJUSDT");
    assert.equal(urls[0]?.searchParams.get("category"), "linear");
    assert.equal(urls[0]?.searchParams.get("limit"), "50");
    const estimate = books.estimates.get("INJUSDT");
    assert.equal(
      estimate?.status,
      index === 0 ? "insufficient" : "unavailable",
    );
    if (estimate?.status === "insufficient")
      assert.equal(estimate.availableAskNotional.toString(), "10");
  }
});
