import assert from "node:assert/strict";
import test from "node:test";

import {
  SecurityCommandTimeoutError,
  type SecurityCommandResult,
  type SecurityRunner,
} from "../src/adapters/macos-keychain-command.js";
import { createMacOSKeychainSecretProvider } from "../src/adapters/macos-keychain-secret-provider.js";

const identity = Object.freeze({
  provider: "coinalyze",
  credential: "api-key",
});
const secret = "coinalyze-sentinel-api-key";

function result(overrides: Partial<SecurityCommandResult> = {}) {
  return {
    stdout: `${secret}\n`,
    stderr: "",
    exitCode: 0,
    ...overrides,
  };
}

test("reads exactly one namespaced Keychain item without shell or secret arguments", async () => {
  const calls: Array<{ args: string[]; input: string | undefined }> = [];
  const runner: SecurityRunner = async (args, input) => {
    calls.push({ args, input });
    return result();
  };
  const provider = createMacOSKeychainSecretProvider({
    platform: "darwin",
    runner,
  });

  const read = await provider.read(identity);

  assert.deepEqual(read, { kind: "available", secret });
  assert.deepEqual(calls, [
    {
      args: [
        "find-generic-password",
        "-a",
        "api-key",
        "-s",
        "com.crypto-analyst-trader.provider.coinalyze",
        "-w",
      ],
      input: undefined,
    },
  ]);
  assert.equal(calls[0]?.args.includes(secret), false);
  assert.equal(Object.isFrozen(read), true);
});

test("provider namespaces cannot cross-read each other", async () => {
  const services: string[] = [];
  const runner: SecurityRunner = async (args) => {
    services.push(args[args.indexOf("-s") + 1] ?? "");
    return result();
  };
  const provider = createMacOSKeychainSecretProvider({
    platform: "darwin",
    runner,
  });

  await provider.read(identity);
  await provider.read({ provider: "other-provider", credential: "api-key" });

  assert.deepEqual(services, [
    "com.crypto-analyst-trader.provider.coinalyze",
    "com.crypto-analyst-trader.provider.other-provider",
  ]);
});

test("missing, denied, timeout, command, and malformed secret outcomes are typed and sanitized", async (t) => {
  const cases: Array<{
    name: string;
    commandResult?: SecurityCommandResult;
    thrown?: Error;
    expected: string;
  }> = [
    {
      name: "missing item",
      commandResult: result({ exitCode: 44, stdout: "", stderr: secret }),
      expected: "missing",
    },
    {
      name: "locked Keychain",
      commandResult: result({ exitCode: 36, stdout: secret, stderr: secret }),
      expected: "inaccessible",
    },
    {
      name: "timeout",
      commandResult: result({
        exitCode: 1,
        failure: "timeout",
        stderr: secret,
      }),
      expected: "timeout",
    },
    {
      name: "unknown command failure",
      commandResult: result({ exitCode: 1, stdout: secret, stderr: secret }),
      expected: "command-failed",
    },
    {
      name: "empty secret",
      commandResult: result({ stdout: "" }),
      expected: "invalid-secret",
    },
    {
      name: "multiline secret",
      commandResult: result({ stdout: `${secret}\nextra\n` }),
      expected: "invalid-secret",
    },
    {
      name: "thrown timeout",
      thrown: new SecurityCommandTimeoutError(),
      expected: "timeout",
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const runner: SecurityRunner = async () => {
        if (item.thrown) throw item.thrown;
        return item.commandResult ?? result();
      };
      const provider = createMacOSKeychainSecretProvider({
        platform: "darwin",
        runner,
      });

      const read = await provider.read(identity);

      assert.deepEqual(read, { kind: "unavailable", reason: item.expected });
      assert.equal(JSON.stringify(read).includes(secret), false);
    });
  }
});

test("invalid identity and unsupported platform fail before Keychain access", async () => {
  let commandCount = 0;
  const runner: SecurityRunner = async () => {
    commandCount += 1;
    return result();
  };

  const darwinProvider = createMacOSKeychainSecretProvider({
    platform: "darwin",
    runner,
  });
  const invalid = await darwinProvider.read({
    provider: "../coinalyze",
    credential: "api-key",
  });
  const otherPlatform = createMacOSKeychainSecretProvider({
    platform: "linux",
    runner,
  });
  const unsupported = await otherPlatform.read(identity);

  assert.deepEqual(invalid, {
    kind: "unavailable",
    reason: "invalid-identity",
  });
  assert.deepEqual(unsupported, {
    kind: "unavailable",
    reason: "unsupported-platform",
  });
  assert.equal(commandCount, 0);
});
