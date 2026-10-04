import assert from "node:assert/strict";
import test from "node:test";

import {
  hashCanonical,
  canonicalSerialize,
} from "../src/domain/identity/canonical-serialization.js";
import {
  accountEvidenceContentHash,
  createAccountEvidenceBundle,
} from "../src/domain/account/account-evidence-bundle.js";
import {
  evaluatePortfolioRiskPreflight,
  rehydratePortfolioRiskPreflight,
} from "../src/domain/risk/portfolio-risk-preflight.js";
import { createPortfolioRiskEvidence } from "../src/domain/risk/portfolio-risk-evidence.js";
import { DecimalValue } from "../src/domain/shared/decimal.js";
import { requireDailyFixture } from "./fixtures/daily-planning-evidence-fixtures.js";
import {
  decimal as accountDecimal,
  fixture as accountFixture,
  known as accountKnown,
  withCounts,
} from "./account-evidence-fixture.js";
import {
  portfolioRiskAccountInput,
  portfolioRiskPolicyInput,
  portfolioRiskPosition,
} from "./fixtures/portfolio-risk-fixtures.js";
import { portfolioRiskPlanningFixture } from "./fixtures/portfolio-risk-planning-fixtures.js";

const evaluationTime = "2026-09-24T14:00:02.000Z";
const ACCOUNT_TIME_SHIFT_MS =
  Date.parse("2026-09-24T14:00:00.000Z") -
  Date.parse("2026-10-02T12:00:00.000Z");

function shiftAccountTimes<T>(value: T): T {
  if (typeof value === "string" && /^\d{4}-\d\d-\d\dT.*Z$/.test(value))
    return new Date(
      Date.parse(value) + ACCOUNT_TIME_SHIFT_MS,
    ).toISOString() as T;
  if (Array.isArray(value))
    return value.map((entry) => shiftAccountTimes(entry)) as T;
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        shiftAccountTimes(child),
      ]),
    ) as T;
  return value;
}

function input(
  recommendation: "ADD_LONG" | "REDUCE_LONG" | "HOLD_LONG" = "ADD_LONG",
  options: {
    readonly account?: unknown;
    readonly evaluationTime?: string;
    readonly balance?: string;
    readonly supplementalEvidence?: unknown;
    readonly marketMaxAgeMs?: number;
  } = {},
) {
  const fixtures = portfolioRiskPlanningFixture({
    recommendation,
    fundingRate: "0",
    ...(options.marketMaxAgeMs === undefined
      ? {}
      : { marketMaxAgeMs: options.marketMaxAgeMs }),
  });
  const source = portfolioRiskAccountInput({
    positions: [portfolioRiskPosition()],
  });
  const balance = accountDecimal(options.balance ?? "1000", "USD");
  const funded = withCounts({
    ...source,
    criticalPasses: {
      A: {
        ...source.criticalPasses.A!,
        totals: {
          ...source.criticalPasses.A!.totals,
          totalAvailableBalance: balance,
        },
      },
      B: {
        ...source.criticalPasses.B!,
        totals: {
          ...source.criticalPasses.B!.totals,
          totalAvailableBalance: balance,
        },
      },
    },
  });
  return {
    dailyPlan: fixtures.dailyPlan,
    account: shiftAccountTimes(options.account ?? funded),
    policy: portfolioRiskPolicyInput(),
    qualityProfile: fixtures.qualityProfile,
    ...(options.supplementalEvidence === undefined
      ? {}
      : { supplementalEvidence: options.supplementalEvidence }),
    evaluationTime: options.evaluationTime ?? evaluationTime,
  };
}

function evaluate(...args: Parameters<typeof input>) {
  return requireDailyFixture(evaluatePortfolioRiskPreflight(input(...args)));
}

function rehash(value: Record<string, unknown>) {
  const { contentHash: _contentHash, ...payload } = value;
  void _contentHash;
  const hash = requireDailyFixture(hashCanonical(payload));
  return { ...payload, contentHash: hash };
}

test("ADD PASS retains unchanged intents and is byte-stable under canonical replay", () => {
  const source = input("ADD_LONG");
  const first = requireDailyFixture(evaluatePortfolioRiskPreflight(source));
  const second = requireDailyFixture(evaluatePortfolioRiskPreflight(source));
  assert.equal(first.verdict, "PASS");
  assert.deepEqual(first.reasonCodes, []);
  assert.equal(first.actionProposal?.kind, "add-long");
  if (first.actionProposal?.kind !== "add-long") return;
  assert.deepEqual(
    first.actionProposal.orderIntents,
    source.dailyPlan.orderIntents,
  );
  assert.equal(first.capacity.outcome, "pass");
  assert.equal(first.economics.outcome, "pass");
  assert.equal(
    requireDailyFixture(canonicalSerialize(first)),
    requireDailyFixture(canonicalSerialize(second)),
  );
  const replayed = requireDailyFixture(rehydratePortfolioRiskPreflight(first));
  assert.equal(replayed.contentHash, first.contentHash);
});

test("REDUCE produces a quantity-only action or a typed no-op, while HOLD has no action", () => {
  const long = portfolioRiskPosition({
    side: "Buy",
    size: accountDecimal("1", "contracts"),
    positionValue: accountDecimal("100", "USD"),
    isReduceOnly: accountKnown(true),
  });
  const reduce = evaluate("REDUCE_LONG", {
    account: portfolioRiskAccountInput({ positions: [long] }),
  });
  assert.equal(reduce.verdict, "PASS");
  assert.equal(reduce.capacity.outcome, "not-evaluated");
  assert.equal(reduce.economics.outcome, "not-evaluated");
  assert.equal(reduce.actionProposal?.kind, "close-long-quantity");
  if (reduce.actionProposal?.kind === "close-long-quantity") {
    assert.equal(reduce.actionProposal.proposal.quantity.toString(), "0.25");
    assert.equal("price" in reduce.actionProposal.proposal, false);
  }

  const noOp = evaluate("REDUCE_LONG", { account: accountFixture() });
  assert.equal(noOp.verdict, "PASS");
  assert.deepEqual(noOp.actionProposal, {
    kind: "reduction-no-op",
    reasonCode: "NO_REDUCIBLE_LONG",
  });

  const hold = evaluate("HOLD_LONG", { account: accountFixture() });
  assert.equal(hold.verdict, "PASS");
  assert.equal(hold.capacity.outcome, "not-evaluated");
  assert.equal(hold.economics.outcome, "not-evaluated");
  assert.deepEqual(hold.actionProposal, { kind: "hold-no-action" });
});

test("shared stale-account gate blocks every recommendation and authorizes no action", () => {
  for (const recommendation of [
    "ADD_LONG",
    "REDUCE_LONG",
    "HOLD_LONG",
  ] as const) {
    const result = evaluate(recommendation, {
      account: accountFixture(),
      evaluationTime: "2026-09-24T14:01:02.001Z",
    });
    assert.equal(result.verdict, "BLOCK");
    assert.ok(result.reasonCodes.includes("ACCOUNT_EVIDENCE_STALE"));
    assert.equal(result.actionProposal, null);
  }
});

test("capacity failure blocks the unchanged ADD plan without a partial action", () => {
  const result = evaluate("ADD_LONG", { balance: "0" });
  assert.equal(result.verdict, "BLOCK");
  assert.ok(result.reasonCodes.includes("CAPACITY_EXCEEDED"));
  assert.equal(result.actionProposal, null);
  assert.equal(result.projection.addProjection.status, "complete");
  assert.equal(result.economics.outcome, "pass");
});

test("exchange reduce-only target state blocks ADD without an action", () => {
  const restricted = portfolioRiskPosition({
    side: "Buy",
    size: accountDecimal("1", "contracts"),
    positionValue: accountDecimal("100", "USD"),
    isReduceOnly: accountKnown(true),
  });
  const source = portfolioRiskAccountInput({ positions: [restricted] });
  const balance = accountDecimal("1000", "USD");
  const account = withCounts({
    ...source,
    criticalPasses: {
      A: {
        ...source.criticalPasses.A!,
        totals: {
          ...source.criticalPasses.A!.totals,
          totalAvailableBalance: balance,
        },
      },
      B: {
        ...source.criticalPasses.B!,
        totals: {
          ...source.criticalPasses.B!.totals,
          totalAvailableBalance: balance,
        },
      },
    },
  });
  const result = evaluate("ADD_LONG", { account });
  assert.equal(result.verdict, "BLOCK");
  assert.ok(result.reasonCodes.includes("ACCOUNT_RESTRICTION_ACTIVE"));
  assert.equal(result.actionProposal, null);
});

test("identity includes evaluation time and replay inputs include the exact original policy/profile", () => {
  const first = evaluate("ADD_LONG", { evaluationTime });
  const later = evaluate("ADD_LONG", {
    evaluationTime: "2026-09-24T14:00:02.001Z",
  });
  assert.notEqual(first.preflightId, later.preflightId);
  assert.equal(
    first.inputIdentity.qualityProfileHash,
    first.economics.qualityProfileHash,
  );
  assert.equal(
    first.inputIdentity.qualityProfileVersion,
    first.economics.qualityProfileVersion,
  );
  assert.equal(first.replayInputs.policy.policyVersion, "m1-v1");
  assert.equal(
    first.replayInputs.qualityProfile.profileVersion,
    "fixture-daily-v1",
  );
});

test("plan, account, policy, profile and supplemental evidence each affect identity", () => {
  const baseInput = input("ADD_LONG");
  const base = requireDailyFixture(evaluatePortfolioRiskPreflight(baseInput));
  const accountChanged = evaluate("ADD_LONG", { balance: "1001" });
  const policyChanged = requireDailyFixture(
    evaluatePortfolioRiskPreflight({
      ...baseInput,
      policy: { ...baseInput.policy, marginReserveRatio: "0.2" },
    }),
  );
  const profileChanged = evaluate("ADD_LONG", { marketMaxAgeMs: 60_001 });
  const planChanged = requireDailyFixture(
    evaluatePortfolioRiskPreflight({
      ...input("ADD_LONG"),
      dailyPlan: portfolioRiskPlanningFixture({
        recommendation: "ADD_LONG",
        fundingRate: "0",
        planningLevels: [
          {
            atrOffset: "0.1",
            allocationWeight: "1",
            takeProfitAtrDistance: "2",
          },
        ],
      }).dailyPlan,
    }),
  );

  const parsedAccount = requireDailyFixture(
    createAccountEvidenceBundle(base.replayInputs.account),
  );
  const accountHash = requireDailyFixture(
    accountEvidenceContentHash(parsedAccount),
  );
  const supplemental = requireDailyFixture(
    createPortfolioRiskEvidence({
      schemaVersion: "portfolio-risk-evidence/v1",
      kind: "target-leverage",
      environment: "demo",
      accountIdentityHash: parsedAccount.accountBinding.accountIdentityHash,
      accountEvidenceHash: accountHash,
      symbol: "ETHUSDT",
      observedAt: parsedAccount.collectionEndedAt,
      rows: [
        {
          positionIdx: 0,
          side: "None",
          size: "0",
          leverage: "1",
          isReduceOnly: false,
        },
      ],
    }),
  );
  const supplementalChanged = requireDailyFixture(
    evaluatePortfolioRiskPreflight({
      ...baseInput,
      supplementalEvidence: [supplemental],
    }),
  );

  for (const changed of [
    accountChanged,
    policyChanged,
    profileChanged,
    planChanged,
    supplementalChanged,
  ])
    assert.notEqual(changed.preflightId, base.preflightId);
  assert.ok(
    supplementalChanged.reasonCodes.includes("SUPPLEMENTAL_EVIDENCE_INVALID"),
  );
});

test("HOLD and REDUCE reject supplemental evidence during admission and canonical replay", () => {
  for (const recommendation of ["HOLD_LONG", "REDUCE_LONG"] as const) {
    const source = input(recommendation);
    const account = requireDailyFixture(
      createAccountEvidenceBundle(source.account),
    );
    const supplemental = requireDailyFixture(
      createPortfolioRiskEvidence({
        schemaVersion: "portfolio-risk-evidence/v1",
        kind: "target-leverage",
        environment: "mainnet",
        accountIdentityHash: `sha256:${"b".repeat(64)}`,
        accountEvidenceHash: `sha256:${"c".repeat(64)}`,
        symbol: "BTCUSDT",
        observedAt: account.collectionEndedAt,
        rows: [
          {
            positionIdx: 0,
            side: "None",
            size: "0",
            leverage: "1",
            isReduceOnly: false,
          },
        ],
      }),
    );
    const rejected = evaluatePortfolioRiskPreflight({
      ...source,
      supplementalEvidence: [supplemental],
    });
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.error.code, "INVALID_EVIDENCE");

    const valid = requireDailyFixture(evaluatePortfolioRiskPreflight(source));
    assert.equal(valid.verdict, "PASS");
    assert.deepEqual(valid.replayInputs.supplementalEvidence, []);
    const forged = rehash({
      ...valid,
      replayInputs: {
        ...valid.replayInputs,
        supplementalEvidence: [supplemental],
      },
    });
    const replayed = rehydratePortfolioRiskPreflight(forged);
    assert.equal(replayed.ok, false);
    if (!replayed.ok) assert.equal(replayed.error.code, "INVALID_EVIDENCE");
  }
});

test("malformed nested input or mismatched original quality profile is admission failure", () => {
  const valid = input("ADD_LONG");
  assert.equal(
    evaluatePortfolioRiskPreflight({ ...valid, supplementalEvidence: [{}] }).ok,
    false,
  );
  assert.equal(
    evaluatePortfolioRiskPreflight({ ...valid, qualityProfile: undefined }).ok,
    false,
  );
  assert.equal(
    evaluatePortfolioRiskPreflight({
      ...valid,
      qualityProfile: {
        ...valid.qualityProfile,
        profileVersion: "replacement-profile",
      },
    }).ok,
    false,
  );
});

test("rehashed output edits cannot bypass semantic replay", () => {
  const result = evaluate("ADD_LONG");
  const changedVerdict = rehash({ ...result, verdict: "BLOCK" });
  assert.equal(rehydratePortfolioRiskPreflight(changedVerdict).ok, false);

  const one = requireDailyFixture(DecimalValue.fromString("1"));
  const changedCapacity = rehash({
    ...result,
    capacity: {
      ...result.capacity,
      capacity: {
        ...result.capacity.capacity,
        incrementalCapacity: { state: "known", value: one },
      },
    },
  });
  assert.equal(rehydratePortfolioRiskPreflight(changedCapacity).ok, false);

  const changedMaterialization = rehash({
    ...result,
    materialization: {
      ...result.materialization,
      reduction: { ...result.materialization.reduction, symbol: "ETHUSDT" },
    },
  });
  assert.equal(
    rehydratePortfolioRiskPreflight(changedMaterialization).ok,
    false,
  );
});
