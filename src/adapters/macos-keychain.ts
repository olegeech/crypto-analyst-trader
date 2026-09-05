import { spawn } from "node:child_process";
import process from "node:process";

import {
  credentialAccounts,
  credentialServiceName,
  CredentialProviderError,
  setupCommand,
  type CredentialEnvironment,
  type CredentialProvider,
  type ExchangeCredentials,
} from "../ports/credential-provider.js";

export { CredentialProviderError } from "../ports/credential-provider.js";

const SECURITY_COMMAND = "/usr/bin/security";

export interface SecurityCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type SecurityRunner = (
  args: string[],
  input?: string,
) => Promise<SecurityCommandResult>;

function runSecurity(
  args: string[],
  input?: string,
): Promise<SecurityCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(SECURITY_COMMAND, args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", () => {
      reject(new Error("security command could not be started"));
    });
    child.once("close", (exitCode) => {
      resolve({ stdout, stderr, exitCode: exitCode ?? 1 });
    });

    if (input !== undefined) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}

function isMissing(result: SecurityCommandResult): boolean {
  return /could not be found|no matching items/i.test(result.stderr);
}

function isInaccessible(result: SecurityCommandResult): boolean {
  return /locked|user interaction is not allowed|authorization/i.test(
    result.stderr,
  );
}

function safeCommandError(
  environment: CredentialEnvironment,
  result: SecurityCommandResult,
  operation: "load" | "write" | "remove",
): CredentialProviderError {
  if (isMissing(result) && operation === "load") {
    return new CredentialProviderError(
      "missing",
      `Bybit ${environment} credentials are unavailable. Run ${setupCommand(environment)}.`,
    );
  }
  if (isInaccessible(result)) {
    return new CredentialProviderError(
      "inaccessible",
      `Bybit ${environment} credentials cannot be accessed. Unlock the macOS Keychain and run ${setupCommand(environment)}.`,
    );
  }
  if (operation === "write") {
    return new CredentialProviderError(
      "write-failed",
      `Bybit ${environment} credentials could not be stored. Run ${setupCommand(environment)} again.`,
    );
  }
  if (operation === "remove") {
    return new CredentialProviderError(
      "remove-failed",
      `Bybit ${environment} credentials could not be removed.`,
    );
  }
  return new CredentialProviderError(
    "command-failed",
    `Bybit ${environment} credentials could not be loaded. Run ${setupCommand(environment)}.`,
  );
}

function validateCredentialValue(name: string, value: string): void {
  if (!value || /[\u0000-\u001f\u007f\r\n]/.test(value)) {
    throw new CredentialProviderError(
      "invalid",
      `${name} must be a non-empty single-line value.`,
    );
  }
}

function validateCredentials(credentials: ExchangeCredentials): void {
  validateCredentialValue("API key", credentials.apiKey);
  validateCredentialValue("API secret", credentials.apiSecret);
  validateCredentialValue("Account ID", credentials.accountId);
}

function accountArgs(account: string, service: string): string[] {
  return ["-a", account, "-s", service];
}

async function command(
  runner: SecurityRunner,
  args: string[],
  input: string | undefined,
): Promise<SecurityCommandResult> {
  try {
    return await runner(args, input);
  } catch {
    return { stdout: "", stderr: "", exitCode: 1 };
  }
}

export function createMacOSKeychainProvider({
  platform = process.platform,
  runner = runSecurity,
}: {
  platform?: NodeJS.Platform;
  runner?: SecurityRunner;
} = {}): CredentialProvider {
  function assertSupported(): void {
    if (platform !== "darwin") {
      throw new CredentialProviderError(
        "unsupported",
        "macOS Keychain credentials are supported only on macOS.",
      );
    }
  }

  async function readValue(
    environment: CredentialEnvironment,
    account: string,
  ): Promise<string> {
    const result = await command(
      runner,
      [
        "find-generic-password",
        ...accountArgs(account, credentialServiceName(environment)),
        "-w",
      ],
      undefined,
    );
    if (result.exitCode !== 0) {
      throw safeCommandError(environment, result, "load");
    }
    const value = result.stdout.endsWith("\n")
      ? result.stdout.slice(0, -1).replace(/\r$/, "")
      : result.stdout;
    try {
      validateCredentialValue(account, value);
    } catch {
      throw new CredentialProviderError(
        "invalid",
        `Bybit ${environment} credentials contain an invalid ${account} value. Run ${setupCommand(environment)}.`,
      );
    }
    return value;
  }

  return {
    async load(environment) {
      assertSupported();
      const [apiKey, apiSecret, accountId] = await Promise.all([
        readValue(environment, credentialAccounts.apiKey),
        readValue(environment, credentialAccounts.apiSecret),
        readValue(environment, credentialAccounts.accountId),
      ]);
      return { apiKey, apiSecret, accountId };
    },

    async save(environment, credentials) {
      assertSupported();
      validateCredentials(credentials);
      const service = credentialServiceName(environment);
      const records = [
        [credentialAccounts.apiKey, credentials.apiKey],
        [credentialAccounts.apiSecret, credentials.apiSecret],
        [credentialAccounts.accountId, credentials.accountId],
      ] as const;

      for (const [account, value] of records) {
        const result = await command(
          runner,
          [
            "add-generic-password",
            ...accountArgs(account, service),
            "-w",
            "-U",
          ],
          `${value}\n`,
        );
        if (result.exitCode !== 0) {
          await this.remove(environment);
          throw safeCommandError(environment, result, "write");
        }
      }
    },

    async remove(environment) {
      assertSupported();
      const service = credentialServiceName(environment);
      for (const account of Object.values(credentialAccounts)) {
        const result = await command(
          runner,
          ["delete-generic-password", ...accountArgs(account, service)],
          undefined,
        );
        if (result.exitCode !== 0 && !isMissing(result)) {
          throw safeCommandError(environment, result, "remove");
        }
      }
    },
  };
}
