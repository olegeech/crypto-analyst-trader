import assert from "node:assert/strict";
import test from "node:test";
import {
  createDailyPrepareBoundary,
  type DailyPrepareDependencies,
} from "../src/application/daily-prepare.js";
import { runDailyCommand } from "../src/cli/daily-command.js";
import { createAccountEvidenceCollectionResult } from "../src/domain/account/account-evidence-bundle.js";
import {
  summarizePreparedShadowContext,
  rehydratePreparedDailyPlan,
  type PreparedDailyPlan,
} from "../src/domain/review/prepared-daily-plan.js";
import { hashCanonical } from "../src/domain/identity/canonical-serialization.js";
import { fail, ok } from "../src/domain/shared/result.js";
import { domainError } from "../src/domain/shared/errors.js";
import { parseUtcTimestamp } from "../src/domain/shared/time.js";
import type { ExchangeCredentials } from "../src/ports/credential-provider.js";
import type { ShadowMarketReport } from "../src/domain/review/shadow-market-report.js";
import { marketFixture } from "./fixtures/data-quality-fixtures.js";
import { requireDailyFixture as value } from "./fixtures/daily-planning-evidence-fixtures.js";
import {
  dailyPrepareLiquidationV2,
  DAILY_PREPARE_CREDENTIALS,
  DAILY_PREPARE_ORIGINS,
  DAILY_PREPARE_RUN_ID,
  DAILY_PREPARE_SYMBOLS,
  DAILY_PREPARE_TIME,
  dailyPrepareAccount,
  dailyPrepareIdentity,
  dailyPrepareLiquidationV3,
  dailyPrepareMarket,
} from "./fixtures/daily-prepare-fixtures.js";
import type { LiquidationTargetAsset } from "../src/domain/liquidation/liquidation-evidence-bundle.js";

const input = { environment: "demo", symbol: "BTCUSDT", allocation: "10" };

function rehash(raw: Record<string, unknown>) {
  const { contentHash: _, ...payload } = raw;
  void _;
  return { ...payload, contentHash: value(hashCanonical(payload)) };
}

function setup(
  options: {
    liquidation?: "complete" | "missing" | "zero" | "invalid-response";
    liquidationAsset?: LiquidationTargetAsset;
    liquidationSchema?: "v2" | "v3";
    target?: "flat" | "long" | "order" | "absent";
    providerTime?: string;
    staleTicker?: boolean;
    planningTime?: string;
    preAuth?: boolean;
    slowPublic?: boolean;
    throwAt?: "market" | "liquidation" | "account" | "risk";
  } = {},
) {
  const events: string[] = [];
  const saved: PreparedDailyPlan[] = [];
  const savedShadowReports: ShadowMarketReport[] = [];
  let loads = 0;
  let capturedAccountCredentials: ExchangeCredentials | undefined;
  let wall = value(
    parseUtcTimestamp(
      options.slowPublic ? "2026-09-24T13:54:00.000Z" : DAILY_PREPARE_TIME,
    ),
  );
  const explode = (stage: string) => {
    if (options.throwAt === stage)
      throw new Error(
        "synthetic-secret rawUID=123 Authorization=private-payload",
      );
  };
  const deps: DailyPrepareDependencies = {
    collectMarket: async (runId) => {
      events.push("market");
      explode("market");
      const market = dailyPrepareMarket(runId);
      return ok(
        options.staleTicker
          ? marketFixture({
              ...market,
              symbols: market.symbols.map((row) =>
                row.symbol === "BTCUSDT" && row.ticker
                  ? {
                      ...row,
                      ticker: {
                        ...row.ticker,
                        observedAt: value(
                          parseUtcTimestamp("2026-09-24T13:54:00.000Z"),
                        ),
                      },
                    }
                  : row,
              ),
            })
          : market,
      );
    },
    collectLiquidation: async (market, selectedAsset) => {
      events.push("liquidation");
      explode("liquidation");
      wall = value(
        parseUtcTimestamp(options.planningTime ?? DAILY_PREPARE_TIME),
      );
      return ok(
        options.liquidationSchema === "v2"
          ? dailyPrepareLiquidationV2(market)
          : dailyPrepareLiquidationV3(
              market,
              options.liquidationAsset ?? selectedAsset,
              options.liquidation,
            ),
      );
    },
    collectAccount: async (opts) => {
      events.push("account");
      explode("account");
      const captured = await opts.credentialLoader.load(opts.environment);
      assert.deepEqual(opts.configuredM1Symbols, DAILY_PREPARE_SYMBOLS);
      capturedAccountCredentials = captured;
      assert.deepEqual(captured, DAILY_PREPARE_CREDENTIALS);
      if (options.preAuth)
        return value(
          createAccountEvidenceCollectionResult({
            kind: "pre-auth-failure",
            environment: opts.environment,
            runId: opts.runId,
            policyVersion: "account-evidence-collection-policy/v1",
            startedAt: DAILY_PREPARE_TIME,
            endedAt: DAILY_PREPARE_TIME,
            reasonCodes: ["CREDENTIALS_UNAVAILABLE"],
          }),
        );
      return {
        kind: "account-evidence",
        bundle: dailyPrepareAccount({
          environment: opts.environment,
          runId: opts.runId,
          ...(options.target ? { target: options.target } : {}),
        }),
      };
    },
    credentialLoader: {
      load: async () => {
        events.push("credentials");
        loads++;
        return DAILY_PREPARE_CREDENTIALS;
      },
    },
    createRiskReader: ({ environment, credentials }) => {
      assert.deepEqual(credentials, capturedAccountCredentials);
      assert.equal(credentials.apiSecret, DAILY_PREPARE_CREDENTIALS.apiSecret);
      events.push("risk-reader");
      explode("risk");
      return {
        environment,
        origin: DAILY_PREPARE_ORIGINS[environment],
        readIdentity: async () => {
          events.push("risk-identity");
          return dailyPrepareIdentity();
        },
        readTargetPositions: async () => {
          events.push("risk-positions");
          return {
            rows: dailyPrepareAccount().criticalPasses.B!.positions,
            observedAt: DAILY_PREPARE_TIME,
          };
        },
        readExchangeTime: async () => {
          events.push("risk-time");
          return value(
            parseUtcTimestamp(options.providerTime ?? DAILY_PREPARE_TIME),
          );
        },
        requestCount: () => 2,
      };
    },
    storeForEnvironment: (environment) => {
      events.push(`store:${environment}`);
      return ok({
        savePrepared: (prepared) => {
          saved.push(prepared);
          return ok(undefined);
        },
        loadPrepared: () => ok(undefined),
        saveApproval: () => {
          assert.fail("prepare must not approve");
        },
        loadApproval: () => ok(undefined),
        close: () => {},
      });
    },
    shadowReportStoreForEnvironment: () =>
      ok({
        saveShadowReport: (report) => {
          savedShadowReports.push(report);
          return ok(undefined);
        },
        loadShadowReport: (hash) =>
          ok(savedShadowReports.find((report) => report.contentHash === hash)),
        close: () => {},
      }),
    clock: { now: () => wall },
    newRunId: () => DAILY_PREPARE_RUN_ID,
  };
  return {
    boundary: createDailyPrepareBoundary(deps),
    deps,
    events,
    saved,
    savedShadowReports,
    get loads() {
      return loads;
    },
  };
}

test("clean native evidence traverses real planning/risk into replayable READY with informational externals", async () => {
  const s = setup({ slowPublic: true });
  const result = await s.boundary.prepare(input);
  assert.equal(result.kind, "prepared", JSON.stringify(result));
  if (result.kind !== "prepared") return;
  const p = result.prepared;
  assert.equal(p.state, "READY_FOR_APPROVAL");
  assert.equal(p.schemaVersion, "prepared-daily-plan/v3");
  assert.equal(p.noteRequired, false);
  assert.equal(p.executionAuthority, "none");
  assert.equal(p.summary.decision.recommendation, "ADD_LONG");
  assert.equal(p.summary.quality.gate, "OK");
  assert.deepEqual(p.summary.quality.findings, []);
  assert.deepEqual(p.summary.quality.appliedPenalties, []);
  assert.equal(p.summary.nativeAvailability.length, 5);
  assert.ok(
    p.summary.nativeAvailability.every(
      (feature) => feature.status === "complete",
    ),
  );
  assert.equal(p.summary.grid.length, 4);
  assert.ok(
    p.summary.grid.every(
      (leg) =>
        leg.timeInForce === "GTC" &&
        leg.takeProfit !== null &&
        leg.stopLoss === null,
    ),
  );
  assert.equal(p.summary.externalAvailability.length, 4);
  assert.ok(
    p.summary.externalAvailability.every(
      (family) => family.status === "not-configured",
    ),
  );
  assert.ok(p.summary.informationalCodes.includes("PROVISIONAL_POLICY"));
  assert.equal(p.replayInputs.preflight.evaluationTime, DAILY_PREPARE_TIME);
  assert.equal(p.replayInputs.shadowContext?.status, "recorded");
  assert.equal(s.savedShadowReports.length, 1);
  assert.equal(
    s.savedShadowReports[0]?.contentHash,
    result.diagnostics.shadowReportHash,
  );
  assert.deepEqual(
    s.savedShadowReports[0]?.context,
    p.replayInputs.shadowContext,
  );
  assert.ok(p.inputIdentity.shadowContextHash?.startsWith("sha256:"));
  const savedShadowSummary = p.summary.shadowIntelligence;
  assert.ok(savedShadowSummary && "sourceManifest" in savedShadowSummary);
  if (!savedShadowSummary || !("sourceManifest" in savedShadowSummary)) return;
  assert.ok(savedShadowSummary.sourceManifest.liquidation !== undefined);
  assert.equal(savedShadowSummary.families.length, 4);
  assert.ok(
    savedShadowSummary.families.every(
      (family) => family.assessmentStatus === "unavailable",
    ),
  );
  assert.equal(result.diagnostics.shadowIntelligence, undefined);
  assert.equal(
    savedShadowSummary.evaluationTime,
    result.prepared.inputIdentity.evaluationTime,
  );
  assert.equal(savedShadowSummary.qualityAssessment.status, "accepted");
  assert.equal(value(rehydratePreparedDailyPlan(p)).contentHash, p.contentHash);
  assert.equal(s.saved.length, 1);
  assert.equal(s.saved[0]?.contentHash, p.contentHash);
  assert.equal(s.loads, 1);
  assert.equal(result.diagnostics.exchangeWrites, 0);
  assert.equal(result.diagnostics.executionAuthority, "none");
  assert.equal(
    result.diagnostics.liquidationSchemaVersion,
    "liquidation-evidence/v3",
  );
  assert.equal(result.diagnostics.eligibleConstituents, 1);
  assert.equal(result.diagnostics.expectedHourlyBuckets, 24);
  assert.equal(result.diagnostics.resolvedHourlyBuckets, 24);
  assert.equal(result.diagnostics.providerExplicitBuckets, 24);
  assert.equal(result.diagnostics.providerImpliedZeroBuckets, 0);
  assert.equal(result.diagnostics.unresolvedRequestedBuckets, 0);
  assert.deepEqual(result.diagnostics.requiredLiquidationWindows, [
    {
      requestId: "liquidation-12h",
      asset: "BTC",
      hours: 12,
      completeness: "complete",
      observedConstituentBuckets: 12,
      expectedConstituentBuckets: 12,
      missingByVenue: [],
      omittedVenueGroupCount: 0,
      omittedMissingConstituentBuckets: 0,
    },
  ]);
  assert.equal(
    result.diagnostics.accountPartitionsTraversed,
    result.diagnostics.accountPartitionsExpected,
  );
  assert.ok(s.events.indexOf("liquidation") < s.events.indexOf("account"));
  assert.ok(s.events.indexOf("account") < s.events.indexOf("risk-identity"));
  assert.ok(s.events.indexOf("risk-identity") < s.events.indexOf("risk-time"));
  assert.ok(s.events.indexOf("risk-time") < s.events.indexOf("store:demo"));
});

test("rehashing recorded v3 shadow-context edits cannot alter deterministic replay", async () => {
  const result = await setup({ slowPublic: true }).boundary.prepare(input);
  assert.equal(result.kind, "prepared", JSON.stringify(result));
  if (result.kind !== "prepared") return;
  const context = result.prepared.replayInputs.shadowContext;
  assert.ok(context?.status === "recorded");
  if (!context || context.status !== "recorded" || !context.assessment) return;

  const { contentHash: _assessmentHash, ...assessmentPayload } =
    context.assessment;
  void _assessmentHash;
  const changedAssessmentPayload = {
    ...assessmentPayload,
    findings: [
      ...context.assessment.findings,
      {
        role: "market" as const,
        reasonCode: "SOURCE_REFERENCE_MISMATCH" as const,
      },
    ],
  };
  const changedContext = {
    ...context,
    assessment: {
      ...changedAssessmentPayload,
      contentHash: value(hashCanonical(changedAssessmentPayload)),
    },
  };
  const shadowContextHash = value(hashCanonical(changedContext));
  const inputIdentity = { ...result.prepared.inputIdentity, shadowContextHash };
  const preparedPlanId = value(
    hashCanonical({
      schemaVersion: "prepared-daily-plan-id/v1",
      inputIdentity,
    }),
  );
  const changed = rehash({
    ...result.prepared,
    preparedPlanId: "prepared-daily-plan:" + preparedPlanId,
    inputIdentity,
    replayInputs: {
      ...result.prepared.replayInputs,
      shadowContext: changedContext,
    },
    summary: {
      ...result.prepared.summary,
      shadowIntelligence: summarizePreparedShadowContext(changedContext),
    },
  } as unknown as Record<string, unknown>);

  assert.equal(rehydratePreparedDailyPlan(changed).ok, false);
});

test("invalid input and caller authority overrides are rejected before any provider", async () => {
  for (const invalid of [
    null,
    {},
    { ...input, environment: "public-mainnet" },
    { ...input, symbol: "XRPUSDT" },
    { ...input, allocation: 10 },
    { ...input, allocation: "0" },
    { ...input, allocation: "-1" },
    ...[
      "policy",
      "qualityProfile",
      "issuer",
      "evaluationTime",
      "dailyPlan",
      "composition",
      "credentialLoader",
      "createRiskReader",
    ].map((key) => ({ ...input, [key]: {} })),
  ]) {
    const s = setup();
    const result = await s.boundary.prepare(invalid);
    assert.notEqual(result.kind, "prepared");
    if (result.kind !== "prepared") {
      assert.equal(result.stage, "input");
      assert.deepEqual(result.reasonCodes, ["INVALID_INPUT"]);
    }
    assert.deepEqual(s.events, []);
    assert.equal(s.saved.length, 0);
  }
});

for (const liquidation of ["missing", "zero", "invalid-response"] as const)
  test(`${liquidation} liquidation cannot fabricate required imbalance or reach account providers`, async () => {
    const s = setup({ liquidation });
    const result = await s.boundary.prepare(input);
    assert.equal(result.kind, "blocked", JSON.stringify(result));
    assert.deepEqual(s.events, ["market", "liquidation"]);
    assert.equal(s.saved.length, 0);
    assert.ok(result.reasonCodes.length > 0);
    assert.equal(
      result.diagnostics.resolvedHourlyBuckets,
      liquidation === "missing" ? 23 : 24,
    );
    assert.deepEqual(result.diagnostics.requiredLiquidationWindows, [
      {
        requestId: "liquidation-12h",
        asset: "BTC",
        hours: 12,
        completeness: liquidation === "zero" ? "complete" : "incomplete",
        observedConstituentBuckets: liquidation === "missing" ? 11 : 12,
        expectedConstituentBuckets: 12,
        missingByVenue:
          liquidation === "missing"
            ? [{ venue: "Bybit", missingConstituentBuckets: 1 }]
            : [],
        omittedVenueGroupCount: 0,
        omittedMissingConstituentBuckets: 0,
      },
    ]);
  });

test("daily prepare rejects non-v3 or wrong-asset liquidation before private reads", async () => {
  for (const [options, expectedReason] of [
    [{ liquidationSchema: "v2" }, "LIQUIDATION_SCHEMA_MISMATCH"],
    [{ liquidationAsset: "ETH" }, "LIQUIDATION_ASSET_MISMATCH"],
  ] as const) {
    const s = setup(options);
    const result = await s.boundary.prepare(input);
    assert.equal(result.kind, "blocked", JSON.stringify(result));
    if (result.kind !== "blocked") continue;
    assert.equal(result.stage, "liquidation");
    assert.deepEqual(result.reasonCodes, [expectedReason]);
    assert.deepEqual(s.events, ["market", "liquidation"]);
    assert.equal(s.loads, 0);
    assert.equal(s.saved.length, 0);
  }
});

test("pre-auth failure creates no prepared artifact or invented account provenance", async () => {
  const s = setup({ preAuth: true });
  const result = await s.boundary.prepare(input);
  assert.equal(result.kind, "unavailable", JSON.stringify(result));
  assert.equal(s.saved.length, 0);
  assert.ok(!s.events.includes("risk-reader"));
  assert.doesNotMatch(
    JSON.stringify(result),
    /accountIdentityHash|synthetic-secret|rawUID/,
  );
});

test("early liquidation failure keeps required-window counts explicitly unknown", async () => {
  const s = setup({ throwAt: "liquidation" });
  const result = await s.boundary.prepare(input);
  assert.equal(result.kind, "unavailable");
  assert.deepEqual(result.diagnostics.requiredLiquidationWindows, [
    {
      requestId: "liquidation-12h",
      asset: "BTC",
      hours: 12,
      completeness: "unknown",
      observedConstituentBuckets: null,
      expectedConstituentBuckets: null,
      missingByVenue: null,
      omittedVenueGroupCount: null,
      omittedMissingConstituentBuckets: null,
    },
  ]);
  assert.ok(!s.events.includes("account"));
  assert.equal(result.diagnostics.shadowReportHash, undefined);
  assert.equal(s.savedShadowReports.length, 0);
});

for (const target of ["long", "order"] as const)
  test(`existing target ${target} blocks create-only ADD`, async () => {
    const s = setup({ target });
    const result = await s.boundary.prepare(input);
    assert.equal(result.kind, "prepared", JSON.stringify(result));
    if (result.kind !== "prepared") return;
    assert.equal(result.prepared.state, "BLOCKED");
    assert.equal(
      result.prepared.summary.shadowIntelligence?.status,
      "recorded",
    );
    assert.ok(
      result.prepared.reasonCodes.includes("BLOCKED_BY_CREATE_ONLY_SCOPE"),
    );
    assert.equal(result.prepared.executionAuthority, "none");
  });

test("fresh final provider time governs the exact 60-second account limit", async () => {
  for (const [providerTime, state] of [
    ["2026-09-24T14:01:02.000Z", "READY_FOR_APPROVAL"],
    ["2026-09-24T14:01:02.001Z", "BLOCKED"],
  ] as const) {
    const s = setup({ providerTime, target: "absent" });
    const result = await s.boundary.prepare(input);
    assert.equal(result.kind, "prepared", JSON.stringify(result));
    if (result.kind !== "prepared") continue;
    assert.equal(result.prepared.state, state);
    assert.equal(result.prepared.inputIdentity.evaluationTime, providerTime);
    const shadowSummary = result.prepared.summary.shadowIntelligence;
    assert.ok(shadowSummary && "evaluationTime" in shadowSummary);
    if (!shadowSummary || !("evaluationTime" in shadowSummary)) continue;
    assert.equal(shadowSummary.evaluationTime, providerTime);
    assert.equal(s.savedShadowReports.length, 1);
    assert.equal(s.savedShadowReports[0]?.evaluationTime, providerTime);
    assert.notEqual(
      s.savedShadowReports[0]?.evaluationTime,
      DAILY_PREPARE_TIME,
    );
    assert.deepEqual(
      s.savedShadowReports[0]?.context,
      result.prepared.replayInputs.shadowContext,
    );
    assert.equal(result.diagnostics.shadowIntelligence, undefined);
    if (state === "BLOCKED")
      assert.ok(result.prepared.reasonCodes.includes("ACCOUNT_EVIDENCE_STALE"));
    assert.equal(s.loads, 1);
    assert.ok(s.events.includes("risk-positions"));
    assert.ok(
      s.events.indexOf("risk-positions") < s.events.indexOf("risk-time"),
    );
    assert.equal(
      result.prepared.replayInputs.preflight.replayInputs.supplementalEvidence
        .length,
      1,
    );
  }
});

test("stale quote shadow rejection stays separate from core planning and consent", async () => {
  const result = await setup({ staleTicker: true }).boundary.prepare(input);
  assert.equal(result.kind, "prepared", JSON.stringify(result));
  if (result.kind !== "prepared") return;
  assert.equal(result.prepared.state, "READY_FOR_APPROVAL");
  assert.equal(result.prepared.noteRequired, false);
  assert.equal(result.prepared.replayInputs.shadowContext?.status, "recorded");
  const shadow = result.prepared.summary.shadowIntelligence;
  assert.ok(
    shadow &&
      "qualityAssessment" in shadow &&
      "observations" in shadow &&
      "families" in shadow,
  );
  if (
    !shadow ||
    !("qualityAssessment" in shadow) ||
    !("observations" in shadow) ||
    !("families" in shadow)
  )
    return;
  assert.equal(shadow?.qualityAssessment.status, "partial");
  assert.ok(
    shadow?.observations
      .filter((observation) => observation.id.startsWith("quote-"))
      .every((observation) => observation.qualityDisposition === "rejected"),
  );
  assert.ok(
    shadow?.families.some(
      (family) =>
        family.family === "liquidity-stress" &&
        family.qualityStatus === "rejected" &&
        family.qualityReasonCodes.includes("STALE_EVIDENCE"),
    ),
  );
  assert.equal(result.prepared.summary.quality.gate, "OK");
  assert.ok(
    result.prepared.summary.externalAvailability.every(
      (family) => family.status === "not-configured",
    ),
  );
});

test("planning refusal keeps blocked readiness and saves a separate shadow report", async () => {
  const s = setup({ planningTime: "2026-09-24T14:10:00.000Z" });
  const result = await s.boundary.prepare(input);
  assert.equal(result.kind, "blocked", JSON.stringify(result));
  assert.equal(result.stage, "planning");
  assert.equal(result.diagnostics.shadowIntelligence?.status, "recorded");
  const shadowDiagnostic = result.diagnostics.shadowIntelligence;
  assert.ok(shadowDiagnostic && "evaluationTime" in shadowDiagnostic);
  if (!shadowDiagnostic || !("evaluationTime" in shadowDiagnostic)) return;
  assert.equal(shadowDiagnostic.evaluationTime, "2026-09-24T14:10:00.000Z");
  assert.equal(s.saved.length, 0);
  assert.equal(s.savedShadowReports.length, 1);
  assert.equal(
    result.diagnostics.shadowReportHash,
    s.savedShadowReports[0]?.contentHash,
  );
  assert.equal(s.loads, 0);
});

test("incomplete liquidation history stays blocked while a public shadow report is saved", async () => {
  const s = setup({ liquidation: "missing" });
  const result = await s.boundary.prepare(input);
  assert.equal(result.kind, "blocked", JSON.stringify(result));
  if (result.kind !== "blocked") return;
  assert.equal(result.stage, "planning");
  assert.equal(result.diagnostics.liquidationStatus, "incomplete");
  assert.equal(result.diagnostics.historyProof, "incomplete");
  assert.equal(result.diagnostics.exchangeWrites, 0);
  assert.equal(result.diagnostics.executionAuthority, "none");
  assert.equal(s.saved.length, 0);
  assert.equal(s.savedShadowReports.length, 1);
  assert.ok(!s.events.includes("account"));
  assert.ok(!s.events.includes("credentials"));
  assert.ok(!s.events.includes("risk-reader"));
  assert.equal(
    result.diagnostics.shadowReportHash,
    s.savedShadowReports[0]?.contentHash,
  );
});

test("shadow report open/save failure leaves native prepared decisions unchanged and prints separate readiness", async () => {
  const baseline = await setup().boundary.prepare(input);
  assert.equal(baseline.kind, "prepared");
  if (baseline.kind !== "prepared") return;

  for (const failureMode of ["open", "save"] as const) {
    const s = setup();
    let closes = 0;
    const dependencies: DailyPrepareDependencies = {
      ...s.deps,
      shadowReportStoreForEnvironment: () =>
        failureMode === "open"
          ? fail(
              domainError("PERSISTENCE_INTEGRITY", "report store unavailable"),
            )
          : ok({
              saveShadowReport: () =>
                fail(
                  domainError("PERSISTENCE_INTEGRITY", "report save failed"),
                ),
              loadShadowReport: () => ok(undefined),
              close: () => {
                closes++;
              },
            }),
    };
    const result =
      await createDailyPrepareBoundary(dependencies).prepare(input);
    assert.equal(result.kind, "prepared", JSON.stringify(result));
    if (result.kind !== "prepared") continue;
    assert.equal(result.prepared.contentHash, baseline.prepared.contentHash);
    assert.deepEqual(result.prepared.summary, baseline.prepared.summary);
    assert.equal(result.diagnostics.shadowReportHash, undefined);
    assert.equal(closes, failureMode === "save" ? 1 : 0);
  }

  const blocked = await setup({ liquidation: "missing" }).boundary.prepare(
    input,
  );
  assert.equal(blocked.kind, "blocked");
  if (blocked.kind !== "blocked") return;
  const output: string[] = [];
  const exitCode = await runDailyCommand(
    [
      "prepare",
      "--environment",
      "demo",
      "--symbol",
      "BTCUSDT",
      "--allocation",
      "10",
    ],
    {
      prepare: async () => blocked,
      openStore: () => {
        assert.fail("blocked prepare must not open the prepared store");
      },
      actor: () => ok("operator"),
      clock: { now: () => DAILY_PREPARE_TIME },
      interactive: false,
      prompt: async () => "",
      write: (text) => output.push(text),
    },
  );
  assert.equal(exitCode, 5);
  assert.match(output[0] ?? "", /Market Intelligence: partial/u);
  assert.match(output[0] ?? "", /GAPPED_WINDOW/u);
  assert.match(output[0] ?? "", /INCOMPLETE_LIQUIDATION_HISTORY/u);
  assert.match(output[1] ?? "", /SHADOW_REPORT_HASH: sha256:/u);
  assert.match(output[0] ?? "", /Trading Readiness: BLOCKED/u);
  assert.match(output.join("\n"), /native reason codes: .*QUALITY_BLOCKED/u);
  assert.doesNotMatch(output.join("\n"), /PREPARED_HASH/u);
});

for (const throwAt of ["market", "liquidation", "account", "risk"] as const)
  test(`${throwAt} provider errors are sanitized without artifacts`, async () => {
    const s = setup({ throwAt });
    const result = await s.boundary.prepare(input);
    assert.equal(result.kind, "unavailable", JSON.stringify(result));
    assert.equal(result.stage, throwAt);
    assert.equal(s.saved.length, 0);
    assert.doesNotMatch(
      JSON.stringify(result),
      /synthetic-secret|rawUID|Authorization|private-payload/,
    );
    if (throwAt === "market" || throwAt === "liquidation")
      assert.equal(result.diagnostics.shadowIntelligence, undefined);
    else
      assert.equal(result.diagnostics.shadowIntelligence?.status, "recorded");
  });

test("unsigned public mainnet evidence remains distinct from the private account environment", async () => {
  for (const environment of ["demo", "testnet", "mainnet"] as const) {
    const s = setup();
    const result = await s.boundary.prepare({ ...input, environment });
    assert.equal(result.kind, "prepared", JSON.stringify(result));
    if (result.kind !== "prepared") continue;
    assert.equal(result.prepared.inputIdentity.environment, environment);
    assert.equal(
      result.prepared.replayInputs.preflight.replayInputs.account.accountBinding
        .origin,
      DAILY_PREPARE_ORIGINS[environment],
    );
    assert.equal(result.prepared.summary.publicMarket.environment, "mainnet");
    assert.ok(s.events.includes(`store:${environment}`));
  }
});
