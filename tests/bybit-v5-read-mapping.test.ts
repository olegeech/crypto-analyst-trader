import assert from "node:assert/strict";
import test from "node:test";

import type { BybitResponse } from "../src/adapters/bybit-v5/transport.js";
import {
  BybitReadMappingError,
  mapInstrumentInfo,
  mapOrderRecords,
  mapPosition,
  mapTicker,
  mapWalletBalance,
  nextPageCursor,
} from "../src/adapters/bybit-v5/read-mappers.js";

function response(result: Record<string, unknown>): BybitResponse {
  return { retCode: 0, retMsg: "OK", result };
}

function instrumentResponse(
  overrides: Record<string, unknown> = {},
): BybitResponse {
  return response({
    list: [
      {
        symbol: "DOGEUSDT",
        status: "Trading",
        contractType: "LinearPerpetual",
        quoteCoin: "USDT",
        settleCoin: "USDT",
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

function order(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    symbol: "DOGEUSDT",
    orderId: "exchange-1",
    orderLinkId: "owned-client",
    side: "Buy",
    qty: "57",
    cumExecQty: "0",
    orderStatus: "New",
    positionIdx: 0,
    reduceOnly: false,
    price: "0.0887",
    ...overrides,
  };
}

test("strict read mappers normalize the supported Demo linear one-way scope", () => {
  const instrument = mapInstrumentInfo(instrumentResponse(), "DOGEUSDT");
  assert.equal(instrument.constraints.priceTickSize.toString(), "0.0001");
  assert.equal(instrument.constraints.minNotional?.toString(), "5");

  const ticker = mapTicker(
    response({
      list: [
        {
          symbol: "DOGEUSDT",
          bid1Price: "0.0886",
          ask1Price: "0.0887",
          lastPrice: "0.08865",
        },
      ],
    }),
    "DOGEUSDT",
  );
  assert.equal(ticker.bid.toString(), "0.0886");
  assert.equal(ticker.ask.toString(), "0.0887");

  const wallet = mapWalletBalance(
    response({
      list: [{ accountType: "UNIFIED", totalAvailableBalance: "100" }],
    }),
  );
  assert.equal(wallet.availableBalance.toString(), "100");

  const position = mapPosition(
    response({
      list: [{ symbol: "DOGEUSDT", positionIdx: "0", side: "", size: "0" }],
    }),
    "DOGEUSDT",
  );
  assert.equal(position.side, "flat");
  assert.equal(position.quantity.toString(), "0");

  const orders = mapOrderRecords(
    response({
      list: [order({ orderStatus: "PartiallyFilled", cumExecQty: "12" })],
    }),
    "DOGEUSDT",
  );
  assert.equal(orders[0]?.status, "partially-filled");
  assert.equal(orders[0]?.filledQuantity.toString(), "12");
});

test("cancelled order mapping preserves executed quantity", () => {
  const [mapped] = mapOrderRecords(
    response({
      list: [
        order({
          orderStatus: "Cancelled",
          cumExecQty: "12",
        }),
      ],
    }),
    "DOGEUSDT",
    "order/history",
  );
  assert.equal(mapped?.status, "cancelled");
  assert.equal(mapped?.filledQuantity.toString(), "12");
});

test("read mappings fail closed on unsupported scope, ignored filters and contradictory state", () => {
  assert.throws(
    () =>
      mapInstrumentInfo(instrumentResponse({ quoteCoin: "BTC" }), "DOGEUSDT"),
    (error: unknown) =>
      error instanceof BybitReadMappingError && error.kind === "precondition",
  );
  assert.throws(
    () =>
      mapTicker(
        response({
          list: [
            {
              symbol: "DOGEUSDT",
              bid1Price: "0.09",
              ask1Price: "0.08",
              lastPrice: "0.085",
            },
          ],
        }),
        "DOGEUSDT",
      ),
    BybitReadMappingError,
  );
  assert.throws(
    () =>
      mapPosition(
        response({
          list: [
            { symbol: "DOGEUSDT", positionIdx: 1, side: "Buy", size: "1" },
          ],
        }),
        "DOGEUSDT",
      ),
    (error: unknown) =>
      error instanceof BybitReadMappingError && error.kind === "precondition",
  );
  assert.throws(
    () =>
      mapOrderRecords(
        response({ list: [order({ symbol: "BTCUSDT" })] }),
        "DOGEUSDT",
      ),
    BybitReadMappingError,
  );
  assert.throws(
    () =>
      mapOrderRecords(
        response({ list: [order({ cumExecQty: "58" })] }),
        "DOGEUSDT",
      ),
    BybitReadMappingError,
  );
});

test("pagination cursors are optional safe strings", () => {
  assert.equal(
    nextPageCursor(response({ list: [] }), "order/realtime"),
    undefined,
  );
  assert.equal(
    nextPageCursor(
      response({ list: [], nextPageCursor: "cursor-1" }),
      "order/realtime",
    ),
    "cursor-1",
  );
  assert.throws(
    () =>
      nextPageCursor(
        response({ list: [], nextPageCursor: 42 }),
        "order/realtime",
      ),
    BybitReadMappingError,
  );
});
