import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

const forbiddenFiles =
  /\/(?:adapters\/sqlite|persistence|scripts\/bybit-probe|cli\/trader-demo|domain\/execution|domain\/identity\/canonical-artifact)\/|\/adapters\/(?:macos-keychain|bybit-v5\/(?:transport|execution-adapter|probe|order-mappers|reconciliation))\.ts$|\/(?:sqlite|execution-journal)\.ts$/u;
const forbiddenSpecifiers =
  /sqlite|execution-adapter|trader-demo|bybit-probe|\/v5\/(?:order\/(?:create|cancel|amend)|position\/set-leverage|asset\/transfer)/u;

async function importGraph(
  roots: readonly string[],
  read = (file: string) => readFile(file, "utf8"),
) {
  const pending = roots.map((file) => resolve(file));
  const visited = new Set<string>();
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    assert.doesNotMatch(
      file,
      forbiddenFiles,
      `${file}: risk preflight import graph reached forbidden authority`,
    );
    visited.add(file);
    const sourceText = await read(file);
    const source = ts.createSourceFile(
      file,
      sourceText,
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
        forbiddenSpecifiers,
        `${file}: ${specifier} reaches write or persistence authority`,
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

test("pure risk evaluation is domain-only and cannot reach I/O", async () => {
  const visited = await importGraph([
    "src/domain/risk/portfolio-risk-preflight.ts",
  ]);
  assert.ok(visited.size > 1);
});

test("application and Bybit supplemental reader stay outside write, approval and persistence graphs", async () => {
  const visited = await importGraph([
    "src/application/portfolio-risk-preflight.ts",
    "src/adapters/bybit-v5/risk-evidence-reader.ts",
  ]);
  assert.ok(
    visited.has(resolve("src/adapters/bybit-v5/account-read-transport.ts")),
  );
  assert.ok(![...visited].some((file) => file.includes("macos-keychain")));
});

test("boundary detects write imports, dynamic imports and hidden transitive authority", async () => {
  for (const declaration of [
    'export * from "../domain/execution/executor.js";',
    'import type { X } from "../adapters/bybit-v5/execution-adapter.js";',
    'type X = import("../persistence/sqlite.js").X;',
    'const x = import("../scripts/bybit-probe.js");',
    "const x = import(target);",
  ]) {
    await assert.rejects(
      importGraph(
        ["src/application/portfolio-risk-preflight.ts"],
        async () => declaration,
      ),
    );
  }
  await assert.rejects(
    importGraph(
      ["src/application/portfolio-risk-preflight.ts"],
      async (file) =>
        file.endsWith("portfolio-risk-preflight.ts")
          ? 'export * from "./neutral.js";'
          : 'export * from "../domain/execution/executor.js";',
    ),
  );
});
