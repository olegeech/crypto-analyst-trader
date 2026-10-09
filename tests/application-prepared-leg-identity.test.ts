import assert from "node:assert/strict";
import test from "node:test";

import { derivePreparedLegClientOrderId } from "../src/application/execution-identity.js";
import { createPreparedPlanApproval } from "../src/domain/review/prepared-plan-approval.js";
import { preparedLegExecutionFixture } from "./fixtures/prepared-leg-execution-fixtures.js";
import { requireDailyFixture as value } from "./fixtures/daily-planning-evidence-fixtures.js";

test("prepared-leg client identity is stable across renewed approvals", () => {
  const source = preparedLegExecutionFixture();
  const renewed = value(
    createPreparedPlanApproval({
      prepared: source.prepared,
      preparedHash: source.prepared.contentHash,
      actor: "local-operator:fixture",
      consent: true,
      approvedAt: "2026-09-24T14:00:05.000Z",
      note: source.prepared.noteRequired ? "Renewed fixture review" : null,
    }),
  );
  assert.notEqual(renewed.contentHash, source.approval.contentHash);
  const first = derivePreparedLegClientOrderId(
    source.prepared.contentHash,
    source.legId,
  );
  const second = derivePreparedLegClientOrderId(
    renewed.preparedHash,
    source.legId,
  );
  const anotherLeg = derivePreparedLegClientOrderId(
    source.prepared.contentHash,
    "daily-leg:another-approved-leg",
  );
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(anotherLeg.ok, true);
  if (first.ok && second.ok && anotherLeg.ok) {
    assert.equal(first.value, second.value);
    assert.notEqual(first.value, anotherLeg.value);
    assert.equal(first.value.length, 35);
    assert.match(first.value, /^m1-[a-f0-9]{32}$/u);
  }
});
