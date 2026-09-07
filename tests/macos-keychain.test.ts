import assert from "node:assert/strict";
import test from "node:test";

import {
  CredentialProviderError,
  createMacOSKeychainProvider,
  type SecurityCommandResult,
  type SecurityRunner,
} from "../src/adapters/macos-keychain.js";
import {
  credentialPreflightAccount,
  credentialPreflightServiceName,
} from "../src/ports/credential-provider.js";

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
  const { calls, runner } = runnerFor((args) => ({
    stdout: "",
    stderr: "",
    exitCode: args[0] === "find-generic-password" ? 44 : 0,
  }));
  const provider = createMacOSKeychainProvider({ runner, platform: "darwin" });

  await provider.save("testnet", credentials);

  const writes = calls.filter(({ args }) => args[0] === "add-generic-password");
  assert.equal(writes.length, 3);
  for (const call of writes) {
    assert.deepEqual(call.args.slice(0, 1), ["add-generic-password"]);
    assert.equal(call.args.includes("-U"), true);
    assert.equal(call.args.includes(credentials.apiKey), false);
    assert.equal(call.args.includes(credentials.apiSecret), false);
    assert.equal(call.args.includes(credentials.accountId), false);
    assert.match(call.input ?? "", /\n$/);
  }
  assert.deepEqual(
    writes.map(({ args }) => args[args.indexOf("-a") + 1]),
    ["api-key", "api-secret", "account-id"],
  );
  assert.ok(writes[0]?.input?.includes(credentials.apiKey));
});

test("preflight round-trips an isolated non-secret sentinel and removes it", async () => {
  let sentinel = "";
  const { calls, runner } = runnerFor((args, input) => {
    if (args[0] === "add-generic-password") {
      sentinel = (input ?? "").trim();
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    if (args[0] === "find-generic-password") {
      return { stdout: `${sentinel}\n`, stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  });
  const provider = createMacOSKeychainProvider({ runner, platform: "darwin" });

  await provider.preflight("testnet");

  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.map(({ args }) => args[0]),
    [
      "add-generic-password",
      "find-generic-password",
      "delete-generic-password",
    ],
  );
  for (const { args } of calls) {
    assert.equal(args[args.indexOf("-a") + 1], credentialPreflightAccount);
    assert.equal(
      args[args.indexOf("-s") + 1],
      credentialPreflightServiceName("testnet"),
    );
    assert.equal(args.includes(sentinel), false);
  }
  assert.match(calls[0]?.input ?? "", /^connect-preflight-[a-f0-9]{32}\n$/);
});

test("preflight failure is redacted and still removes the sentinel", async () => {
  const { calls, runner } = runnerFor((args) => {
    if (args[0] === "find-generic-password") {
      return {
        stdout: "wrong-sentinel\n",
        stderr: "private detail",
        exitCode: 0,
      };
    }
    return { stdout: "", stderr: "private detail", exitCode: 0 };
  });
  const provider = createMacOSKeychainProvider({ runner, platform: "darwin" });

  await assert.rejects(provider.preflight("mainnet"), (error: unknown) => {
    assert.ok(error instanceof CredentialProviderError);
    assert.equal((error as CredentialProviderError).code, "preflight-failed");
    assert.match((error as Error).message, /OAuth was not started/);
    assert.doesNotMatch((error as Error).message, /private detail|sentinel/);
    return true;
  });
  assert.equal(calls.at(-1)?.args[0], "delete-generic-password");
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
    "com.crypto-analyst-trader.bybit.testnet",
  );
});

test("mainnet load never falls back to Testnet", async () => {
  const { calls, runner } = runnerFor(() => ({
    stdout: "",
    stderr: "",
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
    "com.crypto-analyst-trader.bybit.mainnet",
  );
});

test("locked Keychain access returns a safe actionable error", async () => {
  const { runner } = runnerFor(() => ({
    stdout: "",
    stderr: "",
    exitCode: 36,
  }));
  const provider = createMacOSKeychainProvider({ runner, platform: "darwin" });

  await assert.rejects(provider.load("testnet"), (error: unknown) => {
    assert.ok(error instanceof CredentialProviderError);
    const typedError = error as CredentialProviderError;
    assert.equal(typedError.code, "inaccessible");
    assert.match(typedError.message, /unlock.*Keychain/i);
    return true;
  });
});

test("unknown security failure does not use localized stderr for classification", async () => {
  const { runner } = runnerFor(() => ({
    stdout: "",
    stderr: "The specified item could not be found in the keychain.",
    exitCode: 1,
  }));
  const provider = createMacOSKeychainProvider({ runner, platform: "darwin" });

  await assert.rejects(provider.load("testnet"), (error: unknown) => {
    assert.ok(error instanceof CredentialProviderError);
    assert.equal((error as CredentialProviderError).code, "command-failed");
    return true;
  });
});

test("load accesses Keychain records sequentially", async () => {
  let active = 0;
  let maximumActive = 0;
  const values = new Map([
    ["api-key", `${credentials.apiKey}\n`],
    ["api-secret", `${credentials.apiSecret}\n`],
    ["account-id", `${credentials.accountId}\n`],
  ]);
  const runner: SecurityRunner = async (args) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise<void>((resolve) => setImmediate(resolve));
    active -= 1;
    return {
      stdout: values.get(args[args.indexOf("-a") + 1] ?? "") ?? "",
      stderr: "",
      exitCode: 0,
    };
  };
  const provider = createMacOSKeychainProvider({ runner, platform: "darwin" });

  await provider.load("testnet");
  assert.equal(maximumActive, 1);
});

test("setup rejects empty or multiline values before invoking security", async () => {
  let invoked = false;
  const runner: SecurityRunner = async () => {
    invoked = true;
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  const provider = createMacOSKeychainProvider({ runner, platform: "darwin" });

  await assert.rejects(
    provider.save("testnet", { ...credentials, apiSecret: "line\nbreak" }),
    /single-line/,
  );
  assert.equal(invoked, false);
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
        "com.crypto-analyst-trader.bybit.testnet",
    ),
  );
});

test("setup cleans the selected set after a partial write failure", async () => {
  let writes = 0;
  const { calls, runner } = runnerFor((args) => {
    if (args[0] === "find-generic-password") {
      return { stdout: "", stderr: "", exitCode: 44 };
    }
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
      "com.crypto-analyst-trader.bybit.testnet",
      "com.crypto-analyst-trader.bybit.testnet",
      "com.crypto-analyst-trader.bybit.testnet",
    ],
  );
  assert.doesNotMatch(
    calls.map(({ input }) => input ?? "").join("\n"),
    /hidden detail/,
  );
});

test("failed cleanup does not mask the original write failure", async () => {
  let writes = 0;
  const { runner } = runnerFor((args) => {
    if (args[0] === "find-generic-password") {
      return { stdout: "", stderr: "", exitCode: 44 };
    }
    if (args[0] === "add-generic-password") {
      writes += 1;
      return {
        stdout: "",
        stderr: "write detail",
        exitCode: writes === 2 ? 1 : 0,
      };
    }
    return { stdout: "", stderr: "cleanup detail", exitCode: 1 };
  });
  const provider = createMacOSKeychainProvider({ runner, platform: "darwin" });

  await assert.rejects(
    provider.save("testnet", credentials),
    (error: unknown) => {
      assert.ok(error instanceof CredentialProviderError);
      const typedError = error as CredentialProviderError;
      assert.equal(typedError.code, "write-failed");
      assert.match(typedError.message, /could not be stored/i);
      assert.match(typedError.message, /rollback incomplete/i);
      assert.doesNotMatch(
        typedError.message,
        /write detail|cleanup detail|inaccessible/i,
      );
      return true;
    },
  );
});

test("partial update restores a complete prior credential set", async () => {
  const oldCredentials = {
    apiKey: "old-key",
    apiSecret: "old-secret",
    accountId: "old-account",
  };
  const values = new Map([
    ["api-key", `${oldCredentials.apiKey}\n`],
    ["api-secret", `${oldCredentials.apiSecret}\n`],
    ["account-id", `${oldCredentials.accountId}\n`],
  ]);
  const writes: string[] = [];
  let initialWrites = 0;
  const runner: SecurityRunner = async (args, input) => {
    if (args[0] === "find-generic-password") {
      return {
        stdout: values.get(args[args.indexOf("-a") + 1] ?? "") ?? "",
        stderr: "",
        exitCode: 0,
      };
    }
    if (args[0] === "add-generic-password") {
      const account = args[args.indexOf("-a") + 1] ?? "";
      writes.push(`${account}:${input ?? ""}`);
      initialWrites += 1;
      if (initialWrites === 2) {
        return { stdout: "", stderr: "", exitCode: 1 };
      }
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  const provider = createMacOSKeychainProvider({ runner, platform: "darwin" });

  await assert.rejects(
    provider.save("testnet", credentials),
    /could not be stored/,
  );
  assert.deepEqual(writes.slice(-3), [
    `api-key:${oldCredentials.apiKey}\n`,
    `api-secret:${oldCredentials.apiSecret}\n`,
    `account-id:${oldCredentials.accountId}\n`,
  ]);
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
