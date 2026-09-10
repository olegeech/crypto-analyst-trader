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
const SECURITY_COMMAND_TIMEOUT_MS = 30_000;
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

interface SecurityRunOptions {
  timeoutMs?: number;
  spawnProcess?: typeof spawn;
}

export function runSecurity(
  args: string[],
  input?: string,
  {
    timeoutMs = SECURITY_COMMAND_TIMEOUT_MS,
    spawnProcess = spawn,
  }: SecurityRunOptions = {},
): Promise<SecurityCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(SECURITY_COMMAND, args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const effectiveTimeoutMs =
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? timeoutMs
        : SECURITY_COMMAND_TIMEOUT_MS;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        child.kill("SIGKILL");
      } catch {
        // The process may have exited between the timeout and kill attempt.
      }
      reject(new Error("security command timed out"));
    }, effectiveTimeoutMs);

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", () =>
      finish(() => reject(new Error("security command could not be started"))),
    );
    child.once("close", (exitCode) => {
      finish(() => resolve({ stdout, stderr, exitCode: exitCode ?? 1 }));
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

function isValidCredentialValue(value: string): boolean {
  try {
    validateCredentialValue("credential", value);
    return true;
  } catch {
    return false;
  }
}

function valueFromReadResult(result: SecurityCommandResult): string {
  return result.stdout.endsWith("\n")
    ? result.stdout.slice(0, -1).replace(/\r$/, "")
    : result.stdout;
}

type CredentialRecordState =
  | Readonly<{ kind: "present"; value: string }>
  | Readonly<{
      kind: "missing" | "invalid" | "inaccessible" | "unknown";
    }>;

type CredentialSnapshot =
  | Readonly<{
      kind: "complete";
      credentials: Readonly<ExchangeCredentials>;
    }>
  | Readonly<{ kind: "non-restorable" }>;

function credentialRecords(credentials: ExchangeCredentials) {
  return [
    [credentialAccounts.apiKey, credentials.apiKey],
    [credentialAccounts.apiSecret, credentials.apiSecret],
    [credentialAccounts.accountId, credentials.accountId],
  ] as const;
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

  async function readRawValue(
    account: string,
    service: string,
  ): Promise<SecurityCommandResult> {
    return command(
      runner,
      ["find-generic-password", ...accountArgs(account, service), "-w"],
      undefined,
    );
  }

  async function readValue(
    environment: CredentialEnvironment,
    account: string,
  ): Promise<string> {
    const result = await readRawValue(
      account,
      credentialServiceName(environment),
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
    const value = valueFromReadResult(result);
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

  async function writeAndVerifyValue(
    account: string,
    service: string,
    value: string,
  ): Promise<{ addSucceeded: boolean; exactMatch: boolean }> {
    const addResult = await command(
      runner,
      ["add-generic-password", ...accountArgs(account, service), "-U", "-w"],
      `${value}\n${value}\n`,
    );
    const readResult = await readRawValue(account, service);
    if (readResult.exitCode !== 0) {
      return { addSucceeded: addResult.exitCode === 0, exactMatch: false };
    }
    const observedValue = valueFromReadResult(readResult);
    return {
      addSucceeded: addResult.exitCode === 0,
      exactMatch:
        isValidCredentialValue(observedValue) && observedValue === value,
    };
  }

  async function readCredentialStates(
    environment: CredentialEnvironment,
  ): Promise<readonly CredentialRecordState[]> {
    const service = credentialServiceName(environment);
    const states: CredentialRecordState[] = [];
    for (const account of Object.values(credentialAccounts)) {
      const result = await readRawValue(account, service);
      if (isMissing(result)) {
        states.push(Object.freeze({ kind: "missing" }));
        continue;
      }
      if (isInaccessible(result)) {
        states.push(Object.freeze({ kind: "inaccessible" }));
        continue;
      }
      if (result.exitCode !== 0) {
        states.push(Object.freeze({ kind: "unknown" }));
        continue;
      }
      const value = valueFromReadResult(result);
      if (!isValidCredentialValue(value)) {
        states.push(Object.freeze({ kind: "invalid" }));
        continue;
      }
      states.push(Object.freeze({ kind: "present", value }));
    }
    return Object.freeze(states);
  }

  async function snapshotBeforeMutation(
    environment: CredentialEnvironment,
  ): Promise<CredentialSnapshot> {
    const states = await readCredentialStates(environment);
    const fatalState = states.find(
      ({ kind }) => kind === "inaccessible" || kind === "unknown",
    );
    if (fatalState?.kind === "inaccessible") {
      throw new CredentialProviderError(
        "inaccessible",
        `Bybit ${environment} credentials cannot be accessed. Unlock the macOS Keychain and run ${setupCommand(environment)}.`,
      );
    }
    if (fatalState?.kind === "unknown") {
      throw safeCommandError(environment, "load");
    }
    if (states.some(({ kind }) => kind !== "present")) {
      return Object.freeze({ kind: "non-restorable" });
    }
    const [apiKeyState, apiSecretState, accountIdState] = states;
    if (
      apiKeyState?.kind !== "present" ||
      apiSecretState?.kind !== "present" ||
      accountIdState?.kind !== "present"
    ) {
      return Object.freeze({ kind: "non-restorable" });
    }
    return Object.freeze({
      kind: "complete",
      credentials: Object.freeze({
        apiKey: apiKeyState.value,
        apiSecret: apiSecretState.value,
        accountId: accountIdState.value,
      }),
    });
  }

  async function matchesCompleteSnapshot(
    environment: CredentialEnvironment,
    credentials: ExchangeCredentials,
  ): Promise<boolean> {
    const states = await readCredentialStates(environment);
    const records = credentialRecords(credentials);
    return states.every(
      (state, index) =>
        state.kind === "present" && state.value === records[index]?.[1],
    );
  }

  async function restoreCompleteSnapshot(
    environment: CredentialEnvironment,
    credentials: ExchangeCredentials,
  ): Promise<boolean> {
    for (const [account, value] of credentialRecords(credentials)) {
      await writeAndVerifyValue(
        account,
        credentialServiceName(environment),
        value,
      );
    }
    return matchesCompleteSnapshot(environment, credentials);
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

  async function clearAndVerifyAbsent(
    environment: CredentialEnvironment,
  ): Promise<boolean> {
    const removeError = await removeRecords(environment);
    const states = await readCredentialStates(environment);
    return (
      removeError === null && states.every(({ kind }) => kind === "missing")
    );
  }

  async function preflight(environment: CredentialEnvironment): Promise<void> {
    assertSupported();
    const service = credentialPreflightServiceName(environment);
    const sentinel = `connect-preflight-${randomBytes(16).toString("hex")}`;
    let writeVerified = false;
    let cleanupSucceeded = false;
    try {
      const writeResult = await writeAndVerifyValue(
        credentialPreflightAccount,
        service,
        sentinel,
      );
      writeVerified = writeResult.addSucceeded && writeResult.exactMatch;
    } catch {
      writeVerified = false;
    } finally {
      const removeResult = await command(
        runner,
        [
          "delete-generic-password",
          ...accountArgs(credentialPreflightAccount, service),
        ],
        undefined,
      );
      cleanupSucceeded = removeResult.exitCode === 0 || isMissing(removeResult);
    }
    if (!writeVerified || !cleanupSucceeded) {
      throw safePreflightError(environment);
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
    const previous = await snapshotBeforeMutation(environment);

    for (const [account, value] of credentialRecords(credentials)) {
      const result = await writeAndVerifyValue(
        account,
        credentialServiceName(environment),
        value,
      );
      if (!result.addSucceeded || !result.exactMatch) {
        const writeFailure = safeCommandError(environment, "write");
        let restored = false;
        if (previous.kind === "complete") {
          restored = await restoreCompleteSnapshot(
            environment,
            previous.credentials,
          );
        }
        if (restored) {
          throw writeFailure;
        }
        const cleared = await clearAndVerifyAbsent(environment);
        if (!cleared) {
          throw new CredentialProviderError(
            "write-failed",
            `${writeFailure.message} Rollback incomplete; run ${setupCommand(environment)} again.`,
          );
        }
        const recoveryMessage =
          previous.kind === "complete"
            ? `The previous ${environment} credential set could not be restored; the environment was cleared.`
            : `The ${environment} credential set was cleared.`;
        throw new CredentialProviderError(
          "write-failed",
          `${writeFailure.message} ${recoveryMessage} Run ${setupCommand(environment)} again.`,
        );
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
