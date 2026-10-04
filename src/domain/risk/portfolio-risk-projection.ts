import {
  accountEvidenceContentHash,
  createAccountEvidenceBundle,
  type AccountOrderEvidence,
  type AccountEvidenceBundle,
  type AccountEvidenceDecimalFact,
  type AccountEvidenceFact,
  type AccountPositionEvidence,
} from "../account/account-evidence-bundle.js";
import {
  marketEvidenceContentHash,
  type MarketEvidenceBundle,
  type MarketInstrumentEvidence,
} from "../market/market-evidence-bundle.js";
import { prepareDailyPlanningInputs } from "../planning/daily-planning-inputs.js";
import { rehydrateDailyDecisionPlan } from "../planning/daily-decision-plan.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { DecimalValue } from "../shared/decimal.js";
import { domainError } from "../shared/errors.js";
import { fail, ok, type Result } from "../shared/result.js";
import {
  parseUtcTimestamp,
  timestampToEpochMs,
  type UtcTimestamp,
} from "../shared/time.js";
import { isRecord } from "../shared/validation.js";
import {
  createPortfolioRiskBlockReasonCodes,
  type PortfolioRiskBlockReasonCode,
} from "./portfolio-risk-diagnostics.js";
import {
  createPortfolioRiskPolicy,
  portfolioRiskPolicyHash,
} from "./portfolio-risk-policy.js";

export const PORTFOLIO_RISK_PROJECTION_SCHEMA_VERSION =
  "portfolio-risk-projection/v1" as const;

export type PortfolioRiskProjectionFact =
  | { readonly state: "known"; readonly value: DecimalValue }
  | { readonly state: "unavailable" }
  | { readonly state: "not-evaluated" };

export interface PortfolioRiskExposureLine {
  readonly source: "position" | "open-order" | "spot-inventory" | "cash";
  readonly category: "linear" | "inverse" | "spot" | "option" | null;
  readonly symbol: string;
  readonly side: string | null;
  readonly quantity: DecimalValue | null;
  readonly quantityUnit:
    "contracts" | "coin" | "base-coin" | "quote-coin" | null;
  readonly notionalUsd: DecimalValue | null;
  readonly treatment:
    "gross-exposure" | "protective-close" | "cash-visibility" | "unvalued";
}

export interface PortfolioRiskProjection {
  readonly schemaVersion: typeof PORTFOLIO_RISK_PROJECTION_SCHEMA_VERSION;
  readonly dailyPlanHash: string;
  readonly accountEvidenceHash: string;
  readonly marketEvidenceHash: string;
  readonly policyHash: string;
  readonly targetSymbol: string;
  readonly recommendation: "ADD_LONG" | "REDUCE_LONG" | "HOLD_LONG";
  readonly evaluationTime: UtcTimestamp;
  readonly sharedAdmission: {
    readonly status: "admitted" | "blocked";
    readonly reasonCodes: readonly PortfolioRiskBlockReasonCode[];
  };
  readonly addProjection: {
    readonly status: "complete" | "blocked" | "not-evaluated";
    readonly reasonCodes: readonly PortfolioRiskBlockReasonCode[];
    readonly availableBalance: PortfolioRiskProjectionFact;
    readonly currentDerivativesGrossUsd: PortfolioRiskProjectionFact;
    readonly pendingDerivativesGrossUsd: PortfolioRiskProjectionFact;
    readonly spotInventoryGrossUsd: PortfolioRiskProjectionFact;
    readonly totalGrossExposureUsd: PortfolioRiskProjectionFact;
    readonly exposures: readonly PortfolioRiskExposureLine[];
  };
  readonly targetPosition:
    | { readonly state: "absent" }
    | { readonly state: "known"; readonly position: AccountPositionEvidence }
    | { readonly state: "ambiguous" };
}

export interface PortfolioRiskProjectionInput {
  readonly dailyPlan: unknown;
  readonly account: unknown;
  readonly policy: unknown;
  readonly evaluationTime: unknown;
}

type SupportedCategory = "linear" | "inverse" | "spot" | "option";
type ExposureTotals = {
  derivatives: DecimalValue;
  pending: DecimalValue;
  spot: DecimalValue;
  readonly exposures: PortfolioRiskExposureLine[];
  readonly reasonCodes: Set<PortfolioRiskBlockReasonCode>;
};

function invalid(
  message = "portfolio risk projection input is invalid",
): Result<never> {
  return fail(domainError("INVALID_EVIDENCE", message));
}

function hasPlainDataProperties(value: object): boolean {
  return (
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) =>
      Object.hasOwn(descriptor, "value"),
    )
  );
}

function known<T>(fact: AccountEvidenceFact<T>): fact is {
  readonly state: "known";
  readonly value: T;
} {
  return fact.state === "known";
}

function notEvaluated(): PortfolioRiskProjectionFact {
  return { state: "not-evaluated" };
}

function isSupportedLinearInstrument(
  market: MarketEvidenceBundle,
  symbol: string,
): MarketInstrumentEvidence | undefined {
  const instrument = market.symbols.find(
    (row) => row.symbol === symbol,
  )?.instrument;
  if (
    !instrument ||
    instrument.symbol !== symbol ||
    instrument.constraints.instrument !== symbol ||
    instrument.contractType !== "LinearPerpetual" ||
    instrument.quoteCoin !== "USDT" ||
    instrument.settleCoin !== "USDT"
  )
    return undefined;
  return instrument;
}

function positionNotional(
  position: AccountPositionEvidence,
  instrument: MarketInstrumentEvidence | undefined,
): DecimalValue | null {
  if (position.size.state !== "known" || position.size.unit !== "contracts")
    return null;
  if (position.size.value.isZero()) return position.size.value;
  if (!instrument || position.category !== "linear") return null;
  if (
    position.positionValue.state === "known" &&
    position.positionValue.unit === "USD" &&
    position.positionValue.value.isPositive()
  )
    return position.positionValue.value;
  if (position.positionValue.state !== "unavailable") return null;
  if (
    position.markPrice.state !== "known" ||
    position.markPrice.unit !== "price" ||
    !position.markPrice.value.isPositive()
  )
    return null;
  return position.size.value.multiply(position.markPrice.value);
}

function positionSideIsValid(position: AccountPositionEvidence): boolean {
  if (position.size.state !== "known" || position.size.value.isZero())
    return (
      position.side === "None" ||
      position.side === "Buy" ||
      position.side === "Sell"
    );
  if (position.side !== "Buy" && position.side !== "Sell") return false;
  if (position.positionIdx === 0) return true;
  return (
    (position.positionIdx === 1 && position.side === "Buy") ||
    (position.positionIdx === 2 && position.side === "Sell")
  );
}

function line(input: PortfolioRiskExposureLine): PortfolioRiskExposureLine {
  return input;
}

function projectPositions(
  account: AccountEvidenceBundle,
  market: MarketEvidenceBundle,
  totals: ExposureTotals,
): void {
  const pass = account.criticalPasses.B;
  if (!pass) return;
  for (const position of pass.positions) {
    const category = ["linear", "inverse", "spot", "option"].includes(
      position.category,
    )
      ? (position.category as SupportedCategory)
      : null;
    const size = known(position.size) ? position.size.value : null;
    const instrument =
      category === "linear"
        ? isSupportedLinearInstrument(market, position.symbol)
        : undefined;
    const notional = positionNotional(position, instrument);
    const positive = size?.isPositive() ?? true;
    if (!positive) {
      totals.exposures.push(
        line({
          source: "position",
          category,
          symbol: position.symbol,
          side: position.side,
          quantity: size,
          quantityUnit: position.size.unit,
          notionalUsd: notional,
          treatment: "gross-exposure",
        }),
      );
      continue;
    }
    if (
      category !== "linear" ||
      !instrument ||
      size === null ||
      !positionSideIsValid(position) ||
      notional === null ||
      !notional.isPositive()
    ) {
      totals.reasonCodes.add(
        category !== "linear" || !instrument
          ? "UNSUPPORTED_EXPOSURE"
          : "CURRENT_STATE_UNVALUABLE",
      );
      totals.exposures.push(
        line({
          source: "position",
          category,
          symbol: position.symbol,
          side: position.side,
          quantity: size,
          quantityUnit: position.size.unit,
          notionalUsd: null,
          treatment: "unvalued",
        }),
      );
      continue;
    }
    totals.derivatives = totals.derivatives.add(notional);
    totals.exposures.push(
      line({
        source: "position",
        category,
        symbol: position.symbol,
        side: position.side,
        quantity: size,
        quantityUnit: "contracts",
        notionalUsd: notional,
        treatment: "gross-exposure",
      }),
    );
  }
}

function orderFactNumber(
  fact: AccountEvidenceDecimalFact,
): DecimalValue | null {
  return fact.state === "known" ? fact.value : null;
}

function projectedQuantityUnit(
  unit: AccountEvidenceDecimalFact["unit"],
): PortfolioRiskExposureLine["quantityUnit"] {
  return ["contracts", "coin", "base-coin", "quote-coin"].includes(unit)
    ? (unit as "contracts" | "coin" | "base-coin" | "quote-coin")
    : null;
}

function positionForClose(
  account: AccountEvidenceBundle,
  order: AccountOrderEvidence,
) {
  const positions =
    account.criticalPasses.B?.positions.filter(
      (position) =>
        position.category === "linear" &&
        position.symbol === order.symbol &&
        position.positionIdx ===
          (known(order.positionIdx) ? order.positionIdx.value : -1),
    ) ?? [];
  return positions.length === 1 ? positions[0] : undefined;
}

function projectOrders(
  account: AccountEvidenceBundle,
  market: MarketEvidenceBundle,
  targetSymbol: string,
  totals: ExposureTotals,
): void {
  const pass = account.criticalPasses.B;
  if (!pass) return;
  for (const order of pass.orders) {
    const quantity = orderFactNumber(order.leavesQty);
    const sizeIsKnownContracts =
      quantity !== null && order.leavesQty.unit === "contracts";
    if (sizeIsKnownContracts && quantity.isZero()) continue;
    const positiveOrUnknown = quantity === null || quantity.isPositive();
    if (!positiveOrUnknown) continue;

    const category = ["linear", "inverse", "spot", "option"].includes(
      order.category,
    )
      ? (order.category as SupportedCategory)
      : null;
    const instrument =
      category === "linear"
        ? isSupportedLinearInstrument(market, order.symbol)
        : undefined;
    if (
      order.symbol === targetSymbol &&
      (!known(order.positionIdx) || order.positionIdx.value !== 0)
    ) {
      totals.reasonCodes.add("POSITION_MODE_UNSUPPORTED");
      totals.exposures.push(
        line({
          source: "open-order",
          category,
          symbol: order.symbol,
          side: order.side,
          quantity,
          quantityUnit: projectedQuantityUnit(order.leavesQty.unit),
          notionalUsd: null,
          treatment: "unvalued",
        }),
      );
      continue;
    }
    const protective =
      (known(order.reduceOnly) && order.reduceOnly.value) ||
      (known(order.closeOnTrigger) && order.closeOnTrigger.value);
    if (protective) {
      const position = positionForClose(account, order);
      const closesPosition =
        position !== undefined &&
        known(order.positionIdx) &&
        order.side !== position.side &&
        (position.side === "Buy" || position.side === "Sell") &&
        known(position.size) &&
        position.size.unit === "contracts" &&
        position.size.value.isPositive() &&
        quantity !== null &&
        order.leavesQty.unit === "contracts" &&
        quantity.compare(position.size.value) <= 0;
      if (category !== "linear" || !instrument || !closesPosition) {
        totals.reasonCodes.add("CURRENT_STATE_UNVALUABLE");
        totals.exposures.push(
          line({
            source: "open-order",
            category,
            symbol: order.symbol,
            side: order.side,
            quantity,
            quantityUnit: projectedQuantityUnit(order.leavesQty.unit),
            notionalUsd: null,
            treatment: "unvalued",
          }),
        );
        continue;
      }
      const price =
        known(order.price) &&
        order.price.unit === "price" &&
        order.price.value.isPositive()
          ? order.price.value
          : null;
      totals.exposures.push(
        line({
          source: "open-order",
          category,
          symbol: order.symbol,
          side: order.side,
          quantity,
          quantityUnit: "contracts",
          notionalUsd: price?.multiply(quantity) ?? null,
          treatment: "protective-close",
        }),
      );
      continue;
    }

    const price =
      known(order.price) &&
      order.price.unit === "price" &&
      order.price.value.isPositive()
        ? order.price.value
        : null;
    if (
      category !== "linear" ||
      !instrument ||
      !sizeIsKnownContracts ||
      !quantity?.isPositive() ||
      !price ||
      order.orderType !== "Limit" ||
      (order.side !== "Buy" && order.side !== "Sell") ||
      !known(order.positionIdx)
    ) {
      totals.reasonCodes.add(
        category !== "linear" || !instrument
          ? "UNSUPPORTED_EXPOSURE"
          : "CURRENT_STATE_UNVALUABLE",
      );
      totals.exposures.push(
        line({
          source: "open-order",
          category,
          symbol: order.symbol,
          side: order.side,
          quantity,
          quantityUnit: projectedQuantityUnit(order.leavesQty.unit),
          notionalUsd: null,
          treatment: "unvalued",
        }),
      );
      continue;
    }
    const notional = quantity.multiply(price);
    totals.pending = totals.pending.add(notional);
    totals.exposures.push(
      line({
        source: "open-order",
        category,
        symbol: order.symbol,
        side: order.side,
        quantity,
        quantityUnit: "contracts",
        notionalUsd: notional,
        treatment: "gross-exposure",
      }),
    );
  }
}

function projectWallet(
  account: AccountEvidenceBundle,
  totals: ExposureTotals,
): void {
  const pass = account.criticalPasses.B;
  if (!pass) return;
  for (const asset of pass.assets) {
    const balanceKnown = known(asset.walletBalance);
    const balance = balanceKnown ? asset.walletBalance.value : null;
    const cash = asset.coin === "USDT" || asset.coin === "USDC";
    const eligible = asset.collateralEligible;
    const switchFact = asset.collateralSwitch;
    const collateralFactsEstablished =
      balanceKnown &&
      asset.walletBalance.unit === "coin" &&
      known(eligible) &&
      (eligible.value
        ? known(switchFact)
        : switchFact.state === "not-applicable" ||
          (known(switchFact) && !switchFact.value));
    if (!collateralFactsEstablished)
      totals.reasonCodes.add("REQUIRED_ACCOUNT_FACT_UNKNOWN");

    if (balance === null) {
      if (!cash) totals.reasonCodes.add("CURRENT_STATE_UNVALUABLE");
      totals.exposures.push({
        source: cash ? "cash" : "spot-inventory",
        category: "spot",
        symbol: asset.coin,
        side: null,
        quantity: null,
        quantityUnit: "coin",
        notionalUsd: null,
        treatment: cash ? "cash-visibility" : "unvalued",
      });
      continue;
    }
    if (balance.isNegative()) {
      totals.reasonCodes.add("CURRENT_STATE_UNVALUABLE");
      totals.exposures.push({
        source: cash ? "cash" : "spot-inventory",
        category: "spot",
        symbol: asset.coin,
        side: null,
        quantity: balance,
        quantityUnit: "coin",
        notionalUsd: null,
        treatment: "unvalued",
      });
      continue;
    }
    if (balance.isZero()) {
      if (cash)
        totals.exposures.push(
          line({
            source: "cash",
            category: "spot",
            symbol: asset.coin,
            side: null,
            quantity: balance,
            quantityUnit: "coin",
            notionalUsd:
              asset.usdValue.state === "known" ? asset.usdValue.value : null,
            treatment: "cash-visibility",
          }),
        );
      continue;
    }
    if (cash) {
      totals.exposures.push(
        line({
          source: "cash",
          category: "spot",
          symbol: asset.coin,
          side: null,
          quantity: balance,
          quantityUnit: "coin",
          notionalUsd:
            asset.usdValue.state === "known" ? asset.usdValue.value : null,
          treatment: "cash-visibility",
        }),
      );
      continue;
    }
    const value = asset.usdValue;
    if (!known(value) || value.unit !== "USD" || !value.value.isPositive()) {
      totals.reasonCodes.add("CURRENT_STATE_UNVALUABLE");
      totals.exposures.push(
        line({
          source: "spot-inventory",
          category: "spot",
          symbol: asset.coin,
          side: null,
          quantity: balance,
          quantityUnit: "coin",
          notionalUsd: null,
          treatment: "unvalued",
        }),
      );
      continue;
    }
    totals.spot = totals.spot.add(value.value);
    totals.exposures.push(
      line({
        source: "spot-inventory",
        category: "spot",
        symbol: asset.coin,
        side: null,
        quantity: balance,
        quantityUnit: "coin",
        notionalUsd: value.value,
        treatment: "gross-exposure",
      }),
    );
  }
}

function amount(value: DecimalValue): PortfolioRiskProjectionFact {
  return { state: "known", value };
}

function buildProjection(
  input: PortfolioRiskProjectionInput,
): Result<PortfolioRiskProjection> {
  if (
    !isRecord(input) ||
    !hasPlainDataProperties(input) ||
    Reflect.ownKeys(input).length !== 4 ||
    Reflect.ownKeys(input).some(
      (key) =>
        typeof key !== "string" ||
        !["dailyPlan", "account", "policy", "evaluationTime"].includes(key),
    )
  )
    return invalid();
  const plan = rehydrateDailyDecisionPlan(input.dailyPlan);
  const account = createAccountEvidenceBundle(input.account);
  const policy = createPortfolioRiskPolicy(input.policy);
  const evaluationTime = parseUtcTimestamp(input.evaluationTime);
  if (!plan.ok || !account.ok || !policy.ok || !evaluationTime.ok)
    return invalid(
      "risk projection requires validated plan, account and policy",
    );
  const planning = prepareDailyPlanningInputs(plan.value.inputs);
  if (!planning.ok) return invalid("daily plan replay inputs are invalid");

  const p = planning.value;
  const accountHash = accountEvidenceContentHash(account.value);
  const marketHash = marketEvidenceContentHash(p.market);
  const policyHash = portfolioRiskPolicyHash(policy.value);
  if (!accountHash.ok || !marketHash.ok || !policyHash.ok)
    return invalid("risk projection source identity is invalid");

  const reasonCodes = new Set<PortfolioRiskBlockReasonCode>();
  const bundle = account.value;
  const passB = bundle.criticalPasses.B;
  if (
    bundle.collectionStatus !== "complete" ||
    !bundle.consistency.complete ||
    !passB ||
    bundle.collectionEndedAt === null ||
    bundle.bundleCutoff === null
  )
    reasonCodes.add("ACCOUNT_EVIDENCE_INCOMPLETE");
  if (bundle.collectionEndedAt !== null) {
    const age =
      timestampToEpochMs(evaluationTime.value) -
      timestampToEpochMs(bundle.collectionEndedAt);
    if (age < 0) reasonCodes.add("ACCOUNT_EVIDENCE_FUTURE");
    else if (age > policy.value.maxAccountEvidenceAgeMs)
      reasonCodes.add("ACCOUNT_EVIDENCE_STALE");
  }
  if (
    bundle.consistency.marginCompatibility !== "regular-margin" ||
    !passB ||
    !known(passB.account.marginMode) ||
    passB.account.marginMode.value !== "REGULAR_MARGIN"
  )
    reasonCodes.add("ACCOUNT_MODE_UNSUPPORTED");
  const targetMode = bundle.consistency.positionModes.find(
    (mode) => mode.symbol === p.symbol,
  );
  if (!targetMode || targetMode.mode !== "one-way")
    reasonCodes.add("POSITION_MODE_UNSUPPORTED");
  if (!bundle.configuredM1Symbols.includes(p.symbol))
    reasonCodes.add("INPUT_IDENTITY_MISMATCH");

  const normalizedSharedReasons = createPortfolioRiskBlockReasonCodes([
    ...reasonCodes,
  ]);
  if (!normalizedSharedReasons.ok) return invalid();
  const sharedBlocked = normalizedSharedReasons.value.length > 0;

  const targetRows =
    passB?.positions.filter((position) => position.symbol === p.symbol) ?? [];
  const targetPosition =
    targetRows.length === 0
      ? ({ state: "absent" } as const)
      : targetRows.length === 1 && targetRows[0]?.category === "linear"
        ? ({ state: "known", position: targetRows[0] } as const)
        : ({ state: "ambiguous" } as const);

  const emptyExposure: readonly PortfolioRiskExposureLine[] = [];
  let addProjection: PortfolioRiskProjection["addProjection"] = {
    status: "not-evaluated",
    reasonCodes: [],
    availableBalance: notEvaluated(),
    currentDerivativesGrossUsd: notEvaluated(),
    pendingDerivativesGrossUsd: notEvaluated(),
    spotInventoryGrossUsd: notEvaluated(),
    totalGrossExposureUsd: notEvaluated(),
    exposures: emptyExposure,
  };

  if (
    !sharedBlocked &&
    plan.value.decision.recommendation === "ADD_LONG" &&
    passB
  ) {
    const zero = DecimalValue.fromString("0");
    if (!zero.ok) return invalid();
    const totals: ExposureTotals = {
      derivatives: zero.value,
      pending: zero.value,
      spot: zero.value,
      exposures: [],
      reasonCodes: new Set(),
    };
    const available = passB.totals.totalAvailableBalance;
    const availableBalance =
      known(available) && available.unit === "USD"
        ? amount(available.value)
        : { state: "unavailable" as const };
    if (availableBalance.state !== "known")
      totals.reasonCodes.add("AVAILABLE_BALANCE_UNKNOWN");
    else if (!availableBalance.value.isPositive()) {
      // Non-positive provider capacity is known and is handled by U4 as zero.
    }
    projectPositions(bundle, p.market, totals);
    projectOrders(bundle, p.market, p.symbol, totals);
    projectWallet(bundle, totals);
    const normalizedReasons = createPortfolioRiskBlockReasonCodes([
      ...totals.reasonCodes,
    ]);
    if (!normalizedReasons.ok) return invalid();
    const projectionComplete = normalizedReasons.value.length === 0;
    const totalGross = totals.derivatives.add(totals.pending).add(totals.spot);
    const unavailable: PortfolioRiskProjectionFact = { state: "unavailable" };
    addProjection = {
      status: projectionComplete ? "complete" : "blocked",
      reasonCodes: normalizedReasons.value,
      availableBalance,
      currentDerivativesGrossUsd: projectionComplete
        ? amount(totals.derivatives)
        : unavailable,
      pendingDerivativesGrossUsd: projectionComplete
        ? amount(totals.pending)
        : unavailable,
      spotInventoryGrossUsd: projectionComplete
        ? amount(totals.spot)
        : unavailable,
      totalGrossExposureUsd: projectionComplete
        ? amount(totalGross)
        : unavailable,
      exposures: totals.exposures,
    };
  }

  return ok(
    deepFreeze({
      schemaVersion: PORTFOLIO_RISK_PROJECTION_SCHEMA_VERSION,
      dailyPlanHash: plan.value.contentHash,
      accountEvidenceHash: accountHash.value,
      marketEvidenceHash: marketHash.value,
      policyHash: policyHash.value,
      targetSymbol: p.symbol,
      recommendation: plan.value.decision.recommendation,
      evaluationTime: evaluationTime.value,
      sharedAdmission: {
        status: sharedBlocked ? "blocked" : "admitted",
        reasonCodes: normalizedSharedReasons.value,
      },
      addProjection,
      targetPosition,
    }),
  );
}

export function createPortfolioRiskProjection(
  input: PortfolioRiskProjectionInput,
): Result<PortfolioRiskProjection> {
  return buildProjection(input);
}
