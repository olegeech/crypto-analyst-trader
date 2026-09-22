import assert from "node:assert/strict";
import test from "node:test";

import type { BybitResponse } from "../src/adapters/bybit-v5/transport.js";
import {
  BybitReadMappingError,
  mapAccountKeyMetadata,
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
      list: [
        {
          symbol: "DOGEUSDT",
          positionIdx: "0",
          side: "",
          size: "0",
          leverage: "1",
        },
      ],
    }),
    "DOGEUSDT",
  );
  assert.equal(position.side, "flat");
  assert.equal(position.quantity.toString(), "0");
  assert.equal(position.leverage.toString(), "1");

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

test("account-key mapping proves Demo identity and normalizes permissions", () => {
  const mapped = mapAccountKeyMetadata(
    response({
      userID: "demo-account",
      readOnly: 0,
      permissions: {
        ContractTrade: ["Order", "Position"],
        Wallet: [],
      },
      ips: [],
      expiredAt: "2026-10-01T00:00:00Z",
    }),
    "demo-account",
  );
  assert.equal(mapped.userId, "demo-account");
  assert.equal(mapped.readOnly, false);
  assert.deepEqual(mapped.contractTrade, { order: true, position: true });
  assert.deepEqual(mapped.wallet, { withdraw: false, transfer: false });
  assert.equal(mapped.warningCodes[0], "API_KEY_IP_UNBOUND");
  assert.equal(mapped.expiresAt, "2026-10-01T00:00:00.000Z");
});

test("account-key mapping canonicalizes Bybit numeric user IDs", () => {
  const mapped = mapAccountKeyMetadata(
    response({
      userID: 123456789,
      readOnly: 0,
      permissions: {
        ContractTrade: ["Order", "Position"],
        Wallet: [],
      },
      ips: ["127.0.0.1"],
    }),
    "123456789",
  );
  assert.equal(mapped.userId, "123456789");
  assert.equal(mapped.readOnly, false);
});

test("account-key mapping fails closed for identity, read-only and dangerous permissions", () => {
  const base = {
    userID: "demo-account",
    readOnly: 0,
    permissions: { ContractTrade: ["Order", "Position"], Wallet: [] },
    ips: ["127.0.0.1"],
  };
  assert.throws(
    () =>
      mapAccountKeyMetadata(
        response({ ...base, userID: "other" }),
        "demo-account",
      ),
    (error: unknown) =>
      error instanceof BybitReadMappingError && error.kind === "precondition",
  );
  assert.throws(
    () =>
      mapAccountKeyMetadata(response({ ...base, readOnly: 1 }), "demo-account"),
    (error: unknown) =>
      error instanceof BybitReadMappingError && error.kind === "precondition",
  );
  assert.throws(
    () =>
      mapAccountKeyMetadata(
        response({
          ...base,
          permissions: {
            ContractTrade: ["Order", "Position"],
            Wallet: ["Withdraw"],
          },
        }),
        "demo-account",
      ),
    (error: unknown) =>
      error instanceof BybitReadMappingError && error.kind === "precondition",
  );
});

test("order mapping preserves an exact attached-protection parent link", () => {
  const [mapped] = mapOrderRecords(
    response({
      list: [
        order({
          orderLinkId: "",
          parentOrderLinkId: "entry-client",
          stopOrderType: "TakeProfit",
          orderStatus: "Untriggered",
        }),
      ],
    }),
    "DOGEUSDT",
  );
  assert.equal(mapped?.clientOrderId, "entry-client");
  assert.equal(mapped?.parentOrderLinkId, "entry-client");
  assert.equal(mapped?.protectionType, "take-profit");
  assert.equal(mapped?.status, "open");
});

test("ordinary orders with an empty client identity still fail closed", () => {
  assert.throws(
    () =>
      mapOrderRecords(
        response({ list: [order({ orderLinkId: "" })] }),
        "DOGEUSDT",
      ),
    BybitReadMappingError,
  );
});

test("position leverage is mandatory and one-way rows are unambiguous", () => {
  assert.throws(
    () =>
      mapPosition(
        response({
          list: [{ symbol: "DOGEUSDT", positionIdx: 0, side: "", size: "0" }],
        }),
        "DOGEUSDT",
      ),
    (error: unknown) =>
      error instanceof BybitReadMappingError &&
      error.kind === "invalid-response",
  );
  assert.throws(
    () =>
      mapPosition(
        response({
          list: [
            {
              symbol: "DOGEUSDT",
              positionIdx: 0,
              side: "",
              size: "0",
              leverage: "1",
            },
            {
              symbol: "DOGEUSDT",
              positionIdx: 0,
              side: "",
              size: "0",
              leverage: "2",
            },
          ],
        }),
        "DOGEUSDT",
      ),
    (error: unknown) =>
      error instanceof BybitReadMappingError && error.kind === "precondition",
  );
});
