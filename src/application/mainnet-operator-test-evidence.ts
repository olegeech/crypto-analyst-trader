import type { BybitResponse } from "../adapters/bybit-v5/transport.js";
import {
  mapAccountInfo,
  mapAccountWallet,
} from "../adapters/bybit-v5/account-read-mappers.js";
import { mapAccountReadIdentity } from "../adapters/bybit-v5/account-key-mapper.js";
import { BybitAccountReadClient } from "../adapters/bybit-v5/account-read-client.js";
import {
  BybitAccountReadTransport,
  type AccountReadBudget,
} from "../adapters/bybit-v5/account-read-transport.js";
import type {
  AccountEvidenceReadPort,
  AccountReadEnvelope,
} from "../ports/account-evidence.js";
import type { ExchangeCredentials } from "../ports/credential-provider.js";
import type { OperatorMainnetTestPlan } from "../domain/execution/operator-mainnet-test-plan.js";
import { DecimalValue } from "../domain/shared/decimal.js";
import { domainError } from "../domain/shared/errors.js";
import { fail } from "../domain/shared/result.js";
import {
  parseUtcTimestamp,
  timestampFromEpochMs,
  type UtcTimestamp,
} from "../domain/shared/time.js";
import { ACCOUNT_EVIDENCE_COLLECTION_POLICY } from "../domain/account/account-evidence-policy.js";
import type { MainnetExchangeExecutionPort } from "../ports/exchange-execution.js";
import {
  createOperatorMainnetFeeRateEvidence,
  OPERATOR_MAINNET_DIRECT_ACCOUNT_SCHEMA_VERSION,
  OPERATOR_MAINNET_COMPACT_ACCOUNT_SCHEMA_VERSION,
  type MainnetOperatorTestCompactAccountEvidence,
  type MainnetOperatorTestDirectAccountEvidence,
  type MainnetOperatorTestCompactAccountObservation,
  validateMainnetOperatorTestEvidence,
  type MainnetOperatorTestFreshEvidence,
} from "./mainnet-entry-evidence.js";
import type { AccountEvidencePartition } from "../domain/account/account-evidence-policy.js";

/** Only code-owned diagnostics cross the collection boundary; never provider messages. */
export class OperatorEvidenceReadError extends Error {
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    readonly reasonCode: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super("operator admission evidence unavailable");
    const allowed = new Set([
      "availableBalance",
      "orderNotional",
      "entryFeeReserve",
      "exitFeeReserve",
      "totalReserve",
      "requiredAvailableBalance",
      "shortfall",
      "criticalChangedGroups",
      "pass",
      "group",
      "predicate",
      "causeCode",
      "source",
      "ageMs",
      "futureByMs",
      "limitMs",
      "collectionFutureByMs",
      "quoteBid",
      "approvedBidLower",
      "approvedBidUpper",
      "quoteObservedAt",
      "allowedDeviationBps",
      "positionSide",
      "positionQuantity",
      "activeOrderCount",
      "leverage",
      "leverageBuy",
      "leverageSell",
      "leverageEffective",
      "readOnly",
      "contractOrder",
      "contractPosition",
      "walletTransfer",
      "withdraw",
      "utaStatus",
      "marginMode",
      "spotHedging",
      "changedConstraint",
    ]);
    const safe: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(details)) {
      if (!allowed.has(key)) continue;
      if (
        [
          "availableBalance",
          "orderNotional",
          "entryFeeReserve",
          "exitFeeReserve",
          "totalReserve",
          "requiredAvailableBalance",
          "shortfall",
          "quoteBid",
          "approvedBidLower",
          "approvedBidUpper",
          "allowedDeviationBps",
          "positionQuantity",
          "leverage",
          "leverageBuy",
          "leverageSell",
          "leverageEffective",
        ].includes(key)
      ) {
        if (
          typeof value === "string" &&
          /^(?:0|[1-9]\d{0,19})(?:\.\d{1,18})?$/u.test(value)
        )
          safe[key] = value;
      } else if (key === "criticalChangedGroups") {
        if (
          typeof value === "string" &&
          /^(?:account|assets|collateral|orders|positions|modeProbes|discovery|UNESTABLISHED)(?:,(?:account|assets|collateral|orders|positions|modeProbes|discovery|UNESTABLISHED))*$/u.test(
            value,
          )
        )
          safe[key] = value;
      } else if (key === "causeCode") {
        if (typeof value === "string" && /^[A-Z][A-Z0-9_]{0,99}$/u.test(value))
          safe[key] = value;
      } else if (key === "source") {
        if (
          typeof value === "string" &&
          /^(?:account|balance|quote|fee|instrument|position|orders|target-state|provider-time)$/u.test(
            value,
          )
        )
          safe[key] = value;
      } else if (
        key === "pass" &&
        (value === "A" || value === "B" || value === "A/B")
      ) {
        safe[key] = value;
      } else if (
        key === "group" &&
        (value === "account" || value === "positions" || value === "orders")
      ) {
        safe[key] = value;
      } else if (
        key === "predicate" &&
        [
          "totalAvailableBalance",
          "identity",
          "account-mode",
          "wallet-observation",
          "critical-pass",
          "account-mode",
          "position-size",
          "position-value",
          "position-margin",
          "position-leverage",
          "order-leaves-quantity",
          "order-price",
        ].includes(value as string)
      ) {
        safe[key] = value;
      } else if (
        [
          "ageMs",
          "futureByMs",
          "limitMs",
          "collectionFutureByMs",
          "activeOrderCount",
          "utaStatus",
        ].includes(key) &&
        typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= 0
      ) {
        safe[key] = value;
      } else if (
        [
          "readOnly",
          "contractOrder",
          "contractPosition",
          "walletTransfer",
          "withdraw",
          "spotHedging",
        ].includes(key) &&
        typeof value === "boolean"
      ) {
        safe[key] = value;
      } else if (key === "positionSide") {
        if (value === "flat" || value === "long" || value === "short")
          safe[key] = value;
      } else if (key === "marginMode") {
        if (value === "REGULAR_MARGIN" || value === "PORTFOLIO_MARGIN")
          safe[key] = value;
      } else if (key === "changedConstraint") {
        if (
          typeof value === "string" &&
          [
            "instrument",
            "version",
            "priceTickSize",
            "quantityStep",
            "minQuantity",
            "minNotional",
            "minPrice",
            "maxPrice",
            "maxLimitQuantity",
            "constraintSet",
          ].includes(value)
        )
          safe[key] = value;
      } else if (key === "quoteObservedAt") {
        const timestamp = parseUtcTimestamp(value);
        if (timestamp.ok) safe[key] = timestamp.value;
      }
    }
    this.details = Object.freeze(safe);
  }
}

export class CompactAccountEvidenceUnavailable extends Error {
  constructor(readonly reasonCode: string) {
    super("compact operator account evidence unavailable");
    this.name = "CompactAccountEvidenceUnavailable";
  }
}

export type CompactOperatorAccountIdentity = ReturnType<
  typeof mapAccountReadIdentity
>;

export function createCompactOperatorAccountReader(options: {
  readonly credentials: ExchangeCredentials;
  readonly request: typeof fetch;
  readonly utcClock: () => number;
  readonly monotonicClock: () => number;
}) {
  const budget: AccountReadBudget = {
    deadline:
      options.monotonicClock() +
      ACCOUNT_EVIDENCE_COLLECTION_POLICY.maxCollectionDurationMs,
    attempts: 0,
    maxAttempts: ACCOUNT_EVIDENCE_COLLECTION_POLICY.maxHttpAttempts,
    maxResponseBytes: ACCOUNT_EVIDENCE_COLLECTION_POLICY.maxResponseBytes,
    maxObservedResponseBytes: 0,
  };
  const transport = new BybitAccountReadTransport({
    environment: "mainnet",
    credentials: options.credentials,
    budget,
    request: options.request,
    clock: options.utcClock,
    monotonicClock: options.monotonicClock,
  });
  const reader = new BybitAccountReadClient({
    transport,
    utcClock: options.utcClock,
  });
  return { transport, reader };
}

function accountPartition(
  endpoint: "account-info" | "wallet",
  pass: "A" | "B",
): AccountEvidencePartition {
  return {
    endpoint,
    pass,
    category: null,
    settleCoin: null,
    baseCoin: null,
    symbol: null,
  };
}

async function compactPartitionSample(
  reader: AccountEvidenceReadPort,
  endpoint: "account-info" | "wallet",
  pass: "A" | "B",
) {
  const sample = await reader.readPartition(accountPartition(endpoint, pass));
  if (
    sample.coverage.status !== "traversed" ||
    sample.coverage.reasonCodes.length !== 0 ||
    sample.responses.length !== 1 ||
    sample.observation?.timeProvenance !== "response-envelope" ||
    sample.observation.exchangeResponseTime === null
  )
    throw new CompactAccountEvidenceUnavailable(
      endpoint === "wallet"
        ? `WALLET_${pass}_OBSERVATION_MISSING`
        : "ACCOUNT_EVIDENCE_INVALID",
    );
  return {
    response: sample.responses[0]!,
    observedAt: sample.observation.exchangeResponseTime,
  };
}

async function readDirectAccountMode(
  reader: AccountEvidenceReadPort,
  fallbackObservedAt: UtcTimestamp,
): Promise<{
  readonly mode: MainnetOperatorTestCompactAccountObservation["mode"];
  readonly observedAt: UtcTimestamp;
}> {
  const sample = await directPartitionSample(reader, "account-info");
  return {
    mode: mapAccountInfo(sample.response),
    observedAt: sample.observedAt ?? fallbackObservedAt,
  };
}

async function readDirectAccountBalance(
  reader: AccountEvidenceReadPort,
  fallbackObservedAt: UtcTimestamp,
): Promise<{
  readonly availableBalance: DecimalValue;
  readonly observedAt: UtcTimestamp;
}> {
  const sample = await directPartitionSample(reader, "wallet");
  const balance = mapAccountWallet(sample.response).totals
    .totalAvailableBalance;
  if (balance.state !== "known" || balance.unit !== "USD")
    throw new CompactAccountEvidenceUnavailable("WALLET_BALANCE_UNPROVEN");
  return {
    availableBalance: balance.value,
    observedAt: sample.observedAt ?? fallbackObservedAt,
  };
}

async function directPartitionSample(
  reader: AccountEvidenceReadPort,
  endpoint: "account-info" | "wallet",
) {
  const sample = await reader.readPartition(accountPartition(endpoint, "A"));
  if (
    sample.coverage.status !== "traversed" ||
    sample.coverage.reasonCodes.length !== 0 ||
    sample.responses.length !== 1 ||
    !sample.observation
  )
    throw new CompactAccountEvidenceUnavailable(
      endpoint === "wallet"
        ? "WALLET_A_OBSERVATION_MISSING"
        : "ACCOUNT_EVIDENCE_INVALID",
    );
  return {
    response: sample.responses[0]!,
    observedAt: sample.observation.exchangeResponseTime ?? undefined,
  };
}

async function readDirectAccountFacts(
  reader: AccountEvidenceReadPort,
  requested: { readonly mode: boolean; readonly balance: boolean },
) {
  const beforeMs = await reader.readExchangeTime();
  const before = timestampFromEpochMs(beforeMs);
  if (!before.ok)
    throw new CompactAccountEvidenceUnavailable("PROVIDER_TIME_UNAVAILABLE");
  const [mode, balance] = await Promise.all([
    requested.mode ? readDirectAccountMode(reader, before.value) : undefined,
    requested.balance
      ? readDirectAccountBalance(reader, before.value)
      : undefined,
  ]);
  const afterMs = await reader.readExchangeTime();
  const after = timestampFromEpochMs(afterMs);
  if (!after.ok || afterMs < beforeMs)
    throw new CompactAccountEvidenceUnavailable("PROVIDER_TIME_INVALID");
  // Exact provider response times remain authoritative. For endpoints that
  // omit them, before.value is a conservative provider-side lower bound for
  // the facts collected after it; no local time is substituted.
  return { mode, balance };
}

/** One account-wide mode read and one account-wide available-balance read for direct v3. */
export async function collectDirectTradeAccountEvidence(
  reader: AccountEvidenceReadPort,
  credentials: ExchangeCredentials,
  verifiedIdentity?: CompactOperatorAccountIdentity,
): Promise<MainnetOperatorTestDirectAccountEvidence> {
  try {
    const identity =
      verifiedIdentity ??
      (await readCompactOperatorAccountIdentity(reader, credentials));
    const { mode, balance } = await readDirectAccountFacts(reader, {
      mode: true,
      balance: true,
    });
    if (!mode || !balance)
      throw new CompactAccountEvidenceUnavailable("ACCOUNT_EVIDENCE_INVALID");
    return Object.freeze({
      schemaVersion: OPERATOR_MAINNET_DIRECT_ACCOUNT_SCHEMA_VERSION,
      accountBinding: identity.accountBinding,
      credentialPosture: identity.credentialPosture,
      observations: Object.freeze([
        Object.freeze({
          mode: mode.mode,
          availableBalance: balance.availableBalance,
          modeObservedAt: mode.observedAt,
          balanceObservedAt: balance.observedAt,
        }),
      ]) as readonly [MainnetOperatorTestCompactAccountObservation],
    });
  } catch (error) {
    if (error instanceof CompactAccountEvidenceUnavailable) throw error;
    throw new CompactAccountEvidenceUnavailable(
      error instanceof Error &&
        "code" in error &&
        typeof error.code === "string"
        ? error.code
        : error instanceof Error &&
            "reasonCode" in error &&
            typeof error.reasonCode === "string"
          ? error.reasonCode
          : "ACCOUNT_EVIDENCE_INVALID",
    );
  }
}

export interface DirectTradeAccountRefreshNeeds {
  readonly identity?: true;
  readonly mode?: true;
  readonly balance?: true;
}

/** Refreshes only named direct-v3 facts, once each; it never starts a full scan. */
export async function refreshDirectTradeAccountEvidence(
  reader: AccountEvidenceReadPort,
  credentials: ExchangeCredentials,
  current: MainnetOperatorTestDirectAccountEvidence,
  needs: DirectTradeAccountRefreshNeeds,
): Promise<MainnetOperatorTestDirectAccountEvidence> {
  if (
    current.schemaVersion !== OPERATOR_MAINNET_DIRECT_ACCOUNT_SCHEMA_VERSION ||
    current.observations.length !== 1
  )
    throw new CompactAccountEvidenceUnavailable("DIRECT_ACCOUNT_PROOF_INVALID");
  const previous = current.observations[0]!;
  try {
    const [identity, facts] = await Promise.all([
      needs.identity
        ? readCompactOperatorAccountIdentity(reader, credentials)
        : Promise.resolve(undefined),
      needs.mode || needs.balance
        ? readDirectAccountFacts(reader, {
            mode: needs.mode === true,
            balance: needs.balance === true,
          })
        : Promise.resolve({ mode: undefined, balance: undefined }),
    ]);
    const { mode, balance } = facts;
    return Object.freeze({
      schemaVersion: OPERATOR_MAINNET_DIRECT_ACCOUNT_SCHEMA_VERSION,
      accountBinding: identity?.accountBinding ?? current.accountBinding,
      credentialPosture:
        identity?.credentialPosture ?? current.credentialPosture,
      observations: Object.freeze([
        Object.freeze({
          mode: mode?.mode ?? previous.mode,
          availableBalance:
            balance?.availableBalance ?? previous.availableBalance,
          modeObservedAt: mode?.observedAt ?? previous.modeObservedAt,
          balanceObservedAt: balance?.observedAt ?? previous.balanceObservedAt,
        }),
      ]) as readonly [MainnetOperatorTestCompactAccountObservation],
    });
  } catch (error) {
    if (error instanceof CompactAccountEvidenceUnavailable) throw error;
    throw new CompactAccountEvidenceUnavailable(
      error instanceof Error &&
        "code" in error &&
        typeof error.code === "string"
        ? error.code
        : "ACCOUNT_EVIDENCE_REFRESH_FAILED",
    );
  }
}

/** Reads only the bounded #31 identity, account-mode, and account-wide capacity facts. */
export async function collectCompactOperatorAccountEvidence(
  reader: AccountEvidenceReadPort,
  credentials: ExchangeCredentials,
  verifiedIdentity?: CompactOperatorAccountIdentity,
): Promise<MainnetOperatorTestCompactAccountEvidence> {
  try {
    const verified =
      verifiedIdentity ??
      (await readCompactOperatorAccountIdentity(reader, credentials));

    const accountA = await compactPartitionSample(reader, "account-info", "A");
    const accountB = await compactPartitionSample(reader, "account-info", "B");
    const walletA = await compactPartitionSample(reader, "wallet", "A");
    const walletB = await compactPartitionSample(reader, "wallet", "B");
    const modeA = mapAccountInfo(accountA.response);
    const modeB = mapAccountInfo(accountB.response);
    const totalsA = mapAccountWallet(walletA.response).totals;
    const totalsB = mapAccountWallet(walletB.response).totals;
    const balanceA = totalsA.totalAvailableBalance;
    const balanceB = totalsB.totalAvailableBalance;
    if (balanceA.state !== "known" || balanceA.unit !== "USD")
      throw new CompactAccountEvidenceUnavailable("WALLET_A_BALANCE_UNPROVEN");
    if (balanceB.state !== "known" || balanceB.unit !== "USD")
      throw new CompactAccountEvidenceUnavailable("WALLET_B_BALANCE_UNPROVEN");

    return Object.freeze({
      schemaVersion: OPERATOR_MAINNET_COMPACT_ACCOUNT_SCHEMA_VERSION,
      accountBinding: verified.accountBinding,
      credentialPosture: verified.credentialPosture,
      observations: Object.freeze([
        Object.freeze({
          mode: modeA,
          availableBalance: balanceA.value,
          modeObservedAt: accountA.observedAt,
          balanceObservedAt: walletA.observedAt,
        }),
        Object.freeze({
          mode: modeB,
          availableBalance: balanceB.value,
          modeObservedAt: accountB.observedAt,
          balanceObservedAt: walletB.observedAt,
        }),
      ]) as readonly [
        MainnetOperatorTestCompactAccountObservation,
        MainnetOperatorTestCompactAccountObservation,
      ],
    });
  } catch (error) {
    if (error instanceof CompactAccountEvidenceUnavailable) throw error;
    throw new CompactAccountEvidenceUnavailable(
      error instanceof Error &&
        "code" in error &&
        typeof error.code === "string"
        ? error.code
        : error instanceof Error &&
            "reasonCode" in error &&
            typeof error.reasonCode === "string"
          ? error.reasonCode
          : "ACCOUNT_EVIDENCE_INVALID",
    );
  }
}

/** Reads the authenticated identity once so v3 can freeze its plan before account/venue state. */
export async function readCompactOperatorAccountIdentity(
  reader: AccountEvidenceReadPort,
  credentials: ExchangeCredentials,
): Promise<CompactOperatorAccountIdentity> {
  try {
    const identity = await reader.readIdentity();
    const identityAt =
      identity.time === undefined
        ? timestampFromEpochMs(await reader.readExchangeTime())
        : timestampFromEpochMs(identity.time);
    if (!identityAt.ok)
      throw new CompactAccountEvidenceUnavailable("ACCOUNT_EVIDENCE_INVALID");
    return mapAccountReadIdentity(
      identity,
      credentials.accountId,
      "mainnet",
      identityAt.value,
    );
  } catch (error) {
    if (error instanceof CompactAccountEvidenceUnavailable) throw error;
    throw new CompactAccountEvidenceUnavailable(
      error instanceof Error &&
        "code" in error &&
        typeof error.code === "string"
        ? error.code
        : "ACCOUNT_EVIDENCE_INVALID",
    );
  }
}

export function extractOperatorFeeRate(
  response: BybitResponse | AccountReadEnvelope,
  symbol: string,
) {
  const invalid = () =>
    fail(
      domainError("INVALID_EVIDENCE", "fee-rate response is invalid", {
        reasonCode: "FEE_RATE_RESPONSE_INVALID",
      }),
    );
  const responseRecord = response as {
    readonly result: Record<string, unknown>;
    readonly time?: number;
    readonly retCode?: number;
  };
  const rawRows = responseRecord.result?.list;
  const rows =
    Array.isArray(rawRows) &&
    rawRows.every(
      (row) => typeof row === "object" && row !== null && !Array.isArray(row),
    )
      ? (rawRows as readonly Record<string, unknown>[])
      : undefined;
  if (
    !rows ||
    rows.length !== 1 ||
    (responseRecord.retCode !== undefined && responseRecord.retCode !== 0) ||
    responseRecord.time === undefined ||
    !Number.isSafeInteger(responseRecord.time) ||
    responseRecord.time <= 0
  )
    return invalid();
  const row = rows[0];
  if (
    !row ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(row)) ||
    !Object.values(Object.getOwnPropertyDescriptors(row)).every((d) =>
      Object.hasOwn(d, "value"),
    ) ||
    row.symbol !== symbol ||
    typeof row.makerFeeRate !== "string" ||
    typeof row.takerFeeRate !== "string"
  )
    return invalid();
  // RPI orders are not used by this flow. Validate the optional rate, including
  // rebates. Bybit also returns an empty string when this optional rate is
  // unavailable; normal maker/taker rates still own the capital reserve.
  if (Object.hasOwn(row, "rpiMakerFeeRate") && row.rpiMakerFeeRate !== "") {
    const rpi = DecimalValue.fromString(row.rpiMakerFeeRate);
    const lower = DecimalValue.fromString("-1");
    const upper = DecimalValue.fromString("1");
    if (
      !rpi.ok ||
      !lower.ok ||
      !upper.ok ||
      rpi.value.compare(lower.value) <= 0 ||
      rpi.value.compare(upper.value) >= 0
    )
      return invalid();
  }
  const observedAt = timestampFromEpochMs(responseRecord.time);
  if (!observedAt.ok) return invalid();
  const result = createOperatorMainnetFeeRateEvidence({
    schemaVersion: "bybit-mainnet-operator-fee-rate/v1",
    symbol,
    makerFeeRate: row.makerFeeRate,
    takerFeeRate: row.takerFeeRate,
    observedAt: observedAt.value,
  });
  return result.ok ? result : invalid();
}

async function readStage<T>(
  code: string,
  source: "fee" | "quote" | "target-state",
  read: () => Promise<T>,
): Promise<T> {
  try {
    return await read();
  } catch {
    throw new OperatorEvidenceReadError(code, { source });
  }
}

/** Shared by production admission and GET-only diagnostics; this module has no write authority. */
export async function collectOperatorAdmissionEvidence(
  plan: OperatorMainnetTestPlan,
  base: Pick<
    MainnetOperatorTestFreshEvidence,
    "account" | "readiness" | "instrument"
  >,
  reads: {
    readonly fee: () => Promise<BybitResponse>;
    readonly quote: () => Promise<MainnetOperatorTestFreshEvidence["quote"]>;
    readonly state: () => ReturnType<MainnetExchangeExecutionPort["readState"]>;
  },
) {
  const response = await readStage("FEE_RATE_READ_FAILED", "fee", reads.fee);
  const feeRate = extractOperatorFeeRate(response, plan.symbol);
  if (!feeRate.ok)
    throw new OperatorEvidenceReadError("FEE_RATE_RESPONSE_INVALID", {
      source: "fee",
    });
  const quote = await readStage("QUOTE_READ_FAILED", "quote", reads.quote);
  const state = await readStage(
    "TARGET_STATE_READ_FAILED",
    "target-state",
    reads.state,
  );
  if (!state.ok)
    throw new OperatorEvidenceReadError("TARGET_STATE_READ_FAILED", {
      source: "target-state",
    });
  const fresh: MainnetOperatorTestFreshEvidence = {
    ...base,
    quote,
    state: state.value,
    feeRate: feeRate.value,
  };
  const validated = validateMainnetOperatorTestEvidence(plan, fresh);
  if (!validated.ok) {
    const code = validated.error.details?.reasonCode;
    throw new OperatorEvidenceReadError(
      typeof code === "string" && /^[A-Z][A-Z0-9_]{0,99}$/u.test(code)
        ? code
        : "ADMISSION_EVIDENCE_INVALID",
      validated.error.details ?? {},
    );
  }
  return { fresh, ages: validated.value };
}
