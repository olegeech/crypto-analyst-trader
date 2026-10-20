import assert from "node:assert/strict";
import test from "node:test";

import { createPreparedLegExecution } from "../src/domain/execution/prepared-leg-execution.js";
import {
  createExchangeOrder,
  type ExchangeOrderObservation,
} from "../src/domain/execution/exchange-order.js";
import {
  derivePreparedLegProtectionCoverage,
  createPreparedLegOrderProof,
  matchesPreparedLegOrder,
  matchesPreparedLegTakeProfitChild,
} from "../src/domain/execution/prepared-leg-order-proof.js";
import { preparedLegExecutionFixture } from "./fixtures/prepared-leg-execution-fixtures.js";
import { requireDailyFixture as value } from "./fixtures/daily-planning-evidence-fixtures.js";
import { DecimalValue } from "../src/domain/shared/decimal.js";

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
      providerTpslMode: "Partial",
      takeProfitTriggerBy: "LastPrice",
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
    providerTpslMode: "Partial",
    takeProfitTriggerBy: "LastPrice",
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
  for (const changedPolicy of [
    { ...complete, providerTpslMode: "Full" },
    { ...complete, takeProfitTriggerBy: "MarkPrice" },
  ]) {
    const proof = value(createPreparedLegOrderProof(changedPolicy));
    assert.equal(matchesPreparedLegOrder(proof, execution), false);
  }
  const missingPolicyEvidence = value(
    createPreparedLegOrderProof({
      ...complete,
      providerTpslMode: undefined,
      takeProfitTriggerBy: undefined,
    }),
  );
  assert.equal(
    matchesPreparedLegOrder(missingPolicyEvidence, execution),
    false,
  );
});

function preparedExecution() {
  const source = preparedLegExecutionFixture();
  return {
    source,
    execution: value(
      createPreparedLegExecution({
        approval: source.approval,
        approvalHash: source.approval.contentHash,
        legId: source.legId,
        now: source.now,
      }),
    ),
  };
}

function takeProfitChild(
  execution: ReturnType<typeof preparedExecution>["execution"],
  overrides: Record<string, unknown> = {},
): ExchangeOrderObservation {
  const intent = execution.leg.intent;
  const input = {
    exchangeOrderId: "tp-child-1",
    // The mapper may retain this compatibility alias, but the proof must use
    // the raw provider link field and the raw parent attribution separately.
    clientOrderId: execution.clientOrderId,
    providerOrderLinkId: "provider-child-link-1",
    parentOrderLinkId: execution.clientOrderId,
    instrument: intent.instrument,
    category: "linear",
    side: "sell",
    requestedQuantity: "0.4",
    filledQuantity: "0.1",
    status: "partially-filled",
    orderType: "market",
    protectionType: "take-profit",
    providerStopOrderType: "PartialTakeProfit",
    providerTpslMode: "Partial",
    triggerBy: "LastPrice",
    takeProfitTriggerBy: "LastPrice",
    triggerPrice: intent.protection!.takeProfit!.toString(),
    reduceOnly: true,
    positionIdx: 0,
    observedAt: execution.approvedAt,
    source: "bybit-mainnet/protection/order/realtime",
    providerCreatedAt: execution.approvedAt,
    providerUpdatedAt: execution.approvedAt,
    ...overrides,
  };
  input.clientOrderId =
    typeof overrides.clientOrderId === "string"
      ? overrides.clientOrderId
      : typeof input.providerOrderLinkId === "string"
        ? input.providerOrderLinkId
        : execution.clientOrderId;
  return value(createExchangeOrder(input));
}

function rawOrderInput(
  order: ExchangeOrderObservation,
): Record<string, unknown> {
  return {
    ...order,
    requestedQuantity: order.requestedQuantity.toString(),
    filledQuantity: order.filledQuantity.toString(),
    ...(order.price === undefined ? {} : { price: order.price.toString() }),
    ...(order.triggerPrice === undefined
      ? {}
      : { triggerPrice: order.triggerPrice.toString() }),
    ...(order.averagePrice === undefined
      ? {}
      : { averagePrice: order.averagePrice.toString() }),
    ...(order.takeProfit === undefined
      ? {}
      : { takeProfit: order.takeProfit?.toString() ?? null }),
    ...(order.stopLoss === undefined
      ? {}
      : { stopLoss: order.stopLoss?.toString() ?? null }),
  };
}

function asOrderObservation(
  input: Record<string, unknown>,
): ExchangeOrderObservation {
  return input as unknown as ExchangeOrderObservation;
}

test("Mainnet Partial TP child proof requires raw parent linkage and exact trigger mechanism", () => {
  const { execution } = preparedExecution();
  const valid = takeProfitChild(execution);
  assert.equal(matchesPreparedLegTakeProfitChild(valid, execution), true);
  assert.equal(
    matchesPreparedLegTakeProfitChild(
      {
        ...rawOrderInput(valid),
        providerStopOrderType: "TakeProfit",
      } as unknown as ExchangeOrderObservation,
      execution,
    ),
    false,
    "Partial mode requires Bybit's PartialTakeProfit child enum",
  );

  const withoutProviderLink: Record<string, unknown> = {
    ...rawOrderInput(valid),
    clientOrderId: execution.clientOrderId,
  };
  delete withoutProviderLink.providerOrderLinkId;
  assert.equal(
    matchesPreparedLegTakeProfitChild(
      asOrderObservation(withoutProviderLink),
      execution,
    ),
    true,
    "an empty raw child orderLinkId is allowed when raw parent linkage exists",
  );
  const withoutParentLink = rawOrderInput(valid);
  delete withoutParentLink.parentOrderLinkId;
  assert.equal(
    matchesPreparedLegTakeProfitChild(
      asOrderObservation(withoutParentLink),
      execution,
    ),
    false,
    "parentOrderLinkId must come from the provider",
  );
  assert.equal(
    matchesPreparedLegTakeProfitChild(
      {
        ...rawOrderInput(valid),
        providerStopOrderType: "StopLoss",
      } as unknown as ExchangeOrderObservation,
      execution,
    ),
    false,
  );
  assert.equal(
    matchesPreparedLegTakeProfitChild(
      {
        ...rawOrderInput(valid),
        triggerBy: "MarkPrice",
      } as unknown as ExchangeOrderObservation,
      execution,
    ),
    false,
  );
  const withoutTpTrigger = rawOrderInput(valid);
  delete withoutTpTrigger.takeProfitTriggerBy;
  assert.equal(
    matchesPreparedLegTakeProfitChild(
      asOrderObservation(withoutTpTrigger),
      execution,
    ),
    false,
    "generic triggerBy cannot stand in for tpTriggerBy",
  );
  const withoutMode = rawOrderInput(valid);
  delete withoutMode.providerTpslMode;
  assert.equal(
    matchesPreparedLegTakeProfitChild(
      asOrderObservation(withoutMode),
      execution,
    ),
    false,
    "tpslMode must be observed on the provider child",
  );
  assert.equal(
    matchesPreparedLegTakeProfitChild(
      {
        ...rawOrderInput(valid),
        source: "bybit-mainnet/protection/request",
      } as unknown as ExchangeOrderObservation,
      execution,
    ),
    false,
  );
});

test("per-leg coverage subtracts attributed exits and sums distinct active child remainders", () => {
  const { execution } = preparedExecution();
  const parent = value(
    createPreparedLegOrderProof({
      exchangeOrderId: "parent-order-1",
      clientOrderId: execution.clientOrderId,
      instrument: execution.leg.intent.instrument,
      category: "linear",
      side: "buy",
      requestedQuantity: execution.leg.intent.quantity.toString(),
      filledQuantity: "0.5",
      status: "partially-filled",
      orderType: "limit",
      price: execution.leg.intent.price.toString(),
      timeInForce: "GTC",
      takeProfit: execution.leg.intent.protection!.takeProfit!.toString(),
      stopLoss: null,
      providerTpslMode: "Partial",
      takeProfitTriggerBy: "LastPrice",
      reduceOnly: false,
      positionIdx: 0,
      observedAt: execution.approvedAt,
      source: "bybit-mainnet/realtime",
    }),
  );
  const entryFill = {
    executionId: "entry-execution-1",
    exchangeOrderId: parent.exchangeOrderId,
    clientOrderId: execution.clientOrderId,
    instrument: execution.leg.intent.instrument,
    side: "buy" as const,
    quantity: value(DecimalValue.fromString("0.5")),
    price: execution.leg.intent.price,
    executedAt: execution.approvedAt,
    source: "bybit-mainnet/execution",
  };
  const childA = takeProfitChild(execution, {
    exchangeOrderId: "tp-child-a",
    requestedQuantity: "0.3",
    filledQuantity: "0.1",
  });
  const childB = takeProfitChild(execution, {
    exchangeOrderId: "tp-child-b",
    providerOrderLinkId: "provider-child-link-b",
    requestedQuantity: "0.2",
    filledQuantity: "0",
    status: "open",
    source: "bybit-mainnet/protection/order/realtime",
  });
  const exitFill = {
    executionId: "exit-execution-1",
    exchangeOrderId: "tp-child-a",
    clientOrderId: execution.clientOrderId,
    instrument: execution.leg.intent.instrument,
    side: "sell" as const,
    quantity: value(DecimalValue.fromString("0.1")),
    price: execution.leg.intent.protection!.takeProfit!,
    executedAt: execution.approvedAt,
    source: "bybit-mainnet/execution",
  };

  const coverage = value(
    derivePreparedLegProtectionCoverage({
      execution,
      parent,
      entryFills: [entryFill, entryFill],
      exitFills: [exitFill, exitFill],
      children: [childA, childB, childA],
      observedAt: execution.approvedAt,
      maxAgeMs: 30_000,
    }),
  );
  assert.equal(coverage.executedEntryQuantity.toString(), "0.5");
  assert.equal(coverage.executedExitQuantity.toString(), "0.1");
  assert.equal(coverage.outstandingQuantity.toString(), "0.4");
  assert.equal(coverage.activeRemainingQuantity.toString(), "0.4");
  assert.deepEqual(coverage.childOrderIds, ["tp-child-a", "tp-child-b"]);
  assert.equal(coverage.covered, true);
});

test("history-only active child cannot prove remaining TP coverage", () => {
  const { execution } = preparedExecution();
  const parent = value(
    createPreparedLegOrderProof({
      exchangeOrderId: "parent-order-active-history",
      clientOrderId: execution.clientOrderId,
      instrument: execution.leg.intent.instrument,
      category: "linear",
      side: "buy",
      requestedQuantity: execution.leg.intent.quantity.toString(),
      filledQuantity: "0.5",
      status: "partially-filled",
      orderType: "limit",
      price: execution.leg.intent.price.toString(),
      timeInForce: "GTC",
      takeProfit: execution.leg.intent.protection!.takeProfit!.toString(),
      stopLoss: null,
      providerTpslMode: "Partial",
      takeProfitTriggerBy: "LastPrice",
      reduceOnly: false,
      positionIdx: 0,
      observedAt: execution.approvedAt,
      source: "bybit-mainnet/realtime",
    }),
  );
  const entryFill = {
    executionId: "entry-history-active-1",
    exchangeOrderId: parent.exchangeOrderId,
    clientOrderId: execution.clientOrderId,
    instrument: execution.leg.intent.instrument,
    side: "buy" as const,
    quantity: value(DecimalValue.fromString("0.5")),
    price: execution.leg.intent.price,
    executedAt: execution.approvedAt,
    source: "bybit-mainnet/execution",
  };
  const historyChild = takeProfitChild(execution, {
    requestedQuantity: "0.5",
    filledQuantity: "0",
    status: "open",
    source: "bybit-mainnet/protection/order/history",
  });
  const coverage = value(
    derivePreparedLegProtectionCoverage({
      execution,
      parent,
      entryFills: [entryFill],
      exitFills: [],
      children: [historyChild],
      observedAt: execution.approvedAt,
      maxAgeMs: 30_000,
    }),
  );

  assert.equal(coverage.activeRemainingQuantity.toString(), "0");
  assert.equal(coverage.covered, false);
  assert.ok(coverage.reasonCodes.includes("CHILD_OBSERVATION_STALE"));
});

test("zero-fill parent permits absent TP child; trigger evidence without exit fill is not closure", () => {
  const { execution } = preparedExecution();
  const parentInput = {
    exchangeOrderId: "parent-order-zero",
    clientOrderId: execution.clientOrderId,
    instrument: execution.leg.intent.instrument,
    category: "linear",
    side: "buy",
    requestedQuantity: execution.leg.intent.quantity.toString(),
    filledQuantity: "0",
    status: "open",
    orderType: "limit",
    price: execution.leg.intent.price.toString(),
    timeInForce: "GTC",
    takeProfit: execution.leg.intent.protection!.takeProfit!.toString(),
    stopLoss: null,
    providerTpslMode: "Partial",
    takeProfitTriggerBy: "LastPrice",
    reduceOnly: false,
    positionIdx: 0,
    observedAt: execution.approvedAt,
    source: "bybit-mainnet/realtime",
  };
  const parent = value(createPreparedLegOrderProof(parentInput));
  const empty = value(
    derivePreparedLegProtectionCoverage({
      execution,
      parent,
      entryFills: [],
      exitFills: [],
      children: [],
      observedAt: execution.approvedAt,
      maxAgeMs: 30_000,
    }),
  );
  assert.equal(empty.outstandingQuantity.isZero(), true);
  assert.equal(empty.covered, true);

  const filledParent = value(
    createPreparedLegOrderProof({
      ...parentInput,
      filledQuantity: "0.5",
      status: "partially-filled",
    }),
  );
  const triggeredButUnfilled = value(
    derivePreparedLegProtectionCoverage({
      execution,
      parent: filledParent,
      entryFills: [
        {
          executionId: "entry-trigger-case",
          exchangeOrderId: parent.exchangeOrderId,
          clientOrderId: execution.clientOrderId,
          instrument: execution.leg.intent.instrument,
          side: "buy",
          quantity: value(DecimalValue.fromString("0.5")),
          price: execution.leg.intent.price,
          executedAt: execution.approvedAt,
          source: "bybit-mainnet/execution",
        },
      ],
      exitFills: [],
      children: [
        takeProfitChild(execution, {
          exchangeOrderId: "tp-triggered-no-fill",
          requestedQuantity: "0.5",
          filledQuantity: "0",
          status: "open",
        }),
      ],
      observedAt: execution.approvedAt,
      maxAgeMs: 30_000,
    }),
  );
  assert.equal(triggeredButUnfilled.outstandingQuantity.toString(), "0.5");
  assert.equal(triggeredButUnfilled.executedExitQuantity.toString(), "0");
  assert.equal(triggeredButUnfilled.covered, true);
});
