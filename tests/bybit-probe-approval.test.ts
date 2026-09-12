import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  approveProbePlan,
  reverifyProbeApproval,
} from "../scripts/bybit-probe/approval.js";
import { buildProbePlan, hashProbePlan } from "../scripts/bybit-probe/probe-plan.js";

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

test("approval accepts a case-insensitive exact digest after retyping", async () => {
  const digest = hashProbePlan(plan);
  const result = await approveProbePlan(plan, {
    clock: () => 1_000,
    prompt: async () => digest.toUpperCase(),
    output: { write: () => undefined },
  });
  assert.equal(result.kind, "approved");
  if (result.kind === "approved") {
    assert.equal(result.digest, digest);
    assert.equal(result.approvedAt, 1_000);
  }
});

test("a typo consumes an attempt and an empty line refuses", async () => {
  let calls = 0;
  const result = await approveProbePlan(plan, {
    clock: () => 1_000,
    prompt: async () => {
      calls += 1;
      return calls === 1 ? "not-the-digest" : "";
    },
    output: { write: () => undefined },
  });
  assert.equal(result.kind, "refused");
  assert.equal(result.reason, "empty-input");
  assert.equal(calls, 2);
});

test("non-TTY approval fails closed before emitting an approval block", async () => {
  const output = new PassThrough();
  let printed = "";
  output.on("data", (chunk: Buffer) => {
    printed += chunk.toString();
  });
  const result = await approveProbePlan(plan, {
    clock: () => 1_000,
    input: Object.assign(new PassThrough(), { isTTY: false }),
    output,
  });
  assert.equal(result.kind, "refused");
  assert.equal(result.reason, "non-tty");
  assert.equal(printed, "");
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
    () => reverifyProbeApproval(approved, { ...plan, accountId: "other" }, 1_000),
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

test("the injected approval TTL is enforced even before the plan expiry", async () => {
  const result = await approveProbePlan(plan, {
    clock: () => 1_000,
    ttlMs: 100,
    prompt: async () => hashProbePlan(plan),
    output: { write: () => undefined },
  });
  assert.equal(result.kind, "approved");
  if (result.kind === "approved") {
    assert.equal(result.expiresAt, 1_100);
    assert.throws(() => reverifyProbeApproval(result, plan, 1_100), /expired/);
  }
});
