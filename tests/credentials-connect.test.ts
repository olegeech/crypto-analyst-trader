import assert from "node:assert/strict";
import test from "node:test";

import {
  detectSelectionMode,
  runCredentialsConnectCli,
} from "../scripts/credentials-connect.js";
import { PromptInterruptedError } from "../src/cli/interactive-prompt.js";
import {
  createMacOSKeychainProvider,
  type SecurityCommandResult,
  type SecurityRunner,
} from "../src/adapters/macos-keychain.js";
import {
  AgentConnectError,
  type AgentConnectChoice,
  type AgentConnectClient,
  type AgentConnectSession,
} from "../src/ports/agent-connect.js";
import {
  CredentialProviderError,
  type CredentialProviderWithPreflight,
  type ExchangeCredentials,
} from "../src/ports/credential-provider.js";

const importedCredentials: ExchangeCredentials = {
  apiKey: "imported-api-key",
  apiSecret: "imported-api-secret",
  accountId: "123456",
};

function outputBuffer(): {
  output: { write(message: string): void };
  text: () => string;
} {
  const messages: string[] = [];
  return {
    output: { write: (message) => messages.push(message) },
    text: () => messages.join(""),
  };
}

function runConnect(
  argv: string[],
  dependencies: NonNullable<Parameters<typeof runCredentialsConnectCli>[1]>,
): Promise<number> {
  return runCredentialsConnectCli(argv, {
    selectionMode: "terminal",
    ...dependencies,
  });
}

function providerFor(
  events: string[],
  {
    preflightError,
    loadedCredentials = importedCredentials,
    loadResults,
    loadError,
    removeError,
    saveResults,
  }: {
    preflightError?: CredentialProviderError;
    loadedCredentials?: ExchangeCredentials;
    loadResults?: Array<ExchangeCredentials | CredentialProviderError>;
    loadError?: CredentialProviderError;
    removeError?: Error;
    saveResults?: Array<Error | undefined>;
  } = {},
): CredentialProviderWithPreflight {
  let loadIndex = 0;
  let saveIndex = 0;
  return {
    preflight: async (environment) => {
      events.push(`preflight:${environment}`);
      if (preflightError) throw preflightError;
    },
    load: async (environment) => {
      events.push(`load:${environment}`);
      const result = loadResults?.[loadIndex++];
      if (result instanceof CredentialProviderError) throw result;
      if (result) return result;
      if (loadError) throw loadError;
      return loadedCredentials;
    },
    save: async (environment, credentials) => {
      events.push(`save:${environment}:${credentials.accountId}`);
      const error = saveResults?.[saveIndex++];
      if (error) throw error;
    },
    remove: async (environment) => {
      events.push(`remove:${environment}`);
      if (removeError) throw removeError;
    },
  };
}

function clientFor(
  events: string[],
  accounts: Array<{ accountId: string; displayName: string }>,
  {
    browserChoice,
  }: {
    browserChoice?: (choices: readonly AgentConnectChoice[]) => Promise<string>;
  } = {},
): AgentConnectClient {
  const session: AgentConnectSession = {
    authorizationUrl: "https://testnet.bybit.com/oauth?state=masked",
    port: 9876,
    waitForCallback: async () => {
      events.push("callback");
      return { code: "one-time-code", codeVerifier: "verifier" };
    },
    chooseInBrowser: async (choices) => {
      events.push(
        `browser-choice:${choices.map(({ label }) => label).join("|")}`,
      );
      if (!browserChoice) throw new Error("unexpected browser selection");
      return browserChoice(choices);
    },
    close: () => events.push("close"),
  };
  return {
    createSession: async (environment, options) => {
      events.push(
        `session:${environment}${options?.browserSelection ? ":browser" : ""}`,
      );
      return session;
    },
    exchangeCode: async (_environment, callback) => {
      events.push(`exchange:${callback.code}`);
      return "access-token";
    },
    listAccounts: async (_environment, accessToken) => {
      events.push(`list:${accessToken}`);
      return accounts;
    },
    fetchAccountCredentials: async (_environment, accessToken, selection) => {
      events.push(
        `fetch:${accessToken}:${selection.kind === "create" ? "create" : selection.accountId}`,
      );
      return importedCredentials;
    },
  };
}

test("invalid connect command does not touch Keychain or OAuth", async () => {
  const events: string[] = [];
  const { output, text } = outputBuffer();
  const code = await runConnect(["production"], {
    provider: providerFor(events),
    client: clientFor(events, []),
    prompt: async () => "1",
    output,
  });

  assert.equal(code, 2);
  assert.deepEqual(events, []);
  assert.match(text(), /credentials:connect/);
});

test("successful connect preflights first, requires explicit selection, and verifies the load seam", async () => {
  const events: string[] = [];
  const { output, text } = outputBuffer();
  const code = await runConnect(["testnet"], {
    provider: providerFor(events),
    client: clientFor(events, [
      { accountId: "123456", displayName: "Trading" },
    ]),
    prompt: async () => "1",
    output,
  });

  assert.equal(code, 0);
  assert.deepEqual(events, [
    "preflight:testnet",
    "load:testnet",
    "session:testnet",
    "callback",
    "exchange:one-time-code",
    "list:access-token",
    "fetch:access-token:123456",
    "save:testnet:123456",
    "load:testnet",
    "close",
  ]);
  assert.match(text(), /stored in macOS Keychain/);
  assert.match(text(), /withdrawals unavailable/);
  assert.match(text(), /Project write authority remains disabled/);
  assert.doesNotMatch(
    text(),
    /imported-api-key|imported-api-secret|access-token|one-time-code|123456/,
  );
  assert.match(text(), /127\.0\.0\.1:9876/);
});

test("empty account list waits for an explicit choice and does not auto-create", async () => {
  const events: string[] = [];
  const { output } = outputBuffer();
  const code = await runConnect(["mainnet"], {
    provider: providerFor(events),
    client: clientFor(events, []),
    prompt: async () => "invalid",
    output,
  });

  assert.equal(code, 1);
  assert.deepEqual(events, [
    "preflight:mainnet",
    "load:mainnet",
    "session:mainnet",
    "callback",
    "exchange:one-time-code",
    "list:access-token",
    "close",
  ]);
});

test("create is sent only after the operator explicitly selects it", async () => {
  const events: string[] = [];
  const { output } = outputBuffer();
  const code = await runConnect(["mainnet"], {
    provider: providerFor(events),
    client: clientFor(events, []),
    prompt: async () => "1",
    output,
  });

  assert.equal(code, 0);
  assert.ok(events.includes("fetch:access-token:create"));
});

test("account cap hides create when five AI Subaccounts are listed", async () => {
  const events: string[] = [];
  const { output, text } = outputBuffer();
  const code = await runConnect(["mainnet"], {
    provider: providerFor(events),
    client: clientFor(
      events,
      Array.from({ length: 5 }, (_, index) => ({
        accountId: `account-${index + 1}`,
        displayName: `Trading ${index + 1}`,
      })),
    ),
    prompt: async () => "6",
    output,
  });

  assert.equal(code, 1);
  assert.doesNotMatch(text(), /Create a new AI Subaccount/);
  assert.deepEqual(events, [
    "preflight:mainnet",
    "load:mainnet",
    "session:mainnet",
    "callback",
    "exchange:one-time-code",
    "list:access-token",
    "close",
  ]);
});

test("selection rejects non-exact numeric choices", async () => {
  for (const choice of ["1junk", "1.5"]) {
    const events: string[] = [];
    const { output, text } = outputBuffer();
    const code = await runConnect(["testnet"], {
      provider: providerFor(events),
      client: clientFor(events, [
        { accountId: "123456", displayName: "Trading" },
      ]),
      prompt: async () => choice,
      output,
    });

    assert.equal(code, 1);
    assert.match(text(), /Choose one of the listed AI Subaccount options/);
    assert.deepEqual(events, [
      "preflight:testnet",
      "load:testnet",
      "session:testnet",
      "callback",
      "exchange:one-time-code",
      "list:access-token",
      "close",
    ]);
  }
});

test("connect fails when the load seam returns different credentials", async () => {
  const events: string[] = [];
  const { output, text } = outputBuffer();
  const code = await runConnect(["testnet"], {
    provider: providerFor(events, {
      loadedCredentials: {
        apiKey: "different-api-key",
        apiSecret: importedCredentials.apiSecret,
        accountId: importedCredentials.accountId,
      },
    }),
    client: clientFor(events, [
      { accountId: importedCredentials.accountId, displayName: "Trading" },
    ]),
    prompt: async () => "1",
    output,
  });

  assert.equal(code, 1);
  assert.match(text(), /could not be verified after storage/);
  assert.doesNotMatch(text(), /different-api-key|imported-api-secret/);
  assert.deepEqual(events.slice(-4), [
    "load:testnet",
    "remove:testnet",
    "save:testnet:123456",
    "close",
  ]);
});

test("corrupt prior credentials do not block connect", async () => {
  const events: string[] = [];
  const { output, text } = outputBuffer();
  const code = await runConnect(["testnet"], {
    provider: providerFor(events, {
      loadResults: [
        new CredentialProviderError(
          "invalid",
          "Bybit testnet credentials contain a corrupt value.",
        ),
        importedCredentials,
      ],
    }),
    client: clientFor(events, [
      { accountId: importedCredentials.accountId, displayName: "Trading" },
    ]),
    prompt: async () => "1",
    output,
  });

  assert.equal(code, 0);
  assert.match(text(), /stored in macOS Keychain/);
  assert.deepEqual(events, [
    "preflight:testnet",
    "load:testnet",
    "session:testnet",
    "callback",
    "exchange:one-time-code",
    "list:access-token",
    "fetch:access-token:123456",
    "save:testnet:123456",
    "load:testnet",
    "close",
  ]);
});

test("cleanup failure after storage verification restores prior credentials", async () => {
  const events: string[] = [];
  const { output, text } = outputBuffer();
  const code = await runConnect(["testnet"], {
    provider: providerFor(events, {
      loadResults: [
        importedCredentials,
        {
          apiKey: "different-api-key",
          apiSecret: importedCredentials.apiSecret,
          accountId: importedCredentials.accountId,
        },
      ],
      removeError: new Error("private cleanup detail"),
    }),
    client: clientFor(events, [
      { accountId: importedCredentials.accountId, displayName: "Trading" },
    ]),
    prompt: async () => "1",
    output,
  });

  assert.equal(code, 1);
  assert.match(text(), /could not be verified after storage/);
  assert.doesNotMatch(text(), /Cleanup was incomplete/);
  assert.doesNotMatch(text(), /private cleanup detail|different-api-key/);
  assert.deepEqual(events.slice(-3), [
    "remove:testnet",
    "save:testnet:123456",
    "close",
  ]);
});

test("cleanup failure preserves the original safe failure reason", async () => {
  const events: string[] = [];
  const { output, text } = outputBuffer();
  const code = await runConnect(["testnet"], {
    provider: providerFor(events, {
      loadResults: [
        importedCredentials,
        new CredentialProviderError(
          "command-failed",
          "Bybit testnet credentials could not be loaded. Run credentials:setup:testnet.",
        ),
      ],
      removeError: new Error("private cleanup detail"),
      saveResults: [undefined, new Error("private restore detail")],
    }),
    client: clientFor(events, [
      { accountId: importedCredentials.accountId, displayName: "Trading" },
    ]),
    prompt: async () => "1",
    output,
  });

  assert.equal(code, 1);
  assert.match(text(), /credentials could not be loaded/);
  assert.match(text(), /Cleanup was incomplete/);
  assert.doesNotMatch(text(), /private cleanup detail|imported-api-secret/);
});

test("Keychain preflight failure stops before starting OAuth and redacts details", async () => {
  const events: string[] = [];
  const { output, text } = outputBuffer();
  const code = await runConnect(["testnet"], {
    provider: providerFor(events, {
      preflightError: new CredentialProviderError(
        "preflight-failed",
        "Bybit testnet Keychain preflight failed; OAuth was not started.",
      ),
    }),
    client: clientFor(events, []),
    prompt: async () => "1",
    output,
  });

  assert.equal(code, 1);
  assert.deepEqual(events, ["preflight:testnet"]);
  assert.match(text(), /OAuth was not started/);
  assert.doesNotMatch(text(), /sentinel|private/);
});

test("every Keychain preflight failure branch cleans up before OAuth can start", async (t) => {
  for (const scenario of [
    {
      name: "duplicate exit",
      add: { stdout: "", stderr: "private duplicate", exitCode: 45 },
    },
    {
      name: "other nonzero exit",
      add: { stdout: "", stderr: "private add", exitCode: 1 },
    },
    { name: "add exception", addThrows: true },
    {
      name: "read failure",
      add: { stdout: "", stderr: "", exitCode: 0 },
      read: { stdout: "", stderr: "private read", exitCode: 1 },
    },
    {
      name: "empty read-back",
      add: { stdout: "", stderr: "", exitCode: 0 },
      read: { stdout: "", stderr: "", exitCode: 0 },
    },
    {
      name: "mismatched read-back",
      add: { stdout: "", stderr: "", exitCode: 0 },
      read: { stdout: "different\n", stderr: "", exitCode: 0 },
    },
    {
      name: "cleanup failure",
      add: { stdout: "", stderr: "", exitCode: 0 },
      readMatchesWrite: true,
      delete: { stdout: "", stderr: "private cleanup", exitCode: 1 },
    },
  ] satisfies Array<{
    name: string;
    add?: SecurityCommandResult;
    addThrows?: boolean;
    read?: SecurityCommandResult;
    readMatchesWrite?: boolean;
    delete?: SecurityCommandResult;
  }>) {
    await t.test(scenario.name, async () => {
      const keychainEvents: string[] = [];
      let writtenValue = "";
      const runner: SecurityRunner = async (args, input) => {
        const operation = args[0] ?? "unknown";
        keychainEvents.push(operation);
        if (operation === "add-generic-password") {
          if (scenario.addThrows) throw new Error("private add exception");
          writtenValue = input?.split("\n")[0] ?? "";
          return scenario.add ?? { stdout: "", stderr: "", exitCode: 1 };
        }
        if (operation === "find-generic-password") {
          if (scenario.readMatchesWrite) {
            return { stdout: `${writtenValue}\n`, stderr: "", exitCode: 0 };
          }
          return (
            scenario.read ?? { stdout: "", stderr: "missing", exitCode: 44 }
          );
        }
        if (operation === "delete-generic-password") {
          return scenario.delete ?? { stdout: "", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      };
      const events: string[] = [];
      const { output, text } = outputBuffer();
      const provider = createMacOSKeychainProvider({
        runner,
        platform: "darwin",
      });

      const code = await runConnect(["testnet"], {
        provider,
        client: clientFor(events, []),
        prompt: async () => "1",
        output,
      });

      assert.equal(code, 1);
      assert.deepEqual(keychainEvents, [
        "add-generic-password",
        "find-generic-password",
        "delete-generic-password",
      ]);
      assert.deepEqual(events, []);
      assert.match(text(), /OAuth was not started/);
      assert.doesNotMatch(text(), /private|different|connect-preflight-/);
    });
  }
});

test("unexpected implementation errors use a generic safe CLI message", async () => {
  const events: string[] = [];
  const { output, text } = outputBuffer();
  const failingClient = clientFor(events, []);
  failingClient.createSession = async () => {
    throw new AgentConnectError("transport-failed", "transport failed safely");
  };
  const code = await runConnect(["testnet"], {
    provider: providerFor(events),
    client: failingClient,
    prompt: async () => "1",
    output,
  });

  assert.equal(code, 1);
  assert.match(text(), /transport failed safely/);
  assert.doesNotMatch(text(), /api-key|secret|token/);
});

test("selection mode follows interactive terminal input", () => {
  assert.equal(detectSelectionMode({ isTTY: true }), "terminal");
  assert.equal(detectSelectionMode({ isTTY: false }), "browser");
  assert.equal(detectSelectionMode({}), "browser");
});

test("the selection channel is announced before Keychain preflight", async () => {
  for (const [selectionMode, expected] of [
    ["terminal", /selection: terminal prompt/],
    ["browser", /selection: browser page/],
  ] as const) {
    const events: string[] = [];
    const { output, text } = outputBuffer();
    const code = await runConnect(["testnet"], {
      provider: providerFor(events, {
        preflightError: new CredentialProviderError(
          "preflight-failed",
          "Bybit testnet Keychain preflight failed; OAuth was not started.",
        ),
      }),
      client: clientFor(events, []),
      output,
      selectionMode,
    });

    assert.equal(code, 1);
    assert.deepEqual(events, ["preflight:testnet"]);
    assert.match(text(), expected);
  }
});

test("without terminal input the operator chooses in the browser within the same authorization", async () => {
  const events: string[] = [];
  const { output, text } = outputBuffer();
  let prompted = false;
  const code = await runConnect(["testnet"], {
    provider: providerFor(events),
    client: clientFor(
      events,
      [{ accountId: "123456", displayName: "Trading" }],
      { browserChoice: async () => "1" },
    ),
    prompt: async () => {
      prompted = true;
      return "2";
    },
    output,
    selectionMode: "browser",
  });

  assert.equal(code, 0);
  assert.equal(prompted, false);
  assert.deepEqual(events, [
    "preflight:testnet",
    "load:testnet",
    "session:testnet:browser",
    "callback",
    "exchange:one-time-code",
    "list:access-token",
    "browser-choice:Trading (•••3456)|Create a new AI Subaccount",
    "fetch:access-token:123456",
    "save:testnet:123456",
    "load:testnet",
    "close",
  ]);
  assert.match(text(), /Agent Connect page in the browser/);
  assert.match(text(), /stored in macOS Keychain/);
  assert.doesNotMatch(
    text(),
    /imported-api-key|imported-api-secret|access-token|one-time-code|123456/,
  );
});

test("browser selection never auto-selects and stops cleanly when the wait ends", async () => {
  const events: string[] = [];
  const { output, text } = outputBuffer();
  const code = await runConnect(["testnet"], {
    provider: providerFor(events),
    client: clientFor(
      events,
      [{ accountId: "123456", displayName: "Trading" }],
      {
        browserChoice: async () => {
          throw new AgentConnectError(
            "selection-timeout",
            "AI Subaccount selection timed out; no account was selected or created. Run npm run credentials:connect:testnet again.",
          );
        },
      },
    ),
    output,
    selectionMode: "browser",
  });

  assert.equal(code, 1);
  assert.match(text(), /selection timed out/);
  assert.deepEqual(events.slice(-3), [
    "list:access-token",
    "browser-choice:Trading (•••3456)|Create a new AI Subaccount",
    "close",
  ]);
});

test("selection input failures are reported distinctly before account credentials are requested", async (t) => {
  for (const { name, error, expected } of [
    {
      name: "unavailable input",
      error: new Error("private prompt detail"),
      expected: /selection input is unavailable/,
    },
    {
      name: "timeout",
      error: new PromptInterruptedError("timeout"),
      expected: /selection timed out/,
    },
    {
      name: "cancellation",
      error: new PromptInterruptedError("cancelled"),
      expected: /selection was cancelled/,
    },
  ]) {
    await t.test(name, async () => {
      const events: string[] = [];
      const { output, text } = outputBuffer();
      const code = await runConnect(["testnet"], {
        provider: providerFor(events),
        client: clientFor(events, [
          { accountId: "123456", displayName: "Trading" },
        ]),
        prompt: async () => {
          throw error;
        },
        output,
      });

      assert.equal(code, 1);
      assert.match(text(), expected);
      assert.match(text(), /no account was selected or created/);
      assert.match(text(), /credentials:connect:testnet/);
      assert.doesNotMatch(text(), /onboarding failed|private prompt detail/);
      assert.deepEqual(events.slice(-2), ["list:access-token", "close"]);
    });
  }
});
