import assert from "node:assert/strict";
import test from "node:test";

import { createApproval } from "../src/domain/execution/approval.js";
import { createExecutionAttempt } from "../src/domain/execution/execution-attempt.js";
import { createExchangeOrder } from "../src/domain/execution/exchange-order.js";
import {
  createLifecycleState,
  transitionLifecycle,
} from "../src/domain/execution/lifecycle.js";
import { reconcileAttempt } from "../src/domain/execution/reconciliation.js";
import { fixedClock } from "../src/domain/shared/time.js";
import { createPlanFixture } from "./domain-plan-fixture.js";

function approvalFixture(planHash: string) {
  const approval = createApproval({
    approvalId: "approval-life-1",
    planHash,
    actor: "operator",
    approvedAt: "2026-09-19T10:00:00Z",
    expiresAt: "2026-09-19T10:05:00Z",
  });
  assert.equal(approval.ok, true);
  if (!approval.ok) throw new Error("approval fixture");
  return approval.value;
}

test("lifecycle refuses a structural lookalike instead of a produced plan", () => {
  const plan = createPlanFixture();
  const result = createLifecycleState({
    materialHash: plan.materialHash,
    material: { evidence: plan.material.evidence },
  } as never);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "INVALID_PLAN");
});

test("lifecycle refuses a forged state before any transition or freshness check", () => {
  const plan = createPlanFixture();
  const clock = fixedClock("2026-09-19T10:00:30Z");
  assert.equal(clock.ok, true);
  if (!clock.ok) return;
  const forged = {
    state: "APPROVED" as const,
    planHash: plan.materialHash,
    intentIds: plan.material.orderIntents.map((intent) => intent.intentId),
    evidence: [],
  };
  const result = transitionLifecycle(
    forged,
    { type: "begin-execution" },
    clock.value,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "INVALID_TRANSITION");
});

test("documented lifecycle transitions are deterministic and immutable", () => {
  const plan = createPlanFixture();
  const initial = createLifecycleState(plan);
  const clock = fixedClock("2026-09-19T10:00:30Z");
  assert.equal(initial.ok, true);
  assert.equal(clock.ok, true);
  if (!initial.ok || !clock.ok) return;
  const validated = transitionLifecycle(
    initial.value,
    { type: "validate" },
    clock.value,
  );
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  const ready = transitionLifecycle(
    validated.value,
    { type: "ready-for-approval" },
    clock.value,
  );
  assert.equal(ready.ok, true);
  if (!ready.ok) return;
  const approved = transitionLifecycle(
    ready.value,
    { type: "approve", approval: approvalFixture(plan.materialHash) },
    clock.value,
  );
  assert.equal(approved.ok, true);
  if (!approved.ok) return;
  assert.equal(approved.value.state, "APPROVED");
  const executing = transitionLifecycle(
    approved.value,
    { type: "begin-execution" },
    clock.value,
  );
  assert.equal(executing.ok, true);
  if (!executing.ok) return;
  const pending = transitionLifecycle(
    executing.value,
    { type: "mark-pending-reconciliation" },
    clock.value,
  );
  assert.equal(pending.ok, true);
  if (!pending.ok) return;
  const intentId = plan.material.orderIntents[0]?.intentId ?? "fixture-intent";
  const attempt = createExecutionAttempt({
    attemptId: "lifecycle-attempt",
    planHash: plan.materialHash,
    intentId,
    clientOrderId: "lifecycle-client",
    exchangeOrderId: "lifecycle-exchange",
    submittedAt: "2026-09-19T10:00:30Z",
    acknowledgement: "accepted",
    terminalStatus: "filled",
  });
  const order = createExchangeOrder({
    exchangeOrderId: "lifecycle-exchange",
    clientOrderId: "lifecycle-client",
    instrument: "DOGEUSDT",
    side: "buy",
    requestedQuantity: "57",
    filledQuantity: "57",
    status: "filled",
    observedAt: "2026-09-19T10:00:31Z",
    source: "fixture",
  });
  assert.equal(attempt.ok, true);
  assert.equal(order.ok, true);
  if (!attempt.ok || !order.ok) return;
  const reconciliation = reconcileAttempt(attempt.value, order.value, plan);
  assert.equal(reconciliation.ok, true);
  if (!reconciliation.ok) return;
  const reconciled = transitionLifecycle(
    pending.value,
    { type: "reconcile", results: [reconciliation.value] },
    clock.value,
  );
  assert.equal(reconciled.ok, true);
  if (reconciled.ok) assert.equal(reconciled.value.state, "RECONCILED");
  assert.equal(initial.value.state, "DRAFT");
  assert.equal(Object.isFrozen(approved.value), true);
});

test("lifecycle cannot close while reconciliation is unresolved", () => {
  const plan = createPlanFixture();
  const initial = createLifecycleState(plan);
  const clock = fixedClock("2026-09-19T10:00:30Z");
  assert.equal(initial.ok, true);
  assert.equal(clock.ok, true);
  if (!initial.ok || !clock.ok) return;
  const validated = transitionLifecycle(
    initial.value,
    { type: "validate" },
    clock.value,
  );
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  const ready = transitionLifecycle(
    validated.value,
    { type: "ready-for-approval" },
    clock.value,
  );
  assert.equal(ready.ok, true);
  if (!ready.ok) return;
  const approved = transitionLifecycle(
    ready.value,
    { type: "approve", approval: approvalFixture(plan.materialHash) },
    clock.value,
  );
  assert.equal(approved.ok, true);
  if (!approved.ok) return;
  const executing = transitionLifecycle(
    approved.value,
    { type: "begin-execution" },
    clock.value,
  );
  assert.equal(executing.ok, true);
  if (!executing.ok) return;
  const pending = transitionLifecycle(
    executing.value,
    { type: "mark-pending-reconciliation" },
    clock.value,
  );
  assert.equal(pending.ok, true);
  if (!pending.ok) return;
  const intentId = plan.material.orderIntents[0]?.intentId ?? "fixture-intent";
  const attempt = createExecutionAttempt({
    attemptId: "unresolved-attempt",
    planHash: plan.materialHash,
    intentId,
    clientOrderId: "unresolved-client",
    submittedAt: "2026-09-19T10:00:30Z",
    acknowledgement: "pending",
    terminalStatus: "unverified",
  });
  assert.equal(attempt.ok, true);
  if (!attempt.ok) return;
  const unresolved = reconcileAttempt(attempt.value, undefined, plan);
  assert.equal(unresolved.ok, true);
  if (!unresolved.ok) return;
  const result = transitionLifecycle(
    pending.value,
    { type: "reconcile", results: [unresolved.value] },
    clock.value,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "UNRESOLVED_RECONCILIATION");
});

test("unsupported transitions and expired approvals fail closed", () => {
  const plan = createPlanFixture();
  const initial = createLifecycleState(plan);
  const clock = fixedClock("2026-09-19T10:01:00Z");
  assert.equal(initial.ok, true);
  assert.equal(clock.ok, true);
  if (!initial.ok || !clock.ok) return;
  const invalid = transitionLifecycle(
    initial.value,
    { type: "begin-execution" },
    clock.value,
  );
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.error.code, "UNSUPPORTED_TRANSITION");

  const validated = transitionLifecycle(
    initial.value,
    { type: "validate" },
    clock.value,
  );
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  const ready = transitionLifecycle(
    validated.value,
    { type: "ready-for-approval" },
    clock.value,
  );
  assert.equal(ready.ok, true);
  if (!ready.ok) return;
  const approved = transitionLifecycle(
    ready.value,
    { type: "approve", approval: approvalFixture(plan.materialHash) },
    clock.value,
  );
  assert.equal(approved.ok, true);
  if (!approved.ok) return;
  const expiredClock = fixedClock("2026-09-19T10:05:00Z");
  assert.equal(expiredClock.ok, true);
  if (!expiredClock.ok) return;
  const expired = transitionLifecycle(
    approved.value,
    { type: "begin-execution" },
    expiredClock.value,
  );
  assert.equal(expired.ok, false);
  if (!expired.ok) assert.equal(expired.error.code, "PLAN_EXPIRED");
  const marked = transitionLifecycle(
    approved.value,
    { type: "expire" },
    expiredClock.value,
  );
  assert.equal(marked.ok, true);
  if (marked.ok) assert.equal(marked.value.state, "EXPIRED");
});

test("execution refuses an otherwise valid approval after evidence expires", () => {
  const plan = createPlanFixture();
  const initial = createLifecycleState(plan);
  const approval = createApproval({
    approvalId: "approval-stale-evidence",
    planHash: plan.materialHash,
    actor: "operator",
    approvedAt: "2026-09-19T10:00:00Z",
    expiresAt: "2026-09-19T10:10:00Z",
  });
  const clock = fixedClock("2026-09-19T10:01:00Z");
  assert.equal(initial.ok, true);
  assert.equal(approval.ok, true);
  assert.equal(clock.ok, true);
  if (!initial.ok || !approval.ok || !clock.ok) return;
  const validated = transitionLifecycle(
    initial.value,
    { type: "validate" },
    clock.value,
  );
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  const ready = transitionLifecycle(
    validated.value,
    { type: "ready-for-approval" },
    clock.value,
  );
  assert.equal(ready.ok, true);
  if (!ready.ok) return;
  const approved = transitionLifecycle(
    ready.value,
    { type: "approve", approval: approval.value },
    clock.value,
  );
  assert.equal(approved.ok, true);
  if (!approved.ok) return;
  const staleClock = fixedClock("2026-09-19T10:01:00.001Z");
  assert.equal(staleClock.ok, true);
  if (!staleClock.ok) return;
  const executing = transitionLifecycle(
    approved.value,
    { type: "begin-execution" },
    staleClock.value,
  );
  assert.equal(executing.ok, false);
  if (!executing.ok) assert.equal(executing.error.code, "STALE_EVIDENCE");
});

test("expire refuses before the approval deadline with a transition error", () => {
  const plan = createPlanFixture();
  const initial = createLifecycleState(plan);
  const approval = createApproval({
    approvalId: "approval-premature-expiry",
    planHash: plan.materialHash,
    actor: "operator",
    approvedAt: "2026-09-19T10:00:00Z",
    expiresAt: "2026-09-19T10:10:00Z",
  });
  const clock = fixedClock("2026-09-19T10:01:00Z");
  assert.equal(initial.ok, true);
  assert.equal(approval.ok, true);
  assert.equal(clock.ok, true);
  if (!initial.ok || !approval.ok || !clock.ok) return;
  const validated = transitionLifecycle(
    initial.value,
    { type: "validate" },
    clock.value,
  );
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  const ready = transitionLifecycle(
    validated.value,
    { type: "ready-for-approval" },
    clock.value,
  );
  assert.equal(ready.ok, true);
  if (!ready.ok) return;
  const approved = transitionLifecycle(
    ready.value,
    { type: "approve", approval: approval.value },
    clock.value,
  );
  assert.equal(approved.ok, true);
  if (!approved.ok) return;
  const expired = transitionLifecycle(
    approved.value,
    { type: "expire" },
    clock.value,
  );
  assert.equal(expired.ok, false);
  if (!expired.ok) assert.equal(expired.error.code, "UNSUPPORTED_TRANSITION");
});
