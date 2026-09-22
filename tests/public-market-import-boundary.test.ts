import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";

const publicEntrypoints = [
  "src/adapters/bybit-v5/public-market-client.ts",
  "src/adapters/bybit-v5/public-transport.ts",
  "src/application/market-evidence-collection.ts",
  "scripts/public-market-smoke.ts",
];

const localImport = /\b(?:from|import)\s*["']([^"']+)["']/gu;

async function resolveLocalImport(
  importer: string,
  specifier: string,
): Promise<string | undefined> {
  if (!specifier.startsWith(".")) return undefined;
  const base = resolve(dirname(importer), specifier);
  for (const candidate of [base, base.replace(/\.js$/u, ".ts"), `${base}.ts`]) {
    try {
      await readFile(candidate, "utf8");
      return candidate;
    } catch {
      // Try the next TypeScript module candidate.
    }
  }
  throw new Error(`public boundary import could not be resolved: ${specifier}`);
}

async function publicImportGraph(): Promise<readonly string[]> {
  const visited = new Set<string>();
  const pending = publicEntrypoints.map((entrypoint) => resolve(entrypoint));
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || visited.has(current)) continue;
    visited.add(current);
    const source = await readFile(current, "utf8");
    for (const match of source.matchAll(localImport)) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      const imported = await resolveLocalImport(current, specifier);
      if (imported !== undefined && !visited.has(imported))
        pending.push(imported);
    }
  }
  return [...visited];
}

test("public market boundary transitively excludes credentials and writes", async () => {
  for (const relativePath of await publicImportGraph()) {
    const source = await readFile(relativePath, "utf8");
    assert.doesNotMatch(
      source,
      /credential-provider|macos-keychain|sqlite|exchange-execution/iu,
      relativePath,
    );
    assert.doesNotMatch(
      source,
      /BybitDemo|createHmac|X-BAPI-(?:API-KEY|SIGN)/u,
      relativePath,
    );
    if (relativePath.endsWith("public-transport.ts")) {
      assert.doesNotMatch(source, /\bPOST\b/u, relativePath);
    }
  }
});
