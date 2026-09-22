import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const publicModules = [
  "src/adapters/bybit-v5/public-response.ts",
  "src/adapters/bybit-v5/public-transport.ts",
  "src/adapters/bybit-v5/public-market-mappers.ts",
  "src/adapters/bybit-v5/public-market-pagination.ts",
  "src/adapters/bybit-v5/public-market-client.ts",
  "src/ports/market-evidence.ts",
];

test("public market boundary does not import credentials, Demo execution or persistence", async () => {
  for (const relativePath of publicModules) {
    const source = await readFile(relativePath, "utf8");
    assert.doesNotMatch(
      source,
      /credential-provider|macos-keychain|sqlite|exchange-execution/iu,
      relativePath,
    );
    assert.doesNotMatch(
      source,
      /BybitDemo|createHmac|X-BAPI-(?:API-KEY|SIGN)/u,
      relativePath,
    );
    if (relativePath.includes("public-transport")) {
      assert.doesNotMatch(source, /\bPOST\b/u, relativePath);
    }
  }
});
