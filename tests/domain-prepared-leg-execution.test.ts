import assert from "node:assert/strict";
import test from "node:test";

import {
  createPreparedLegExecution,
  createPreparedLegGridExecution,
  derivePreparedLegExecutionIdentity,
  derivePreparedLegSourceIdentity,
  derivePreparedLegSourceId,
  validatePreparedLegGridShape,
} from "../src/domain/execution/prepared-leg-execution.js";
import { createPreparedPlanApproval } from "../src/domain/review/prepared-plan-approval.js";
import { hashCanonical } from "../src/domain/identity/canonical-serialization.js";
import { rehydratePreparedDailyPlan } from "../src/domain/review/prepared-daily-plan.js";
import {
  PREPARED_LEG_FOUR_LEVELS,
  preparedLegExecutionFixture,
} from "./fixtures/prepared-leg-execution-fixtures.js";

function value<T>(
  result: { ok: true; value: T } | { ok: false; error: unknown },
): T {
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("fixture construction failed");
  return result.value;
}

function legacyV1Plan(current: Record<string, any>) {
  const { protectionPolicy: _policy, ...legacyReplayInputs } =
    current.replayInputs;
  const { protectionPolicyHash: _policyHash, ...legacyInputIdentity } =
    current.inputIdentity;
  const { protectionVersion: _version, ...legacyPolicies } =
    current.summary.policies;
  void _policy;
  void _policyHash;
  void _version;
  const id = value(
    hashCanonical({
      schemaVersion: "prepared-daily-plan-id/v1",
      inputIdentity: legacyInputIdentity,
    }),
  );
  const payload = {
    ...current,
    schemaVersion: "prepared-daily-plan/v1",
    preparedPlanId: `prepared-daily-plan:${id}`,
    inputIdentity: legacyInputIdentity,
    replayInputs: legacyReplayInputs,
    summary: {
      ...current.summary,
      policies: legacyPolicies,
    },
  };
  const { contentHash: _contentHash, ...withoutHash } = payload as Record<
    string,
    any
  >;
  void _contentHash;
  return { ...withoutHash, contentHash: value(hashCanonical(withoutHash)) };
}

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
  assert.deepEqual(
    (result.value.leg.intent.protection as unknown as Record<string, unknown>)
      ?.takeProfitPolicy,
    {
      policyVersion: "m1-mainnet-per-leg-tp/v1",
      tpslMode: "Partial",
      orderType: "Market",
      triggerBy: "LastPrice",
    },
  );
  assert.deepEqual(
    (source.prepared.replayInputs as unknown as Record<string, unknown>)
      .protectionPolicy,
    {
      schemaVersion: "prepared-protection-policy/v1",
      policyVersion: "m1-mainnet-per-leg-tp/v1",
      environment: "mainnet",
      entry: { orderType: "Limit", timeInForce: "GTC" },
      takeProfit: {
        tpslMode: "Partial",
        orderType: "Market",
        triggerBy: "LastPrice",
      },
      stopLoss: "none",
    },
  );
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

test("legacy v1 artifacts retain hashes and recovery identities but cannot authorize new protection", () => {
  const source = preparedLegExecutionFixture();
  const legacy = legacyV1Plan(
    source.prepared as unknown as Record<string, any>,
  );
  assert.equal(
    legacy.contentHash,
    "sha256:b80d08057ef0e72a52db82677d6de33551070ed1c19afa2abc6c054ab5226b68",
  );
  const prepared = value(rehydratePreparedDailyPlan(legacy));
  assert.equal(prepared.contentHash, legacy.contentHash);

  const approval = value(
    createPreparedPlanApproval({
      prepared,
      preparedHash: prepared.contentHash,
      actor: source.approval.actor,
      consent: true,
      approvedAt: source.approval.approvedAt,
      note: source.approval.note,
    }),
  );
  assert.equal(
    approval.contentHash,
    "sha256:f2d857f53ca8fb89644a5e651cf19248f2834a8a24a8661a6f742e1b919a03b7",
  );

  const recoveredExecution = value(
    derivePreparedLegExecutionIdentity({
      approval,
      approvalHash: approval.contentHash,
      legId: source.legId,
    }),
  );
  assert.equal(
    recoveredExecution.clientOrderId,
    "m1-cb9881dd57342aa65a67bdd2810149e5",
  );
  assert.equal(
    createPreparedLegExecution({
      approval,
      approvalHash: approval.contentHash,
      legId: source.legId,
      now: source.now,
    }).ok,
    false,
  );

  const sourceIdentity = value(
    derivePreparedLegSourceIdentity({
      prepared,
      preparedHash: prepared.contentHash,
      legId: source.legId,
      accountIdentityHash: prepared.inputIdentity.accountIdentityHash,
    }),
  );
  assert.equal(
    sourceIdentity.clientOrderId,
    "m1-cb9881dd57342aa65a67bdd2810149e5",
  );
  assert.equal(
    value(
      derivePreparedLegSourceId(
        sourceIdentity.accountIdentityHash,
        sourceIdentity.preparedHash,
        sourceIdentity.leg.legId,
      ),
    ),
    "prepared-leg:2d5ead6221e1555b11551f480aef02cbe197fe57",
  );
  const newlyPrepared = createPreparedLegExecution({
    approval: source.approval,
    approvalHash: source.approval.contentHash,
    legId: source.legId,
    now: source.now,
  });
  assert.equal(newlyPrepared.ok, true);
  if (newlyPrepared.ok)
    assert.equal(newlyPrepared.value.preparedHash, source.prepared.contentHash);
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
