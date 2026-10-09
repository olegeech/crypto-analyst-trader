import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

const repositoryRoot = resolve(process.cwd());
const testRoot = resolve(repositoryRoot, "tests");
const authorizationPort = resolve(
  repositoryRoot,
  "src/ports/prepared-leg-write-authorization.ts",
);
const mainnetWriters = [
  resolve(repositoryRoot, "src/application/mainnet-prepared-leg-boundary.ts"),
  resolve(repositoryRoot, "src/application/mainnet-prepared-leg-cancel.ts"),
];

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (/\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/u.test(entry.name))
      files.push(path);
  }
  return files;
}

function imports(source: string, file: string): string[] {
  const parsed = ts.createSourceFile(
    file,
    source,
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
      if (!argument || !ts.isStringLiteral(argument)) {
        assert.equal(
          file,
          resolve(repositoryRoot, "scripts/smoke-bybit-portfolio-risk.ts"),
          `${file}: nonliteral module dependency is not auditable`,
        );
        return;
      }
      specifiers.push(argument.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return specifiers;
}

async function resolveLocalImport(
  file: string,
  specifier: string,
): Promise<string | undefined> {
  if (!specifier.startsWith(".")) return undefined;
  const requested = resolve(dirname(file), specifier);
  const stem = requested.replace(/\.(?:js|mjs|cjs)$/u, "");
  const candidates = [
    `${stem}.ts`,
    `${stem}.tsx`,
    `${stem}.mts`,
    `${stem}.cts`,
    `${stem}.js`,
    `${stem}.mjs`,
    `${stem}.cjs`,
    requested,
  ];
  for (const candidate of new Set(candidates)) {
    if (!/\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/u.test(candidate)) continue;
    try {
      await readFile(candidate, "utf8");
      return candidate;
    } catch {
      // Try the next source extension.
    }
  }
  return undefined;
}

async function operatorEntrypoints(): Promise<string[]> {
  const packageJson = JSON.parse(
    await readFile(resolve(repositoryRoot, "package.json"), "utf8"),
  ) as { private?: boolean; scripts?: Record<string, string> };
  assert.equal(
    packageJson.private,
    true,
    "the repository package stays private",
  );
  const roots: string[] = [];
  for (const [name, command] of Object.entries(packageJson.scripts ?? {})) {
    if (name === "test" || name === "test:release") continue;
    for (const match of command.matchAll(
      /(?:^|\s)node(?:\s+--import\s+tsx)?\s+((?:src|scripts)\/[^\s;&]+)/gu,
    )) {
      const entrypoint = match[1];
      assert.ok(entrypoint, `${name}: command entrypoint is present`);
      roots.push(resolve(repositoryRoot, entrypoint));
    }
  }
  assert.ok(roots.includes(resolve(repositoryRoot, "src/cli/daily.ts")));
  assert.ok(
    roots.includes(resolve(repositoryRoot, "src/cli/mainnet-preflight.ts")),
  );
  return [...new Set(roots)];
}

test("operator package entry points cannot reach #21 Mainnet writers or test authority", async () => {
  const roots = await operatorEntrypoints();
  const pending = [...roots];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || visited.has(file)) continue;
    assert.equal(
      file.startsWith(`${testRoot}/`),
      false,
      `${file}: operator graph must not import test authority or fixtures`,
    );
    assert.equal(
      mainnetWriters.includes(file),
      false,
      `${file}: #21 Mainnet writer is not released through an operator entry point`,
    );
    visited.add(file);
    const source = await readFile(file, "utf8");
    for (const specifier of imports(source, file)) {
      const target = await resolveLocalImport(file, specifier);
      if (target) pending.push(target);
    }
  }

  const productionFiles = await sourceFiles(resolve(repositoryRoot, "src"));
  const authorizationPortImporters: string[] = [];
  for (const file of productionFiles) {
    const source = await readFile(file, "utf8");
    for (const specifier of imports(source, file)) {
      const target = await resolveLocalImport(file, specifier);
      if (!target) continue;
      assert.equal(
        target.startsWith(`${testRoot}/`),
        false,
        `${file}: production source must not import test-only modules`,
      );
      if (target === authorizationPort) authorizationPortImporters.push(file);
    }
  }
  assert.deepEqual(
    authorizationPortImporters.sort(),
    [
      resolve(
        repositoryRoot,
        "src/application/mainnet-prepared-leg-boundary.ts",
      ),
      resolve(repositoryRoot, "src/application/mainnet-prepared-leg-cancel.ts"),
    ].sort(),
    "only the injected #21 boundaries may depend on the write-authorization port",
  );
});
