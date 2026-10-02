import {
  hashCanonical,
  type PlanHash,
} from "../identity/canonical-serialization.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import type { DecimalValue } from "../shared/decimal.js";
import { ok, type Result } from "../shared/result.js";
import { requireIdentifier } from "../shared/validation.js";
import {
  isPlanningSymbol,
  parseEvidenceSelector,
  type PlanningSymbol,
} from "./decision-policy.js";
import {
  boundedList,
  closedRecord,
  invalidPlanning,
  planningConstant,
  planningDecimal,
} from "./planning-validation.js";

export const PLANNING_POLICY_SCHEMA_VERSION = "planning-policy/v1" as const;
export const MAX_PLANNING_LEVELS = 64;
export interface AtrRequestSelector {
  readonly source: "native";
  readonly requestId: string;
  readonly kind: "atr";
  readonly field: "atr";
  readonly symbol: PlanningSymbol;
  readonly required: true;
}
export interface PlanningLevel {
  readonly atrOffset: DecimalValue;
  readonly allocationWeight: DecimalValue;
  readonly takeProfitAtrDistance: DecimalValue;
}
export interface PlanningPolicy {
  readonly schemaVersion: typeof PLANNING_POLICY_SCHEMA_VERSION;
  readonly policyVersion: string;
  readonly atrSelector: AtrRequestSelector;
  readonly anchor: "bid-capped-below-ask/v1";
  readonly entryRounding: "floor";
  readonly quantityRounding: "floor";
  readonly takeProfitRounding: "ceil";
  readonly timeInForce: "GTC";
  readonly levels: readonly PlanningLevel[];
}

export function createPlanningPolicy(input: unknown): Result<PlanningPolicy> {
  if (
    !closedRecord(input, [
      "schemaVersion",
      "policyVersion",
      "atrSelector",
      "anchor",
      "entryRounding",
      "quantityRounding",
      "takeProfitRounding",
      "timeInForce",
      "levels",
    ]) ||
    input.schemaVersion !== PLANNING_POLICY_SCHEMA_VERSION ||
    input.anchor !== "bid-capped-below-ask/v1" ||
    input.entryRounding !== "floor" ||
    input.quantityRounding !== "floor" ||
    input.takeProfitRounding !== "ceil" ||
    input.timeInForce !== "GTC"
  )
    return invalidPlanning();
  const version = requireIdentifier(input.policyVersion, "policyVersion");
  if (
    !version.ok ||
    !closedRecord(input.atrSelector, [
      "source",
      "requestId",
      "kind",
      "field",
      "symbol",
      "required",
    ]) ||
    !isPlanningSymbol(input.atrSelector.symbol) ||
    !boundedList(input.levels, MAX_PLANNING_LEVELS)
  )
    return invalidPlanning();
  const selector = parseEvidenceSelector(
    { ...input.atrSelector, id: "grid-atr" },
    [input.atrSelector.symbol],
  );
  if (
    !selector.ok ||
    selector.value.source !== "native" ||
    selector.value.kind !== "atr" ||
    selector.value.field !== "atr" ||
    selector.value.required !== true
  )
    return invalidPlanning(
      "grid ATR must select mandatory native ATR in price units",
    );
  const levels: PlanningLevel[] = [];
  const one = planningConstant("1");
  for (const row of input.levels) {
    if (
      !closedRecord(row, [
        "atrOffset",
        "allocationWeight",
        "takeProfitAtrDistance",
      ])
    )
      return invalidPlanning();
    const offset = planningDecimal(row.atrOffset);
    const weight = planningDecimal(row.allocationWeight, true, one);
    const tp = planningDecimal(row.takeProfitAtrDistance, true);
    if (
      !offset.ok ||
      !weight.ok ||
      !tp.ok ||
      (levels.length > 0 &&
        offset.value.compare(levels[levels.length - 1]!.atrOffset) <= 0)
    )
      return invalidPlanning();
    levels.push({
      atrOffset: offset.value,
      allocationWeight: weight.value,
      takeProfitAtrDistance: tp.value,
    });
  }
  if (
    levels
      .reduce((sum, l) => sum.add(l.allocationWeight), planningConstant("0"))
      .compare(one) !== 0
  )
    return invalidPlanning("allocation weights must sum exactly to 1");
  const s = selector.value;
  return ok(
    deepFreeze({
      schemaVersion: PLANNING_POLICY_SCHEMA_VERSION,
      policyVersion: version.value,
      atrSelector: {
        source: "native" as const,
        requestId: s.requestId,
        kind: "atr" as const,
        field: "atr" as const,
        symbol: s.symbol,
        required: true as const,
      },
      anchor: "bid-capped-below-ask/v1" as const,
      entryRounding: "floor" as const,
      quantityRounding: "floor" as const,
      takeProfitRounding: "ceil" as const,
      timeInForce: "GTC" as const,
      levels,
    }),
  );
}

export function planningPolicyHash(input: unknown): Result<PlanHash> {
  const policy = createPlanningPolicy(input);
  return policy.ok ? hashCanonical(policy.value) : policy;
}
