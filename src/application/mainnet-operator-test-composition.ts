import { createHash } from "node:crypto";

import { createMacOSKeychainProvider } from "../adapters/macos-keychain.js";
import { BybitAccountReadTransport } from "../adapters/bybit-v5/account-read-transport.js";
import { BybitAccountReadClient } from "../adapters/bybit-v5/account-read-client.js";
import { BybitMainnetExecutionAdapter } from "../adapters/bybit-v5/execution-adapter.js";
import { mapCreateOrderRequest } from "../adapters/bybit-v5/order-mappers.js";
import {
  BybitPrivateTransport,
  responseList,
} from "../adapters/bybit-v5/transport.js";
import { BybitPublicMarketClient } from "../adapters/bybit-v5/public-market-client.js";
import { BybitPublicTransport } from "../adapters/bybit-v5/public-transport.js";
import { BybitMainnetReadCapabilityFacade } from "../adapters/bybit-v5/read-capability-facade.js";
import type { BybitInstrumentInfo } from "../adapters/bybit-v5/read-mappers.js";
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
  createOperatorMainnetFeeRateEvidence,
  revalidateMainnetOperatorEvidenceAge,
  validateMainnetOperatorTestEvidence,
  type MainnetOperatorTestEvidencePort,
  type MainnetOperatorTestFreshEvidence,
} from "./mainnet-entry-evidence.js";
import { deriveMainnetExecutionReadiness } from "./mainnet-execution-readiness.js";
import {
  snapshotExchangeCredentials,
  withExchangeCounts,
} from "./mainnet-composition-helpers.js";

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
        requireIdentifier(binding.leaseOwnerRunId, "leaseOwnerRunId"),
      ];
      const expiry = parseUtcTimestamp(binding.expiresAt);
      if (
        hashes.some((item) => !item.ok) ||
        identifiers.some((item) => !item.ok) ||
        !expiry.ok ||
        !Number.isSafeInteger(binding.leaseEpoch) ||
        binding.leaseEpoch < 1
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

function plainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every((property) =>
      Object.hasOwn(property, "value"),
    )
  );
}

function extractFeeRate(
  response: Awaited<ReturnType<BybitPrivateTransport["get"]>>,
  symbol: string,
) {
  const rows = responseList(response);
  if (
    !rows ||
    rows.length !== 1 ||
    response.time === undefined ||
    !Number.isSafeInteger(response.time) ||
    response.time <= 0
  )
    return undefined;
  const row = rows[0];
  if (
    !row ||
    !plainObject(row) ||
    Reflect.ownKeys(row).length !== 3 ||
    row.symbol !== symbol ||
    typeof row.makerFeeRate !== "string" ||
    typeof row.takerFeeRate !== "string"
  )
    return undefined;
  const observedAt = timestampFromEpochMs(response.time);
  if (!observedAt.ok) return undefined;
  const fee = createOperatorMainnetFeeRateEvidence({
    schemaVersion: "bybit-mainnet-operator-fee-rate/v1",
    symbol,
    makerFeeRate: row.makerFeeRate,
    takerFeeRate: row.takerFeeRate,
    observedAt: observedAt.value,
  });
  return fee.ok ? fee.value : undefined;
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
  let exchangeReads = 0;
  let exchangeWrites = 0;
  const normalized = inputIdentity(input);
  if (!normalized)
    return withExchangeCounts(
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
    return withExchangeCounts(persistence, exchangeReads, exchangeWrites);
  try {
    const sqlite = persistence.value;
    const journal = sqlite.operatorMainnetTest;
    if (!journal)
      return withExchangeCounts(
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
      if (method === "GET") exchangeReads += 1;
      else if (method === "POST") exchangeWrites += 1;
      else throw new Error("operator composition permits GET and CREATE only");
      return fetch(url, init);
    };
    let accountTransport: BybitAccountReadTransport | undefined;
    const accountResult: AccountEvidenceCollectionResult =
      await collectAccountEvidence({
        environment: "mainnet",
        runId: admitted.runId,
        configuredM1Symbols: [admitted.plan.symbol],
        credentialLoader,
        utcClock: wall,
        monotonicClock: monotonic,
        createReadPort: (configuration) => {
          accountTransport = new BybitAccountReadTransport({
            environment: "mainnet",
            credentials: configuration.credentials,
            budget: configuration.budget,
            request,
            clock: configuration.utcClock,
            monotonicClock: configuration.monotonicClock,
          });
          return new BybitAccountReadClient({
            transport: accountTransport,
            utcClock: configuration.utcClock,
          });
        },
      });
    if (
      accountResult.kind !== "account-evidence" ||
      !credentialSnapshot ||
      !accountTransport
    )
      return withExchangeCounts(
        failed("ACCOUNT_EVIDENCE_INCOMPLETE"),
        exchangeReads,
        exchangeWrites,
      );

    const instrument: BybitInstrumentInfo =
      await new BybitMainnetReadCapabilityFacade(
        accountTransport,
      ).readInstrument(admitted.plan.symbol);
    const evaluatedAtMs = await accountTransport.readExchangeTime();
    const evaluatedAt = timestampFromEpochMs(evaluatedAtMs);
    if (!evaluatedAt.ok)
      return withExchangeCounts(
        failed("PROVIDER_TIME_UNAVAILABLE"),
        exchangeReads,
        exchangeWrites,
      );
    const readiness = deriveMainnetExecutionReadiness({
      accountResult,
      symbol: admitted.plan.symbol,
      instrument,
      evaluatedAt: evaluatedAt.value,
    });

    let latestAdmission:
      | {
          readonly evidence: MainnetOperatorTestFreshEvidence;
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

    function localNow(): UtcTimestamp | undefined {
      try {
        const parsed = timestampFromEpochMs(wall());
        return parsed.ok ? parsed.value : undefined;
      } catch {
        return undefined;
      }
    }

    function sourceAndFenceAreCurrent(): boolean {
      const binding = currentBinding;
      if (!binding) return false;
      const snapshot = sqlite.readScopeSnapshot();
      const source = operatorJournal.readOperatorMainnetTestSource(
        binding.sourceId,
      );
      if (!snapshot.ok || !source.ok || !source.value) return false;
      const lease = snapshot.value.lease;
      const now = localNow();
      return Boolean(
        lease &&
        now &&
        lease.ownerRunId === binding.leaseOwnerRunId &&
        lease.epoch === binding.leaseEpoch &&
        !lease.reconciliationRequired &&
        timestampToEpochMs(now) < timestampToEpochMs(lease.expiresAt) &&
        !snapshot.value.halt.active &&
        !snapshot.value.halt.reconciliationRequired &&
        source.value.intent.operation === "CREATE" &&
        source.value.intent.runId === binding.leaseOwnerRunId &&
        source.value.intent.leaseOwnerRunId === binding.leaseOwnerRunId &&
        source.value.intent.leaseEpoch === binding.leaseEpoch &&
        source.value.source.payloadHash === binding.exactPayloadHash &&
        source.value.attempt === undefined,
      );
    }

    async function finalTransportFence(
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
        sourceAndFenceAreCurrent()
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
      if (!(await finalTransportFence(body, parsedUrl.pathname)))
        throw new Error(
          "Mainnet CREATE failed its final source, lease or freshness fence",
        );
      issuer.markDispatched();
      return request(url, init);
    };

    const privateTransport = new BybitPrivateTransport({
      environment: "mainnet",
      credentials: credentialSnapshot,
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
        const feeResponse = await privateTransport.get(ACCOUNT_FEE_RATE_PATH, {
          category: "linear",
          symbol,
        });
        const feeRate = extractFeeRate(feeResponse, symbol);
        if (!feeRate) throw new Error("symbol fee-rate evidence unavailable");
        const quote = await publicMarkets.readOperatorQuote(symbol);
        const state = await exchangeAdapter.readState({ instrument: symbol });
        if (!state.ok)
          throw new Error("current Mainnet target state unavailable");
        const fresh: MainnetOperatorTestFreshEvidence = {
          account: accountResult.bundle,
          readiness,
          state: state.value,
          instrument,
          quote,
          feeRate,
        };
        const validated = validateMainnetOperatorTestEvidence(
          admitted.plan,
          fresh,
        );
        const evidenceAtMonotonic = monotonic();
        if (!validated.ok || !Number.isFinite(evidenceAtMonotonic))
          throw new Error(
            "current Mainnet evidence did not pass the operator gate",
          );
        latestAdmission = {
          evidence: fresh,
          evidenceAtMonotonic,
          ages: validated.value,
        };
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
          !sourceAndFenceAreCurrent()
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
          value: { ...result.value, exchangeReads, exchangeWrites },
        }
      : withExchangeCounts(result, exchangeReads, exchangeWrites);
  } catch {
    return withExchangeCounts(
      failed("MAINNET_OPERATOR_TEST_FAILED_CLOSED"),
      exchangeReads,
      exchangeWrites,
    );
  } finally {
    persistence.value.close();
  }
}
