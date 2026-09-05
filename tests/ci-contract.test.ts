import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
  scripts: Record<string, string>;
};
const ciWorkflow = await readFile(".github/workflows/ci.yml", "utf8");

test("release script contains every blocking repository check", () => {
  assert.equal(
    packageJson.scripts["test:release"],
    "npm run typecheck && npm run lint && npm run format:check && npm run check:repository-safety && npm test",
  );
});

test("default CI delegates to the same release command without secrets or optional checks", () => {
  assert.match(ciWorkflow, /run: npm ci/);
  assert.match(ciWorkflow, /run: npm run test:release/);
  assert.doesNotMatch(
    ciWorkflow,
    /secrets\.|BYBIT_API_|test:testnet|audit:dependencies|api-testnet\.bybit\.com|placeOrder|create-order/i,
  );
});
