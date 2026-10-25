import { changedAccountCriticalGroups } from "../domain/account/account-evidence-consistency.js";
import { createHash } from "node:crypto";

import {
  createAccountBinding,
  createAccountCredentialPosture,
  type AccountBinding,
  type AccountCredentialPosture,
  type AccountEvidenceBundle,
  type AccountModeEvidence,
} from "../domain/account/account-evidence-bundle.js";
import {
  accountEvidenceContentHash,
  createAccountEvidenceBundle,
} from "../domain/account/account-evidence-bundle.js";
import { requireTrustedCapability } from "../domain/capabilities/capability.js";
import {
  validateOperatorMainnetQuoteForPlan,
  rehydrateOperatorMainnetQuote,
  OPERATOR_MAINNET_QUOTE_FRESHNESS_MS,
  type OperatorMainnetQuote,
  type OperatorMainnetTestPlan,
} from "../domain/execution/operator-mainnet-test-plan.js";
import { createOrderIntent } from "../domain/planning/order-intent.js";
import { hashCanonical } from "../domain/identity/canonical-serialization.js";
import { DecimalValue } from "../domain/shared/decimal.js";
import {
  domainError,
  type DomainErrorDetails,
} from "../domain/shared/errors.js";
import { fail, ok, type Result } from "../domain/shared/result.js";
import {
  parseUtcTimestamp,
  timestampToEpochMs,
  type UtcTimestamp,
} from "../domain/shared/time.js";
import { isRecord, requireIdentifier } from "../domain/shared/validation.js";
import { mapCreateOrderRequest } from "../adapters/bybit-v5/order-mappers.js";
import { createInstrumentConstraints } from "../domain/market/instrument-constraints.js";
import type { InstrumentConstraints } from "../domain/market/instrument-constraints.js";
import { isProducedMarketSnapshot } from "../domain/market/snapshot-proof.js";
import type { BybitInstrumentInfo } from "../adapters/bybit-v5/read-mappers.js";
import type {
  MainnetExchangeReadState,
  ExchangeOrderRequest,
} from "../ports/exchange-execution.js";
import type { MainnetExecutionReadiness } from "./mainnet-execution-readiness.js";
import { PROVISIONAL_M1_MAX_ACCOUNT_EVIDENCE_AGE_MS } from "./policies/provisional-m1.js";

export const OPERATOR_MAINNET_FEE_RATE_SCHEMA_VERSION =
  "bybit-mainnet-operator-fee-rate/v1" as const;

export interface OperatorMainnetFeeRateEvidence {
  readonly schemaVersion: typeof OPERATOR_MAINNET_FEE_RATE_SCHEMA_VERSION;
  readonly symbol: string;
  readonly makerFeeRate: DecimalValue;
  readonly takerFeeRate: DecimalValue;
  readonly observedAt: UtcTimestamp;
}

export interface MainnetOperatorTestFreshEvidence {
  readonly account: AccountEvidenceBundle;
  readonly readiness: MainnetExecutionReadiness;
  readonly state: MainnetExchangeReadState;
  readonly instrument: BybitInstrumentInfo;
  readonly quote: OperatorMainnetQuote;
  readonly feeRate: OperatorMainnetFeeRateEvidence;
}

export const OPERATOR_MAINNET_COMPACT_ACCOUNT_SCHEMA_VERSION =
  "operator-mainnet-compact-account/v1" as const;

export interface MainnetOperatorTestCompactAccountObservation {
  readonly mode: AccountModeEvidence;
  readonly availableBalance: DecimalValue;
  readonly modeObservedAt: UtcTimestamp;
  readonly balanceObservedAt: UtcTimestamp;
}

/** Narrow, GET-only account proof for the attended #31 operator canary. */
export interface MainnetOperatorTestCompactAccountEvidence {
  readonly schemaVersion: typeof OPERATOR_MAINNET_COMPACT_ACCOUNT_SCHEMA_VERSION;
  readonly accountBinding: AccountBinding;
  readonly credentialPosture: AccountCredentialPosture;
  readonly observations: readonly [
    MainnetOperatorTestCompactAccountObservation,
    MainnetOperatorTestCompactAccountObservation,
  ];
}

export interface MainnetOperatorTestCompactFreshEvidence {
  readonly compactAccount: MainnetOperatorTestCompactAccountEvidence;
  readonly state: MainnetExchangeReadState;
  readonly instrument: BybitInstrumentInfo;
  readonly quote: OperatorMainnetQuote;
  readonly feeRate: OperatorMainnetFeeRateEvidence;
}

export type MainnetOperatorTestAdmissionEvidence =
  MainnetOperatorTestFreshEvidence | MainnetOperatorTestCompactFreshEvidence;

export interface MainnetOperatorTestEvidencePort {
  collect(symbol: string): Promise<MainnetOperatorTestAdmissionEvidence>;
}

export interface OperatorMainnetTestCapacity {
  readonly availableBalance: DecimalValue;
  readonly entryFeeReserve: DecimalValue;
  readonly exitFeeReserve: DecimalValue;
  readonly totalReserve: DecimalValue;
  readonly requiredAvailableBalance: DecimalValue;
}

export interface OperatorMainnetCreateRequest {
  readonly request: ExchangeOrderRequest;
  readonly payloadJson: string;
  readonly payloadHash: `sha256:${string}`;
}

const one = DecimalValue.fromString("1");
const zero = DecimalValue.fromString("0");

function blocked(
  code: string,
  message = "operator Mainnet admission is blocked",
  details: DomainErrorDetails = {},
) {
  return fail(
    domainError("INVALID_EVIDENCE", message, {
      reasonCode: code,
      ...details,
    }),
  );
}

function timeFailureDetails(
  source: "account" | "balance" | "quote" | "fee",
  ageMs: number,
  limitMs: number,
) {
  return ageMs < 0
    ? { source, futureByMs: -ageMs, limitMs }
    : { source, ageMs, limitMs };
}

function plainDataRecord(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every((d) =>
      Object.hasOwn(d, "value"),
    )
  );
}

export function createOperatorMainnetFeeRateEvidence(
  input: unknown,
): Result<OperatorMainnetFeeRateEvidence> {
  if (
    !plainDataRecord(input) ||
    Reflect.ownKeys(input).length !== 5 ||
    input.schemaVersion !== OPERATOR_MAINNET_FEE_RATE_SCHEMA_VERSION ||
    typeof input.symbol !== "string" ||
    !requireIdentifier(input.symbol, "symbol").ok
  )
    return blocked("FEE_RATE_INVALID");
  const makerFeeRate =
    input.makerFeeRate instanceof DecimalValue
      ? ok(input.makerFeeRate)
      : DecimalValue.fromString(input.makerFeeRate);
  const takerFeeRate =
    input.takerFeeRate instanceof DecimalValue
      ? ok(input.takerFeeRate)
      : DecimalValue.fromString(input.takerFeeRate);
  const observedAt = parseUtcTimestamp(input.observedAt);
  if (
    !makerFeeRate.ok ||
    !takerFeeRate.ok ||
    !observedAt.ok ||
    makerFeeRate.value.isNegative() ||
    !takerFeeRate.value.isPositive() ||
    makerFeeRate.value.compare(takerFeeRate.value) > 0 ||
    !one.ok ||
    takerFeeRate.value.compare(one.value) >= 0
  )
    return blocked("FEE_RATE_INVALID");
  return ok(
    Object.freeze({
      schemaVersion: OPERATOR_MAINNET_FEE_RATE_SCHEMA_VERSION,
      symbol: input.symbol,
      makerFeeRate: makerFeeRate.value,
      takerFeeRate: takerFeeRate.value,
      observedAt: observedAt.value,
    }),
  );
}

/** Construct the same validated intent that the Mainnet adapter serializes. */
export function createOperatorMainnetCreateRequest(
  plan: OperatorMainnetTestPlan,
): Result<OperatorMainnetCreateRequest> {
  if (!one.ok) return blocked("DECIMAL_CONSTANT_INVALID");
  const intent = createOrderIntent({
    intentId: plan.clientOrderId,
    instrument: plan.symbol,
    orderType: "limit",
    side: "buy",
    positionEffect: "open",
    price: plan.entry.limitPrice,
    quantity: plan.entry.quantity,
    notional: plan.effectiveGrossNotional,
    normalization: {
      price: "floor",
      quantity: "floor",
      constraintVersion: plan.constraints.version,
    },
    protection: {
      takeProfit: plan.entry.takeProfit.triggerPrice,
      takeProfitPolicy: {
        policyVersion: "m1-mainnet-per-leg-tp/v1",
        tpslMode: "Partial",
        orderType: "Market",
        triggerBy: "LastPrice",
      },
    },
  });
  if (!intent.ok) return intent;
  const request: ExchangeOrderRequest = Object.freeze({
    intent: intent.value,
    clientOrderId: plan.clientOrderId,
    timeInForce: "GTC",
    reduceOnly: false,
  });
  try {
    const payloadJson = JSON.stringify(mapCreateOrderRequest(request));
    const payloadHash = `sha256:${createHash("sha256")
      .update(payloadJson, "utf8")
      .digest("hex")}` as const;
    return ok(Object.freeze({ request, payloadJson, payloadHash }));
  } catch {
    return blocked("APPROVED_CREATE_PAYLOAD_INVALID");
  }
}

function knownUsd(fact: unknown): DecimalValue | undefined {
  if (
    !plainDataRecord(fact) ||
    fact.state !== "known" ||
    fact.unit !== "USD" ||
    !(fact.value instanceof DecimalValue) ||
    fact.value.isNegative()
  )
    return undefined;
  return fact.value;
}

function knownPositiveRate(fact: unknown): boolean {
  return (
    plainDataRecord(fact) &&
    fact.state === "known" &&
    fact.unit === "rate" &&
    fact.value instanceof DecimalValue &&
    fact.value.isPositive()
  );
}

function completeCurrentCommitments(account: AccountEvidenceBundle): boolean {
  const passes = [account.criticalPasses.A, account.criticalPasses.B];
  for (const pass of passes) {
    if (pass === null) return false;
    for (const position of pass.positions) {
      if (position.category !== "linear") continue;
      if (
        position.size.state !== "known" ||
        position.size.unit !== "contracts" ||
        position.size.value.isNegative()
      )
        return false;
      if (
        position.size.value.isPositive() &&
        (knownUsd(position.positionValue) === undefined ||
          knownUsd(position.positionIM) === undefined ||
          !knownPositiveRate(position.leverage))
      )
        return false;
    }
    for (const order of pass.orders) {
      if (order.category !== "linear") continue;
      const active = ["New", "PartiallyFilled", "Untriggered"].includes(
        order.status,
      );
      if (!active) continue;
      if (
        order.leavesQty.state !== "known" ||
        order.leavesQty.unit !== "contracts" ||
        !order.leavesQty.value.isPositive() ||
        order.price.state !== "known" ||
        !order.price.value.isPositive()
      )
        return false;
    }
  }
  return true;
}

function currentAvailableBalance(
  account: AccountEvidenceBundle,
): DecimalValue | undefined {
  const passA = account.criticalPasses.A;
  const passB = account.criticalPasses.B;
  if (!passA || !passB) return undefined;
  const availableA = knownUsd(passA.totals.totalAvailableBalance);
  const availableB = knownUsd(passB.totals.totalAvailableBalance);
  if (
    availableA === undefined ||
    availableB === undefined ||
    availableA.compare(availableB) !== 0
  )
    return undefined;
  return availableA;
}

export function calculateOperatorMainnetTestCapacity(
  plan: OperatorMainnetTestPlan,
  account: AccountEvidenceBundle,
  feeRate: OperatorMainnetFeeRateEvidence,
): Result<OperatorMainnetTestCapacity> {
  const availableBalance = currentAvailableBalance(account);
  if (availableBalance === undefined || !completeCurrentCommitments(account))
    return blocked("ACCOUNT_CAPACITY_INCOMPLETE");
  return calculateOperatorMainnetTestCapacityFromAvailableBalance(
    plan,
    availableBalance,
    feeRate,
  );
}

/** Capacity math for the bounded operator read path; the balance must already
 * be a validated USD-equivalent totalAvailableBalance from Bybit. */
export function calculateOperatorMainnetTestCapacityFromAvailableBalance(
  plan: OperatorMainnetTestPlan,
  availableBalance: DecimalValue,
  feeRate: OperatorMainnetFeeRateEvidence,
): Result<OperatorMainnetTestCapacity> {
  if (!zero.ok) return blocked("DECIMAL_CONSTANT_INVALID");
  if (
    !(availableBalance instanceof DecimalValue) ||
    availableBalance.isNegative()
  )
    return blocked("ACCOUNT_CAPACITY_INCOMPLETE");
  if (feeRate.symbol !== plan.symbol)
    return blocked("FEE_RATE_SYMBOL_MISMATCH");
  const entryFeeReserve = plan.effectiveGrossNotional.multiply(
    feeRate.takerFeeRate,
  );
  const exitGrossNotional = plan.entry.takeProfit.triggerPrice.multiply(
    plan.entry.quantity,
  );
  const exitFeeReserve = exitGrossNotional.multiply(feeRate.takerFeeRate);
  const totalReserve = entryFeeReserve.add(exitFeeReserve);
  const requiredAvailableBalance =
    plan.effectiveGrossNotional.add(totalReserve);
  if (availableBalance.compare(requiredAvailableBalance) < 0) {
    const shortfall = requiredAvailableBalance.subtract(availableBalance);
    return blocked(
      "AVAILABLE_MARGIN_OR_FEE_RESERVE_INSUFFICIENT",
      "account-wide USD-equivalent available balance is insufficient for the USDT order and fee reserve",
      {
        availableBalance: availableBalance.toString(),
        orderNotional: plan.effectiveGrossNotional.toString(),
        entryFeeReserve: entryFeeReserve.toString(),
        exitFeeReserve: exitFeeReserve.toString(),
        totalReserve: totalReserve.toString(),
        requiredAvailableBalance: requiredAvailableBalance.toString(),
        shortfall: shortfall.toString(),
      },
    );
  }
  return ok(
    Object.freeze({
      availableBalance,
      entryFeeReserve,
      exitFeeReserve,
      totalReserve,
      requiredAvailableBalance,
    }),
  );
}

function compactKnownFact<T>(
  input: unknown,
  valid: (value: unknown) => value is T,
): T | undefined {
  if (
    !plainDataRecord(input) ||
    Reflect.ownKeys(input).length !== 2 ||
    input.state !== "known" ||
    !Object.hasOwn(input, "value") ||
    !valid(input.value)
  )
    return undefined;
  return input.value;
}

function validCompactFact(
  input: unknown,
  valid: (value: unknown) => boolean,
): boolean {
  if (!plainDataRecord(input) || !Object.hasOwn(input, "state")) return false;
  if (
    input.state === "known" &&
    Reflect.ownKeys(input).length === 2 &&
    Object.hasOwn(input, "value")
  )
    return valid(input.value);
  return (
    input.state === "unavailable" &&
    Reflect.ownKeys(input).length === 2 &&
    typeof input.reason === "string" &&
    /^[a-z][a-z0-9-]{0,63}$/u.test(input.reason)
  );
}

function compactAccountMode(input: unknown): AccountModeEvidence | undefined {
  if (
    !plainDataRecord(input) ||
    Reflect.ownKeys(input).length !== 3 ||
    !Object.hasOwn(input, "utaStatus") ||
    !Object.hasOwn(input, "marginMode") ||
    !Object.hasOwn(input, "spotHedging")
  )
    return undefined;
  if (
    !validCompactFact(
      input.utaStatus,
      (value) => Number.isSafeInteger(value) && Number(value) >= 0,
    ) ||
    !validCompactFact(
      input.marginMode,
      (value) => typeof value === "string" && value.length > 0,
    ) ||
    !validCompactFact(input.spotHedging, (value) => typeof value === "boolean")
  )
    return undefined;
  return input as unknown as AccountModeEvidence;
}

function validateCompactAccountEvidence(
  plan: OperatorMainnetTestPlan | undefined,
  input: unknown,
  providerTime: UtcTimestamp,
): Result<{
  readonly availableBalance: DecimalValue;
  readonly accountAgeAtReadMs: number;
  readonly accountIdentityHash: string;
  readonly credentialPosture: AccountCredentialPosture;
}> {
  if (
    !plainDataRecord(input) ||
    Reflect.ownKeys(input).length !== 4 ||
    input.schemaVersion !== OPERATOR_MAINNET_COMPACT_ACCOUNT_SCHEMA_VERSION ||
    !Object.hasOwn(input, "accountBinding") ||
    !Object.hasOwn(input, "credentialPosture") ||
    !Object.hasOwn(input, "observations") ||
    !Array.isArray(input.observations) ||
    input.observations.length !== 2
  )
    return blocked(
      "FRESH_MAINNET_EVIDENCE_INVALID",
      "compact account evidence is malformed",
    );

  const binding = createAccountBinding(input.accountBinding);
  const posture = createAccountCredentialPosture(input.credentialPosture);
  if (!binding.ok || !posture.ok)
    return blocked(
      "FRESH_MAINNET_EVIDENCE_INVALID",
      "compact identity evidence is invalid",
    );
  if (
    binding.value.environment !== "mainnet" ||
    binding.value.origin !== "https://api.bybit.com" ||
    (plan !== undefined &&
      binding.value.accountIdentityHash !== plan.accountIdentityHash)
  )
    return blocked(
      "ACCOUNT_READINESS_OR_IDENTITY_BLOCKED",
      "authenticated account identity does not match the approved operator plan",
      { source: "account", causeCode: "ACCOUNT_IDENTITY_MISMATCH" },
    );
  if (
    posture.value.readOnly ||
    !posture.value.permissions.contractOrder ||
    !posture.value.permissions.contractPosition ||
    posture.value.permissions.withdraw ||
    posture.value.permissions.walletTransfer
  )
    return blocked(
      "CREDENTIAL_PERMISSION_BLOCKED",
      "API key permissions do not match the operator test requirements",
      {
        source: "account",
        readOnly: posture.value.readOnly,
        contractOrder: posture.value.permissions.contractOrder,
        contractPosition: posture.value.permissions.contractPosition,
        walletTransfer: posture.value.permissions.walletTransfer,
        withdraw: posture.value.permissions.withdraw,
      },
    );
  if (
    posture.value.expiresAt !== null &&
    timestampToEpochMs(posture.value.expiresAt) <=
      timestampToEpochMs(providerTime)
  )
    return blocked("CREDENTIAL_PERMISSION_BLOCKED", "API key is expired", {
      source: "account",
      causeCode: "API_KEY_EXPIRED",
    });

  const observations: MainnetOperatorTestCompactAccountObservation[] = [];
  for (const candidate of input.observations) {
    if (
      !plainDataRecord(candidate) ||
      Reflect.ownKeys(candidate).length !== 4 ||
      !Object.hasOwn(candidate, "mode") ||
      !Object.hasOwn(candidate, "availableBalance") ||
      !Object.hasOwn(candidate, "modeObservedAt") ||
      !Object.hasOwn(candidate, "balanceObservedAt")
    )
      return blocked(
        "FRESH_MAINNET_EVIDENCE_INVALID",
        "compact account observation is malformed",
      );
    const mode = compactAccountMode(candidate.mode);
    const modeObservedAt = parseUtcTimestamp(candidate.modeObservedAt);
    const balanceObservedAt = parseUtcTimestamp(candidate.balanceObservedAt);
    if (
      !mode ||
      !(candidate.availableBalance instanceof DecimalValue) ||
      candidate.availableBalance.isNegative() ||
      !modeObservedAt.ok ||
      !balanceObservedAt.ok
    )
      return blocked(
        "FRESH_MAINNET_EVIDENCE_INVALID",
        "compact account observation is invalid",
      );
    observations.push({
      mode,
      availableBalance: candidate.availableBalance,
      modeObservedAt: modeObservedAt.value,
      balanceObservedAt: balanceObservedAt.value,
    });
  }
  const [first, second] = observations;
  if (!first || !second) return blocked("FRESH_MAINNET_EVIDENCE_INVALID");
  const sameMode =
    JSON.stringify(first.mode.utaStatus) ===
      JSON.stringify(second.mode.utaStatus) &&
    JSON.stringify(first.mode.marginMode) ===
      JSON.stringify(second.mode.marginMode) &&
    JSON.stringify(first.mode.spotHedging) ===
      JSON.stringify(second.mode.spotHedging);
  if (!sameMode)
    return blocked(
      "CRITICAL_STATE_CHANGED",
      "account mode changed between the two compact observations",
      { criticalChangedGroups: "account" },
    );
  if (first.availableBalance.compare(second.availableBalance) !== 0)
    return blocked(
      "CRITICAL_STATE_CHANGED",
      "account-wide available balance changed between the two compact observations",
      { criticalChangedGroups: "assets" },
    );
  const mode = second.mode;
  const utaStatus = compactKnownFact(mode.utaStatus, (value): value is number =>
    Number.isSafeInteger(value),
  );
  const marginMode = compactKnownFact(
    mode.marginMode,
    (value): value is string => typeof value === "string",
  );
  const spotHedging = compactKnownFact(
    mode.spotHedging,
    (value): value is boolean => typeof value === "boolean",
  );
  if (
    utaStatus === undefined ||
    marginMode === undefined ||
    spotHedging === undefined
  )
    return blocked(
      "ACCOUNT_MODE_UNKNOWN",
      "required account-mode facts were not returned",
      {
        source: "account",
      },
    );
  if (![5, 6].includes(utaStatus) || marginMode !== "REGULAR_MARGIN")
    return blocked(
      "ACCOUNT_MODE_UNSUPPORTED",
      "account mode is not supported by this operator flow",
      {
        source: "account",
        utaStatus,
        marginMode,
      },
    );
  if (spotHedging)
    return blocked("SPOT_HEDGING_ENABLED", "spot hedging is enabled", {
      source: "account",
      spotHedging,
    });

  const providerMs = timestampToEpochMs(providerTime);
  const observedTimes = observations.flatMap((item) => [
    item.modeObservedAt,
    item.balanceObservedAt,
  ]);
  const ages = observedTimes.map(
    (observedAt) => providerMs - timestampToEpochMs(observedAt),
  );
  const identityAge =
    providerMs - timestampToEpochMs(binding.value.authenticatedAt);
  const accountAgeAtReadMs = Math.max(identityAge, ...ages);
  if (
    identityAge < 0 ||
    identityAge > PROVISIONAL_M1_MAX_ACCOUNT_EVIDENCE_AGE_MS ||
    ages.some(
      (age) => age < 0 || age > PROVISIONAL_M1_MAX_ACCOUNT_EVIDENCE_AGE_MS,
    )
  ) {
    const accountAges = [
      identityAge,
      ...observations.map(
        (item) => providerMs - timestampToEpochMs(item.modeObservedAt),
      ),
    ];
    const balanceAges = observations.map(
      (item) => providerMs - timestampToEpochMs(item.balanceObservedAt),
    );
    const isOutsideWindow = (age: number) =>
      age < 0 || age > PROVISIONAL_M1_MAX_ACCOUNT_EVIDENCE_AGE_MS;
    const accountAge = accountAges.find(isOutsideWindow);
    const source = accountAge === undefined ? "balance" : "account";
    const age =
      source === "account" ? accountAge! : balanceAges.find(isOutsideWindow)!;
    return blocked(
      "MAINNET_EVIDENCE_STALE",
      "account evidence is outside the allowed freshness window",
      timeFailureDetails(
        source,
        age,
        PROVISIONAL_M1_MAX_ACCOUNT_EVIDENCE_AGE_MS,
      ),
    );
  }

  return ok({
    availableBalance: second.availableBalance,
    accountAgeAtReadMs,
    accountIdentityHash: binding.value.accountIdentityHash,
    credentialPosture: posture.value,
  });
}

export function validateCompactOperatorAccountForPlan(
  plan: OperatorMainnetTestPlan | undefined,
  compactAccount: MainnetOperatorTestCompactAccountEvidence,
  providerTime: UtcTimestamp,
): Result<{
  readonly availableBalance: DecimalValue;
  readonly accountAgeAtReadMs: number;
  readonly accountIdentityHash: string;
  readonly credentialPosture: AccountCredentialPosture;
}> {
  return validateCompactAccountEvidence(plan, compactAccount, providerTime);
}

function verifyCapabilities(state: MainnetExchangeReadState): boolean {
  if (!Array.isArray(state.capabilities)) return false;
  const scope = {
    exchange: "bybit",
    environment: "mainnet",
    category: "linear",
    positionMode: "one-way",
  } as const;
  return (
    ["order-create", "attached-protection", "reconciliation-reads"] as const
  ).every((capability) => {
    const observation = state.capabilities.find(
      (item) =>
        item.capability === capability &&
        item.scope.exchange === scope.exchange &&
        item.scope.environment === scope.environment &&
        item.scope.category === scope.category &&
        item.scope.positionMode === scope.positionMode,
    );
    return (
      observation !== undefined &&
      requireTrustedCapability(
        observation,
        { capability, scope },
        { now: () => state.serverTime },
      ).ok
    );
  });
}

function validateOperatorTargetState(
  state: MainnetExchangeReadState,
  symbol: string,
): Result<void> {
  if (
    !plainDataRecord(state.position) ||
    !plainDataRecord(state.leverage) ||
    !Array.isArray(state.openOrders)
  )
    return blocked(
      "FRESH_MAINNET_EVIDENCE_INVALID",
      "target position, leverage or open-order evidence is malformed",
      { source: "target-state", causeCode: "TARGET_STATE_SHAPE_INVALID" },
    );
  const market = isProducedMarketSnapshot(state.market)
    ? state.market
    : undefined;
  if (
    !market ||
    market.instrument !== symbol ||
    market.scope.exchange !== "bybit" ||
    market.scope.environment !== "mainnet" ||
    market.scope.category !== "linear" ||
    market.scope.positionMode !== "one-way"
  )
    return blocked(
      "TARGET_STATE_OR_CAPABILITY_BLOCKED",
      "target market snapshot does not prove the approved symbol scope",
      { source: "target-state", causeCode: "MARKET_SCOPE_INVALID" },
    );
  if (
    state.position.instrument !== symbol ||
    !(state.position.quantity instanceof DecimalValue)
  )
    return blocked(
      "TARGET_STATE_OR_CAPABILITY_BLOCKED",
      "target position evidence is unavailable or mismatched",
      { source: "position", causeCode: "POSITION_EVIDENCE_INVALID" },
    );
  if (state.position.side !== "flat" || !state.position.quantity.isZero())
    return blocked(
      "TARGET_STATE_OR_CAPABILITY_BLOCKED",
      "target symbol already has a position",
      {
        source: "position",
        positionSide: state.position.side,
        positionQuantity: state.position.quantity.toString(),
      },
    );
  if (state.openOrders.length > 0)
    return blocked(
      "TARGET_STATE_OR_CAPABILITY_BLOCKED",
      "target symbol already has active orders",
      { source: "orders", activeOrderCount: state.openOrders.length },
    );
  if (
    !one.ok ||
    !(state.position.leverage instanceof DecimalValue) ||
    !(state.leverage.buy instanceof DecimalValue) ||
    !(state.leverage.sell instanceof DecimalValue) ||
    !(state.leverage.effective instanceof DecimalValue)
  )
    return blocked(
      "TARGET_STATE_OR_CAPABILITY_BLOCKED",
      "target leverage evidence is incomplete",
      { source: "position", causeCode: "LEVERAGE_UNKNOWN" },
    );
  if (
    state.position.leverage.compare(one.value) !== 0 ||
    state.leverage.buy.compare(one.value) !== 0 ||
    state.leverage.sell.compare(one.value) !== 0 ||
    state.leverage.effective.compare(one.value) !== 0
  )
    return blocked(
      "TARGET_STATE_OR_CAPABILITY_BLOCKED",
      "target leverage is not one-way 1x",
      {
        source: "position",
        leverage: state.position.leverage.toString(),
        leverageBuy: state.leverage.buy.toString(),
        leverageSell: state.leverage.sell.toString(),
        leverageEffective: state.leverage.effective.toString(),
      },
    );
  if (!verifyCapabilities(state))
    return blocked(
      "TARGET_STATE_OR_CAPABILITY_BLOCKED",
      "required operator execution capability evidence is unavailable",
      { source: "target-state", causeCode: "REQUIRED_CAPABILITY_UNPROVEN" },
    );
  return ok(undefined);
}

function changedInstrumentConstraint(
  approved: InstrumentConstraints,
  instrument: InstrumentConstraints,
  market: InstrumentConstraints,
): string {
  const fields = [
    "instrument",
    "version",
    "priceTickSize",
    "quantityStep",
    "minQuantity",
    "minNotional",
    "minPrice",
    "maxPrice",
    "maxLimitQuantity",
  ] as const;
  for (const field of fields) {
    const approvedValue = approved[field]?.toString() ?? null;
    const instrumentValue = instrument[field]?.toString() ?? null;
    const marketValue = market[field]?.toString() ?? null;
    if (instrumentValue !== approvedValue || marketValue !== approvedValue)
      return field;
  }
  return "constraintSet";
}

export function validateMainnetOperatorTestEvidence(
  plan: OperatorMainnetTestPlan,
  evidenceInput: MainnetOperatorTestAdmissionEvidence,
): Result<{
  readonly account:
    AccountEvidenceBundle | MainnetOperatorTestCompactAccountEvidence;
  readonly quote: OperatorMainnetQuote;
  readonly accountAgeAtReadMs: number;
  readonly quoteAgeAtReadMs: number;
  readonly feeRateAgeAtReadMs: number;
  readonly capacity: OperatorMainnetTestCapacity;
}> {
  if (isCompactOperatorEvidence(evidenceInput))
    return validateCompactMainnetOperatorTestEvidence(plan, evidenceInput);
  if (
    !plainDataRecord(evidenceInput) ||
    Reflect.ownKeys(evidenceInput).length !== 6 ||
    ["account", "readiness", "state", "instrument", "quote", "feeRate"].some(
      (key) => !Object.hasOwn(evidenceInput, key),
    ) ||
    !plainDataRecord(evidenceInput.readiness)
  )
    return blocked("FRESH_MAINNET_EVIDENCE_INVALID");
  if (
    !plainDataRecord(evidenceInput.state) ||
    !plainDataRecord(evidenceInput.instrument)
  )
    return blocked("FRESH_MAINNET_EVIDENCE_INVALID");
  const account = createAccountEvidenceBundle(evidenceInput.account);
  const readiness = evidenceInput.readiness;
  const state = evidenceInput.state;
  const instrument = evidenceInput.instrument;
  const quote = validateOperatorMainnetQuoteForPlan(
    plan,
    evidenceInput.quote,
    plainDataRecord(evidenceInput.quote)
      ? evidenceInput.quote.collectionCompletedAt
      : undefined,
  );
  const feeRate = createOperatorMainnetFeeRateEvidence(evidenceInput.feeRate);
  const serverTime = parseUtcTimestamp(state.serverTime);
  const evaluatedAt = parseUtcTimestamp(readiness.evaluatedAt);
  if (!account.ok)
    return blocked(
      "ACCOUNT_EVIDENCE_INVALID",
      "account evidence failed validation",
      { source: "account", causeCode: account.error.code },
    );
  if (!quote.ok)
    return blocked(
      quote.error.code === "CONSTRAINT_VIOLATION"
        ? "QUOTE_OUTSIDE_APPROVED_RANGE"
        : quote.error.code === "STALE_EVIDENCE"
          ? "QUOTE_STALE_OR_FUTURE"
          : "QUOTE_EVIDENCE_INVALID",
      "fresh quote validation failed",
      { ...quote.error.details, causeCode: quote.error.code },
    );
  if (!feeRate.ok)
    return blocked(
      "FEE_RATE_EVIDENCE_INVALID",
      "fee-rate evidence failed validation",
      { source: "fee", causeCode: "FEE_RATE_INVALID" },
    );
  if (!serverTime.ok || !evaluatedAt.ok)
    return blocked("EVIDENCE_TIME_INVALID");
  const accountHash = accountEvidenceContentHash(account.value);
  const binding = account.value.accountBinding;
  const readinessWarnings = readiness.warningCodes;
  if (
    !Array.isArray(readiness.warningCodes) ||
    !Array.isArray(readiness.reasonCodes) ||
    !Array.isArray(readiness.providerReasonCodes)
  )
    return blocked("FRESH_MAINNET_EVIDENCE_INVALID");
  if (readiness.reasonCodes.includes("CRITICAL_STATE_CHANGED"))
    return blocked(
      "CRITICAL_STATE_CHANGED",
      "account critical state changed between observations",
      {
        criticalChangedGroups:
          changedAccountCriticalGroups(account.value).join(",") ||
          "UNESTABLISHED",
      },
    );
  const hasIpWarning = readinessWarnings.includes("API_KEY_IP_UNBOUND");
  const plannedIpWarning = plan.warningCodes.includes("API_KEY_IP_UNBOUND");
  if (
    readiness.environment !== "mainnet" ||
    readiness.schemaVersion !== "mainnet-execution-readiness/v1" ||
    readiness.verdict !== "READY" ||
    readiness.symbol !== plan.symbol ||
    readiness.reasonCodes.length !== 0 ||
    readinessWarnings.some((warning) => warning !== "API_KEY_IP_UNBOUND") ||
    hasIpWarning !== plannedIpWarning ||
    readiness.internalBinding?.accountIdentityHash !==
      plan.accountIdentityHash ||
    !accountHash.ok ||
    readiness.internalBinding?.accountEvidenceHash !== accountHash.value ||
    readiness.capabilityProfile.status !== "SUPPORTED" ||
    readiness.capabilityProfile.liveProof !== "not-established" ||
    account.value.collectionStatus !== "complete" ||
    binding.environment !== "mainnet" ||
    binding.origin !== "https://api.bybit.com" ||
    !binding.identityVerified ||
    binding.accountIdentityHash !== plan.accountIdentityHash ||
    account.value.collectionEndedAt === null ||
    readiness.accountEvidenceAgeMs === undefined ||
    !Number.isFinite(readiness.accountEvidenceAgeMs) ||
    readiness.accountEvidenceAgeMs < 0 ||
    readiness.accountEvidenceAgeMs >
      PROVISIONAL_M1_MAX_ACCOUNT_EVIDENCE_AGE_MS ||
    timestampToEpochMs(serverTime.value) <
      timestampToEpochMs(evaluatedAt.value) ||
    timestampToEpochMs(serverTime.value) -
      timestampToEpochMs(evaluatedAt.value) >
      PROVISIONAL_M1_MAX_ACCOUNT_EVIDENCE_AGE_MS ||
    timestampToEpochMs(account.value.collectionEndedAt) >
      timestampToEpochMs(serverTime.value) ||
    timestampToEpochMs(serverTime.value) -
      timestampToEpochMs(account.value.collectionEndedAt) >
      PROVISIONAL_M1_MAX_ACCOUNT_EVIDENCE_AGE_MS
  )
    return blocked(
      "ACCOUNT_READINESS_OR_IDENTITY_BLOCKED",
      "fresh account identity or readiness evidence did not match the approved plan",
      {
        source: "account",
        causeCode: "ACCOUNT_READINESS_OR_IDENTITY_MISMATCH",
      },
    );
  const posture = account.value.credentialPosture;
  if (
    posture.readOnly ||
    !posture.permissions.contractOrder ||
    !posture.permissions.contractPosition ||
    posture.permissions.withdraw ||
    posture.permissions.walletTransfer
  )
    return blocked(
      "CREDENTIAL_PERMISSION_BLOCKED",
      "API key permissions do not match the operator test requirements",
      {
        source: "account",
        readOnly: posture.readOnly,
        contractOrder: posture.permissions.contractOrder,
        contractPosition: posture.permissions.contractPosition,
        walletTransfer: posture.permissions.walletTransfer,
        withdraw: posture.permissions.withdraw,
      },
    );
  const instrumentConstraints = createInstrumentConstraints(
    instrument.constraints,
  );
  const market = isProducedMarketSnapshot(state.market)
    ? ok(state.market)
    : fail(
        domainError("INVALID_EVIDENCE", "market snapshot lacks domain proof"),
      );
  if (
    !instrumentConstraints.ok ||
    !market.ok ||
    instrument.symbol !== plan.symbol ||
    instrument.status !== "Trading" ||
    instrument.contractType !== "LinearPerpetual" ||
    instrument.quoteCoin !== "USDT" ||
    instrument.settleCoin !== "USDT"
  )
    return blocked(
      "TARGET_INSTRUMENT_UNSUPPORTED",
      "fresh instrument details do not prove a supported linear USDT contract",
      { source: "instrument", causeCode: "INSTRUMENT_SCOPE_UNSUPPORTED" },
    );
  const freshInstrumentConstraintsHash = hashCanonical(
    instrumentConstraints.value,
  );
  const planConstraintsHash = hashCanonical(plan.constraints);
  const marketConstraints = market.value.constraints;
  const notionalConstraintMatches =
    (marketConstraints.minNotional === undefined &&
      plan.constraints.minNotional === undefined) ||
    (marketConstraints.minNotional !== undefined &&
      plan.constraints.minNotional !== undefined &&
      marketConstraints.minNotional.compare(plan.constraints.minNotional) ===
        0);
  if (
    !freshInstrumentConstraintsHash.ok ||
    !planConstraintsHash.ok ||
    freshInstrumentConstraintsHash.value !== planConstraintsHash.value ||
    marketConstraints.instrument !== plan.constraints.instrument ||
    marketConstraints.version !== plan.constraints.version ||
    marketConstraints.priceTickSize.compare(plan.constraints.priceTickSize) !==
      0 ||
    marketConstraints.quantityStep.compare(plan.constraints.quantityStep) !==
      0 ||
    marketConstraints.minQuantity.compare(plan.constraints.minQuantity) !== 0 ||
    !notionalConstraintMatches
  )
    return blocked(
      "APPROVED_INSTRUMENT_CONSTRAINTS_CHANGED",
      "fresh public instrument constraints differ from the approved plan",
      {
        source: "instrument",
        causeCode: "INSTRUMENT_CONSTRAINT_MISMATCH",
        changedConstraint: changedInstrumentConstraint(
          plan.constraints,
          instrumentConstraints.value,
          marketConstraints,
        ),
      },
    );
  const targetState = validateOperatorTargetState(state, plan.symbol);
  if (!targetState.ok) return targetState;
  if (feeRate.value.symbol !== plan.symbol)
    return blocked(
      "FEE_RATE_SYMBOL_MISMATCH",
      "fee rate is for a different symbol",
      { source: "fee", causeCode: "FEE_RATE_SYMBOL_MISMATCH" },
    );
  const quoteAgeAtReadMs =
    timestampToEpochMs(serverTime.value) -
    timestampToEpochMs(quote.value.observedAt);
  const feeRateAgeAtReadMs =
    timestampToEpochMs(serverTime.value) -
    timestampToEpochMs(feeRate.value.observedAt);
  const accountAgeAtReadMs =
    readiness.accountEvidenceAgeMs +
    timestampToEpochMs(serverTime.value) -
    timestampToEpochMs(evaluatedAt.value);
  if (quoteAgeAtReadMs < 0 || quoteAgeAtReadMs > plan.quoteFreshnessMs)
    return blocked(
      "MAINNET_EVIDENCE_STALE",
      "quote evidence is outside the allowed freshness window",
      timeFailureDetails("quote", quoteAgeAtReadMs, plan.quoteFreshnessMs),
    );
  if (
    feeRateAgeAtReadMs < 0 ||
    feeRateAgeAtReadMs > PROVISIONAL_M1_MAX_ACCOUNT_EVIDENCE_AGE_MS
  )
    return blocked(
      "MAINNET_EVIDENCE_STALE",
      "fee-rate evidence is outside the allowed freshness window",
      timeFailureDetails(
        "fee",
        feeRateAgeAtReadMs,
        PROVISIONAL_M1_MAX_ACCOUNT_EVIDENCE_AGE_MS,
      ),
    );
  if (
    accountAgeAtReadMs < 0 ||
    accountAgeAtReadMs > PROVISIONAL_M1_MAX_ACCOUNT_EVIDENCE_AGE_MS
  )
    return blocked(
      "MAINNET_EVIDENCE_STALE",
      "account evidence is outside the allowed freshness window",
      timeFailureDetails(
        "account",
        accountAgeAtReadMs,
        PROVISIONAL_M1_MAX_ACCOUNT_EVIDENCE_AGE_MS,
      ),
    );
  const capacity = calculateOperatorMainnetTestCapacity(
    plan,
    account.value,
    feeRate.value,
  );
  if (!capacity.ok) return capacity;
  return ok({
    account: account.value,
    quote: quote.value,
    accountAgeAtReadMs,
    quoteAgeAtReadMs,
    feeRateAgeAtReadMs,
    capacity: capacity.value,
  });
}

function isCompactOperatorEvidence(
  input: unknown,
): input is MainnetOperatorTestCompactFreshEvidence {
  return plainDataRecord(input) && Object.hasOwn(input, "compactAccount");
}

export function validateCompactOperatorPreparationEvidence(input: {
  readonly compactAccount: MainnetOperatorTestCompactAccountEvidence;
  readonly state: MainnetExchangeReadState;
  readonly instrument: BybitInstrumentInfo;
  readonly quote: OperatorMainnetQuote;
}): Result<{
  readonly accountIdentityHash: string;
  readonly warningCodes: readonly "API_KEY_IP_UNBOUND"[];
}> {
  if (!plainDataRecord(input)) return blocked("FRESH_MAINNET_EVIDENCE_INVALID");
  const serverTime = parseUtcTimestamp(input.state.serverTime);
  if (!serverTime.ok) return blocked("EVIDENCE_TIME_INVALID");
  const account = validateCompactAccountEvidence(
    undefined,
    input.compactAccount,
    serverTime.value,
  );
  if (!account.ok) return account;
  const currentMarket = isProducedMarketSnapshot(input.state.market)
    ? input.state.market
    : undefined;
  if (!currentMarket)
    return blocked(
      "TARGET_STATE_OR_CAPABILITY_BLOCKED",
      "target market snapshot is unavailable",
      { source: "target-state", causeCode: "MARKET_SCOPE_INVALID" },
    );
  const targetState = validateOperatorTargetState(
    input.state,
    input.instrument.symbol,
  );
  if (!targetState.ok) return targetState;
  const quote = rehydrateOperatorMainnetQuote(input.quote);
  if (!quote.ok) return blocked("QUOTE_EVIDENCE_INVALID");
  if (quote.value.symbol !== input.instrument.symbol)
    return blocked("QUOTE_EVIDENCE_INVALID");
  const quoteAge =
    timestampToEpochMs(serverTime.value) -
    timestampToEpochMs(quote.value.observedAt);
  if (quoteAge < 0 || quoteAge > OPERATOR_MAINNET_QUOTE_FRESHNESS_MS)
    return blocked(
      "QUOTE_STALE_OR_FUTURE",
      "preparation quote is outside the allowed freshness window",
      timeFailureDetails(
        "quote",
        quoteAge,
        OPERATOR_MAINNET_QUOTE_FRESHNESS_MS,
      ),
    );
  const constraints = createInstrumentConstraints(input.instrument.constraints);
  const instrumentHash = constraints.ok
    ? hashCanonical(constraints.value)
    : undefined;
  const marketHash = currentMarket
    ? hashCanonical(currentMarket.constraints)
    : undefined;
  if (
    !constraints?.ok ||
    !instrumentHash?.ok ||
    !marketHash?.ok ||
    instrumentHash.value !== marketHash.value ||
    input.instrument.status !== "Trading" ||
    input.instrument.contractType !== "LinearPerpetual" ||
    input.instrument.quoteCoin !== "USDT" ||
    input.instrument.settleCoin !== "USDT"
  )
    return blocked(
      "TARGET_INSTRUMENT_UNSUPPORTED",
      "fresh instrument details do not prove a supported linear USDT contract",
      { source: "instrument", causeCode: "INSTRUMENT_SCOPE_UNSUPPORTED" },
    );
  return ok({
    accountIdentityHash: account.value.accountIdentityHash,
    warningCodes: account.value.credentialPosture.warnings,
  });
}

function validateCompactMainnetOperatorTestEvidence(
  plan: OperatorMainnetTestPlan,
  evidenceInput: MainnetOperatorTestCompactFreshEvidence,
): Result<{
  readonly account: MainnetOperatorTestCompactAccountEvidence;
  readonly quote: OperatorMainnetQuote;
  readonly accountAgeAtReadMs: number;
  readonly quoteAgeAtReadMs: number;
  readonly feeRateAgeAtReadMs: number;
  readonly capacity: OperatorMainnetTestCapacity;
}> {
  if (
    !plainDataRecord(evidenceInput) ||
    Reflect.ownKeys(evidenceInput).length !== 5 ||
    !Object.hasOwn(evidenceInput, "compactAccount") ||
    !Object.hasOwn(evidenceInput, "state") ||
    !Object.hasOwn(evidenceInput, "instrument") ||
    !Object.hasOwn(evidenceInput, "quote") ||
    !Object.hasOwn(evidenceInput, "feeRate") ||
    !plainDataRecord(evidenceInput.state) ||
    !plainDataRecord(evidenceInput.instrument)
  )
    return blocked("FRESH_MAINNET_EVIDENCE_INVALID");

  const state = evidenceInput.state;
  const serverTime = parseUtcTimestamp(state.serverTime);
  if (!serverTime.ok) return blocked("EVIDENCE_TIME_INVALID");
  const account = validateCompactAccountEvidence(
    plan,
    evidenceInput.compactAccount,
    serverTime.value,
  );
  if (!account.ok) return account;
  const quote = validateOperatorMainnetQuoteForPlan(
    plan,
    evidenceInput.quote,
    plainDataRecord(evidenceInput.quote)
      ? evidenceInput.quote.collectionCompletedAt
      : undefined,
  );
  if (!quote.ok)
    return blocked(
      quote.error.code === "CONSTRAINT_VIOLATION"
        ? "QUOTE_OUTSIDE_APPROVED_RANGE"
        : quote.error.code === "STALE_EVIDENCE"
          ? "QUOTE_STALE_OR_FUTURE"
          : "QUOTE_EVIDENCE_INVALID",
      "fresh quote validation failed",
      { ...quote.error.details, causeCode: quote.error.code },
    );
  const feeRate = createOperatorMainnetFeeRateEvidence(evidenceInput.feeRate);
  if (!feeRate.ok)
    return blocked(
      "FEE_RATE_EVIDENCE_INVALID",
      "fee-rate evidence failed validation",
      { source: "fee", causeCode: "FEE_RATE_INVALID" },
    );

  const posture = account.value.credentialPosture;
  const hasIpWarning = posture.warnings.includes("API_KEY_IP_UNBOUND");
  if (hasIpWarning !== plan.warningCodes.includes("API_KEY_IP_UNBOUND"))
    return blocked(
      "ACCOUNT_READINESS_OR_IDENTITY_BLOCKED",
      "account identity or credential posture does not match the approved plan",
      {
        source: "account",
        causeCode: "ACCOUNT_READINESS_OR_IDENTITY_MISMATCH",
      },
    );

  const instrument = evidenceInput.instrument;
  const instrumentConstraints = createInstrumentConstraints(
    instrument.constraints,
  );
  const market = isProducedMarketSnapshot(state.market)
    ? ok(state.market)
    : fail(
        domainError("INVALID_EVIDENCE", "market snapshot lacks domain proof"),
      );
  if (
    !instrumentConstraints.ok ||
    !market.ok ||
    instrument.symbol !== plan.symbol ||
    instrument.status !== "Trading" ||
    instrument.contractType !== "LinearPerpetual" ||
    instrument.quoteCoin !== "USDT" ||
    instrument.settleCoin !== "USDT"
  )
    return blocked(
      "TARGET_INSTRUMENT_UNSUPPORTED",
      "fresh instrument details do not prove a supported linear USDT contract",
      { source: "instrument", causeCode: "INSTRUMENT_SCOPE_UNSUPPORTED" },
    );
  const freshInstrumentConstraintsHash = hashCanonical(
    instrumentConstraints.value,
  );
  const planConstraintsHash = hashCanonical(plan.constraints);
  const marketConstraints = market.value.constraints;
  const notionalConstraintMatches =
    (marketConstraints.minNotional === undefined &&
      plan.constraints.minNotional === undefined) ||
    (marketConstraints.minNotional !== undefined &&
      plan.constraints.minNotional !== undefined &&
      marketConstraints.minNotional.compare(plan.constraints.minNotional) ===
        0);
  if (
    !freshInstrumentConstraintsHash.ok ||
    !planConstraintsHash.ok ||
    freshInstrumentConstraintsHash.value !== planConstraintsHash.value ||
    marketConstraints.instrument !== plan.constraints.instrument ||
    marketConstraints.version !== plan.constraints.version ||
    marketConstraints.priceTickSize.compare(plan.constraints.priceTickSize) !==
      0 ||
    marketConstraints.quantityStep.compare(plan.constraints.quantityStep) !==
      0 ||
    marketConstraints.minQuantity.compare(plan.constraints.minQuantity) !== 0 ||
    !notionalConstraintMatches
  )
    return blocked(
      "APPROVED_INSTRUMENT_CONSTRAINTS_CHANGED",
      "fresh public instrument constraints differ from the approved plan",
      {
        source: "instrument",
        causeCode: "INSTRUMENT_CONSTRAINT_MISMATCH",
        changedConstraint: changedInstrumentConstraint(
          plan.constraints,
          instrumentConstraints.value,
          marketConstraints,
        ),
      },
    );

  const targetState = validateOperatorTargetState(state, plan.symbol);
  if (!targetState.ok) return targetState;

  if (feeRate.value.symbol !== plan.symbol)
    return blocked(
      "FEE_RATE_SYMBOL_MISMATCH",
      "fee rate is for a different symbol",
      { source: "fee", causeCode: "FEE_RATE_SYMBOL_MISMATCH" },
    );
  const quoteAgeAtReadMs =
    timestampToEpochMs(serverTime.value) -
    timestampToEpochMs(quote.value.observedAt);
  const feeRateAgeAtReadMs =
    timestampToEpochMs(serverTime.value) -
    timestampToEpochMs(feeRate.value.observedAt);
  if (quoteAgeAtReadMs < 0 || quoteAgeAtReadMs > plan.quoteFreshnessMs)
    return blocked(
      "MAINNET_EVIDENCE_STALE",
      "quote evidence is outside the allowed freshness window",
      timeFailureDetails("quote", quoteAgeAtReadMs, plan.quoteFreshnessMs),
    );
  if (
    feeRateAgeAtReadMs < 0 ||
    feeRateAgeAtReadMs > PROVISIONAL_M1_MAX_ACCOUNT_EVIDENCE_AGE_MS
  )
    return blocked(
      "MAINNET_EVIDENCE_STALE",
      "fee-rate evidence is outside the allowed freshness window",
      timeFailureDetails(
        "fee",
        feeRateAgeAtReadMs,
        PROVISIONAL_M1_MAX_ACCOUNT_EVIDENCE_AGE_MS,
      ),
    );

  const capacity = calculateOperatorMainnetTestCapacityFromAvailableBalance(
    plan,
    account.value.availableBalance,
    feeRate.value,
  );
  if (!capacity.ok) return capacity;
  return ok({
    account: evidenceInput.compactAccount,
    quote: quote.value,
    accountAgeAtReadMs: account.value.accountAgeAtReadMs,
    quoteAgeAtReadMs,
    feeRateAgeAtReadMs,
    capacity: capacity.value,
  });
}

export function revalidateMainnetOperatorEvidenceAge(
  plan: OperatorMainnetTestPlan,
  evidence: {
    readonly accountAgeAtReadMs: number;
    readonly quoteAgeAtReadMs: number;
    readonly feeRateAgeAtReadMs: number;
  },
  monotonicElapsedMs: number,
): Result<void> {
  if (
    !Number.isFinite(monotonicElapsedMs) ||
    monotonicElapsedMs < 0 ||
    evidence.accountAgeAtReadMs + monotonicElapsedMs >
      PROVISIONAL_M1_MAX_ACCOUNT_EVIDENCE_AGE_MS ||
    evidence.quoteAgeAtReadMs + monotonicElapsedMs > plan.quoteFreshnessMs ||
    evidence.feeRateAgeAtReadMs + monotonicElapsedMs >
      PROVISIONAL_M1_MAX_ACCOUNT_EVIDENCE_AGE_MS
  )
    return blocked("MAINNET_EVIDENCE_EXPIRED");
  return ok(undefined);
}
