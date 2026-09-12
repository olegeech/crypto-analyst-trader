import assert from "node:assert/strict";
import test from "node:test";

import {
  buildProbePlan,
  canonicalize,
  hashProbePlan,
  isProbePlanExpired,
  type ProbePlanInput,
} from "../scripts/bybit-probe/probe-plan.js";

const baseInput = {
  environment: "testnet" as const,
  accountId: "trading-account",
  scenario: "long-entry",
  expiresAt: 2_000,
  method: "POST" as const,
  endpoint: "/v5/order/create",
  params: {
    category: "linear",
    symbol: "DOGEUSDT",
    side: "Buy" as const,
    orderLinkId: "probe-run-1-long",
    price: "0.1000",
    qty: "51.00",
    takeProfit: "0.1020",
    stopLoss: "0.0980",
    orderType: "Limit",
    timeInForce: "PostOnly",
    reduceOnly: false,
    positionIdx: 0,
    tpslMode: "Full",
    tpOrderType: "Market",
    slOrderType: "Market",
    tpTriggerBy: "LastPrice",
    slTriggerBy: "LastPrice",
  },
} as const satisfies ProbePlanInput;

test("equivalent plans have one canonical serialization and digest", () => {
  const one = buildProbePlan(baseInput);
  const two = buildProbePlan({
    ...baseInput,
    params: {
      ...baseInput.params,
      slTriggerBy: "LastPrice",
      tpTriggerBy: "LastPrice",
    },
  });
  assert.equal(canonicalize(one), canonicalize(two));
  assert.equal(hashProbePlan(one), hashProbePlan(two));
  assert.match(hashProbePlan(one), /^[a-f0-9]{64}$/);
});

test("every material request field changes the digest", () => {
  const original = buildProbePlan(baseInput);
  for (const [field, value] of [
    ["symbol", "BTCUSDT"],
    ["side", "Sell"],
    ["qty", "52.00"],
    ["price", "0.1010"],
    ["takeProfit", "0.1030"],
    ["stopLoss", "0.0970"],
    ["positionIdx", 1],
    ["orderLinkId", "probe-run-1-other"],
  ] as const) {
    const candidate = buildProbePlan({
      ...baseInput,
      params: { ...baseInput.params, [field]: value },
    });
    assert.notEqual(hashProbePlan(candidate), hashProbePlan(original), field);
  }
  assert.notEqual(
    hashProbePlan(
      buildProbePlan({ ...baseInput, endpoint: "/v5/order/cancel" }),
    ),
    hashProbePlan(original),
  );
  assert.notEqual(
    hashProbePlan(buildProbePlan({ ...baseInput, method: "GET" })),
    hashProbePlan(original),
  );
  assert.notEqual(
    hashProbePlan(buildProbePlan({ ...baseInput, accountId: "other-account" })),
    hashProbePlan(original),
  );
});

test("plans reject secrets and expire at the exact boundary", () => {
  assert.throws(
    () =>
      buildProbePlan({
        ...baseInput,
        params: { ...baseInput.params, apiSecret: "sentinel" } as never,
      }),
    /unsupported sensitive plan field/,
  );
  const plan = buildProbePlan(baseInput);
  assert.equal(isProbePlanExpired(plan, 1_999), false);
  assert.equal(isProbePlanExpired(plan, 2_000), true);
});

test("invalid plan decimal values never become hash input", () => {
  assert.throws(
    () =>
      buildProbePlan({
        ...baseInput,
        params: { ...baseInput.params, qty: 1 as never } as never,
      }),
    /decimal string/,
  );
});
