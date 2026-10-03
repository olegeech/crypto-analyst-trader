import assert from "node:assert/strict";
import test from "node:test";
import {
  mapAccountInfo,
  mapAccountWallet,
  mapAccountCollateral,
  mapAccountPositions,
  mapAccountOrders,
  mapAccountExecutions,
  mapAccountTiers,
} from "../src/adapters/bybit-v5/account-read-mappers.js";
import {
  manualOrder,
  fill,
  tiers,
  accountReadResponse as response,
  accountInfoResponse,
  walletResponse,
  collateralResponse,
  tierResponse,
} from "./fixtures/bybit-account/read-fixtures.js";
const rows = (list: unknown[], category = "linear") =>
  response({ category, list });
const json = (value: unknown) => JSON.parse(JSON.stringify(value));
const unknown = { state: "unavailable", reason: "not-returned" };

test("wallet colRes retains all provider states and rejects undocumented values", () => {
  for (const [colRes, value] of [
    ["-1", "unknown"],
    ["0", "unrestricted"],
    ["1", "near-limit"],
    ["2", "restricted"],
  ]) {
    const result = rows([
      { accountType: "UNIFIED", coin: [{ coin: "USDT", colRes }] },
    ]);
    assert.deepEqual(mapAccountWallet(result).assets[0]?.restricted, {
      state: "known",
      value,
    });
  }
  for (const colRes of ["3", "true", 2]) {
    const result = rows([
      { accountType: "UNIFIED", coin: [{ coin: "USDT", colRes }] },
    ]);
    assert.throws(
      () => mapAccountWallet(result),
      /^BybitAccountReadError: INVALID_RESPONSE$/,
    );
  }
});

test("spot order amount preserves base/quote market units independently of fills", () => {
  for (const [marketUnit, unit] of [
    ["baseCoin", "base-coin"],
    ["quoteCoin", "quote-coin"],
    [undefined, "unknown"],
    ["FutureUnit", "unknown"],
  ]) {
    const mapped = mapAccountOrders(
      rows(
        [
          {
            ...manualOrder,
            orderType: "Market",
            marketUnit,
            qty: "100",
            cumExecQty: "0.01",
            leavesQty: "0",
          },
        ],
        "spot",
      ),
    )[0]!;
    assert.equal(mapped.qty.unit, unit);
    assert.equal(mapped.cumExecQty.unit, "base-coin");
    assert.equal(mapped.leavesQty.unit, "base-coin");
    assert.deepEqual(
      json(mapped.marketUnit),
      marketUnit === undefined
        ? unknown
        : { state: "known", value: marketUnit },
    );
    assert.equal(json(mapped.qty).value, "100");
  }
  assert.equal(
    mapAccountOrders(rows([manualOrder], "spot"))[0]?.qty.unit,
    "base-coin",
  );
  assert.equal(
    mapAccountExecutions(rows([{ ...fill, execQty: "0.01" }], "spot"))[0]?.qty
      .unit,
    "base-coin",
  );
  assert.throws(() =>
    mapAccountOrders(
      rows(
        [
          { ...manualOrder, orderType: "Market", marketUnit: "baseCoin" },
          { ...manualOrder, orderType: "Market", marketUnit: "quoteCoin" },
        ],
        "spot",
      ),
    ),
  );
});

test("account enums survive and missing wallet facts never become zero", () => {
  assert.deepEqual(
    mapAccountInfo(
      response({
        unifiedMarginStatus: 99,
        marginMode: "FUTURE_MARGIN",
        spotHedgingStatus: "OFF",
      }),
    ).marginMode,
    { state: "known", value: "FUTURE_MARGIN" },
  );
  const wallet = mapAccountWallet(
    rows([
      {
        accountType: "UNIFIED",
        totalAvailableBalance: "",
        coin: [
          {
            coin: "ETH",
            borrowAmount: "2",
            spotBorrow: "3",
            walletBalance: "0",
            marginCollateral: false,
          },
        ],
      },
    ]),
  );
  assert.deepEqual(wallet.totals.totalAvailableBalance, {
    ...unknown,
    unit: "USD",
  });
  assert.equal(wallet.assets[0]?.restricted.state, "unavailable");
  assert.equal(json(wallet.assets[0]?.borrowAmount).value, "2");
  assert.equal(json(wallet.assets[0]?.spotBorrow).value, "3");
  assert.equal(wallet.totals.equityBasis, "unestablished");
  assert.equal(Object.isFrozen(wallet.assets), true);
});
test("collateral uses currency and keeps shared borrow separate and restrictions unknown", () => {
  const value = mapAccountCollateral(
    rows([
      {
        currency: "ETH",
        borrowAmount: "2",
        otherBorrowAmount: "9",
        marginCollateral: false,
      },
    ]),
  );
  assert.equal(value[0]?.coin, "ETH");
  assert.deepEqual(value[0]?.restricted, unknown);
  assert.equal(json(value[0]?.otherBorrowAmount).value, "9");
  assert.equal(value[0]?.collateralSwitch.state, "not-applicable");
});
test("manual conditional orders and unknown category/enums survive", () => {
  const value = mapAccountOrders(rows([manualOrder], "future-category"));
  assert.equal(value[0]?.category, "future-category");
  assert.equal(value[0]?.orderLinkId, null);
  assert.equal(value[0]?.status, "FutureStatus");
  assert.deepEqual(value[0]?.positionIdx, { state: "known", value: 2 });
});
test("hedge legs and flat symbol proofs retain indices and missing decimals", () => {
  const value = mapAccountPositions(
    rows(
      [1, 2].map((positionIdx) => ({
        symbol: "ETHUSDC",
        positionIdx,
        side: "Sell",
        size: "1",
        leverage: "",
      })),
      "inverse",
    ),
  );
  assert.equal(value.length, 2);
  assert.equal(value[0]?.leverage.state, "unavailable");
  assert.equal(
    mapAccountPositions(
      rows([{ symbol: "ETHUSDC", positionIdx: 0, side: "", size: "0" }]),
    )[0]?.side,
    "None",
  );
});
test("execution fees retain unavailable currency, signed fee, separate V2 and typed extra fees", () => {
  const value = mapAccountExecutions(rows([fill], "option"))[0];
  assert.deepEqual(value?.feeCurrency, unknown);
  assert.equal(json(value?.fee).value, "-0.01");
  assert.equal(json(value?.execFeeV2).value, "0");
  assert.equal(json(value?.extraFees).value[0].feeType.value, "FutureTax");
  assert.equal(value?.orderLinkId, null);
  assert.equal(
    mapAccountExecutions(rows([{ ...fill, extraFees: "" }]))[0]?.extraFees
      .state,
    "unavailable",
  );
});
test("tier quantities sort numerically, blank maximum is unbounded and flat ratio is ignored", () => {
  const value = mapAccountTiers(rows(tiers));
  assert.equal(json(value[0]?.minQty).value, "0");
  assert.equal(json(value[0]?.collateralRatio).value, "0.9");
  assert.equal(value[1]?.maxQty, null);
  assert.throws(() =>
    mapAccountTiers(rows([{ coin: "ETH", collateralRatio: "0.9" }])),
  );
});
test("identical rows deduplicate; conflicting metadata and malformed identities fail safely", () => {
  assert.equal(mapAccountOrders(rows([manualOrder, manualOrder])).length, 1);
  for (const change of [
    { symbol: "OTHER" },
    { orderLinkId: "client" },
    { qty: "2" },
  ])
    assert.throws(
      () =>
        mapAccountOrders(rows([manualOrder, { ...manualOrder, ...change }])),
      /^BybitAccountReadError: INVALID_RESPONSE$/,
    );
  for (const change of [{ orderId: "" }, { qty: "1e3" }, { positionIdx: "2" }])
    assert.throws(() =>
      mapAccountOrders(rows([{ ...manualOrder, ...change }])),
    );
  assert.throws(() =>
    mapAccountPositions(rows([{ symbol: "ETH", side: "Buy", size: "1" }])),
  );
  assert.throws(() =>
    mapAccountExecutions(rows([fill, { ...fill, execTime: "1790942400001" }])),
  );
});
test("tier malformed ranges, missing limits and out of bounds ratios fail", () => {
  for (const tier of [
    { minQty: "0", maxQty: "1", ratio: "1.1" },
    { minQty: "2", maxQty: "1", ratio: "0.9" },
    { minQty: "0", ratio: "0.9" },
  ])
    assert.throws(() =>
      mapAccountTiers(rows([{ coin: "ETH", tiers: [tier] }])),
    );
  assert.throws(() =>
    mapAccountTiers(
      rows([
        {
          coin: "ETH",
          tiers: [
            { minQty: "0", maxQty: "2", ratio: "1" },
            { minQty: "1", maxQty: "", ratio: "0.9" },
          ],
        },
      ]),
    ),
  );
});
test("collector fixtures and explicit category arguments match exported APIs", () => {
  assert.equal(mapAccountInfo(accountInfoResponse).utaStatus.state, "known");
  assert.equal(mapAccountWallet(walletResponse).assets.length, 1);
  assert.equal(mapAccountCollateral(collateralResponse).length, 1);
  assert.equal(mapAccountTiers(tierResponse)[0]?.maxQty, null);
  assert.equal(
    mapAccountOrders(response({ list: [manualOrder] }), "option")[0]?.category,
    "option",
  );
  assert.equal(
    mapAccountExecutions(response({ list: [fill] }), "option")[0]?.category,
    "option",
  );
  assert.equal(
    mapAccountPositions(response({ list: [] }), "inverse").length,
    0,
  );
  assert.throws(() =>
    mapAccountOrders(rows([manualOrder], "linear"), "inverse"),
  );
});
test("duplicates, safe errors, and exact sort apply across all fact families", () => {
  assert.equal(
    mapAccountCollateral(rows([{ currency: "ETH" }, { currency: "ETH" }]))
      .length,
    1,
  );
  assert.throws(() =>
    mapAccountCollateral(
      rows([
        { currency: "ETH", borrowAmount: "1" },
        { currency: "ETH", borrowAmount: "2" },
      ]),
    ),
  );
  const position = { symbol: "ETH", positionIdx: 1, side: "Sell", size: "1" };
  assert.equal(mapAccountPositions(rows([position, position])).length, 1);
  assert.throws(() =>
    mapAccountPositions(rows([position, { ...position, size: "2" }])),
  );
  assert.equal(mapAccountExecutions(rows([fill, fill])).length, 1);
  const sorted = mapAccountExecutions(
    rows([
      { ...fill, execId: "b" },
      { ...fill, execId: "a" },
      { ...fill, execId: "z", execTime: "1790942399999" },
    ]),
  );
  assert.deepEqual(
    sorted.map((v) => v.execId),
    ["z", "a", "b"],
  );
  for (const value of ["bad", 1, "1e2", "NaN"])
    assert.throws(() =>
      mapAccountExecutions(rows([{ ...fill, execFee: value }])),
    );
  assert.throws(
    () =>
      mapAccountExecutions(
        rows([{ ...fill, extraFees: "private-malformed-payload" }]),
      ),
    /^BybitAccountReadError: INVALID_RESPONSE$/,
  );
  assert.throws(() =>
    mapAccountWallet(
      rows([
        {
          accountType: "UNIFIED",
          coin: [{ coin: "ETH" }, { coin: "ETH", walletBalance: "1" }],
        },
      ]),
    ),
  );
  assert.throws(() =>
    mapAccountTiers(
      rows([{ currency: "ETH", coin: "BTC", collateralRatioList: [] }]),
    ),
  );
});
test("documented never-traded sequence is not applicable, not an identity error", () => {
  const value = mapAccountPositions(
    rows([
      { symbol: "ETHUSDC", positionIdx: 0, side: "", size: "0", seq: "-1" },
    ]),
  );
  assert.deepEqual(value[0]?.seq, { state: "not-applicable" });
});
test("inverse valuation and margin amounts retain coin units instead of being relabeled USD", () => {
  const mapped = mapAccountPositions({
    time: 1790942400000,
    result: {
      category: "inverse",
      list: [
        {
          symbol: "BTCUSD",
          positionIdx: 0,
          side: "Buy",
          size: "300",
          positionValue: "0.01092319",
          positionIM: "0.001",
          positionMM: "0.0001",
          unrealisedPnl: "-0.001",
        },
      ],
    },
  });
  for (const field of [
    "positionValue",
    "positionIM",
    "positionMM",
    "unrealisedPnl",
  ] as const)
    assert.equal(mapped[0]?.[field].unit, "coin");
});
