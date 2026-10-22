import { randomUUID } from "node:crypto";

import { createMacOSKeychainProvider } from "../adapters/macos-keychain.js";
import {
  BybitAccountReadTransport,
  type AccountReadBudget,
} from "../adapters/bybit-v5/account-read-transport.js";
import { BybitAccountReadClient } from "../adapters/bybit-v5/account-read-client.js";
import { BybitMainnetReadCapabilityFacade } from "../adapters/bybit-v5/read-capability-facade.js";
import { BybitPublicMarketClient } from "../adapters/bybit-v5/public-market-client.js";
import { BybitPublicTransport } from "../adapters/bybit-v5/public-transport.js";
import { openSqlitePersistence } from "../adapters/sqlite/sqlite-persistence.js";
import type { AccountEvidenceCollectionResult } from "../domain/account/account-evidence-bundle.js";
import {
  createOperatorMainnetTestPlan,
  type OperatorMainnetTestPlan,
} from "../domain/execution/operator-mainnet-test-plan.js";
import { domainError } from "../domain/shared/errors.js";
import { fail, ok, type Result } from "../domain/shared/result.js";
import { timestampFromEpochMs } from "../domain/shared/time.js";
import { isPlanningSymbol } from "../domain/planning/decision-policy.js";
import type {
  CredentialEnvironment,
  CredentialProvider,
  ExchangeCredentials,
} from "../ports/credential-provider.js";
import { collectAccountEvidence } from "./account-evidence-collection.js";
import { deriveMainnetExecutionReadiness } from "./mainnet-execution-readiness.js";

export interface MainnetOperatorTestPrepareInput {
  readonly symbol: unknown;
  readonly allocation: unknown;
  readonly grossNotionalCap: unknown;
  readonly maxDeviationBps: unknown;
}

function scopeFor(accountId: string) {
  return {
    exchange: "bybit" as const,
    environment: "mainnet" as const,
    accountId,
    category: "linear" as const,
    positionMode: "one-way" as const,
  };
}

function failed(code: string): Result<never> {
  return fail(
    domainError("INVALID_EVIDENCE", "operator Mainnet preparation is blocked", {
      reasonCode: code,
    }),
  );
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

/** GET-only preparation and canonical persistence; it has no private write transport. */
export async function prepareMainnetOperatorTest(
  input: MainnetOperatorTestPrepareInput,
): Promise<Result<OperatorMainnetTestPlan>> {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    Reflect.ownKeys(input).length !== 4 ||
    !Object.hasOwn(input, "symbol") ||
    !Object.hasOwn(input, "allocation") ||
    !Object.hasOwn(input, "grossNotionalCap") ||
    !Object.hasOwn(input, "maxDeviationBps") ||
    typeof input.symbol !== "string" ||
    !isPlanningSymbol(input.symbol) ||
    [input.allocation, input.grossNotionalCap, input.maxDeviationBps].some(
      (value) => typeof value !== "string" || value.length > 128,
    )
  )
    return failed("INVALID_INPUT");

  const wall = Date.now;
  const monotonic = () => performance.now();
  const runId = `operator-prepare-${randomUUID()}`;
  const provider = createMacOSKeychainProvider();
  let credentials: Readonly<ExchangeCredentials> | undefined;
  const credentialLoader: Pick<CredentialProvider, "load"> = {
    load: async (environment: CredentialEnvironment) => {
      if (environment !== "mainnet") throw new Error("environment mismatch");
      if (!credentials)
        credentials = snapshotCredentials(await provider.load("mainnet"));
      return credentials;
    },
  };
  let accountTransport: BybitAccountReadTransport | undefined;
  let accountBudget: AccountReadBudget | undefined;
  let accountResult: AccountEvidenceCollectionResult;
  try {
    accountResult = await collectAccountEvidence({
      environment: "mainnet",
      runId,
      configuredM1Symbols: [input.symbol],
      credentialLoader,
      utcClock: wall,
      monotonicClock: monotonic,
      createReadPort: (options) => {
        accountBudget = options.budget;
        accountTransport = new BybitAccountReadTransport({
          environment: "mainnet",
          credentials: options.credentials,
          budget: options.budget,
          request: fetch,
          clock: options.utcClock,
          monotonicClock: options.monotonicClock,
        });
        return new BybitAccountReadClient({
          transport: accountTransport,
          utcClock: options.utcClock,
        });
      },
    });
  } catch {
    return failed("ACCOUNT_EVIDENCE_UNAVAILABLE");
  }
  if (
    accountResult.kind !== "account-evidence" ||
    !credentials ||
    !accountTransport ||
    !accountBudget
  )
    return failed("ACCOUNT_EVIDENCE_INCOMPLETE");

  try {
    const instrument = await new BybitMainnetReadCapabilityFacade(
      accountTransport,
    ).readInstrument(input.symbol);
    const publicMarkets = new BybitPublicMarketClient({
      transport: new BybitPublicTransport({ request: fetch }),
    });
    const quote = await publicMarkets.readOperatorQuote(input.symbol);
    const providerTimeMs = await accountTransport.readExchangeTime();
    const providerTime = timestampFromEpochMs(providerTimeMs);
    if (!providerTime.ok) return failed("PROVIDER_TIME_UNAVAILABLE");
    const readiness = deriveMainnetExecutionReadiness({
      accountResult,
      symbol: input.symbol,
      instrument,
      evaluatedAt: providerTime.value,
    });
    if (
      readiness.verdict !== "READY" ||
      readiness.internalBinding?.accountIdentityHash !==
        accountResult.bundle.accountBinding.accountIdentityHash
    )
      return failed(
        `READINESS_${readiness.reasonCodes.join("_") || "BLOCKED"}`,
      );
    const warningCodes = readiness.warningCodes.includes("API_KEY_IP_UNBOUND")
      ? ["API_KEY_IP_UNBOUND"]
      : [];
    const plan = createOperatorMainnetTestPlan({
      accountIdentityHash:
        accountResult.bundle.accountBinding.accountIdentityHash,
      symbol: input.symbol,
      nonce: randomUUID(),
      allocation: input.allocation,
      grossNotionalCap: input.grossNotionalCap,
      maxDeviationBps: input.maxDeviationBps,
      quote,
      warningCodes,
      constraints: instrument.constraints,
      preparedAt: providerTime.value,
    });
    if (!plan.ok) return plan;
    const persistence = openSqlitePersistence({
      environment: "mainnet",
      scope: scopeFor(plan.value.accountIdentityHash),
      clock: { now: () => providerTime.value },
    });
    if (!persistence.ok) return persistence;
    try {
      const journal = persistence.value.operatorMainnetTest;
      if (!journal) return failed("OPERATOR_PLAN_STORE_UNAVAILABLE");
      const stored = journal.persistPreparedPlan(plan.value);
      return stored.ok ? ok(plan.value) : stored;
    } finally {
      persistence.value.close();
    }
  } catch {
    return failed("PREPARATION_FAILED_CLOSED");
  }
}
