import type { DataQualityBoundary } from "./data-quality-assessment.js";
import { createDecisionPolicy } from "../domain/planning/decision-policy.js";
import { createPlanningPolicy } from "../domain/planning/planning-policy.js";
import {
  createDailyDecisionPlan,
  type DailyDecisionPlan,
} from "../domain/planning/daily-decision-plan.js";
import {
  createBlockedDailyPlanningResult,
  type DailyPlanningResult,
  type DailyPlanningBlockCode,
} from "../domain/planning/daily-planning-result.js";
import {
  boundedList,
  closedRecord,
  invalidPlanning,
} from "../domain/planning/planning-validation.js";
import {
  isQualitySourceInput,
  type QualitySourceInput,
} from "../domain/quality/quality-inputs.js";
import { ok, type Result } from "../domain/shared/result.js";
import { parseUtcTimestamp } from "../domain/shared/time.js";

export interface DailyPlanningBoundary {
  readonly prepare: (input: unknown) => DailyPlanningResult<DailyDecisionPlan>;
}
function blocked(
  code: DailyPlanningBlockCode,
): DailyPlanningResult<DailyDecisionPlan> {
  const result = createBlockedDailyPlanningResult({
    status: "blocked",
    reasons: [{ code, message: code }],
    diagnosticIdentities: {},
  });
  if (!result.ok) throw new Error("invalid internal daily planning reason");
  return result.value;
}
function failureReason(message: string): DailyPlanningBlockCode {
  switch (message) {
    case "QUALITY_BLOCKED":
      return "QUALITY_BLOCKED";
    case "MISSING_EVIDENCE_CONFIDENCE":
      return "MISSING_EVIDENCE_CONFIDENCE";
    case "INPUT_IDENTITY_MISMATCH":
      return "INCOMPATIBLE_IDENTITIES";
    case "MANDATORY_INPUT_UNAVAILABLE":
      return "UNUSABLE_REQUIRED_EVIDENCE";
    case "MISSING_STATIC_BOUNDS":
      return "MISSING_STATIC_BOUNDS";
    case "INVALID_DECISION_POLICY":
    case "INVALID_PLANNING_POLICY":
      return "INVALID_POLICY";
    default:
      return "INVALID_CANDIDATE_CONSTRUCTION";
  }
}
/** Trusted composition selects quality/policies here, never in external preparation JSON. */
export function createDailyPlanningBoundary(configuration: {
  readonly qualityBoundary: DataQualityBoundary;
  readonly decisionPolicy: unknown;
  readonly planningPolicy: unknown;
}): Result<DailyPlanningBoundary> {
  const decision = createDecisionPolicy(configuration.decisionPolicy);
  const planning = createPlanningPolicy(configuration.planningPolicy);
  if (!decision.ok) return decision;
  if (!planning.ok) return planning;
  if (
    !configuration.qualityBoundary ||
    typeof configuration.qualityBoundary.assess !== "function"
  )
    return invalidPlanning("trusted quality boundary is required");
  const assess = configuration.qualityBoundary.assess.bind(
    configuration.qualityBoundary,
  );
  return ok(
    Object.freeze({
      prepare: (input: unknown): DailyPlanningResult<DailyDecisionPlan> => {
        if (
          !closedRecord(input, [
            "sources",
            "symbol",
            "allocation",
            "bundleCutoff",
            "evaluationTime",
          ]) ||
          !boundedList(input.sources, 3) ||
          !input.sources.every(
            (source) =>
              closedRecord(source, [
                "role",
                "value",
                "evidenceRef",
                "expectedBundleHash",
              ]) && isQualitySourceInput(source),
          )
        )
          return blocked("INVALID_POLICY");
        const cutoff = parseUtcTimestamp(input.bundleCutoff);
        const evaluation = parseUtcTimestamp(input.evaluationTime);
        if (!cutoff.ok || !evaluation.ok)
          return blocked("INCOMPATIBLE_IDENTITIES");
        const sources: readonly QualitySourceInput[] = input.sources;
        const assessment = assess({
          sources,
          bundleCutoff: cutoff.value,
          evaluationTime: evaluation.value,
        });
        if (!assessment.ok) return blocked("MISSING_QUALITY_ASSESSMENT");
        if (assessment.value.qualityGate !== "OK")
          return blocked("QUALITY_BLOCKED");
        const market = sources.find((source) => source.role === "market");
        const analytics = sources.find((source) => source.role === "analytics");
        const liquidation = sources.find(
          (source) => source.role === "liquidation",
        );
        if (!market || !analytics) return blocked("MISSING_REQUIRED_EVIDENCE");
        const plan = createDailyDecisionPlan({
          market: market.value,
          analytics: analytics.value,
          ...(liquidation ? { liquidation: liquidation.value } : {}),
          assessment: assessment.value,
          symbol: input.symbol,
          allocation: input.allocation,
          decisionPolicy: decision.value,
          planningPolicy: planning.value,
        });
        return plan.ok
          ? Object.freeze({ status: "prepared", plan: plan.value })
          : blocked(failureReason(plan.error.message));
      },
    }),
  );
}
