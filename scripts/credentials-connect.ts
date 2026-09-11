import { pathToFileURL } from "node:url";
import process from "node:process";

import { createBybitAgentConnectClient } from "../src/adapters/bybit-agent-connect.js";
import {
  PromptInterruptedError,
  promptVisible as promptVisibleCommon,
} from "../src/cli/interactive-prompt.js";
import {
  AgentConnectError,
  type AgentConnectAccount,
  type AgentConnectChoice,
  type AgentConnectClient,
  type AgentConnectSelection,
  type AgentConnectSession,
} from "../src/ports/agent-connect.js";
import { createMacOSKeychainProvider } from "../src/adapters/macos-keychain.js";
import {
  connectCommand,
  CredentialProviderError,
  type CredentialEnvironment,
  type CredentialProviderWithPreflight,
  type ExchangeCredentials,
  setupCommand,
} from "../src/ports/credential-provider.js";

type Output = { write(message: string): void };
type Prompt = (label: string) => Promise<string>;
type ChooseOption = (choices: readonly AgentConnectChoice[]) => Promise<string>;
export type SelectionMode = "terminal" | "browser";
const MAX_AI_SUBACCOUNTS = 5;
const SELECTION_TIMEOUT_MS = 300_000;

function promptVisible(label: string): Promise<string> {
  return promptVisibleCommon(
    label,
    "Interactive Agent Connect requires a terminal.",
    { timeoutMs: SELECTION_TIMEOUT_MS },
  );
}

export function detectSelectionMode(
  input: { isTTY?: boolean } = process.stdin,
): SelectionMode {
  return input.isTTY === true ? "terminal" : "browser";
}

function selectionModeNotice(mode: SelectionMode): string {
  return mode === "terminal"
    ? "AI Subaccount selection: terminal prompt after authorization.\n"
    : "AI Subaccount selection: browser page after authorization (no interactive terminal input detected).\n";
}

function isEnvironment(
  value: string | undefined,
): value is CredentialEnvironment {
  return value === "testnet" || value === "mainnet";
}

function usage(): string {
  return "Usage: npm run credentials:connect:<testnet|mainnet>";
}

function maskedAccountId(accountId: string): string {
  return accountId.length > 4 ? `•••${accountId.slice(-4)}` : "•••";
}

function safeAccountName(name: string): string {
  const normalized = name.replace(/[\u0000-\u001f\u007f\r\n]/g, " ").trim();
  return (normalized || "AI Subaccount").slice(0, 80);
}

function selectionInputError(
  error: unknown,
  environment: CredentialEnvironment,
): AgentConnectError {
  if (error instanceof AgentConnectError) {
    return error;
  }
  const retry = `Run ${connectCommand(environment)} again.`;
  if (error instanceof PromptInterruptedError) {
    return error.reason === "timeout"
      ? new AgentConnectError(
          "selection-timeout",
          `AI Subaccount selection timed out; no account was selected or created. ${retry}`,
        )
      : new AgentConnectError(
          "selection-cancelled",
          `AI Subaccount selection was cancelled; no account was selected or created. ${retry}`,
        );
  }
  return new AgentConnectError(
    "selection-unavailable",
    `AI Subaccount selection input is unavailable; no account was selected or created. ${retry} Use an interactive terminal, or an agent shell to choose in the browser.`,
  );
}

async function chooseSelection(
  accounts: AgentConnectAccount[],
  choose: ChooseOption,
  output: Output,
  environment: CredentialEnvironment,
): Promise<AgentConnectSelection> {
  const choices: AgentConnectChoice[] = accounts.map((account, index) => ({
    id: String(index + 1),
    label: `${safeAccountName(account.displayName)} (${maskedAccountId(account.accountId)})`,
  }));
  const canCreate = accounts.length < MAX_AI_SUBACCOUNTS;
  if (canCreate) {
    choices.push({
      id: String(accounts.length + 1),
      label: "Create a new AI Subaccount",
    });
  }
  output.write("Available Bybit AI Subaccounts:\n");
  for (const choice of choices) {
    output.write(`${choice.id}. ${choice.label}\n`);
  }

  let answer: string;
  try {
    answer = (await choose(choices)).trim();
  } catch (error) {
    throw selectionInputError(error, environment);
  }
  if (!/^\d+$/.test(answer)) {
    throw new AgentConnectError(
      "invalid-response",
      "Choose one of the listed AI Subaccount options.",
    );
  }
  const value = Number.parseInt(answer, 10);
  if (Number.isInteger(value) && value >= 1 && value <= accounts.length) {
    const account = accounts[value - 1];
    if (account) {
      return { kind: "existing", accountId: account.accountId };
    }
  }
  if (canCreate && value === accounts.length + 1) {
    return {
      kind: "create",
      existingAccountIds: accounts.map((account) => account.accountId),
    };
  }
  throw new AgentConnectError(
    "invalid-response",
    "Choose one of the listed AI Subaccount options.",
  );
}

function safeErrorMessage(error: unknown): string {
  if (
    error instanceof CredentialProviderError ||
    error instanceof AgentConnectError
  ) {
    return error.message;
  }
  return "Bybit Agent Connect onboarding failed.";
}

async function readPreviousCredentials(
  provider: CredentialProviderWithPreflight,
  environment: CredentialEnvironment,
): Promise<ExchangeCredentials | undefined> {
  try {
    return await provider.load(environment);
  } catch (error) {
    if (
      error instanceof CredentialProviderError &&
      (error.code === "missing" || error.code === "invalid")
    ) {
      return undefined;
    }
    throw error;
  }
}

export async function runCredentialsConnectCli(
  argv: string[],
  {
    provider = createMacOSKeychainProvider(),
    client = createBybitAgentConnectClient(),
    prompt = promptVisible,
    output = process.stdout,
    selectionMode = detectSelectionMode(),
  }: {
    provider?: CredentialProviderWithPreflight;
    client?: AgentConnectClient;
    prompt?: Prompt;
    output?: Output;
    selectionMode?: SelectionMode;
  } = {},
): Promise<number> {
  const [environmentValue, extra] = argv;
  if (!isEnvironment(environmentValue) || extra !== undefined) {
    output.write(`${usage()}\n`);
    return 2;
  }

  const environment = environmentValue;
  // Announce how the account will be chosen before any side effect, so an
  // unsuitable invocation can be stopped before browser authorization.
  output.write(selectionModeNotice(selectionMode));
  let session: AgentConnectSession | undefined;
  let storageCommitted = false;
  let previousCredentials: ExchangeCredentials | undefined;
  try {
    await provider.preflight(environment);
    previousCredentials = await readPreviousCredentials(provider, environment);
    session = await client.createSession(environment, {
      browserSelection: selectionMode === "browser",
    });
    const activeSession = session;
    output.write(
      `Bybit ${environment} Agent Connect authorization URL:\n${session.authorizationUrl}\n`,
    );
    output.write(`Waiting for one callback on 127.0.0.1:${session.port}.\n`);

    const callback = await session.waitForCallback();
    const accessToken = await client.exchangeCode(environment, callback);
    const accounts = await client.listAccounts(environment, accessToken);
    const choose: ChooseOption =
      selectionMode === "terminal"
        ? () => prompt("Choose an option")
        : (choices) => {
            output.write(
              "Choose an option on the Agent Connect page in the browser used for authorization.\n",
            );
            return activeSession.chooseInBrowser(choices);
          };
    const selection = await chooseSelection(
      accounts,
      choose,
      output,
      environment,
    );
    const credentials = await client.fetchAccountCredentials(
      environment,
      accessToken,
      selection,
    );
    await provider.save(environment, credentials);
    storageCommitted = true;
    const loadedCredentials = await provider.load(environment);
    if (
      loadedCredentials.apiKey !== credentials.apiKey ||
      loadedCredentials.apiSecret !== credentials.apiSecret ||
      loadedCredentials.accountId !== credentials.accountId
    ) {
      throw new CredentialProviderError(
        "invalid",
        `Bybit ${environment} credentials could not be verified after storage.`,
      );
    }

    output.write(
      `Bybit ${environment} AI Subaccount credentials were stored in macOS Keychain.\n`,
    );
    output.write(
      "Capabilities: withdrawals unavailable; managed transfers are not requested; configure IP allowlist on Bybit if supported before #31.\n",
    );
    output.write(
      "Project write authority remains disabled until the separate #31 canary gate.\n",
    );
    return 0;
  } catch (error) {
    let failure = error;
    if (storageCommitted) {
      let cleanupFailed = false;
      try {
        await provider.remove(environment);
      } catch {
        cleanupFailed = true;
      }
      if (previousCredentials) {
        try {
          await provider.save(environment, previousCredentials);
          cleanupFailed = false;
        } catch {
          cleanupFailed = true;
        }
      }
      if (cleanupFailed) {
        failure = new CredentialProviderError(
          "write-failed",
          `${safeErrorMessage(error)} Cleanup was incomplete. Run ${setupCommand(environment)} again.`,
        );
      }
    }
    output.write(`${safeErrorMessage(failure)}\n`);
    return 1;
  } finally {
    session?.close();
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = await runCredentialsConnectCli(process.argv.slice(2));
}
