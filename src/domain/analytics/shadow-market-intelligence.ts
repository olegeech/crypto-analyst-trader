import {
  hashCanonical,
  type PlanHash,
} from "../identity/canonical-serialization.js";
import { rehydrateAnalyticsEvidenceBundle } from "./analytics-evidence-bundle.js";
import { createAnalyticsInputIdentity } from "./analytics-inputs.js";
import {
  ANALYTICS_FEATURE_OUTPUT_SCALE,
  ANALYTICS_FEATURE_ROUNDING,
} from "./analytics-numeric-policy.js";
import type { AnalyticsFeatureRequest } from "./analytics-profile.js";
import type { DerivativeFeatureOutcome } from "./derivatives-features.js";
import type { PriceFeatureOutcome } from "./price-features.js";
import {
  MARKET_EVIDENCE_PRODUCER,
  MARKET_EVIDENCE_SCHEMA_VERSION,
  createMarketEvidenceBundle,
  marketEvidenceContentHash,
  type MarketEvidenceBundle,
  type MarketEvidenceSymbol,
  type MarketTickerEvidence,
} from "../market/market-evidence-bundle.js";
import {
  rehydrateLiquidationEvidenceBundle,
  type VersionedLiquidationEvidenceBundle,
} from "../liquidation/liquidation-evidence-bundle.js";
import {
  DecimalValue,
  type DecimalValue as Decimal,
} from "../shared/decimal.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { domainError } from "../shared/errors.js";
import { fail, ok, type Result } from "../shared/result.js";
import { parseUtcTimestamp, type UtcTimestamp } from "../shared/time.js";
import { isRecord, requireIdentifier } from "../shared/validation.js";
import { onlyKeys } from "./analytics-validation.js";

export const SHADOW_MARKET_INTELLIGENCE_SCHEMA_VERSION =
  "shadow-market-intelligence/v1" as const;
export const SHADOW_MARKET_INTELLIGENCE_PRODUCER =
  "crypto-analyst-trader/shadow-market-intelligence" as const;
export const SHADOW_MARKET_INTELLIGENCE_MODEL_VERSION =
  "existing-evidence-shadow/v1" as const;
export const SHADOW_MARKET_INTELLIGENCE_PROFILE_VERSION =
  "existing-evidence-shadow-profile/v1" as const;
export const SHADOW_MARKET_INTELLIGENCE_MAX_SOURCE_AGE_MS = 300_000 as const;
export const SHADOW_MARKET_INTELLIGENCE_ANALYTICS_SOURCE_PRODUCER =
  "crypto-analyst-trader/native-analytics" as const;

export const SHADOW_MARKET_FAMILIES = [
  "market-regime-score",
  "early-warning-risk",
  "liquidity-stress",
  "trap",
] as const;
export type ShadowMarketFamily = (typeof SHADOW_MARKET_FAMILIES)[number];

export type ShadowObservationUnit =
  | "percent"
  | "price"
  | "funding-rate"
  | "USD"
  | "ratio"
  | "quote-currency-per-base-asset";

export interface ShadowObservationWindow {
  readonly from: UtcTimestamp;
  readonly to: UtcTimestamp;
  readonly interval?: "1h" | "4h" | "1d" | "1w";
  readonly hours?: number;
  readonly observationCount?: number;
  readonly expectedConstituentBuckets?: number;
  readonly observedConstituentBuckets?: number;
  readonly complete?: boolean;
  readonly cadenceMs?: number;
}

export interface ShadowObservation {
  readonly id: string;
  readonly kind:
    | "close-return"
    | "atr"
    | "funding-rate"
    | "open-interest-relative-change"
    | "liquidation-notional"
    | "liquidation-imbalance"
    | "quoted-spread"
    | "relative-quoted-spread";
  readonly sourceId: string;
  readonly sourceHash: PlanHash;
  readonly symbol: MarketEvidenceSymbol;
  readonly asset?: string;
  readonly baseAsset?: string;
  readonly quoteCurrency?: string;
  readonly unitLabel?: string;
  readonly value: Decimal;
  readonly unit: ShadowObservationUnit;
  readonly observedAt: UtcTimestamp;
  readonly sourceStatus: "complete" | "partial";
  readonly sourceReasonCodes: readonly string[];
  readonly window?: ShadowObservationWindow;
}

export interface ShadowMarketSourceManifest {
  readonly role: "market";
  readonly sourceId: string;
  readonly producer: string;
  readonly schemaVersion: string;
  readonly contentHash: string;
  readonly bundleHash: PlanHash;
  readonly asOf: UtcTimestamp;
  readonly validForMs: number;
}

export interface ShadowAnalyticsSourceManifest {
  readonly role: "analytics";
  readonly sourceId: string;
  readonly producer: typeof SHADOW_MARKET_INTELLIGENCE_ANALYTICS_SOURCE_PRODUCER;
  readonly schemaVersion: string;
  readonly contentHash: string;
  readonly bundleHash: PlanHash;
  readonly asOf: UtcTimestamp;
  readonly validForMs: number;
}

export interface ShadowLiquidationSourceManifest {
  readonly role: "liquidation";
  readonly sourceId: string;
  readonly producer: string;
  readonly schemaVersion: string;
  readonly contentHash: string;
  readonly bundleHash: PlanHash;
  readonly asOf: UtcTimestamp;
  readonly validForMs: number;
}

export interface ShadowFamilyOutcome {
  readonly family: ShadowMarketFamily;
  readonly status: "partial" | "unavailable";
  readonly assessmentStatus: "unavailable";
  readonly assessmentReason: "NO_CALIBRATED_MODEL";
  readonly observationIds: readonly string[];
  readonly missingSourceInputs: readonly string[];
  readonly missingModelInputs: readonly string[];
  readonly reasonCodes: readonly string[];
}

export interface ShadowMarketIntelligenceBundle {
  readonly schemaVersion: typeof SHADOW_MARKET_INTELLIGENCE_SCHEMA_VERSION;
  readonly producer: typeof SHADOW_MARKET_INTELLIGENCE_PRODUCER;
  readonly modelVersion: typeof SHADOW_MARKET_INTELLIGENCE_MODEL_VERSION;
  readonly profileVersion: typeof SHADOW_MARKET_INTELLIGENCE_PROFILE_VERSION;
  readonly runId: string;
  readonly universeVersion: string;
  readonly symbol: MarketEvidenceSymbol;
  readonly cutoff: UtcTimestamp;
  readonly asOf: UtcTimestamp;
  readonly validForMs: number;
  readonly evaluationTime: UtcTimestamp;
  readonly sourceManifest: {
    readonly market: ShadowMarketSourceManifest;
    readonly analytics: ShadowAnalyticsSourceManifest;
    readonly liquidation?: ShadowLiquidationSourceManifest;
  };
  readonly observations: readonly ShadowObservation[];
  readonly families: readonly ShadowFamilyOutcome[];
  readonly contentHash: PlanHash;
}

export interface CreateShadowMarketIntelligenceInput {
  readonly market: unknown;
  readonly analytics: unknown;
  readonly liquidation?: unknown;
  readonly symbol: unknown;
  readonly evaluationTime: unknown;
}

type BundlePayload = Omit<ShadowMarketIntelligenceBundle, "contentHash">;
type ShadowWindow = NonNullable<ShadowObservation["window"]>;
type ObservationSource =
  ShadowMarketSourceManifest | ShadowAnalyticsSourceManifest;

const TWO = DecimalValue.fromString("2");

const FAMILY_MODEL_GAPS: Readonly<
  Record<ShadowMarketFamily, readonly string[]>
> = {
  "market-regime-score": [
    "broad-market-health",
    "macro-and-global-liquidity",
    "market-breadth",
    "etf-and-sentiment",
    "calibrated-regime-model",
  ],
  "early-warning-risk": [
    "calibrated-warning-model",
    "predictive-risk-probability",
    "validated-warning-thresholds",
  ],
  "liquidity-stress": [
    "market-depth-and-resilience",
    "historical-spread-anomaly",
    "calibrated-liquidity-stress-model",
  ],
  trap: [
    "trap-classification-model",
    "confirmation-and-invalidation-forecast",
    "calibrated-scenario-likelihoods",
  ],
};

const FAMILY_SOURCE_INPUTS: Readonly<
  Record<ShadowMarketFamily, readonly string[]>
> = {
  "market-regime-score": ["return-24h", "return-3d", "atr-4h"],
  "early-warning-risk": [
    "return-24h",
    "return-3d",
    "funding-current",
    "oi-relative-24h",
    "liquidation-12h-long-usd",
    "liquidation-12h-short-usd",
    "liquidation-12h-total-usd",
  ],
  "liquidity-stress": ["quote-spread", "quote-relative-spread"],
  trap: [
    "return-24h",
    "return-3d",
    "funding-current",
    "oi-relative-24h",
    "liquidation-12h-long-usd",
    "liquidation-12h-short-usd",
    "liquidation-12h-total-usd",
  ],
};

function invalid(message: string, field?: string): Result<never> {
  return fail(
    domainError(
      "INVALID_VALUE",
      message,
      field === undefined ? undefined : { field },
    ),
  );
}

function finiteTimestamp(value: unknown, field: string) {
  const parsed = parseUtcTimestamp(value);
  return parsed.ok
    ? parsed
    : fail(domainError("INVALID_TIMESTAMP", `${field} is invalid`, { field }));
}

function oneRequest(
  features: readonly AnalyticsFeatureRequest[],
  broadMatch: (request: AnalyticsFeatureRequest) => boolean,
  exactMatch: (request: AnalyticsFeatureRequest) => boolean,
  description: string,
): Result<AnalyticsFeatureRequest | undefined> {
  const broad = features.filter(broadMatch);
  const exact = broad.filter(exactMatch);
  if (exact.length > 1 || (exact.length === 0 && broad.length > 0)) {
    return invalid(
      `analytics profile has an incompatible ${description} request`,
    );
  }
  return ok(exact[0]);
}

function sourceStatus(
  outcome: PriceFeatureOutcome | DerivativeFeatureOutcome,
): "complete" | "partial" | undefined {
  return outcome.status === "complete" || outcome.status === "partial"
    ? outcome.status
    : undefined;
}

function hasValidWindow(
  window: ShadowWindow | undefined,
  cutoff: UtcTimestamp,
): window is ShadowWindow {
  return (
    window !== undefined &&
    Date.parse(window.from) <= Date.parse(window.to) &&
    Date.parse(window.to) <= Date.parse(cutoff)
  );
}

function observation(
  input: Omit<ShadowObservation, "sourceReasonCodes"> & {
    readonly sourceReasonCodes: readonly string[];
  },
): ShadowObservation {
  const reasons = [...new Set(input.sourceReasonCodes)].sort();
  return deepFreeze({ ...input, sourceReasonCodes: reasons });
}

function addPriceObservation(
  output: ShadowObservation[],
  id: string,
  kind: "close-return" | "atr",
  request: AnalyticsFeatureRequest | undefined,
  outcome: PriceFeatureOutcome | undefined,
  valueType: "close-return" | "atr",
  unit: "percent" | "price",
  source: ShadowAnalyticsSourceManifest,
  symbol: MarketEvidenceSymbol,
  cutoff: UtcTimestamp,
  instrument: MarketEvidenceBundle["symbols"][number]["instrument"],
): void {
  if (
    request === undefined ||
    outcome === undefined ||
    outcome.kind !== valueType ||
    outcome.symbol !== symbol ||
    outcome.value?.type !== valueType
  )
    return;
  const status = sourceStatus(outcome);
  if (status === undefined || !hasValidWindow(outcome.window, cutoff)) return;
  const value =
    valueType === "close-return" && outcome.value.type === "close-return"
      ? outcome.value.percent
      : valueType === "atr" && outcome.value.type === "atr"
        ? outcome.value.atr
        : undefined;
  if (value === undefined) return;
  const priceUnit =
    valueType === "atr" && instrument !== undefined
      ? `${instrument.quoteCoin} per ${instrument.baseCoin}`
      : undefined;
  output.push(
    observation({
      id,
      kind,
      sourceId: source.sourceId,
      sourceHash: source.bundleHash,
      symbol,
      value,
      unit,
      ...(instrument === undefined
        ? {}
        : {
            baseAsset: instrument.baseCoin,
            quoteCurrency: instrument.quoteCoin,
            ...(priceUnit === undefined ? {} : { unitLabel: priceUnit }),
          }),
      observedAt: outcome.window.to,
      sourceStatus: status,
      sourceReasonCodes: outcome.reasonCodes,
      window: { ...outcome.window, interval: outcome.interval },
    }),
  );
}

function addDerivativeObservation(
  output: ShadowObservation[],
  input: {
    readonly id: string;
    readonly kind: ShadowObservation["kind"];
    readonly request: AnalyticsFeatureRequest | undefined;
    readonly outcome: DerivativeFeatureOutcome | undefined;
    readonly value: Decimal | undefined;
    readonly unit: ShadowObservationUnit;
    readonly source: ShadowAnalyticsSourceManifest;
    readonly symbol: MarketEvidenceSymbol;
    readonly cutoff: UtcTimestamp;
  },
): void {
  const { request, outcome, value } = input;
  if (
    request === undefined ||
    outcome === undefined ||
    value === undefined ||
    outcome.requestId !== request.id
  )
    return;
  const status = sourceStatus(outcome);
  if (status === undefined || !hasValidWindow(outcome.window, input.cutoff))
    return;
  const window: ShadowWindow =
    request.kind === "open-interest-relative-change" &&
    outcome.window !== undefined &&
    "cadenceMs" in outcome.window
      ? { ...outcome.window, interval: request.interval }
      : outcome.window;
  output.push(
    observation({
      id: input.id,
      kind: input.kind,
      sourceId: input.source.sourceId,
      sourceHash: input.source.bundleHash,
      symbol: input.symbol,
      value,
      unit: input.unit,
      observedAt: outcome.window.to,
      sourceStatus: status,
      sourceReasonCodes: outcome.reasonCodes,
      window,
      ...(outcome.asset === undefined ? {} : { asset: outcome.asset }),
    }),
  );
}

function familyOutcomes(
  observations: readonly ShadowObservation[],
): readonly ShadowFamilyOutcome[] {
  const known = new Set(observations.map((item) => item.id));
  return deepFreeze(
    SHADOW_MARKET_FAMILIES.map((family) => {
      const expected = FAMILY_SOURCE_INPUTS[family];
      const observationIds = expected.filter((id) => known.has(id));
      const missingSourceInputs = expected.filter((id) => !known.has(id));
      return {
        family,
        status: observationIds.length > 0 ? "partial" : "unavailable",
        assessmentStatus: "unavailable",
        assessmentReason: "NO_CALIBRATED_MODEL",
        observationIds,
        missingSourceInputs,
        missingModelInputs: FAMILY_MODEL_GAPS[family],
        reasonCodes: [
          "ASSESSMENT_UNAVAILABLE",
          ...(missingSourceInputs.length > 0 ? ["SOURCE_INPUTS_MISSING"] : []),
        ],
      };
    }),
  );
}

function minimumAge(marketRefAge: number): number {
  return Math.min(marketRefAge, SHADOW_MARKET_INTELLIGENCE_MAX_SOURCE_AGE_MS);
}

export function createShadowMarketIntelligence(
  input: unknown,
): Result<ShadowMarketIntelligenceBundle> {
  if (
    !isRecord(input) ||
    !onlyKeys(input, [
      "market",
      "analytics",
      "liquidation",
      "symbol",
      "evaluationTime",
    ]) ||
    !Object.hasOwn(input, "market") ||
    !Object.hasOwn(input, "analytics") ||
    !Object.hasOwn(input, "symbol") ||
    !Object.hasOwn(input, "evaluationTime")
  )
    return invalid("shadow market intelligence input is invalid");

  const symbolValue = requireIdentifier(input.symbol, "symbol");
  const evaluationTime = finiteTimestamp(
    input.evaluationTime,
    "evaluationTime",
  );
  if (!symbolValue.ok) return symbolValue;
  if (!evaluationTime.ok) return evaluationTime;

  const marketResult = createMarketEvidenceBundle(input.market);
  if (!marketResult.ok) return marketResult;
  const market = marketResult.value;
  const symbol = symbolValue.value as MarketEvidenceSymbol;
  if (!market.universe.includes(symbol))
    return invalid("shadow symbol is outside the market universe", "symbol");
  const selected = market.symbols.filter((item) => item.symbol === symbol);
  if (selected.length !== 1)
    return invalid("shadow market symbol is missing or ambiguous", "symbol");
  const symbolEvidence = selected[0];
  if (symbolEvidence === undefined)
    return invalid("shadow symbol evidence is missing");

  const analyticsResult = rehydrateAnalyticsEvidenceBundle(input.analytics);
  if (!analyticsResult.ok) return analyticsResult;
  const analytics = analyticsResult.value;

  let liquidation: VersionedLiquidationEvidenceBundle | undefined;
  if (input.liquidation !== undefined) {
    const liquidationResult = rehydrateLiquidationEvidenceBundle(
      input.liquidation,
    );
    if (!liquidationResult.ok) return liquidationResult;
    liquidation = liquidationResult.value;
  }
  const computedIdentity = createAnalyticsInputIdentity(market, liquidation);
  if (!computedIdentity.ok) return computedIdentity;
  if (computedIdentity.value.compatibility !== "compatible")
    return invalid("shadow market and liquidation sources are incompatible");
  const suppliedIdentityHash = hashCanonical(analytics.inputIdentity);
  const computedIdentityHash = hashCanonical(computedIdentity.value);
  if (
    !suppliedIdentityHash.ok ||
    !computedIdentityHash.ok ||
    suppliedIdentityHash.value !== computedIdentityHash.value
  )
    return invalid("shadow analytics identity does not match its sources");
  if (analytics.inputIdentity.runId !== market.runId)
    return invalid("shadow analytics run does not match the market source");

  const marketContentHash = marketEvidenceContentHash(market);
  const marketBundleHash = hashCanonical(market);
  const analyticsBundleHash = hashCanonical(analytics);
  if (!marketContentHash.ok) return marketContentHash;
  if (!marketBundleHash.ok) return marketBundleHash;
  if (!analyticsBundleHash.ok) return analyticsBundleHash;

  const marketRefs = market.evidence.filter(
    (item) => item.kind === "market-evidence-bundle",
  );
  if (marketRefs.length !== 1)
    return invalid(
      "shadow market source must have exactly one bundle reference",
    );
  const marketRef = marketRefs[0];
  if (
    marketRef === undefined ||
    market.producer !== MARKET_EVIDENCE_PRODUCER ||
    market.schemaVersion !== MARKET_EVIDENCE_SCHEMA_VERSION ||
    marketRef.producer !== market.producer ||
    marketRef.schemaVersion !== market.schemaVersion ||
    marketRef.sourceId !== `bybit-public:${market.runId}` ||
    marketRef.asOf !== market.bundleCutoff ||
    marketRef.contentHash !== marketContentHash.value
  )
    return invalid("shadow market source manifest is inconsistent");

  const cutoff = market.bundleCutoff;
  if (Date.parse(evaluationTime.value) < Date.parse(cutoff))
    return invalid("shadow evaluation time precedes the source cutoff");
  const validForMs = minimumAge(marketRef.validForMs);
  const marketManifest: ShadowMarketSourceManifest = {
    role: "market",
    sourceId: marketRef.sourceId,
    producer: marketRef.producer,
    schemaVersion: marketRef.schemaVersion,
    contentHash: marketContentHash.value,
    bundleHash: marketBundleHash.value,
    asOf: marketRef.asOf,
    validForMs,
  };
  const analyticsManifest: ShadowAnalyticsSourceManifest = {
    role: "analytics",
    sourceId: `analytics:${market.runId}`,
    producer: SHADOW_MARKET_INTELLIGENCE_ANALYTICS_SOURCE_PRODUCER,
    schemaVersion: analytics.schemaVersion,
    contentHash: analytics.contentHash,
    bundleHash: analyticsBundleHash.value,
    asOf: cutoff,
    validForMs,
  };
  let liquidationManifest: ShadowLiquidationSourceManifest | undefined;
  if (liquidation !== undefined) {
    const hash = hashCanonical(liquidation);
    if (!hash.ok) return hash;
    liquidationManifest = {
      role: "liquidation",
      sourceId: liquidation.runId,
      producer: liquidation.producer,
      schemaVersion: liquidation.schemaVersion,
      contentHash: hash.value,
      bundleHash: hash.value,
      asOf: liquidation.bundleCutoff,
      validForMs,
    };
  }
  const manifest = {
    market: marketManifest,
    analytics: analyticsManifest,
    ...(liquidationManifest === undefined
      ? {}
      : { liquidation: liquidationManifest }),
  };

  const features = analytics.profile.features;
  const symbolRequests = features.filter(
    (request) => "symbol" in request && request.symbol === symbol,
  );
  if (
    symbolRequests.length === 0 &&
    features.some((request) => "symbol" in request)
  )
    return invalid(
      "shadow symbol does not match the analytics profile",
      "symbol",
    );

  const return24Request = oneRequest(
    features,
    (request) =>
      request.kind === "close-return" &&
      request.symbol === symbol &&
      request.interval === "1h",
    (request) => request.kind === "close-return" && request.periods === 24,
    "24h return",
  );
  if (!return24Request.ok) return return24Request;
  const return3dRequest = oneRequest(
    features,
    (request) =>
      request.kind === "close-return" &&
      request.symbol === symbol &&
      request.interval === "1d",
    (request) => request.kind === "close-return" && request.periods === 3,
    "3d return",
  );
  if (!return3dRequest.ok) return return3dRequest;
  const atrRequest = oneRequest(
    features,
    (request) =>
      request.kind === "atr" &&
      request.symbol === symbol &&
      request.interval === "4h",
    (request) => request.kind === "atr" && request.period === 14,
    "4h ATR(14)",
  );
  if (!atrRequest.ok) return atrRequest;
  const oiRequest = oneRequest(
    features,
    (request) =>
      request.kind === "open-interest-relative-change" &&
      request.symbol === symbol &&
      request.interval === "1h",
    (request) =>
      request.kind === "open-interest-relative-change" &&
      request.observationCount === 25,
    "24h relative open interest",
  );
  if (!oiRequest.ok) return oiRequest;

  const baseAsset = symbolEvidence.instrument?.baseCoin;
  const liquidationCandidates = features.filter(
    (request) => request.kind === "liquidation-window",
  );
  const matchingLiquidationCandidates =
    baseAsset === undefined
      ? []
      : liquidationCandidates.filter(
          (request) =>
            request.kind === "liquidation-window" &&
            request.asset === baseAsset,
        );
  const liquidationRequest = matchingLiquidationCandidates.find(
    (request) =>
      request.kind === "liquidation-window" && request.windowHours === 12,
  );
  if (
    matchingLiquidationCandidates.length > 1 ||
    (matchingLiquidationCandidates.length > 0 &&
      liquidationRequest === undefined)
  )
    return invalid(
      "analytics profile has an incompatible 12h liquidation request",
    );

  const priceOutcome = (request: AnalyticsFeatureRequest | undefined) =>
    request === undefined
      ? undefined
      : analytics.priceFeatures.find((item) => item.requestId === request.id);
  const derivativeOutcome = (request: AnalyticsFeatureRequest | undefined) =>
    request === undefined
      ? undefined
      : analytics.derivativeFeatures.find(
          (item) => item.requestId === request.id,
        );

  const observations: ShadowObservation[] = [];
  addPriceObservation(
    observations,
    "return-24h",
    "close-return",
    return24Request.value,
    priceOutcome(return24Request.value),
    "close-return",
    "percent",
    analyticsManifest,
    symbol,
    cutoff,
    symbolEvidence.instrument,
  );
  addPriceObservation(
    observations,
    "return-3d",
    "close-return",
    return3dRequest.value,
    priceOutcome(return3dRequest.value),
    "close-return",
    "percent",
    analyticsManifest,
    symbol,
    cutoff,
    symbolEvidence.instrument,
  );
  addPriceObservation(
    observations,
    "atr-4h",
    "atr",
    atrRequest.value,
    priceOutcome(atrRequest.value),
    "atr",
    "price",
    analyticsManifest,
    symbol,
    cutoff,
    symbolEvidence.instrument,
  );

  const oiOutcome = derivativeOutcome(oiRequest.value);
  const oiValue =
    oiOutcome?.value?.type === "open-interest-relative-change"
      ? oiOutcome.value.percent
      : undefined;
  addDerivativeObservation(observations, {
    id: "oi-relative-24h",
    kind: "open-interest-relative-change",
    request: oiRequest.value,
    outcome: oiOutcome,
    value: oiValue,
    unit: "percent",
    source: analyticsManifest,
    symbol,
    cutoff,
  });

  const liquidationOutcome = derivativeOutcome(liquidationRequest);
  const liquidationValue =
    liquidationOutcome?.value?.type === "liquidation-window"
      ? liquidationOutcome.value
      : undefined;
  if (
    liquidationValue !== undefined &&
    liquidationOutcome !== undefined &&
    sourceStatus(liquidationOutcome) !== undefined &&
    hasValidWindow(liquidationOutcome.window, cutoff)
  ) {
    const status = sourceStatus(liquidationOutcome);
    if (status !== undefined) {
      const common = {
        sourceId: analyticsManifest.sourceId,
        sourceHash: analyticsManifest.bundleHash,
        symbol,
        ...(liquidationOutcome.asset === undefined
          ? {}
          : { asset: liquidationOutcome.asset }),
        observedAt: liquidationOutcome.window.to,
        sourceStatus: status,
        sourceReasonCodes: liquidationOutcome.reasonCodes,
        window: liquidationOutcome.window,
      } as const;
      observations.push(
        observation({
          id: "liquidation-12h-long-usd",
          kind: "liquidation-notional",
          ...common,
          value: liquidationValue.longUsd,
          unit: "USD",
        }),
        observation({
          id: "liquidation-12h-short-usd",
          kind: "liquidation-notional",
          ...common,
          value: liquidationValue.shortUsd,
          unit: "USD",
        }),
        observation({
          id: "liquidation-12h-total-usd",
          kind: "liquidation-notional",
          ...common,
          value: liquidationValue.totalUsd,
          unit: "USD",
        }),
      );
      if (liquidationValue.imbalance !== undefined) {
        observations.push(
          observation({
            id: "liquidation-12h-imbalance",
            kind: "liquidation-imbalance",
            ...common,
            value: liquidationValue.imbalance,
            unit: "ratio",
          }),
        );
      }
    }
  }

  const ticker: MarketTickerEvidence | undefined = symbolEvidence.ticker;
  if (ticker !== undefined) {
    if (
      !ticker.bid.isPositive() ||
      !ticker.ask.isPositive() ||
      ticker.ask.compare(ticker.bid) < 0
    )
      return invalid("shadow quote is invalid", "market.ticker");
    if (Date.parse(ticker.observedAt) > Date.parse(cutoff))
      return invalid(
        "shadow quote is after the authoritative cutoff",
        "market.ticker.observedAt",
      );
    const marketSource: ObservationSource = marketManifest;
    if (ticker.fundingRate !== undefined) {
      observations.push(
        observation({
          id: "funding-current",
          kind: "funding-rate",
          sourceId: marketSource.sourceId,
          sourceHash: marketSource.bundleHash,
          symbol,
          value: ticker.fundingRate,
          unit: "funding-rate",
          observedAt: ticker.observedAt,
          sourceStatus: "complete",
          sourceReasonCodes: [],
        }),
      );
    }
    const spread = ticker.ask.subtract(ticker.bid);
    const sum = ticker.ask.add(ticker.bid);
    if (!TWO.ok) return invalid("shadow decimal constants are invalid");
    // Algebraically equal to (ask - bid) / ((ask + bid) / 2), without
    // rounding the midpoint before the final analytics-scale division.
    const numerator = spread.multiply(TWO.value);
    const relative = numerator.divide(
      sum,
      ANALYTICS_FEATURE_OUTPUT_SCALE,
      ANALYTICS_FEATURE_ROUNDING,
    );
    if (!relative.ok) return relative;
    observations.push(
      observation({
        id: "quote-spread",
        kind: "quoted-spread",
        sourceId: marketSource.sourceId,
        sourceHash: marketSource.bundleHash,
        symbol,
        value: spread,
        unit: "quote-currency-per-base-asset",
        ...(symbolEvidence.instrument === undefined
          ? {}
          : {
              baseAsset: symbolEvidence.instrument.baseCoin,
              quoteCurrency: symbolEvidence.instrument.quoteCoin,
              unitLabel: `${symbolEvidence.instrument.quoteCoin} per ${symbolEvidence.instrument.baseCoin}`,
            }),
        observedAt: ticker.observedAt,
        sourceStatus: "complete",
        sourceReasonCodes: [],
      }),
      observation({
        id: "quote-relative-spread",
        kind: "relative-quoted-spread",
        sourceId: marketSource.sourceId,
        sourceHash: marketSource.bundleHash,
        symbol,
        value: relative.value,
        unit: "ratio",
        ...(symbolEvidence.instrument === undefined
          ? {}
          : {
              baseAsset: symbolEvidence.instrument.baseCoin,
              quoteCurrency: symbolEvidence.instrument.quoteCoin,
              unitLabel: "dimensionless ratio",
            }),
        observedAt: ticker.observedAt,
        sourceStatus: "complete",
        sourceReasonCodes: [],
      }),
    );
  }

  observations.sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
  const payload: BundlePayload = {
    schemaVersion: SHADOW_MARKET_INTELLIGENCE_SCHEMA_VERSION,
    producer: SHADOW_MARKET_INTELLIGENCE_PRODUCER,
    modelVersion: SHADOW_MARKET_INTELLIGENCE_MODEL_VERSION,
    profileVersion: SHADOW_MARKET_INTELLIGENCE_PROFILE_VERSION,
    runId: market.runId,
    universeVersion: market.universeVersion,
    symbol,
    cutoff,
    asOf: marketRef.asOf,
    validForMs,
    evaluationTime: evaluationTime.value,
    sourceManifest: manifest,
    observations: deepFreeze(observations),
    families: familyOutcomes(observations),
  };
  const contentHash = hashCanonical(payload);
  if (!contentHash.ok) return contentHash;
  return ok(deepFreeze({ ...payload, contentHash: contentHash.value }));
}
