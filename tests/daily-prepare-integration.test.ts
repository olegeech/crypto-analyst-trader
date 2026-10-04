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
import { requireDailyFixture as value } from "./fixtures/daily-planning-evidence-fixtures.js";
import {
  DAILY_PREPARE_CREDENTIALS,
  DAILY_PREPARE_TIME,
  DAILY_PREPARE_RUN_ID,
  DAILY_PREPARE_ORIGINS,
  dailyPrepareAccount,
  dailyPrepareIdentity,
  dailyPrepareMarket,
  dailyPrepareLiquidation,
} from "./fixtures/daily-prepare-fixtures.js";

test("released chain persists READY; fresh-process review and offline consent cannot create execution state", async () => {
  const root = mkdtempSync(join(tmpdir(), "daily-prepare-integration-"));
  const directory = join(root, "data/private/execution");
  const clock = value(fixedClock(DAILY_PREPARE_TIME));
  const openStore = (environment: "demo" | "testnet" | "mainnet") =>
    openSqlitePreparedArtifactStore({ environment, rootDirectory: directory });
  try {
    const boundary = createDailyPrepareBoundary({
      collectMarket: async (runId) => ok(dailyPrepareMarket(runId)),
      collectLiquidation: async (market) => ok(dailyPrepareLiquidation(market)),
      collectAccount: async (options) => {
        await options.credentialLoader.load(options.environment);
        return {
          kind: "account-evidence",
          bundle: dailyPrepareAccount({
            environment: options.environment,
            runId: options.runId,
          }),
        };
      },
      credentialLoader: { load: async () => DAILY_PREPARE_CREDENTIALS },
      createRiskReader: ({ environment }) => ({
        environment,
        origin: DAILY_PREPARE_ORIGINS[environment],
        readIdentity: async () => dailyPrepareIdentity(),
        readTargetPositions: async () => ({
          rows: dailyPrepareAccount().criticalPasses.B!.positions,
          observedAt: DAILY_PREPARE_TIME,
        }),
        readExchangeTime: async () => DAILY_PREPARE_TIME,
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
    assert.match(review.stdout, /READY_FOR_APPROVAL/u);
    assert.match(review.stdout, /not-configured/u);
    const redirected = spawnSync(
      process.execPath,
      ["--import", tsx, cli, "approve", ...args],
      { cwd: root, input: "yes\n", encoding: "utf8", timeout: 60000 },
    );
    assert.equal(redirected.status, 3, redirected.stderr);
    const deps = {
      prepare: async () => {
        throw new Error("offline only");
      },
      openStore,
      actor: localOperatorIdentity,
      clock,
      interactive: true,
      prompt: async () => "yes",
      write: () => {},
    };
    assert.equal(await runDailyCommand(["approve", ...args], deps), 0);
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
