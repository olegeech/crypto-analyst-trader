import assert from "node:assert/strict";
import { test } from "node:test";
import {
  runDailyCommand,
  parseDailyArguments,
  renderPreparedReview,
} from "../src/cli/daily-command.js";
import { preparedPlanFixture } from "./fixtures/prepared-plan-fixtures.js";
import { ok } from "../src/domain/shared/result.js";
import { fail } from "../src/domain/shared/result.js";
import { domainError } from "../src/domain/shared/errors.js";
import { fixedClock } from "../src/domain/shared/time.js";
import type { PreparedPlanApproval } from "../src/domain/review/prepared-plan-approval.js";
import { createPreparedDailyPlanV2 } from "../src/domain/review/prepared-daily-plan.js";
import { portfolioRiskPosition } from "./fixtures/portfolio-risk-fixtures.js";
import { decimal } from "./account-evidence-fixture.js";
import type { DailyPrepareResult } from "../src/application/daily-prepare.js";
import type { PreparedDailyPlan } from "../src/domain/review/prepared-daily-plan.js";
import { createAnalyticsEvidenceBundle } from "../src/domain/analytics/analytics-evidence-bundle.js";
import { createProvisionalM1Composition } from "../src/application/policies/provisional-m1.js";
import {
  createPreparedShadowContextV1,
  summarizePreparedShadowContext,
} from "../src/domain/review/prepared-shadow-context.js";
import { createShadowMarketReportV1 } from "../src/domain/review/shadow-market-report.js";
import {
  DAILY_PREPARE_TIME,
  dailyPrepareLiquidationV3,
  dailyPrepareMarket,
} from "./fixtures/daily-prepare-fixtures.js";
import type { ShadowMarketReport } from "../src/domain/review/shadow-market-report.js";
import type { ShadowReportStore } from "../src/ports/shadow-report-store.js";
import { requireDailyFixture as value } from "./fixtures/daily-planning-evidence-fixtures.js";

function shadowEvidence(evaluationTime: string = DAILY_PREPARE_TIME) {
  const market = dailyPrepareMarket();
  const liquidation = dailyPrepareLiquidationV3(market, "BTC").bundle;
  const composition = value(
    createProvisionalM1Composition({ symbol: "BTCUSDT", allocation: "10" }),
  );
  const analytics = value(
    createAnalyticsEvidenceBundle({
      market,
      liquidation,
      profile: composition.analyticsProfile,
      featuresVersion: composition.analyticsFeaturesVersion,
    }),
  );
  const context = value(
    createPreparedShadowContextV1({
      market,
      analytics,
      liquidation,
      symbol: "BTCUSDT",
      evaluationTime,
    }),
  );
  return { market, liquidation, analytics, context };
}

function recordedShadowSummary(evaluationTime: string = DAILY_PREPARE_TIME) {
  const summary = summarizePreparedShadowContext(
    shadowEvidence(evaluationTime).context,
  );
  if (!("qualityAssessment" in summary))
    throw new Error("expected a recorded shadow assessment");
  return summary;
}

function shadowReportFixture(evaluationTime: string): ShadowMarketReport {
  const { market, liquidation, analytics } = shadowEvidence(evaluationTime);
  return value(
    createShadowMarketReportV1({
      environment: "demo",
      market,
      liquidation,
      analytics,
      symbol: "BTCUSDT",
      evaluationTime,
    }),
  );
}

async function executePrepareResult(result: DailyPrepareResult) {
  const clock = fixedClock("2026-09-24T14:00:10Z");
  assert.ok(clock.ok);
  const output: string[] = [];
  const code = await runDailyCommand(
    [
      "prepare",
      "--environment",
      "mainnet",
      "--symbol",
      "BTCUSDT",
      "--allocation",
      "100",
    ],
    {
      prepare: async () => result,
      openStore: () => fail(domainError("INVALID_VALUE", "unused")),
      actor: () => ok("unused"),
      clock: clock.value,
      interactive: false,
      prompt: async () => "",
      write: (text) => output.push(text),
    },
  );
  return { code, output };
}

async function executeShadowReportReview(report: ShadowMarketReport) {
  const clock = fixedClock("2026-09-24T14:05:10Z");
  assert.ok(clock.ok);
  const output: string[] = [];
  let prepareCalls = 0;
  let storeClosed = false;
  const shadowStore: ShadowReportStore = {
    saveShadowReport: () => ok(undefined),
    loadShadowReport: (hash) =>
      ok(hash === report.contentHash ? report : undefined),
    close: () => {
      storeClosed = true;
    },
  };
  const code = await runDailyCommand(
    ["review", "--environment", "demo", "--shadow-hash", report.contentHash],
    {
      prepare: async () => {
        prepareCalls++;
        throw new Error("offline shadow review must not prepare");
      },
      openStore: () => fail(domainError("INVALID_VALUE", "unused")),
      openShadowStore: () => ok(shadowStore),
      actor: () => ok("unused"),
      clock: clock.value,
      interactive: false,
      prompt: async () => "",
      write: (text) => output.push(text),
    },
  );
  return { code, output, prepareCalls, storeClosed };
}

test("human review describes HOLD, REDUCE, no-op and BLOCKED without inventing an entry", () => {
  const hold = preparedPlanFixture("review");
  const reduce = preparedPlanFixture("review", {
    recommendation: "REDUCE_LONG",
    positions: [
      portfolioRiskPosition({ side: "Buy", size: decimal("1", "contracts") }),
    ],
  });
  const noOp = preparedPlanFixture("review", { recommendation: "REDUCE_LONG" });
  const tooSmall = preparedPlanFixture("review", {
    recommendation: "REDUCE_LONG",
    positions: [
      portfolioRiskPosition({
        side: "Buy",
        size: decimal("0.001", "contracts"),
      }),
    ],
  });
  const blocked = preparedPlanFixture("blocked");
  assert.equal(hold.summary.action.kind, "hold-no-action");
  assert.equal(reduce.summary.action.kind, "close-long-quantity");
  assert.equal(noOp.summary.action.kind, "reduction-no-op");
  assert.equal(tooSmall.summary.action.kind, "reduction-no-op");
  assert.equal(blocked.state, "BLOCKED");
  for (const [prepared, expected] of [
    [hold, "HOLD: no action proposed"],
    [reduce, "REDUCE proposal: quantity-only, decision-only"],
    [noOp, "REDUCE: NO_REDUCIBLE_LONG; no action"],
    [tooSmall, "REDUCE: REDUCTION_QUANTITY_TOO_SMALL; no action"],
    [blocked, "No action: prepared plan is BLOCKED"],
  ] as const) {
    const output = renderPreparedReview(prepared);
    assert.ok(output.split("\n").includes(expected));
    assert.ok(!output.includes("Entry proposal:"));
    assert.ok(!output.includes("ADD proposal:"));
    assert.ok(output.includes("Execution authority: none."));
  }
});

test("closed CLI surface rejects authority overrides before any dependencies", async () => {
  for (const flag of [
    "--actor",
    "--yes",
    "--composition",
    "--policy",
    "--daily-plan",
    "--evaluation-time",
  ]) {
    assert.equal(
      parseDailyArguments([
        "prepare",
        "--environment",
        "mainnet",
        "--symbol",
        "BTCUSDT",
        "--allocation",
        "100",
        flag,
        "x",
      ]).ok,
      false,
    );
  }
  let used = false;
  const code = await runDailyCommand(
    [
      "prepare",
      "--environment",
      "mainnet",
      "--symbol",
      "BTCUSDT",
      "--allocation",
      "0",
    ],
    {
      prepare: async () => {
        used = true;
        throw new Error("should not run");
      },
      openStore: () => {
        used = true;
        throw new Error("should not run");
      },
      actor: () => {
        used = true;
        throw new Error("should not run");
      },
      clock: {
        now: () => {
          used = true;
          throw new Error("should not run");
        },
      },
      interactive: false,
      prompt: async () => {
        used = true;
        throw new Error("should not run");
      },
      write: () => {},
    },
  );
  assert.equal(code, 2);
  assert.equal(used, false);
});

test("shadow hash has a separate offline review route and cannot enter approval", () => {
  const shadowHash = `sha256:${"a".repeat(64)}`;
  assert.deepEqual(
    parseDailyArguments([
      "review",
      "--environment",
      "demo",
      "--shadow-hash",
      shadowHash,
    ]),
    {
      ok: true,
      value: {
        kind: "shadow-review",
        environment: "demo",
        shadowHash,
      },
    },
  );
  assert.equal(
    parseDailyArguments([
      "review",
      "--environment",
      "demo",
      "--shadow-hash",
      "invalid",
    ]).ok,
    false,
  );
  assert.equal(
    parseDailyArguments([
      "review",
      "--environment",
      "demo",
      "--prepared-hash",
      shadowHash,
      "--shadow-hash",
      shadowHash,
    ]).ok,
    false,
  );
  assert.equal(
    parseDailyArguments([
      "approve",
      "--environment",
      "demo",
      "--shadow-hash",
      shadowHash,
    ]).ok,
    false,
  );
});

test("prepare prints only the bounded sanitized required-window diagnostics", async () => {
  const prepared = preparedPlanFixture("blocked");
  const diagnostics = {
    marketStatus: "complete",
    marketObservations: 3416,
    liquidationStatus: "incomplete",
    coverageProof: "complete",
    historyProof: "incomplete",
    liquidationSchemaVersion: "liquidation-evidence/v2",
    liquidationPolicyVersion: "liquidation-market-aggregate/v1",
    liquidationSelectedAsset: null,
    liquidationCatalogueMarketCount: null,
    liquidationExcludedMarketCount: null,
    liquidationCatalogueHash: null,
    liquidationSelectedSetHash: null,
    liquidationEvidenceHash: `sha256:${"f".repeat(64)}`,
    eligibleConstituents: 93,
    expectedHourlyBuckets: 93 * 24,
    resolvedHourlyBuckets: 353,
    providerExplicitBuckets: 353,
    providerExplicitZeroBuckets: 0,
    providerImpliedZeroBuckets: 0,
    unresolvedRequestedBuckets: 93 * 24 - 353,
    requiredLiquidationWindows: [
      {
        requestId: "liquidation-12h",
        asset: "BTC",
        hours: 12,
        completeness: "incomplete" as const,
        observedConstituentBuckets: 11,
        expectedConstituentBuckets: 12,
        missingByVenue: [{ venue: "Bybit", missingConstituentBuckets: 1 }],
        omittedVenueGroupCount: 0,
        omittedMissingConstituentBuckets: 0,
      },
    ],
    accountPartitionsTraversed: 0,
    accountPartitionsExpected: 0,
    exchangeWrites: 0 as const,
    executionAuthority: "none" as const,
  };
  const output: string[] = [];
  const clock = fixedClock("2026-09-24T14:00:10Z");
  assert.equal(clock.ok, true);
  if (!clock.ok) return;
  const code = await runDailyCommand(
    [
      "prepare",
      "--environment",
      "mainnet",
      "--symbol",
      "BTCUSDT",
      "--allocation",
      "100",
    ],
    {
      prepare: async () => ({ kind: "prepared", prepared, diagnostics }),
      openStore: () => fail(domainError("INVALID_VALUE", "unused")),
      actor: () => ok("unused"),
      clock: clock.value,
      interactive: false,
      prompt: async () => "",
      write: (text) => output.push(text),
    },
  );
  assert.equal(code, 5);
  assert.match(output[0] ?? "", /Market Intelligence: unavailable/u);
  assert.match(output[0] ?? "", /Trading Readiness: BLOCKED/u);
  assert.equal(output[1], JSON.stringify(diagnostics));
  assert.ok(output[1]?.includes('"observedConstituentBuckets":11'));
  assert.ok(output[1]?.includes('"expectedConstituentBuckets":12'));
  assert.equal(output[1]?.includes("apiKey"), false);
  assert.equal(output[1]?.includes("accountId"), false);
});

test("prepare status uses the prepared shadow summary when diagnostics omit it", async () => {
  const prepared = preparedPlanFixture("ready");
  const hash = `sha256:${"a".repeat(64)}`;
  const shadowIntelligence = recordedShadowSummary();
  assert.equal(shadowIntelligence.qualityAssessment.status, "accepted");
  assert.ok(
    shadowIntelligence.families.every((family) => family.status === "partial"),
  );
  const preparedWithShadow = {
    ...prepared,
    summary: { ...prepared.summary, shadowIntelligence },
  } as PreparedDailyPlan;
  const diagnostics = {
    shadowReportHash: hash,
  } as DailyPrepareResult["diagnostics"];

  const { code, output } = await executePrepareResult({
    kind: "prepared",
    prepared: preparedWithShadow,
    diagnostics,
  });

  assert.equal(code, 0);
  assert.match(output[0] ?? "", /Market Intelligence: partial/u);
  assert.match(output[0] ?? "", new RegExp(hash, "u"));
  assert.doesNotMatch(output[0] ?? "", /Market Intelligence: unavailable/u);
  assert.equal(output[1], `SHADOW_REPORT_HASH: ${hash}`);
  assert.equal(output[2], JSON.stringify(diagnostics));
  assert.equal(output[2]?.includes("apiKey"), false);
  assert.match(output[0] ?? "", /model families: partial/u);
});

test("recorded prepare context without a report hash is partial and explains persistence", async () => {
  const prepared = preparedPlanFixture("ready");
  const shadowIntelligence = recordedShadowSummary();
  assert.equal(shadowIntelligence.qualityAssessment.status, "accepted");
  const preparedWithShadow = {
    ...prepared,
    summary: { ...prepared.summary, shadowIntelligence },
  } as PreparedDailyPlan;
  const diagnostics = {} as DailyPrepareResult["diagnostics"];

  const { code, output } = await executePrepareResult({
    kind: "prepared",
    prepared: preparedWithShadow,
    diagnostics,
  });

  assert.equal(code, 0);
  assert.match(output[0] ?? "", /Market Intelligence: partial/u);
  assert.match(output[0] ?? "", /SHADOW_REPORT_NOT_PERSISTED/u);
  assert.match(output[0] ?? "", /hash: unavailable/u);
  assert.doesNotMatch(output[0] ?? "", /Market Intelligence: unavailable/u);
  assert.equal(output[1], JSON.stringify(diagnostics));
  assert.equal(output[1]?.includes("apiKey"), false);
});

test("prepare marks an expired shadow assessment unavailable and retains its report hash", async () => {
  const prepared = preparedPlanFixture("ready");
  const hash = `sha256:${"b".repeat(64)}`;
  const shadowIntelligence = recordedShadowSummary("2026-09-24T14:05:00.000Z");
  assert.equal(shadowIntelligence.qualityAssessment.status, "rejected");
  assert.ok(
    shadowIntelligence.qualityAssessment.findings.some(
      (finding) => finding.reasonCode === "STALE_EVIDENCE",
    ),
  );
  const preparedWithShadow = {
    ...prepared,
    summary: { ...prepared.summary, shadowIntelligence },
  } as PreparedDailyPlan;
  const diagnostics = {
    shadowReportHash: hash,
  } as DailyPrepareResult["diagnostics"];

  const { code, output } = await executePrepareResult({
    kind: "prepared",
    prepared: preparedWithShadow,
    diagnostics,
  });

  assert.equal(code, 0);
  assert.match(output[0] ?? "", /Market Intelligence: unavailable/u);
  assert.match(output[0] ?? "", /STALE_EVIDENCE/u);
  assert.match(output[0] ?? "", new RegExp(hash, "u"));
  assert.match(output[0] ?? "", /model families: partial/u);
});

test("offline shadow review reports an expired assessment without refreshing sources", async () => {
  const report = shadowReportFixture("2026-09-24T14:05:00.000Z");
  const summary = summarizePreparedShadowContext(report.context);
  assert.ok("qualityAssessment" in summary);
  assert.equal(summary.qualityAssessment.status, "rejected");
  assert.ok(
    summary.qualityAssessment.findings.some(
      (finding) => finding.reasonCode === "STALE_EVIDENCE",
    ),
  );

  const { code, output, prepareCalls, storeClosed } =
    await executeShadowReportReview(report);

  assert.equal(code, 0);
  assert.equal(prepareCalls, 0);
  assert.equal(storeClosed, true);
  assert.match(output[0] ?? "", new RegExp(report.contentHash, "u"));
  assert.match(output[0] ?? "", /Market Intelligence: unavailable/u);
  assert.match(output[0] ?? "", /STALE_EVIDENCE/u);
  assert.match(output[0] ?? "", /model families: partial/u);
  assert.match(output[0] ?? "", /Trading Readiness: not evaluated/u);
});

test("offline review/approval renders informational absence, binds derived actor and rejects redirected consent", async () => {
  const prepared = preparedPlanFixture("review");
  const clock = fixedClock("2026-09-24T14:00:10Z");
  assert.ok(clock.ok);
  const saved: PreparedPlanApproval[] = [];
  let privateCalls = 0;
  let prompts = 0;
  const output: string[] = [];
  const dependencies = {
    prepare: async () => {
      privateCalls++;
      throw new Error("offline");
    },
    openStore: () =>
      ok({
        savePrepared: () => ok(undefined),
        loadPrepared: () => ok(prepared),
        saveApproval: (a: PreparedPlanApproval) => {
          saved.push(a);
          return ok(undefined);
        },
        loadApproval: () => ok(undefined),
        close: () => {},
      }),
    actor: () => ok("local-operator:trusted"),
    clock: clock.value,
    interactive: false,
    prompt: async () => {
      prompts++;
      return "yes";
    },
    write: (s: string) => {
      output.push(s);
    },
  };
  const args = [
    "--environment",
    prepared.inputIdentity.environment,
    "--prepared-hash",
    prepared.contentHash,
  ];
  assert.equal(await runDailyCommand(["review", ...args], dependencies), 0);
  assert.equal(
    await runDailyCommand(
      ["approve", ...args, "--note", "reviewed"],
      dependencies,
    ),
    3,
  );
  assert.equal(prompts, 0);
  assert.equal(saved.length, 0);
  assert.equal(
    await runDailyCommand(["approve", ...args, "--note", "reviewed"], {
      ...dependencies,
      interactive: true,
    }),
    0,
  );
  assert.equal(saved[0]?.actor, "local-operator:trusted");
  assert.equal(saved[0]?.executionAuthority, "none");
  assert.equal(prompts, 1);
  assert.equal(privateCalls, 0);
  assert.equal(
    await runDailyCommand(["approve", ...args, "--note", "reviewed"], {
      ...dependencies,
      interactive: true,
      actor: () => fail(domainError("INVALID_VALUE", "unavailable")),
    }),
    4,
  );
  assert.equal(
    await runDailyCommand(["approve", ...args, "--note", "reviewed"], {
      ...dependencies,
      interactive: true,
      prompt: async () => "no",
    }),
    3,
  );
  assert.equal(
    await runDailyCommand(["approve", ...args], {
      ...dependencies,
      interactive: true,
      prompt: async () => {
        throw new Error("EOF");
      },
    }),
    3,
  );
  assert.equal(
    await runDailyCommand(["approve", ...args], {
      ...dependencies,
      interactive: true,
      prompt: async () => " ",
    }),
    5,
  );
  assert.equal(
    await runDailyCommand(
      [
        "review",
        "--environment",
        "mainnet",
        "--prepared-hash",
        prepared.contentHash,
      ],
      dependencies,
    ),
    prepared.inputIdentity.environment === "mainnet" ? 0 : 4,
  );
  assert.equal(saved.length, 1);
  assert.ok(output.join("\n").includes("PROVISIONAL_POLICY"));
  const rendered = renderPreparedReview(prepared);
  for (const name of [
    "market-regime",
    "early-warning-risk",
    "liquidity-stress",
    "trap",
  ])
    assert.ok(rendered.includes(name));
  assert.ok(rendered.includes("not-configured"));
  assert.ok(rendered.includes("Historical"));
  assert.ok(!rendered.includes("synthetic-secret"));
});

test("offline review distinguishes an unsupported prepared contract from corruption", async () => {
  const clock = fixedClock("2026-09-24T14:05:10Z");
  assert.ok(clock.ok);
  const output: string[] = [];
  const hash = `sha256:${"d".repeat(64)}`;
  const code = await runDailyCommand(
    ["review", "--environment", "demo", "--prepared-hash", hash],
    {
      prepare: async () => {
        throw new Error("offline review must not prepare");
      },
      openStore: () =>
        ok({
          savePrepared: () => ok(undefined),
          loadPrepared: () =>
            fail(domainError("UNSUPPORTED_CONTRACT", "future shadow model")),
          saveApproval: () => ok(undefined),
          loadApproval: () => ok(undefined),
          close: () => {},
        }),
      actor: () => ok("unused"),
      clock: clock.value,
      interactive: false,
      prompt: async () => "",
      write: (text) => output.push(text),
    },
  );

  assert.equal(code, 5);
  assert.deepEqual(output, ["Reason: PREPARED_UNSUPPORTED_CONTRACT"]);
});

test("offline review keeps v3 shadow timing historical and preserves v2 review", async () => {
  const prepared = preparedPlanFixture("ready");
  const future = fixedClock("2027-11-02T00:00:00.000Z");
  assert.ok(future.ok);
  if (!future.ok) return;
  let clockCalls = 0;
  let prepareCalls = 0;
  let actorCalls = 0;
  let promptCalls = 0;
  const output: string[] = [];
  const code = await runDailyCommand(
    [
      "review",
      "--environment",
      prepared.inputIdentity.environment,
      "--prepared-hash",
      prepared.contentHash,
    ],
    {
      prepare: async () => {
        prepareCalls++;
        throw new Error("offline review must not prepare");
      },
      openStore: () =>
        ok({
          savePrepared: () => ok(undefined),
          loadPrepared: () => ok(prepared),
          saveApproval: () => ok(undefined),
          loadApproval: () => ok(undefined),
          close: () => {},
        }),
      actor: () => {
        actorCalls++;
        return ok("unused");
      },
      clock: {
        now: () => {
          clockCalls++;
          return future.value.now();
        },
      },
      interactive: false,
      prompt: async () => {
        promptCalls++;
        return "yes";
      },
      write: (text) => output.push(text),
    },
  );
  assert.equal(code, 0);
  assert.equal(prepareCalls, 0);
  assert.equal(actorCalls, 0);
  assert.equal(promptCalls, 0);
  assert.equal(clockCalls, 0);
  const rendered = output.join("\n");
  assert.ok(
    rendered.includes(
      `Historical preflight evaluated at: ${prepared.inputIdentity.evaluationTime}`,
    ),
  );
  assert.ok(rendered.includes('"shadowIntelligence": {'));
  assert.ok(rendered.includes("SHADOW_SOURCE_INCOMPATIBLE"));
  assert.ok(!rendered.includes("2027-11-02T00:00:00.000Z"));

  const legacy = createPreparedDailyPlanV2({
    preflight: prepared.replayInputs.preflight,
    reviewPolicy: prepared.replayInputs.reviewPolicy,
    approvalPolicy: prepared.replayInputs.approvalPolicy,
    externalAvailability: prepared.replayInputs.externalAvailability,
    protectionPolicy: prepared.replayInputs.protectionPolicy,
  });
  assert.equal(legacy.ok, true);
  if (!legacy.ok) return;
  const legacyReview = renderPreparedReview(legacy.value);
  assert.ok(legacyReview.includes("Historical preflight evaluated at:"));
  assert.ok(!legacyReview.includes('"shadowIntelligence"'));
  assert.ok(legacyReview.includes('"externalAvailability"'));
});
