import { randomBytes } from "node:crypto";

import { domainError } from "../domain/shared/errors.js";
import { fail, ok, type Result } from "../domain/shared/result.js";
import type { CredentialEnvironment } from "../ports/credential-provider.js";
import type { HistoryAccountingAnchorKeyProvider } from "../ports/history-accounting-anchor-key-provider.js";
import {
  runSecurity,
  type SecurityCommandResult,
  type SecurityRunner,
} from "./macos-keychain-command.js";

const ACCOUNT = "wallet-anchor-authentication-v1";
const SERVICE_PREFIX = "com.crypto-analyst-trader.accounting";
const KEYCHAIN_ITEM_NOT_FOUND_EXIT_CODE = 44;

function service(environment: CredentialEnvironment): string {
  return `${SERVICE_PREFIX}.${environment}`;
}

function unavailable(): Result<never> {
  return fail(
    domainError(
      "PERSISTENCE_INTEGRITY",
      "local wallet-anchor authentication key is unavailable",
    ),
  );
}

function parseKey(stdout: string): Uint8Array | undefined {
  const value = stdout.endsWith("\n")
    ? stdout.slice(0, -1).replace(/\r$/u, "")
    : stdout;
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) return undefined;
  const key = Buffer.from(value, "base64url");
  return key.byteLength === 32 && key.toString("base64url") === value
    ? key
    : undefined;
}

export interface MacOSHistoryAccountingAnchorKeyProviderOptions {
  readonly platform?: NodeJS.Platform;
  readonly runner?: SecurityRunner;
  readonly createKey?: () => Uint8Array;
}

/**
 * Keep the HMAC key in the macOS Keychain, outside the SQLite journal. The
 * per-environment item is created only by explicit anchor capture; reading an
 * existing anchor or validating a report never creates or rotates the key.
 */
export function createMacOSHistoryAccountingAnchorKeyProvider({
  platform = process.platform,
  runner = runSecurity,
  createKey = () => randomBytes(32),
}: MacOSHistoryAccountingAnchorKeyProviderOptions = {}): HistoryAccountingAnchorKeyProvider {
  type ReadResult =
    | { readonly kind: "found"; readonly key: Uint8Array }
    | { readonly kind: "missing" }
    | { readonly kind: "failed" };

  async function run(
    args: string[],
    input?: string,
  ): Promise<SecurityCommandResult> {
    try {
      return await runner(args, input);
    } catch {
      return { stdout: "", stderr: "", exitCode: 1 };
    }
  }

  async function lookup(
    environment: CredentialEnvironment,
  ): Promise<ReadResult> {
    if (platform !== "darwin") return { kind: "failed" };
    const result = await run([
      "find-generic-password",
      "-a",
      ACCOUNT,
      "-s",
      service(environment),
      "-w",
    ]);
    if (result.exitCode === KEYCHAIN_ITEM_NOT_FOUND_EXIT_CODE)
      return { kind: "missing" };
    if (result.exitCode !== 0) return { kind: "failed" };
    const key = parseKey(result.stdout);
    return key === undefined ? { kind: "failed" } : { kind: "found", key };
  }

  async function read(
    environment: CredentialEnvironment,
  ): Promise<Result<Uint8Array>> {
    const result = await lookup(environment);
    return result.kind === "found" ? ok(result.key) : unavailable();
  }

  return Object.freeze({
    read,
    async getOrCreate(
      environment: CredentialEnvironment,
    ): Promise<Result<Uint8Array>> {
      const existing = await lookup(environment);
      if (existing.kind === "found") return ok(existing.key);
      // Do not attempt to replace an inaccessible, malformed or otherwise
      // unreadable item. Only the Keychain's explicit not-found response may
      // establish a new authenticator.
      if (existing.kind !== "missing") return unavailable();
      if (platform !== "darwin") return unavailable();
      const candidate = createKey();
      if (!(candidate instanceof Uint8Array) || candidate.byteLength !== 32)
        return unavailable();
      const value = Buffer.from(candidate).toString("base64url");
      const added = await run(
        [
          "add-generic-password",
          "-a",
          ACCOUNT,
          "-s",
          service(environment),
          "-w",
        ],
        `${value}\n${value}\n`,
      );
      // Another capture may have created the non-overwritable item first. Use
      // the value Keychain actually retained; never rotate a stored key here.
      const stored = await lookup(environment);
      if (stored.kind !== "found") return unavailable();
      if (
        added.exitCode === 0 &&
        !Buffer.from(stored.key).equals(Buffer.from(candidate))
      )
        return unavailable();
      return ok(stored.key);
    },
  });
}
