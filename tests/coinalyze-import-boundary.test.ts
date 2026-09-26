import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import test from "node:test";

const entrypoints = [
  "src/adapters/coinalyze/coinalyze-client.ts",
  "src/application/liquidation-evidence-collection.ts",
  "scripts/coinalyze-liquidation-smoke.ts",
];
const importSpecifier = /\b(?:from|import)\s*["']([^"']+)["']/gu;
const forbiddenPath =
  /(?:\/ports\/credential-provider\.ts|\/adapters\/macos-keychain\.ts|\/adapters\/bybit-v5\/(?:private|exchange|execution)|\/adapters\/sqlite\/|\/application\/(?:execution|order|position)|\/domain\/(?:order|position)\/)/iu;

async function resolveImport(
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
  throw new Error(
    `Coinalyze boundary import could not be resolved: ${specifier}`,
  );
}

async function importGraph(): Promise<readonly string[]> {
  const visited = new Set<string>();
  const pending = entrypoints.map((entrypoint) => resolve(entrypoint));
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || visited.has(current)) continue;
    visited.add(current);
    const source = await readFile(current, "utf8");
    for (const match of source.matchAll(importSpecifier)) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      const imported = await resolveImport(current, specifier);
      if (imported !== undefined && !visited.has(imported))
        pending.push(imported);
    }
  }
  return [...visited];
}

test("Coinalyze collection and smoke graph excludes account and persistence authority", async () => {
  const graph = await importGraph();
  for (const path of graph) {
    const source = await readFile(path, "utf8");
    assert.doesNotMatch(path, forbiddenPath, path);
    assert.doesNotMatch(
      source,
      /createHmac|X-BAPI-(?:API-KEY|SIGN)|placeOrder|cancelOrder|setLeverage|transferAsset/iu,
      path,
    );
  }

  const keychainSecretAdapter = graph.find((path) =>
    path.endsWith("/macos-keychain-secret-provider.ts"),
  );
  assert.ok(
    keychainSecretAdapter,
    "provider-neutral read-only Keychain adapter must be in the explicit smoke graph",
  );
  assert.equal(
    graph.some((path) => path.endsWith("/macos-keychain.ts")),
    false,
    "exchange-coupled credential adapter must not be imported",
  );
  assert.equal(
    graph.some((path) => /\/adapters\/sqlite\//u.test(path)),
    false,
    "liquidation evidence path must not persist to SQLite",
  );
});

test("public Coinalyze transport remains GET-only and API keys never enter the URL", async () => {
  const transportPath = resolve(
    "src/adapters/coinalyze/coinalyze-transport.ts",
  );
  const source = await readFile(transportPath, "utf8");
  assert.match(source, /method:\s*["']GET["']/u);
  assert.doesNotMatch(source, /method:\s*["'](?:POST|PUT|PATCH|DELETE)["']/iu);
  assert.match(source, /headers:\s*\{[^}]*api_key:\s*apiKey/su);
  assert.doesNotMatch(source, /[?&]api_key=|searchParams\.set\(["']api_key/u);
});
