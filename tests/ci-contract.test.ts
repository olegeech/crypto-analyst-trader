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
    /secrets\.|BYBIT_API_|test:testnet|audit:dependencies|api-testnet\.bybit\.com|placeOrder|create-order/i,
  );
});
