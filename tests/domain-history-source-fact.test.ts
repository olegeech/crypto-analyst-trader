import assert from "node:assert/strict";
import test from "node:test";
import { createHistorySourceFact } from "../src/domain/accounting/history-source-fact.js";

const order = {
  factKind: "order" as const,
  source: "order-history" as const,
  providerEventTime: "2026-10-20T12:00:00.000Z",
  providerRevisionTime: "2026-10-20T12:01:00.000Z",
  collectedAt: "2026-10-27T10:00:00.000Z",
  category: "linear",
  symbol: "DOGEUSDT",
  orderId: "order-1",
  orderLinkId: null,
  parentOrderLinkId: null,
  side: "Buy",
  orderType: "Limit",
  orderStatus: "PartiallyFilled",
  timeInForce: "GTC",
  qty: "1",
  price: "0.07699",
  avgPrice: "0.07699",
  cumExecQty: "0.4",
  cumExecValue: "0.030796",
  cumExecFee: null,
  feeDetails: [],
  leavesQty: "0.6",
  leavesValue: "0.046194",
  createType: null,
  cancelType: null,
  rejectReason: null,
  tpslMode: null,
  tpTriggerBy: null,
  slTriggerBy: null,
  triggerBy: null,
  triggerPrice: null,
  takeProfit: null,
  stopLoss: null,
  stopOrderType: null,
  marketUnit: null,
  isLeverage: null,
  blockTradeId: null,
  reduceOnly: false,
  closeOnTrigger: false,
  positionIdx: "0",
};

test("history source fact hash is semantic and excludes collection time", () => {
  const first = createHistorySourceFact(order);
  const replay = createHistorySourceFact({
    ...order,
    collectedAt: "2026-10-27T10:05:00.000Z",
  });
  assert.equal(first.ok, true);
  assert.equal(replay.ok, true);
  if (!first.ok || !replay.ok) return;
  assert.equal(first.value.contentHash, replay.value.contentHash);
  assert.notEqual(first.value.collectedAt, replay.value.collectedAt);
  assert.equal(first.value.providerEventTime, order.providerEventTime);
  assert.ok(first.value.factKind === "order");
  if (first.value.factKind !== "order") return;
  assert.equal(first.value.orderLinkId, null);
  assert.ok(Object.isFrozen(first.value));
  assert.ok(Object.isFrozen(first.value.feeDetails));
});

test("closed-PnL identity remains a grouping key, not a claimed provider row ID", () => {
  const fact = createHistorySourceFact({
    factKind: "closed-pnl",
    source: "closed-pnl",
    providerEventTime: "2026-10-20T12:00:00.000Z",
    providerRevisionTime: "2026-10-20T12:01:00.000Z",
    collectedAt: "2026-10-27T10:00:00.000Z",
    category: "linear",
    symbol: "DOGEUSDT",
    orderId: "close-1",
    side: "Sell",
    orderType: "Market",
    execType: "Trade",
    qty: "0.4",
    orderPrice: "0.07715",
    closedSize: "0.4",
    cumEntryValue: "0.030796",
    avgEntryPrice: "0.07699",
    cumExitValue: "0.03086",
    avgExitPrice: "0.07715",
    closedPnl: "0.000064",
    openFee: null,
    closeFee: null,
    fundingFee: null,
    fillCount: "1",
    leverage: "1",
  });
  assert.equal(fact.ok, true);
  if (!fact.ok) return;
  assert.ok(fact.value.factKind === "closed-pnl");
  if (fact.value.factKind !== "closed-pnl") return;
  assert.deepEqual(fact.value.groupingKey, {
    category: "linear",
    symbol: "DOGEUSDT",
    orderId: "close-1",
    createdTime: "2026-10-20T12:00:00.000Z",
  });
  assert.equal("providerId" in fact.value, false);
});

test("malformed source IDs, timestamps and exact decimals are rejected", () => {
  assert.equal(
    createHistorySourceFact({ ...order, orderId: "" }).ok,
    false,
  );
  assert.equal(
    createHistorySourceFact({
      ...order,
      providerEventTime: "yesterday",
    }).ok,
    false,
  );
  assert.equal(createHistorySourceFact({ ...order, qty: "1e-3" }).ok, false);
});
