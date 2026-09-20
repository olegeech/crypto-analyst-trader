import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

test("SQLite adapters have no exchange transport or credential dependency", async () => {
  const root = resolve(process.cwd(), "src/adapters/sqlite");
  const files = await sourceFiles(root);
  for (const file of files) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(
      source,
      /bybit|credential-provider|macos-keychain|agent-connect/iu,
      file,
    );
    assert.doesNotMatch(source, /\bfetch\s*\(|https?:\/\//iu, file);
  }
});

test("the public persistence port exposes no SQLite handle or transport shape", async () => {
  const [port, domain] = await Promise.all([
    readFile(resolve(process.cwd(), "src/ports/persistence.ts"), "utf8"),
    readFile(resolve(process.cwd(), "src/domain/index.ts"), "utf8"),
  ]);
  assert.doesNotMatch(
    port,
    /DatabaseSync|from .*sqlite|from .*bybit|credential-provider/iu,
  );
  assert.doesNotMatch(
    domain,
    /DatabaseSync|sqlite|bybit|credential|signedrequest/iu,
  );
});
