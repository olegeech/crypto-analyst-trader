import assert from "node:assert/strict";
import test from "node:test";

import type { BybitResponse } from "../src/adapters/bybit-v5/transport.js";
import {
  BybitReadMappingError,
  mapAccountKeyMetadata,
  mapExecutionRecords,
  mapInstrumentInfo,
  mapOrderRecords,
  mapOrderObservation,
  mapPosition,
  mapTicker,
  mapWalletBalance,
  nextPageCursor,
} from "../src/adapters/bybit-v5/read-mappers.js";
import { parseUtcTimestamp } from "../src/domain/shared/time.js";
import { requireDailyFixture as value } from "./fixtures/daily-planning-evidence-fixtures.js";

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
        priceFilter: {
          tickSize: "0.0001",
          minPrice: "0.0001",
          maxPrice: "1000000",
        },
        lotSizeFilter: {
          qtyStep: "1",
          minOrderQty: "1",
          maxOrderQty: "100000",
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
  assert.equal(instrument.constraints.minPrice?.toString(), "0.0001");
  assert.equal(instrument.constraints.maxPrice?.toString(), "1000000");
  assert.equal(instrument.constraints.maxLimitQuantity?.toString(), "100000");

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

test("order mapping uses response category and preserves decimal zero protection", () => {
  const [mapped] = mapOrderRecords(
    response({
      category: "linear",
      list: [order({ takeProfit: "0.00", stopLoss: "0.0000" })],
    }),
    "DOGEUSDT",
  );
  assert.equal(mapped?.category, "linear");
  assert.equal(mapped?.takeProfit, null);
  assert.equal(mapped?.stopLoss, null);

  assert.throws(
    () =>
      mapOrderRecords(
        response({
          category: "linear",
          list: [order({ category: "spot" })],
        }),
        "DOGEUSDT",
      ),
    BybitReadMappingError,
  );
  assert.throws(
    () =>
      mapOrderRecords(
        response({ category: "spot", list: [order()] }),
        "DOGEUSDT",
      ),
    BybitReadMappingError,
  );
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
          stopOrderType: "PartialTakeProfit",
          tpslMode: "Partial",
          tpTriggerBy: "LastPrice",
          triggerBy: "MarkPrice",
          orderStatus: "Untriggered",
          category: "linear",
          side: "Sell",
          orderType: "Market",
          qty: "57",
          triggerPrice: "0.0912",
          reduceOnly: true,
          positionIdx: 0,
        }),
      ],
    }),
    "DOGEUSDT",
  );
  assert.equal(mapped?.clientOrderId, "entry-client");
  assert.equal(mapped?.providerOrderLinkId, undefined);
  assert.equal(mapped?.parentOrderLinkId, "entry-client");
  assert.equal(mapped?.protectionType, "take-profit");
  assert.equal(mapped?.providerStopOrderType, "PartialTakeProfit");
  assert.equal(mapped?.providerTpslMode, "Partial");
  assert.equal(mapped?.takeProfitTriggerBy, "LastPrice");
  assert.equal(mapped?.triggerBy, "MarkPrice");
  assert.equal(mapped?.status, "open");
  assert.equal(mapped?.orderType, "market");
  assert.equal(mapped?.triggerPrice?.toString(), "0.0912");
});

test("strict child projection retains provider timestamps and endpoint source", () => {
  const [record] = mapOrderRecords(
    response({
      list: [
        order({
          orderLinkId: "",
          parentOrderLinkId: "entry-client",
          stopOrderType: "PartialTakeProfit",
          tpslMode: "Partial",
          tpTriggerBy: "LastPrice",
          orderStatus: "Untriggered",
          side: "Sell",
          orderType: "Market",
          qty: "12",
          triggerPrice: "0.0912",
          reduceOnly: true,
          positionIdx: 0,
          createdTime: "1789984800000",
          updatedTime: "1789984801000",
        }),
      ],
    }),
    "DOGEUSDT",
    "order/history",
  );
  assert.ok(record);
  const observation = mapOrderObservation(
    record,
    value(parseUtcTimestamp("2026-09-21T10:00:00.000Z")),
    "bybit-mainnet/protection",
  );
  assert.equal(observation.clientOrderId, "entry-client");
  assert.equal(observation.providerOrderLinkId, undefined);
  assert.equal(observation.parentOrderLinkId, "entry-client");
  assert.equal(observation.providerStopOrderType, "PartialTakeProfit");
  assert.equal(observation.providerTpslMode, "Partial");
  assert.equal(observation.takeProfitTriggerBy, "LastPrice");
  assert.equal(observation.source, "bybit-mainnet/protection/order/history");
  assert.equal(observation.providerCreatedAt, "2026-09-21T10:00:00.000Z");
  assert.equal(observation.providerUpdatedAt, "2026-09-21T10:00:01.000Z");
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

test("generic UNKNOWN triggerBy is absent while unknown TP trigger remains invalid", () => {
  const [ordinary] = mapOrderRecords(
    response({ list: [order({ triggerBy: "UNKNOWN" })] }),
    "DOGEUSDT",
  );
  assert.equal(ordinary?.triggerBy, undefined);

  assert.throws(
    () =>
      mapOrderRecords(
        response({
          list: [
            order({
              stopOrderType: "PartialTakeProfit",
              tpTriggerBy: "UNKNOWN",
            }),
          ],
        }),
        "DOGEUSDT",
      ),
    BybitReadMappingError,
  );
});

test("execution mapping preserves an empty TP child link id without parent alias", () => {
  const [execution] = mapExecutionRecords(
    response({
      list: [
        {
          symbol: "DOGEUSDT",
          execId: "exit-exec-1",
          orderId: "tp-child-1",
          orderLinkId: "",
          side: "Sell",
          execQty: "0.2",
          execPrice: "0.0912",
          execTime: "1789984801000",
        },
      ],
    }),
    "DOGEUSDT",
  );

  assert.equal(execution?.exchangeOrderId, "tp-child-1");
  assert.equal(execution?.clientOrderId, "");
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
