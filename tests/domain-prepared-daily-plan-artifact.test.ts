import assert from "node:assert/strict";
import test from "node:test";
import { createProvisionalM1Composition } from "../src/application/policies/provisional-m1.js";
import {
  createPreparedDailyPlan,
  createPreparedDailyPlanV2,
  summarizePreparedShadowContext,
  rehydratePreparedDailyPlan,
  createDailyReviewPolicy,
  createDailyApprovalPolicy,
} from "../src/domain/review/prepared-daily-plan.js";
import { evaluatePortfolioRiskPreflight } from "../src/domain/risk/portfolio-risk-preflight.js";
import {
  hashCanonical,
  canonicalSerialize,
} from "../src/domain/identity/canonical-serialization.js";
import { encodeCanonicalArtifact } from "../src/domain/identity/canonical-artifact.js";
import {
  portfolioRiskAccountInput,
  portfolioRiskPosition,
  portfolioRiskPolicyInput,
} from "./fixtures/portfolio-risk-fixtures.js";
import { portfolioRiskPlanningFixture } from "./fixtures/portfolio-risk-planning-fixtures.js";
import { requireDailyFixture as value } from "./fixtures/daily-planning-evidence-fixtures.js";
import { DecimalValue } from "../src/domain/shared/decimal.js";
import { decimal } from "./account-evidence-fixture.js";
import { preparedLegExecutionFixture } from "./fixtures/prepared-leg-execution-fixtures.js";
import { preparedPlanFixture } from "./fixtures/prepared-plan-fixtures.js";
import {
  createPreparedPlanApproval,
  validatePreparedPlanApproval,
} from "../src/domain/review/prepared-plan-approval.js";

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
  const first = value(createPreparedDailyPlanV2(source));
  const second = value(createPreparedDailyPlanV2(source));
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

test("v3 preserves explicit shadow unavailability and round-trips its safe summary", () => {
  const prepared = value(createPreparedDailyPlan(input()));
  assert.equal(prepared.schemaVersion, "prepared-daily-plan/v3");
  assert.ok(prepared.inputIdentity.shadowContextHash?.startsWith("sha256:"));
  const context = prepared.replayInputs.shadowContext;
  assert.ok(context);
  assert.equal(context.status, "unavailable");
  assert.deepEqual(context.reasonCodes, ["SHADOW_SOURCE_INCOMPATIBLE"]);
  assert.equal(context.shadow, undefined);
  assert.equal(context.assessment, undefined);
  const shadowSummary = prepared.summary.shadowIntelligence as
    | {
        readonly status: string;
        readonly reasonCodes: readonly string[];
      }
    | undefined;
  assert.equal(shadowSummary?.status, "unavailable");
  assert.deepEqual(shadowSummary?.reasonCodes, context.reasonCodes);
  assert.equal(prepared.executionAuthority, "none");
  assert.equal(
    value(hashCanonical(context)),
    prepared.inputIdentity.shadowContextHash,
  );

  const decoded = JSON.parse(
    value(canonicalSerialize(prepared)),
    (_key, raw: unknown) =>
      raw !== null && typeof raw === "object" && "$decimal" in raw
        ? value(DecimalValue.fromString(raw.$decimal))
        : raw,
  );
  assert.equal(
    value(rehydratePreparedDailyPlan(decoded)).contentHash,
    prepared.contentHash,
  );
});

test("v3 replay rejects rehashed unavailable context, profile and summary edits", () => {
  const prepared = value(createPreparedDailyPlan(input()));
  const context = prepared.replayInputs.shadowContext;
  assert.ok(context?.status === "unavailable");
  if (!context || context.status !== "unavailable") return;
  const mutations = [
    {
      replayInputs: {
        ...prepared.replayInputs,
        shadowContext: { ...context, reasonCodes: ["INVENTED"] },
      },
    },
    {
      replayInputs: {
        ...prepared.replayInputs,
        shadowContext: {
          ...context,
          model: { ...context.model, producer: "untrusted" },
        },
      },
    },
    {
      replayInputs: {
        ...prepared.replayInputs,
        shadowContext: {
          ...context,
          qualityProfileVersion: "foreign-shadow-quality/v1",
        },
      },
    },
    {
      summary: {
        ...prepared.summary,
        shadowIntelligence: {
          ...prepared.summary.shadowIntelligence,
          status: "recorded",
        },
      },
    },
  ];
  for (const mutation of mutations)
    assert.equal(
      rehydratePreparedDailyPlan(
        rehash({ ...prepared, ...mutation } as unknown as Record<
          string,
          unknown
        >),
      ).ok,
      false,
    );
});

test("changed shadow identity cannot reuse prior prepared consent", () => {
  const prepared = preparedPlanFixture("review");
  const approval = value(
    createPreparedPlanApproval({
      prepared,
      preparedHash: prepared.contentHash,
      actor: "local-operator:fixture",
      consent: true,
      note: "Acknowledged quality degradation",
      approvedAt: "2026-09-24T14:02:00.000Z",
    }),
  );
  const context = prepared.replayInputs.shadowContext;
  assert.ok(context?.status === "unavailable");
  if (!context || context.status !== "unavailable") return;
  const changedContext = {
    ...context,
    reasonCodes: [...context.reasonCodes, "SHADOW_CONTEXT_UNAVAILABLE"],
  };
  const shadowContextHash = value(hashCanonical(changedContext));
  assert.notEqual(shadowContextHash, prepared.inputIdentity.shadowContextHash);
  const inputIdentity = { ...prepared.inputIdentity, shadowContextHash };
  const planId = value(
    hashCanonical({
      schemaVersion: "prepared-daily-plan-id/v1",
      inputIdentity,
    }),
  );
  const changed = rehash({
    ...prepared,
    preparedPlanId: `prepared-daily-plan:${planId}`,
    inputIdentity,
    replayInputs: {
      ...prepared.replayInputs,
      shadowContext: changedContext,
    },
    summary: {
      ...prepared.summary,
      shadowIntelligence: summarizePreparedShadowContext(changedContext),
    },
  } as unknown as Record<string, unknown>);
  assert.notEqual(`prepared-daily-plan:${planId}`, prepared.preparedPlanId);
  assert.notEqual(changed.contentHash, prepared.contentHash);
  assert.equal(rehydratePreparedDailyPlan(changed).ok, false);
  assert.equal(
    validatePreparedPlanApproval(approval, changed, approval.approvedAt).ok,
    false,
  );
});

test("rehashed disposition, target, summary, warning and authority claims fail semantic replay", () => {
  const prepared = value(createPreparedDailyPlanV2(input()));
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
    assert.equal(createPreparedDailyPlanV2({ ...source, preflight }).ok, false);
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
      createPreparedDailyPlanV2({ ...source, reviewPolicy }).ok,
      false,
    );
  for (const approvalPolicy of [
    undefined,
    { ...source.approvalPolicy, ttlMs: 900001 },
    { ...source.approvalPolicy, extra: true },
  ])
    assert.equal(
      createPreparedDailyPlanV2({ ...source, approvalPolicy }).ok,
      false,
    );
  let invoked = false;
  const accessor = Object.defineProperty({}, "preflight", {
    get() {
      invoked = true;
      return source.preflight;
    },
  });
  assert.equal(createPreparedDailyPlanV2(accessor).ok, false);
  assert.equal(invoked, false);
  assert.equal(
    createPreparedDailyPlanV2({ ...source, actor: "operator" }).ok,
    false,
  );
});

test("hash binds metadata and complete policies without inventing review warnings", () => {
  const source = input();
  const prepared = value(createPreparedDailyPlanV2(source));
  const changed = value(
    createPreparedDailyPlanV2({
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
    createPreparedDailyPlanV2({ ...source, externalAvailability: [] }).ok,
    false,
  );
  assert.equal(
    createPreparedDailyPlanV2({
      ...source,
      externalAvailability: source.externalAvailability.map((row) => ({
        ...row,
        status: "available",
      })),
    }).ok,
    false,
  );
});

test("Mainnet preparation binds one closed Partial Market LastPrice policy and rejects edits", () => {
  const prepared = preparedLegExecutionFixture().prepared;
  assert.equal(prepared.schemaVersion, "prepared-daily-plan/v2");
  assert.deepEqual(prepared.replayInputs.protectionPolicy, {
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
  });

  const policy = prepared.replayInputs.protectionPolicy!;
  const { protectionPolicy: _policy, ...legacyReplayInputs } =
    prepared.replayInputs;
  void _policy;
  for (const protectionPolicy of [
    undefined,
    { ...policy, takeProfit: { ...policy.takeProfit, orderType: "Limit" } },
    { ...policy, stopLoss: "invented" },
    { ...policy, tpLimitPrice: "70000" },
  ]) {
    const replayInputs =
      protectionPolicy === undefined
        ? legacyReplayInputs
        : { ...legacyReplayInputs, protectionPolicy };
    const { contentHash: _hash, ...payload } = {
      ...prepared,
      replayInputs,
    };
    void _hash;
    assert.equal(rehydratePreparedDailyPlan(rehash(payload)).ok, false);
  }
});

test("prepared daily artifact compatibility retains its pre-operator golden hashes", () => {
  const prepared = value(createPreparedDailyPlanV2(input()));
  const envelope = value(
    encodeCanonicalArtifact("prepared-daily-plan", prepared),
  );
  assert.equal(
    prepared.contentHash,
    "sha256:9943be849a9ef46b588024b9e89feb756d5e5005d855282a6acb7a4129cdb0ea",
  );
  assert.equal(
    envelope.canonicalHash,
    "sha256:e73b5cda51e9104f4dbc046fd55c36621feb55c6bd1afd7b4a24b7b71ffde463",
  );
});
