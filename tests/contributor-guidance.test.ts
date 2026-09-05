import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("contributor surfaces point to one release command", async () => {
  const documents = await Promise.all([
    readFile("README.md", "utf8"),
    readFile("CONTRIBUTING.md", "utf8"),
    readFile(".github/pull_request_template.md", "utf8"),
  ]);
  for (const document of documents) {
    assert.match(document, /npm ci && npm run test:release/);
  }
});

test("issue templates retain lightweight core guidance", async () => {
  const [story, config] = await Promise.all([
    readFile(".github/ISSUE_TEMPLATE/story.yml", "utf8"),
    readFile(".github/ISSUE_TEMPLATE/config.yml", "utf8"),
  ]);
  for (const field of [
    "outcome",
    "why",
    "scope",
    "acceptance",
    "safety",
    "relationships",
    "verification",
  ]) {
    assert.match(story, new RegExp(`id: ${field}`));
  }
  assert.match(config, /blank_issues_enabled: false/);
  assert.doesNotMatch(story, /secret|credential|security audit/i);
});
