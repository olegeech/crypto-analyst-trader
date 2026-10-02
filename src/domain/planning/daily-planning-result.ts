import type { DecimalValue } from "../shared/decimal.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { ok, type Result } from "../shared/result.js";
import {
  requireHash,
  requireIdentifier,
  requireSafeText,
} from "../shared/validation.js";
import type { DailyRecommendation } from "./decision-policy.js";
import {
  boundedList,
  canonicalOrder,
  closedRecord,
  invalidPlanning,
} from "./planning-validation.js";

export const DAILY_PLANNING_BLOCK_CODES = Object.freeze([
  "MISSING_QUALITY_ASSESSMENT",
  "QUALITY_BLOCKED",
  "MISSING_EVIDENCE_CONFIDENCE",
  "INCOMPATIBLE_IDENTITIES",
  "HASH_MISMATCH",
  "INVALID_POLICY",
  "MISSING_REQUIRED_EVIDENCE",
  "UNUSABLE_REQUIRED_EVIDENCE",
  "INVALID_CANDIDATE_CONSTRUCTION",
  "MISSING_STATIC_BOUNDS",
] as const);
export type DailyPlanningBlockCode =
  (typeof DAILY_PLANNING_BLOCK_CODES)[number];
export interface DailyPlanningBlockReason {
  readonly code: DailyPlanningBlockCode;
  readonly message: string;
  readonly selectorId?: string;
}
export interface PlanningDiagnosticIdentities {
  readonly qualityAssessmentHash?: string;
  readonly marketHash?: string;
  readonly analyticsHash?: string;
  readonly decisionPolicyHash?: string;
  readonly planningPolicyHash?: string;
}
export interface BlockedDailyPlanningResult {
  readonly status: "blocked";
  readonly reasons: readonly DailyPlanningBlockReason[];
  readonly diagnosticIdentities: PlanningDiagnosticIdentities;
  readonly plan?: never;
  readonly decision?: never;
  readonly orderIntents?: never;
}

/** Shared pre-risk shape; the daily artifact constructor owns concrete validation. */
export interface DailyDecisionSummary {
  readonly recommendation: DailyRecommendation;
  readonly decisionSupport: DecimalValue;
  readonly decisionConfidence: DecimalValue;
  readonly reasons: readonly string[];
}
export type DailyDecisionPlanContract<Leg, Intent> =
  | {
      readonly decision: DailyDecisionSummary & {
        readonly recommendation: "ADD_LONG";
      };
      readonly candidateLegs: readonly Leg[];
      readonly orderIntents: readonly Intent[];
      readonly reductionFraction?: never;
    }
  | {
      readonly decision: DailyDecisionSummary & {
        readonly recommendation: "REDUCE_LONG";
      };
      readonly reductionFraction: DecimalValue;
      readonly candidateLegs?: never;
      readonly orderIntents?: never;
    }
  | {
      readonly decision: DailyDecisionSummary & {
        readonly recommendation: "HOLD_LONG";
      };
      readonly reductionFraction?: never;
      readonly candidateLegs?: never;
      readonly orderIntents?: never;
    };
export interface PreparedDailyPlanningResult<
  Plan extends DailyDecisionPlanContract<unknown, unknown>,
> {
  readonly status: "prepared";
  readonly plan: Plan;
  readonly reasons?: never;
}
export type DailyPlanningResult<
  Plan extends DailyDecisionPlanContract<unknown, unknown>,
> = BlockedDailyPlanningResult | PreparedDailyPlanningResult<Plan>;

export function createBlockedDailyPlanningResult(
  input: unknown,
): Result<BlockedDailyPlanningResult> {
  if (
    !closedRecord(input, ["status", "reasons", "diagnosticIdentities"]) ||
    input.status !== "blocked" ||
    !boundedList(input.reasons, 128) ||
    !closedRecord(input.diagnosticIdentities, [
      "qualityAssessmentHash",
      "marketHash",
      "analyticsHash",
      "decisionPolicyHash",
      "planningPolicyHash",
    ])
  )
    return invalidPlanning("invalid blocked planning result");
  const reasons: DailyPlanningBlockReason[] = [];
  for (const row of input.reasons) {
    if (
      !closedRecord(row, ["code", "message", "selectorId"]) ||
      !DAILY_PLANNING_BLOCK_CODES.some((c) => c === row.code)
    )
      return invalidPlanning();
    const message = requireSafeText(row.message, "message");
    if (!message.ok || message.value.length > 1024) return invalidPlanning();
    const selector = Object.hasOwn(row, "selectorId")
      ? requireIdentifier(row.selectorId, "selectorId")
      : undefined;
    if (selector && !selector.ok) return invalidPlanning();
    reasons.push({
      code: row.code as DailyPlanningBlockCode,
      message: message.value,
      ...(selector?.ok ? { selectorId: selector.value } : {}),
    });
  }
  const identities: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.diagnosticIdentities)) {
    const hash = requireHash(value, key);
    if (!hash.ok) return hash;
    identities[key] = hash.value;
  }
  const ordered = canonicalOrder(reasons);
  if (!ordered.ok) return ordered;
  return ok(
    deepFreeze({
      status: "blocked" as const,
      reasons: ordered.value,
      diagnosticIdentities: identities,
    }),
  );
}
