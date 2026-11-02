import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createDailyPrepareBoundary } from "../src/application/daily-prepare.js";
import { openSqlitePreparedArtifactStore } from "../src/adapters/sqlite/prepared-artifact-store.js";
import { runDailyCommand } from "../src/cli/daily-command.js";
import { localOperatorIdentity } from "../src/application/local-operator.js";
import { ok } from "../src/domain/shared/result.js";
import { fixedClock } from "../src/domain/shared/time.js";
import { validatePreparedPlanApproval } from "../src/domain/review/prepared-plan-approval.js";
import {
  createPreparedDailyPlanV2,
  type PreparedDailyPlan,
} from "../src/domain/review/prepared-daily-plan.js";
import { requireDailyFixture as value } from "./fixtures/daily-planning-evidence-fixtures.js";
import {
  DAILY_PREPARE_CREDENTIALS,
  DAILY_PREPARE_TIME,
  DAILY_PREPARE_RUN_ID,
  DAILY_PREPARE_ORIGINS,
  dailyPrepareAccount,
  dailyPrepareIdentity,
  dailyPrepareMarket,
  dailyPrepareLiquidationV3,
} from "./fixtures/daily-prepare-fixtures.js";

function coreProjection(prepared: PreparedDailyPlan) {
  const { shadowIntelligence: _shadow, ...summary } = prepared.summary;
  void _shadow;
  return {
    state: prepared.state,
    reasonCodes: prepared.reasonCodes,
    noteRequired: prepared.noteRequired,
    summary,
  };
}

test("released chain persists READY; fresh-process review and offline consent cannot create execution state", async () => {
  const root = mkdtempSync(join(tmpdir(), "daily-prepare-integration-"));
  const directory = join(root, "data/private/execution");
  const clock = value(fixedClock(DAILY_PREPARE_TIME));
  const sourceReads = {
    market: 0,
    liquidation: 0,
    account: 0,
    credentials: 0,
    risk: 0,
  };
  const openStore = (environment: "demo" | "testnet" | "mainnet") =>
    openSqlitePreparedArtifactStore({ environment, rootDirectory: directory });
  try {
    const boundary = createDailyPrepareBoundary({
      collectMarket: async (runId) => {
        sourceReads.market++;
        return ok(dailyPrepareMarket(runId));
      },
      collectLiquidation: async (market, selectedAsset) => {
        sourceReads.liquidation++;
        return ok(dailyPrepareLiquidationV3(market, selectedAsset));
      },
      collectAccount: async (options) => {
        sourceReads.account++;
        await options.credentialLoader.load(options.environment);
        return {
          kind: "account-evidence",
          bundle: dailyPrepareAccount({
            environment: options.environment,
            runId: options.runId,
          }),
        };
      },
      credentialLoader: {
        load: async () => {
          sourceReads.credentials++;
          return DAILY_PREPARE_CREDENTIALS;
        },
      },
      createRiskReader: ({ environment }) => ({
        environment,
        origin: DAILY_PREPARE_ORIGINS[environment],
        readIdentity: async () => {
          sourceReads.risk++;
          return dailyPrepareIdentity();
        },
        readTargetPositions: async () => {
          sourceReads.risk++;
          return {
            rows: dailyPrepareAccount().criticalPasses.B!.positions,
            observedAt: DAILY_PREPARE_TIME,
          };
        },
        readExchangeTime: async () => {
          sourceReads.risk++;
          return DAILY_PREPARE_TIME;
        },
        requestCount: () => 2,
      }),
      storeForEnvironment: openStore,
      clock,
      newRunId: () => DAILY_PREPARE_RUN_ID,
    });
    const result = await boundary.prepare({
      environment: "demo",
      symbol: "BTCUSDT",
      allocation: "10",
    });
    assert.equal(result.kind, "prepared");
    if (result.kind !== "prepared") return;
    const prepared = result.prepared;
    assert.equal(prepared.state, "READY_FOR_APPROVAL");
    assert.equal(prepared.noteRequired, false);
    assert.equal(prepared.executionAuthority, "none");
    assert.equal(prepared.schemaVersion, "prepared-daily-plan/v3");
    assert.equal(prepared.replayInputs.shadowContext?.status, "recorded");
    assert.ok(prepared.inputIdentity.shadowContextHash?.startsWith("sha256:"));
    const savedShadowSummary = prepared.summary.shadowIntelligence;
    assert.ok(savedShadowSummary && "sourceManifest" in savedShadowSummary);
    if (!savedShadowSummary || !("sourceManifest" in savedShadowSummary))
      return;
    assert.ok(savedShadowSummary.sourceManifest.liquidation !== undefined);
    assert.equal(
      savedShadowSummary.evaluationTime,
      prepared.inputIdentity.evaluationTime,
    );
    assert.equal(
      result.diagnostics.liquidationSchemaVersion,
      "liquidation-evidence/v3",
    );
    assert.equal(result.diagnostics.providerExplicitBuckets, 24);
    assert.equal(result.diagnostics.providerImpliedZeroBuckets, 0);
    assert.equal(result.diagnostics.unresolvedRequestedBuckets, 0);
    assert.equal(result.diagnostics.exchangeWrites, 0);
    assert.equal(result.diagnostics.executionAuthority, "none");

    // The fresh-process exact-hash review below rehydrates this saved identity.
    // A v2 projection of the same preflight proves the supplemental attachment
    // leaves core readiness, consent and outputs alone.
    const { shadowContext: _shadowContext, ...legacyInputs } =
      prepared.replayInputs;
    void _shadowContext;
    const legacy = value(createPreparedDailyPlanV2(legacyInputs));
    assert.equal(legacy.schemaVersion, "prepared-daily-plan/v2");
    assert.notEqual(legacy.contentHash, prepared.contentHash);
    assert.deepEqual(coreProjection(prepared), coreProjection(legacy));
    const readsAfterPrepare = { ...sourceReads };
    const cli = resolve("src/cli/daily.ts");
    const tsx = resolve("node_modules/tsx/dist/loader.mjs");
    const args = [
      "--environment",
      "demo",
      "--prepared-hash",
      prepared.contentHash,
    ];
    const review = spawnSync(
      process.execPath,
      ["--import", tsx, cli, "review", ...args],
      { cwd: root, encoding: "utf8", timeout: 60000 },
    );
    assert.equal(review.status, 0, review.stderr);
    assert.ok(review.stdout.includes(prepared.contentHash));
    assert.match(review.stdout, /READY_FOR_APPROVAL/u);
    assert.match(review.stdout, /not-configured/u);
    assert.match(review.stdout, /"shadowIntelligence": \{/u);
    assert.match(review.stdout, /"sourceManifest": \{/u);
    assert.match(review.stdout, /"liquidation": \{/u);
    assert.match(review.stdout, /"return-24h"/u);
    assert.match(review.stdout, /NO_CALIBRATED_MODEL/u);
    assert.match(
      review.stdout,
      new RegExp(
        `"evaluationTime": "${prepared.inputIdentity.evaluationTime}"`,
        "u",
      ),
    );
    let offlinePrepareCalls = 0;
    let offlineReviewOutput = "";
    const deps = {
      prepare: async () => {
        offlinePrepareCalls++;
        throw new Error("provider and credential loaders unavailable offline");
      },
      openStore,
      actor: localOperatorIdentity,
      clock,
      interactive: true,
      prompt: async () => "yes",
      write: (text: string) => {
        offlineReviewOutput += text;
      },
    };
    assert.equal(await runDailyCommand(["review", ...args], deps), 0);
    assert.ok(offlineReviewOutput.includes(prepared.contentHash));
    assert.equal(offlinePrepareCalls, 0);
    const redirected = spawnSync(
      process.execPath,
      ["--import", tsx, cli, "approve", ...args],
      { cwd: root, input: "yes\n", encoding: "utf8", timeout: 60000 },
    );
    assert.equal(redirected.status, 3, redirected.stderr);
    assert.equal(await runDailyCommand(["approve", ...args], deps), 0);
    assert.equal(offlinePrepareCalls, 0);
    assert.deepEqual(sourceReads, readsAfterPrepare);
    const db = new DatabaseSync(join(directory, "demo.db"));
    try {
      const approvals = db
        .prepare(
          "SELECT material_hash FROM artifacts WHERE artifact_kind = 'prepared-plan-approval'",
        )
        .all();
      assert.equal(approvals.length, 1);
      const store = value(openStore("demo"));
      try {
        const approval = value(
          store.loadApproval(String(approvals[0]!.material_hash)),
        );
        assert.ok(approval);
        assert.equal(approval.actor, value(localOperatorIdentity()));
        assert.equal(approval.preparedHash, prepared.contentHash);
        assert.equal(
          validatePreparedPlanApproval(approval, prepared, approval.approvedAt)
            .ok,
          true,
        );
        assert.equal(
          validatePreparedPlanApproval(approval, prepared, approval.expiresAt)
            .ok,
          false,
        );
      } finally {
        store.close();
      }
      for (const table of [
        "leases",
        "halt_state",
        "owned_intents",
        "execution_lineages",
        "execution_attempts",
        "reconciliation_results",
      ]) {
        assert.equal(
          db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n,
          0,
        );
      }
    } finally {
      db.close();
    }
    assert.ok(readdirSync(root).every((name) => name === "data"));
    assert.doesNotMatch(
      review.stdout,
      /synthetic-secret|rawUID|apiKey|apiSecret|orderId/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
