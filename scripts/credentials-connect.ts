import { pathToFileURL } from "node:url";
import process from "node:process";

import { createBybitAgentConnectClient } from "../src/adapters/bybit-agent-connect.js";
import { promptVisible as promptVisibleCommon } from "../src/cli/interactive-prompt.js";
import {
  AgentConnectError,
  type AgentConnectAccount,
  type AgentConnectClient,
  type AgentConnectSelection,
  type AgentConnectSession,
} from "../src/ports/agent-connect.js";
import { createMacOSKeychainProvider } from "../src/adapters/macos-keychain.js";
import {
  CredentialProviderError,
  type CredentialEnvironment,
  type CredentialProviderWithPreflight,
  type ExchangeCredentials,
  setupCommand,
} from "../src/ports/credential-provider.js";

type Output = { write(message: string): void };
type Prompt = (label: string) => Promise<string>;
const MAX_AI_SUBACCOUNTS = 5;

function promptVisible(label: string): Promise<string> {
  return promptVisibleCommon(
    label,
    "Interactive Agent Connect requires a terminal.",
  );
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

async function chooseSelection(
  accounts: AgentConnectAccount[],
  prompt: Prompt,
  output: Output,
): Promise<AgentConnectSelection> {
  output.write("Available Bybit AI Subaccounts:\n");
  accounts.forEach((account, index) => {
    output.write(
      `${index + 1}. ${safeAccountName(account.displayName)} (${maskedAccountId(account.accountId)})\n`,
    );
  });
  const canCreate = accounts.length < MAX_AI_SUBACCOUNTS;
  if (canCreate) {
    output.write(`${accounts.length + 1}. Create a new AI Subaccount\n`);
  }

  const answer = (await prompt("Choose an option")).trim();
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
    if (error instanceof CredentialProviderError && error.code === "missing") {
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
  }: {
    provider?: CredentialProviderWithPreflight;
    client?: AgentConnectClient;
    prompt?: Prompt;
    output?: Output;
  } = {},
): Promise<number> {
  const [environmentValue, extra] = argv;
  if (!isEnvironment(environmentValue) || extra !== undefined) {
    output.write(`${usage()}\n`);
    return 2;
  }

  const environment = environmentValue;
  let session: AgentConnectSession | undefined;
  let storageCommitted = false;
  let previousCredentials: ExchangeCredentials | undefined;
  try {
    await provider.preflight(environment);
    session = await client.createSession(environment);
    output.write(
      `Bybit ${environment} Agent Connect authorization URL:\n${session.authorizationUrl}\n`,
    );
    output.write(`Waiting for one callback on 127.0.0.1:${session.port}.\n`);

    const callback = await session.waitForCallback();
    const accessToken = await client.exchangeCode(environment, callback);
    const accounts = await client.listAccounts(environment, accessToken);
    const selection = await chooseSelection(accounts, prompt, output);
    const credentials = await client.fetchAccountCredentials(
      environment,
      accessToken,
      selection,
    );
    previousCredentials = await readPreviousCredentials(provider, environment);
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
