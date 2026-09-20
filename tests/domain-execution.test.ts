import assert from "node:assert/strict";
import test from "node:test";

import { createExecutionAttempt } from "../src/domain/execution/execution-attempt.js";
import { createExchangeOrder } from "../src/domain/execution/exchange-order.js";
import { reconcileAttempt } from "../src/domain/execution/reconciliation.js";
import { createPlanFixture } from "./domain-plan-fixture.js";

function attemptFixture(
  planHash: string,
  intentId: string,
  exchangeOrderId = "exchange-1",
) {
  const attempt = createExecutionAttempt({
    attemptId: "attempt-1",
    planHash,
    intentId,
    clientOrderId: "client-1",
    submittedAt: "2026-09-19T10:00:00Z",
    acknowledgement: "pending",
    terminalStatus: "unverified",
    exchangeOrderId,
  });
  assert.equal(attempt.ok, true);
  if (!attempt.ok) throw new Error("attempt fixture");
  return attempt.value;
}

test("attempts preserve plan and intent identity while pending", () => {
  const plan = createPlanFixture();
  const intentId = plan.material.orderIntents[0]?.intentId ?? "fixture-intent";
  const attempt = attemptFixture(plan.materialHash, intentId);
  assert.equal(attempt.acknowledgement, "pending");
  assert.equal(attempt.terminalStatus, "unverified");
  const order = createExchangeOrder({
    exchangeOrderId: "exchange-1",
    clientOrderId: "client-1",
    instrument: "DOGEUSDT",
    side: "buy",
    requestedQuantity: "57",
    filledQuantity: "0",
    status: "open",
    observedAt: "2026-09-19T10:00:01Z",
    source: "fixture",
  });
  assert.equal(order.ok, true);
  if (!order.ok) return;
  const pending = reconcileAttempt(attempt, order.value, plan);
  assert.equal(pending.ok, true);
  if (pending.ok) assert.equal(pending.value.status, "PENDING");
});

test("reconciliation is owned, deterministic and distinguishes full, partial and failed outcomes", () => {
  const plan = createPlanFixture();
  const intentId = plan.material.orderIntents[0]?.intentId ?? "fixture-intent";
  const attempt = attemptFixture(plan.materialHash, intentId);
  for (const [status, filledQuantity, expected] of [
    ["filled", "57", "RECONCILED"],
    ["partially-filled", "10", "PENDING"],
    ["open", "10", "PENDING"],
    ["cancelled", "10", "PARTIAL"],
    ["cancelled", "0", "FAILED"],
  ] as const) {
    const order = createExchangeOrder({
      exchangeOrderId: "exchange-1",
      clientOrderId: "client-1",
      instrument: "DOGEUSDT",
      side: "buy",
      requestedQuantity: "57",
      filledQuantity,
      status,
      observedAt: "2026-09-19T10:00:01Z",
      source: "fixture",
    });
    assert.equal(order.ok, true);
    if (!order.ok) continue;
    const result = reconcileAttempt(attempt, order.value, plan);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value.status, expected);
  }
  const unowned = createExchangeOrder({
    exchangeOrderId: "exchange-unowned",
    clientOrderId: "other-client",
    instrument: "DOGEUSDT",
    side: "buy",
    requestedQuantity: "57",
    filledQuantity: "57",
    status: "filled",
    observedAt: "2026-09-19T10:00:01Z",
    source: "fixture",
  });
  assert.equal(unowned.ok, true);
  if (unowned.ok) {
    const result = reconcileAttempt(attempt, unowned.value, plan);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "OWNERSHIP_MISMATCH");
  }
});

test("missing exchange observation remains unresolved instead of authorizing a retry", () => {
  const plan = createPlanFixture();
  const intentId = plan.material.orderIntents[0]?.intentId ?? "fixture-intent";
  const result = reconcileAttempt(
    attemptFixture(plan.materialHash, intentId),
    undefined,
    plan,
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.status, "UNRESOLVED");
});

test("rejected submissions without an exchange observation reconcile as failed", () => {
  const plan = createPlanFixture();
  const intentId = plan.material.orderIntents[0]?.intentId ?? "fixture-intent";
  const attempt = createExecutionAttempt({
    attemptId: "rejected-attempt",
    planHash: plan.materialHash,
    intentId,
    clientOrderId: "rejected-client",
    submittedAt: "2026-09-19T10:00:00Z",
    acknowledgement: "rejected",
    terminalStatus: "rejected",
  });
  assert.equal(attempt.ok, true);
  if (!attempt.ok) return;
  const result = reconcileAttempt(attempt.value, undefined, plan);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.status, "FAILED");
});

test("accepted submissions with a contradictory rejected terminal status stay unresolved", () => {
  const plan = createPlanFixture();
  const intentId = plan.material.orderIntents[0]?.intentId ?? "fixture-intent";
  const attempt = createExecutionAttempt({
    attemptId: "accepted-but-rejected-attempt",
    planHash: plan.materialHash,
    intentId,
    clientOrderId: "accepted-client",
    submittedAt: "2026-09-19T10:00:00Z",
    acknowledgement: "accepted",
    terminalStatus: "rejected",
  });
  assert.equal(attempt.ok, true);
  if (!attempt.ok) return;
  const result = reconcileAttempt(attempt.value, undefined, plan);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.status, "UNRESOLVED");
});

test("reconciliation rejects an order whose approved intent was mutated", () => {
  const plan = createPlanFixture();
  const intentId = plan.material.orderIntents[0]?.intentId ?? "fixture-intent";
  const order = createExchangeOrder({
    exchangeOrderId: "exchange-mutated",
    clientOrderId: "client-1",
    instrument: "BTCUSDT",
    side: "buy",
    requestedQuantity: "57",
    filledQuantity: "57",
    status: "filled",
    observedAt: "2026-09-19T10:00:01Z",
    source: "fixture",
  });
  assert.equal(order.ok, true);
  if (!order.ok) return;
  const result = reconcileAttempt(
    attemptFixture(plan.materialHash, intentId),
    order.value,
    plan,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "OWNERSHIP_MISMATCH");
});

test("reconciliation rejects a mismatched plan or replacement exchange order", () => {
  const plan = createPlanFixture();
  const intentId = plan.material.orderIntents[0]?.intentId ?? "fixture-intent";
  const order = createExchangeOrder({
    exchangeOrderId: "exchange-2",
    clientOrderId: "client-1",
    instrument: "DOGEUSDT",
    side: "buy",
    requestedQuantity: "57",
    filledQuantity: "57",
    status: "filled",
    observedAt: "2026-09-19T10:00:01Z",
    source: "fixture",
  });
  assert.equal(order.ok, true);
  if (!order.ok) return;

  const wrongPlan = reconcileAttempt(
    attemptFixture(plan.materialHash, intentId),
    order.value,
    {
      materialHash: `sha256:${"3".repeat(64)}`,
      material: { orderIntents: [] },
    } as never,
  );
  assert.equal(wrongPlan.ok, false);
  if (!wrongPlan.ok) assert.equal(wrongPlan.error.code, "INVALID_PLAN");

  const replacement = reconcileAttempt(
    attemptFixture(plan.materialHash, intentId, "exchange-1"),
    order.value,
    plan,
  );
  assert.equal(replacement.ok, false);
  if (!replacement.ok)
    assert.equal(replacement.error.code, "OWNERSHIP_MISMATCH");

  const oldOrder = createExchangeOrder({
    exchangeOrderId: "exchange-old",
    clientOrderId: "client-1",
    instrument: "DOGEUSDT",
    side: "buy",
    requestedQuantity: "57",
    filledQuantity: "57",
    status: "filled",
    observedAt: "2026-09-19T09:59:59Z",
    source: "fixture",
  });
  assert.equal(oldOrder.ok, true);
  if (!oldOrder.ok) return;
  const historical = reconcileAttempt(
    attemptFixture(plan.materialHash, intentId),
    oldOrder.value,
    plan,
  );
  assert.equal(historical.ok, false);
  if (!historical.ok) assert.equal(historical.error.code, "OWNERSHIP_MISMATCH");
});
