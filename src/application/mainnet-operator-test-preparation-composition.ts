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
import { rehydrateOperatorMainnetRecoveryAttestation } from "../domain/execution/operator-mainnet-recovery.js";
import { domainError } from "../domain/shared/errors.js";
import { fail, ok, type Result } from "../domain/shared/result.js";
import {
  parseUtcTimestamp,
  timestampFromEpochMs,
  timestampToEpochMs,
} from "../domain/shared/time.js";
import { isPlanningSymbol } from "../domain/planning/decision-policy.js";
import { requireHash } from "../domain/shared/validation.js";
import type {
  CredentialEnvironment,
  CredentialProvider,
  ExchangeCredentials,
} from "../ports/credential-provider.js";
import type { UtcTimestamp } from "../domain/shared/time.js";
import { collectAccountEvidence } from "./account-evidence-collection.js";
import { deriveMainnetExecutionReadiness } from "./mainnet-execution-readiness.js";
import {
  collectCompactOperatorAccountEvidence,
  createCompactOperatorAccountReader,
  extractOperatorFeeRate,
  CompactAccountEvidenceUnavailable,
} from "./mainnet-operator-test-evidence.js";
import {
  calculateOperatorMainnetTestCapacity,
  calculateOperatorMainnetTestCapacityFromAvailableBalance,
  validateCompactOperatorAccountForPlan,
  validateCompactOperatorPreparationEvidence,
} from "./mainnet-entry-evidence.js";
import { PROVISIONAL_M1_MAX_ACCOUNT_EVIDENCE_AGE_MS } from "./policies/provisional-m1.js";
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
  readonly recoveryAttestationHash?: unknown;
  readonly recoveryAttestation?: unknown;
}

export interface MainnetOperatorTestPreparation {
  readonly plan: OperatorMainnetTestPlan;
  readonly exchangeReads: number;
  readonly exchangeGetCounts?: string;
  readonly exchangeWrites: 0;
  readonly compactFallbackReason?: string;
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

async function readPreparationFee(
  transport: BybitAccountReadTransport,
  symbol: string,
) {
  let response;
  try {
    response = await transport.get("/v5/account/fee-rate", {
      category: "linear",
      symbol,
    });
  } catch {
    return failed("FEE_RATE_READ_FAILED", { source: "fee" });
  }
  return extractOperatorFeeRate(response, symbol);
}

export interface MainnetOperatorTestPreparationDependencies {
  readonly request?: typeof fetch;
  readonly credentialProvider?: Pick<CredentialProvider, "load">;
  readonly openPersistence?: typeof openSqlitePersistence;
  readonly utcClock?: () => number;
}

/** GET-only preparation and canonical persistence; it has no private write transport. */
export async function prepareMainnetOperatorTest(
  input: MainnetOperatorTestPrepareInput,
  dependencies: MainnetOperatorTestPreparationDependencies = {},
): Promise<Result<MainnetOperatorTestPreparation>> {
  const getCounts = createMainnetGetCounts();
  let compactFallbackReason: string | undefined;
  const withCounts = <T>(result: Result<T>, reads: number, writes: number) =>
    withExchangeCounts(
      !result.ok && compactFallbackReason
        ? fail(
            domainError(result.error.code, result.error.message, {
              ...result.error.details,
              compactFallbackReason,
            }),
          )
        : result,
      reads,
      writes,
      getCounts.summary(),
    );
  let exchangeReads = 0;
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    (Reflect.ownKeys(input).length !== 4 &&
      Reflect.ownKeys(input).length !== 6) ||
    !Object.hasOwn(input, "symbol") ||
    !Object.hasOwn(input, "allocation") ||
    !Object.hasOwn(input, "grossNotionalCap") ||
    !Object.hasOwn(input, "maxDeviationBps") ||
    Object.hasOwn(input, "recoveryAttestationHash") !==
      Object.hasOwn(input, "recoveryAttestation") ||
    typeof input.symbol !== "string" ||
    !isPlanningSymbol(input.symbol) ||
    [input.allocation, input.grossNotionalCap, input.maxDeviationBps].some(
      (value) => typeof value !== "string" || value.length > 128,
    )
  )
    return withCounts(failed("INVALID_INPUT"), exchangeReads, 0);

  const recoveryAttestation = Object.hasOwn(input, "recoveryAttestation")
    ? rehydrateOperatorMainnetRecoveryAttestation(input.recoveryAttestation)
    : undefined;
  const recoveryAttestationHash = Object.hasOwn(
    input,
    "recoveryAttestationHash",
  )
    ? requireHash(input.recoveryAttestationHash, "recoveryAttestationHash")
    : undefined;
  if (
    (recoveryAttestation !== undefined && !recoveryAttestation.ok) ||
    (recoveryAttestationHash !== undefined && !recoveryAttestationHash.ok) ||
    (recoveryAttestation !== undefined &&
      recoveryAttestation.ok &&
      recoveryAttestationHash?.ok &&
      recoveryAttestation.value.contentHash !== recoveryAttestationHash.value)
  )
    return withCounts(
      failed("MANUAL_RECOVERY_ATTESTATION_INVALID"),
      exchangeReads,
      0,
    );

  const wall = dependencies.utcClock ?? Date.now;
  const monotonic = () => performance.now();
  const request: typeof fetch = async (url, init) => {
    const method = (
      init?.method ?? (url instanceof Request ? url.method : "GET")
    ).toUpperCase();
    if (method !== "GET")
      throw new Error("operator preparation permits GET requests only");
    exchangeReads += 1;
    getCounts.record(url, init);
    return (dependencies.request ?? fetch)(url, init);
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
  let compactServerTime: UtcTimestamp | undefined;
  let accountResult: AccountEvidenceCollectionResult | undefined;
  let preparationFee:
    | Extract<ReturnType<typeof extractOperatorFeeRate>, { ok: true }>["value"]
    | undefined;
  const provider =
    dependencies.credentialProvider ?? createMacOSKeychainProvider();
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
    const fee = await readPreparationFee(compactReader.transport, input.symbol);
    if (!fee.ok) return withCounts(fee, exchangeReads, 0);
    preparationFee = fee.value;
    const accountCheck = validateCompactOperatorAccountForPlan(
      undefined,
      compactAccount,
      fee.value.observedAt,
    );
    if (!accountCheck.ok) {
      const reasonCode = accountCheck.error.details?.reasonCode;
      if (
        typeof reasonCode === "string" &&
        [
          "ACCOUNT_MODE_UNKNOWN",
          "ACCOUNT_MODE_UNSUPPORTED",
          "SPOT_HEDGING_ENABLED",
          "CREDENTIAL_PERMISSION_BLOCKED",
          "CRITICAL_STATE_CHANGED",
          "AVAILABLE_BALANCE_SNAPSHOTS_DIFFER",
        ].includes(reasonCode)
      )
        return withCounts(
          failed(reasonCode, accountCheck.error.details ?? {}),
          exchangeReads,
          0,
        );
      throw new CompactAccountEvidenceUnavailable(
        typeof reasonCode === "string"
          ? reasonCode
          : "ACCOUNT_EVIDENCE_INVALID",
      );
    }
    if (accountCheck.value.availableBalance.isZero())
      return withCounts(
        failed("AVAILABLE_MARGIN_OR_FEE_RESERVE_INSUFFICIENT", {
          availableBalance: "0",
          source: "balance",
        }),
        exchangeReads,
        0,
      );
    const instrument = await new BybitMainnetReadCapabilityFacade(
      compactReader.transport,
    ).readInstrument(input.symbol);
    const publicMarkets = new BybitPublicMarketClient({
      transport: new BybitPublicTransport({ request }),
    });
    const quote = await publicMarkets.readOperatorQuote(input.symbol);
    // Exact venue rounding and both entry/exit fees own affordability. Do this
    // before the comparatively expensive target-state reads or persistence.
    const candidate = createOperatorMainnetTestPlan({
      accountIdentityHash: accountCheck.value.accountIdentityHash,
      symbol: input.symbol,
      nonce: randomUUID(),
      allocation: input.allocation,
      grossNotionalCap: input.grossNotionalCap,
      maxDeviationBps: input.maxDeviationBps,
      quote,
      warningCodes: accountCheck.value.credentialPosture.warnings,
      constraints: instrument.constraints,
      preparedAt: quote.observedAt,
      ...(recoveryAttestationHash?.ok
        ? { recoveryAttestationHash: recoveryAttestationHash.value }
        : {}),
    });
    if (!candidate.ok) return withCounts(candidate, exchangeReads, 0);
    const earlyFeeAge =
      timestampToEpochMs(quote.observedAt) -
      timestampToEpochMs(fee.value.observedAt);
    if (
      earlyFeeAge < 0 ||
      earlyFeeAge > PROVISIONAL_M1_MAX_ACCOUNT_EVIDENCE_AGE_MS
    )
      return withCounts(
        failed("MAINNET_EVIDENCE_STALE", {
          source: "fee",
          ageMs: earlyFeeAge,
          limitMs: PROVISIONAL_M1_MAX_ACCOUNT_EVIDENCE_AGE_MS,
        }),
        exchangeReads,
        0,
      );
    const accountAtQuote = validateCompactOperatorAccountForPlan(
      candidate.value,
      compactAccount,
      quote.observedAt,
    );
    if (!accountAtQuote.ok) return withCounts(accountAtQuote, exchangeReads, 0);
    const capacity = calculateOperatorMainnetTestCapacityFromAvailableBalance(
      candidate.value,
      accountAtQuote.value.availableBalance,
      fee.value,
    );
    if (!capacity.ok) return withCounts(capacity, exchangeReads, 0);
    const exchange = new BybitMainnetExecutionAdapter({
      transport: new BybitPrivateTransport({
        environment: "mainnet",
        credentials: loaded,
        request,
        clock: wall,
      }),
    });
    compactInstrument = instrument;
    compactQuote = quote;
    let checked;
    if (recoveryAttestation?.ok) {
      const parts = await exchange.readOperatorTargetStateParts({
        instrument: input.symbol,
      });
      if (!parts.serverTime)
        return withCounts(
          failed("PROVIDER_TIME_UNAVAILABLE", {
            source: "target-state",
          }),
          exchangeReads,
          0,
        );
      compactServerTime = parts.serverTime;
      checked = validateCompactOperatorPreparationEvidence({
        compactAccount,
        manualTargetState: {
          ...parts,
          attestation: recoveryAttestation.value,
        },
        plan: candidate.value,
        instrument,
        quote,
      });
    } else {
      const current = await exchange.readState({ instrument: input.symbol });
      if (!current.ok) throw new Error("compact state unavailable");
      compactServerTime = current.value.serverTime;
      checked = validateCompactOperatorPreparationEvidence({
        compactAccount,
        state: current.value,
        instrument,
        quote,
      });
    }
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
      compactFallbackReason =
        typeof reasonCode === "string" &&
        /^[A-Z][A-Z0-9_]{0,79}$/u.test(reasonCode)
          ? reasonCode
          : "COMPACT_EVIDENCE_INVALID";
    }
  } catch (error) {
    // No raw provider error is exposed. The route and safe reason explain extra reads.
    compactFallbackReason =
      error instanceof CompactAccountEvidenceUnavailable &&
      /^[A-Z][A-Z0-9_]{0,79}$/u.test(error.reasonCode)
        ? error.reasonCode
        : "COMPACT_READ_FAILED";
  }
  if (recoveryAttestation?.ok && !compactPreparation)
    return withCounts(
      failed(
        compactFallbackReason ?? "MANUAL_RECOVERY_MACHINE_EVIDENCE_UNAVAILABLE",
        {
          source: "account",
          causeCode: "MANDATORY_COMPACT_EVIDENCE_INCOMPLETE",
        },
      ),
      exchangeReads,
      0,
    );
  if (!credentials)
    return withCounts(failed("ACCOUNT_EVIDENCE_UNAVAILABLE"), exchangeReads, 0);

  try {
    let instrument = compactInstrument;
    let quote = compactQuote;
    let providerTime = compactServerTime
      ? parseUtcTimestamp(compactServerTime)
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
      const fallbackFee = await readPreparationFee(
        accountTransport,
        input.symbol,
      );
      if (!fallbackFee.ok) return withCounts(fallbackFee, exchangeReads, 0);
      preparationFee = fallbackFee.value;
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
      ...(recoveryAttestationHash?.ok
        ? { recoveryAttestationHash: recoveryAttestationHash.value }
        : {}),
    });
    if (!plan.ok) return withCounts(plan, exchangeReads, 0);
    // Recheck fresh fee/balance evidence at the shared persistence boundary,
    // covering both compact preparation and full-readiness fallback.
    if (!accountTransport)
      return withCounts(
        failed("ACCOUNT_EVIDENCE_UNAVAILABLE"),
        exchangeReads,
        0,
      );
    if (!preparationFee)
      return withCounts(failed("FEE_RATE_EVIDENCE_INVALID"), exchangeReads, 0);
    const fee = preparationFee;
    const freshTime = timestampToEpochMs(providerTime.value);
    const feeAge = freshTime - timestampToEpochMs(fee.observedAt);
    if (feeAge < 0 || feeAge > PROVISIONAL_M1_MAX_ACCOUNT_EVIDENCE_AGE_MS)
      return withCounts(
        failed("MAINNET_EVIDENCE_STALE", {
          source: "fee",
          ageMs: feeAge,
          limitMs: PROVISIONAL_M1_MAX_ACCOUNT_EVIDENCE_AGE_MS,
        }),
        exchangeReads,
        0,
      );
    let capacity;
    if (compactPreparation && compactAccount) {
      const time = timestampFromEpochMs(freshTime);
      if (!time.ok) return withCounts(time, exchangeReads, 0);
      const account = validateCompactOperatorAccountForPlan(
        plan.value,
        compactAccount,
        time.value,
      );
      if (!account.ok) return withCounts(account, exchangeReads, 0);
      capacity = calculateOperatorMainnetTestCapacityFromAvailableBalance(
        plan.value,
        account.value.availableBalance,
        fee,
      );
    } else if (accountResult?.kind === "account-evidence") {
      const walletObservations = [
        accountResult.bundle.criticalPasses.A,
        accountResult.bundle.criticalPasses.B,
      ].map(
        (pass) =>
          pass?.observations.find(
            (item) => item.partition.endpoint === "wallet",
          )?.exchangeResponseTime,
      );
      const missingWalletPass = walletObservations.findIndex((at) => !at);
      if (missingWalletPass >= 0) {
        const pass = missingWalletPass === 0 ? "A" : "B";
        return withCounts(
          failed(`WALLET_${pass}_OBSERVATION_MISSING`, {
            source: "balance",
            pass,
            predicate: "wallet-observation",
          }),
          exchangeReads,
          0,
        );
      }
      for (const observedAt of walletObservations) {
        const accountAge = freshTime - timestampToEpochMs(observedAt!);
        if (
          accountAge < 0 ||
          accountAge > PROVISIONAL_M1_MAX_ACCOUNT_EVIDENCE_AGE_MS
        )
          return withCounts(
            failed("MAINNET_EVIDENCE_STALE", {
              source: "balance",
              ageMs: accountAge,
              limitMs: PROVISIONAL_M1_MAX_ACCOUNT_EVIDENCE_AGE_MS,
            }),
            exchangeReads,
            0,
          );
      }
      capacity = calculateOperatorMainnetTestCapacity(
        plan.value,
        accountResult.bundle,
        fee,
      );
    } else
      return withCounts(
        failed("ACCOUNT_EVIDENCE_INCOMPLETE"),
        exchangeReads,
        0,
      );
    if (!capacity.ok) return withCounts(capacity, exchangeReads, 0);
    const persistence = (dependencies.openPersistence ?? openSqlitePersistence)(
      {
        environment: "mainnet",
        scope: scopeFor(plan.value.accountIdentityHash),
        clock: { now: () => providerTime.value },
      },
    );
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
            ...(compactFallbackReason ? { compactFallbackReason } : {}),
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
