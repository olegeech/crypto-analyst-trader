import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createDailyPrepareBoundary } from "../src/application/daily-prepare.js";
import { openSqlitePreparedArtifactStore } from "../src/adapters/sqlite/prepared-artifact-store.js";
import { openSqliteShadowReportStore } from "../src/adapters/sqlite/shadow-report-store.js";
import { runDailyCommand } from "../src/cli/daily-command.js";
import {
  canonicalSerialize,
  hashCanonical,
} from "../src/domain/identity/canonical-serialization.js";
import { localOperatorIdentity } from "../src/application/local-operator.js";
import { ok } from "../src/domain/shared/result.js";
import { fixedClock, parseUtcTimestamp } from "../src/domain/shared/time.js";
import { validatePreparedPlanApproval } from "../src/domain/review/prepared-plan-approval.js";
import {
  createPreparedDailyPlanV2,
  type PreparedDailyPlan,
} from "../src/domain/review/prepared-daily-plan.js";
import type { ShadowMarketReport } from "../src/domain/review/shadow-market-report.js";
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
  const openShadowStore = (environment: "demo" | "testnet" | "mainnet") =>
    openSqliteShadowReportStore({ environment, rootDirectory: directory });
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
      shadowReportStoreForEnvironment: openShadowStore,
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
    // Pin the complete persisted v3 replay identity, including the recorded
    // shadow context, so changes require an explicit artifact version review.
    assert.equal(
      prepared.contentHash,
      "sha256:ad470f398951a9245b202c636b7421999204bcd7f5c04e228d695d5c023c7b2f",
    );
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
    assert.ok(result.diagnostics.shadowReportHash?.startsWith("sha256:"));
    const shadowStore = value(openShadowStore("demo"));
    try {
      const report = value(
        shadowStore.loadShadowReport(result.diagnostics.shadowReportHash!),
      );
      assert.ok(report);
      assert.deepEqual(report?.context, prepared.replayInputs.shadowContext);
    } finally {
      shadowStore.close();
    }

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
    const shadowReview = spawnSync(
      process.execPath,
      [
        "--import",
        tsx,
        cli,
        "review",
        "--environment",
        "demo",
        "--shadow-hash",
        result.diagnostics.shadowReportHash!,
      ],
      { cwd: root, encoding: "utf8", timeout: 60000 },
    );
    assert.equal(shadowReview.status, 0, shadowReview.stderr);
    assert.ok(
      shadowReview.stdout.includes(result.diagnostics.shadowReportHash!),
    );
    assert.match(shadowReview.stdout, /Shadow-only report/u);
    assert.match(shadowReview.stdout, /NO_CALIBRATED_MODEL/u);
    assert.doesNotMatch(shadowReview.stdout, /PREPARED_HASH/u);
    const shadowApprove = spawnSync(
      process.execPath,
      [
        "--import",
        tsx,
        cli,
        "approve",
        "--environment",
        "demo",
        "--shadow-hash",
        result.diagnostics.shadowReportHash!,
      ],
      { cwd: root, input: "yes\n", encoding: "utf8", timeout: 60000 },
    );
    assert.equal(shadowApprove.status, 2, shadowApprove.stderr);
    const shadowApproveAsPrepared = spawnSync(
      process.execPath,
      [
        "--import",
        tsx,
        cli,
        "approve",
        "--environment",
        "demo",
        "--prepared-hash",
        result.diagnostics.shadowReportHash!,
      ],
      { cwd: root, input: "yes\n", encoding: "utf8", timeout: 60000 },
    );
    assert.equal(
      shadowApproveAsPrepared.status,
      4,
      shadowApproveAsPrepared.stderr,
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
      openShadowStore,
      write: (text: string) => {
        offlineReviewOutput += text;
      },
    };
    assert.equal(await runDailyCommand(["review", ...args], deps), 0);
    assert.ok(offlineReviewOutput.includes(prepared.contentHash));
    assert.equal(offlinePrepareCalls, 0);
    const futureReviewOutput: string[] = [];
    const futureClock = value(
      fixedClock(value(parseUtcTimestamp("2027-01-01T00:00:00.000Z"))),
    );
    assert.equal(
      await runDailyCommand(["review", ...args], {
        ...deps,
        clock: futureClock,
        write: (text: string) => futureReviewOutput.push(text),
      }),
      0,
    );
    const expiredReview = futureReviewOutput.join("\n");
    assert.ok(expiredReview.includes(prepared.contentHash));
    assert.match(
      expiredReview,
      /saved historical snapshot; review does not refresh it or claim that it is current/u,
    );
    assert.match(
      expiredReview,
      new RegExp(
        '"evaluationTime": "' + prepared.inputIdentity.evaluationTime + '"',
        "u",
      ),
    );
    assert.match(
      expiredReview,
      new RegExp('"asOf": "' + savedShadowSummary.asOf + '"', "u"),
    );
    assert.doesNotMatch(expiredReview, /2027-01-01T00:00:00\.000Z/u);
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

test("blocked history still persists an offline, shadow-only report across processes", async () => {
  const root = mkdtempSync(join(tmpdir(), "daily-shadow-report-integration-"));
  const directory = join(root, "data/private/execution");
  const clock = value(fixedClock(DAILY_PREPARE_TIME));
  const reads = { account: 0, credentials: 0, risk: 0 };
  const openStore = (environment: "demo" | "testnet" | "mainnet") =>
    openSqlitePreparedArtifactStore({ environment, rootDirectory: directory });
  const openShadowStore = (environment: "demo" | "testnet" | "mainnet") =>
    openSqliteShadowReportStore({ environment, rootDirectory: directory });
  try {
    const boundary = createDailyPrepareBoundary({
      collectMarket: async (runId) => ok(dailyPrepareMarket(runId)),
      collectLiquidation: async (market, selectedAsset) =>
        ok(dailyPrepareLiquidationV3(market, selectedAsset, "missing")),
      collectAccount: async () => {
        reads.account++;
        throw new Error("blocked preparation must not read account data");
      },
      credentialLoader: {
        load: async () => {
          reads.credentials++;
          throw new Error("blocked preparation must not load credentials");
        },
      },
      createRiskReader: () => {
        reads.risk++;
        throw new Error("blocked preparation must not read private risk data");
      },
      storeForEnvironment: openStore,
      shadowReportStoreForEnvironment: openShadowStore,
      clock,
      newRunId: () => DAILY_PREPARE_RUN_ID,
    });
    const result = await boundary.prepare({
      environment: "demo",
      symbol: "BTCUSDT",
      allocation: "10",
    });
    assert.equal(result.kind, "blocked", JSON.stringify(result));
    if (result.kind !== "blocked") return;
    assert.equal(result.stage, "planning");
    assert.equal(result.diagnostics.liquidationStatus, "incomplete");
    assert.equal(result.diagnostics.historyProof, "incomplete");
    assert.equal(result.diagnostics.exchangeWrites, 0);
    assert.equal(result.diagnostics.executionAuthority, "none");
    assert.ok(result.diagnostics.shadowReportHash?.startsWith("sha256:"));
    assert.deepEqual(reads, { account: 0, credentials: 0, risk: 0 });

    // The writer was closed by prepare. Reopen the same SQLite store to replay.
    const reopened = value(openShadowStore("demo"));
    let loadedReport: ShadowMarketReport | undefined;
    try {
      const report = value(
        reopened.loadShadowReport(result.diagnostics.shadowReportHash!),
      );
      assert.ok(report);
      loadedReport = report;
      assert.equal(report?.environment, "demo");
      assert.equal(report?.runId, DAILY_PREPARE_RUN_ID);
      assert.equal(report?.context.status, "recorded");
    } finally {
      reopened.close();
    }
    const otherEnvironment = value(openShadowStore("testnet"));
    try {
      assert.ok(loadedReport);
      assert.equal(otherEnvironment.saveShadowReport(loadedReport!).ok, false);
    } finally {
      otherEnvironment.close();
    }

    const cli = resolve("src/cli/daily.ts");
    const tsx = resolve("node_modules/tsx/dist/loader.mjs");
    const review = spawnSync(
      process.execPath,
      [
        "--import",
        tsx,
        cli,
        "review",
        "--environment",
        "demo",
        "--shadow-hash",
        result.diagnostics.shadowReportHash!,
      ],
      { cwd: root, encoding: "utf8", timeout: 60000 },
    );
    assert.equal(review.status, 0, review.stderr);
    assert.match(review.stdout, /SHADOW_REPORT_HASH: sha256:/u);
    assert.match(review.stdout, /Shadow-only report/u);
    assert.doesNotMatch(
      review.stdout,
      /PREPARED_HASH|accountIdentityHash|apiSecret/u,
    );
    const mismatch = spawnSync(
      process.execPath,
      [
        "--import",
        tsx,
        cli,
        "review",
        "--environment",
        "testnet",
        "--shadow-hash",
        result.diagnostics.shadowReportHash!,
      ],
      { cwd: root, encoding: "utf8", timeout: 60000 },
    );
    assert.equal(mismatch.status, 4, mismatch.stderr);
    assert.match(mismatch.stdout, /SHADOW_REPORT_NOT_FOUND/u);
    const db = new DatabaseSync(join(directory, "demo.db"));
    try {
      assert.equal(
        db.prepare("SELECT COUNT(*) AS n FROM artifacts").get()?.n,
        0,
      );
      const stored = db
        .prepare("SELECT canonical_json FROM shadow_market_reports")
        .get() as { canonical_json: string };
      assert.doesNotMatch(
        stored.canonical_json,
        /apiKey|apiSecret|accountId|accountIdentityHash/u,
      );
      assert.throws(
        () =>
          db
            .prepare(
              "UPDATE shadow_market_reports SET canonical_json = '{}' WHERE content_hash = ?",
            )
            .run(result.diagnostics.shadowReportHash!),
        /immutable/u,
      );
      assert.ok(loadedReport);
      const { contentHash: _originalHash, ...unsupportedPayload } = {
        ...loadedReport,
        context: {
          ...loadedReport.context,
          model: {
            ...loadedReport.context.model,
            modelVersion: "existing-evidence-shadow/v2",
          },
        },
      };
      void _originalHash;
      const unsupportedHash = value(hashCanonical(unsupportedPayload));
      const unsupportedReport = {
        ...unsupportedPayload,
        contentHash: unsupportedHash,
      };
      const unsupportedJson = value(canonicalSerialize(unsupportedReport));
      const unsupportedCanonicalHash = `sha256:${createHash("sha256")
        .update(unsupportedJson, "utf8")
        .digest("hex")}`;
      db.prepare(
        `INSERT INTO shadow_market_reports
         (content_hash, environment, canonical_json, canonical_hash, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        unsupportedHash,
        "demo",
        unsupportedJson,
        unsupportedCanonicalHash,
        DAILY_PREPARE_TIME,
      );
      const misboundRowKey = `sha256:${"f".repeat(64)}`;
      assert.notEqual(unsupportedHash, misboundRowKey);
      db.prepare(
        `INSERT INTO shadow_market_reports
         (content_hash, environment, canonical_json, canonical_hash, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        misboundRowKey,
        "demo",
        unsupportedJson,
        unsupportedCanonicalHash,
        DAILY_PREPARE_TIME,
      );
      const { contentHash: _unsupportedHash, ...misboundEnvironmentPayload } = {
        ...unsupportedReport,
        environment: "testnet",
      };
      void _unsupportedHash;
      const misboundEnvironmentHash = value(
        hashCanonical(misboundEnvironmentPayload),
      );
      const misboundEnvironmentReport = {
        ...misboundEnvironmentPayload,
        contentHash: misboundEnvironmentHash,
      };
      const misboundEnvironmentJson = value(
        canonicalSerialize(misboundEnvironmentReport),
      );
      const misboundEnvironmentCanonicalHash = `sha256:${createHash("sha256")
        .update(misboundEnvironmentJson, "utf8")
        .digest("hex")}`;
      db.prepare(
        `INSERT INTO shadow_market_reports
         (content_hash, environment, canonical_json, canonical_hash, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        misboundEnvironmentHash,
        "demo",
        misboundEnvironmentJson,
        misboundEnvironmentCanonicalHash,
        DAILY_PREPARE_TIME,
      );
      const staleVersionReport = {
        ...unsupportedReport,
        contentHash: loadedReport.contentHash,
      };
      const staleVersionJson = value(canonicalSerialize(staleVersionReport));
      const staleVersionCanonicalHash = `sha256:${createHash("sha256")
        .update(staleVersionJson, "utf8")
        .digest("hex")}`;
      const { contentHash: _loadedHash, ...malformedNestedPayload } = {
        ...loadedReport,
        sources: {
          ...loadedReport.sources,
          liquidation: {
            ...loadedReport.sources.liquidation,
            schemaVersion: null,
          },
        },
      };
      void _loadedHash;
      const malformedNestedHash = value(hashCanonical(malformedNestedPayload));
      const malformedNestedReport = {
        ...malformedNestedPayload,
        contentHash: malformedNestedHash,
      };
      const malformedNestedJson = value(
        canonicalSerialize(malformedNestedReport),
      );
      const malformedNestedCanonicalHash = `sha256:${createHash("sha256")
        .update(malformedNestedJson, "utf8")
        .digest("hex")}`;
      db.prepare(
        `INSERT INTO shadow_market_reports
         (content_hash, environment, canonical_json, canonical_hash, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        malformedNestedHash,
        "demo",
        malformedNestedJson,
        malformedNestedCanonicalHash,
        DAILY_PREPARE_TIME,
      );
      db.exec("DROP TRIGGER shadow_market_reports_no_update");
      db.prepare(
        `UPDATE shadow_market_reports
         SET canonical_json = ?, canonical_hash = ?
         WHERE content_hash = ?`,
      ).run(
        staleVersionJson,
        staleVersionCanonicalHash,
        result.diagnostics.shadowReportHash!,
      );
      const tamperedStore = value(openShadowStore("demo"));
      try {
        const tampered = tamperedStore.loadShadowReport(
          result.diagnostics.shadowReportHash!,
        );
        assert.equal(tampered.ok, false);
        if (!tampered.ok)
          assert.equal(tampered.error.code, "PERSISTENCE_INTEGRITY");
        const unsupported = tamperedStore.loadShadowReport(unsupportedHash);
        assert.equal(unsupported.ok, false);
        if (!unsupported.ok)
          assert.equal(unsupported.error.code, "UNSUPPORTED_CONTRACT");
        const misbound = tamperedStore.loadShadowReport(misboundRowKey);
        assert.equal(misbound.ok, false);
        if (!misbound.ok)
          assert.equal(misbound.error.code, "PERSISTENCE_INTEGRITY");
        const environmentMisbound = tamperedStore.loadShadowReport(
          misboundEnvironmentHash,
        );
        assert.equal(environmentMisbound.ok, false);
        if (!environmentMisbound.ok)
          assert.equal(environmentMisbound.error.code, "PERSISTENCE_INTEGRITY");
        const malformedNested =
          tamperedStore.loadShadowReport(malformedNestedHash);
        assert.equal(malformedNested.ok, false);
        if (!malformedNested.ok)
          assert.equal(malformedNested.error.code, "PERSISTENCE_INTEGRITY");
      } finally {
        tamperedStore.close();
      }
      const unsupportedCli = spawnSync(
        process.execPath,
        [
          "--import",
          tsx,
          cli,
          "review",
          "--environment",
          "demo",
          "--shadow-hash",
          unsupportedHash,
        ],
        { cwd: root, encoding: "utf8", timeout: 60000 },
      );
      assert.equal(unsupportedCli.status, 5, unsupportedCli.stderr);
      assert.match(
        unsupportedCli.stdout,
        /SHADOW_REPORT_UNSUPPORTED_CONTRACT/u,
      );
      const malformedNestedCli = spawnSync(
        process.execPath,
        [
          "--import",
          tsx,
          cli,
          "review",
          "--environment",
          "demo",
          "--shadow-hash",
          malformedNestedHash,
        ],
        { cwd: root, encoding: "utf8", timeout: 60000 },
      );
      assert.equal(malformedNestedCli.status, 5, malformedNestedCli.stderr);
      assert.match(malformedNestedCli.stdout, /SHADOW_REPORT_INTEGRITY/u);
      const noncanonicalUnsupportedJson = JSON.stringify(
        JSON.parse(unsupportedJson) as unknown,
        null,
        2,
      );
      const noncanonicalUnsupportedHash = `sha256:${createHash("sha256")
        .update(noncanonicalUnsupportedJson, "utf8")
        .digest("hex")}`;
      db.prepare(
        `UPDATE shadow_market_reports
         SET canonical_json = ?, canonical_hash = ?
         WHERE content_hash = ?`,
      ).run(
        noncanonicalUnsupportedJson,
        noncanonicalUnsupportedHash,
        unsupportedHash,
      );
      const noncanonicalStore = value(openShadowStore("demo"));
      try {
        const noncanonical =
          noncanonicalStore.loadShadowReport(unsupportedHash);
        assert.equal(noncanonical.ok, false);
        if (!noncanonical.ok) {
          assert.equal(noncanonical.error.code, "PERSISTENCE_INTEGRITY");
          assert.equal(
            noncanonical.error.message,
            "stored shadow report is not canonical",
          );
        }
      } finally {
        noncanonicalStore.close();
      }
      const noncanonicalCli = spawnSync(
        process.execPath,
        [
          "--import",
          tsx,
          cli,
          "review",
          "--environment",
          "demo",
          "--shadow-hash",
          unsupportedHash,
        ],
        { cwd: root, encoding: "utf8", timeout: 60000 },
      );
      assert.equal(noncanonicalCli.status, 5, noncanonicalCli.stderr);
      assert.match(noncanonicalCli.stdout, /SHADOW_REPORT_INTEGRITY/u);
      const tamperedCli = spawnSync(
        process.execPath,
        [
          "--import",
          tsx,
          cli,
          "review",
          "--environment",
          "demo",
          "--shadow-hash",
          result.diagnostics.shadowReportHash!,
        ],
        { cwd: root, encoding: "utf8", timeout: 60000 },
      );
      assert.equal(tamperedCli.status, 5, tamperedCli.stderr);
      assert.match(tamperedCli.stdout, /SHADOW_REPORT_INTEGRITY/u);
      const misboundCli = spawnSync(
        process.execPath,
        [
          "--import",
          tsx,
          cli,
          "review",
          "--environment",
          "demo",
          "--shadow-hash",
          misboundRowKey,
        ],
        { cwd: root, encoding: "utf8", timeout: 60000 },
      );
      assert.equal(misboundCli.status, 5, misboundCli.stderr);
      assert.match(misboundCli.stdout, /SHADOW_REPORT_INTEGRITY/u);
    } finally {
      db.close();
    }
    assert.deepEqual(reads, { account: 0, credentials: 0, risk: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
