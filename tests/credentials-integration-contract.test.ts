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
  const ciWorkflow = await readFile(".github/workflows/ci.yml", "utf8");

  assert.match(providerSource, /export interface CredentialProvider/);
  assert.match(providerSource, /load\(environment: CredentialEnvironment/);
  assert.match(adapterSource, /export function createMacOSKeychainProvider/);
  assert.doesNotMatch(adapterSource, /process\.env/);
  assert.doesNotMatch(
    packageSource,
    /credentials:.*dotenv|dotenv.*credentials/i,
  );
  assert.match(packageSource, /credentials:connect:testnet/);
  assert.match(packageSource, /credentials:connect:mainnet/);
  assert.match(packageSource, /credentials:setup:demo/);
  assert.match(packageSource, /credentials:remove:demo/);
  assert.doesNotMatch(ciWorkflow, /credentials:connect/);
});

test("provider secrets have a separate read-only Keychain boundary", async () => {
  const secretPort = await readFile("src/ports/secret-provider.ts", "utf8");
  const secretAdapter = await readFile(
    "src/adapters/macos-keychain-secret-provider.ts",
    "utf8",
  );
  const commandHelper = await readFile(
    "src/adapters/macos-keychain-command.ts",
    "utf8",
  );

  assert.match(secretPort, /export interface SecretProvider/);
  assert.match(secretPort, /read\(identity: SecretIdentity\)/);
  assert.match(secretPort, /kind: "unavailable"/);
  assert.doesNotMatch(
    secretPort,
    /CredentialEnvironment|ExchangeCredentials|save\(|remove\(|accountId|bybit/iu,
  );
  assert.match(
    secretAdapter,
    /export function createMacOSKeychainSecretProvider/,
  );
  assert.match(secretAdapter, /find-generic-password/);
  assert.doesNotMatch(
    secretAdapter,
    /credential-provider|bybit-v5|exchange-execution|add-generic-password|delete-generic-password/iu,
  );
  assert.doesNotMatch(
    commandHelper,
    /CredentialEnvironment|ExchangeCredentials|bybit/iu,
  );
});

test("the credential guide presents Agent Connect as the only preferred onboarding path", async () => {
  const guide = await readFile("docs/credentials.md", "utf8");
  const agentConnectHeading = "## Bybit Agent Connect (preferred)";
  const manualSetupHeading = "## Manual API credential fallback";
  const keychainFallbackHeading = "## Manual Keychain Access fallback";

  assert.match(guide, /^## Bybit Agent Connect \(preferred\)$/m);
  assert.match(guide, /npm run credentials:connect:testnet/);
  assert.match(guide, /npm run credentials:connect:mainnet/);
  assert.match(guide, /^## Manual API credential fallback$/m);
  assert.match(guide, /npm run credentials:setup:testnet/);
  assert.match(guide, /npm run credentials:setup:demo/);
  assert.match(guide, /npm run credentials:setup:mainnet/);
  assert.match(guide, /com\.crypto-analyst-trader\.bybit\.demo/);
  assert.match(guide, /Agent Connect flow/);
  assert.match(guide, /^## Manual Keychain Access fallback$/m);
  assert.doesNotMatch(guide, /^## .*recommended.*$/gim);
  assert.ok(
    guide.indexOf(agentConnectHeading) < guide.indexOf(manualSetupHeading),
  );
  assert.ok(
    guide.indexOf(manualSetupHeading) < guide.indexOf(keychainFallbackHeading),
  );
});
