import assert from "node:assert/strict";
import test from "node:test";

import {
  CredentialProviderError,
  createMacOSKeychainProvider,
  type SecurityCommandResult,
  type SecurityRunner,
} from "../src/adapters/macos-keychain.js";

const credentials = {
  apiKey: "test-api-key",
  apiSecret: "test-api-secret",
  accountId: "test-account",
};

function runnerFor(
  handler: (args: string[], input: string | undefined) => SecurityCommandResult,
) {
  const calls: Array<{ args: string[]; input: string | undefined }> = [];
  const runner: SecurityRunner = async (args, input) => {
    calls.push({ args, input });
    return handler(args, input);
  };
  return { calls, runner };
}

test("setup stores each value through security without putting secrets in argv", async () => {
  const { calls, runner } = runnerFor(() => ({
    stdout: "",
    stderr: "",
    exitCode: 0,
  }));
  const provider = createMacOSKeychainProvider({ runner, platform: "darwin" });

  await provider.save("testnet", credentials);

  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.deepEqual(call.args.slice(0, 1), ["add-generic-password"]);
    assert.equal(call.args.includes("-U"), true);
    assert.equal(call.args.includes(credentials.apiKey), false);
    assert.equal(call.args.includes(credentials.apiSecret), false);
    assert.equal(call.args.includes(credentials.accountId), false);
    assert.match(call.input ?? "", /\n$/);
  }
  assert.deepEqual(
    calls.map(({ args }) => args[args.indexOf("-a") + 1]),
    ["api-key", "api-secret", "account-id"],
  );
  assert.ok(calls[0]?.input?.includes(credentials.apiKey));
});

test("load reads a complete environment from its own service", async () => {
  const values = new Map([
    ["api-key", `${credentials.apiKey}\n`],
    ["api-secret", `${credentials.apiSecret}\n`],
    ["account-id", `${credentials.accountId}\n`],
  ]);
  const { calls, runner } = runnerFor((args) => ({
    stdout: values.get(args[args.indexOf("-a") + 1] ?? "") ?? "",
    stderr: "",
    exitCode: 0,
  }));
  const provider = createMacOSKeychainProvider({ runner, platform: "darwin" });

  assert.deepEqual(await provider.load("testnet"), credentials);
  assert.equal(
    new Set(calls.map(({ args }) => args[args.indexOf("-s") + 1])).size,
    1,
  );
  assert.equal(
    calls[0]?.args[calls[0].args.indexOf("-s") + 1],
    "com.olegeech.crypto-analyst-trader.bybit.testnet",
  );
});

test("mainnet load never falls back to Testnet", async () => {
  const { calls, runner } = runnerFor(() => ({
    stdout: "",
    stderr: "The specified item could not be found in the keychain.",
    exitCode: 44,
  }));
  const provider = createMacOSKeychainProvider({ runner, platform: "darwin" });

  await assert.rejects(provider.load("mainnet"), (error: unknown) => {
    assert.ok(error instanceof CredentialProviderError);
    const typedError = error as CredentialProviderError;
    assert.equal(typedError.code, "missing");
    assert.match(typedError.message, /credentials:setup:mainnet/);
    assert.doesNotMatch(typedError.message, /keychain|specified item/i);
    return true;
  });
  assert.equal(
    calls[0]?.args[calls[0].args.indexOf("-s") + 1],
    "com.olegeech.crypto-analyst-trader.bybit.mainnet",
  );
});

test("remove targets only the selected environment and treats missing entries as success", async () => {
  const { calls, runner } = runnerFor(() => ({
    stdout: "",
    stderr: "The specified item could not be found in the keychain.",
    exitCode: 44,
  }));
  const provider = createMacOSKeychainProvider({ runner, platform: "darwin" });

  await provider.remove("testnet");

  assert.equal(calls.length, 3);
  assert.ok(
    calls.every(
      ({ args }) =>
        args[args.indexOf("-s") + 1] ===
        "com.olegeech.crypto-analyst-trader.bybit.testnet",
    ),
  );
});

test("setup cleans the selected set after a partial write failure", async () => {
  let writes = 0;
  const { calls, runner } = runnerFor((args) => {
    if (args[0] === "add-generic-password") {
      writes += 1;
      return {
        stdout: "",
        stderr: writes === 2 ? "write failed: hidden detail" : "",
        exitCode: writes === 2 ? 1 : 0,
      };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  });
  const provider = createMacOSKeychainProvider({ runner, platform: "darwin" });

  await assert.rejects(
    provider.save("testnet", credentials),
    /setup:.*testnet/,
  );
  assert.deepEqual(
    calls
      .filter(({ args }) => args[0] === "delete-generic-password")
      .map(({ args }) => args[args.indexOf("-s") + 1]),
    [
      "com.olegeech.crypto-analyst-trader.bybit.testnet",
      "com.olegeech.crypto-analyst-trader.bybit.testnet",
      "com.olegeech.crypto-analyst-trader.bybit.testnet",
    ],
  );
  assert.doesNotMatch(
    calls.map(({ input }) => input ?? "").join("\n"),
    /hidden detail/,
  );
});

test("non-macOS setup is blocked before invoking a command", async () => {
  const runner: SecurityRunner = async () => ({
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  const provider = createMacOSKeychainProvider({ runner, platform: "linux" });

  await assert.rejects(provider.load("testnet"), /macOS Keychain/);
});
