import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

const repositoryRoot = resolve(process.cwd());
const statusComposition = resolve(
  repositoryRoot,
  "src/application/mainnet-operator-test-status-composition.ts",
);

const forbiddenModules = new Set([
  resolve(repositoryRoot, "src/ports/operator-mainnet-test-authorization.ts"),
  resolve(
    repositoryRoot,
    "src/application/mainnet-operator-test-composition.ts",
  ),
  resolve(repositoryRoot, "src/application/mainnet-operator-test.ts"),
  resolve(repositoryRoot, "src/application/mainnet-prepared-leg-boundary.ts"),
  resolve(repositoryRoot, "src/application/mainnet-prepared-leg-cancel.ts"),
  resolve(repositoryRoot, "src/application/mainnet-prepared-grid-boundary.ts"),
  resolve(repositoryRoot, "src/adapters/bybit-v5/execution-adapter.ts"),
]);

async function resolveLocalImport(
  file: string,
  specifier: string,
): Promise<string | undefined> {
  if (!specifier.startsWith(".")) return undefined;
  const requested = resolve(dirname(file), specifier);
  const stem = requested.replace(/\.(?:js|mjs|cjs)$/u, "");
  for (const candidate of [
    `${stem}.ts`,
    `${stem}.tsx`,
    `${stem}.mts`,
    `${stem}.cts`,
    `${stem}.js`,
    `${stem}.mjs`,
    `${stem}.cjs`,
    requested,
  ]) {
    if (!/\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/u.test(candidate)) continue;
    try {
      await readFile(candidate, "utf8");
      return candidate;
    } catch {
      // Continue through the repository's supported source extensions.
    }
  }
  return undefined;
}

function inspectStatusModule(source: string, file: string): string[] {
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const violations: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const method = ts.isPropertyAccessExpression(expression)
        ? expression.name.text
        : ts.isElementAccessExpression(expression) &&
            expression.argumentExpression &&
            ts.isStringLiteral(expression.argumentExpression)
          ? expression.argumentExpression.text
          : undefined;
      if (
        method &&
        [
          "post",
          "createOrder",
          "cancelOrder",
          "closePosition",
          "setLeverage",
        ].includes(method)
      )
        violations.push(`${file}: call to forbidden mutator ${method}`);
      if (
        expression.kind === ts.SyntaxKind.ImportKeyword &&
        (!node.arguments[0] || !ts.isStringLiteral(node.arguments[0]))
      )
        violations.push(`${file}: nonliteral dynamic import is not auditable`);
      if (
        ts.isIdentifier(expression) &&
        expression.text === "require" &&
        (!node.arguments[0] || !ts.isStringLiteral(node.arguments[0]))
      )
        violations.push(`${file}: nonliteral require is not auditable`);
    }
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "method" &&
      ts.isStringLiteral(node.initializer) &&
      node.initializer.text.toUpperCase() !== "GET"
    )
      violations.push(`${file}: non-GET fetch method in status dependency`);
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return violations;
}

test("#31 status/reconciliation graph is GET-only and cannot reach an issuer or writer", async () => {
  const pending = [statusComposition];
  const visited = new Set<string>();
  const violations: string[] = [];
  while (pending.length > 0) {
    const file = pending.pop();
    if (!file || visited.has(file)) continue;
    visited.add(file);
    assert.equal(
      forbiddenModules.has(file),
      false,
      `${file}: status graph must not import write authorization or execution composition`,
    );
    const source = await readFile(file, "utf8");
    violations.push(...inspectStatusModule(source, file));
    const parsed = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
    );
    const specifiers: string[] = [];
    function collect(node: ts.Node): void {
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
            node.expression.text === "require")) &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0])
      )
        specifiers.push(node.arguments[0].text);
      ts.forEachChild(node, collect);
    }
    collect(parsed);
    for (const specifier of specifiers) {
      const target = await resolveLocalImport(file, specifier);
      if (target) pending.push(target);
    }
  }
  assert.deepEqual(violations, []);
  assert.ok(
    visited.has(
      resolve(
        repositoryRoot,
        "src/application/mainnet-operator-test-status.ts",
      ),
    ),
  );
  assert.ok(
    visited.has(
      resolve(
        repositoryRoot,
        "src/adapters/bybit-v5/account-read-transport.ts",
      ),
    ),
  );
});
