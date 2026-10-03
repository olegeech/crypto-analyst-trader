import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

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

// Include type imports and re-exports: either can conceal a downstream dependency.
async function leafGraph(roots: readonly string[], application = false) {
  const domainRoot = resolve("src/domain");
  const applicationRoot = resolve("src/application");
  const pending = roots.map((path) => resolve(path));
  const visited = new Set<string>();
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || visited.has(file)) continue;
    visited.add(file);
    const source = ts.createSourceFile(
      file,
      await readFile(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const specifiers: string[] = [];
    function visit(node: ts.Node) {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        specifiers.push(node.moduleSpecifier.text);
      if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteral(node.argument.literal)
      )
        specifiers.push(node.argument.literal.text);
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === "require"))
      ) {
        const argument = node.arguments[0];
        assert.ok(
          argument && ts.isStringLiteral(argument),
          `${file}: nonliteral dependency`,
        );
        specifiers.push(argument.text);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    for (const specifier of specifiers) {
      if (specifier === "big.js" || specifier === "node:crypto") continue;
      assert.ok(specifier.startsWith("."), `${file}: ${specifier}`);
      const target = resolve(dirname(file), specifier.replace(/\.js$/u, ".ts"));
      assert.ok(
        target.startsWith(`${domainRoot}/`) ||
          (application && target.startsWith(`${applicationRoot}/`)),
        `${file}: ${specifier} escapes the preparation boundary`,
      );
      assert.doesNotMatch(
        target,
        /\/(?:adapters|persistence|cli|risk|execution)\//u,
      );
      assert.notEqual(target, join(domainRoot, "index.ts"), "no domain barrel");
      assert.notEqual(
        target,
        join(domainRoot, "identity/canonical-artifact.ts"),
        "no artifact registry",
      );
      assert.doesNotMatch(target, /\/(?:execution-plan|plan-proof)\.ts$/u);
      pending.push(target);
    }
  }
  return visited;
}

test("daily compiler leaf graphs cannot reach downstream authority or registry", async () => {
  const visited = await leafGraph([
    "src/domain/planning/daily-planning-inputs.ts",
    "src/domain/planning/daily-decision.ts",
    "src/domain/planning/daily-entry-grid.ts",
    "src/domain/planning/daily-decision-plan.ts",
    "src/domain/planning/daily-planning-result.ts",
  ]);
  assert.ok(
    visited.has(resolve("src/domain/analytics/analytics-evidence-bundle.ts")),
  );
});

test("account evidence leaf graphs cannot reach downstream authority or registry", async () => {
  const visited = await leafGraph([
    "src/domain/account/account-evidence-bundle.ts",
    "src/domain/account/account-evidence-policy.ts",
    "src/domain/account/account-evidence-consistency.ts",
    "src/domain/account/account-evidence-diagnostics.ts",
  ]);
  assert.ok(
    visited.has(resolve("src/domain/identity/canonical-serialization.ts")),
  );
});

test("application daily preparation graph cannot reach private Bybit or SQLite writes", async () => {
  const visited = await leafGraph(
    ["src/application/daily-decision-planning.ts"],
    true,
  );
  assert.ok(visited.has(resolve("src/application/data-quality-assessment.ts")));
  assert.ok(visited.has(resolve("src/domain/planning/daily-decision-plan.ts")));
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
