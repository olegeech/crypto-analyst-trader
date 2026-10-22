import { createHash } from "node:crypto";

import type { AccountEvidenceBundle } from "../domain/account/account-evidence-bundle.js";
import {
  accountEvidenceContentHash,
  createAccountEvidenceBundle,
} from "../domain/account/account-evidence-bundle.js";
import { requireTrustedCapability } from "../domain/capabilities/capability.js";
import {
  validateOperatorMainnetQuoteForPlan,
  type OperatorMainnetQuote,
  type OperatorMainnetTestPlan,
} from "../domain/execution/operator-mainnet-test-plan.js";
import { createOrderIntent } from "../domain/planning/order-intent.js";
import { hashCanonical } from "../domain/identity/canonical-serialization.js";
import { DecimalValue } from "../domain/shared/decimal.js";
import { domainError } from "../domain/shared/errors.js";
import { fail, ok, type Result } from "../domain/shared/result.js";
import {
  parseUtcTimestamp,
  timestampToEpochMs,
  type UtcTimestamp,
} from "../domain/shared/time.js";
import { isRecord, requireIdentifier } from "../domain/shared/validation.js";
import { mapCreateOrderRequest } from "../adapters/bybit-v5/order-mappers.js";
import { createInstrumentConstraints } from "../domain/market/instrument-constraints.js";
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

export interface MainnetOperatorTestEvidencePort {
  collect(symbol: string): Promise<MainnetOperatorTestFreshEvidence>;
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
) {
  return fail(domainError("INVALID_EVIDENCE", message, { reasonCode: code }));
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
  if (!zero.ok) return blocked("DECIMAL_CONSTANT_INVALID");
  const availableBalance = currentAvailableBalance(account);
  if (availableBalance === undefined || !completeCurrentCommitments(account))
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
  if (availableBalance.compare(requiredAvailableBalance) < 0)
    return blocked("AVAILABLE_MARGIN_OR_FEE_RESERVE_INSUFFICIENT");
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

function targetPositionIsFlat(
  state: MainnetExchangeReadState,
  symbol: string,
): boolean {
  return (
    state.position.quantity instanceof DecimalValue &&
    state.position.instrument === symbol &&
    state.position.side === "flat" &&
    state.position.quantity.isZero() &&
    Array.isArray(state.openOrders) &&
    state.openOrders.length === 0
  );
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

export function validateMainnetOperatorTestEvidence(
  plan: OperatorMainnetTestPlan,
  evidenceInput: MainnetOperatorTestFreshEvidence,
): Result<{
  readonly account: AccountEvidenceBundle;
  readonly quote: OperatorMainnetQuote;
  readonly accountAgeAtReadMs: number;
  readonly quoteAgeAtReadMs: number;
  readonly feeRateAgeAtReadMs: number;
  readonly capacity: OperatorMainnetTestCapacity;
}> {
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
    evidenceInput.quote.collectionCompletedAt,
  );
  const feeRate = createOperatorMainnetFeeRateEvidence(evidenceInput.feeRate);
  const serverTime = parseUtcTimestamp(state.serverTime);
  const evaluatedAt = parseUtcTimestamp(readiness.evaluatedAt);
  if (
    !account.ok ||
    !quote.ok ||
    !feeRate.ok ||
    !plainDataRecord(instrument) ||
    !serverTime.ok ||
    !evaluatedAt.ok
  )
    return blocked("FRESH_MAINNET_EVIDENCE_INVALID");
  const accountHash = accountEvidenceContentHash(account.value);
  const binding = account.value.accountBinding;
  const readinessWarnings = readiness.warningCodes;
  if (
    !Array.isArray(readiness.warningCodes) ||
    !Array.isArray(readiness.reasonCodes) ||
    !Array.isArray(readiness.providerReasonCodes) ||
    !plainDataRecord(state.position) ||
    !plainDataRecord(state.leverage) ||
    !Array.isArray(state.openOrders)
  )
    return blocked("FRESH_MAINNET_EVIDENCE_INVALID");
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
    return blocked("ACCOUNT_READINESS_OR_IDENTITY_BLOCKED");
  const posture = account.value.credentialPosture;
  if (
    posture.readOnly ||
    !posture.permissions.contractOrder ||
    !posture.permissions.contractPosition ||
    posture.permissions.withdraw ||
    posture.permissions.walletTransfer
  )
    return blocked("CREDENTIAL_PERMISSION_BLOCKED");
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
    return blocked("TARGET_INSTRUMENT_UNSUPPORTED");
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
    return blocked("APPROVED_INSTRUMENT_CONSTRAINTS_CHANGED");
  if (
    market.value.instrument !== plan.symbol ||
    market.value.scope.exchange !== "bybit" ||
    market.value.scope.environment !== "mainnet" ||
    market.value.scope.category !== "linear" ||
    market.value.scope.positionMode !== "one-way" ||
    !targetPositionIsFlat(state, plan.symbol) ||
    !one.ok ||
    !(state.position.leverage instanceof DecimalValue) ||
    !(state.leverage.buy instanceof DecimalValue) ||
    !(state.leverage.sell instanceof DecimalValue) ||
    !(state.leverage.effective instanceof DecimalValue) ||
    state.position.leverage.compare(one.value) !== 0 ||
    state.leverage.buy.compare(one.value) !== 0 ||
    state.leverage.sell.compare(one.value) !== 0 ||
    state.leverage.effective.compare(one.value) !== 0 ||
    !verifyCapabilities(state)
  )
    return blocked("TARGET_STATE_OR_CAPABILITY_BLOCKED");
  if (feeRate.value.symbol !== plan.symbol)
    return blocked("FEE_RATE_SYMBOL_MISMATCH");
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
  if (
    quoteAgeAtReadMs < 0 ||
    quoteAgeAtReadMs > plan.quoteFreshnessMs ||
    feeRateAgeAtReadMs < 0 ||
    feeRateAgeAtReadMs > PROVISIONAL_M1_MAX_ACCOUNT_EVIDENCE_AGE_MS ||
    accountAgeAtReadMs < 0 ||
    accountAgeAtReadMs > PROVISIONAL_M1_MAX_ACCOUNT_EVIDENCE_AGE_MS
  )
    return blocked("MAINNET_EVIDENCE_STALE");
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
