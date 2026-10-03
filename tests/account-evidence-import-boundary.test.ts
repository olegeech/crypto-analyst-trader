import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

const forbidden =
  /\/(?:adapters\/sqlite|persistence|scripts\/bybit-probe|domain\/(?:execution|risk))\/|\/bybit-v5\/(?:transport|client|execution-adapter|read-mappers|order-mappers|reconciliation)\.ts$|\/domain\/(?:index|identity\/canonical-artifact)\.ts$/u;

async function checkGraph(
  roots: readonly string[],
  read = (file: string) => readFile(file, "utf8"),
) {
  const pending = roots.map((file) => resolve(file));
  const visited = new Set<string>();
  while (pending.length) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    assert.doesNotMatch(
      file,
      forbidden,
      `${file}: account read graph reaches write authority`,
    );
    visited.add(file);
    const source = ts.createSourceFile(
      file,
      await read(file),
      ts.ScriptTarget.Latest,
      true,
    );
    const imports: string[] = [];
    function visit(node: ts.Node) {
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
          `${file}: nonliteral dependency`,
        );
        imports.push(argument.text);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    for (const specifier of imports) {
      assert.doesNotMatch(
        specifier,
        /sqlite|bybit-probe/u,
        `${file}: ${specifier}`,
      );
      if (!specifier.startsWith(".")) {
        assert.ok(
          ["big.js", "node:crypto"].includes(specifier),
          `${file}: unexpected external dependency ${specifier}`,
        );
        continue;
      }
      pending.push(resolve(dirname(file), specifier.replace(/\.js$/u, ".ts")));
    }
  }
  return visited;
}

test("account client and collector transitively exclude Demo writes, probe helpers and SQLite", async () => {
  const roots = [
    "src/adapters/bybit-v5/account-read-client.ts",
    "src/adapters/bybit-v5/account-read-transport.ts",
    "src/application/account-evidence-collection.ts",
  ];
  const visited = await checkGraph(roots);
  assert.ok(
    visited.has(resolve("src/adapters/bybit-v5/account-read-transport.ts")),
  );
});

test("account boundary detects reexports, type imports, dynamic imports and hidden transitive writes", async () => {
  for (const declaration of [
    'export * from "./transport.js";',
    'import type { X } from "./client.js";',
    'type X = import("./order-mappers.js").X;',
    'const x = import("./read-mappers.js");',
    'const x = require("./execution-adapter.js");',
    "const x = import(target);",
  ]) {
    await assert.rejects(
      checkGraph(
        ["src/adapters/bybit-v5/account-read-client.ts"],
        async () => declaration,
      ),
    );
  }
  await assert.rejects(
    checkGraph(
      ["src/adapters/bybit-v5/account-read-client.ts"],
      async (file) =>
        file.endsWith("account-read-client.ts")
          ? 'export * from "./neutral.js";'
          : 'export * from "./transport.js";',
    ),
  );
});
