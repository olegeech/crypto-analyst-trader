import assert from "node:assert/strict";
import test from "node:test";

import {
  createApproval,
  validateApproval,
} from "../src/domain/execution/approval.js";
import { fixedClock } from "../src/domain/shared/time.js";

const planHash = `sha256:${"f".repeat(64)}`;

test("approval binds one exact plan hash and expires at the absolute boundary", () => {
  const approval = createApproval({
    approvalId: "approval-1",
    planHash,
    actor: "operator",
    approvedAt: "2026-09-19T10:00:00Z",
    expiresAt: "2026-09-19T10:05:00Z",
    note: "approved",
  });
  assert.equal(approval.ok, true);
  if (!approval.ok) return;
  const before = fixedClock("2026-09-19T10:04:59.999Z");
  assert.equal(before.ok, true);
  if (!before.ok) return;
  assert.equal(
    validateApproval(approval.value, planHash, before.value).ok,
    true,
  );

  const atBoundary = fixedClock("2026-09-19T10:05:00Z");
  assert.equal(atBoundary.ok, true);
  if (!atBoundary.ok) return;
  const expired = validateApproval(approval.value, planHash, atBoundary.value);
  assert.equal(expired.ok, false);
  if (!expired.ok) assert.equal(expired.error.code, "PLAN_EXPIRED");

  const mismatch = validateApproval(
    approval.value,
    `sha256:${"0".repeat(64)}`,
    before.value,
  );
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) assert.equal(mismatch.error.code, "PLAN_HASH_MISMATCH");
});

test("approval rejects reversed timestamps and empty notes", () => {
  const result = createApproval({
    approvalId: "approval-2",
    planHash,
    actor: "operator",
    approvedAt: "2026-09-19T10:05:00Z",
    expiresAt: "2026-09-19T10:00:00Z",
    note: "",
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "INVALID_APPROVAL");
});

test("approval cannot be used before its approved-at instant", () => {
  const approval = createApproval({
    approvalId: "approval-future",
    planHash,
    actor: "operator",
    approvedAt: "2026-09-19T10:05:00Z",
    expiresAt: "2026-09-19T10:10:00Z",
  });
  assert.equal(approval.ok, true);
  if (!approval.ok) return;
  const clock = fixedClock("2026-09-19T10:04:59.999Z");
  assert.equal(clock.ok, true);
  if (!clock.ok) return;
  const result = validateApproval(approval.value, planHash, clock.value);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "INVALID_APPROVAL");
});

test("validation rejects a forged approval with malformed timestamps", () => {
  const clock = fixedClock("2026-09-19T10:04:00Z");
  assert.equal(clock.ok, true);
  if (!clock.ok) return;
  const forged = {
    approvalId: "approval-forged",
    planHash,
    actor: "operator",
    approvedAt: "not-a-timestamp",
    expiresAt: "also-not-a-timestamp",
  } as never;
  const result = validateApproval(forged, planHash, clock.value);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "INVALID_APPROVAL");
});
