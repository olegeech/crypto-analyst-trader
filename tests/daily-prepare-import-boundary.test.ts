import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import ts from "typescript";

function graph(
  root: string,
  read = (path: string) => readFileSync(path, "utf8"),
) {
  const visited = new Set<string>();
  const pending = [resolve(root)];
  while (pending.length) {
    const path = pending.pop()!;
    if (visited.has(path)) continue;
    visited.add(path);
    assert.doesNotMatch(
      path,
      /\/(?:tests|scripts)\/|\/cli\/trader-demo\.ts$|\/adapters\/bybit-v5\/(?:transport|execution-adapter|probe)\.ts$/u,
    );
    const source = ts.createSourceFile(
      path,
      read(path),
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
        assert.ok(
          node.arguments[0] && ts.isStringLiteral(node.arguments[0]),
          "no caller-selected module imports",
        );
        specifiers.push(node.arguments[0].text);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    for (const specifier of specifiers)
      if (specifier.startsWith("."))
        pending.push(
          resolve(dirname(path), specifier.replace(/\.js$/u, ".ts")),
        );
  }
  return visited;
}

test("released composition cannot reach signed write transport, smoke or fixture modules", () => {
  const visited = graph("src/cli/daily.ts");
  assert.ok(
    visited.has(resolve("src/adapters/bybit-v5/account-read-transport.ts")),
  );
  assert.ok(
    visited.has(resolve("src/adapters/sqlite/prepared-artifact-store.ts")),
  );
});
test("import gate rejects direct, re-exported and dynamic authority", () => {
  for (const statement of [
    'import "../adapters/bybit-v5/execution-adapter.js";',
    'export * from "../scripts/smoke.js";',
    "const x = import(moduleFromOperator);",
  ]) {
    assert.throws(() =>
      graph("src/application/daily-prepare.ts", () => statement),
    );
  }
});
