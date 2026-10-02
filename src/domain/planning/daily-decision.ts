import { isDecimalValue, type DecimalValue } from "../shared/decimal.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { isRecord } from "../shared/validation.js";
import { ok, type Result } from "../shared/result.js";
import {
  createDecisionPolicy,
  type DailyRecommendation,
  type DecisionCondition,
  type NumericComparison,
} from "./decision-policy.js";
import type {
  DailyPlanningInputs,
  DailySelectorObservation,
} from "./daily-planning-inputs.js";
import {
  boundedList,
  closedRecord,
  invalidPlanning,
  planningConstant,
  planningDecimal,
  textOrder,
} from "./planning-validation.js";

export interface DailyDecisionConditionTrace {
  readonly selectorId: string;
  readonly comparison: NumericComparison;
  readonly threshold: DecimalValue;
  readonly value?: DecimalValue;
  readonly status: "matched" | "unmatched" | "unavailable" | "absent";
}
export interface DailyDecisionRuleTrace {
  readonly ruleId: string;
  readonly target: DailyRecommendation;
  readonly support: DecimalValue;
  readonly matched: boolean;
  readonly conditions: readonly DailyDecisionConditionTrace[];
}
export interface DailyDecisionGroupTrace {
  readonly groupId: string;
  readonly weight: DecimalValue;
  readonly addSupport: DecimalValue;
  readonly reduceSupport: DecimalValue;
  readonly holdSupport: DecimalValue;
  readonly addWeightedSupport: DecimalValue;
  readonly reduceWeightedSupport: DecimalValue;
  readonly holdWeightedSupport: DecimalValue;
  readonly agreeingDirection: "ADD_LONG" | "REDUCE_LONG" | null;
  readonly rules: readonly DailyDecisionRuleTrace[];
}
export interface DailyDecisionEvaluation {
  readonly recommendation: DailyRecommendation;
  readonly decisionSupport: DecimalValue;
  readonly decisionConfidence: DecimalValue;
  readonly reasons: readonly string[];
  readonly addWeightedSupport: DecimalValue;
  readonly reduceWeightedSupport: DecimalValue;
  readonly addAgreeingGroupCount: number;
  readonly reduceAgreeingGroupCount: number;
  readonly groups: readonly DailyDecisionGroupTrace[];
}

const zero = planningConstant("0");
const hundred = planningConstant("100");
function maximum(a: DecimalValue, b: DecimalValue): DecimalValue {
  return a.compare(b) >= 0 ? a : b;
}
function conditionTrace(
  condition: DecisionCondition,
  observation: DailySelectorObservation,
): DailyDecisionConditionTrace {
  if (observation.status !== "available" || observation.value === undefined)
    return {
      ...condition,
      status: observation.status === "absent" ? "absent" : "unavailable",
    };
  const comparison = observation.value.compare(condition.threshold);
  const matches = {
    lt: comparison < 0,
    lte: comparison <= 0,
    eq: comparison === 0,
    gte: comparison >= 0,
    gt: comparison > 0,
  };
  return {
    ...condition,
    value: observation.value,
    status: matches[condition.comparison] ? "matched" : "unmatched",
  };
}

/** Pure evaluation of U2's admitted view; this does not mint admission or execution authority. */
export function evaluateDailyDecision(
  inputs: DailyPlanningInputs,
): Result<DailyDecisionEvaluation> {
  // Reparse the policy and validate every operand this public entry point uses.
  // Evidence identities and quality admission remain owned by input preparation.
  if (!isRecord(inputs))
    return invalidPlanning("invalid daily decision inputs");
  const parsed = createDecisionPolicy(inputs.decisionPolicy);
  if (!parsed.ok) return parsed;
  const policy = parsed.value;
  if (
    !isDecimalValue(inputs.evidenceConfidence) ||
    !boundedList(inputs.selectors, policy.selectors.length) ||
    inputs.selectors.length !== policy.selectors.length ||
    !policy.symbolApplicability.some((symbol) => symbol === inputs.symbol)
  )
    return invalidPlanning("invalid daily decision inputs");
  const confidence = planningDecimal(inputs.evidenceConfidence, false, hundred);
  if (!confidence.ok) return confidence;
  const observations = new Map<string, DailySelectorObservation>();
  for (const row of inputs.selectors) {
    if (
      !closedRecord(row, ["selectorId", "status", "value"]) ||
      typeof row.selectorId !== "string" ||
      observations.has(row.selectorId)
    )
      return invalidPlanning("invalid daily selector observation");
    const selector = policy.selectors.find(
      (item) => item.id === row.selectorId,
    );
    if (!selector) return invalidPlanning("unknown daily selector observation");
    if (row.status === "available") {
      if (!isDecimalValue(row.value) || row.value.toString().length > 128)
        return invalidPlanning("invalid daily selector operand");
      observations.set(row.selectorId, {
        selectorId: row.selectorId,
        status: "available",
        value: row.value,
      });
    } else if (
      (row.status === "unavailable" || row.status === "absent") &&
      !Object.hasOwn(row, "value") &&
      !selector.required
    ) {
      observations.set(row.selectorId, {
        selectorId: row.selectorId,
        status: row.status,
      });
    } else return invalidPlanning("invalid daily selector status");
  }

  let addWeightedSupport = zero;
  let reduceWeightedSupport = zero;
  let holdWeightedSupport = zero;
  let addAgreeingGroupCount = 0;
  let reduceAgreeingGroupCount = 0;
  const groups: DailyDecisionGroupTrace[] = [];
  for (const group of [...policy.groups].sort((a, b) =>
    textOrder(a.id, b.id),
  )) {
    let addSupport = zero;
    let reduceSupport = zero;
    let holdSupport = zero;
    const rules: DailyDecisionRuleTrace[] = [];
    for (const rule of [...group.rules].sort((a, b) => textOrder(a.id, b.id))) {
      const conditions: DailyDecisionConditionTrace[] = [];
      for (const condition of rule.conditions) {
        const observation = observations.get(condition.selectorId);
        if (!observation)
          return invalidPlanning("missing daily selector observation");
        conditions.push(conditionTrace(condition, observation));
      }
      const matched = conditions.every(
        (condition) => condition.status === "matched",
      );
      rules.push({
        ruleId: rule.id,
        target: rule.target,
        support: rule.support,
        matched,
        conditions,
      });
      if (matched) {
        switch (rule.target) {
          case "ADD_LONG":
            addSupport = maximum(addSupport, rule.support);
            break;
          case "REDUCE_LONG":
            reduceSupport = maximum(reduceSupport, rule.support);
            break;
          case "HOLD_LONG":
            holdSupport = maximum(holdSupport, rule.support);
            break;
        }
      }
    }
    const addContribution = group.weight.multiply(addSupport);
    const reduceContribution = group.weight.multiply(reduceSupport);
    const holdContribution = group.weight.multiply(holdSupport);
    addWeightedSupport = addWeightedSupport.add(addContribution);
    reduceWeightedSupport = reduceWeightedSupport.add(reduceContribution);
    holdWeightedSupport = holdWeightedSupport.add(holdContribution);
    const agreeingDirection =
      addSupport.isPositive() && addSupport.compare(reduceSupport) > 0
        ? "ADD_LONG"
        : reduceSupport.isPositive() && reduceSupport.compare(addSupport) > 0
          ? "REDUCE_LONG"
          : null;
    if (agreeingDirection === "ADD_LONG") addAgreeingGroupCount += 1;
    if (agreeingDirection === "REDUCE_LONG") reduceAgreeingGroupCount += 1;
    groups.push({
      groupId: group.id,
      weight: group.weight,
      addSupport,
      reduceSupport,
      holdSupport,
      addWeightedSupport: addContribution,
      reduceWeightedSupport: reduceContribution,
      holdWeightedSupport: holdContribution,
      agreeingDirection,
      rules,
    });
  }
  const addQualified =
    addWeightedSupport.compare(policy.addLong.supportThreshold) >= 0 &&
    addAgreeingGroupCount >= policy.addLong.minAgreeingGroups;
  const reduceQualified =
    reduceWeightedSupport.compare(policy.reduceLong.supportThreshold) >= 0 &&
    reduceAgreeingGroupCount >= policy.reduceLong.minAgreeingGroups;
  const recommendation =
    addQualified === reduceQualified
      ? "HOLD_LONG"
      : addQualified
        ? "ADD_LONG"
        : "REDUCE_LONG";
  const decisionSupport =
    recommendation === "ADD_LONG"
      ? addWeightedSupport
      : recommendation === "REDUCE_LONG"
        ? reduceWeightedSupport
        : holdWeightedSupport;
  const reasons =
    recommendation === "HOLD_LONG"
      ? [
          addQualified
            ? "DIRECTIONAL_CONFLICT"
            : "INSUFFICIENT_DIRECTIONAL_AGREEMENT",
        ]
      : [`${recommendation}_QUALIFIED`];
  return ok(
    deepFreeze({
      recommendation,
      decisionSupport,
      decisionConfidence:
        confidence.value.compare(decisionSupport) <= 0
          ? confidence.value
          : decisionSupport,
      reasons,
      addWeightedSupport,
      reduceWeightedSupport,
      addAgreeingGroupCount,
      reduceAgreeingGroupCount,
      groups,
    }),
  );
}
