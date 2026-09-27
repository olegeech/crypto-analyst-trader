import assert from "node:assert/strict";
import test from "node:test";

import type {
  SecretIdentity,
  SecretProvider,
  SecretReadResult,
} from "../src/ports/secret-provider.js";

test("the provider-neutral secret port reads by identity and exposes no mutation methods", async () => {
  const requested: SecretIdentity[] = [];
  const provider: SecretProvider = {
    async read(identity) {
      requested.push(identity);
      return Object.freeze({ kind: "available", secret: "sentinel-api-key" });
    },
  };

  const result: SecretReadResult = await provider.read({
    provider: "coinalyze",
    credential: "api-key",
  });

  assert.deepEqual(requested, [
    { provider: "coinalyze", credential: "api-key" },
  ]);
  assert.deepEqual(result, { kind: "available", secret: "sentinel-api-key" });
  assert.deepEqual(Object.keys(provider).sort(), ["read"]);
});

test("unavailable secrets use a typed reason without exposing command details", async () => {
  const privateCommandDetail = "sentinel-api-key in private stderr";
  const provider: SecretProvider = {
    async read() {
      return Object.freeze({ kind: "unavailable", reason: "inaccessible" });
    },
  };

  const result = await provider.read({
    provider: "coinalyze",
    credential: "api-key",
  });

  assert.deepEqual(result, { kind: "unavailable", reason: "inaccessible" });
  assert.equal(JSON.stringify(result).includes(privateCommandDetail), false);
});
