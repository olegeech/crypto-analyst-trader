import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path: string) => readFile(path, "utf8");

const skillSpecs = [
  {
    name: "daily-rebalance",
    path: ".agents/skills/daily-rebalance/SKILL.md",
  },
  {
    name: "test-current-feature-pr",
    path: ".agents/skills/test-current-feature-pr/SKILL.md",
  },
  {
    name: "develop-next-roadmap-story",
    path: ".agents/skills/develop-next-roadmap-story/SKILL.md",
  },
] as const;

test("publishes the canonical operator runbook and skill links", async () => {
  const [readme, agents, runbook] = await Promise.all([
    read("README.md"),
    read("AGENTS.md"),
    read("docs/operator-runbook.md"),
  ]);

  assert.match(
    readme,
    /\[Daily operator runbook\]\(docs\/operator-runbook\.md\)/,
  );
  assert.match(agents, /docs\/operator-runbook\.md/);
  assert.match(
    runbook,
    /prepare -> review -> approve -> execute -> reconcile -> report/,
  );
});

test("keeps execution modes and exact approval fail closed", async () => {
  const [runbook, invariants, skill] = await Promise.all([
    read("docs/operator-runbook.md"),
    read("docs/architecture/invariants.md"),
    read(skillSpecs[0].path),
  ]);

  for (const mode of ["PREPARE_ONLY", "TESTNET_EXECUTE", "MAINNET_EXECUTE"]) {
    assert.match(runbook, new RegExp(`\\b${mode}\\b`));
    assert.match(skill, new RegExp(`\\b${mode}\\b`));
  }

  assert.match(runbook, /approval of the exact plan hash/i);
  assert.match(skill, /(approval|approve)[\s\S]{0,80}exact( plan)? hash/i);
  assert.match(invariants, /approved, unexpired exact plan hash/i);
  assert.match(runbook, /Never blind-retry an ambiguous write/i);
  assert.match(runbook, /Set `HALT`/);
});

test("keeps timing policy versioned instead of hard-coding a market session", async () => {
  const [runbook, skill] = await Promise.all([
    read("docs/operator-runbook.md"),
    read(skillSpecs[0].path),
  ]);

  assert.match(runbook, /timing is defined by the active versioned strategy or\s+operating policy/i);
  assert.match(skill, /active versioned timing policy/i);
  assert.doesNotMatch(runbook, /09:45\s+America\/New_York/i);
  assert.doesNotMatch(runbook, /United States cash-market holidays/i);
});

test("makes validated evidence identity part of immutable planning", async () => {
  const [runbook, skill, invariants] = await Promise.all([
    read("docs/operator-runbook.md"),
    read(skillSpecs[0].path),
    read("docs/architecture/invariants.md"),
  ]);

  assert.match(runbook, /validated evidence references and hashes/i);
  assert.match(runbook, /evidence references or hashes[\s\S]{0,160}invalidates the approval/i);
  assert.match(skill, /evidence refs\/hashes/i);
  assert.match(invariants, /Evidence that can affect a live-ready plan/i);
});

test("declares complete repository skill metadata without placeholders", async () => {
  const skills = await Promise.all(
    skillSpecs.map(async ({ name, path }) => ({
      contents: await read(path),
      name,
    })),
  );

  for (const { contents, name } of skills) {
    assert.match(contents, new RegExp(`^---\\nname: ${name}\\n`, "m"));
    assert.match(contents, /\ndescription: ".*"\n---\n/);
    assert.doesNotMatch(contents, /\bTODO\b/);

    const metadata = await read(`.agents/skills/${name}/agents/openai.yaml`);
    assert.match(metadata, new RegExp(`\\$${name}\\b`));
  }
});

test("separates daily operation, PR review, and roadmap delivery authority", async () => {
  const [daily, review, roadmap] = await Promise.all([
    read(skillSpecs[0].path),
    read(skillSpecs[1].path),
    read(skillSpecs[2].path),
  ]);

  assert.match(daily, /Default to `PREPARE_ONLY`/);
  assert.match(review, /Never perform a mainnet write during PR review/);
  assert.match(review, /exact head commit/i);
  assert.match(roadmap, /Do not select `status:queued`/);
  assert.match(roadmap, /Do not merge the pull\s+request/);
});

test("documents queued work separately from active blockers", async () => {
  const [workflow, storyTemplate] = await Promise.all([
    read("docs/workflow.md"),
    read(".github/ISSUE_TEMPLATE/story.yml"),
  ]);

  assert.match(
    workflow,
    /`queued`: valid scoped work waiting in roadmap order/,
  );
  assert.match(
    workflow,
    /Do not use `blocked` merely because a later milestone/,
  );
  assert.match(storyTemplate, /Depends on:/);
});
