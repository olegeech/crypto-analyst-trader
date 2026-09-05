import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const wrapperPath = "scripts/merge-pr.sh";

test("merge wrapper has valid shell syntax and fail-closed merge guards", async () => {
  const wrapper = await readFile(wrapperPath, "utf8");

  await execFileAsync("bash", ["-n", wrapperPath]);
  assert.match(wrapper, /git status --porcelain --untracked-files=no/);
  assert.match(wrapper, /if \[\[ "\$HEAD_SHA" != "\$REVIEWED_SHA" \]\]/);
  assert.match(wrapper, /--match-head-commit "\$REVIEWED_SHA"/);
  assert.match(wrapper, /gh pr merge "\$PR" --squash/);
  assert.match(wrapper, /git pull --ff-only origin main/);

  await assert.rejects(
    execFileAsync("bash", [wrapperPath, "50", "not-a-sha"]),
    (error) => {
      const result = error as {
        code?: number;
        stderr?: string;
      };
      assert.equal(result.code, 2);
      assert.match(
        result.stderr ?? "",
        /reviewed head SHA must contain exactly 40 hexadecimal characters/,
      );
      return true;
    },
  );
});
