import {
  accountEvidenceContentHash,
  createAccountEvidenceBundle,
} from "../account/account-evidence-bundle.js";
import { hashCanonical } from "../identity/canonical-serialization.js";
import { prepareDailyPlanningInputs } from "../planning/daily-planning-inputs.js";
import {
  rehydrateDailyDecisionPlan,
  type DailyDecisionPlan,
} from "../planning/daily-decision-plan.js";
import type { InstrumentConstraints } from "../market/instrument-constraints.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { DecimalValue, isDecimalValue } from "../shared/decimal.js";
import { domainError } from "../shared/errors.js";
import { fail, ok, type Result } from "../shared/result.js";
import { parseUtcTimestamp, type UtcTimestamp } from "../shared/time.js";
import { isRecord } from "../shared/validation.js";
import {
  createPortfolioRiskProjection,
  type PortfolioRiskProjection,
  type PortfolioRiskProjectionFact,
} from "./portfolio-risk-projection.js";
import {
  createPortfolioRiskPolicy,
  portfolioRiskPolicyHash,
} from "./portfolio-risk-policy.js";
import {
  createPortfolioRiskBlockReasonCodes,
  createPortfolioRiskNoOpReasonCodes,
  type PortfolioRiskBlockReasonCode,
  type PortfolioRiskNoOpReasonCode,
} from "./portfolio-risk-diagnostics.js";
import type { PortfolioRiskGateStatus } from "./portfolio-risk-capacity.js";

export const PORTFOLIO_RISK_MATERIALIZATION_SCHEMA_VERSION =
  "portfolio-risk-materialization/v1" as const;

export interface PortfolioRiskCloseProposal {
  readonly kind: "close-long-quantity";
  readonly symbol: string;
  readonly side: "Sell";
  readonly positionIdx: 0;
  readonly quantity: DecimalValue;
  readonly quantityUnit: "contracts";
}

export interface PortfolioRiskReductionMaterialization {
  readonly status: "proposed" | "no-op" | "blocked" | "not-evaluated";
  readonly symbol: string | null;
  readonly currentQuantity: PortfolioRiskProjectionFact;
  readonly reductionFraction: PortfolioRiskProjectionFact;
  readonly requestedQuantity: PortfolioRiskProjectionFact;
  readonly normalizedQuantity: PortfolioRiskProjectionFact;
  readonly quantityStep: PortfolioRiskProjectionFact;
  readonly minimumQuantity: PortfolioRiskProjectionFact;
  readonly constraintVersion: string | null;
  readonly constraintHash: string | null;
  readonly noOpReason: PortfolioRiskNoOpReasonCode | null;
  readonly proposal: PortfolioRiskCloseProposal | null;
}

export interface PortfolioRiskMaterialization {
  readonly schemaVersion: typeof PORTFOLIO_RISK_MATERIALIZATION_SCHEMA_VERSION;
  readonly dailyPlanHash: string;
  readonly accountEvidenceHash: string;
  readonly marketEvidenceHash: string;
  readonly policyHash: string;
  readonly evaluationTime: UtcTimestamp;
  readonly recommendation: "ADD_LONG" | "REDUCE_LONG" | "HOLD_LONG";
  readonly outcome: PortfolioRiskGateStatus;
  readonly reasonCodes: readonly PortfolioRiskBlockReasonCode[];
  readonly projection: PortfolioRiskProjection;
  readonly reduction: PortfolioRiskReductionMaterialization;
}

export interface PortfolioRiskMaterializationInput {
  readonly dailyPlan: unknown;
  readonly account: unknown;
  readonly policy: unknown;
  readonly evaluationTime: unknown;
}

function invalid(
  message = "portfolio risk materialization input is invalid",
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
  const fields = ["dailyPlan", "account", "policy", "evaluationTime"];
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

function known<T>(fact: {
  readonly state: string;
  readonly value?: T;
}): fact is { readonly state: "known"; readonly value: T } {
  return fact.state === "known" && Object.hasOwn(fact, "value");
}

function fact(value: DecimalValue): PortfolioRiskProjectionFact {
  return { state: "known", value };
}

function unavailable(): PortfolioRiskProjectionFact {
  return { state: "unavailable" };
}

function notEvaluated(): PortfolioRiskProjectionFact {
  return { state: "not-evaluated" };
}

function notEvaluatedReduction(): PortfolioRiskReductionMaterialization {
  return {
    status: "not-evaluated",
    symbol: null,
    currentQuantity: notEvaluated(),
    reductionFraction: notEvaluated(),
    requestedQuantity: notEvaluated(),
    normalizedQuantity: notEvaluated(),
    quantityStep: notEvaluated(),
    minimumQuantity: notEvaluated(),
    constraintVersion: null,
    constraintHash: null,
    noOpReason: null,
    proposal: null,
  };
}

function failedReduction(input: {
  readonly symbol: string;
  readonly currentQuantity: PortfolioRiskProjectionFact;
  readonly reductionFraction: DecimalValue;
  readonly requestedQuantity: PortfolioRiskProjectionFact;
  readonly normalizedQuantity: PortfolioRiskProjectionFact;
  readonly quantityStep: DecimalValue;
  readonly minimumQuantity: DecimalValue;
  readonly constraintVersion: string;
  readonly constraintHash: string;
}): PortfolioRiskReductionMaterialization {
  return {
    status: "blocked",
    symbol: input.symbol,
    currentQuantity: input.currentQuantity,
    reductionFraction: fact(input.reductionFraction),
    requestedQuantity: input.requestedQuantity,
    normalizedQuantity: input.normalizedQuantity,
    quantityStep: fact(input.quantityStep),
    minimumQuantity: fact(input.minimumQuantity),
    constraintVersion: input.constraintVersion,
    constraintHash: input.constraintHash,
    noOpReason: null,
    proposal: null,
  };
}

function reduce(
  plan: DailyDecisionPlan,
  projection: PortfolioRiskProjection,
  constraints: InstrumentConstraints,
): Result<{
  readonly reduction: PortfolioRiskReductionMaterialization;
  readonly outcome: PortfolioRiskGateStatus;
  readonly reasonCodes: readonly PortfolioRiskBlockReasonCode[];
}> {
  if (plan.decision.recommendation !== "REDUCE_LONG")
    return ok({
      reduction: notEvaluatedReduction(),
      outcome: "not-evaluated",
      reasonCodes: [],
    });

  const reductionFraction = plan.reductionFraction;
  if (!isDecimalValue(reductionFraction) || !reductionFraction.isPositive())
    return invalid("REDUCE plan is missing a positive reduction fraction");

  const constraintHash = hashCanonical(constraints);
  const zero = DecimalValue.fromString("0");
  if (!constraintHash.ok || !zero.ok) return invalid();
  const base = {
    symbol: projection.targetSymbol,
    reductionFraction,
    quantityStep: constraints.quantityStep,
    minimumQuantity: constraints.minQuantity,
    constraintVersion: constraints.version,
    constraintHash: constraintHash.value,
  };
  const target = projection.targetPosition;
  if (target.state === "ambiguous") {
    return ok({
      reduction: failedReduction({
        ...base,
        currentQuantity: unavailable(),
        requestedQuantity: unavailable(),
        normalizedQuantity: unavailable(),
      }),
      outcome: "block",
      reasonCodes: ["REDUCTION_STATE_INVALID"],
    });
  }

  if (target.state === "absent") {
    const noOps = createPortfolioRiskNoOpReasonCodes(["NO_REDUCIBLE_LONG"]);
    if (!noOps.ok) return invalid();
    return ok({
      reduction: {
        status: "no-op",
        symbol: projection.targetSymbol,
        currentQuantity: fact(zero.value),
        reductionFraction: fact(reductionFraction),
        requestedQuantity: fact(zero.value),
        normalizedQuantity: fact(zero.value),
        quantityStep: fact(constraints.quantityStep),
        minimumQuantity: fact(constraints.minQuantity),
        constraintVersion: constraints.version,
        constraintHash: constraintHash.value,
        noOpReason: noOps.value[0] ?? null,
        proposal: null,
      },
      outcome: "pass",
      reasonCodes: [],
    });
  }

  const position = target.position;
  const currentQuantity =
    known(position.size) && position.size.unit === "contracts"
      ? position.size.value
      : null;
  const structurallyValid =
    position.category === "linear" &&
    position.symbol === projection.targetSymbol &&
    position.positionIdx === 0 &&
    currentQuantity !== null &&
    !currentQuantity.isNegative() &&
    ["Buy", "Sell", "None"].includes(position.side);
  if (!structurallyValid || currentQuantity === null) {
    return ok({
      reduction: failedReduction({
        ...base,
        currentQuantity:
          currentQuantity === null ? unavailable() : fact(currentQuantity),
        requestedQuantity: unavailable(),
        normalizedQuantity: unavailable(),
      }),
      outcome: "block",
      reasonCodes: ["REDUCTION_STATE_INVALID"],
    });
  }

  if (currentQuantity.isZero()) {
    const noOps = createPortfolioRiskNoOpReasonCodes(["NO_REDUCIBLE_LONG"]);
    if (!noOps.ok) return invalid();
    return ok({
      reduction: {
        status: "no-op",
        symbol: projection.targetSymbol,
        currentQuantity: fact(currentQuantity),
        reductionFraction: fact(reductionFraction),
        requestedQuantity: fact(zero.value),
        normalizedQuantity: fact(zero.value),
        quantityStep: fact(constraints.quantityStep),
        minimumQuantity: fact(constraints.minQuantity),
        constraintVersion: constraints.version,
        constraintHash: constraintHash.value,
        noOpReason: noOps.value[0] ?? null,
        proposal: null,
      },
      outcome: "pass",
      reasonCodes: [],
    });
  }

  if (position.side !== "Buy") {
    return ok({
      reduction: failedReduction({
        ...base,
        currentQuantity: fact(currentQuantity),
        requestedQuantity: unavailable(),
        normalizedQuantity: unavailable(),
      }),
      outcome: "block",
      reasonCodes: ["REDUCTION_STATE_INVALID"],
    });
  }

  const requestedQuantity = currentQuantity.multiply(reductionFraction);
  const floored = requestedQuantity.floorToStep(constraints.quantityStep);
  if (!floored.ok)
    return invalid("reduction quantity cannot be normalized safely");
  const normalizedQuantity =
    floored.value.compare(currentQuantity) <= 0
      ? floored.value
      : currentQuantity;
  if (normalizedQuantity.compare(constraints.minQuantity) < 0) {
    const noOps = createPortfolioRiskNoOpReasonCodes([
      "REDUCTION_QUANTITY_TOO_SMALL",
    ]);
    if (!noOps.ok) return invalid();
    return ok({
      reduction: {
        status: "no-op",
        symbol: projection.targetSymbol,
        currentQuantity: fact(currentQuantity),
        reductionFraction: fact(reductionFraction),
        requestedQuantity: fact(requestedQuantity),
        normalizedQuantity: fact(normalizedQuantity),
        quantityStep: fact(constraints.quantityStep),
        minimumQuantity: fact(constraints.minQuantity),
        constraintVersion: constraints.version,
        constraintHash: constraintHash.value,
        noOpReason: noOps.value[0] ?? null,
        proposal: null,
      },
      outcome: "pass",
      reasonCodes: [],
    });
  }

  return ok({
    reduction: {
      status: "proposed",
      symbol: projection.targetSymbol,
      currentQuantity: fact(currentQuantity),
      reductionFraction: fact(reductionFraction),
      requestedQuantity: fact(requestedQuantity),
      normalizedQuantity: fact(normalizedQuantity),
      quantityStep: fact(constraints.quantityStep),
      minimumQuantity: fact(constraints.minQuantity),
      constraintVersion: constraints.version,
      constraintHash: constraintHash.value,
      noOpReason: null,
      proposal: {
        kind: "close-long-quantity",
        symbol: projection.targetSymbol,
        side: "Sell",
        positionIdx: 0,
        quantity: normalizedQuantity,
        quantityUnit: "contracts",
      },
    },
    outcome: "pass",
    reasonCodes: [],
  });
}

function buildMaterialization(
  input: PortfolioRiskMaterializationInput,
): Result<PortfolioRiskMaterialization> {
  if (!closedInput(input)) return invalid();
  const plan = rehydrateDailyDecisionPlan(input.dailyPlan);
  const account = createAccountEvidenceBundle(input.account);
  const policy = createPortfolioRiskPolicy(input.policy);
  const evaluationTime = parseUtcTimestamp(input.evaluationTime);
  if (!plan.ok || !account.ok || !policy.ok || !evaluationTime.ok)
    return invalid(
      "materialization requires a validated plan, account, policy and time",
    );
  const planning = prepareDailyPlanningInputs(plan.value.inputs);
  if (!planning.ok) return invalid("daily plan replay inputs are invalid");

  const projection = createPortfolioRiskProjection({
    dailyPlan: plan.value,
    account: account.value,
    policy: policy.value,
    evaluationTime: evaluationTime.value,
  });
  const accountHash = accountEvidenceContentHash(account.value);
  const policyHash = portfolioRiskPolicyHash(policy.value);
  if (!projection.ok || !accountHash.ok || !policyHash.ok)
    return invalid(
      "materialization source identity or shared projection is invalid",
    );

  const base = {
    schemaVersion: PORTFOLIO_RISK_MATERIALIZATION_SCHEMA_VERSION,
    dailyPlanHash: plan.value.contentHash,
    accountEvidenceHash: accountHash.value,
    marketEvidenceHash: projection.value.marketEvidenceHash,
    policyHash: policyHash.value,
    evaluationTime: evaluationTime.value,
    recommendation: plan.value.decision.recommendation,
    projection: projection.value,
  };
  if (projection.value.sharedAdmission.status === "blocked")
    return ok(
      deepFreeze({
        ...base,
        outcome: "block",
        reasonCodes: projection.value.sharedAdmission.reasonCodes,
        reduction: notEvaluatedReduction(),
      }),
    );

  const reduction = reduce(
    plan.value,
    projection.value,
    planning.value.constraints,
  );
  if (!reduction.ok) return reduction;
  const reasons = createPortfolioRiskBlockReasonCodes([
    ...projection.value.sharedAdmission.reasonCodes,
    ...reduction.value.reasonCodes,
  ]);
  if (!reasons.ok) return invalid();
  return ok(
    deepFreeze({
      ...base,
      outcome: reduction.value.outcome,
      reasonCodes: reasons.value,
      reduction: reduction.value.reduction,
    }),
  );
}

export function materializePortfolioRiskAction(
  input: PortfolioRiskMaterializationInput,
): Result<PortfolioRiskMaterialization> {
  return buildMaterialization(input);
}
