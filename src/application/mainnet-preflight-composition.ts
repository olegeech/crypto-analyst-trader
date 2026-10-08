import { randomUUID } from "node:crypto";
import { createMacOSKeychainProvider } from "../adapters/macos-keychain.js";
import {
  BybitAccountReadError,
  BybitAccountReadTransport,
  type AccountReadBudget,
} from "../adapters/bybit-v5/account-read-transport.js";
import { BybitAccountReadClient } from "../adapters/bybit-v5/account-read-client.js";
import {
  BybitMainnetReadCapabilityError,
  BybitMainnetReadCapabilityFacade,
} from "../adapters/bybit-v5/read-capability-facade.js";
import type { BybitInstrumentInfo } from "../adapters/bybit-v5/read-mappers.js";
import type { AccountEvidenceCollectionResult } from "../domain/account/account-evidence-bundle.js";
import type { AccountEvidenceFailureCode } from "../domain/account/account-evidence-diagnostics.js";
import { MARKET_EVIDENCE_SYMBOLS } from "../domain/market/market-evidence-bundle.js";
import { timestampFromEpochMs } from "../domain/shared/time.js";
import { isPlanningSymbol } from "../domain/planning/decision-policy.js";
import type {
  CredentialEnvironment,
  CredentialProvider,
  ExchangeCredentials,
} from "../ports/credential-provider.js";
import type { AccountEvidenceReadPort } from "../ports/account-evidence.js";
import { collectAccountEvidence } from "./account-evidence-collection.js";
import {
  deriveMainnetExecutionReadiness,
  type MainnetExecutionReadiness,
} from "./mainnet-execution-readiness.js";

export interface MainnetPreflightRequestCounts {
  readonly exchangeReads: number;
  /** Non-GET attempts are rejected before reaching fetch and must remain zero. */
  readonly exchangeWrites: number;
}

export interface MainnetPreflightAssessment {
  readonly kind: "assessment";
  readonly readiness: MainnetExecutionReadiness;
  readonly requestCounts: MainnetPreflightRequestCounts;
  readonly instrumentProviderReasonCode?: AccountEvidenceFailureCode;
}

export interface MainnetPreflightFailure {
  readonly kind: "failure";
  readonly reasonCode:
    | "INVALID_SYMBOL"
    | "NON_GET_REQUEST_BLOCKED"
    | "PREFLIGHT_FAILED"
    | "PROVIDER_TIME_UNAVAILABLE";
  readonly requestCounts: MainnetPreflightRequestCounts;
}

export type MainnetPreflightResult =
  MainnetPreflightAssessment | MainnetPreflightFailure;

export interface MainnetPreflightDependencies {
  readonly credentialProvider?: Pick<CredentialProvider, "load">;
  readonly request?: typeof fetch;
  readonly utcClock?: () => number;
  readonly monotonicClock?: () => number;
  readonly runId?: string;
  /** Test seam for the account evidence reader; the released CLI never sets it. */
  readonly createAccountReadPort?: (options: {
    readonly environment: "mainnet";
    readonly credentials: ExchangeCredentials;
    readonly budget: AccountReadBudget;
    readonly utcClock: () => number;
    readonly monotonicClock: () => number;
    readonly request: typeof fetch;
  }) => AccountEvidenceReadPort;
}

function requestCounter() {
  let exchangeReads = 0;
  let exchangeWrites = 0;
  return {
    get counts(): MainnetPreflightRequestCounts {
      return Object.freeze({ exchangeReads, exchangeWrites });
    },
    wrap(request: typeof fetch): typeof fetch {
      return async (input, init) => {
        const requestMethod =
          typeof Request !== "undefined" && input instanceof Request
            ? input.method
            : "GET";
        const method = (init?.method ?? requestMethod).toUpperCase();
        if (method === "GET") exchangeReads++;
        else {
          exchangeWrites++;
          throw new Error("Mainnet preflight permits GET only.");
        }
        return request(input, init);
      };
    },
  };
}

function instrumentProviderFailureCode(
  error: unknown,
): AccountEvidenceFailureCode {
  if (error instanceof BybitAccountReadError) return error.code;
  if (error instanceof BybitMainnetReadCapabilityError) {
    switch (error.code) {
      case "ORIGIN_MISMATCH":
        return "ORIGIN_MISMATCH";
      case "UNSUPPORTED_INSTRUMENT":
        return "UNSUPPORTED_CAPABILITY";
      case "INVALID_REQUEST":
      case "INVALID_RESPONSE":
        return "INVALID_RESPONSE";
    }
  }
  return "TRANSPORT_FAILED";
}

function snapshotCredentials(
  credentials: ExchangeCredentials,
): Readonly<ExchangeCredentials> {
  return Object.freeze({
    apiKey: credentials.apiKey,
    apiSecret: credentials.apiSecret,
    accountId: credentials.accountId,
  });
}

function failed(
  reasonCode: MainnetPreflightFailure["reasonCode"],
  requestCounts: MainnetPreflightRequestCounts,
): MainnetPreflightFailure {
  return Object.freeze({ kind: "failure", reasonCode, requestCounts });
}

/**
 * Application-owned Mainnet read-only composition. This does not import the
 * private execution transport or any order-mutation adapter.
 */
export async function runMainnetPreflight(
  symbol: string,
  dependencies: MainnetPreflightDependencies = {},
): Promise<MainnetPreflightResult> {
  const counter = requestCounter();
  if (!isPlanningSymbol(symbol))
    return failed("INVALID_SYMBOL", counter.counts);

  const wall = dependencies.utcClock ?? Date.now;
  const monotonic = dependencies.monotonicClock ?? (() => performance.now());
  const countedRequest = counter.wrap(dependencies.request ?? fetch);
  const provider =
    dependencies.credentialProvider ?? createMacOSKeychainProvider();
  let credentialSnapshot: Readonly<ExchangeCredentials> | undefined;
  let sharedBudget: AccountReadBudget | undefined;
  const credentialLoader: Pick<CredentialProvider, "load"> = {
    load: async (environment: CredentialEnvironment) => {
      if (environment !== "mainnet") throw new Error("Environment mismatch.");
      if (credentialSnapshot) return credentialSnapshot;
      credentialSnapshot = snapshotCredentials(await provider.load("mainnet"));
      return credentialSnapshot;
    },
  };

  let accountResult: AccountEvidenceCollectionResult;
  try {
    accountResult = await collectAccountEvidence({
      environment: "mainnet",
      runId: dependencies.runId ?? randomUUID(),
      configuredM1Symbols: [...MARKET_EVIDENCE_SYMBOLS],
      credentialLoader,
      utcClock: wall,
      monotonicClock: monotonic,
      createReadPort: (options) => {
        sharedBudget = options.budget;
        if (dependencies.createAccountReadPort)
          return dependencies.createAccountReadPort({
            ...options,
            environment: "mainnet",
            request: countedRequest,
          });
        const transport = new BybitAccountReadTransport({
          environment: "mainnet",
          credentials: options.credentials,
          budget: options.budget,
          request: countedRequest,
          clock: options.utcClock,
          monotonicClock: options.monotonicClock,
        });
        return new BybitAccountReadClient({
          transport,
          utcClock: options.utcClock,
        });
      },
    });
  } catch {
    return failed(
      counter.counts.exchangeWrites > 0
        ? "NON_GET_REQUEST_BLOCKED"
        : "PREFLIGHT_FAILED",
      counter.counts,
    );
  }

  let instrument: BybitInstrumentInfo | null = null;
  let instrumentReasonCode: AccountEvidenceFailureCode | undefined;
  let evaluatedAtMs: number;
  if (accountResult.kind === "account-evidence") {
    if (credentialSnapshot === undefined || sharedBudget === undefined)
      return failed("PROVIDER_TIME_UNAVAILABLE", counter.counts);
    const transport = new BybitAccountReadTransport({
      environment: "mainnet",
      credentials: credentialSnapshot,
      budget: sharedBudget,
      request: countedRequest,
      clock: wall,
      monotonicClock: monotonic,
    });
    try {
      instrument = await new BybitMainnetReadCapabilityFacade(
        transport,
      ).readInstrument(symbol);
    } catch (error) {
      instrument = null;
      instrumentReasonCode = instrumentProviderFailureCode(error);
    }
    try {
      // Compare account evidence and the verdict using the exchange clock,
      // never the operator machine's potentially skewed wall clock.
      evaluatedAtMs = await transport.readExchangeTime();
    } catch {
      return failed("PROVIDER_TIME_UNAVAILABLE", counter.counts);
    }
  } else {
    evaluatedAtMs = wall();
  }

  if (counter.counts.exchangeWrites > 0)
    return failed("NON_GET_REQUEST_BLOCKED", counter.counts);

  const evaluatedAt = timestampFromEpochMs(evaluatedAtMs);
  if (!evaluatedAt.ok) return failed("PREFLIGHT_FAILED", counter.counts);
  const readiness = deriveMainnetExecutionReadiness({
    accountResult,
    symbol,
    instrument,
    evaluatedAt: evaluatedAt.value,
  });
  return Object.freeze({
    kind: "assessment",
    readiness,
    requestCounts: counter.counts,
    ...(instrumentReasonCode === undefined
      ? {}
      : { instrumentProviderReasonCode: instrumentReasonCode }),
  });
}
