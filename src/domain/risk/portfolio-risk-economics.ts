import {
  hashCanonical,
  type PlanHash,
} from "../identity/canonical-serialization.js";
import { prepareDailyPlanningInputs } from "../planning/daily-planning-inputs.js";
import { rehydrateDailyDecisionPlan } from "../planning/daily-decision-plan.js";
import {
  hashQualityProfile,
  createQualityProfile,
} from "../quality/quality-profile.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { DecimalValue, isDecimalValue } from "../shared/decimal.js";
import { domainError } from "../shared/errors.js";
import { fail, ok, type Result } from "../shared/result.js";
import { parseUtcTimestamp, type UtcTimestamp } from "../shared/time.js";
import { isRecord } from "../shared/validation.js";
import type { QualityProfile } from "../quality/quality-profile.js";
import type {
  MarketEvidenceBundle,
  MarketTickerEvidence,
} from "../market/market-evidence-bundle.js";
import type { PortfolioRiskBlockReasonCode } from "./portfolio-risk-diagnostics.js";
import { createPortfolioRiskBlockReasonCodes } from "./portfolio-risk-diagnostics.js";
import type { PortfolioRiskProjectionFact } from "./portfolio-risk-projection.js";
import {
  createPortfolioRiskPolicy,
  portfolioRiskPolicyHash,
  type PortfolioRiskPolicy,
} from "./portfolio-risk-policy.js";
import type { PortfolioRiskGateStatus } from "./portfolio-risk-capacity.js";

export const PORTFOLIO_RISK_ECONOMICS_SCHEMA_VERSION =
  "portfolio-risk-economics/v1" as const;

export type PortfolioRiskFundingEvidenceReason =
  | "market-role-missing"
  | "market-cutoff-future"
  | "market-cutoff-stale"
  | "market-reference-missing"
  | "market-reference-expired"
  | "market-metadata-after-evaluation"
  | "ticker-missing"
  | "ticker-after-cutoff"
  | "funding-rate-missing";

export interface PortfolioRiskFundingEvidence {
  readonly status:
    "fresh" | "stale" | "unavailable" | "inconsistent" | "not-evaluated";
  readonly reason: PortfolioRiskFundingEvidenceReason | null;
  readonly bundleCutoff: UtcTimestamp | null;
  readonly tickerObservedAt: UtcTimestamp | null;
  readonly maxAgeMs: number | null;
  readonly rate: PortfolioRiskProjectionFact;
}

export interface PortfolioRiskEconomicLeg {
  readonly legId: string;
  readonly index: number;
  readonly entryPrice: DecimalValue;
  readonly quantity: DecimalValue;
  readonly takeProfit: DecimalValue;
  readonly entryNotional: DecimalValue;
  readonly exitNotional: DecimalValue;
  readonly grossProfit: DecimalValue;
  readonly entryFee: DecimalValue;
  readonly exitFee: DecimalValue;
  readonly slippageBuffer: DecimalValue;
  readonly minimumEdge: DecimalValue;
  readonly fundingIntervals: 1;
  readonly fundingCost: PortfolioRiskProjectionFact;
  readonly requiredProfit: PortfolioRiskProjectionFact;
  readonly netAfterModeledCosts: PortfolioRiskProjectionFact;
  readonly status: "pass" | "block";
  readonly reasonCodes: readonly PortfolioRiskBlockReasonCode[];
}

export interface PortfolioRiskEconomics {
  readonly schemaVersion: typeof PORTFOLIO_RISK_ECONOMICS_SCHEMA_VERSION;
  readonly dailyPlanHash: PlanHash;
  readonly marketContentHash: string;
  readonly marketBundleHash: string;
  readonly policyHash: string;
  readonly qualityProfileHash: string;
  readonly qualityProfileVersion: string;
  readonly evaluationTime: UtcTimestamp;
  readonly recommendation: "ADD_LONG" | "REDUCE_LONG" | "HOLD_LONG";
  readonly outcome: PortfolioRiskGateStatus;
  readonly reasonCodes: readonly PortfolioRiskBlockReasonCode[];
  readonly fundingEvidence: PortfolioRiskFundingEvidence;
  readonly legs: readonly PortfolioRiskEconomicLeg[];
}

export interface PortfolioRiskEconomicsInput {
  readonly dailyPlan: unknown;
  readonly qualityProfile: unknown;
  readonly policy: unknown;
  readonly evaluationTime: unknown;
}

function invalid(
  message = "portfolio risk economics input is invalid",
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

function closedInput(value: unknown): value is Record<string, unknown> {
  const fields = ["dailyPlan", "qualityProfile", "policy", "evaluationTime"];
  return (
    isRecord(value) &&
    hasPlainDataProperties(value) &&
    Reflect.ownKeys(value).length === fields.length &&
    Reflect.ownKeys(value).every(
      (key) => typeof key === "string" && fields.includes(key),
    ) &&
    fields.every((key) => Object.hasOwn(value, key))
  );
}

function knownFact(value: DecimalValue): PortfolioRiskProjectionFact {
  return { state: "known", value };
}

function unavailableFact(): PortfolioRiskProjectionFact {
  return { state: "unavailable" };
}

function notEvaluatedFact(): PortfolioRiskProjectionFact {
  return { state: "not-evaluated" };
}

function ageExpired(
  evaluationTime: UtcTimestamp,
  asOf: UtcTimestamp,
  maxAgeMs: number,
): boolean {
  return (
    BigInt(Date.parse(evaluationTime)) >=
    BigInt(Date.parse(asOf)) + BigInt(maxAgeMs)
  );
}

function metadataIsFuture(
  timestamp: UtcTimestamp,
  evaluationTime: UtcTimestamp,
  metadataSkewMs: number,
): boolean {
  return (
    BigInt(Date.parse(timestamp)) >
    BigInt(Date.parse(evaluationTime)) + BigInt(metadataSkewMs)
  );
}

function fundingEvidence(
  market: MarketEvidenceBundle,
  ticker: MarketTickerEvidence | undefined,
  profile: QualityProfile,
  evaluationTime: UtcTimestamp,
): PortfolioRiskFundingEvidence {
  const role = profile.roles.find((row) => row.id === "market");
  const base = {
    bundleCutoff: market.bundleCutoff,
    tickerObservedAt: ticker?.observedAt ?? null,
    maxAgeMs: role?.maxAgeMs ?? null,
  };
  const unavailable = (
    status: PortfolioRiskFundingEvidence["status"],
    reason: PortfolioRiskFundingEvidenceReason,
  ): PortfolioRiskFundingEvidence => ({
    ...base,
    status,
    reason,
    rate: unavailableFact(),
  });

  if (!role) return unavailable("unavailable", "market-role-missing");
  if (Date.parse(market.bundleCutoff) > Date.parse(evaluationTime))
    return unavailable("inconsistent", "market-cutoff-future");
  if (ageExpired(evaluationTime, market.bundleCutoff, role.maxAgeMs))
    return unavailable("stale", "market-cutoff-stale");

  const reference = market.evidence.find(
    (row) => row.kind === "market-evidence-bundle",
  );
  if (!reference || reference.asOf !== market.bundleCutoff)
    return unavailable("unavailable", "market-reference-missing");
  if (ageExpired(evaluationTime, reference.asOf, reference.validForMs))
    return unavailable("stale", "market-reference-expired");

  if (
    metadataIsFuture(
      market.collectionStartedAt,
      evaluationTime,
      profile.metadataSkewMs,
    ) ||
    metadataIsFuture(
      market.collectionEndedAt,
      evaluationTime,
      profile.metadataSkewMs,
    )
  )
    return unavailable("inconsistent", "market-metadata-after-evaluation");
  if (!ticker) return unavailable("unavailable", "ticker-missing");
  if (Date.parse(ticker.observedAt) > Date.parse(market.bundleCutoff))
    return unavailable("inconsistent", "ticker-after-cutoff");
  if (!ticker.fundingRate || !isDecimalValue(ticker.fundingRate))
    return unavailable("unavailable", "funding-rate-missing");
  return {
    ...base,
    status: "fresh",
    reason: null,
    rate: knownFact(ticker.fundingRate),
  };
}

function legEconomics(input: {
  readonly legId: string;
  readonly index: number;
  readonly entryPrice: DecimalValue;
  readonly quantity: DecimalValue;
  readonly takeProfit: DecimalValue;
  readonly expectedNotional: DecimalValue;
  readonly policy: PortfolioRiskPolicy;
  readonly fundingEvidence: PortfolioRiskFundingEvidence;
}): Result<PortfolioRiskEconomicLeg> {
  const entryNotional = input.entryPrice.multiply(input.quantity);
  if (entryNotional.compare(input.expectedNotional) !== 0)
    return invalid(
      "candidate leg notional differs from the retained order plan",
    );
  const exitNotional = input.takeProfit.multiply(input.quantity);
  const grossProfit = exitNotional.subtract(entryNotional);
  const entryFee = entryNotional.multiply(input.policy.entryFeeRate);
  const exitFee = exitNotional.multiply(input.policy.exitFeeRate);
  const slippageBuffer = entryNotional.multiply(
    input.policy.slippageBufferRate,
  );
  const minimumEdge = entryNotional.multiply(input.policy.minimumNetEdgeRate);
  const reasons = new Set<PortfolioRiskBlockReasonCode>();
  if (input.fundingEvidence.status !== "fresh") {
    reasons.add("ECONOMICS_INPUT_UNKNOWN");
    return ok({
      legId: input.legId,
      index: input.index,
      entryPrice: input.entryPrice,
      quantity: input.quantity,
      takeProfit: input.takeProfit,
      entryNotional,
      exitNotional,
      grossProfit,
      entryFee,
      exitFee,
      slippageBuffer,
      minimumEdge,
      fundingIntervals: 1,
      fundingCost: unavailableFact(),
      requiredProfit: unavailableFact(),
      netAfterModeledCosts: unavailableFact(),
      status: "block",
      reasonCodes: ["ECONOMICS_INPUT_UNKNOWN"],
    });
  }
  if (input.fundingEvidence.rate.state !== "known") return invalid();
  const zero = DecimalValue.fromString("0");
  if (!zero.ok) return invalid();
  const positiveFundingRate =
    input.fundingEvidence.rate.value.compare(zero.value) > 0
      ? input.fundingEvidence.rate.value
      : zero.value;
  const fundingCost = entryNotional.multiply(positiveFundingRate);
  const requiredProfit = entryFee
    .add(exitFee)
    .add(slippageBuffer)
    .add(minimumEdge)
    .add(fundingCost);
  const netAfterModeledCosts = grossProfit
    .subtract(entryFee)
    .subtract(exitFee)
    .subtract(slippageBuffer)
    .subtract(fundingCost);
  const passes = grossProfit.compare(requiredProfit) >= 0;
  if (!passes) reasons.add("ECONOMICS_INSUFFICIENT");
  const normalized = createPortfolioRiskBlockReasonCodes([...reasons]);
  if (!normalized.ok) return invalid();
  return ok({
    legId: input.legId,
    index: input.index,
    entryPrice: input.entryPrice,
    quantity: input.quantity,
    takeProfit: input.takeProfit,
    entryNotional,
    exitNotional,
    grossProfit,
    entryFee,
    exitFee,
    slippageBuffer,
    minimumEdge,
    fundingIntervals: 1,
    fundingCost: knownFact(fundingCost),
    requiredProfit: knownFact(requiredProfit),
    netAfterModeledCosts: knownFact(netAfterModeledCosts),
    status: passes ? "pass" : "block",
    reasonCodes: normalized.value,
  });
}

function notEvaluatedFunding(): PortfolioRiskFundingEvidence {
  return {
    status: "not-evaluated",
    reason: null,
    bundleCutoff: null,
    tickerObservedAt: null,
    maxAgeMs: null,
    rate: notEvaluatedFact(),
  };
}

function buildEconomics(
  input: PortfolioRiskEconomicsInput,
): Result<PortfolioRiskEconomics> {
  if (!closedInput(input)) return invalid();
  const plan = rehydrateDailyDecisionPlan(input.dailyPlan);
  const profile = createQualityProfile(input.qualityProfile);
  const policy = createPortfolioRiskPolicy(input.policy);
  const evaluationTime = parseUtcTimestamp(input.evaluationTime);
  if (!plan.ok || !profile.ok || !policy.ok || !evaluationTime.ok)
    return invalid(
      "economics requires a validated plan, profile, policy and time",
    );
  const planning = prepareDailyPlanningInputs(plan.value.inputs);
  if (!planning.ok) return invalid("daily plan replay inputs are invalid");

  const profileHash = hashQualityProfile(profile.value);
  const policyHash = portfolioRiskPolicyHash(policy.value);
  const marketHash = hashCanonical(planning.value.market);
  if (!profileHash.ok || !policyHash.ok || !marketHash.ok)
    return invalid("economics source identity is invalid");
  if (
    profile.value.profileVersion !== planning.value.assessment.profileVersion ||
    profileHash.value !== planning.value.assessment.profileHash
  )
    return invalid("quality profile does not match the daily assessment");

  const base = {
    schemaVersion: PORTFOLIO_RISK_ECONOMICS_SCHEMA_VERSION,
    dailyPlanHash: plan.value.contentHash,
    marketContentHash: plan.value.inputIdentity.marketContentHash,
    marketBundleHash: marketHash.value,
    policyHash: policyHash.value,
    qualityProfileHash: profileHash.value,
    qualityProfileVersion: profile.value.profileVersion,
    evaluationTime: evaluationTime.value,
    recommendation: plan.value.decision.recommendation,
  };
  if (plan.value.decision.recommendation !== "ADD_LONG")
    return ok(
      deepFreeze({
        ...base,
        outcome: "not-evaluated",
        reasonCodes: [],
        fundingEvidence: notEvaluatedFunding(),
        legs: [],
      }),
    );

  const market = planning.value.market;
  const target = market.symbols.find(
    (row) => row.symbol === planning.value.symbol,
  );
  const funding = fundingEvidence(
    market,
    target?.ticker,
    profile.value,
    evaluationTime.value,
  );
  const legs = [] as PortfolioRiskEconomicLeg[];
  const reasons = new Set<PortfolioRiskBlockReasonCode>();
  const candidateLegs = plan.value.candidateLegs;
  if (!Array.isArray(candidateLegs))
    return invalid("ADD plan is missing its original candidate legs");
  for (const leg of candidateLegs) {
    const takeProfit = leg.intent.protection?.takeProfit;
    if (
      !isDecimalValue(leg.intent.price) ||
      !isDecimalValue(leg.intent.quantity) ||
      !isDecimalValue(leg.intent.notional) ||
      !takeProfit ||
      !isDecimalValue(takeProfit)
    )
      return invalid("ADD candidate is missing exact price, quantity or TP");
    const evaluated = legEconomics({
      legId: leg.legId,
      index: leg.index,
      entryPrice: leg.intent.price,
      quantity: leg.intent.quantity,
      takeProfit,
      expectedNotional: leg.intent.notional,
      policy: policy.value,
      fundingEvidence: funding,
    });
    if (!evaluated.ok) return evaluated;
    legs.push(evaluated.value);
    for (const code of evaluated.value.reasonCodes) reasons.add(code);
  }
  const normalized = createPortfolioRiskBlockReasonCodes([...reasons]);
  if (!normalized.ok) return invalid();
  return ok(
    deepFreeze({
      ...base,
      outcome: normalized.value.length > 0 ? "block" : "pass",
      reasonCodes: normalized.value,
      fundingEvidence: funding,
      legs,
    }),
  );
}

export function evaluatePortfolioRiskEconomics(
  input: PortfolioRiskEconomicsInput,
): Result<PortfolioRiskEconomics> {
  return buildEconomics(input);
}
