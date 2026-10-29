import { randomUUID } from "node:crypto";

import { createMacOSKeychainProvider } from "../adapters/macos-keychain.js";
import { createMacOSHistoryAccountingAnchorKeyProvider } from "../adapters/macos-keychain-history-accounting-anchor-key-provider.js";
import {
  BybitAccountReadError,
  BybitAccountReadTransport,
  type AccountReadBudget,
} from "../adapters/bybit-v5/account-read-transport.js";
import { mapAccountReadIdentity } from "../adapters/bybit-v5/account-key-mapper.js";
import { mapAccountWallet } from "../adapters/bybit-v5/account-read-mappers.js";
import { createSqliteHistoryAccountingWalletAnchorStore } from "../adapters/sqlite/history-accounting-anchor-store.js";
import {
  openSqliteConnection,
  type SqliteConnection,
} from "../adapters/sqlite/connection.js";
import { domainError } from "../domain/shared/errors.js";
import { fail, ok, type Result } from "../domain/shared/result.js";
import { timestampFromEpochMs } from "../domain/shared/time.js";
import type {
  CredentialEnvironment,
  CredentialProvider,
} from "../ports/credential-provider.js";
import type { HistoryAccountingAnchorKeyProvider } from "../ports/history-accounting-anchor-key-provider.js";
import { authenticateWalletAnchorCapture } from "../ports/history-accounting-anchor-capture-provenance.js";
import type { HistoryAccountingWalletAnchor } from "../ports/history-accounting-anchor-store.js";
import { createHistoryAccountingAnchorMac } from "./history-accounting-anchor-authentication.js";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_GET_ATTEMPTS = 10;
const MAX_DURATION_MS = 60_000;

export interface CaptureHistoryAccountingAnchorInput {
  readonly environment: CredentialEnvironment;
  readonly databasePath: string;
  readonly kind: "opening" | "closing";
}

export interface CaptureHistoryAccountingAnchorDependencies {
  readonly credentialProvider?: Pick<CredentialProvider, "load">;
  readonly anchorKeyProvider?: Pick<
    HistoryAccountingAnchorKeyProvider,
    "getOrCreate"
  >;
  readonly request?: typeof fetch;
  readonly utcClock?: () => number;
  readonly monotonicClock?: () => number;
  readonly openConnection?: typeof openSqliteConnection;
  readonly createAnchorId?: () => string;
}

export interface CapturedHistoryAccountingAnchor {
  readonly anchor: HistoryAccountingWalletAnchor;
  readonly getAttempts: number;
}

function safeReadError(error: unknown): string {
  return error instanceof BybitAccountReadError
    ? error.code
    : "ANCHOR_CAPTURE_FAILED";
}

function resultFailure(code: string, reads: number): Result<never> {
  return fail(
    domainError("INVALID_VALUE", `${code}: wallet anchor was not recorded`, {
      exchangeReads: reads,
      exchangeWrites: 0,
    }),
  );
}

function timestamp(value: number) {
  return Number.isSafeInteger(value) && value >= 0
    ? timestampFromEpochMs(value)
    : fail(domainError("INVALID_VALUE", "timestamp is invalid"));
}

/**
 * Capture one immutable wallet anchor through the authenticated GET-only
 * adapter. This function is only called by an explicit CLI operation; it does
 * not grant any exchange-write capability.
 */
export async function captureHistoryAccountingAnchor(
  input: CaptureHistoryAccountingAnchorInput,
  dependencies: CaptureHistoryAccountingAnchorDependencies = {},
): Promise<Result<CapturedHistoryAccountingAnchor>> {
  if (
    !input ||
    !["demo", "testnet", "mainnet"].includes(input.environment) ||
    typeof input.databasePath !== "string" ||
    !input.databasePath.startsWith("/") ||
    input.databasePath.length > 2_048 ||
    /[\u0000-\u001f\u007f]/u.test(input.databasePath) ||
    (input.kind !== "opening" && input.kind !== "closing")
  )
    return resultFailure("INVALID_REQUEST", 0);

  const wall = dependencies.utcClock ?? Date.now;
  const monotonic = dependencies.monotonicClock ?? (() => performance.now());
  const started = monotonic();
  if (!Number.isFinite(started)) return resultFailure("CLOCK_INVALID", 0);
  const budget: AccountReadBudget = {
    deadline: started + MAX_DURATION_MS,
    attempts: 0,
    maxAttempts: MAX_GET_ATTEMPTS,
    maxResponseBytes: MAX_RESPONSE_BYTES,
    maxObservedResponseBytes: 0,
  };
  let connection: SqliteConnection | undefined;
  try {
    const anchorKeyProvider =
      dependencies.anchorKeyProvider ??
      createMacOSHistoryAccountingAnchorKeyProvider();
    const authenticationKey = await anchorKeyProvider.getOrCreate(
      input.environment,
    );
    if (!authenticationKey.ok)
      return resultFailure("ANCHOR_AUTHENTICATOR_UNAVAILABLE", 0);
    const provider =
      dependencies.credentialProvider ?? createMacOSKeychainProvider();
    const credentials = await provider.load(input.environment);
    const bootstrap = new BybitAccountReadTransport({
      environment: input.environment,
      credentials,
      budget,
      ...(dependencies.request === undefined
        ? {}
        : { request: dependencies.request }),
      clock: wall,
      monotonicClock: monotonic,
    });

    const offsetStart = wall();
    const initialServerTimeMs = await bootstrap.readExchangeTime();
    const offsetEnd = wall();
    const clockOffsetMs =
      initialServerTimeMs - Math.round((offsetStart + offsetEnd) / 2);
    if (!Number.isSafeInteger(clockOffsetMs))
      return resultFailure("TIME_OFFSET_UNUSABLE", budget.attempts);

    const transport = new BybitAccountReadTransport({
      environment: input.environment,
      credentials,
      budget,
      ...(dependencies.request === undefined
        ? {}
        : { request: dependencies.request }),
      clock: wall,
      monotonicClock: monotonic,
      clockOffsetMs,
    });

    const providerBeforeMs = await transport.readExchangeTime();
    const identityResponse = await transport.get("/v5/user/query-api");
    if (identityResponse.time === undefined)
      return resultFailure("IDENTITY_PROVIDER_TIME_MISSING", budget.attempts);
    const identityObservedAt = timestamp(identityResponse.time);
    if (!identityObservedAt.ok)
      return resultFailure("IDENTITY_PROVIDER_TIME_INVALID", budget.attempts);
    let identity: ReturnType<typeof mapAccountReadIdentity>;
    try {
      identity = mapAccountReadIdentity(
        identityResponse,
        credentials.accountId,
        input.environment,
        identityObservedAt.value,
      );
    } catch (error) {
      return resultFailure(safeReadError(error), budget.attempts);
    }

    const walletResponse = await transport.get("/v5/account/wallet-balance", {
      accountType: "UNIFIED",
    });
    const providerAfterMs = await transport.readExchangeTime();
    if (walletResponse.time === undefined)
      return resultFailure("WALLET_PROVIDER_TIME_MISSING", budget.attempts);
    if (
      ![providerBeforeMs, walletResponse.time, providerAfterMs].every(
        (value) => Number.isSafeInteger(value) && value > 0,
      ) ||
      providerBeforeMs > identityResponse.time ||
      identityResponse.time > walletResponse.time ||
      providerBeforeMs > walletResponse.time ||
      walletResponse.time > providerAfterMs
    )
      return resultFailure(
        "WALLET_CAPTURE_BOUNDARY_AMBIGUOUS",
        budget.attempts,
      );

    // Use provider timestamps for both ends of the collection interval. This
    // keeps identity/wallet ordering in one clock domain instead of comparing
    // local wall-clock time with Bybit event time.
    const collectionStartedAtMs = providerBeforeMs;
    const collectionEndedAtMs = providerAfterMs;

    let wallet: ReturnType<typeof mapAccountWallet>;
    try {
      wallet = mapAccountWallet(walletResponse);
    } catch (error) {
      return resultFailure(safeReadError(error), budget.attempts);
    }

    const collectionStartedAt = timestamp(collectionStartedAtMs);
    const collectionEndedAt = timestamp(collectionEndedAtMs);
    const providerTimeBefore = timestamp(providerBeforeMs);
    const providerResponseTime = timestamp(walletResponse.time);
    const providerTimeAfter = timestamp(providerAfterMs);
    if (
      !collectionStartedAt.ok ||
      !collectionEndedAt.ok ||
      !providerTimeBefore.ok ||
      !providerResponseTime.ok ||
      !providerTimeAfter.ok
    )
      return resultFailure("WALLET_CAPTURE_TIME_INVALID", budget.attempts);

    const opened = (dependencies.openConnection ?? openSqliteConnection)({
      environment: input.environment,
      databasePath: input.databasePath,
    });
    if (!opened.ok) return resultFailure(opened.error.code, budget.attempts);
    connection = opened.value;
    const store = createSqliteHistoryAccountingWalletAnchorStore(
      connection,
      authenticationKey.value,
    );
    const anchor: Omit<
      HistoryAccountingWalletAnchor,
      "contentHash" | "recordedAt"
    > = {
      schemaVersion: "history-accounting-wallet-anchor/v1",
      anchorId: (dependencies.createAnchorId ?? randomUUID)(),
      kind: input.kind,
      scope: {
        exchange: "bybit",
        environment: input.environment,
        accountId: identity.accountBinding.accountIdentityHash,
      },
      accountBinding: identity.accountBinding,
      credentialPosture: identity.credentialPosture,
      capture: {
        identityEndpoint: "/v5/user/query-api",
        walletEndpoint: "/v5/account/wallet-balance",
        accountType: "UNIFIED",
        identityObservedAt: identityObservedAt.value,
        collectionStartedAt: collectionStartedAt.value,
        collectionEndedAt: collectionEndedAt.value,
        providerTimeBefore: providerTimeBefore.value,
        providerResponseTime: providerResponseTime.value,
        providerTimeAfter: providerTimeAfter.value,
      },
      totals: wallet.totals,
      assets: wallet.assets,
    };
    const captureMac = createHistoryAccountingAnchorMac(
      anchor,
      authenticationKey.value,
    );
    if (!captureMac.ok)
      return resultFailure("ANCHOR_AUTHENTICATION_FAILED", budget.attempts);
    // Only a payload authenticated with the environment's non-SQLite Keychain
    // key can regain the in-process provenance marker after capture or reopen.
    authenticateWalletAnchorCapture(
      anchor,
      captureMac.value,
      authenticationKey.value,
    );
    const appended = store.append({ anchor });
    return appended.ok
      ? ok({ anchor: appended.value, getAttempts: budget.attempts })
      : appended;
  } catch (error) {
    return resultFailure(safeReadError(error), budget.attempts);
  } finally {
    connection?.close();
  }
}
