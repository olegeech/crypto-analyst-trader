import assert from "node:assert/strict";
import type { spawn, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  CredentialProviderError,
  createMacOSKeychainProvider,
  runSecurity,
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

interface FakeKeychainItem {
  account: string;
  service: string;
  value: string;
}

interface FakeCommandOutcome extends Partial<SecurityCommandResult> {
  mutatedValue?: string;
  storedValue?: string;
  throwError?: boolean;
}

function statefulSecurityRunner({
  initialItems = [],
  addOutcomes = [],
  readOutcomes = [],
  deleteOutcomes = [],
}: {
  initialItems?: FakeKeychainItem[];
  addOutcomes?: FakeCommandOutcome[];
  readOutcomes?: FakeCommandOutcome[];
  deleteOutcomes?: FakeCommandOutcome[];
} = {}) {
  const calls: Array<{ args: string[]; input: string | undefined }> = [];
  const items = new Map(
    initialItems.map(({ account, service, value }) => [
      JSON.stringify([service, account]),
      value,
    ]),
  );

  function optionValue(args: string[], option: "-a" | "-s"): string {
    const index = args.indexOf(option);
    return index >= 0 ? (args[index + 1] ?? "") : "";
  }

  function itemKey(args: string[]): string | null {
    const account = optionValue(args, "-a");
    const service = optionValue(args, "-s");
    return account && service ? JSON.stringify([service, account]) : null;
  }

  function completeResult(
    outcome: FakeCommandOutcome | undefined,
    fallback: SecurityCommandResult,
  ): SecurityCommandResult {
    return {
      stdout: outcome?.stdout ?? fallback.stdout,
      stderr: outcome?.stderr ?? fallback.stderr,
      exitCode: outcome?.exitCode ?? fallback.exitCode,
    };
  }

  const runner: SecurityRunner = async (args, input) => {
    calls.push({ args: [...args], input });
    const key = itemKey(args);
    let result: SecurityCommandResult;

    if (args[0] === "add-generic-password" && key) {
      let update = false;
      let passwordArgument: string | undefined;
      let promptsForPassword = false;
      for (let index = 1; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === "-a" || argument === "-s") {
          index += 1;
        } else if (argument === "-U") {
          update = true;
        } else if (argument === "-w") {
          if (index === args.length - 1) {
            promptsForPassword = true;
          } else {
            passwordArgument = args[index + 1];
            index += 1;
          }
        }
      }

      if (items.has(key) && !update) {
        result = { stdout: "", stderr: "duplicate item", exitCode: 45 };
      } else {
        const inputLines = input?.split("\n") ?? [];
        const promptedValue =
          promptsForPassword &&
          inputLines.length === 3 &&
          inputLines[2] === "" &&
          inputLines[0] === inputLines[1]
            ? inputLines[0]
            : undefined;
        const requestedValue = passwordArgument ?? promptedValue;
        if (requestedValue === undefined) {
          result = {
            stdout: "",
            stderr: "invalid password input",
            exitCode: 1,
          };
        } else {
          const outcome = addOutcomes.shift();
          if (outcome?.throwError) {
            throw new Error("private runner failure");
          }
          result = completeResult(outcome, {
            stdout: "",
            stderr: "",
            exitCode: 0,
          });
          if (
            result.exitCode === 0 ||
            (outcome && Object.hasOwn(outcome, "mutatedValue"))
          ) {
            items.set(
              key,
              outcome && Object.hasOwn(outcome, "mutatedValue")
                ? (outcome.mutatedValue ?? "")
                : outcome && Object.hasOwn(outcome, "storedValue")
                  ? (outcome.storedValue ?? "")
                  : requestedValue,
            );
          }
        }
      }
    } else if (args[0] === "find-generic-password" && key) {
      const storedValue = items.get(key);
      const outcome = readOutcomes.shift();
      if (outcome?.throwError) {
        throw new Error("private runner failure");
      }
      result = completeResult(
        outcome,
        storedValue === undefined
          ? { stdout: "", stderr: "item not found", exitCode: 44 }
          : { stdout: `${storedValue}\n`, stderr: "", exitCode: 0 },
      );
    } else if (args[0] === "delete-generic-password" && key) {
      const outcome = deleteOutcomes.shift();
      result = completeResult(
        outcome,
        items.has(key)
          ? { stdout: "", stderr: "", exitCode: 0 }
          : { stdout: "", stderr: "item not found", exitCode: 44 },
      );
      if (result.exitCode === 0) {
        items.delete(key);
      }
    } else {
      result = { stdout: "", stderr: "unsupported command", exitCode: 1 };
    }

    return result;
  };

  return {
    calls,
    runner,
    valueFor(service: string, account: string): string | undefined {
      return items.get(JSON.stringify([service, account]));
    },
  };
}

test("hung security commands are killed after a bounded timeout", async () => {
  let killedWith: NodeJS.Signals | undefined;
  const child = {
    stdout: {
      setEncoding: () => undefined,
      on: () => undefined,
    },
    stderr: {
      setEncoding: () => undefined,
      on: () => undefined,
    },
    stdin: { end: () => undefined },
    once: () => child,
    kill: (signal?: NodeJS.Signals) => {
      killedWith = signal;
      return true;
    },
  } as unknown as ReturnType<typeof spawn>;
  const spawnProcess = (() => child) as unknown as typeof spawn;

  await assert.rejects(
    runSecurity([], undefined, { timeoutMs: 10, spawnProcess }),
    /timed out/,
  );
  assert.equal(killedWith, "SIGKILL");
});

function fakeSecurityChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter & { setEncoding(): void };
    stderr: EventEmitter & { setEncoding(): void };
    stdin: { end(input?: string): void };
    kill(signal?: NodeJS.Signals): boolean;
  };
  const stream = () =>
    Object.assign(new EventEmitter(), { setEncoding: () => undefined });
  const state: {
    input?: string | undefined;
    killedWith?: NodeJS.Signals | undefined;
  } = {};
  child.stdout = stream();
  child.stderr = stream();
  child.stdin = { end: (input?: string) => void (state.input = input) };
  child.kill = (signal?: NodeJS.Signals) => {
    state.killedWith = signal;
    return true;
  };
  return { child, state };
}

function fakeParentProcess() {
  const parent = Object.assign(new EventEmitter(), {
    pid: 4242,
    raised: [] as Array<[number, string | number | undefined]>,
    kill(pid: number, signal?: string | number) {
      parent.raised.push([pid, signal]);
      return true;
    },
  });
  return parent;
}

test("security runs without a controlling terminal so piped input is used", async () => {
  const { child } = fakeSecurityChild();
  let spawnOptions: SpawnOptions | undefined;
  const spawnProcess = ((
    _command: string,
    _args: string[],
    options: SpawnOptions,
  ) => {
    spawnOptions = options;
    return child;
  }) as unknown as typeof spawn;
  const parentProcess = fakeParentProcess();

  const result = runSecurity(["find-generic-password"], undefined, {
    spawnProcess,
    parentProcess: parentProcess as unknown as NodeJS.Process,
  });
  child.emit("close", 0);
  await result;

  assert.equal(spawnOptions?.detached, true);
  assert.deepEqual(spawnOptions?.stdio, ["pipe", "pipe", "pipe"]);
  assert.equal(spawnOptions?.shell, false);
});

test("a terminal signal kills the detached security child and is re-raised", async (t) => {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    await t.test(signal, async () => {
      const { child, state } = fakeSecurityChild();
      const spawnProcess = (() => child) as unknown as typeof spawn;
      const parentProcess = fakeParentProcess();

      const result = runSecurity(["add-generic-password"], "value\nvalue\n", {
        spawnProcess,
        parentProcess: parentProcess as unknown as NodeJS.Process,
      });
      parentProcess.emit(signal, signal);

      await assert.rejects(result, /interrupted/);
      assert.equal(state.killedWith, "SIGKILL");
      assert.deepEqual(parentProcess.raised, [[4242, signal]]);
      for (const event of ["exit", "SIGINT", "SIGTERM", "SIGHUP"]) {
        assert.equal(parentProcess.listenerCount(event), 0);
      }
    });
  }
});

test("parent exit kills an active security child", async () => {
  const { child, state } = fakeSecurityChild();
  const spawnProcess = (() => child) as unknown as typeof spawn;
  const parentProcess = fakeParentProcess();

  const result = runSecurity(["find-generic-password"], undefined, {
    spawnProcess,
    parentProcess: parentProcess as unknown as NodeJS.Process,
  });
  parentProcess.emit("exit", 1);
  child.emit("close", null);
  await result;

  assert.equal(state.killedWith, "SIGKILL");
});

test("completed security commands release parent listeners", async () => {
  const { child, state } = fakeSecurityChild();
  const spawnProcess = (() => child) as unknown as typeof spawn;
  const parentProcess = fakeParentProcess();

  const result = runSecurity(["add-generic-password"], "value\nvalue\n", {
    spawnProcess,
    parentProcess: parentProcess as unknown as NodeJS.Process,
  });
  child.stdout.emit("data", "out");
  child.emit("close", 0);

  assert.deepEqual(await result, { stdout: "out", stderr: "", exitCode: 0 });
  assert.equal(state.input, "value\nvalue\n");
  assert.equal(state.killedWith, undefined);
  for (const event of ["exit", "SIGINT", "SIGTERM", "SIGHUP"]) {
    assert.equal(parentProcess.listenerCount(event), 0);
  }
});

test("timed out Keychain reads return actionable unlock guidance", async () => {
  const { runner } = runnerFor(() => ({
    stdout: "",
    stderr: "",
    exitCode: 1,
    failure: "timeout",
  }));
  const provider = createMacOSKeychainProvider({ runner, platform: "darwin" });

  await assert.rejects(provider.load("testnet"), (error: unknown) => {
    assert.ok(error instanceof CredentialProviderError);
    assert.equal(error.code, "inaccessible");
    assert.match(error.message, /Keychain access timed out/);
    assert.match(error.message, /unlock.*Keychain|approve.*access prompt/i);
    return true;
  });
});

test("timed out writes retain actionable unlock guidance", async () => {
  const { runner } = runnerFor((args) => {
    if (args[0] === "add-generic-password") {
      return { stdout: "", stderr: "", exitCode: 1, failure: "timeout" };
    }
    return { stdout: "", stderr: "", exitCode: 44 };
  });
  const provider = createMacOSKeychainProvider({ runner, platform: "darwin" });

  await assert.rejects(
    provider.save("testnet", credentials),
    (error: unknown) => {
      assert.ok(error instanceof CredentialProviderError);
      assert.equal(error.code, "write-failed");
      assert.match(error.message, /Keychain access timed out/);
      assert.match(error.message, /unlock.*Keychain|approve.*access prompt/i);
      assert.match(error.message, /credential set was cleared/i);
      return true;
    },
  );
});

test("timed out preflight returns actionable unlock guidance", async () => {
  const { runner } = runnerFor((args) => {
    if (args[0] === "add-generic-password") {
      return { stdout: "", stderr: "", exitCode: 1, failure: "timeout" };
    }
    return { stdout: "", stderr: "", exitCode: 44 };
  });
  const provider = createMacOSKeychainProvider({ runner, platform: "darwin" });

  await assert.rejects(provider.preflight("testnet"), (error: unknown) => {
    assert.ok(error instanceof CredentialProviderError);
    assert.equal(error.code, "preflight-failed");
    assert.match(error.message, /preflight timed out/);
    assert.match(error.message, /unlock.*Keychain|approve.*access prompt/i);
    assert.match(error.message, /credentials:connect:testnet/);
    assert.doesNotMatch(error.message, /credentials:setup/);
    assert.match(error.message, /OAuth was not started/);
    return true;
  });
});

const testnetService = "com.crypto-analyst-trader.bybit.testnet";
const mainnetService = "com.crypto-analyst-trader.bybit.mainnet";

test("fresh writes put effective update mode before a final -w", async () => {
  const fake = statefulSecurityRunner();
  const provider = createMacOSKeychainProvider({
    runner: fake.runner,
    platform: "darwin",
  });

  await provider.save("testnet", credentials);

  const writes = fake.calls.filter(
    ({ args }) => args[0] === "add-generic-password",
  );
  assert.deepEqual(
    writes.map(({ args }) => args),
    [
      [
        "add-generic-password",
        "-a",
        "api-key",
        "-s",
        testnetService,
        "-U",
        "-w",
      ],
      [
        "add-generic-password",
        "-a",
        "api-secret",
        "-s",
        testnetService,
        "-U",
        "-w",
      ],
      [
        "add-generic-password",
        "-a",
        "account-id",
        "-s",
        testnetService,
        "-U",
        "-w",
      ],
    ],
  );
});

test("fresh writes send identical newline-terminated entry and confirmation values", async () => {
  const fake = statefulSecurityRunner();
  const provider = createMacOSKeychainProvider({
    runner: fake.runner,
    platform: "darwin",
  });

  await provider.save("testnet", credentials);

  const writes = fake.calls.filter(
    ({ args }) => args[0] === "add-generic-password",
  );
  assert.deepEqual(
    writes.map(({ input }) => input),
    [
      `${credentials.apiKey}\n${credentials.apiKey}\n`,
      `${credentials.apiSecret}\n${credentials.apiSecret}\n`,
      `${credentials.accountId}\n${credentials.accountId}\n`,
    ],
  );
});

test("existing items are updated only when -U remains an effective option", async () => {
  const fake = statefulSecurityRunner({
    initialItems: [
      { account: "api-key", service: testnetService, value: "old-key" },
      { account: "api-secret", service: testnetService, value: "old-secret" },
      { account: "account-id", service: testnetService, value: "old-account" },
    ],
  });
  const provider = createMacOSKeychainProvider({
    runner: fake.runner,
    platform: "darwin",
  });

  await provider.save("testnet", credentials);

  assert.equal(fake.valueFor(testnetService, "api-key"), credentials.apiKey);
  assert.equal(
    fake.valueFor(testnetService, "api-secret"),
    credentials.apiSecret,
  );
  assert.equal(
    fake.valueFor(testnetService, "account-id"),
    credentials.accountId,
  );
});

test("an exit-zero write cannot succeed without exact read-back", async (t) => {
  for (const storedValue of ["", "line\nbreak", "different-value"]) {
    await t.test(
      storedValue === ""
        ? "empty stored state"
        : storedValue.includes("\n")
          ? "invalid stored state"
          : "different stored state",
      async () => {
        const fake = statefulSecurityRunner({
          addOutcomes: [{ exitCode: 0, storedValue }],
        });
        const provider = createMacOSKeychainProvider({
          runner: fake.runner,
          platform: "darwin",
        });

        await assert.rejects(
          provider.save("testnet", credentials),
          (error: unknown) => {
            assert.ok(error instanceof CredentialProviderError);
            assert.equal(error.code, "write-failed");
            assert.doesNotMatch(
              error.message,
              new RegExp(
                [
                  credentials.apiKey,
                  credentials.apiSecret,
                  credentials.accountId,
                  storedValue,
                ]
                  .filter(Boolean)
                  .join("|"),
              ),
            );
            return true;
          },
        );
        assert.equal(fake.valueFor(testnetService, "api-key"), undefined);
      },
    );
  }
});

test("save writes and verifies each credential sequentially", async () => {
  const fake = statefulSecurityRunner();
  const provider = createMacOSKeychainProvider({
    runner: fake.runner,
    platform: "darwin",
  });

  await provider.save("testnet", credentials);

  assert.deepEqual(
    fake.calls
      .slice(3)
      .map(({ args }) => [args[0], args[args.indexOf("-a") + 1]]),
    [
      ["add-generic-password", "api-key"],
      ["find-generic-password", "api-key"],
      ["add-generic-password", "api-secret"],
      ["find-generic-password", "api-secret"],
      ["add-generic-password", "account-id"],
      ["find-generic-password", "account-id"],
    ],
  );
});

test("read-back command failures remain redacted write failures", async (t) => {
  for (const { name, outcome } of [
    {
      name: "interaction required",
      outcome: { exitCode: 36, stderr: credentials.apiSecret },
    },
    {
      name: "missing item",
      outcome: { exitCode: 44, stderr: credentials.apiSecret },
    },
    {
      name: "generic read failure",
      outcome: { exitCode: 1, stderr: credentials.apiSecret },
    },
    {
      name: "runner exception",
      outcome: { throwError: true },
    },
  ] satisfies Array<{ name: string; outcome: FakeCommandOutcome }>) {
    await t.test(name, async () => {
      const fake = statefulSecurityRunner({
        readOutcomes: [{}, {}, {}, outcome],
      });
      const provider = createMacOSKeychainProvider({
        runner: fake.runner,
        platform: "darwin",
      });

      await assert.rejects(
        provider.save("testnet", credentials),
        (error: unknown) => {
          assert.ok(error instanceof CredentialProviderError);
          assert.equal(error.code, "write-failed");
          assert.match(error.message, /could not be stored/i);
          for (const value of Object.values(credentials)) {
            assert.doesNotMatch(error.message, new RegExp(value));
          }
          return true;
        },
      );
    });
  }
});

test("a nonzero add remains a write failure when read-back matches", async () => {
  const fake = statefulSecurityRunner({
    initialItems: [
      {
        account: "api-key",
        service: testnetService,
        value: credentials.apiKey,
      },
      {
        account: "api-secret",
        service: testnetService,
        value: credentials.apiSecret,
      },
      {
        account: "account-id",
        service: testnetService,
        value: credentials.accountId,
      },
    ],
    addOutcomes: [{ exitCode: 1, stderr: credentials.apiKey }],
  });
  const provider = createMacOSKeychainProvider({
    runner: fake.runner,
    platform: "darwin",
  });

  await assert.rejects(
    provider.save("testnet", credentials),
    (error: unknown) => {
      assert.ok(error instanceof CredentialProviderError);
      assert.equal(error.code, "write-failed");
      assert.doesNotMatch(error.message, new RegExp(credentials.apiKey));
      return true;
    },
  );
});

test("preflight round-trips an isolated non-secret sentinel and removes it", async () => {
  const fake = statefulSecurityRunner();
  const provider = createMacOSKeychainProvider({
    runner: fake.runner,
    platform: "darwin",
  });

  await provider.preflight("testnet");

  assert.equal(fake.calls.length, 3);
  assert.deepEqual(
    fake.calls.map(({ args }) => args[0]),
    [
      "add-generic-password",
      "find-generic-password",
      "delete-generic-password",
    ],
  );
  for (const { args } of fake.calls) {
    assert.equal(args[args.indexOf("-a") + 1], credentialPreflightAccount);
    assert.equal(
      args[args.indexOf("-s") + 1],
      credentialPreflightServiceName("testnet"),
    );
  }
  assert.deepEqual(fake.calls[0]?.args, [
    "add-generic-password",
    "-a",
    credentialPreflightAccount,
    "-s",
    credentialPreflightServiceName("testnet"),
    "-U",
    "-w",
  ]);
  assert.match(
    fake.calls[0]?.input ?? "",
    /^(connect-preflight-[a-f0-9]{32})\n\1\n$/,
  );
  const sentinel = fake.calls[0]?.input?.split("\n")[0] ?? "";
  assert.ok(sentinel);
  assert.ok(fake.calls.every(({ args }) => !args.includes(sentinel)));
});

test("credential values, sentinels, and command output stay out of errors and argv", async () => {
  const privateStdout = `private stdout ${credentials.apiKey}`;
  const privateStderr = `private stderr ${credentials.apiSecret}`;
  const credentialFake = statefulSecurityRunner({
    addOutcomes: [
      { exitCode: 1, stdout: privateStdout, stderr: privateStderr },
    ],
  });
  const credentialProvider = createMacOSKeychainProvider({
    runner: credentialFake.runner,
    platform: "darwin",
  });
  let credentialError = "";

  await assert.rejects(
    credentialProvider.save("testnet", credentials),
    (error: unknown) => {
      assert.ok(error instanceof CredentialProviderError);
      credentialError = error.message;
      return true;
    },
  );

  const credentialArgv = credentialFake.calls
    .flatMap(({ args }) => args)
    .join(" ");
  for (const value of Object.values(credentials)) {
    assert.doesNotMatch(credentialArgv, new RegExp(value));
    assert.doesNotMatch(credentialError, new RegExp(value));
  }
  assert.doesNotMatch(credentialError, /private stdout|private stderr/);

  const preflightFake = statefulSecurityRunner({
    addOutcomes: [
      {
        exitCode: 0,
        storedValue: "substituted-sentinel",
        stdout: "private preflight stdout",
        stderr: "private preflight stderr",
      },
    ],
  });
  const preflightProvider = createMacOSKeychainProvider({
    runner: preflightFake.runner,
    platform: "darwin",
  });
  let preflightError = "";

  await assert.rejects(
    preflightProvider.preflight("testnet"),
    (error: unknown) => {
      assert.ok(error instanceof CredentialProviderError);
      preflightError = error.message;
      return true;
    },
  );

  const sentinel = preflightFake.calls[0]?.input?.split("\n")[0] ?? "";
  assert.ok(sentinel);
  assert.ok(preflightFake.calls.every(({ args }) => !args.includes(sentinel)));
  assert.doesNotMatch(preflightError, new RegExp(sentinel));
  assert.doesNotMatch(
    preflightError,
    /substituted-sentinel|private preflight stdout|private preflight stderr/,
  );
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
  const fake = statefulSecurityRunner({
    addOutcomes: [{}, { exitCode: 1, stderr: "write failed: hidden detail" }],
  });
  const provider = createMacOSKeychainProvider({
    runner: fake.runner,
    platform: "darwin",
  });

  await assert.rejects(
    provider.save("testnet", credentials),
    /setup:.*testnet/,
  );
  assert.deepEqual(
    fake.calls
      .filter(({ args }) => args[0] === "delete-generic-password")
      .map(({ args }) => args[args.indexOf("-s") + 1]),
    [
      "com.crypto-analyst-trader.bybit.testnet",
      "com.crypto-analyst-trader.bybit.testnet",
      "com.crypto-analyst-trader.bybit.testnet",
    ],
  );
  assert.deepEqual(
    fake.calls
      .filter(({ args }) => args[0] === "add-generic-password")
      .map(({ args }) => args[args.indexOf("-a") + 1]),
    ["api-key", "api-secret"],
  );
  assert.doesNotMatch(
    fake.calls.map(({ input }) => input ?? "").join("\n"),
    /hidden detail/,
  );
});

test("failed cleanup does not mask the original write failure", async () => {
  const fake = statefulSecurityRunner({
    addOutcomes: [{}, { exitCode: 1, stderr: "write detail" }],
    deleteOutcomes: [{ exitCode: 1, stderr: "cleanup detail" }],
  });
  const provider = createMacOSKeychainProvider({
    runner: fake.runner,
    platform: "darwin",
  });

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
  const fake = statefulSecurityRunner({
    initialItems: [
      {
        account: "api-key",
        service: testnetService,
        value: oldCredentials.apiKey,
      },
      {
        account: "api-secret",
        service: testnetService,
        value: oldCredentials.apiSecret,
      },
      {
        account: "account-id",
        service: testnetService,
        value: oldCredentials.accountId,
      },
    ],
    addOutcomes: [{}, { exitCode: 1 }, {}, {}, {}],
  });
  const provider = createMacOSKeychainProvider({
    runner: fake.runner,
    platform: "darwin",
  });

  await assert.rejects(
    provider.save("testnet", credentials),
    /could not be stored/,
  );
  assert.deepEqual(
    fake.calls
      .filter(({ args }) => args[0] === "add-generic-password")
      .slice(-3)
      .map(
        ({ args, input }) => `${args[args.indexOf("-a") + 1]}:${input ?? ""}`,
      ),
    [
      `api-key:${oldCredentials.apiKey}\n${oldCredentials.apiKey}\n`,
      `api-secret:${oldCredentials.apiSecret}\n${oldCredentials.apiSecret}\n`,
      `account-id:${oldCredentials.accountId}\n${oldCredentials.accountId}\n`,
    ],
  );
});

test("setup overwrites a corrupt prior credential record", async () => {
  const fake = statefulSecurityRunner({
    initialItems: [
      { account: "api-key", service: testnetService, value: "corrupt\nvalue" },
    ],
  });
  const provider = createMacOSKeychainProvider({
    runner: fake.runner,
    platform: "darwin",
  });

  await provider.save("testnet", credentials);

  assert.equal(
    fake.calls.filter(({ args }) => args[0] === "add-generic-password").length,
    3,
  );
  assert.equal(
    fake.calls.filter(({ args }) => args[0] === "delete-generic-password")
      .length,
    0,
  );
});

test("snapshot classifies every record before aborting on inaccessible or unknown state", async (t) => {
  for (const { name, finalResult, expectedCode } of [
    {
      name: "inaccessible record after missing and invalid records",
      finalResult: {
        stdout: "",
        stderr: "private locked detail",
        exitCode: 36,
      },
      expectedCode: "inaccessible",
    },
    {
      name: "unknown record after missing and invalid records",
      finalResult: {
        stdout: "",
        stderr: "private unknown detail",
        exitCode: 1,
      },
      expectedCode: "command-failed",
    },
  ] as const) {
    await t.test(name, async () => {
      const { calls, runner } = runnerFor((args) => {
        const account = args[args.indexOf("-a") + 1];
        if (args[0] === "find-generic-password") {
          if (account === "api-key") {
            return { stdout: "", stderr: "missing", exitCode: 44 };
          }
          if (account === "api-secret") {
            return { stdout: "invalid\nvalue\n", stderr: "", exitCode: 0 };
          }
          return finalResult;
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      });
      const provider = createMacOSKeychainProvider({
        runner,
        platform: "darwin",
      });

      await assert.rejects(
        provider.save("testnet", credentials),
        (error: unknown) => {
          assert.ok(error instanceof CredentialProviderError);
          assert.equal(error.code, expectedCode);
          assert.doesNotMatch(error.message, /private|invalid\nvalue/);
          return true;
        },
      );
      assert.deepEqual(
        calls.map(({ args }) => [args[0], args[args.indexOf("-a") + 1]]),
        [
          ["find-generic-password", "api-key"],
          ["find-generic-password", "api-secret"],
          ["find-generic-password", "account-id"],
        ],
      );
    });
  }
});

test("fresh partial saves clear and verify absence after nonzero and mismatched writes", async (t) => {
  for (const { name, addOutcomes } of [
    {
      name: "nonzero add",
      addOutcomes: [
        {},
        {
          exitCode: 1,
          stderr: "private write detail",
          mutatedValue: "private failed-write mutation",
        },
      ],
    },
    {
      name: "mismatched read-back",
      addOutcomes: [{ exitCode: 0, storedValue: "private mismatch" }],
    },
  ] satisfies Array<{ name: string; addOutcomes: FakeCommandOutcome[] }>) {
    await t.test(name, async () => {
      const fake = statefulSecurityRunner({ addOutcomes });
      const provider = createMacOSKeychainProvider({
        runner: fake.runner,
        platform: "darwin",
      });

      await assert.rejects(
        provider.save("testnet", credentials),
        (error: unknown) => {
          assert.ok(error instanceof CredentialProviderError);
          assert.match(error.message, /testnet credential set was cleared/i);
          return true;
        },
      );

      for (const account of ["api-key", "api-secret", "account-id"]) {
        assert.equal(fake.valueFor(testnetService, account), undefined);
      }
      assert.deepEqual(
        fake.calls.slice(-3).map(({ args }) => args[0]),
        [
          "find-generic-password",
          "find-generic-password",
          "find-generic-password",
        ],
      );
    });
  }
});

test("partial update restores then compares the complete immutable snapshot", async () => {
  const oldCredentials = {
    apiKey: "old-key-complete",
    apiSecret: "old-secret-complete",
    accountId: "old-account-complete",
  };
  const fake = statefulSecurityRunner({
    initialItems: [
      {
        account: "api-key",
        service: testnetService,
        value: oldCredentials.apiKey,
      },
      {
        account: "api-secret",
        service: testnetService,
        value: oldCredentials.apiSecret,
      },
      {
        account: "account-id",
        service: testnetService,
        value: oldCredentials.accountId,
      },
    ],
    addOutcomes: [{}, { exitCode: 1 }, {}, {}, {}],
  });
  const provider = createMacOSKeychainProvider({
    runner: fake.runner,
    platform: "darwin",
  });

  await assert.rejects(
    provider.save("testnet", credentials),
    /could not be stored/,
  );

  assert.equal(fake.valueFor(testnetService, "api-key"), oldCredentials.apiKey);
  assert.equal(
    fake.valueFor(testnetService, "api-secret"),
    oldCredentials.apiSecret,
  );
  assert.equal(
    fake.valueFor(testnetService, "account-id"),
    oldCredentials.accountId,
  );
  const restoreAdds = fake.calls
    .filter(({ args }) => args[0] === "add-generic-password")
    .slice(-3);
  assert.deepEqual(
    restoreAdds.map(({ args }) => args[args.indexOf("-a") + 1]),
    ["api-key", "api-secret", "account-id"],
  );
  assert.deepEqual(
    restoreAdds.map(({ input }) => input),
    [
      oldCredentials.apiKey,
      oldCredentials.apiSecret,
      oldCredentials.accountId,
    ].map((value) => `${value}\n${value}\n`),
  );
  for (const { args } of restoreAdds) {
    assert.equal(args.at(-1), "-w");
    assert.equal(args[args.indexOf("-U") + 1], "-w");
    for (const value of Object.values(oldCredentials)) {
      assert.equal(args.includes(value), false);
    }
  }
  const firstRestoreAdd = restoreAdds[0];
  assert.ok(firstRestoreAdd);
  const restoreStart = fake.calls.indexOf(firstRestoreAdd);
  assert.deepEqual(
    fake.calls
      .slice(restoreStart, restoreStart + 6)
      .map(({ args }) => [args[0], args[args.indexOf("-a") + 1]]),
    [
      ["add-generic-password", "api-key"],
      ["find-generic-password", "api-key"],
      ["add-generic-password", "api-secret"],
      ["find-generic-password", "api-secret"],
      ["add-generic-password", "account-id"],
      ["find-generic-password", "account-id"],
    ],
  );
  assert.deepEqual(
    fake.calls
      .slice(-3)
      .map(({ args }) => [args[0], args[args.indexOf("-a") + 1]]),
    [
      ["find-generic-password", "api-key"],
      ["find-generic-password", "api-secret"],
      ["find-generic-password", "account-id"],
    ],
  );
});

test("a failed restore write still attempts every record and final exact state proves recovery", async () => {
  const oldCredentials = {
    apiKey: "old-key-recoverable",
    apiSecret: "old-secret-recoverable",
    accountId: "old-account-recoverable",
  };
  const fake = statefulSecurityRunner({
    initialItems: [
      {
        account: "api-key",
        service: testnetService,
        value: oldCredentials.apiKey,
      },
      {
        account: "api-secret",
        service: testnetService,
        value: oldCredentials.apiSecret,
      },
      {
        account: "account-id",
        service: testnetService,
        value: oldCredentials.accountId,
      },
    ],
    addOutcomes: [{ exitCode: 1 }, { exitCode: 1 }, {}, {}],
  });
  const provider = createMacOSKeychainProvider({
    runner: fake.runner,
    platform: "darwin",
  });

  await assert.rejects(
    provider.save("testnet", credentials),
    (error: unknown) => {
      assert.ok(error instanceof CredentialProviderError);
      assert.equal(error.code, "write-failed");
      assert.doesNotMatch(error.message, /rollback incomplete/i);
      return true;
    },
  );
  assert.deepEqual(
    fake.calls
      .filter(({ args }) => args[0] === "add-generic-password")
      .map(({ args }) => args[args.indexOf("-a") + 1]),
    ["api-key", "api-key", "api-secret", "account-id"],
  );
  assert.equal(
    fake.calls.filter(({ args }) => args[0] === "delete-generic-password")
      .length,
    0,
  );
});

test("a final restore mismatch clears the selected environment and verifies absence", async () => {
  const oldCredentials = {
    apiKey: "old-key-mismatch",
    apiSecret: "old-secret-mismatch",
    accountId: "old-account-mismatch",
  };
  const fake = statefulSecurityRunner({
    initialItems: [
      {
        account: "api-key",
        service: testnetService,
        value: oldCredentials.apiKey,
      },
      {
        account: "api-secret",
        service: testnetService,
        value: oldCredentials.apiSecret,
      },
      {
        account: "account-id",
        service: testnetService,
        value: oldCredentials.accountId,
      },
    ],
    addOutcomes: [
      {},
      { exitCode: 1 },
      { storedValue: "private restore mismatch" },
      {},
      {},
    ],
  });
  const provider = createMacOSKeychainProvider({
    runner: fake.runner,
    platform: "darwin",
  });

  await assert.rejects(
    provider.save("testnet", credentials),
    (error: unknown) => {
      assert.ok(error instanceof CredentialProviderError);
      assert.equal(error.code, "write-failed");
      assert.match(error.message, /previous.*could not be restored/i);
      assert.match(error.message, /environment was cleared/i);
      assert.match(error.message, /credentials:setup:testnet/);
      assert.doesNotMatch(
        error.message,
        /rollback incomplete|private restore mismatch/i,
      );
      return true;
    },
  );
  for (const account of ["api-key", "api-secret", "account-id"]) {
    assert.equal(fake.valueFor(testnetService, account), undefined);
  }
  assert.deepEqual(
    fake.calls.slice(-3).map(({ args }) => args[0]),
    ["find-generic-password", "find-generic-password", "find-generic-password"],
  );
});

test("failed cleanup keeps the safe write error primary and verifies rollback is incomplete", async () => {
  const fake = statefulSecurityRunner({
    addOutcomes: [{}, { exitCode: 1, stderr: "private write detail" }],
    deleteOutcomes: [{ exitCode: 1, stderr: "private cleanup detail" }],
  });
  const provider = createMacOSKeychainProvider({
    runner: fake.runner,
    platform: "darwin",
  });

  await assert.rejects(
    provider.save("testnet", credentials),
    (error: unknown) => {
      assert.ok(error instanceof CredentialProviderError);
      assert.equal(error.code, "write-failed");
      assert.match(error.message, /could not be stored/i);
      assert.match(error.message, /rollback incomplete/i);
      assert.doesNotMatch(
        error.message,
        /private write detail|private cleanup detail/,
      );
      return true;
    },
  );
  assert.deepEqual(
    fake.calls.slice(-3).map(({ args }) => args[0]),
    ["find-generic-password", "find-generic-password", "find-generic-password"],
  );
});

test("cleanup command success is incomplete when final absence cannot be verified", async () => {
  const fake = statefulSecurityRunner({
    addOutcomes: [{}, { exitCode: 1 }],
    readOutcomes: [
      {},
      {},
      {},
      {},
      {},
      { stdout: "private surviving value\n", exitCode: 0 },
      {},
      {},
    ],
  });
  const provider = createMacOSKeychainProvider({
    runner: fake.runner,
    platform: "darwin",
  });

  await assert.rejects(
    provider.save("testnet", credentials),
    (error: unknown) => {
      assert.ok(error instanceof CredentialProviderError);
      assert.equal(error.code, "write-failed");
      assert.match(error.message, /rollback incomplete/i);
      assert.doesNotMatch(error.message, /private surviving value/);
      return true;
    },
  );
});

test("every preflight write failure branch attempts isolated cleanup", async (t) => {
  for (const scenario of [
    { name: "duplicate exit", addOutcomes: [{ exitCode: 45 }] },
    { name: "other nonzero exit", addOutcomes: [{ exitCode: 1 }] },
    { name: "runner exception", addOutcomes: [{ throwError: true }] },
    { name: "read failure", readOutcomes: [{ exitCode: 1 }] },
    { name: "empty read-back", addOutcomes: [{ storedValue: "" }] },
    {
      name: "mismatched read-back",
      addOutcomes: [{ storedValue: "mismatch" }],
    },
  ] satisfies Array<{
    name: string;
    addOutcomes?: FakeCommandOutcome[];
    readOutcomes?: FakeCommandOutcome[];
  }>) {
    await t.test(scenario.name, async () => {
      const fake = statefulSecurityRunner(scenario);
      const provider = createMacOSKeychainProvider({
        runner: fake.runner,
        platform: "darwin",
      });

      await assert.rejects(provider.preflight("testnet"), (error: unknown) => {
        assert.ok(error instanceof CredentialProviderError);
        assert.equal(error.code, "preflight-failed");
        assert.match(error.message, /OAuth was not started/);
        assert.doesNotMatch(
          error.message,
          /mismatch|private|connect-preflight-/,
        );
        return true;
      });
      assert.deepEqual(
        fake.calls.map(({ args }) => args[0]),
        [
          "add-generic-password",
          "find-generic-password",
          "delete-generic-password",
        ],
      );
      assert.equal(
        fake.valueFor(
          credentialPreflightServiceName("testnet"),
          credentialPreflightAccount,
        ),
        undefined,
      );
    });
  }
});

test("preflight cleanup failure fails closed after an exact round-trip", async () => {
  const fake = statefulSecurityRunner({
    deleteOutcomes: [{ exitCode: 1, stderr: "private cleanup detail" }],
  });
  const provider = createMacOSKeychainProvider({
    runner: fake.runner,
    platform: "darwin",
  });

  await assert.rejects(provider.preflight("mainnet"), (error: unknown) => {
    assert.ok(error instanceof CredentialProviderError);
    assert.equal(error.code, "preflight-failed");
    assert.match(error.message, /OAuth was not started/);
    assert.doesNotMatch(error.message, /private|connect-preflight-/);
    return true;
  });
  assert.deepEqual(
    fake.calls.map(({ args }) => args[0]),
    [
      "add-generic-password",
      "find-generic-password",
      "delete-generic-password",
    ],
  );
});

test("restore and cleanup never cross environment service identities", async () => {
  const mainnetCredentials = {
    apiKey: "mainnet-old-key",
    apiSecret: "mainnet-old-secret",
    accountId: "mainnet-old-account",
  };
  const fake = statefulSecurityRunner({
    initialItems: [
      { account: "api-key", service: testnetService, value: "testnet-old-key" },
      {
        account: "api-secret",
        service: testnetService,
        value: "testnet-old-secret",
      },
      {
        account: "account-id",
        service: testnetService,
        value: "testnet-old-account",
      },
      {
        account: "api-key",
        service: mainnetService,
        value: mainnetCredentials.apiKey,
      },
      {
        account: "api-secret",
        service: mainnetService,
        value: mainnetCredentials.apiSecret,
      },
      {
        account: "account-id",
        service: mainnetService,
        value: mainnetCredentials.accountId,
      },
    ],
    addOutcomes: [{}, { exitCode: 1 }],
  });
  const provider = createMacOSKeychainProvider({
    runner: fake.runner,
    platform: "darwin",
  });

  await assert.rejects(
    provider.save("testnet", credentials),
    /could not be stored/,
  );

  assert.equal(fake.valueFor(testnetService, "api-key"), "testnet-old-key");
  assert.equal(
    fake.valueFor(testnetService, "api-secret"),
    "testnet-old-secret",
  );
  assert.equal(
    fake.valueFor(testnetService, "account-id"),
    "testnet-old-account",
  );
  assert.equal(
    fake.valueFor(mainnetService, "api-key"),
    mainnetCredentials.apiKey,
  );
  assert.equal(
    fake.valueFor(mainnetService, "api-secret"),
    mainnetCredentials.apiSecret,
  );
  assert.equal(
    fake.valueFor(mainnetService, "account-id"),
    mainnetCredentials.accountId,
  );
  assert.ok(
    fake.calls.every(
      ({ args }) =>
        args[args.indexOf("-s") + 1] === testnetService || !args.includes("-s"),
    ),
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
