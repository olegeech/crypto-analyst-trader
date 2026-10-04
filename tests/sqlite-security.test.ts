import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
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

function assertNoTransportDependency(sourceText: string, file: string) {
  const source = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  );
  const forbidden = /bybit|credential-provider|macos-keychain|agent-connect/iu;
  function visit(node: ts.Node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      assert.doesNotMatch(node.moduleSpecifier.text, forbidden, file);
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    )
      assert.doesNotMatch(node.argument.literal.text, forbidden, file);
    if (ts.isCallExpression(node)) {
      assert.ok(
        !(
          (ts.isIdentifier(node.expression) &&
            node.expression.text === "fetch") ||
          (ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === "fetch")
        ),
        `${file}: network call`,
      );
      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")
      ) {
        const argument = node.arguments[0];
        assert.ok(
          argument && ts.isStringLiteral(argument),
          `${file}: nonliteral dependency`,
        );
        assert.doesNotMatch(argument.text, forbidden, file);
      }
    }
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    )
      assert.doesNotMatch(node.text, /https?:\/\//iu, file);
    ts.forEachChild(node, visit);
  }
  visit(source);
}

test("SQLite adapters have no exchange transport or credential dependency", async () => {
  const root = resolve(process.cwd(), "src/adapters/sqlite");
  const files = await sourceFiles(root);
  for (const file of files) {
    const source = await readFile(file, "utf8");
    assertNoTransportDependency(source, file);
  }
});

test("SQLite dependency guard checks executable imports, not exchange labels or comments", () => {
  assertNoTransportDependency(
    '// No macos-keychain access\nconst scope = { exchange: "bybit" };',
    "fixture.ts",
  );
  for (const code of [
    'import "../bybit-v5/transport.js";',
    'export * from "../macos-keychain.js";',
    'type X = import("../ports/credential-provider.js");',
    "const x = import(path);",
    "fetch(url);",
    "globalThis.fetch(url);",
    "transport.fetch(url);",
    'const url = "https://example.com";',
    "const url = `http://example.com`;",
    "const url = `https://example.com/${path}`;",
    "const url = `${prefix}http://example.com/${path}`;",
    "const url = `${prefix}https://example.com`;",
  ])
    assert.throws(() => assertNoTransportDependency(code, "fixture.ts"));
});

test("the public persistence port exposes no SQLite handle or transport shape", async () => {
  const [port, domain] = await Promise.all([
    readFile(resolve(process.cwd(), "src/ports/persistence.ts"), "utf8"),
    readFile(resolve(process.cwd(), "src/domain/index.ts"), "utf8"),
  ]);
  assert.doesNotMatch(
    port,
    /DatabaseSync|from .*sqlite|from .*bybit|credential-provider/iu,
  );
  const source = ts.createSourceFile(
    "domain/index.ts",
    domain,
    ts.ScriptTarget.Latest,
    true,
  );
  for (const statement of source.statements) {
    if (
      (ts.isExportDeclaration(statement) ||
        ts.isImportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    )
      assert.doesNotMatch(
        statement.moduleSpecifier.text,
        /sqlite|bybit-v5|credential-provider|macos-keychain|agent-connect/iu,
      );
  }
  assert.doesNotMatch(domain, /\bDatabaseSync\b|\bSignedRequest\b/iu);
});
