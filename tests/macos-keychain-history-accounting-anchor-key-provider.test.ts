import assert from "node:assert/strict";
import test from "node:test";

import { createMacOSHistoryAccountingAnchorKeyProvider } from "../src/adapters/macos-keychain-history-accounting-anchor-key-provider.js";
import type { SecurityCommandResult } from "../src/adapters/macos-keychain-command.js";

function missing(): SecurityCommandResult {
  return { stdout: "", stderr: "", exitCode: 44 };
}

test("explicit capture creates one non-overwritable Keychain authenticator", async () => {
  let item: string | undefined;
  const commands: string[][] = [];
  const candidate = new Uint8Array(32).fill(0x6a);
  const provider = createMacOSHistoryAccountingAnchorKeyProvider({
    platform: "darwin",
    createKey: () => candidate,
    runner: async (args, input) => {
      commands.push(args);
      if (args[0] === "find-generic-password")
        return item === undefined
          ? missing()
          : { stdout: `${item}\n`, stderr: "", exitCode: 0 };
      assert.equal(args[0], "add-generic-password");
      assert.equal(args.includes("-U"), false);
      assert.equal(
        input?.split("\n")[0],
        Buffer.from(candidate).toString("base64url"),
      );
      item ??= input?.split("\n")[0];
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  });

  const created = await provider.getOrCreate("demo");
  assert.equal(created.ok, true);
  assert.equal(
    created.ok && Buffer.from(created.value).equals(Buffer.from(candidate)),
    true,
  );
  assert.equal(
    commands.filter(([command]) => command === "add-generic-password").length,
    1,
  );

  const existing = await provider.getOrCreate("demo");
  assert.equal(existing.ok, true);
  assert.equal(
    existing.ok && Buffer.from(existing.value).equals(Buffer.from(candidate)),
    true,
  );
  assert.equal(
    commands.filter(([command]) => command === "add-generic-password").length,
    1,
  );
});

test("inaccessible or malformed Keychain items are never replaced", async () => {
  for (const response of [
    { stdout: "", stderr: "", exitCode: 36 },
    { stdout: "not-a-valid-key", stderr: "", exitCode: 0 },
  ]) {
    const commands: string[][] = [];
    const provider = createMacOSHistoryAccountingAnchorKeyProvider({
      platform: "darwin",
      runner: async (args) => {
        commands.push(args);
        return args[0] === "find-generic-password" ? response : missing();
      },
    });

    const result = await provider.getOrCreate("mainnet");
    assert.equal(result.ok, false);
    assert.equal(
      commands.some(([command]) => command === "add-generic-password"),
      false,
    );
  }
});

test("a missing authenticator is not created on unsupported platforms", async () => {
  let commands = 0;
  const provider = createMacOSHistoryAccountingAnchorKeyProvider({
    platform: "linux",
    runner: async () => {
      commands += 1;
      return missing();
    },
  });

  const result = await provider.getOrCreate("demo");
  assert.equal(result.ok, false);
  assert.equal(commands, 0);
});
