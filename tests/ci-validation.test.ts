import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  documentationOnly,
  localLinkErrors,
} from "../scripts/ci-validation.js";

test("only an entirely known documentation diff selects lightweight validation", () => {
  assert.equal(
    documentationOnly([
      "README.md",
      "AGENTS.md",
      "docs/workflow.md",
      ".github/pull_request_template.md",
    ]),
    true,
  );
  for (const files of [
    null,
    [],
    ["docs/workflow.md", "src/application/order.ts"],
    [".github/workflows/ci.yml"],
    ["scripts/ci-validation.ts"],
    ["package.json"],
    ["package-lock.json"],
    ["tests/ci-contract.test.ts"],
    ["src/prompt.md"],
    [".agents/skills/daily-rebalance/SKILL.md"],
    ["README.md", "src/renamed-from-doc.ts"],
    ["src/renamed-to-doc.ts", "README.md"],
  ])
    assert.equal(documentationOnly(files), false, JSON.stringify(files));
});

test("missing diff data emits the full-release decision without installed dependencies", () => {
  const output = execFileSync(
    process.execPath,
    ["--experimental-strip-types", "scripts/ci-validation.ts", "scope"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        CI_DIFF_BASE: "",
        CI_DIFF_HEAD: "",
        GITHUB_OUTPUT: "",
      },
    },
  );
  assert.match(output, /docs_only=false/u);
});

test("Git diff classification covers docs deletion, renames and full PR changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ci-scope-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  try {
    git("init", "--quiet");
    git("config", "user.email", "fixture@example.invalid");
    git("config", "user.name", "CI fixture");
    await writeFile(join(root, "README.md"), "# Fixture\n");
    git("add", "README.md");
    git("commit", "--quiet", "-m", "base");
    const base = git("rev-parse", "HEAD");
    const classify = () =>
      execFileSync(
        process.execPath,
        [
          "--experimental-strip-types",
          resolve("scripts/ci-validation.ts"),
          "scope",
        ],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            ...process.env,
            CI_DIFF_BASE: base,
            CI_DIFF_HEAD: git("rev-parse", "HEAD"),
            CI_DIFF_EVENT: "pull_request",
            GITHUB_OUTPUT: "",
          },
        },
      );
    await writeFile(join(root, "README.md"), "# Updated fixture\n");
    git("commit", "--quiet", "-am", "docs");
    assert.match(classify(), /docs_only=true/u);
    git("mv", "README.md", "runtime.ts");
    git("commit", "--quiet", "-m", "rename");
    assert.match(classify(), /docs_only=false/u);
    git("mv", "runtime.ts", "README.md");
    git("commit", "--quiet", "-m", "restore docs");
    git("rm", "README.md");
    git("commit", "--quiet", "-m", "delete docs");
    assert.match(classify(), /docs_only=true/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("documentation links report missing files and anchors without external requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "ci-doc-links-"));
  try {
    await writeFile(
      join(root, "target.md"),
      "# Financial boundaries\n\n# Financial boundaries\n",
    );
    const file = join(root, "README.md");
    await writeFile(
      file,
      "[valid](target.md#financial-boundaries)\n[duplicate](target.md#financial-boundaries-1)\n[web](https://example.invalid)\n[route](/issues/31)\n`[example](missing.md)`\n",
    );
    assert.deepEqual(localLinkErrors(file), []);
    await writeFile(
      file,
      "[missing](missing.md)\n[anchor](target.md#absent)\n[reference]: missing-reference.md\n",
    );
    assert.equal(localLinkErrors(file).length, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
