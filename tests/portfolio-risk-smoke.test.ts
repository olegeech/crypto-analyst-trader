import assert from "node:assert/strict";
import test from "node:test";
import {
  parsePortfolioRiskSmokeArgs,
  runPortfolioRiskSmoke,
  summarizePortfolioRiskResult,
} from "../scripts/smoke-bybit-portfolio-risk.js";
import { evaluatePortfolioRiskPreflight } from "../src/domain/risk/portfolio-risk-preflight.js";
import { createPortfolioRiskPolicy } from "../src/domain/risk/portfolio-risk-policy.js";
import { createQualityProfile } from "../src/domain/quality/quality-profile.js";
import { createDataQualityBoundary } from "../src/application/data-quality-assessment.js";
import { hashCanonical } from "../src/domain/identity/canonical-serialization.js";
import { parseUtcTimestamp } from "../src/domain/shared/time.js";
import { createAccountEvidenceCollectionResult } from "../src/domain/account/account-evidence-bundle.js";
import {
  portfolioRiskAccountInput,
  portfolioRiskPolicyInput,
  portfolioRiskPosition,
} from "./fixtures/portfolio-risk-fixtures.js";
import { portfolioRiskPlanningFixture } from "./fixtures/portfolio-risk-planning-fixtures.js";
import { withCounts, decimal } from "./account-evidence-fixture.js";

const argumentsForSmoke = [
  "--live",
  "--environment",
  "demo",
  "--run-id",
  "risk-smoke-1",
  "--daily-plan",
  "/tmp/daily-plan.json",
  "--composition",
  "/tmp/risk-composition.mjs",
];

function requireValue<T>(value: { ok: true; value: T } | { ok: false }): T {
  assert.equal(value.ok, true);
  if (!value.ok) throw new Error("fixture failed validation");
  return value.value;
}

function fixtureQualityBoundary(qualityProfile: unknown) {
  return requireValue(
    createDataQualityBoundary({
      qualityProfile,
      issuer: "portfolio-risk-smoke-fixture",
    }),
  );
}

function evaluatedResult(marketMaxAgeMs?: number, marketValidForMs?: number) {
  const planning = portfolioRiskPlanningFixture({
    fundingRate: "0",
    ...(marketMaxAgeMs === undefined ? {} : { marketMaxAgeMs }),
    ...(marketValidForMs === undefined ? {} : { marketValidForMs }),
  });
  const source = portfolioRiskAccountInput({
    positions: [portfolioRiskPosition()],
  });
  const hash = hashCanonical({
    exchange: "bybit",
    environment: "demo",
    userID: "123",
  });
  assert.equal(hash.ok, true);
  if (!hash.ok) throw new Error("identity fixture failed");
  const passes = {
    A: {
      ...source.criticalPasses.A!,
      totals: {
        ...source.criticalPasses.A!.totals,
        totalAvailableBalance: decimal("1000", "USD"),
      },
    },
    B: {
      ...source.criticalPasses.B!,
      totals: {
        ...source.criticalPasses.B!.totals,
        totalAvailableBalance: decimal("1000", "USD"),
      },
    },
  };
  const account = withCounts({
    ...source,
    criticalPasses: passes,
    accountBinding: {
      ...source.accountBinding,
      accountIdentityHash: hash.value,
    },
  });
  const policy = requireValue(
    createPortfolioRiskPolicy(portfolioRiskPolicyInput()),
  );
  const qualityProfile = requireValue(
    createQualityProfile(planning.qualityProfile),
  );
  const evaluationTime = requireValue(
    parseUtcTimestamp("2026-10-02T12:00:03.000Z"),
  );
  const result = evaluatePortfolioRiskPreflight({
    dailyPlan: planning.dailyPlan,
    account,
    policy,
    qualityProfile,
    evaluationTime,
  });
  return requireValue(result);
}

test("live smoke requires explicit environment, identity, artifacts and --live", () => {
  assert.deepEqual(parsePortfolioRiskSmokeArgs(argumentsForSmoke), {
    environment: "demo",
    runId: "risk-smoke-1",
    dailyPlanPath: "/tmp/daily-plan.json",
    compositionPath: "/tmp/risk-composition.mjs",
  });
  for (const invalid of [
    argumentsForSmoke.filter((arg) => arg !== "--live"),
    [...argumentsForSmoke, "--live"],
    argumentsForSmoke.map((arg, index) =>
      index === argumentsForSmoke.indexOf("demo") ? "public-mainnet" : arg,
    ),
    [...argumentsForSmoke, "--base-url", "https://example.invalid"],
    argumentsForSmoke.slice(0, -2),
  ])
    assert.throws(() => parsePortfolioRiskSmokeArgs(invalid));
});

test("evaluated smoke summary is canonical but excludes symbols, account facts and credentials", () => {
  const preflight = evaluatedResult();
  const summary = summarizePortfolioRiskResult(
    {
      kind: "evaluated",
      preflight,
      supplementalEvidenceStatus: "not-needed",
      supplementalFailureCode: null,
      providerRequestCount: 1,
      durationMs: 37,
    },
    "demo",
  );
  assert.deepEqual(summary.reasonCodes, preflight.reasonCodes);
  assert.equal(summary.environment, "demo");
  assert.equal(summary.preflightHash, preflight.contentHash);
  assert.equal(summary.accountCollectionStatus, "complete");
  assert.equal(summary.exchangeWrites, 0);
  assert.doesNotMatch(
    JSON.stringify(summary),
    /BTCUSDT|1000|accountIdentityHash|walletBalance|positionIdx|synthetic-secret|123/u,
  );
});

test("pre-auth failure smoke prints only safe metadata and does not start risk reads", async () => {
  const planning = portfolioRiskPlanningFixture({ fundingRate: "0" });
  const account = createAccountEvidenceCollectionResult({
    kind: "pre-auth-failure",
    environment: "demo",
    runId: "DO-NOT-PRINT",
    policyVersion: "account-evidence-collection-policy/v1",
    startedAt: "2026-10-02T12:00:00.000Z",
    endedAt: "2026-10-02T12:00:01.000Z",
    reasonCodes: ["CREDENTIALS_UNAVAILABLE"],
  });
  assert.equal(account.ok, true);
  if (!account.ok) return;
  const output: string[] = [];
  let readerCreated = false;
  const exit = await runPortfolioRiskSmoke(argumentsForSmoke, {
    loadComposition: async () => ({
      policy: portfolioRiskPolicyInput(),
      qualityProfile: planning.qualityProfile,
      qualityBoundary: fixtureQualityBoundary(planning.qualityProfile),
    }),
    readPlan: async () => planning.dailyPlan,
    collect: async () => account.value,
    credentialProvider: {
      load: async () => ({
        apiKey: "SECRET-KEY",
        apiSecret: "SECRET-SECRET",
        accountId: "PRIVATE-UID",
      }),
    },
    createReader: () => {
      readerCreated = true;
      throw new Error("reader must not be created after pre-auth failure");
    },
    write: (line) => output.push(line),
  });
  assert.equal(exit, 1);
  assert.equal(readerCreated, false);
  assert.equal(output.length, 1);
  assert.deepEqual(Object.keys(JSON.parse(output[0]!)).sort(), [
    "endedAt",
    "environment",
    "exchangeWrites",
    "kind",
    "reasonCodes",
    "startedAt",
  ]);
  assert.doesNotMatch(output.join(""), /DO-NOT-PRINT|SECRET|PRIVATE-UID/u);
});

test("live smoke collects, authenticates and evaluates PASS/BLOCK with stable exit and sanitized summary", async () => {
  const passPreflight = evaluatedResult(1_000_000_000, 1_000_000_000);
  assert.equal(passPreflight.verdict, "PASS");
  const passCollection = requireValue(
    createAccountEvidenceCollectionResult({
      kind: "account-evidence",
      bundle: passPreflight.replayInputs.account,
    }),
  );
  const passOutput: string[] = [];
  let providerReads = 0;
  const providerTime = requireValue(
    parseUtcTimestamp("2026-10-02T12:00:03.000Z"),
  );
  const dependencies = {
    loadComposition: async () => ({
      policy: passPreflight.replayInputs.policy,
      qualityProfile: passPreflight.replayInputs.qualityProfile,
      qualityBoundary: fixtureQualityBoundary(
        passPreflight.replayInputs.qualityProfile,
      ),
    }),
    readPlan: async () => passPreflight.replayInputs.dailyPlan,
    collect: async () => passCollection,
    credentialProvider: {
      load: async () => ({
        apiKey: "synthetic-key",
        apiSecret: "synthetic-secret",
        accountId: "123",
      }),
    },
    createReader: () => ({
      environment: "demo" as const,
      origin: "https://api-demo.bybit.com",
      readIdentity: async () => {
        providerReads++;
        return {
          time: Date.parse(providerTime),
          result: {
            userID: "123",
            readOnly: 1,
            permissions: { ContractTrade: [], Spot: [], Wallet: [] },
            ips: [],
            expiredAt: "",
          },
        };
      },
      readTargetPositions: async () => {
        assert.fail("known pass-B leverage must not require a target read");
      },
      readExchangeTime: async () => {
        providerReads++;
        return providerTime;
      },
      requestCount: () => providerReads,
    }),
    write: (line: string) => passOutput.push(line),
  };
  const passExit = await runPortfolioRiskSmoke(argumentsForSmoke, dependencies);
  assert.equal(passExit, 0);
  const passSummary = JSON.parse(passOutput[0]!);
  assert.equal(passSummary.kind, "evaluated");
  assert.equal(passSummary.verdict, "PASS");
  assert.equal(passSummary.exchangeWrites, 0);
  assert.equal(passSummary.accountCollection.kind, "account-evidence");
  assert.equal(passSummary.accountCollection.status, "complete");
  assert.equal(passSummary.preflightHash, passPreflight.contentHash);
  assert.equal(passSummary.providerRequestCount, 2);
  assert.doesNotMatch(
    passOutput.join(""),
    /synthetic-secret|synthetic-key|accountIdentityHash|walletBalance|BTCUSDT|userID/u,
  );

  const account = passPreflight.replayInputs.account;
  const blockedCollection = requireValue(
    createAccountEvidenceCollectionResult({
      kind: "account-evidence",
      bundle: {
        ...account,
        criticalPasses: {
          A: {
            ...account.criticalPasses.A!,
            totals: {
              ...account.criticalPasses.A!.totals,
              totalAvailableBalance: decimal("0", "USD"),
            },
          },
          B: {
            ...account.criticalPasses.B!,
            totals: {
              ...account.criticalPasses.B!.totals,
              totalAvailableBalance: decimal("0", "USD"),
            },
          },
        },
      },
    }),
  );
  const blockOutput: string[] = [];
  const blockExit = await runPortfolioRiskSmoke(argumentsForSmoke, {
    ...dependencies,
    collect: async () => blockedCollection,
    write: (line: string) => blockOutput.push(line),
  });
  assert.equal(blockExit, 1);
  const blockSummary = JSON.parse(blockOutput[0]!);
  assert.equal(blockSummary.kind, "evaluated");
  assert.equal(blockSummary.verdict, "BLOCK");
  assert.ok(blockSummary.reasonCodes.length > 0);
  assert.equal(blockSummary.exchangeWrites, 0);
  assert.doesNotMatch(blockOutput.join(""), /synthetic-secret|synthetic-key/u);
});
