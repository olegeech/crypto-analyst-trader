import {
  createMarketEvidenceBundle,
  marketEvidenceContentHash,
  type MarketEvidenceBundle,
  type MarketTickerEvidence,
} from "../market/market-evidence-bundle.js";
import { rehydrateLiquidationEvidenceBundle } from "../liquidation/liquidation-evidence-bundle.js";
import {
  rehydrateAnalyticsEvidenceBundle,
  type AnalyticsEvidenceBundle,
} from "../analytics/analytics-evidence-bundle.js";
import {
  rehydrateDataQualityAssessment,
  type DataQualityAssessment,
} from "../quality/data-quality-assessment.js";
import { hashCanonical } from "../identity/canonical-serialization.js";
import {
  createDecisionPolicy,
  isPlanningSymbol,
  type DecisionPolicy,
  type EvidenceSelector,
} from "./decision-policy.js";
import {
  createPlanningPolicy,
  type PlanningPolicy,
  type AtrRequestSelector,
} from "./planning-policy.js";
import type { InstrumentConstraints } from "../market/instrument-constraints.js";
import { DecimalValue, isDecimalValue } from "../shared/decimal.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { domainError } from "../shared/errors.js";
import { fail, ok, type Result } from "../shared/result.js";
import { isRecord } from "../shared/validation.js";

export interface DailySelectorObservation {
  readonly selectorId: string;
  readonly status: "available" | "unavailable" | "absent";
  readonly value?: DecimalValue;
}
export interface DailyPlanningInputs {
  readonly symbol: string;
  readonly allocation: DecimalValue;
  readonly market: MarketEvidenceBundle;
  readonly analytics: AnalyticsEvidenceBundle;
  readonly assessment: DataQualityAssessment;
  readonly decisionPolicy: DecisionPolicy;
  readonly planningPolicy: PlanningPolicy;
  readonly constraints: InstrumentConstraints;
  readonly ticker: MarketTickerEvidence;
  readonly atr: DecimalValue;
  readonly evidenceConfidence: DecimalValue;
  readonly selectors: readonly DailySelectorObservation[];
  readonly identity: {
    readonly runId: string;
    readonly universeVersion: string;
    readonly bundleCutoff: string;
    readonly marketContentHash: string;
    readonly marketBundleHash: string;
    readonly analyticsContentHash: string;
    readonly analyticsBundleHash: string;
    readonly liquidationBundleHash?: string;
    readonly assessmentHash: string;
    readonly decisionPolicyHash: string;
    readonly planningPolicyHash: string;
    readonly constraintsHash: string;
  };
}
export interface DailyPlanningInput {
  readonly market: unknown;
  readonly analytics: unknown;
  readonly liquidation?: unknown;
  readonly assessment: unknown;
  readonly symbol: unknown;
  readonly allocation: unknown;
  readonly decisionPolicy: unknown;
  readonly planningPolicy: unknown;
}
function invalid(reason: string): Result<never> {
  return fail(domainError("INVALID_VALUE", reason));
}
function selectedField(value: unknown, field: string): unknown {
  return isRecord(value) ? value[field] : undefined;
}
export function prepareDailyPlanningInputs(
  input: DailyPlanningInput,
): Result<DailyPlanningInputs> {
  if (
    !isRecord(input) ||
    Object.values(Object.getOwnPropertyDescriptors(input)).some(
      (descriptor) => !Object.hasOwn(descriptor, "value"),
    )
  )
    return invalid("INPUT_IDENTITY_MISMATCH");
  const decision = createDecisionPolicy(input.decisionPolicy);
  if (!decision.ok) return invalid("INVALID_DECISION_POLICY");
  const planning = createPlanningPolicy(input.planningPolicy);
  if (!planning.ok) return invalid("INVALID_PLANNING_POLICY");
  const assessment = rehydrateDataQualityAssessment(input.assessment);
  if (!assessment.ok) return invalid("INPUT_IDENTITY_MISMATCH");
  if (assessment.value.qualityGate !== "OK") return invalid("QUALITY_BLOCKED");
  if (!assessment.value.evidenceConfidence)
    return invalid("MISSING_EVIDENCE_CONFIDENCE");
  const market = createMarketEvidenceBundle(input.market);
  const analytics = rehydrateAnalyticsEvidenceBundle(input.analytics);
  const allocation = isDecimalValue(input.allocation)
    ? ok(input.allocation)
    : DecimalValue.fromString(input.allocation);
  if (
    !market.ok ||
    !analytics.ok ||
    !allocation.ok ||
    !allocation.value.isPositive() ||
    !isPlanningSymbol(input.symbol) ||
    !decision.value.symbolApplicability.includes(input.symbol)
  )
    return invalid("INPUT_IDENTITY_MISMATCH");
  const analyticsValue = analytics.value;
  const marketContent = marketEvidenceContentHash(market.value);
  const marketBundle = hashCanonical(market.value);
  const analyticsBundle = hashCanonical(analytics.value);
  if (!marketContent.ok || !marketBundle.ok || !analyticsBundle.ok)
    return invalid("INPUT_IDENTITY_MISMATCH");
  const identity = analytics.value.inputIdentity;
  if (
    identity.runId !== market.value.runId ||
    identity.universeVersion !== market.value.universeVersion ||
    identity.bundleCutoff !== market.value.bundleCutoff ||
    assessment.value.bundleCutoff !== market.value.bundleCutoff ||
    identity.marketContentHash !== marketContent.value ||
    identity.marketBundleHash !== marketBundle.value
  )
    return invalid("INPUT_IDENTITY_MISMATCH");
  const disposition = (role: string) =>
    assessment.value.dispositions.find((row) => row.role === role);
  const accepted = (role: string, content: string, bundle?: string) => {
    const row = disposition(role);
    return (
      row?.disposition === "accepted" &&
      row.contentHash === content &&
      (bundle === undefined || row.bundleHash === bundle)
    );
  };
  if (
    !accepted("market", marketContent.value, marketBundle.value) ||
    !accepted("analytics", analytics.value.contentHash, analyticsBundle.value)
  )
    return invalid("INPUT_IDENTITY_MISMATCH");
  let liquidationBundleHash: string | undefined;
  if (input.liquidation !== undefined) {
    const liquidation = rehydrateLiquidationEvidenceBundle(input.liquidation);
    if (!liquidation.ok) return invalid("INPUT_IDENTITY_MISMATCH");
    const hash = hashCanonical(liquidation.value);
    if (
      !hash.ok ||
      liquidation.value.runId !== market.value.runId ||
      liquidation.value.bundleCutoff !== market.value.bundleCutoff ||
      liquidation.value.marketEvidence.universeVersion !==
        market.value.universeVersion ||
      liquidation.value.marketEvidence.contentHash !== marketContent.value ||
      identity.liquidationBundleHash !== hash.value
    )
      return invalid("INPUT_IDENTITY_MISMATCH");
    liquidationBundleHash = hash.value;
    const row = disposition("liquidation");
    if (row?.contentHash !== hash.value || row.bundleHash !== hash.value)
      return invalid("INPUT_IDENTITY_MISMATCH");
  } else if (identity.liquidationBundleHash !== undefined)
    return invalid("INPUT_IDENTITY_MISMATCH");
  const symbol = market.value.symbols.find(
    (row) => row.symbol === input.symbol,
  );
  if (!symbol?.instrument || !symbol.ticker)
    return invalid("MANDATORY_INPUT_UNAVAILABLE");
  const constraints = symbol.instrument.constraints;
  const constraintsHash = hashCanonical(constraints);
  const dHash = hashCanonical(decision.value);
  const pHash = hashCanonical(planning.value);
  if (!constraintsHash.ok || !dHash.ok || !pHash.ok)
    return invalid("INPUT_IDENTITY_MISMATCH");

  // Selectors are closed and validated by the versioned policy parser, never caller paths.
  const nativeOutcomes = [
    ...analyticsValue.priceFeatures,
    ...analyticsValue.derivativeFeatures,
  ];
  const outcomesByRequest = new Map<string, (typeof nativeOutcomes)[number]>();
  for (const row of nativeOutcomes) {
    if (!outcomesByRequest.has(row.requestId))
      outcomesByRequest.set(row.requestId, row);
  }
  function observe(
    selector: EvidenceSelector | AtrRequestSelector,
    selectorId: string,
  ): Result<DailySelectorObservation> {
    let value: unknown;
    let usable = false;
    if (selector.source === "ticker") {
      usable = selector.symbol === input.symbol;
      value = symbol!.ticker![selector.field];
    } else if (selector.source === "native") {
      const row = outcomesByRequest.get(selector.requestId);
      const role = `analytics:${String(selector.requestId)}`;
      const assessed = disposition(role);
      if (
        assessed?.contentHash !== undefined &&
        assessed.contentHash !== analyticsValue.contentHash
      )
        return invalid("INPUT_IDENTITY_MISMATCH");
      if (row && row.kind !== selector.kind)
        return invalid("INPUT_IDENTITY_MISMATCH");
      const context =
        row &&
        (row.kind === "liquidation-window"
          ? "asset" in row &&
            "asset" in selector &&
            row.asset === selector.asset &&
            row.asset === symbol!.instrument!.baseCoin
          : "symbol" in row &&
            "symbol" in selector &&
            row.symbol === selector.symbol &&
            row.symbol === input.symbol);
      usable =
        !!row &&
        row.status !== "unavailable" &&
        !!context &&
        accepted(role, analyticsValue.contentHash);
      if (row?.kind === "liquidation-window")
        usable =
          usable && disposition("liquidation")?.disposition === "accepted";
      value = selectedField(row?.value, String(selector.field));
    } else if (selector.source === "external") {
      const row = analyticsValue.externalEvidence.find(
        (item) => item.family === selector.family,
      );
      const role = `external:${String(selector.family)}`;
      const assessed = disposition(role);
      if (
        row &&
        assessed?.contentHash !== undefined &&
        assessed.contentHash !== row.contentHash
      )
        return invalid("INPUT_IDENTITY_MISMATCH");
      const applicability = selector.applicability;
      const context =
        applicability.scope === "symbol"
          ? applicability.symbol === input.symbol
          : applicability.symbols.some(
              (candidate) => candidate === input.symbol,
            );
      usable =
        !!row &&
        !!context &&
        accepted(role, row.contentHash) &&
        assessed?.admission?.artifactHash === row.contentHash;
      if (
        row?.family !== "trap" &&
        row &&
        (!("direction" in selector) || selector.direction !== row.direction)
      )
        return invalid("INPUT_IDENTITY_MISMATCH");
      value =
        row?.family === "trap"
          ? selector.field === "confidence"
            ? row.confidence
            : selectedField(row.scenarioLikelihoods, selector.field)
          : selectedField(row, selector.field);
    }
    const status = !usable
      ? "unavailable"
      : isDecimalValue(value)
        ? "available"
        : "absent";
    if (selector.required === true && status !== "available")
      return invalid("MANDATORY_INPUT_UNAVAILABLE");
    return ok({
      selectorId,
      status,
      ...(status === "available" && isDecimalValue(value) ? { value } : {}),
    });
  }
  const selectors: DailySelectorObservation[] = [];
  for (const selector of decision.value.selectors) {
    const result = observe(selector, selector.id);
    if (!result.ok) return result;
    selectors.push(result.value);
  }
  const atr = observe(planning.value.atrSelector, "grid-atr");
  if (!atr.ok) return atr;
  if (!atr.value.value?.isPositive())
    return invalid("MANDATORY_INPUT_UNAVAILABLE");
  return ok(
    deepFreeze({
      symbol: input.symbol,
      allocation: allocation.value,
      market: market.value,
      analytics: analytics.value,
      assessment: assessment.value,
      decisionPolicy: decision.value,
      planningPolicy: planning.value,
      constraints,
      ticker: symbol.ticker,
      atr: atr.value.value,
      evidenceConfidence: assessment.value.evidenceConfidence,
      selectors,
      identity: {
        runId: market.value.runId,
        universeVersion: market.value.universeVersion,
        bundleCutoff: market.value.bundleCutoff,
        marketContentHash: marketContent.value,
        marketBundleHash: marketBundle.value,
        analyticsContentHash: analytics.value.contentHash,
        analyticsBundleHash: analyticsBundle.value,
        ...(liquidationBundleHash === undefined
          ? {}
          : { liquidationBundleHash }),
        assessmentHash: assessment.value.contentHash,
        decisionPolicyHash: dHash.value,
        planningPolicyHash: pHash.value,
        constraintsHash: constraintsHash.value,
      },
    }),
  );
}
