import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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

test("domain imports stay isolated from adapters, persistence and probe helpers", async () => {
  const domainRoot = resolve(process.cwd(), "src/domain");
  const files = await sourceFiles(domainRoot);
  const importSpecifier =
    /(?:from\s+|import\s*\(?\s*|require\s*\(\s*)["']([^"']+)["']/gu;
  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(importSpecifier)) {
      const specifier = match[1];
      if (specifier === "node:crypto" || specifier === "big.js") continue;
      assert.ok(specifier?.startsWith("."), `${file}: ${specifier}`);
      const target = resolve(
        dirname(file),
        (specifier ?? "").replace(/\.js$/u, ".ts"),
      );
      assert.ok(
        target === domainRoot || target.startsWith(`${domainRoot}/`),
        `${file}: ${specifier}`,
      );
    }
  }
});

test("analytics and quality dependency graphs stay domain-local and upstream-only", async () => {
  const domainRoot = resolve(process.cwd(), "src/domain");
  const analyticsFiles = [
    ...(await sourceFiles(join(domainRoot, "analytics"))),
    ...(await sourceFiles(join(domainRoot, "quality"))),
  ];
  const importSpecifier =
    /(?:from\s+|import\s*\(?\s*|require\s*\(\s*)["']([^"']+)["']/gu;
  const visited = new Set<string>();
  const pending = [...analyticsFiles];
  const downstreamDomainPath =
    /\/domain\/(?:planning|risk|execution|accounting|application|adapters|persistence|cli)\//u;

  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || visited.has(file)) continue;
    visited.add(file);
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(importSpecifier)) {
      const specifier = match[1];
      if (specifier === "node:crypto" || specifier === "big.js") continue;
      assert.ok(specifier?.startsWith("."), `${file}: ${specifier}`);
      const target = resolve(
        dirname(file),
        (specifier ?? "").replace(/\.js$/u, ".ts"),
      );
      assert.ok(
        target === domainRoot || target.startsWith(`${domainRoot}/`),
        `${file}: ${specifier} escapes src/domain`,
      );
      assert.equal(
        downstreamDomainPath.test(target),
        false,
        `${file}: ${specifier} reaches a downstream authority layer`,
      );
      assert.equal(
        target.endsWith("/identity/canonical-artifact.ts"),
        false,
        `${file}: ${specifier} reaches the downstream artifact registry`,
      );
      if (target.endsWith(".ts")) pending.push(target);
    }
  }
});
