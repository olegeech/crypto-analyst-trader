import {
  SecurityCommandTimeoutError,
  runSecurity,
  type SecurityCommandResult,
  type SecurityRunner,
} from "./macos-keychain-command.js";
import type {
  SecretIdentity,
  SecretProvider,
  SecretReadResult,
  SecretUnavailableReason,
} from "../ports/secret-provider.js";

const KEYCHAIN_ITEM_NOT_FOUND_EXIT_CODE = 44;
const KEYCHAIN_INTERACTION_REQUIRED_EXIT_CODE = 36;
const SECRET_SERVICE_PREFIX = "com.crypto-analyst-trader.provider";
const SAFE_IDENTITY = /^[a-z][a-z0-9-]{0,47}$/u;

function unavailable(reason: SecretUnavailableReason): SecretReadResult {
  return Object.freeze({ kind: "unavailable", reason });
}

function safeIdentity(identity: SecretIdentity): boolean {
  return (
    typeof identity === "object" &&
    identity !== null &&
    typeof identity.provider === "string" &&
    typeof identity.credential === "string" &&
    SAFE_IDENTITY.test(identity.provider) &&
    SAFE_IDENTITY.test(identity.credential)
  );
}

function secretFromStdout(stdout: string): string | undefined {
  const secret = stdout.endsWith("\n")
    ? stdout.slice(0, -1).replace(/\r$/u, "")
    : stdout;
  if (!secret || /[\u0000-\u001f\u007f]/u.test(secret)) return undefined;
  return secret;
}

function unavailableForCommandError(error: unknown): SecretReadResult {
  return unavailable(
    error instanceof SecurityCommandTimeoutError ? "timeout" : "command-failed",
  );
}

export interface MacOSKeychainSecretProviderOptions {
  readonly platform?: NodeJS.Platform;
  readonly runner?: SecurityRunner;
}

export function createMacOSKeychainSecretProvider({
  platform = process.platform,
  runner = runSecurity,
}: MacOSKeychainSecretProviderOptions = {}): SecretProvider {
  return Object.freeze({
    async read(identity: SecretIdentity): Promise<SecretReadResult> {
      if (!safeIdentity(identity)) return unavailable("invalid-identity");
      if (platform !== "darwin") return unavailable("unsupported-platform");

      const service = `${SECRET_SERVICE_PREFIX}.${identity.provider}`;
      let result: SecurityCommandResult;
      try {
        result = await runner(
          [
            "find-generic-password",
            "-a",
            identity.credential,
            "-s",
            service,
            "-w",
          ],
          undefined,
        );
      } catch (error) {
        return unavailableForCommandError(error);
      }

      if (result.failure === "timeout") return unavailable("timeout");
      if (result.exitCode === KEYCHAIN_ITEM_NOT_FOUND_EXIT_CODE) {
        return unavailable("missing");
      }
      if (result.exitCode === KEYCHAIN_INTERACTION_REQUIRED_EXIT_CODE) {
        return unavailable("inaccessible");
      }
      if (result.exitCode !== 0) return unavailable("command-failed");

      const secret = secretFromStdout(result.stdout);
      return secret === undefined
        ? unavailable("invalid-secret")
        : Object.freeze({ kind: "available", secret });
    },
  });
}
