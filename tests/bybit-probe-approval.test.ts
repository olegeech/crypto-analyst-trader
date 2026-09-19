import assert from "node:assert/strict";
import test from "node:test";

import {
  authorizeProbePlan,
  reverifyProbeApproval,
} from "../scripts/bybit-probe/approval.js";
import {
  buildProbePlan,
  hashProbePlan,
} from "../scripts/bybit-probe/probe-plan.js";

const plan = buildProbePlan({
  environment: "testnet",
  accountId: "trading-account",
  scenario: "long-entry",
  expiresAt: 10_000,
  method: "POST",
  endpoint: "/v5/order/create",
  params: {
    category: "linear",
    symbol: "DOGEUSDT",
    side: "Buy",
    orderLinkId: "probe-run-long",
    price: "0.1",
    qty: "51",
    takeProfit: "0.102",
    stopLoss: "0.098",
    positionIdx: 0,
  },
});

test("explicit probe invocation authorizes the exact plan without a prompt", async () => {
  const digest = hashProbePlan(plan);
  const result = await authorizeProbePlan(plan, { clock: () => 1_000 });
  assert.equal(result.kind, "approved");
  if (result.kind === "approved") {
    assert.equal(result.digest, digest);
    assert.equal(result.approvedAt, 1_000);
    assert.equal(result.expiresAt, plan.expiresAt);
  }
});

test("expired plans and invalid authorization TTLs fail closed", async () => {
  const expired = await authorizeProbePlan(plan, { clock: () => 10_000 });
  assert.equal(expired.kind, "refused");
  if (expired.kind === "refused") assert.equal(expired.reason, "expired");

  const invalidTtl = await authorizeProbePlan(plan, {
    clock: () => 1_000,
    ttlMs: 0,
  });
  assert.equal(invalidTtl.kind, "refused");
  if (invalidTtl.kind === "refused") {
    assert.equal(invalidTtl.reason, "invalid-ttl");
  }
});

test("final re-verification rejects expiry, account changes, and request mutation", async () => {
  const digest = hashProbePlan(plan);
  const approved = {
    kind: "approved" as const,
    plan,
    digest,
    approvedAt: 1_000,
    expiresAt: plan.expiresAt,
  };
  assert.doesNotThrow(() => reverifyProbeApproval(approved, plan, 9_999));
  assert.throws(() => reverifyProbeApproval(approved, plan, 10_000), /expired/);
  assert.throws(
    () =>
      reverifyProbeApproval(approved, { ...plan, accountId: "other" }, 1_000),
    /digest mismatch|account mismatch/,
  );
  assert.throws(
    () =>
      reverifyProbeApproval(
        approved,
        { ...plan, params: { ...plan.params, qty: "52" } },
        1_000,
      ),
    /digest mismatch/,
  );
});

test("the run-scoped authorization TTL is enforced before the plan expiry", async () => {
  const result = await authorizeProbePlan(plan, {
    clock: () => 1_000,
    ttlMs: 100,
  });
  assert.equal(result.kind, "approved");
  if (result.kind === "approved") {
    assert.equal(result.expiresAt, 1_100);
    assert.throws(() => reverifyProbeApproval(result, plan, 1_100), /expired/);
  }
});
