import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("contributor surfaces select validation by risk without mandatory local duplication", async () => {
  const [contributing, template, workflow, readme] = await Promise.all([
    readFile("CONTRIBUTING.md", "utf8"),
    readFile(".github/pull_request_template.md", "utf8"),
    readFile("docs/workflow.md", "utf8"),
    readFile("README.md", "utf8"),
  ]);
  for (const document of [contributing, template, workflow, readme]) {
    assert.match(document, /risk-based.validation/iu);
  }
  assert.match(
    contributing,
    /Documentation-only changes do not require a full local release suite/u,
  );
  assert.match(contributing, /npm run test:release/u);
  assert.match(template, /exact commit SHA/u);
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
});
