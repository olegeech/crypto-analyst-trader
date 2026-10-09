import assert from "node:assert/strict";
import test from "node:test";

import { createPreparedLegExecution } from "../src/domain/execution/prepared-leg-execution.js";
import { preparedLegExecutionFixture } from "./fixtures/prepared-leg-execution-fixtures.js";

test("an exact unexpired approval selects only its immutable ADD leg", () => {
  const source = preparedLegExecutionFixture();
  assert.equal(source.prepared.state, "REVIEW");
  assert.equal(source.prepared.inputIdentity.environment, "mainnet");
  assert.equal(source.prepared.replayInputs.preflight.verdict, "PASS");
  const result = createPreparedLegExecution({
    approval: source.approval,
    approvalHash: source.approval.contentHash,
    legId: source.legId,
    now: source.now,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.preparedHash, source.prepared.contentHash);
  assert.equal(result.value.approvalHash, source.approval.contentHash);
  assert.equal(result.value.leg.legId, source.legId);
  assert.equal(result.value.leg.intent.side, "buy");
  assert.equal(result.value.leg.intent.positionEffect, "open");
  assert.equal(result.value.leg.intent.protection?.stopLoss, undefined);
  assert.ok(result.value.leg.intent.protection?.takeProfit);
});

test("approval hash, expiry, plan state and selected leg fail closed", () => {
  const source = preparedLegExecutionFixture();
  const valid = {
    approval: source.approval,
    approvalHash: source.approval.contentHash,
    legId: source.legId,
    now: source.now,
  };
  for (const input of [
    { ...valid, approvalHash: `sha256:${"0".repeat(64)}` },
    { ...valid, legId: "daily-leg:not-approved" },
    { ...valid, now: source.approval.expiresAt },
    { ...valid, terms: { price: "1", quantity: "999" } },
  ])
    assert.equal(createPreparedLegExecution(input).ok, false);
});
