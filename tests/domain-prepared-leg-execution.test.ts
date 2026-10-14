import assert from "node:assert/strict";
import test from "node:test";

import {
  createPreparedLegExecution,
  createPreparedLegGridExecution,
  validatePreparedLegGridShape,
} from "../src/domain/execution/prepared-leg-execution.js";
import { createPreparedPlanApproval } from "../src/domain/review/prepared-plan-approval.js";
import {
  PREPARED_LEG_FOUR_LEVELS,
  preparedLegExecutionFixture,
} from "./fixtures/prepared-leg-execution-fixtures.js";

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

test("an exact approval admits the whole canonical grid in index order", () => {
  const source = preparedLegExecutionFixture({
    planningLevels: PREPARED_LEG_FOUR_LEVELS,
  });
  const result = createPreparedLegGridExecution({
    approval: source.approval,
    approvalHash: source.approval.contentHash,
    now: source.now,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.approvalHash, source.approval.contentHash);
  assert.equal(result.value.preparedHash, source.prepared.contentHash);
  assert.deepEqual(
    result.value.legs.map(({ execution }) => execution.leg.index),
    [0, 1, 2, 3],
  );
  assert.deepEqual(
    result.value.legs.map(({ execution }) => execution.leg.legId),
    source.prepared.replayInputs.preflight.replayInputs.dailyPlan.candidateLegs?.map(
      (leg) => leg.legId,
    ),
  );
  assert.equal(new Set(result.value.legs.map((leg) => leg.sourceId)).size, 4);
  assert.equal(
    new Set(result.value.legs.map(({ execution }) => execution.clientOrderId))
      .size,
    4,
  );
  assert.ok(
    result.value.legs.every(
      ({ execution }) =>
        execution.approvalHash === source.approval.contentHash &&
        execution.leg.timeInForce === "GTC" &&
        execution.leg.intent.protection?.takeProfit !== undefined &&
        execution.leg.intent.protection.stopLoss === undefined,
    ),
  );
});

test("grid admission rejects expired or caller-selected subsets of approval", () => {
  const source = preparedLegExecutionFixture({
    planningLevels: PREPARED_LEG_FOUR_LEVELS,
  });
  const valid = {
    approval: source.approval,
    approvalHash: source.approval.contentHash,
    now: source.now,
  };
  for (const input of [
    { ...valid, approvalHash: `sha256:${"0".repeat(64)}` },
    {
      ...valid,
      now: source.approval.expiresAt,
    },
    {
      ...valid,
      legIds: [
        source.prepared.replayInputs.preflight.replayInputs.dailyPlan
          .candidateLegs![0]!.legId,
      ],
    },
  ])
    assert.equal(createPreparedLegGridExecution(input).ok, false);

  const renewed = createPreparedPlanApproval({
    prepared: source.prepared,
    preparedHash: source.prepared.contentHash,
    actor: source.approval.actor,
    consent: true,
    approvedAt: "2026-09-24T14:00:08.000Z",
    note: source.approval.note,
  });
  assert.equal(renewed.ok, true);
  if (!renewed.ok) return;
  const first = createPreparedLegGridExecution(valid);
  const second = createPreparedLegGridExecution({
    approval: renewed.value,
    approvalHash: renewed.value.contentHash,
    now: "2026-09-24T14:00:09.000Z",
  });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.notEqual(first.value.approvalHash, second.value.approvalHash);
  assert.deepEqual(
    second.value.legs.map(({ sourceId }) => sourceId),
    first.value.legs.map(({ sourceId }) => sourceId),
  );
  assert.deepEqual(
    second.value.legs.map(({ execution }) => execution.clientOrderId),
    first.value.legs.map(({ execution }) => execution.clientOrderId),
  );
});

test("grid shape requires unique identities and consecutive bounded indices", () => {
  const source = preparedLegExecutionFixture({
    planningLevels: PREPARED_LEG_FOUR_LEVELS,
  });
  const legs =
    source.prepared.replayInputs.preflight.replayInputs.dailyPlan
      .candidateLegs!;
  assert.equal(validatePreparedLegGridShape(legs).ok, true);
  assert.equal(validatePreparedLegGridShape([legs[0], legs[0]]).ok, false);
  assert.equal(
    validatePreparedLegGridShape([
      legs[0],
      { ...legs[1]!, index: 3 },
      legs[2],
      legs[3],
    ]).ok,
    false,
  );
  assert.equal(validatePreparedLegGridShape([]).ok, false);
  assert.equal(
    validatePreparedLegGridShape(
      Array.from({ length: 65 }, (_, index) => ({
        ...legs[0]!,
        legId: `test-leg:${index}`,
        index,
      })),
    ).ok,
    false,
  );
});
