import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const skillPath = ".agents/skills/issue-delivery/SKILL.md";
const metadataPath = ".agents/skills/issue-delivery/agents/openai.yaml";

test("issue-delivery is discoverable and self-contained", async () => {
  const [skill, metadata, readme, agents, workflow] = await Promise.all([
    readFile(skillPath, "utf8"),
    readFile(metadataPath, "utf8"),
    readFile("README.md", "utf8"),
    readFile("AGENTS.md", "utf8"),
    readFile("docs/workflow.md", "utf8"),
  ]);

  assert.match(metadata, /display_name: ["']Issue Delivery["']/);
  assert.match(metadata, /\$issue-delivery/);
  assert.match(readme, /\$issue-delivery/);
  assert.match(agents, /\$issue-delivery/);
  assert.match(workflow, /named issue delivery/i);
  assert.doesNotMatch(skill, /\.agents\/skills\/(?!issue-delivery)/);
  assert.match(skill, /self-contained/i);
});

test("issue-delivery enforces the pre-development gates", async () => {
  const skill = await readFile(skillPath, "utf8");

  for (const requirement of [
    /exactly one issue number or unambiguous issue URL/i,
    /code, configuration, or canonical documentation/i,
    /epics, roadmap trackers, or no-PR housekeeping/i,
    /Product-owner interview.*Product-owner decisions/is,
    /Definition of Ready/i,
    /reviewer checks scope.*acceptance criteria.*dependencies.*safety.*failure behavior.*testability.*contradictions with canonical sources/is,
    /status:ready/i,
    /exactly one status label.*status:ready/is,
    /independent issue review/i,
    /maximum three attempts/i,
    /npm run review:target -- issue <issue>/,
    /npm run review:target -- pr <pr> <reviewed-head-sha>/,
    /review_scope_digest/,
    /REVIEW_INPUT_UNAVAILABLE/,
    /REVIEW_INPUT_STALE/,
    /malformed-output.*stale-input.*do not consume/is,
    /Claude's JSON result envelope.*plain-text/is,
    /BLOCKING.*MATERIAL.*NON_BLOCKING.*INFORMATIONAL/is,
    /reserves `BLOCKING` and `MATERIAL` for concrete defects.*wrong or unsafe/is,
    /ISSUE_REVIEW_CAP_REACHED/,
    /\$compound-engineering:lfg #<issue>/,
    /scope manifest/i,
    /pre-publication implementation plan or diff-scope\s+receipt/i,
    /For an existing unambiguous open PR, skip development/is,
    /one focused PR/i,
    /scope expansion/i,
  ]) {
    assert.match(skill, requirement);
  }
});

test("issue-delivery binds PR review and merge to exact evidence", async () => {
  const skill = await readFile(skillPath, "utf8");

  for (const requirement of [
    /After initial checks are green/i,
    /exact full head SHA/i,
    /REVIEWED_HEAD_SHA/,
    /adapter binds the exact full head SHA/i,
    /PR_REVIEW_CAP_REACHED/,
    /current head SHA equals/i,
    /release-checks/,
    /READY_FOR_MERGE/,
    /Without the literal `merge` input.*?no merge/is,
    /scripts\/merge-pr\.sh <PR-number> <reviewed-head-SHA>/,
    /--match-head-commit/,
    /Never replace the wrapper with an AI-only or implicit merge/i,
    /Non-blocking findings.*do not force stylistic churn/is,
    /REVIEWER_UNAVAILABLE/,
  ]) {
    assert.match(skill, requirement);
  }
});

test("issue-delivery includes every required structured dry-run case", async () => {
  const skill = await readFile(skillPath, "utf8");
  const cases = [
    "missing-po-interview",
    "not-ready",
    "issue-review-pass",
    "issue-review-block",
    "issue-review-cap",
    "scope-split",
    "development-helper-unavailable",
    "reviewer-unavailable",
    "ci-identified-failure",
    "ci-ambiguous-failure",
    "pr-review-pass",
    "pr-review-cap",
    "moved-reviewed-head",
    "default-ready-for-merge",
    "explicit-merge",
  ];

  for (const caseId of cases)
    assert.match(skill, new RegExp("`" + caseId + "`"));
  assert.match(skill, /npm run test:release/);
});
