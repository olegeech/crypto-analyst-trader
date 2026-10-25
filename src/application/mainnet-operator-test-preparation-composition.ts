import { randomUUID } from "node:crypto";

import { createMacOSKeychainProvider } from "../adapters/macos-keychain.js";
import { BybitAccountReadTransport } from "../adapters/bybit-v5/account-read-transport.js";
import { BybitAccountReadClient } from "../adapters/bybit-v5/account-read-client.js";
import { BybitMainnetReadCapabilityFacade } from "../adapters/bybit-v5/read-capability-facade.js";
import { BybitMainnetExecutionAdapter } from "../adapters/bybit-v5/execution-adapter.js";
import { BybitPrivateTransport } from "../adapters/bybit-v5/transport.js";
import { BybitPublicMarketClient } from "../adapters/bybit-v5/public-market-client.js";
import {
  BybitPublicTransport,
  BybitPublicTransportError,
} from "../adapters/bybit-v5/public-transport.js";
import { BybitPublicMarketMappingError } from "../adapters/bybit-v5/public-market-mappers.js";
import { openSqlitePersistence } from "../adapters/sqlite/sqlite-persistence.js";
import { changedAccountCriticalGroups } from "../domain/account/account-evidence-consistency.js";
import type { AccountEvidenceCollectionResult } from "../domain/account/account-evidence-bundle.js";
import {
  createOperatorMainnetTestPlan,
  type OperatorMainnetTestPlan,
} from "../domain/execution/operator-mainnet-test-plan.js";
import { domainError } from "../domain/shared/errors.js";
import { fail, ok, type Result } from "../domain/shared/result.js";
import {
  parseUtcTimestamp,
  timestampFromEpochMs,
} from "../domain/shared/time.js";
import { isPlanningSymbol } from "../domain/planning/decision-policy.js";
import type {
  CredentialEnvironment,
  CredentialProvider,
  ExchangeCredentials,
} from "../ports/credential-provider.js";
import type { MainnetExchangeReadState } from "../ports/exchange-execution.js";
import { collectAccountEvidence } from "./account-evidence-collection.js";
import { deriveMainnetExecutionReadiness } from "./mainnet-execution-readiness.js";
import {
  collectCompactOperatorAccountEvidence,
  createCompactOperatorAccountReader,
} from "./mainnet-operator-test-evidence.js";
import { validateCompactOperatorPreparationEvidence } from "./mainnet-entry-evidence.js";
import {
  createMainnetGetCounts,
  snapshotExchangeCredentials,
  withExchangeCounts,
} from "./mainnet-composition-helpers.js";

export interface MainnetOperatorTestPrepareInput {
  readonly symbol: unknown;
  readonly allocation: unknown;
  readonly grossNotionalCap: unknown;
  readonly maxDeviationBps: unknown;
}

export interface MainnetOperatorTestPreparation {
  readonly plan: OperatorMainnetTestPlan;
  readonly exchangeReads: number;
  readonly exchangeGetCounts?: string;
  readonly exchangeWrites: 0;
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

function failed(
  code: string,
  details: Readonly<Record<string, unknown>> = {},
): Result<never> {
  return fail(
    domainError("INVALID_EVIDENCE", "operator Mainnet preparation is blocked", {
      reasonCode: code,
      ...details,
    }),
  );
}

/** GET-only preparation and canonical persistence; it has no private write transport. */
export async function prepareMainnetOperatorTest(
  input: MainnetOperatorTestPrepareInput,
): Promise<Result<MainnetOperatorTestPreparation>> {
  const getCounts = createMainnetGetCounts();
  const withCounts = <T>(result: Result<T>, reads: number, writes: number) =>
    withExchangeCounts(result, reads, writes, getCounts.summary());
  let exchangeReads = 0;
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
    return withCounts(failed("INVALID_INPUT"), exchangeReads, 0);

  const wall = Date.now;
  const monotonic = () => performance.now();
  const request: typeof fetch = async (url, init) => {
    const method = (
      init?.method ?? (url instanceof Request ? url.method : "GET")
    ).toUpperCase();
    if (method !== "GET")
      throw new Error("operator preparation permits GET requests only");
    exchangeReads += 1;
    getCounts.record(url, init);
    return fetch(url, init);
  };
  const runId = `operator-prepare-${randomUUID()}`;
  let credentials: Readonly<ExchangeCredentials> | undefined;
  let accountTransport: BybitAccountReadTransport | undefined;
  let compactAccount:
    | Awaited<ReturnType<typeof collectCompactOperatorAccountEvidence>>
    | undefined;
  let compactPreparation:
    | Extract<
        ReturnType<typeof validateCompactOperatorPreparationEvidence>,
        { readonly ok: true }
      >["value"]
    | undefined;
  let compactInstrument:
    | Awaited<ReturnType<BybitMainnetReadCapabilityFacade["readInstrument"]>>
    | undefined;
  let compactQuote:
    | Awaited<ReturnType<BybitPublicMarketClient["readOperatorQuote"]>>
    | undefined;
  let compactState: MainnetExchangeReadState | undefined;
  let accountResult: AccountEvidenceCollectionResult | undefined;
  const provider = createMacOSKeychainProvider();
  const credentialLoader: Pick<CredentialProvider, "load"> = {
    load: async (environment: CredentialEnvironment) => {
      if (environment !== "mainnet") throw new Error("environment mismatch");
      if (!credentials)
        credentials = snapshotExchangeCredentials(
          await provider.load("mainnet"),
        );
      return credentials;
    },
  };
  try {
    const loaded = await credentialLoader.load("mainnet");
    const compactReader = createCompactOperatorAccountReader({
      credentials: loaded,
      request,
      utcClock: wall,
      monotonicClock: monotonic,
    });
    accountTransport = compactReader.transport;
    compactAccount = await collectCompactOperatorAccountEvidence(
      compactReader.reader,
      loaded,
    );
    const instrument = await new BybitMainnetReadCapabilityFacade(
      compactReader.transport,
    ).readInstrument(input.symbol);
    const publicMarkets = new BybitPublicMarketClient({
      transport: new BybitPublicTransport({ request }),
    });
    const quote = await publicMarkets.readOperatorQuote(input.symbol);
    const exchange = new BybitMainnetExecutionAdapter({
      transport: new BybitPrivateTransport({
        environment: "mainnet",
        credentials: loaded,
        request,
        clock: wall,
      }),
    });
    const current = await exchange.readState({ instrument: input.symbol });
    if (!current.ok) throw new Error("compact state unavailable");
    compactInstrument = instrument;
    compactQuote = quote;
    compactState = current.value;
    const checked = validateCompactOperatorPreparationEvidence({
      compactAccount,
      state: current.value,
      instrument,
      quote,
    });
    if (checked.ok) compactPreparation = checked.value;
    else {
      const reasonCode = checked.error.details?.reasonCode;
      if (
        typeof reasonCode === "string" &&
        [
          "ACCOUNT_MODE_UNKNOWN",
          "ACCOUNT_MODE_UNSUPPORTED",
          "SPOT_HEDGING_ENABLED",
          "CREDENTIAL_PERMISSION_BLOCKED",
          "CRITICAL_STATE_CHANGED",
          "TARGET_STATE_OR_CAPABILITY_BLOCKED",
          "TARGET_INSTRUMENT_UNSUPPORTED",
          "QUOTE_EVIDENCE_INVALID",
          "QUOTE_STALE_OR_FUTURE",
        ].includes(reasonCode)
      )
        return withCounts(
          failed(reasonCode, checked.error.details ?? {}),
          exchangeReads,
          0,
        );
    }
  } catch {
    // Missing or ambiguous compact facts use the existing full-readiness path below.
  }
  if (!credentials)
    return withCounts(failed("ACCOUNT_EVIDENCE_UNAVAILABLE"), exchangeReads, 0);

  try {
    let instrument = compactInstrument;
    let quote = compactQuote;
    let providerTime = compactState
      ? parseUtcTimestamp(compactState.serverTime)
      : undefined;
    let accountIdentityHash = compactPreparation?.accountIdentityHash;
    let warningCodes: readonly "API_KEY_IP_UNBOUND"[] | undefined =
      compactPreparation?.warningCodes;

    if (!compactPreparation) {
      accountResult = await collectAccountEvidence({
        environment: "mainnet",
        runId,
        configuredM1Symbols: [input.symbol],
        credentialLoader,
        utcClock: wall,
        monotonicClock: monotonic,
        createReadPort: (options) => {
          accountTransport = new BybitAccountReadTransport({
            environment: "mainnet",
            credentials: options.credentials,
            budget: options.budget,
            request,
            clock: options.utcClock,
            monotonicClock: options.monotonicClock,
          });
          return new BybitAccountReadClient({
            transport: accountTransport,
            utcClock: options.utcClock,
          });
        },
      });
      if (accountResult.kind !== "account-evidence" || !accountTransport)
        return withCounts(
          failed("ACCOUNT_EVIDENCE_INCOMPLETE"),
          exchangeReads,
          0,
        );
      instrument = await new BybitMainnetReadCapabilityFacade(
        accountTransport,
      ).readInstrument(input.symbol);
      const publicMarkets = new BybitPublicMarketClient({
        transport: new BybitPublicTransport({ request }),
      });
      quote = await publicMarkets.readOperatorQuote(input.symbol);
      providerTime = timestampFromEpochMs(
        await accountTransport.readExchangeTime(),
      );
      if (!providerTime.ok)
        return withCounts(
          failed("PROVIDER_TIME_UNAVAILABLE"),
          exchangeReads,
          0,
        );
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
        return withCounts(
          readiness.reasonCodes.includes("CRITICAL_STATE_CHANGED")
            ? failed("CRITICAL_STATE_CHANGED", {
                criticalChangedGroups:
                  changedAccountCriticalGroups(accountResult.bundle).join(
                    ",",
                  ) || "UNESTABLISHED",
              })
            : failed(
                `READINESS_${readiness.reasonCodes.join("_") || "BLOCKED"}`,
                { source: "account" },
              ),
          exchangeReads,
          0,
        );
      accountIdentityHash =
        accountResult.bundle.accountBinding.accountIdentityHash;
      warningCodes = readiness.warningCodes.includes("API_KEY_IP_UNBOUND")
        ? ["API_KEY_IP_UNBOUND"]
        : [];
    }
    if (
      !instrument ||
      !quote ||
      !providerTime?.ok ||
      !accountIdentityHash ||
      !warningCodes
    )
      return withCounts(
        failed("COMPACT_EVIDENCE_INCOMPLETE"),
        exchangeReads,
        0,
      );
    const plan = createOperatorMainnetTestPlan({
      accountIdentityHash,
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
    if (!plan.ok) return withCounts(plan, exchangeReads, 0);
    const persistence = openSqlitePersistence({
      environment: "mainnet",
      scope: scopeFor(plan.value.accountIdentityHash),
      clock: { now: () => providerTime.value },
    });
    if (!persistence.ok) return withCounts(persistence, exchangeReads, 0);
    try {
      const journal = persistence.value.operatorMainnetTest;
      if (!journal)
        return withCounts(
          failed("OPERATOR_PLAN_STORE_UNAVAILABLE"),
          exchangeReads,
          0,
        );
      const stored = journal.persistPreparedPlan(plan.value);
      return stored.ok
        ? ok({
            plan: plan.value,
            exchangeReads,
            exchangeWrites: 0,
            exchangeGetCounts: getCounts.summary(),
          })
        : withCounts(stored, exchangeReads, 0);
    } finally {
      persistence.value.close();
    }
  } catch (error) {
    return withCounts(
      failed(
        error instanceof BybitPublicTransportError
          ? (error.reasonCode ??
              `PUBLIC_${error.kind.toUpperCase().replaceAll("-", "_")}`)
          : error instanceof BybitPublicMarketMappingError
            ? `PUBLIC_MARKET_${error.kind.toUpperCase().replaceAll("-", "_")}`
            : "PREPARATION_FAILED_CLOSED",
      ),
      exchangeReads,
      0,
    );
  }
}
