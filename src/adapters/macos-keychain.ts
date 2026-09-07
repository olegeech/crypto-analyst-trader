import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import process from "node:process";

import {
  credentialAccounts,
  credentialPreflightAccount,
  credentialPreflightServiceName,
  credentialServiceName,
  CredentialProviderError,
  setupCommand,
  type CredentialEnvironment,
  type CredentialProviderWithPreflight,
  type ExchangeCredentials,
} from "../ports/credential-provider.js";

export { CredentialProviderError } from "../ports/credential-provider.js";

const SECURITY_COMMAND = "/usr/bin/security";
const SECURITY_ITEM_NOT_FOUND_EXIT_CODE = 44;
const SECURITY_INTERACTION_REQUIRED_EXIT_CODE = 36;

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
  return result.exitCode === SECURITY_ITEM_NOT_FOUND_EXIT_CODE;
}

function isInaccessible(result: SecurityCommandResult): boolean {
  return result.exitCode === SECURITY_INTERACTION_REQUIRED_EXIT_CODE;
}

function safeCommandError(
  environment: CredentialEnvironment,
  operation: "load" | "write" | "remove",
): CredentialProviderError {
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

function safePreflightError(
  environment: CredentialEnvironment,
): CredentialProviderError {
  return new CredentialProviderError(
    "preflight-failed",
    `Bybit ${environment} Keychain preflight failed; OAuth was not started.`,
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
} = {}): CredentialProviderWithPreflight {
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
      if (isMissing(result)) {
        throw new CredentialProviderError(
          "missing",
          `Bybit ${environment} credentials are unavailable. Run ${setupCommand(environment)}.`,
        );
      }
      if (isInaccessible(result)) {
        throw new CredentialProviderError(
          "inaccessible",
          `Bybit ${environment} credentials cannot be accessed. Unlock the macOS Keychain and run ${setupCommand(environment)}.`,
        );
      }
      throw safeCommandError(environment, "load");
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

  async function storeValue(
    environment: CredentialEnvironment,
    account: string,
    value: string,
  ): Promise<SecurityCommandResult> {
    return command(
      runner,
      [
        "add-generic-password",
        ...accountArgs(account, credentialServiceName(environment)),
        "-w",
        "-U",
      ],
      `${value}\n`,
    );
  }

  async function readExisting(
    environment: CredentialEnvironment,
  ): Promise<ExchangeCredentials | null> {
    const values: string[] = [];
    for (const account of Object.values(credentialAccounts)) {
      try {
        values.push(await readValue(environment, account));
      } catch (error) {
        if (
          error instanceof CredentialProviderError &&
          error.code === "missing"
        ) {
          return null;
        }
        throw error;
      }
    }
    const [apiKey, apiSecret, accountId] = values;
    if (
      apiKey === undefined ||
      apiSecret === undefined ||
      accountId === undefined
    ) {
      return null;
    }
    return { apiKey, apiSecret, accountId };
  }

  async function restore(
    environment: CredentialEnvironment,
    credentials: ExchangeCredentials,
  ): Promise<boolean> {
    let complete = true;
    const records = [
      [credentialAccounts.apiKey, credentials.apiKey],
      [credentialAccounts.apiSecret, credentials.apiSecret],
      [credentialAccounts.accountId, credentials.accountId],
    ] as const;
    for (const [account, value] of records) {
      const result = await storeValue(environment, account, value);
      if (result.exitCode !== 0) {
        complete = false;
      }
    }
    return complete;
  }

  async function removeRecords(
    environment: CredentialEnvironment,
  ): Promise<CredentialProviderError | null> {
    let firstError: CredentialProviderError | null = null;
    const service = credentialServiceName(environment);
    for (const account of Object.values(credentialAccounts)) {
      const result = await command(
        runner,
        ["delete-generic-password", ...accountArgs(account, service)],
        undefined,
      );
      if (result.exitCode !== 0 && !isMissing(result) && firstError === null) {
        firstError = safeCommandError(environment, "remove");
      }
    }
    return firstError;
  }

  async function preflight(environment: CredentialEnvironment): Promise<void> {
    assertSupported();
    const service = credentialPreflightServiceName(environment);
    const sentinel = `connect-preflight-${randomBytes(16).toString("hex")}`;
    const writeResult = await command(
      runner,
      [
        "add-generic-password",
        "-a",
        credentialPreflightAccount,
        "-s",
        service,
        "-w",
        "-U",
      ],
      `${sentinel}\n`,
    );
    if (writeResult.exitCode !== 0) {
      throw safePreflightError(environment);
    }

    let failure: CredentialProviderError | null = null;
    const readResult = await command(
      runner,
      [
        "find-generic-password",
        "-a",
        credentialPreflightAccount,
        "-s",
        service,
        "-w",
      ],
      undefined,
    );
    const readValue = readResult.stdout.endsWith("\n")
      ? readResult.stdout.slice(0, -1).replace(/\r$/, "")
      : readResult.stdout;
    if (readResult.exitCode !== 0 || readValue !== sentinel) {
      failure = safePreflightError(environment);
    }

    const removeResult = await command(
      runner,
      [
        "delete-generic-password",
        "-a",
        credentialPreflightAccount,
        "-s",
        service,
      ],
      undefined,
    );
    if (
      removeResult.exitCode !== 0 &&
      !isMissing(removeResult) &&
      failure === null
    ) {
      failure = safePreflightError(environment);
    }
    if (failure) {
      throw failure;
    }
  }

  async function load(
    environment: CredentialEnvironment,
  ): Promise<ExchangeCredentials> {
    assertSupported();
    const apiKey = await readValue(environment, credentialAccounts.apiKey);
    const apiSecret = await readValue(
      environment,
      credentialAccounts.apiSecret,
    );
    const accountId = await readValue(
      environment,
      credentialAccounts.accountId,
    );
    return { apiKey, apiSecret, accountId };
  }

  async function save(
    environment: CredentialEnvironment,
    credentials: ExchangeCredentials,
  ): Promise<void> {
    assertSupported();
    validateCredentials(credentials);
    const previous = await readExisting(environment);
    const records = [
      [credentialAccounts.apiKey, credentials.apiKey],
      [credentialAccounts.apiSecret, credentials.apiSecret],
      [credentialAccounts.accountId, credentials.accountId],
    ] as const;

    for (const [account, value] of records) {
      const result = await storeValue(environment, account, value);
      if (result.exitCode !== 0) {
        const writeFailure = safeCommandError(environment, "write");
        const rollbackComplete = previous
          ? await restore(environment, previous)
          : (await removeRecords(environment)) === null;
        if (!rollbackComplete) {
          throw new CredentialProviderError(
            "write-failed",
            `${writeFailure.message} Rollback incomplete; run ${setupCommand(environment)} again.`,
          );
        }
        throw writeFailure;
      }
    }
  }

  async function remove(environment: CredentialEnvironment): Promise<void> {
    assertSupported();
    const error = await removeRecords(environment);
    if (error) {
      throw error;
    }
  }

  return { load, save, remove, preflight };
}
