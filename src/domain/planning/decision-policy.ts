import {
  hashCanonical,
  type PlanHash,
} from "../identity/canonical-serialization.js";
import {
  MARKET_EVIDENCE_SYMBOLS,
  type MarketEvidenceSymbol,
} from "../market/market-evidence-bundle.js";
import {
  LIQUIDATION_EVIDENCE_ASSETS,
  type LiquidationTargetAsset,
} from "../liquidation/liquidation-evidence-bundle.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import {
  isDecimalValue,
  parseDecimal,
  type DecimalValue,
} from "../shared/decimal.js";
import { ok, type Result } from "../shared/result.js";
import { requireIdentifier } from "../shared/validation.js";
import {
  boundedList,
  canonicalOrder,
  closedRecord,
  invalidPlanning,
  planningConstant,
  planningDecimal,
  textOrder,
} from "./planning-validation.js";

export const DECISION_POLICY_SCHEMA_VERSION = "decision-policy/v1" as const;
export const DAILY_RECOMMENDATIONS = Object.freeze([
  "ADD_LONG",
  "REDUCE_LONG",
  "HOLD_LONG",
] as const);
export type DailyRecommendation = (typeof DAILY_RECOMMENDATIONS)[number];
export type PlanningSymbol = MarketEvidenceSymbol;
export type PlanningAsset = LiquidationTargetAsset;
export type NumericComparison = "lt" | "lte" | "eq" | "gte" | "gt";
export const DECISION_POLICY_LIMITS = Object.freeze({
  selectors: 128,
  groups: 32,
  rulesPerGroup: 64,
  conditionsPerRule: 16,
});

interface SelectorBase {
  readonly id: string;
  readonly required: boolean;
}
type NativeReference<K extends string, F extends string> = {
  readonly source: "native";
  readonly requestId: string;
  readonly kind: K;
  readonly field: F;
};
export type SymbolNativeReference = (
  | NativeReference<
      | "close-return"
      | "maximum-drawdown"
      | "realized-volatility"
      | "open-interest-relative-change",
      "percent"
    >
  | NativeReference<"atr", "atr" | "normalizedPercent">
  | NativeReference<
      "volatility-comparison",
      "recentPercent" | "referencePercent" | "ratio"
    >
  | NativeReference<
      "funding-change" | "open-interest-absolute-change",
      "change"
    >
) & { readonly symbol: PlanningSymbol };
export type NativeEvidenceReference =
  | SymbolNativeReference
  | (NativeReference<
      "liquidation-window",
      "longUsd" | "shortUsd" | "totalUsd" | "imbalance"
    > & { readonly asset: PlanningAsset });
export type ExternalApplicability =
  | { readonly scope: "global"; readonly symbols: readonly PlanningSymbol[] }
  | { readonly scope: "symbol"; readonly symbol: PlanningSymbol };
export type ExternalEvidenceReference = {
  readonly source: "external";
  readonly applicability: ExternalApplicability;
} & (
  | {
      readonly family: "market-regime-score";
      readonly field: "score" | "confidence";
      readonly direction: "higher-is-healthier";
    }
  | {
      readonly family: "early-warning-risk";
      readonly field: "score" | "confidence";
      readonly direction: "higher-is-warning";
    }
  | {
      readonly family: "liquidity-stress";
      readonly field: "score" | "confidence";
      readonly direction: "higher-is-stress";
    }
  | {
      readonly family: "trap";
      readonly field:
        "confidence" | "continuation" | "reversal" | "squeeze" | "range";
    }
);
export type TickerField =
  | "bid"
  | "ask"
  | "last"
  | "markPrice"
  | "indexPrice"
  | "fundingRate"
  | "openInterest"
  | "volume24h"
  | "turnover24h";
export type EvidenceSelector = SelectorBase &
  (
    | NativeEvidenceReference
    | ExternalEvidenceReference
    | {
        readonly source: "ticker";
        readonly symbol: PlanningSymbol;
        readonly field: TickerField;
      }
  );
export interface DecisionCondition {
  readonly selectorId: string;
  readonly comparison: NumericComparison;
  readonly threshold: DecimalValue;
}
export interface DecisionRule {
  readonly id: string;
  readonly target: DailyRecommendation;
  readonly support: DecimalValue;
  readonly conditions: readonly DecisionCondition[];
}
export interface DecisionGroup {
  readonly id: string;
  readonly weight: DecimalValue;
  readonly rules: readonly DecisionRule[];
}
export interface DirectionalQualification {
  readonly supportThreshold: DecimalValue;
  readonly minAgreeingGroups: number;
}
/**
 * v1 mechanics are fixed by the version, not configurable policy fields.
 * Conditions are AND; separate rules supply OR. Each group's target support
 * is the maximum matched rule support (zero when none match). Weighted target
 * supports are independent sums across all groups. A group agrees ADD only
 * when add > reduce and add > 0; REDUCE is symmetric, and ties agree neither.
 * Each direction must meet both its weighted threshold and agreeing-group
 * quorum. Exactly one qualifier wins; both or neither resolve to HOLD.
 * HOLD support comes exclusively from matched HOLD rules. Confidence is
 * min(evidenceConfidence, selected support), never a success probability.
 */
export interface DecisionPolicy {
  readonly schemaVersion: typeof DECISION_POLICY_SCHEMA_VERSION;
  readonly policyVersion: string;
  readonly symbolApplicability: readonly PlanningSymbol[];
  readonly selectors: readonly EvidenceSelector[];
  readonly groups: readonly DecisionGroup[];
  readonly addLong: DirectionalQualification;
  readonly reduceLong: DirectionalQualification;
  readonly reductionFraction: DecimalValue;
}

const nativeFields = {
  "close-return": ["percent"],
  "maximum-drawdown": ["percent"],
  atr: ["atr", "normalizedPercent"],
  "realized-volatility": ["percent"],
  "volatility-comparison": ["recentPercent", "referencePercent", "ratio"],
  "funding-change": ["change"],
  "open-interest-absolute-change": ["change"],
  "open-interest-relative-change": ["percent"],
  "liquidation-window": ["longUsd", "shortUsd", "totalUsd", "imbalance"],
} as const;
const directions = {
  "market-regime-score": "higher-is-healthier",
  "early-warning-risk": "higher-is-warning",
  "liquidity-stress": "higher-is-stress",
} as const;
const tickerFields: readonly string[] = [
  "bid",
  "ask",
  "last",
  "markPrice",
  "indexPrice",
  "fundingRate",
  "openInterest",
  "volume24h",
  "turnover24h",
];
const hundred = planningConstant("100");
const one = planningConstant("1");

export function isPlanningSymbol(value: unknown): value is PlanningSymbol {
  return MARKET_EVIDENCE_SYMBOLS.some((symbol) => symbol === value);
}

function applicability(
  input: unknown,
  symbols: readonly PlanningSymbol[],
): Result<ExternalApplicability> {
  if (!closedRecord(input, ["scope", "symbols", "symbol"]))
    return invalidPlanning();
  if (
    input.scope === "symbol" &&
    closedRecord(input, ["scope", "symbol"]) &&
    isPlanningSymbol(input.symbol) &&
    symbols.includes(input.symbol)
  )
    return ok({ scope: "symbol", symbol: input.symbol });
  if (
    input.scope !== "global" ||
    !closedRecord(input, ["scope", "symbols"]) ||
    !boundedList(input.symbols, MARKET_EVIDENCE_SYMBOLS.length) ||
    !input.symbols.every(isPlanningSymbol) ||
    !input.symbols.every((s) => symbols.includes(s)) ||
    new Set(input.symbols).size !== input.symbols.length
  )
    return invalidPlanning();
  return ok({ scope: "global", symbols: [...input.symbols].sort(textOrder) });
}

export function parseEvidenceSelector(
  input: unknown,
  symbols: readonly PlanningSymbol[],
): Result<EvidenceSelector> {
  if (
    !closedRecord(input, [
      "id",
      "required",
      "source",
      "requestId",
      "kind",
      "field",
      "symbol",
      "asset",
      "family",
      "direction",
      "applicability",
    ])
  )
    return invalidPlanning();
  const id = requireIdentifier(input.id, "id");
  if (!id.ok || typeof input.required !== "boolean") return invalidPlanning();
  const base = { id: id.value, required: input.required };
  if (input.source === "native") {
    const liquidation = input.kind === "liquidation-window";
    if (
      !closedRecord(input, [
        "id",
        "required",
        "source",
        "requestId",
        "kind",
        "field",
        liquidation ? "asset" : "symbol",
      ])
    )
      return invalidPlanning();
    const request = requireIdentifier(input.requestId, "requestId");
    if (
      !request.ok ||
      request.value.startsWith("external:") ||
      typeof input.kind !== "string" ||
      !Object.hasOwn(nativeFields, input.kind) ||
      typeof input.field !== "string"
    )
      return invalidPlanning();
    const kind = input.kind as keyof typeof nativeFields;
    if (!(nativeFields[kind] as readonly string[]).includes(input.field))
      return invalidPlanning();
    if (
      liquidation
        ? !LIQUIDATION_EVIDENCE_ASSETS.some((asset) => asset === input.asset) ||
          !symbols.some((s) => s === `${input.asset as string}USDT`)
        : !isPlanningSymbol(input.symbol) || !symbols.includes(input.symbol)
    )
      return invalidPlanning();
    // The closed kind/field/context combinations above establish this discriminated union.
    return ok({
      ...base,
      source: "native",
      requestId: request.value,
      kind,
      field: input.field,
      ...(liquidation ? { asset: input.asset } : { symbol: input.symbol }),
    } as EvidenceSelector);
  }
  if (input.source === "ticker") {
    if (
      !closedRecord(input, ["id", "required", "source", "symbol", "field"]) ||
      !isPlanningSymbol(input.symbol) ||
      !symbols.includes(input.symbol) ||
      typeof input.field !== "string" ||
      !tickerFields.includes(input.field)
    )
      return invalidPlanning();
    return ok({
      ...base,
      source: "ticker",
      symbol: input.symbol,
      field: input.field as TickerField,
    });
  }
  if (input.source === "external") {
    const trap = input.family === "trap";
    if (
      !closedRecord(input, [
        "id",
        "required",
        "source",
        "family",
        "field",
        "applicability",
        ...(trap ? [] : ["direction"]),
      ])
    )
      return invalidPlanning();
    const applies = applicability(input.applicability, symbols);
    if (!applies.ok || typeof input.field !== "string")
      return invalidPlanning();
    if (trap) {
      if (
        ![
          "confidence",
          "continuation",
          "reversal",
          "squeeze",
          "range",
        ].includes(input.field)
      )
        return invalidPlanning();
      return ok({
        ...base,
        source: "external",
        family: "trap",
        field: input.field,
        applicability: applies.value,
      } as EvidenceSelector);
    }
    if (
      typeof input.family !== "string" ||
      !Object.hasOwn(directions, input.family) ||
      !["score", "confidence"].includes(input.field)
    )
      return invalidPlanning();
    const family = input.family as keyof typeof directions;
    if (input.direction !== directions[family]) return invalidPlanning();
    return ok({
      ...base,
      source: "external",
      family,
      field: input.field,
      direction: directions[family],
      applicability: applies.value,
    } as EvidenceSelector);
  }
  return invalidPlanning();
}

function qualification(
  input: unknown,
  groupCount: number,
): Result<DirectionalQualification> {
  if (!closedRecord(input, ["supportThreshold", "minAgreeingGroups"]))
    return invalidPlanning();
  const threshold = planningDecimal(input.supportThreshold, true, hundred);
  if (
    !threshold.ok ||
    typeof input.minAgreeingGroups !== "number" ||
    !Number.isSafeInteger(input.minAgreeingGroups) ||
    input.minAgreeingGroups < 1 ||
    input.minAgreeingGroups > groupCount
  )
    return invalidPlanning();
  return ok({
    supportThreshold: threshold.value,
    minAgreeingGroups: input.minAgreeingGroups,
  });
}

export function createDecisionPolicy(input: unknown): Result<DecisionPolicy> {
  if (
    !closedRecord(input, [
      "schemaVersion",
      "policyVersion",
      "symbolApplicability",
      "selectors",
      "groups",
      "addLong",
      "reduceLong",
      "reductionFraction",
    ]) ||
    input.schemaVersion !== DECISION_POLICY_SCHEMA_VERSION
  )
    return invalidPlanning();
  const version = requireIdentifier(input.policyVersion, "policyVersion");
  if (
    !version.ok ||
    !boundedList(input.symbolApplicability, MARKET_EVIDENCE_SYMBOLS.length) ||
    !input.symbolApplicability.every(isPlanningSymbol) ||
    new Set(input.symbolApplicability).size !==
      input.symbolApplicability.length ||
    !boundedList(input.selectors, DECISION_POLICY_LIMITS.selectors) ||
    !boundedList(input.groups, DECISION_POLICY_LIMITS.groups)
  )
    return invalidPlanning();
  const symbols = [...input.symbolApplicability].sort(textOrder);
  const selectors: EvidenceSelector[] = [];
  for (const row of input.selectors) {
    const parsed = parseEvidenceSelector(row, symbols);
    if (!parsed.ok || selectors.some((s) => s.id === parsed.value.id))
      return invalidPlanning();
    selectors.push(parsed.value);
  }
  const groups: DecisionGroup[] = [];
  const ruleIds = new Set<string>();
  for (const row of input.groups) {
    if (!closedRecord(row, ["id", "weight", "rules"])) return invalidPlanning();
    const id = requireIdentifier(row.id, "id");
    const weight = planningDecimal(row.weight, true, one);
    if (
      !id.ok ||
      !weight.ok ||
      groups.some((g) => g.id === id.value) ||
      !boundedList(row.rules, DECISION_POLICY_LIMITS.rulesPerGroup)
    )
      return invalidPlanning();
    const rules: DecisionRule[] = [];
    for (const rule of row.rules) {
      if (!closedRecord(rule, ["id", "target", "support", "conditions"]))
        return invalidPlanning();
      const ruleId = requireIdentifier(rule.id, "id");
      const support = planningDecimal(rule.support, false, hundred);
      if (
        !ruleId.ok ||
        ruleIds.has(ruleId.value) ||
        !support.ok ||
        !DAILY_RECOMMENDATIONS.some((t) => t === rule.target) ||
        !boundedList(rule.conditions, DECISION_POLICY_LIMITS.conditionsPerRule)
      )
        return invalidPlanning();
      ruleIds.add(ruleId.value);
      const conditions: DecisionCondition[] = [];
      for (const condition of rule.conditions) {
        if (
          !closedRecord(condition, ["selectorId", "comparison", "threshold"]) ||
          !selectors.some((s) => s.id === condition.selectorId) ||
          !["lt", "lte", "eq", "gte", "gt"].some(
            (op) => op === condition.comparison,
          )
        )
          return invalidPlanning();
        const value = condition.threshold;
        if (
          !isDecimalValue(value) &&
          (typeof value !== "string" || value.length > 128)
        )
          return invalidPlanning();
        const threshold = isDecimalValue(value)
          ? ok(value)
          : parseDecimal(value);
        if (!threshold.ok || threshold.value.toString().length > 128)
          return invalidPlanning();
        conditions.push({
          selectorId: condition.selectorId as string,
          comparison: condition.comparison as NumericComparison,
          threshold: threshold.value,
        });
      }
      const ordered = canonicalOrder(conditions);
      if (!ordered.ok) return ordered;
      rules.push({
        id: ruleId.value,
        target: rule.target as DailyRecommendation,
        support: support.value,
        conditions: ordered.value,
      });
    }
    rules.sort((a, b) => textOrder(a.id, b.id));
    groups.push({ id: id.value, weight: weight.value, rules });
  }
  if (
    groups
      .reduce((sum, g) => sum.add(g.weight), planningConstant("0"))
      .compare(one) !== 0
  )
    return invalidPlanning("group weights must sum exactly to 1");
  const add = qualification(input.addLong, groups.length);
  const reduce = qualification(input.reduceLong, groups.length);
  const fraction = planningDecimal(input.reductionFraction, true, one);
  if (!add.ok || !reduce.ok || !fraction.ok) return invalidPlanning();
  groups.sort((a, b) => textOrder(a.id, b.id));
  selectors.sort((a, b) => textOrder(a.id, b.id));
  return ok(
    deepFreeze({
      schemaVersion: DECISION_POLICY_SCHEMA_VERSION,
      policyVersion: version.value,
      symbolApplicability: symbols,
      selectors,
      groups,
      addLong: add.value,
      reduceLong: reduce.value,
      reductionFraction: fraction.value,
    }),
  );
}

export function decisionPolicyHash(input: unknown): Result<PlanHash> {
  const policy = createDecisionPolicy(input);
  return policy.ok ? hashCanonical(policy.value) : policy;
}
