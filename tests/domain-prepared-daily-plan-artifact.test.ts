import assert from "node:assert/strict";
import test from "node:test";
import { createProvisionalM1Composition } from "../src/application/policies/provisional-m1.js";
import {
  createPreparedDailyPlan,
  rehydratePreparedDailyPlan,
  createDailyReviewPolicy,
  createDailyApprovalPolicy,
} from "../src/domain/review/prepared-daily-plan.js";
import { evaluatePortfolioRiskPreflight } from "../src/domain/risk/portfolio-risk-preflight.js";
import {
  hashCanonical,
  canonicalSerialize,
} from "../src/domain/identity/canonical-serialization.js";
import {
  portfolioRiskAccountInput,
  portfolioRiskPosition,
  portfolioRiskPolicyInput,
} from "./fixtures/portfolio-risk-fixtures.js";
import { portfolioRiskPlanningFixture } from "./fixtures/portfolio-risk-planning-fixtures.js";
import { requireDailyFixture as value } from "./fixtures/daily-planning-evidence-fixtures.js";
import { DecimalValue } from "../src/domain/shared/decimal.js";
import { decimal } from "./account-evidence-fixture.js";

function input() {
  const planning = portfolioRiskPlanningFixture({ fundingRate: "0" });
  const source = portfolioRiskAccountInput({
    positions: [portfolioRiskPosition()],
  });
  function shift(raw: unknown): unknown {
    if (typeof raw === "string" && /^\d{4}-\d\d-\d\dT.*Z$/.test(raw))
      return new Date(
        Date.parse(raw) +
          Date.parse("2026-09-24T14:00:00Z") -
          Date.parse("2026-10-02T12:00:00Z"),
      ).toISOString();
    if (Array.isArray(raw)) return raw.map(shift);
    if (raw !== null && typeof raw === "object")
      return Object.fromEntries(
        Object.entries(raw).map(([k, v]) => [k, shift(v)]),
      );
    return raw;
  }
  const account = {
    ...source,
    runId: planning.dailyPlan.inputIdentity.runId,
    criticalPasses: {
      A: {
        ...source.criticalPasses.A,
        totals: {
          ...source.criticalPasses.A.totals,
          totalAvailableBalance: decimal("1000"),
        },
      },
      B: {
        ...source.criticalPasses.B,
        totals: {
          ...source.criticalPasses.B.totals,
          totalAvailableBalance: decimal("1000"),
        },
      },
    },
  };
  const preflight = value(
    evaluatePortfolioRiskPreflight({
      dailyPlan: planning.dailyPlan,
      qualityProfile: planning.qualityProfile,
      account: shift(account),
      policy: portfolioRiskPolicyInput(),
      evaluationTime: "2026-09-24T14:00:02.000Z",
    }),
  );
  const policy = value(
    createProvisionalM1Composition({ symbol: "BTCUSDT", allocation: "10" }),
  );
  return {
    preflight,
    reviewPolicy: policy.reviewPolicy,
    approvalPolicy: policy.approvalPolicy,
    externalAvailability: policy.externalAvailability,
  };
}

function rehash(raw: Record<string, unknown>) {
  const { contentHash: _, ...payload } = raw;
  void _;
  return { ...payload, contentHash: value(hashCanonical(payload)) };
}

test("canonical replay is deterministic, immutable and serialized Decimal values round trip", () => {
  const source = input();
  const first = value(createPreparedDailyPlan(source));
  const second = value(createPreparedDailyPlan(source));
  assert.equal(first.contentHash, second.contentHash);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.summary));
  assert.ok(Object.isFrozen(first.replayInputs.preflight.replayInputs.account));
  // U4's canonical decoder restores Decimal tags before domain rehydration.
  const decoded = JSON.parse(
    value(canonicalSerialize(first)),
    (_key, raw: unknown) =>
      raw !== null && typeof raw === "object" && "$decimal" in raw
        ? value(DecimalValue.fromString(raw.$decimal))
        : raw,
  );
  assert.equal(
    value(rehydratePreparedDailyPlan(decoded)).contentHash,
    first.contentHash,
  );
  assert.equal(
    value(canonicalSerialize(first)),
    value(canonicalSerialize(value(rehydratePreparedDailyPlan(first)))),
  );
});

test("rehashed disposition, target, summary, warning and authority claims fail semantic replay", () => {
  const prepared = value(createPreparedDailyPlan(input()));
  for (const edit of [
    { state: "BLOCKED" },
    { noteRequired: false },
    { reasonCodes: ["INVENTED"] },
    { executionAuthority: "execution" },
    {
      summary: {
        ...prepared.summary,
        targetGate: { ...prepared.summary.targetGate, status: "conflict" },
      },
    },
    { summary: { ...prepared.summary, informationalCodes: [] } },
    {
      summary: {
        ...prepared.summary,
        risk: { ...prepared.summary.risk, verdict: "BLOCK" },
      },
    },
  ])
    assert.equal(
      rehydratePreparedDailyPlan(rehash({ ...prepared, ...edit })).ok,
      false,
    );
});

test("nested preflight, original profile and foreign account substitution cannot be laundered by rehashing", () => {
  const source = input();
  const p = source.preflight;
  for (const preflight of [
    rehash({ ...p, verdict: "BLOCK" }),
    rehash({
      ...p,
      replayInputs: {
        ...p.replayInputs,
        qualityProfile: {
          ...p.replayInputs.qualityProfile,
          profileVersion: "foreign",
        },
      },
    }),
    rehash({
      ...p,
      replayInputs: {
        ...p.replayInputs,
        account: {
          ...p.replayInputs.account,
          accountBinding: {
            ...p.replayInputs.account.accountBinding,
            accountIdentityHash: `sha256:${"b".repeat(64)}`,
          },
        },
      },
    }),
  ])
    assert.equal(createPreparedDailyPlan({ ...source, preflight }).ok, false);
});

test("policy bodies are explicit, closed and compatible with U1", () => {
  const source = input();
  assert.deepEqual(
    value(createDailyReviewPolicy(source.reviewPolicy)),
    source.reviewPolicy,
  );
  assert.deepEqual(
    value(createDailyApprovalPolicy(source.approvalPolicy)),
    source.approvalPolicy,
  );
  for (const reviewPolicy of [
    undefined,
    { ...source.reviewPolicy, provisionalRequiresReview: true },
    { ...source.reviewPolicy, exceptionalWarnings: ["PROVISIONAL_POLICY"] },
    { ...source.reviewPolicy, extra: true },
  ])
    assert.equal(
      createPreparedDailyPlan({ ...source, reviewPolicy }).ok,
      false,
    );
  for (const approvalPolicy of [
    undefined,
    { ...source.approvalPolicy, ttlMs: 900001 },
    { ...source.approvalPolicy, extra: true },
  ])
    assert.equal(
      createPreparedDailyPlan({ ...source, approvalPolicy }).ok,
      false,
    );
  let invoked = false;
  const accessor = Object.defineProperty({}, "preflight", {
    get() {
      invoked = true;
      return source.preflight;
    },
  });
  assert.equal(createPreparedDailyPlan(accessor).ok, false);
  assert.equal(invoked, false);
  assert.equal(
    createPreparedDailyPlan({ ...source, actor: "operator" }).ok,
    false,
  );
});

test("hash binds metadata and complete policies without inventing review warnings", () => {
  const source = input();
  const prepared = value(createPreparedDailyPlan(source));
  const changed = value(
    createPreparedDailyPlan({
      ...source,
      reviewPolicy: {
        ...source.reviewPolicy,
        policyVersion: "same-rules-v2",
        informationalCodes: [],
      },
    }),
  );
  assert.notEqual(changed.contentHash, prepared.contentHash);
  assert.equal(changed.state, prepared.state);
  assert.equal(changed.noteRequired, prepared.noteRequired);
  assert.equal(
    createPreparedDailyPlan({ ...source, externalAvailability: [] }).ok,
    false,
  );
  assert.equal(
    createPreparedDailyPlan({
      ...source,
      externalAvailability: source.externalAvailability.map((row) => ({
        ...row,
        status: "available",
      })),
    }).ok,
    false,
  );
});
