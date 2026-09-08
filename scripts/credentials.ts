import { pathToFileURL } from "node:url";
import process from "node:process";

import { createMacOSKeychainProvider } from "../src/adapters/macos-keychain.js";
import { promptVisible as promptVisibleCommon } from "../src/cli/interactive-prompt.js";
import {
  CredentialProviderError,
  type CredentialEnvironment,
  type CredentialProvider,
} from "../src/ports/credential-provider.js";

type Output = { write(message: string): void };
type Prompt = (label: string, hidden: boolean) => Promise<string>;

function promptVisible(label: string): Promise<string> {
  return promptVisibleCommon(
    label,
    "Interactive credential setup requires a terminal.",
  );
}

function isEnvironment(
  value: string | undefined,
): value is CredentialEnvironment {
  return value === "testnet" || value === "mainnet";
}

function usage(): string {
  return "Usage: npm run credentials:setup:<testnet|mainnet> or npm run credentials:remove:<testnet|mainnet>";
}

function promptHidden(label: string): Promise<string> {
  const input = process.stdin;
  const output = process.stdout;
  if (!input.isTTY || !input.setRawMode) {
    throw new Error("Secret input requires an interactive terminal.");
  }
  return new Promise((resolve, reject) => {
    let value = "";
    const onData = (chunk: Buffer) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003") {
          cleanup();
          reject(new Error("Credential setup cancelled."));
        } else if (character === "\r" || character === "\n") {
          cleanup();
          output.write("\n");
          resolve(value);
        } else if (character === "\u007f") {
          value = value.slice(0, -1);
        } else if (character >= " ") {
          value += character;
        }
      }
    };
    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode?.(false);
      input.pause();
    };
    output.write(`${label}: `);
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

async function promptDefault(label: string, hidden: boolean): Promise<string> {
  return hidden ? promptHidden(label) : promptVisible(label);
}

export async function runCredentialsCli(
  argv: string[],
  {
    provider = createMacOSKeychainProvider(),
    prompt = promptDefault,
    output = process.stdout,
  }: {
    provider?: CredentialProvider;
    prompt?: Prompt;
    output?: Output;
  } = {},
): Promise<number> {
  const [operation, environmentValue, extra] = argv;
  if (
    (operation !== "setup" && operation !== "remove") ||
    !isEnvironment(environmentValue) ||
    extra !== undefined
  ) {
    output.write(`${usage()}\n`);
    return 2;
  }

  const environment = environmentValue;
  try {
    if (operation === "setup") {
      const apiKey = await prompt("Bybit API key", true);
      const apiSecret = await prompt("Bybit API secret", true);
      const accountId = await prompt("Bybit account/subaccount ID", true);
      await provider.save(environment, { apiKey, apiSecret, accountId });
      output.write(
        `Stored Bybit ${environment} credentials in macOS Keychain.\n`,
      );
    } else {
      await provider.remove(environment);
      output.write(
        `Removed Bybit ${environment} credentials from macOS Keychain.\n`,
      );
    }
    return 0;
  } catch (error) {
    const message =
      error instanceof CredentialProviderError || error instanceof Error
        ? error.message
        : "Credential operation failed.";
    output.write(`${message}\n`);
    return 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = await runCredentialsCli(process.argv.slice(2));
}
