import { createHash } from "node:crypto";

import { createMacOSKeychainProvider } from "../adapters/macos-keychain.js";
import {
  BybitAccountReadError,
  BybitAccountReadTransport,
} from "../adapters/bybit-v5/account-read-transport.js";
import { BybitAccountReadClient } from "../adapters/bybit-v5/account-read-client.js";
import { BybitMainnetExecutionAdapter } from "../adapters/bybit-v5/execution-adapter.js";
import { mapCreateOrderRequest } from "../adapters/bybit-v5/order-mappers.js";
import {
  BybitPrivateTransport,
  BybitPrivateTransportError,
} from "../adapters/bybit-v5/transport.js";
import { BybitPublicMarketClient } from "../adapters/bybit-v5/public-market-client.js";
import {
  BybitPublicTransport,
  BybitPublicTransportError,
} from "../adapters/bybit-v5/public-transport.js";
import {
  BybitMainnetReadCapabilityError,
  BybitMainnetReadCapabilityFacade,
} from "../adapters/bybit-v5/read-capability-facade.js";
import { BybitPublicMarketMappingError } from "../adapters/bybit-v5/public-market-mappers.js";
import { openSqlitePersistence } from "../adapters/sqlite/sqlite-persistence.js";
import type { AccountEvidenceCollectionResult } from "../domain/account/account-evidence-bundle.js";
import {
  canonicalSerialize,
  type PlanHash,
} from "../domain/identity/canonical-serialization.js";
import {
  rehydrateOperatorMainnetTestApproval,
  rehydrateOperatorMainnetTestPlan,
  validateOperatorMainnetTestApproval,
  type OperatorMainnetTestPlan,
} from "../domain/execution/operator-mainnet-test-plan.js";
import { domainError } from "../domain/shared/errors.js";
import { fail, type Result } from "../domain/shared/result.js";
import {
  parseUtcTimestamp,
  timestampFromEpochMs,
  timestampToEpochMs,
  type UtcTimestamp,
} from "../domain/shared/time.js";
import { requireHash, requireIdentifier } from "../domain/shared/validation.js";
import type {
  CredentialEnvironment,
  CredentialProvider,
  ExchangeCredentials,
} from "../ports/credential-provider.js";
import type { PersistenceScope } from "../ports/persistence.js";
import type {
  OperatorMainnetTestCreateAuthorizationBinding,
  OperatorMainnetTestAuthorizationPort,
} from "../ports/operator-mainnet-test-authorization.js";
import type {
  MainnetOperatorTestInput,
  MainnetOperatorTestOutcome,
} from "./mainnet-operator-test.js";
import { executeMainnetOperatorTest } from "./mainnet-operator-test.js";
import { collectAccountEvidence } from "./account-evidence-collection.js";
import {
  calculateOperatorMainnetTestCapacityFromAvailableBalance,
  revalidateMainnetOperatorEvidenceAge,
  validateMainnetOperatorTestEvidence,
  validateCompactOperatorAccountForPlan,
  type MainnetOperatorTestEvidencePort,
  type MainnetOperatorTestAdmissionEvidence,
} from "./mainnet-entry-evidence.js";
import { deriveMainnetExecutionReadiness } from "./mainnet-execution-readiness.js";
import {
  createMainnetGetCounts,
  snapshotExchangeCredentials,
  withExchangeCounts,
} from "./mainnet-composition-helpers.js";

import {
  collectCompactOperatorAccountEvidence,
  createCompactOperatorAccountReader,
  collectOperatorAdmissionEvidence,
  extractOperatorFeeRate,
  CompactAccountEvidenceUnavailable,
  OperatorEvidenceReadError,
} from "./mainnet-operator-test-evidence.js";

const ACCOUNT_FEE_RATE_PATH = "/v5/account/fee-rate";
const CREATE_ORDER_PATH = "/v5/order/create";

interface PrivateCreateGrant {
  readonly bindingJson: string;
  readonly payloadHash: PlanHash;
  readonly expiresAt: UtcTimestamp;
  consumed: boolean;
  claimed: boolean;
  dispatched: boolean;
}

/** Private to this composition: identity, exact binding, expiry and one-use state are process-local. */
function createPrivateCreateIssuer(): {
  readonly authorization: OperatorMainnetTestAuthorizationPort;
  claimForTransport(payloadHash: string, providerNow: UtcTimestamp): boolean;
  hasClaimedTransportGrant(
    payloadHash: string,
    providerNow: UtcTimestamp,
  ): boolean;
  markDispatched(): void;
} {
  const grants = new WeakMap<object, PrivateCreateGrant>();
  let activeGrant: PrivateCreateGrant | undefined;
  let issued = false;
  const authorization: OperatorMainnetTestAuthorizationPort = {
    async issue(binding) {
      if (
        issued ||
        binding.operation !== "CREATE" ||
        binding.environment !== "mainnet"
      )
        return undefined;
      const hashes = [
        requireHash(binding.planHash, "planHash"),
        requireHash(binding.approvalHash, "approvalHash"),
        requireHash(binding.exactPayloadHash, "exactPayloadHash"),
        requireHash(binding.accountIdentityHash, "accountIdentityHash"),
      ];
      const identifiers = [
        requireIdentifier(binding.sourceId, "sourceId"),
        requireIdentifier(binding.symbol, "symbol"),
        requireIdentifier(binding.clientOrderId, "clientOrderId"),
        requireIdentifier(binding.runId, "runId"),
      ];
      const expiry = parseUtcTimestamp(binding.expiresAt);
      if (
        hashes.some((item) => !item.ok) ||
        identifiers.some((item) => !item.ok) ||
        !expiry.ok
      )
        return undefined;
      const encoded = canonicalSerialize(binding);
      if (!encoded.ok) return undefined;
      const capability = Object.freeze(Object.create(null)) as object;
      const grant: PrivateCreateGrant = {
        bindingJson: encoded.value,
        payloadHash: binding.exactPayloadHash,
        expiresAt: expiry.value,
        consumed: false,
        claimed: false,
        dispatched: false,
      };
      grants.set(capability, grant);
      activeGrant = grant;
      issued = true;
      return capability;
    },
    consume(capability, binding, now) {
      const grant = grants.get(capability);
      const encoded = canonicalSerialize(binding);
      const at = parseUtcTimestamp(now);
      if (
        !grant ||
        !encoded.ok ||
        !at.ok ||
        grant.consumed ||
        grant.bindingJson !== encoded.value ||
        timestampToEpochMs(at.value) >= timestampToEpochMs(grant.expiresAt)
      )
        return false;
      grant.consumed = true;
      return true;
    },
  };
  return {
    authorization,
    claimForTransport(payloadHash, providerNow) {
      const parsed = parseUtcTimestamp(providerNow);
      if (
        !activeGrant ||
        !parsed.ok ||
        !activeGrant.consumed ||
        activeGrant.claimed ||
        activeGrant.dispatched ||
        activeGrant.payloadHash !== payloadHash ||
        timestampToEpochMs(parsed.value) >=
          timestampToEpochMs(activeGrant.expiresAt)
      )
        return false;
      activeGrant.claimed = true;
      return true;
    },
    hasClaimedTransportGrant(payloadHash, providerNow) {
      const parsed = parseUtcTimestamp(providerNow);
      return Boolean(
        activeGrant &&
        parsed.ok &&
        activeGrant.consumed &&
        activeGrant.claimed &&
        !activeGrant.dispatched &&
        activeGrant.payloadHash === payloadHash &&
        timestampToEpochMs(parsed.value) <
          timestampToEpochMs(activeGrant.expiresAt),
      );
    },
    markDispatched() {
      if (activeGrant) activeGrant.dispatched = true;
    },
  };
}

function failed<T>(reasonCode: string): Result<T> {
  return fail(
    domainError(
      "INVALID_CAPABILITY",
      "operator Mainnet composition is blocked",
      {
        reasonCode,
      },
    ),
  );
}

function scopeFor(plan: OperatorMainnetTestPlan): PersistenceScope {
  return {
    exchange: "bybit",
    environment: "mainnet",
    accountId: plan.accountIdentityHash,
    category: "linear",
    positionMode: "one-way",
  };
}

function providerTime(
  wall: () => number,
  offsetMs: number,
): UtcTimestamp | undefined {
  const parsed = timestampFromEpochMs(Math.trunc(wall() + offsetMs));
  return parsed.ok ? parsed.value : undefined;
}

function inputIdentity(input: MainnetOperatorTestInput) {
  const approval = rehydrateOperatorMainnetTestApproval(input.approval);
  const hash = requireHash(input.approvalHash, "approvalHash");
  const runId = requireIdentifier(input.runId, "runId");
  if (
    !approval.ok ||
    !hash.ok ||
    !runId.ok ||
    approval.value.contentHash !== hash.value
  )
    return undefined;
  const plan = rehydrateOperatorMainnetTestPlan(
    approval.value.replayInputs.plan,
  );
  if (!plan.ok) return undefined;
  return { approval: approval.value, plan: plan.value, runId: runId.value };
}

type ValidatedAdmission = Extract<
  ReturnType<typeof validateMainnetOperatorTestEvidence>,
  { readonly ok: true }
>["value"];

/** Private production composition: real Keychain, GET-only evidence, and one durable CREATE dispatch. */
export async function runMainnetOperatorTestComposition(
  input: MainnetOperatorTestInput,
): Promise<Result<MainnetOperatorTestOutcome>> {
  const getCounts = createMainnetGetCounts();
  const withCounts = <T>(result: Result<T>, reads: number, writes: number) =>
    withExchangeCounts(result, reads, writes, getCounts.summary());
  let exchangeReads = 0;
  let exchangeWrites = 0;
  const normalized = inputIdentity(input);
  if (!normalized)
    return withCounts(
      failed("APPROVAL_OR_PLAN_INVALID"),
      exchangeReads,
      exchangeWrites,
    );
  const admitted = normalized;
  const wall = Date.now;
  const monotonic = () => performance.now();
  const localClock = {
    now: () => {
      const parsed = timestampFromEpochMs(wall());
      if (!parsed.ok) throw new Error("local UTC clock unavailable");
      return parsed.value;
    },
  };
  const persistence = openSqlitePersistence({
    environment: "mainnet",
    scope: scopeFor(admitted.plan),
    clock: localClock,
  });
  if (!persistence.ok)
    return withCounts(persistence, exchangeReads, exchangeWrites);
  try {
    const sqlite = persistence.value;
    const journal = sqlite.operatorMainnetTest;
    if (!journal)
      return withCounts(
        failed("MAINNET_OPERATOR_JOURNAL_UNAVAILABLE"),
        exchangeReads,
        exchangeWrites,
      );
    const operatorJournal = journal;
    const credentialProvider = createMacOSKeychainProvider();
    let credentialSnapshot: Readonly<ExchangeCredentials> | undefined;
    const credentialLoader: Pick<CredentialProvider, "load"> = {
      load: async (environment: CredentialEnvironment) => {
        if (environment !== "mainnet")
          throw new Error("credential environment mismatch");
        if (!credentialSnapshot)
          credentialSnapshot = snapshotExchangeCredentials(
            await credentialProvider.load("mainnet"),
          );
        return credentialSnapshot;
      },
    };

    const request: typeof fetch = async (url, init) => {
      const method = (
        init?.method ?? (url instanceof Request ? url.method : "GET")
      ).toUpperCase();
      getCounts.record(url, init);
      if (method === "GET") exchangeReads += 1;
      else if (method === "POST") exchangeWrites += 1;
      else throw new Error("operator composition permits GET and CREATE only");
      return fetch(url, init);
    };
    const loadedCredentials = await credentialLoader.load("mainnet");
    const accountReader = createCompactOperatorAccountReader({
      credentials: loadedCredentials,
      request,
      utcClock: wall,
      monotonicClock: monotonic,
    });
    let compactAccount:
      | Awaited<ReturnType<typeof collectCompactOperatorAccountEvidence>>
      | undefined;
    let accountResult: AccountEvidenceCollectionResult | undefined;

    let latestAdmission:
      | {
          readonly evidence: MainnetOperatorTestAdmissionEvidence;
          readonly evidenceAtMonotonic: number;
          readonly ages: ValidatedAdmission;
        }
      | undefined;
    let expectedBody: string | undefined;
    let postGrantArmed = false;
    let currentBinding:
      OperatorMainnetTestCreateAuthorizationBinding | undefined;
    const privateTransportRef: { current?: BybitPrivateTransport } = {};
    const issuer = createPrivateCreateIssuer();

    function sourceIsCurrent(): boolean {
      const binding = currentBinding;
      if (!binding) return false;
      const halt = sqlite.readHalt();
      const source = operatorJournal.readOperatorMainnetTestSource(
        binding.sourceId,
      );
      if (!halt.ok || !source.ok || !source.value) return false;
      return Boolean(
        !halt.value.active &&
        !halt.value.reconciliationRequired &&
        source.value.intent.operation === "CREATE" &&
        source.value.intent.runId === binding.runId &&
        source.value.source.payloadHash === binding.exactPayloadHash &&
        source.value.attempt === undefined,
      );
    }

    async function finalTransportCheck(
      body: string,
      path: string,
    ): Promise<boolean> {
      const active = latestAdmission;
      const binding = currentBinding;
      const transport = privateTransportRef.current;
      if (
        !active ||
        !binding ||
        path !== CREATE_ORDER_PATH ||
        body !== expectedBody
      )
        return false;
      if (!transport) return false;
      const offset = await transport.getServerTimeOffset();
      const now = providerTime(wall, offset);
      const elapsed = monotonic() - active.evidenceAtMonotonic;
      if (!now || !Number.isFinite(elapsed) || elapsed < 0) return false;
      const evidenceStillValid = validateMainnetOperatorTestEvidence(
        admitted.plan,
        active.evidence,
      );
      const fresh = revalidateMainnetOperatorEvidenceAge(
        admitted.plan,
        active.ages,
        elapsed,
      );
      const approvalStillValid = validateOperatorMainnetTestApproval(
        admitted.approval,
        admitted.plan,
        admitted.approval.contentHash,
        now,
      );
      return (
        evidenceStillValid.ok &&
        fresh.ok &&
        approvalStillValid.ok &&
        issuer.hasClaimedTransportGrant(binding.exactPayloadHash, now) &&
        sourceIsCurrent()
      );
    }

    const guardedRequest: typeof fetch = async (url, init) => {
      const requestUrl =
        typeof url === "string"
          ? url
          : url instanceof URL
            ? url.toString()
            : url.url;
      const method = (
        init?.method ?? (url instanceof Request ? url.method : "GET")
      ).toUpperCase();
      if (method === "GET") return request(url, init);
      const parsedUrl = new URL(requestUrl);
      const body = typeof init?.body === "string" ? init.body : "";
      if (
        method !== "POST" ||
        parsedUrl.origin !== "https://api.bybit.com" ||
        parsedUrl.pathname !== CREATE_ORDER_PATH ||
        !postGrantArmed ||
        !expectedBody ||
        !currentBinding
      )
        throw new Error("Mainnet write lacks its one-use durable CREATE grant");
      postGrantArmed = false;
      if (!(await finalTransportCheck(body, parsedUrl.pathname)))
        throw new Error(
          "Mainnet CREATE failed its final source or freshness check",
        );
      issuer.markDispatched();
      return request(url, init);
    };

    const privateTransport = new BybitPrivateTransport({
      environment: "mainnet",
      credentials: loadedCredentials,
      request: guardedRequest,
      clock: wall,
    });
    privateTransportRef.current = privateTransport;
    const publicMarkets = new BybitPublicMarketClient({
      transport: new BybitPublicTransport({ request }),
    });
    const exchangeAdapter = new BybitMainnetExecutionAdapter({
      transport: privateTransport,
      clock: localClock,
    });
    const evidence: MainnetOperatorTestEvidencePort = {
      collect: async (symbol) => {
        if (symbol !== admitted.plan.symbol)
          throw new Error("operator source symbol mismatch");
        try {
          compactAccount = await collectCompactOperatorAccountEvidence(
            accountReader.reader,
            loadedCredentials,
          );
          const feeResponse = await accountReader.transport.get(
            ACCOUNT_FEE_RATE_PATH,
            {
              category: "linear",
              symbol,
            },
          );
          const feeRate = extractOperatorFeeRate(feeResponse, symbol);
          if (!feeRate.ok)
            throw new CompactAccountEvidenceUnavailable(
              "FEE_RATE_RESPONSE_INVALID",
            );
          const accountAdmission = validateCompactOperatorAccountForPlan(
            admitted.plan,
            compactAccount,
            feeRate.value.observedAt,
          );
          if (!accountAdmission.ok) {
            const reasonCode = accountAdmission.error.details?.reasonCode;
            const code =
              typeof reasonCode === "string"
                ? reasonCode
                : "ACCOUNT_EVIDENCE_INVALID";
            if (
              [
                "CRITICAL_STATE_CHANGED",
                "ACCOUNT_MODE_UNSUPPORTED",
                "SPOT_HEDGING_ENABLED",
                "CREDENTIAL_PERMISSION_BLOCKED",
                "ACCOUNT_READINESS_OR_IDENTITY_BLOCKED",
              ].includes(code)
            )
              throw new OperatorEvidenceReadError(
                code,
                accountAdmission.error.details ?? {},
              );
            throw new CompactAccountEvidenceUnavailable(code);
          }
          const capacity =
            calculateOperatorMainnetTestCapacityFromAvailableBalance(
              admitted.plan,
              accountAdmission.value.availableBalance,
              feeRate.value,
            );
          if (!capacity.ok) {
            const reasonCode = capacity.error.details?.reasonCode;
            if (reasonCode === "AVAILABLE_MARGIN_OR_FEE_RESERVE_INSUFFICIENT")
              throw new OperatorEvidenceReadError(
                reasonCode,
                capacity.error.details ?? {},
              );
            throw new CompactAccountEvidenceUnavailable(
              typeof reasonCode === "string"
                ? reasonCode
                : "ACCOUNT_CAPACITY_INCOMPLETE",
            );
          }

          const instrument = await new BybitMainnetReadCapabilityFacade(
            accountReader.transport,
          ).readInstrument(symbol);
          const quote = await publicMarkets.readOperatorQuote(symbol);
          const state = await exchangeAdapter.readState({ instrument: symbol });
          if (!state.ok)
            throw new CompactAccountEvidenceUnavailable(
              "TARGET_STATE_READ_FAILED",
            );
          const fresh: MainnetOperatorTestAdmissionEvidence = {
            compactAccount,
            state: state.value,
            instrument,
            quote,
            feeRate: feeRate.value,
          };
          const validated = validateMainnetOperatorTestEvidence(
            admitted.plan,
            fresh,
          );
          if (!validated.ok) {
            const reasonCode = validated.error.details?.reasonCode;
            const code =
              typeof reasonCode === "string"
                ? reasonCode
                : "FRESH_MAINNET_EVIDENCE_INVALID";
            if (
              [
                "CRITICAL_STATE_CHANGED",
                "TARGET_STATE_OR_CAPABILITY_BLOCKED",
                "TARGET_INSTRUMENT_UNSUPPORTED",
                "APPROVED_INSTRUMENT_CONSTRAINTS_CHANGED",
                "QUOTE_OUTSIDE_APPROVED_RANGE",
                "QUOTE_STALE_OR_FUTURE",
                "AVAILABLE_MARGIN_OR_FEE_RESERVE_INSUFFICIENT",
              ].includes(code)
            )
              throw new OperatorEvidenceReadError(
                code,
                validated.error.details ?? {},
              );
            throw new CompactAccountEvidenceUnavailable(code);
          }
          const evidenceAtMonotonic = monotonic();
          if (!Number.isFinite(evidenceAtMonotonic))
            throw new OperatorEvidenceReadError("MONOTONIC_CLOCK_INVALID");
          latestAdmission = {
            evidence: fresh,
            evidenceAtMonotonic,
            ages: validated.value,
          };
          return fresh;
        } catch (error) {
          if (error instanceof OperatorEvidenceReadError) throw error;
          if (!(
            error instanceof CompactAccountEvidenceUnavailable ||
            error instanceof BybitAccountReadError ||
            error instanceof BybitMainnetReadCapabilityError ||
            error instanceof BybitPublicMarketMappingError ||
            error instanceof BybitPublicTransportError ||
            error instanceof BybitPrivateTransportError
          ))
            throw new OperatorEvidenceReadError(
              "FRESH_MAINNET_EVIDENCE_UNAVAILABLE",
            );
        }

        let fullAccountTransport: BybitAccountReadTransport | undefined;
        accountResult = await collectAccountEvidence({
          environment: "mainnet",
          runId: admitted.runId,
          configuredM1Symbols: [admitted.plan.symbol],
          credentialLoader,
          utcClock: wall,
          monotonicClock: monotonic,
          createReadPort: (configuration) => {
            fullAccountTransport = new BybitAccountReadTransport({
              environment: "mainnet",
              credentials: configuration.credentials,
              budget: configuration.budget,
              request,
              clock: configuration.utcClock,
              monotonicClock: configuration.monotonicClock,
            });
            return new BybitAccountReadClient({
              transport: fullAccountTransport,
              utcClock: configuration.utcClock,
            });
          },
        });
        if (
          !accountResult ||
          accountResult.kind !== "account-evidence" ||
          !fullAccountTransport
        )
          throw new OperatorEvidenceReadError("ACCOUNT_EVIDENCE_INCOMPLETE");
        const instrument = await new BybitMainnetReadCapabilityFacade(
          fullAccountTransport,
        ).readInstrument(symbol);
        const evaluatedAt = timestampFromEpochMs(
          await fullAccountTransport.readExchangeTime(),
        );
        if (!evaluatedAt.ok)
          throw new OperatorEvidenceReadError("PROVIDER_TIME_UNAVAILABLE");
        const readiness = deriveMainnetExecutionReadiness({
          accountResult,
          symbol,
          instrument,
          evaluatedAt: evaluatedAt.value,
        });
        const { fresh, ages } = await collectOperatorAdmissionEvidence(
          admitted.plan,
          { account: accountResult.bundle, readiness, instrument },
          {
            fee: () =>
              privateTransport.get(ACCOUNT_FEE_RATE_PATH, {
                category: "linear",
                symbol,
              }),
            quote: () => publicMarkets.readOperatorQuote(symbol),
            state: () => exchangeAdapter.readState({ instrument: symbol }),
          },
        );
        const evidenceAtMonotonic = monotonic();
        if (!Number.isFinite(evidenceAtMonotonic))
          throw new OperatorEvidenceReadError("MONOTONIC_CLOCK_INVALID");
        latestAdmission = { evidence: fresh, evidenceAtMonotonic, ages };
        return fresh;
      },
    };
    const exchange = {
      async createOrder(
        requestValue: Parameters<typeof exchangeAdapter.createOrder>[0],
      ) {
        let body: string;
        try {
          body = JSON.stringify(mapCreateOrderRequest(requestValue));
        } catch {
          throw new Error("approved CREATE payload cannot be serialized");
        }
        const payloadHash = `sha256:${createHash("sha256")
          .update(body, "utf8")
          .digest("hex")}`;
        const offset = await privateTransport.getServerTimeOffset();
        const now = providerTime(wall, offset);
        if (
          !now ||
          !issuer.claimForTransport(payloadHash, now) ||
          !sourceIsCurrent()
        )
          throw new Error(
            "Mainnet CREATE lacks its consumed one-use source grant",
          );
        expectedBody = body;
        postGrantArmed = true;
        return exchangeAdapter.createOrder(requestValue);
      },
    };
    const authorization: OperatorMainnetTestAuthorizationPort = {
      issue: async (binding) => {
        currentBinding = binding;
        return issuer.authorization.issue(binding);
      },
      consume: issuer.authorization.consume,
    };

    const result = await executeMainnetOperatorTest(input, {
      persistence: sqlite,
      journal: operatorJournal,
      exchange,
      evidence,
      authorization,
      localClock,
      monotonicClock: monotonic,
    });
    return result.ok
      ? {
          ok: true,
          value: {
            ...result.value,
            exchangeReads,
            exchangeWrites,
            exchangeGetCounts: getCounts.summary(),
          },
        }
      : withCounts(result, exchangeReads, exchangeWrites);
  } catch {
    return withCounts(
      failed("MAINNET_OPERATOR_TEST_FAILED_CLOSED"),
      exchangeReads,
      exchangeWrites,
    );
  } finally {
    persistence.value.close();
  }
}
