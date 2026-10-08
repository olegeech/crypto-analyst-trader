import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

const forbidden =
  /\/bybit-v5\/(?:transport|client|execution-adapter|order-mappers|reconciliation)\.ts$|\/application\/(?:demo-entry-use-case|daily-prepare-composition)\.ts$|\/adapters\/sqlite\/|\/persistence\//u;

async function collectImportGraph(roots: readonly string[]) {
  const pending = roots.map((file) => resolve(file));
  const visited = new Set<string>();
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    assert.doesNotMatch(file, forbidden, `${file} reaches write authority`);
    visited.add(file);
    const source = ts.createSourceFile(
      file,
      await readFile(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const imports: string[] = [];
    function visit(node: ts.Node): void {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        imports.push(node.moduleSpecifier.text);
      if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteral(node.argument.literal)
      )
        imports.push(node.argument.literal.text);
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === "require"))
      ) {
        const argument = node.arguments[0];
        assert.ok(
          argument && ts.isStringLiteral(argument),
          "dynamic import must be literal",
        );
        imports.push(argument.text);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    for (const specifier of imports) {
      assert.doesNotMatch(
        specifier,
        /execution-adapter|order-mappers|reconciliation|sqlite|persistence/u,
      );
      if (!specifier.startsWith(".")) continue;
      pending.push(resolve(dirname(file), specifier.replace(/\.js$/u, ".ts")));
    }
  }
  return visited;
}

test("Mainnet preflight production graph excludes exchange mutation and persistence", async () => {
  const files = await collectImportGraph([
    "src/cli/mainnet-preflight.ts",
    "src/application/mainnet-preflight-composition.ts",
  ]);
  assert.ok(
    files.has(resolve("src/application/mainnet-preflight-composition.ts")),
  );
  assert.ok(
    files.has(resolve("src/adapters/bybit-v5/account-read-transport.ts")),
  );
  assert.ok(
    files.has(resolve("src/adapters/bybit-v5/read-capability-facade.ts")),
  );
});
