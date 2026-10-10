import {
  hashCanonical,
  type PlanHash,
} from "../identity/canonical-serialization.js";
import { rehydrateLiquidationEvidenceBundle } from "../liquidation/liquidation-evidence-bundle.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { domainError } from "../shared/errors.js";
import { fail, ok, type Result } from "../shared/result.js";
import type { DecimalValue } from "../shared/decimal.js";
import {
  evaluateDailyDecision,
  type DailyDecisionEvaluation,
} from "./daily-decision.js";
import {
  compileDailyEntryGrid,
  type DailyCandidateLeg,
} from "./daily-entry-grid.js";
import {
  prepareDailyPlanningInputs,
  type DailyPlanningInput,
  type DailyPlanningInputs,
} from "./daily-planning-inputs.js";
import type { OrderIntent } from "./order-intent.js";
import { closedRecord } from "./planning-validation.js";

export const DAILY_DECISION_PLAN_SCHEMA_VERSION =
  "daily-decision-plan/v1" as const;
interface DailyPlanCommon {
  readonly schemaVersion: typeof DAILY_DECISION_PLAN_SCHEMA_VERSION;
  readonly planId: string;
  readonly decisionId: string;
  readonly inputSeed: PlanHash;
  readonly inputIdentity: DailyPlanningInputs["identity"];
  /** Canonical replay facts only; restored admission metadata never becomes live authority. */
  readonly inputs: DailyPlanningInput;
  readonly decision: DailyDecisionEvaluation;
  readonly contentHash: PlanHash;
}
export type DailyDecisionPlan = DailyPlanCommon &
  (
    | {
        readonly decision: DailyDecisionEvaluation & {
          readonly recommendation: "ADD_LONG";
        };
        readonly candidateLegs: readonly DailyCandidateLeg[];
        readonly orderIntents: readonly OrderIntent[];
        readonly reductionFraction?: never;
      }
    | {
        readonly decision: DailyDecisionEvaluation & {
          readonly recommendation: "REDUCE_LONG";
        };
        readonly reductionFraction: DecimalValue;
        readonly candidateLegs?: never;
        readonly orderIntents?: never;
      }
    | {
        readonly decision: DailyDecisionEvaluation & {
          readonly recommendation: "HOLD_LONG";
        };
        readonly candidateLegs?: never;
        readonly orderIntents?: never;
        readonly reductionFraction?: never;
      }
  );
function invalid(message = "INVALID_DAILY_PLAN"): Result<never> {
  return fail(domainError("INVALID_PLAN", message));
}

/** Deterministic preparation/replay. This constructor issues no risk, approval or execution proof. */
export function createDailyDecisionPlan(
  input: DailyPlanningInput,
): Result<DailyDecisionPlan> {
  const prepared = prepareDailyPlanningInputs(input);
  if (!prepared.ok) return prepared;
  const p = prepared.value;
  const decision = evaluateDailyDecision(p);
  if (!decision.ok) return decision;
  const seed = hashCanonical({
    schemaVersion: "daily-input-seed/v1",
    symbol: p.symbol,
    allocation: p.allocation,
    identity: p.identity,
  });
  if (!seed.ok) return seed;
  const decisionId = hashCanonical({
    schemaVersion: "daily-decision-id/v1",
    seed: seed.value,
  });
  const planId = hashCanonical({
    schemaVersion: "daily-plan-id/v1",
    seed: seed.value,
  });
  if (!decisionId.ok || !planId.ok) return invalid();
  const liquidation =
    input.liquidation === undefined
      ? undefined
      : rehydrateLiquidationEvidenceBundle(input.liquidation);
  if (liquidation && !liquidation.ok) return liquidation;
  const inputs: DailyPlanningInput = {
    market: p.market,
    analytics: p.analytics,
    assessment: p.assessment,
    symbol: p.symbol,
    allocation: p.allocation,
    decisionPolicy: p.decisionPolicy,
    planningPolicy: p.planningPolicy,
    ...(liquidation?.ok ? { liquidation: liquidation.value } : {}),
  };
  const common = {
    schemaVersion: DAILY_DECISION_PLAN_SCHEMA_VERSION,
    planId: `daily-plan:${planId.value}`,
    decisionId: `daily-decision:${decisionId.value}`,
    inputSeed: seed.value,
    inputIdentity: p.identity,
    inputs,
  };
  const recommendation = decision.value.recommendation;
  let payload;
  if (recommendation === "ADD_LONG") {
    const grid = compileDailyEntryGrid(p, recommendation, seed.value);
    if (!grid.ok) return grid;
    payload = {
      ...common,
      decision: { ...decision.value, recommendation },
      candidateLegs: grid.value,
      orderIntents: grid.value.map((leg) => leg.intent),
    };
  } else if (recommendation === "REDUCE_LONG") {
    payload = {
      ...common,
      decision: { ...decision.value, recommendation },
      reductionFraction: p.decisionPolicy.reductionFraction,
    };
  } else {
    payload = { ...common, decision: { ...decision.value, recommendation } };
  }
  const contentHash = hashCanonical(payload);
  if (!contentHash.ok) return contentHash;
  return ok(deepFreeze({ ...payload, contentHash: contentHash.value }));
}

export function rehydrateDailyDecisionPlan(
  input: unknown,
): Result<DailyDecisionPlan> {
  if (
    !closedRecord(input, [
      "schemaVersion",
      "planId",
      "decisionId",
      "inputSeed",
      "inputIdentity",
      "inputs",
      "decision",
      "contentHash",
      "candidateLegs",
      "orderIntents",
      "reductionFraction",
    ]) ||
    input.schemaVersion !== DAILY_DECISION_PLAN_SCHEMA_VERSION ||
    !closedRecord(input.inputs, [
      "market",
      "analytics",
      "liquidation",
      "assessment",
      "symbol",
      "allocation",
      "decisionPolicy",
      "planningPolicy",
    ])
  )
    return invalid();
  const i = input.inputs;
  const reconstructed = createDailyDecisionPlan({
    market: i.market,
    analytics: i.analytics,
    assessment: i.assessment,
    symbol: i.symbol,
    allocation: i.allocation,
    decisionPolicy: i.decisionPolicy,
    planningPolicy: i.planningPolicy,
    ...(i.liquidation === undefined ? {} : { liquidation: i.liquidation }),
  });
  if (!reconstructed.ok) return reconstructed;
  const expected = hashCanonical(reconstructed.value);
  const actual = hashCanonical(input);
  if (!expected.ok || !actual.ok || expected.value !== actual.value)
    return fail(
      domainError(
        "PLAN_HASH_MISMATCH",
        "daily artifact differs from its canonical replay",
      ),
    );
  return reconstructed;
}
