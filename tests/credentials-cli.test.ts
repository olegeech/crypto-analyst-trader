import assert from "node:assert/strict";
import test from "node:test";

import { CredentialProviderError } from "../src/ports/credential-provider.js";
import { runCredentialsCli } from "../scripts/credentials.js";

const values = ["test-key", "test-secret", "test-account"];

test("setup CLI prompts for the three values and never writes them to output", async () => {
  const output: string[] = [];
  let index = 0;
  const hiddenFlags: boolean[] = [];
  let saved: unknown;
  const code = await runCredentialsCli(["setup", "testnet"], {
    output: { write: (message) => output.push(message) },
    prompt: async (_label, hidden) => {
      hiddenFlags.push(hidden);
      return values[index++] ?? "";
    },
    provider: {
      load: async () => {
        throw new Error("unused");
      },
      save: async (environment, credentials) => {
        saved = { environment, credentials };
      },
      remove: async () => undefined,
    },
  });

  assert.equal(code, 0);
  assert.deepEqual(saved, {
    environment: "testnet",
    credentials: {
      apiKey: values[0],
      apiSecret: values[1],
      accountId: values[2],
    },
  });
  assert.deepEqual(hiddenFlags, [true, true, true]);
  assert.doesNotMatch(output.join(""), /test-key|test-secret|test-account/);
});

test("setup CLI reports success only after save resolves", async () => {
  const output: string[] = [];
  let valueIndex = 0;
  let resolveSave: (() => void) | undefined;
  const savePending = new Promise<void>((resolve) => {
    resolveSave = resolve;
  });
  const run = runCredentialsCli(["setup", "testnet"], {
    output: { write: (message) => output.push(message) },
    prompt: async (_label, hidden) => {
      assert.equal(hidden, true);
      return values[valueIndex++] ?? "test-value";
    },
    provider: {
      load: async () => {
        throw new Error("unused");
      },
      save: async () => savePending,
      remove: async () => undefined,
    },
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(output.length, 0);
  resolveSave?.();
  assert.equal(await run, 0);
  assert.match(output.join(""), /Stored Bybit testnet credentials/);
});

test("remove CLI passes only the selected environment", async () => {
  let removed: string | undefined;
  const code = await runCredentialsCli(["remove", "mainnet"], {
    output: { write: () => undefined },
    provider: {
      load: async () => {
        throw new Error("unused");
      },
      save: async () => undefined,
      remove: async (environment) => {
        removed = environment;
      },
    },
  });

  assert.equal(code, 0);
  assert.equal(removed, "mainnet");
});

test("CLI rejects invalid commands without touching the provider", async () => {
  let touched = false;
  const code = await runCredentialsCli(["status", "testnet"], {
    output: { write: () => undefined },
    provider: {
      load: async () => {
        touched = true;
        throw new Error("unexpected");
      },
      save: async () => {
        touched = true;
      },
      remove: async () => {
        touched = true;
      },
    },
  });

  assert.equal(code, 2);
  assert.equal(touched, false);
});

test("CLI reports a safe actionable setup error", async () => {
  const output: string[] = [];
  const code = await runCredentialsCli(["setup", "testnet"], {
    output: { write: (message) => output.push(message) },
    prompt: async () => "value",
    provider: {
      load: async () => {
        throw new Error("unused");
      },
      save: async () => {
        throw new CredentialProviderError(
          "write-failed",
          "Credentials could not be stored.",
        );
      },
      remove: async () => undefined,
    },
  });

  assert.equal(code, 1);
  assert.match(output.join(""), /could not be stored/i);
  assert.doesNotMatch(output.join(""), /value|write-failed/);
});
