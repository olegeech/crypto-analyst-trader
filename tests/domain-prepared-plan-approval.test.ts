import assert from "node:assert/strict";
import test from "node:test";
import {
  createPreparedPlanApproval,
  rehydratePreparedPlanApproval,
  validatePreparedPlanApproval,
} from "../src/domain/review/prepared-plan-approval.js";
import { preparedPlanFixture } from "./fixtures/prepared-plan-fixtures.js";
import { requireDailyFixture as value } from "./fixtures/daily-planning-evidence-fixtures.js";
import { hashCanonical } from "../src/domain/identity/canonical-serialization.js";
import { createApproval } from "../src/domain/execution/approval.js";
import { createPreparedDailyPlan } from "../src/domain/review/prepared-daily-plan.js";

function input(state: "ready" | "review" | "blocked" = "ready") {
  const prepared = preparedPlanFixture(state);
  return {
    prepared,
    preparedHash: prepared.contentHash,
    actor: "local-operator:fixture",
    consent: true,
    approvedAt: "2026-09-24T14:02:00.000Z",
    note: null,
  };
}
test("exact prepared consent is immutable, decision-only and has fixed expiry", () => {
  const source = input();
  assert.equal(source.prepared.state, "READY_FOR_APPROVAL");
  const a = value(createPreparedPlanApproval(source));
  assert.equal(a.preparedHash, source.preparedHash);
  assert.equal(a.expiresAt, "2026-09-24T14:17:00.000Z");
  assert.equal(a.executionAuthority, "none");
  assert.equal(
    a.replayInputs.prepared.inputIdentity.evaluationTime,
    source.prepared.inputIdentity.evaluationTime,
  );
  assert.ok(Object.isFrozen(a));
  assert.equal(rehydratePreparedPlanApproval(a).ok, true);
  assert.equal(createApproval(a).ok, false);
  assert.equal(
    value(createPreparedPlanApproval(source)).contentHash,
    a.contentHash,
  );
});
test("review requires note; blocked, absent actor/consent, wrong hash or time rejected", () => {
  const ready = {
      ...input("review"),
      note: "Acknowledged quality degradation",
    },
    review = input("review");
  assert.equal(createPreparedPlanApproval(review).ok, false);
  assert.equal(
    createPreparedPlanApproval({
      ...review,
      note: "Understood the exceptional context",
    }).ok,
    true,
  );
  for (const source of [
    input("blocked"),
    { ...ready, actor: "" },
    { ...ready, consent: false },
    { ...ready, preparedHash: "f".repeat(64) },
    { ...ready, approvedAt: "2026-09-24T14:00:01.999Z" },
    { ...ready, actorOverride: "forged" },
    { ...review, note: "   " },
  ])
    assert.equal(createPreparedPlanApproval(source).ok, false);
});
test("expiry exact boundary and new prepared identity invalidate association", () => {
  const source = {
      ...input("review"),
      note: "Acknowledged quality degradation",
    },
    a = value(createPreparedPlanApproval(source));
  assert.equal(
    validatePreparedPlanApproval(a, source.prepared, "2026-09-24T14:16:59.999Z")
      .ok,
    true,
  );
  assert.equal(
    validatePreparedPlanApproval(a, source.prepared, a.expiresAt).ok,
    false,
  );
  assert.equal(
    validatePreparedPlanApproval(a, source.prepared, "2026-09-24T14:01:59.999Z")
      .ok,
    false,
  );
  assert.equal(
    validatePreparedPlanApproval(
      a,
      value(
        createPreparedDailyPlan({
          ...source.prepared.replayInputs,
          reviewPolicy: {
            ...source.prepared.replayInputs.reviewPolicy,
            policyVersion: "another-review-v1",
          },
        }),
      ),
      a.approvedAt,
    ).ok,
    false,
  );
});
test("rehashing altered approval fields cannot change fixed policy or consent", () => {
  const a = value(
    createPreparedPlanApproval({
      ...input("review"),
      note: "Acknowledged quality degradation",
    }),
  );
  for (const change of [
    { expiresAt: "2026-09-24T14:18:00.000Z" },
    { preparedHash: "a".repeat(64) },
    { executionAuthority: "exchange-write" },
    { consent: false },
  ]) {
    const { contentHash: _, ...payload } = a;
    void _;
    const changed = { ...payload, ...change };
    assert.equal(
      rehydratePreparedPlanApproval({
        ...changed,
        contentHash: value(hashCanonical(changed)),
      }).ok,
      false,
    );
  }
});
