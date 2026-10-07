import assert from "node:assert/strict";
import test from "node:test";
import {
  createDailyPrepareBoundary,
  type DailyPrepareDependencies,
} from "../src/application/daily-prepare.js";
import { createAccountEvidenceCollectionResult } from "../src/domain/account/account-evidence-bundle.js";
import {
  rehydratePreparedDailyPlan,
  type PreparedDailyPlan,
} from "../src/domain/review/prepared-daily-plan.js";
import { ok } from "../src/domain/shared/result.js";
import { parseUtcTimestamp } from "../src/domain/shared/time.js";
import type { ExchangeCredentials } from "../src/ports/credential-provider.js";
import { requireDailyFixture as value } from "./fixtures/daily-planning-evidence-fixtures.js";
import {
  DAILY_PREPARE_CREDENTIALS,
  DAILY_PREPARE_ORIGINS,
  DAILY_PREPARE_RUN_ID,
  DAILY_PREPARE_SYMBOLS,
  DAILY_PREPARE_TIME,
  dailyPrepareAccount,
  dailyPrepareIdentity,
  dailyPrepareLiquidation,
  dailyPrepareMarket,
} from "./fixtures/daily-prepare-fixtures.js";

const input = { environment: "demo", symbol: "BTCUSDT", allocation: "10" };

function setup(
  options: {
    liquidation?: "complete" | "missing" | "zero" | "invalid-response";
    target?: "flat" | "long" | "order" | "absent";
    providerTime?: string;
    preAuth?: boolean;
    slowPublic?: boolean;
    throwAt?: "market" | "liquidation" | "account" | "risk";
  } = {},
) {
  const events: string[] = [];
  const saved: PreparedDailyPlan[] = [];
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
      return ok(dailyPrepareMarket(runId));
    },
    collectLiquidation: async (market) => {
      events.push("liquidation");
      explode("liquidation");
      wall = DAILY_PREPARE_TIME;
      return ok(dailyPrepareLiquidation(market, options.liquidation));
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
    clock: { now: () => wall },
    newRunId: () => DAILY_PREPARE_RUN_ID,
  };
  return {
    boundary: createDailyPrepareBoundary(deps),
    deps,
    events,
    saved,
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
  assert.equal(value(rehydratePreparedDailyPlan(p)).contentHash, p.contentHash);
  assert.equal(s.saved.length, 1);
  assert.equal(s.saved[0]?.contentHash, p.contentHash);
  assert.equal(s.loads, 1);
  assert.equal(result.diagnostics.exchangeWrites, 0);
  assert.equal(result.diagnostics.executionAuthority, "none");
  assert.equal(result.diagnostics.eligibleConstituents, 4);
  assert.equal(result.diagnostics.observedHourlyBuckets, 96);
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
      result.diagnostics.observedHourlyBuckets,
      liquidation === "missing" ? 92 : 96,
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
});

for (const target of ["long", "order"] as const)
  test(`existing target ${target} blocks create-only ADD`, async () => {
    const s = setup({ target });
    const result = await s.boundary.prepare(input);
    assert.equal(result.kind, "prepared", JSON.stringify(result));
    if (result.kind !== "prepared") return;
    assert.equal(result.prepared.state, "BLOCKED");
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
