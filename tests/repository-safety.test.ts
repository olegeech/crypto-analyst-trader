import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const guardPath = join(process.cwd(), "scripts/check-repository-safety.mjs");

async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "repository-safety-"));
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  for (const [path, content] of Object.entries(files)) {
    const fullPath = join(root, path);
    await mkdir(join(fullPath, ".."), { recursive: true });
    await writeFile(fullPath, content);
  }
  await execFileAsync("git", ["add", "--all"], { cwd: root });
  return root;
}

async function runGuard(root: string) {
  try {
    await execFileAsync(process.execPath, [guardPath], { cwd: root });
    return { failed: false, output: "" };
  } catch (error) {
    const result = error as { stdout?: string; stderr?: string };
    return {
      failed: true,
      output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    };
  }
}

test("placeholder environment configuration passes", async () => {
  const exampleKey = ["BYBIT_API_KEY", ""].join("=");
  const exampleSecret = ["BYBIT_API_SECRET", ""].join("=");
  const root = await fixture({
    ".env.example": `${exampleKey}\n${exampleSecret}\n`,
  });
  try {
    assert.deepEqual(await runGuard(root), { failed: false, output: "" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tracked local environment file fails without revealing values", async () => {
  const secret = "synthetic-secret-value";
  const root = await fixture({ ".env": `BYBIT_API_KEY=${secret}\n` });
  try {
    const result = await runGuard(root);
    assert.equal(result.failed, true);
    assert.match(result.output, /\.env/);
    assert.doesNotMatch(result.output, new RegExp(secret));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tracked credential directory files fail without revealing values", async () => {
  const root = await fixture({ "credentials/testnet.json": "{}\n" });
  try {
    const result = await runGuard(root);
    assert.equal(result.failed, true);
    assert.match(result.output, /credentials\/testnet\.json/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tracked Bybit credential fields fail in otherwise ordinary files", async () => {
  const key = "synthetic-bybit-key";
  const root = await fixture({
    "config.json": `{ "BYBIT_API_KEY": "${key}" }`,
  });
  try {
    const result = await runGuard(root);
    assert.equal(result.failed, true);
    assert.match(result.output, /non-placeholder Bybit credential field/);
    assert.doesNotMatch(result.output, new RegExp(key));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generic API examples do not trigger heuristic scanning", async () => {
  const root = await fixture({
    "docs/example.txt": "apiKey=example\nsecret=placeholder\n",
  });
  try {
    assert.deepEqual(await runGuard(root), { failed: false, output: "" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ignored local credential files are not scanned when untracked", async () => {
  const root = await fixture({ ".gitignore": ".env\n", "README.md": "safe\n" });
  try {
    await writeFile(
      join(root, ".env"),
      ["BYBIT_API_KEY", "synthetic"].join("=") + "\n",
    );
    assert.deepEqual(await runGuard(root), { failed: false, output: "" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the example file remains placeholder-only", async () => {
  const example = await readFile(".env.example", "utf8");
  assert.match(example, new RegExp(["BYBIT_API_KEY", "\\s*$"].join("="), "m"));
  assert.match(
    example,
    new RegExp(["BYBIT_API_SECRET", "\\s*$"].join("="), "m"),
  );
});
