import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the future authenticated probe has a typed vault seam and no dotenv fallback", async () => {
  const providerSource = await readFile(
    "src/ports/credential-provider.ts",
    "utf8",
  );
  const adapterSource = await readFile(
    "src/adapters/macos-keychain.ts",
    "utf8",
  );
  const packageSource = await readFile("package.json", "utf8");

  assert.match(providerSource, /export interface CredentialProvider/);
  assert.match(providerSource, /load\(environment: CredentialEnvironment/);
  assert.match(adapterSource, /export function createMacOSKeychainProvider/);
  assert.doesNotMatch(adapterSource, /process\.env/);
  assert.doesNotMatch(
    packageSource,
    /credentials:.*dotenv|dotenv.*credentials/i,
  );
});
