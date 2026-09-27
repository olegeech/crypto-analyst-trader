import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("documents issue delivery in repository guidance", async () => {
  const [readme, agents, workflow] = await Promise.all([
    readFile("README.md", "utf8"),
    readFile("AGENTS.md", "utf8"),
    readFile("docs/workflow.md", "utf8"),
  ]);

  assert.match(readme, /\$issue-delivery/);
  assert.match(agents, /\$issue-delivery/);
  assert.match(workflow, /named issue delivery/i);
});
