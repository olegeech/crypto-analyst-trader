import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeCanonicalArtifact,
  encodeCanonicalArtifact,
  rehydrateArtifact,
} from "../src/domain/identity/canonical-artifact.js";
import { createApproval } from "../src/domain/execution/approval.js";
import { createClearanceEvidence } from "../src/domain/execution/clearance-evidence.js";
import { createExecutionAttempt } from "../src/domain/execution/execution-attempt.js";
import { createExchangeOrder } from "../src/domain/execution/exchange-order.js";
import { createLifecycleState } from "../src/domain/execution/lifecycle.js";
import { reconcileAttempt } from "../src/domain/execution/reconciliation.js";
import { createFee } from "../src/domain/accounting/fee.js";
import { createFill } from "../src/domain/accounting/fill.js";
import { createFunding } from "../src/domain/accounting/funding.js";
import { createLedgerEntry } from "../src/domain/accounting/ledger-entry.js";
import { createCapabilityObservation } from "../src/domain/capabilities/capability.js";
import { createPlanFixture } from "./domain-plan-fixture.js";

test("artifact/v1 round-trips a produced execution plan", () => {
  const plan = createPlanFixture();
  const encoded = encodeCanonicalArtifact("execution-plan", plan);
  assert.equal(encoded.ok, true);
  if (!encoded.ok) return;

  assert.equal(encoded.value.schemaVersion, "artifact/v1");
  assert.equal(encoded.value.artifactKind, "execution-plan");

  const decoded = decodeCanonicalArtifact(encoded.value, "execution-plan");
  assert.equal(decoded.ok, true);
  const rehydrated = rehydrateArtifact("execution-plan", encoded.value);
  assert.equal(rehydrated.ok, true);
  if (!rehydrated.ok) return;
  assert.equal(rehydrated.value.planId, plan.planId);
  assert.equal(rehydrated.value.materialHash, plan.materialHash);
  assert.equal(
    rehydrated.value.material.orderIntents[0]?.quantity.toString(),
    plan.material.orderIntents[0]?.quantity.toString(),
  );
});

test("artifact decoder rejects unknown versions and envelope fields", () => {
  const plan = createPlanFixture();
  const encoded = encodeCanonicalArtifact("execution-plan", plan);
  assert.equal(encoded.ok, true);
  if (!encoded.ok) return;

  const future = decodeCanonicalArtifact(
    { ...encoded.value, schemaVersion: "artifact/v2" },
    "execution-plan",
  );
  assert.equal(future.ok, false);

  const extraField = decodeCanonicalArtifact(
    { ...encoded.value, unexpected: true },
    "execution-plan",
  );
  assert.equal(extraField.ok, false);
});

test("artifact decoder rejects tampered canonical bytes and unknown payload fields", () => {
  const plan = createPlanFixture();
  const encoded = encodeCanonicalArtifact("execution-plan", plan);
  assert.equal(encoded.ok, true);
  if (!encoded.ok) return;

  const tampered = decodeCanonicalArtifact(
    {
      ...encoded.value,
      canonicalJson: encoded.value.canonicalJson.replace(
        plan.planId,
        "plan-tampered",
      ),
    },
    "execution-plan",
  );
  assert.equal(tampered.ok, false);

  const payload = JSON.parse(encoded.value.canonicalJson) as Record<
    string,
    unknown
  >;
  payload.unexpected = "must fail";
  const payloadJson = JSON.stringify(payload);
  const unknownProperty = decodeCanonicalArtifact(
    {
      ...encoded.value,
      canonicalJson: payloadJson,
      canonicalHash: encoded.value.canonicalHash,
    },
    "execution-plan",
  );
  assert.equal(unknownProperty.ok, false);
});

test("rehydrates the execution and accounting artifact graph through domain constructors", () => {
  const plan = createPlanFixture();
  const intent = plan.material.orderIntents[0];
  const evidence = plan.material.evidence[0];
  assert.ok(intent);
  assert.ok(evidence);

  const approval = createApproval({
    approvalId: "persistence-approval",
    planHash: plan.materialHash,
    actor: "operator",
    approvedAt: "2026-09-19T10:00:00Z",
    expiresAt: "2026-09-19T10:05:00Z",
  });
  const lifecycle = createLifecycleState(plan);
  const attempt = createExecutionAttempt({
    attemptId: "persistence-attempt",
    planHash: plan.materialHash,
    intentId: intent.intentId,
    clientOrderId: "persistence-client",
    exchangeOrderId: "persistence-exchange",
    submittedAt: "2026-09-19T10:00:00Z",
    acknowledgement: "accepted",
    terminalStatus: "filled",
  });
  const order = createExchangeOrder({
    exchangeOrderId: "persistence-exchange",
    clientOrderId: "persistence-client",
    instrument: intent.instrument,
    side: intent.side,
    requestedQuantity: intent.quantity.toString(),
    filledQuantity: intent.quantity.toString(),
    status: "filled",
    observedAt: "2026-09-19T10:00:01Z",
    source: "fixture",
    parentOrderLinkId: "persistence-client",
  });
  assert.equal(approval.ok, true);
  assert.equal(lifecycle.ok, true);
  assert.equal(attempt.ok, true);
  assert.equal(order.ok, true);
  if (!approval.ok || !lifecycle.ok || !attempt.ok || !order.ok) return;
  const reconciliation = reconcileAttempt(attempt.value, order.value, plan);
  assert.equal(reconciliation.ok, true);
  if (!reconciliation.ok) return;

  const capability = createCapabilityObservation({
    capability: "order-create",
    status: "supported",
    observedAt: evidence.asOf,
    source: "fixture",
    evidence,
    scope: plan.material.executionScope,
  });
  const fill = createFill({
    fillId: "persistence-fill",
    attemptId: attempt.value.attemptId,
    exchangeOrderId: order.value.exchangeOrderId,
    instrument: intent.instrument,
    side: intent.side,
    quantity: intent.quantity.toString(),
    price: intent.price.toString(),
    executedAt: "2026-09-19T10:00:01Z",
    source: "fixture",
  });
  const fee = createFee({
    feeId: "persistence-fee",
    amount: "0.001",
    currency: "USDT",
    kind: "trading",
    chargedAt: "2026-09-19T10:00:01Z",
    source: "fixture",
  });
  const funding = createFunding({
    fundingId: "persistence-funding",
    amount: "-0.02",
    currency: "USDT",
    occurredAt: "2026-09-19T10:00:01Z",
    source: "fixture",
  });
  const ledgerEntry = createLedgerEntry({
    entryId: "persistence-ledger",
    kind: "fill",
    amount: "5.0559",
    currency: "USDT",
    occurredAt: "2026-09-19T10:00:01Z",
    source: "fixture",
    referenceId: fill.ok ? fill.value.fillId : "persistence-fill",
  });
  const clearance = createClearanceEvidence({
    evidenceVersion: "clearance/v1",
    actor: "operator",
    source: "manual-reconciliation",
    timestamp: "2026-09-19T10:01:00Z",
    reason: "all owned intents reconciled",
    affectedLineageRevision: 1,
    affectedReconciliationRevision: 2,
  });
  assert.equal(capability.ok, true);
  assert.equal(fill.ok, true);
  assert.equal(fee.ok, true);
  assert.equal(funding.ok, true);
  assert.equal(ledgerEntry.ok, true);
  assert.equal(clearance.ok, true);

  const artifacts = [
    ["evidence-ref", evidence],
    ["capability-observation", capability.ok ? capability.value : undefined],
    ["market-snapshot", plan.material.marketSnapshot],
    ["account-snapshot", plan.material.accountSnapshot],
    ["order-intent", intent],
    ["risk-decision", plan.material.riskDecision],
    ["execution-plan", plan],
    ["approval", approval.value],
    ["lifecycle-state", lifecycle.value],
    ["execution-attempt", attempt.value],
    ["exchange-order", order.value],
    ["reconciliation-result", reconciliation.value],
    ["fill", fill.ok ? fill.value : undefined],
    ["fee", fee.ok ? fee.value : undefined],
    ["funding", funding.ok ? funding.value : undefined],
    ["ledger-entry", ledgerEntry.ok ? ledgerEntry.value : undefined],
    ["clearance-evidence", clearance.ok ? clearance.value : undefined],
  ] as const;
  for (const [kind, value] of artifacts) {
    assert.ok(value, kind);
    const encoded = encodeCanonicalArtifact(kind, value);
    assert.equal(encoded.ok, true, kind);
    if (!encoded.ok) continue;
    const rehydrated = rehydrateArtifact(kind, encoded.value);
    assert.equal(rehydrated.ok, true, kind);
  }
});

test("exchange-order artifacts retain an exact protective parent identity", () => {
  const order = createExchangeOrder({
    exchangeOrderId: "child-exchange",
    clientOrderId: "child-client",
    parentOrderLinkId: "entry-client",
    instrument: "DOGEUSDT",
    side: "sell",
    requestedQuantity: "57",
    filledQuantity: "0",
    status: "open",
    observedAt: "2026-09-19T10:00:01Z",
    source: "fixture",
  });
  assert.equal(order.ok, true);
  if (!order.ok) return;
  const encoded = encodeCanonicalArtifact("exchange-order", order.value);
  assert.equal(encoded.ok, true);
  if (!encoded.ok) return;
  const rehydrated = rehydrateArtifact("exchange-order", encoded.value);
  assert.equal(rehydrated.ok, true);
  if (rehydrated.ok) {
    assert.equal(rehydrated.value.parentOrderLinkId, "entry-client");
  }
});
