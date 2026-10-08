import assert from "node:assert/strict";
import test from "node:test";

import { createPreparedLegExecution } from "../src/domain/execution/prepared-leg-execution.js";
import {
  createPreparedLegOrderProof,
  matchesPreparedLegOrder,
} from "../src/domain/execution/prepared-leg-order-proof.js";
import { preparedLegExecutionFixture } from "./fixtures/prepared-leg-execution-fixtures.js";
import { requireDailyFixture as value } from "./fixtures/daily-planning-evidence-fixtures.js";

test("exact provider order terms prove one approved open GTC leg", () => {
  const source = preparedLegExecutionFixture();
  const execution = value(
    createPreparedLegExecution({
      approval: source.approval,
      approvalHash: source.approval.contentHash,
      legId: source.legId,
      now: source.now,
    }),
  );
  const leg = execution.leg.intent;
  const order = value(
    createPreparedLegOrderProof({
      exchangeOrderId: "exchange-order-1",
      clientOrderId: execution.clientOrderId,
      instrument: leg.instrument,
      category: "linear",
      side: "buy",
      requestedQuantity: leg.quantity.toString(),
      filledQuantity: "0",
      status: "open",
      orderType: "limit",
      price: leg.price.toString(),
      timeInForce: "GTC",
      takeProfit: leg.protection!.takeProfit!.toString(),
      stopLoss: null,
      reduceOnly: false,
      positionIdx: 0,
      observedAt: source.now,
      source: "bybit-mainnet/realtime",
    }),
  );
  assert.equal(matchesPreparedLegOrder(order, execution), true);
  assert.equal(order.status, "open");
  assert.equal(order.filledQuantity.isZero(), true);
});

test("missing exchange terms remain unresolved, not request-inferred", () => {
  const source = preparedLegExecutionFixture();
  const execution = value(
    createPreparedLegExecution({
      approval: source.approval,
      approvalHash: source.approval.contentHash,
      legId: source.legId,
      now: source.now,
    }),
  );
  const leg = execution.leg.intent;
  const complete = {
    exchangeOrderId: "exchange-order-1",
    clientOrderId: execution.clientOrderId,
    instrument: leg.instrument,
    category: "linear",
    side: "buy",
    requestedQuantity: leg.quantity.toString(),
    filledQuantity: "0",
    status: "open",
    orderType: "limit",
    price: leg.price.toString(),
    timeInForce: "GTC",
    takeProfit: leg.protection!.takeProfit!.toString(),
    stopLoss: null,
    reduceOnly: false,
    positionIdx: 0,
    observedAt: source.now,
    source: "bybit-mainnet/realtime",
  };
  for (const key of ["price", "timeInForce", "takeProfit", "stopLoss"]) {
    const incomplete = { ...complete } as Record<string, unknown>;
    delete incomplete[key];
    assert.equal(createPreparedLegOrderProof(incomplete).ok, false, key);
  }
  const changed = value(
    createPreparedLegOrderProof({ ...complete, timeInForce: "IOC" }),
  );
  assert.equal(matchesPreparedLegOrder(changed, execution), false);
});
