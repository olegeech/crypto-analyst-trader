import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
  scripts: Record<string, string>;
};
const ciWorkflow = await readFile(".github/workflows/ci.yml", "utf8");
const demoVerificationScript = await readFile(
  "scripts/bybit-demo-adapter-verification.ts",
  "utf8",
);
const coinalyzeSmokeScript = await readFile(
  "scripts/coinalyze-liquidation-smoke.ts",
  "utf8",
);
const coinalyzeFullSmokeScript = await readFile(
  "scripts/coinalyze-liquidation-full-smoke.ts",
  "utf8",
);
const traderDemoCli = await readFile("src/cli/trader-demo.ts", "utf8");
const tsconfig = JSON.parse(await readFile("tsconfig.json", "utf8")) as {
  include: string[];
};
const execFileAsync = promisify(execFile);
const releaseScript = packageJson.scripts["test:release"];
assert.ok(releaseScript);
const releaseStages = releaseScript
  .split(" && ")
  .map((command) => command.replace(/^npm (?:run )?/, ""));

test("release script contains every blocking repository check", () => {
  let previousIndex = -1;
  for (const stage of [
    "typecheck",
    "lint",
    "format:check",
    "check:repository-safety",
    "test",
  ]) {
    const command = stage === "test" ? "npm test" : `npm run ${stage}`;
    const index = releaseScript.indexOf(command);
    assert.ok(index > previousIndex, `${stage} should be in release order`);
    previousIndex = index;
  }
});

test("scripts are included in the TypeScript project", () => {
  assert.ok(tsconfig.include.includes("scripts"));
});

test("review:target is explicit and excluded from default release execution", () => {
  assert.match(
    packageJson.scripts["review:target"] ?? "",
    /node --import tsx scripts\/review-target\.ts/,
  );
  assert.doesNotMatch(releaseScript, /review:target/);
});

test("release composition propagates each blocking stage failure", async () => {
  for (const failingStage of ["typecheck", "lint", "format:check", "test"]) {
    const root = await mkdtemp(join(tmpdir(), "release-contract-"));
    try {
      const scripts = Object.fromEntries(
        releaseStages.map((stage) => [
          stage,
          `node -e "process.exit(${stage === failingStage ? 1 : 0})"`,
        ]),
      );
      scripts["test:release"] = releaseScript;
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({ name: "release-fixture", scripts }),
      );

      await assert.rejects(
        execFileAsync("npm", ["run", "test:release"], { cwd: root }),
        (error) => {
          const result = error as { stdout?: string; stderr?: string };
          assert.ok(
            `${result.stdout ?? ""}${result.stderr ?? ""}`.includes(
              `> ${failingStage}\n`,
            ),
          );
          return true;
        },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("default CI delegates to the same release command without secrets or optional checks", () => {
  assert.match(ciWorkflow, /run: npm ci/);
  assert.match(ciWorkflow, /run: npm run test:release/);
  assert.doesNotMatch(
    ciWorkflow,
    /secrets\.|BYBIT_API_|credentials:(?:setup|remove|connect)|test:testnet|audit:dependencies|api-testnet\.bybit\.com|placeOrder|create-order/i,
  );
  assert.doesNotMatch(ciWorkflow, /review:target|scripts\/review-target\.ts/);
  assert.doesNotMatch(
    ciWorkflow,
    /probe:bybit:|scripts\/bybit-capability-probe\.ts/,
  );
});

test("the write probe is absent from release execution", () => {
  assert.doesNotMatch(releaseScript, /probe:bybit:testnet/);
  assert.doesNotMatch(releaseScript, /probe:bybit:demo/);
  assert.doesNotMatch(releaseScript, /scripts\/bybit-capability-probe\.ts/);
});

test("Demo adapter verification is explicit, Demo-only and excluded from CI/release", () => {
  assert.match(
    packageJson.scripts["verify:bybit:demo-adapter"] ?? "",
    /scripts\/bybit-demo-adapter-verification\.ts/,
  );
  assert.doesNotMatch(releaseScript, /verify:bybit:demo-adapter/);
  assert.doesNotMatch(
    ciWorkflow,
    /verify:bybit:demo-adapter|bybit-demo-adapter-verification/,
  );
  assert.doesNotMatch(
    demoVerificationScript,
    /testnet|mainnet|api-testnet\.bybit\.com|api\.bybit\.com/iu,
  );
  assert.doesNotMatch(demoVerificationScript, /confirm-demo/iu);
});

test("the managed Demo trader CLI is fixed-origin and excluded from CI/release", () => {
  assert.match(
    packageJson.scripts["trader:demo"] ?? "",
    /node --import tsx src\/cli\/trader-demo\.ts/,
  );
  assert.doesNotMatch(releaseScript, /trader:demo|src\/cli\/trader-demo\.ts/);
  assert.doesNotMatch(ciWorkflow, /trader:demo|src\/cli\/trader-demo\.ts/);
  assert.match(traderDemoCli, /load\("demo"\)/);
  assert.match(traderDemoCli, /timeInForce.*GTC|TIME_IN_FORCE=\$\{/u);
  assert.doesNotMatch(
    traderDemoCli,
    /testnet|mainnet|api-testnet\.bybit\.com|api\.bybit\.com/iu,
  );
  assert.doesNotMatch(
    traderDemoCli,
    /--environment|--time-in-force|--confirm-demo|--report/iu,
  );
});

test("Coinalyze live characterization is explicitly gated and excluded from release", () => {
  assert.match(
    packageJson.scripts["coinalyze:liquidation:smoke"] ?? "",
    /scripts\/coinalyze-liquidation-smoke\.ts/,
  );
  assert.doesNotMatch(releaseScript, /coinalyze:liquidation:smoke/u);
  assert.doesNotMatch(ciWorkflow, /coinalyze:liquidation:smoke/u);
  assert.match(coinalyzeSmokeScript, /args\[0\] === "--live"/u);
  assert.match(coinalyzeSmokeScript, /liveConfirmed/u);
});

test("full Coinalyze collector smoke is live-gated, run-scoped, and excluded from CI", () => {
  assert.match(
    packageJson.scripts["coinalyze:liquidation:full-smoke"] ?? "",
    /scripts\/coinalyze-liquidation-full-smoke\.ts/u,
  );
  assert.doesNotMatch(releaseScript, /coinalyze:liquidation:full-smoke/u);
  assert.doesNotMatch(ciWorkflow, /coinalyze:liquidation:full-smoke/u);
  assert.match(coinalyzeFullSmokeScript, /args\[0\] !== "--live"/u);
  assert.match(coinalyzeFullSmokeScript, /collectMarketEvidence/u);
  assert.match(coinalyzeFullSmokeScript, /collectLiquidationEvidence/u);
  assert.match(coinalyzeFullSmokeScript, /canonicalHash/u);
});
