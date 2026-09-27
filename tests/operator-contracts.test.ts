import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path: string) => readFile(path, "utf8");

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

test("documents the fixed Demo managed-entry lifecycle and safe stop states", async () => {
  const [readme, runbook] = await Promise.all([
    read("README.md"),
    read("docs/operator-runbook.md"),
  ]);

  assert.match(readme, /npm run trader:demo/);
  assert.match(runbook, /npm run trader:demo/);
  assert.match(
    runbook,
    /exactly one of `--take-profit-percent` or `--take-profit-price`/i,
  );
  assert.match(runbook, /`Limit \+ GTC`/);
  assert.match(runbook, /one\s+approval prompt/i);
  for (const verdict of [
    "CONFIRMED_OPEN",
    "CONFIRMED_FILLED",
    "NOT_READY",
    "DECLINED",
    "HALTED",
    "UNRESOLVED",
  ]) {
    assert.match(runbook, new RegExp(`\\b${verdict}\\b`));
  }
  assert.match(runbook, /API_KEY_IP_UNBOUND/);
  assert.match(runbook, /does not create a report file by default/i);
  assert.match(runbook, /never blind-retry an ambiguous create/i);
  assert.match(runbook, /schema-v5 journal/i);
  assert.match(runbook, /v5-aware adapter/i);
  assert.match(runbook, /verified pre-migration backup/i);
  assert.match(
    runbook,
    /expected\s+open position is then normal managed state/i,
  );
});

test("keeps execution modes and exact approval fail closed in canonical docs", async () => {
  const [runbook, invariants] = await Promise.all([
    read("docs/operator-runbook.md"),
    read("docs/architecture/invariants.md"),
  ]);

  for (const mode of ["PREPARE_ONLY", "TESTNET_EXECUTE", "MAINNET_EXECUTE"]) {
    assert.match(runbook, new RegExp(`\\b${mode}\\b`));
  }

  assert.match(runbook, /approval of the exact plan hash/i);
  assert.match(invariants, /approved, unexpired exact plan hash/i);
  assert.match(runbook, /Never blind-retry an ambiguous write/i);
  assert.match(runbook, /Set `HALT`/);
});

test("keeps timing policy versioned instead of hard-coding a market session", async () => {
  const runbook = await read("docs/operator-runbook.md");

  assert.match(
    runbook,
    /timing is defined by the active versioned strategy or\s+operating policy/i,
  );
  assert.doesNotMatch(runbook, /09:45\s+America\/New_York/i);
  assert.doesNotMatch(runbook, /United States cash-market holidays/i);
});

test("makes validated evidence identity part of immutable planning", async () => {
  const [runbook, invariants] = await Promise.all([
    read("docs/operator-runbook.md"),
    read("docs/architecture/invariants.md"),
  ]);

  assert.match(runbook, /validated evidence references and hashes/i);
  assert.match(
    runbook,
    /evidence references or hashes[\s\S]{0,160}invalidates the approval/i,
  );
  assert.match(invariants, /Evidence that can affect a live-ready plan/i);
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
