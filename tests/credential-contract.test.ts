import assert from "node:assert/strict";
import test from "node:test";

import {
  credentialPreflightServiceName,
  credentialServiceName,
  type CredentialEnvironment,
  type ExchangeCredentials,
} from "../src/ports/credential-provider.js";

test("credential environments have deterministic, distinct Keychain services", () => {
  assert.notEqual(
    credentialServiceName("testnet"),
    credentialServiceName("mainnet"),
  );
  assert.equal(
    credentialServiceName("testnet"),
    "com.crypto-analyst-trader.bybit.testnet",
  );
  assert.equal(
    credentialServiceName("mainnet"),
    "com.crypto-analyst-trader.bybit.mainnet",
  );
});

test("preflight uses an isolated service instead of a fourth credential field", () => {
  assert.notEqual(
    credentialPreflightServiceName("testnet"),
    credentialServiceName("testnet"),
  );
  assert.match(credentialPreflightServiceName("mainnet"), /\.preflight$/);
});

test("credential contract is explicit about all values needed by authenticated Bybit calls", () => {
  const environment: CredentialEnvironment = "testnet";
  const credentials: ExchangeCredentials = {
    apiKey: "test-key",
    apiSecret: "test-secret",
    accountId: "test-account",
  };

  assert.equal(environment, "testnet");
  assert.deepEqual(Object.keys(credentials).sort(), [
    "accountId",
    "apiKey",
    "apiSecret",
  ]);
});
