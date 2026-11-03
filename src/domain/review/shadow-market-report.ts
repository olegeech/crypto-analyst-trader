import {
  createAnalyticsEvidenceBundle,
  rehydrateAnalyticsEvidenceBundle,
  type AnalyticsEvidenceBundle,
} from "../analytics/analytics-evidence-bundle.js";
import { createAnalyticsInputIdentity } from "../analytics/analytics-inputs.js";
import {
  LIQUIDATION_EVIDENCE_V3_SCHEMA_VERSION,
  rehydrateLiquidationEvidenceBundle,
  type VersionedLiquidationEvidenceBundle,
} from "../liquidation/liquidation-evidence-bundle.js";
import {
  MARKET_EVIDENCE_SCHEMA_VERSION,
  MARKET_EVIDENCE_SYMBOLS,
  createMarketEvidenceBundle,
  type MarketEvidenceBundle,
} from "../market/market-evidence-bundle.js";
import {
  SHADOW_MARKET_INTELLIGENCE_MODEL_VERSION,
  SHADOW_MARKET_INTELLIGENCE_PROFILE_VERSION,
  SHADOW_MARKET_INTELLIGENCE_PRODUCER,
  SHADOW_MARKET_INTELLIGENCE_SCHEMA_VERSION,
} from "../analytics/shadow-market-intelligence.js";
import {
  createPreparedShadowContextV1,
  PREPARED_SHADOW_CONTEXT_SCHEMA_VERSION,
  type PreparedShadowContext,
} from "./prepared-shadow-context.js";
import { SHADOW_QUALITY_PROFILE_VERSION } from "../quality/shadow-quality-assessment.js";
import {
  canonicalSerialize,
  hashCanonical,
  type PlanHash,
} from "../identity/canonical-serialization.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { domainError } from "../shared/errors.js";
import { fail, ok, type Result } from "../shared/result.js";
import { parseUtcTimestamp, type UtcTimestamp } from "../shared/time.js";
import { isRecord, requireIdentifier } from "../shared/validation.js";

export const SHADOW_MARKET_REPORT_SCHEMA_VERSION =
  "shadow-market-report/v1" as const;

export type ShadowMarketReportEnvironment = "demo" | "testnet" | "mainnet";

export interface ShadowMarketReportSources {
  readonly market: MarketEvidenceBundle;
  readonly liquidation: VersionedLiquidationEvidenceBundle;
  readonly analytics: AnalyticsEvidenceBundle;
}

/** Public source-bound replay material and its derived shadow-only assessment. */
export interface ShadowMarketReport {
  readonly schemaVersion: typeof SHADOW_MARKET_REPORT_SCHEMA_VERSION;
  readonly contentHash: PlanHash;
  readonly environment: ShadowMarketReportEnvironment;
  readonly runId: string;
  readonly symbol: MarketEvidenceBundle["symbols"][number]["symbol"];
  readonly evaluationTime: UtcTimestamp;
  readonly sources: ShadowMarketReportSources;
  readonly context: PreparedShadowContext;
}

const ENVIRONMENTS = ["demo", "testnet", "mainnet"] as const;
const REPORT_KEYS = [
  "schemaVersion",
  "contentHash",
  "environment",
  "runId",
  "symbol",
  "evaluationTime",
  "sources",
  "context",
] as const;
const SOURCE_KEYS = ["market", "liquidation", "analytics"] as const;
const PREPARED_SHADOW_CONTEXT_KEYS = [
  "schemaVersion",
  "status",
  "model",
  "qualityProfileVersion",
  "reasonCodes",
  "shadow",
  "assessment",
] as const;
const PREPARED_SHADOW_MODEL_KEYS = [
  "producer",
  "schemaVersion",
  "modelVersion",
  "profileVersion",
] as const;

function invalid(message: string): Result<never> {
  return fail(domainError("INVALID_EVIDENCE", message));
}

function unsupportedContextContract(): Result<never> {
  return fail(
    domainError(
      "UNSUPPORTED_CONTRACT",
      "prepared shadow context identity is unsupported",
    ),
  );
}

function hasPreparedShadowContextV1Identity(context: unknown): boolean {
  return (
    isRecord(context) &&
    isRecord(context.model) &&
    context.schemaVersion === PREPARED_SHADOW_CONTEXT_SCHEMA_VERSION &&
    context.qualityProfileVersion === SHADOW_QUALITY_PROFILE_VERSION &&
    context.model.producer === SHADOW_MARKET_INTELLIGENCE_PRODUCER &&
    context.model.schemaVersion === SHADOW_MARKET_INTELLIGENCE_SCHEMA_VERSION &&
    context.model.modelVersion === SHADOW_MARKET_INTELLIGENCE_MODEL_VERSION &&
    context.model.profileVersion === SHADOW_MARKET_INTELLIGENCE_PROFILE_VERSION
  );
}

function hasPreparedShadowContextV1Shape(context: unknown): boolean {
  return (
    exactRecord(context, PREPARED_SHADOW_CONTEXT_KEYS) &&
    context.status === "recorded" &&
    exactRecord(context.model, PREPARED_SHADOW_MODEL_KEYS) &&
    Array.isArray(context.reasonCodes) &&
    context.reasonCodes.every((reasonCode) => typeof reasonCode === "string") &&
    isRecord(context.shadow) &&
    isRecord(context.assessment)
  );
}

function isVersionedContractIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*\/v\d+$/u.test(value)
  );
}

function haveVersionedSourceIdentities(
  market: unknown,
  liquidation: unknown,
  analytics: unknown,
): boolean {
  return (
    isRecord(market) &&
    isVersionedContractIdentity(market.schemaVersion) &&
    isRecord(liquidation) &&
    isVersionedContractIdentity(liquidation.schemaVersion) &&
    isRecord(analytics) &&
    isVersionedContractIdentity(analytics.schemaVersion) &&
    isVersionedContractIdentity(analytics.featuresVersion)
  );
}

function hasPreparedShadowContextVersionShape(context: unknown): boolean {
  return (
    isRecord(context) &&
    isVersionedContractIdentity(context.schemaVersion) &&
    isVersionedContractIdentity(context.qualityProfileVersion) &&
    isRecord(context.model) &&
    typeof context.model.producer === "string" &&
    context.model.producer.length > 0 &&
    isVersionedContractIdentity(context.model.schemaVersion) &&
    isVersionedContractIdentity(context.model.modelVersion) &&
    isVersionedContractIdentity(context.model.profileVersion)
  );
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) => keys.includes(key)) &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function sameCanonical(left: unknown, right: unknown): boolean {
  const leftJson = canonicalSerialize(left);
  const rightJson = canonicalSerialize(right);
  return leftJson.ok && rightJson.ok && leftJson.value === rightJson.value;
}

function rehydrateShadowMarketSource(
  rawMarket: unknown,
): Result<MarketEvidenceBundle> {
  if (
    isRecord(rawMarket) &&
    isVersionedContractIdentity(rawMarket.schemaVersion) &&
    rawMarket.schemaVersion !== MARKET_EVIDENCE_SCHEMA_VERSION
  )
    return fail(
      domainError(
        "UNSUPPORTED_CONTRACT",
        "market evidence version is unsupported",
      ),
    );
  return createMarketEvidenceBundle(rawMarket);
}

interface RehydratedShadowReportSources {
  readonly market: MarketEvidenceBundle;
  readonly liquidation: VersionedLiquidationEvidenceBundle;
  readonly analytics: AnalyticsEvidenceBundle;
}

function rehydrateShadowReportSources(
  rawSources: unknown,
  expectedReportIdentity?: {
    readonly runId: string;
    readonly symbol: string;
  },
): Result<RehydratedShadowReportSources> {
  if (!exactRecord(rawSources, SOURCE_KEYS))
    return invalid("shadow report sources are invalid");
  if (
    !haveVersionedSourceIdentities(
      rawSources.market,
      rawSources.liquidation,
      rawSources.analytics,
    )
  )
    return invalid("shadow report source version identity is malformed");

  const market = rehydrateShadowMarketSource(rawSources.market);
  const liquidation = rehydrateLiquidationEvidenceBundle(
    rawSources.liquidation,
  );
  const suppliedAnalytics = rehydrateAnalyticsEvidenceBundle(
    rawSources.analytics,
  );
  const sourceResults = [market, liquidation, suppliedAnalytics];
  const invalidSource = sourceResults.find(
    (source) => !source.ok && source.error.code !== "UNSUPPORTED_CONTRACT",
  );
  if (invalidSource !== undefined && !invalidSource.ok)
    return fail(invalidSource.error);
  if (
    market.ok &&
    (market.value.status !== "complete" ||
      (expectedReportIdentity !== undefined &&
        (expectedReportIdentity.runId !== market.value.runId ||
          !market.value.symbols.some(
            (entry) => entry.symbol === expectedReportIdentity.symbol,
          ))))
  )
    return invalid("shadow report identity differs from its market source");
  if (
    market.ok &&
    liquidation.ok &&
    (liquidation.value.schemaVersion !==
      LIQUIDATION_EVIDENCE_V3_SCHEMA_VERSION ||
      market.value.runId !== liquidation.value.runId)
  )
    return invalid("shadow report sources are incomplete or mixed-run");
  if (
    market.ok &&
    suppliedAnalytics.ok &&
    (suppliedAnalytics.value.inputIdentity.compatibility !== "compatible" ||
      suppliedAnalytics.value.inputIdentity.runId !== market.value.runId)
  )
    return invalid("shadow report sources are incomplete or mixed-run");
  if (
    liquidation.ok &&
    suppliedAnalytics.ok &&
    suppliedAnalytics.value.inputIdentity.liquidationRunId !==
      liquidation.value.runId
  )
    return invalid("shadow report sources are incomplete or mixed-run");
  if (
    expectedReportIdentity !== undefined &&
    ((liquidation.ok &&
      liquidation.value.runId !== expectedReportIdentity.runId) ||
      (suppliedAnalytics.ok &&
        suppliedAnalytics.value.inputIdentity.runId !==
          expectedReportIdentity.runId))
  )
    return invalid("shadow report sources are incomplete or mixed-run");
  const unsupportedSource = sourceResults.find(
    (source) => !source.ok && source.error.code === "UNSUPPORTED_CONTRACT",
  );
  if (unsupportedSource !== undefined && !unsupportedSource.ok)
    return fail(unsupportedSource.error);
  if (!market.ok || !liquidation.ok || !suppliedAnalytics.ok)
    return invalid("shadow report source identity is invalid");

  const marketSource = market.value;
  const liquidationSource = liquidation.value;
  const analyticsSource = suppliedAnalytics.value;
  const identity = createAnalyticsInputIdentity(
    marketSource,
    liquidationSource,
  );
  if (
    marketSource.status !== "complete" ||
    liquidationSource.schemaVersion !==
      LIQUIDATION_EVIDENCE_V3_SCHEMA_VERSION ||
    marketSource.runId !== liquidationSource.runId ||
    analyticsSource.inputIdentity.compatibility !== "compatible" ||
    analyticsSource.inputIdentity.runId !== marketSource.runId ||
    analyticsSource.inputIdentity.liquidationRunId !==
      liquidationSource.runId ||
    !identity.ok ||
    !sameCanonical(identity.value, analyticsSource.inputIdentity)
  )
    return invalid("shadow report sources are incomplete or mixed-run");

  const analytics = createAnalyticsEvidenceBundle({
    market: marketSource,
    liquidation: liquidationSource,
    profile: analyticsSource.profile,
    featuresVersion: analyticsSource.featuresVersion,
  });
  if (!analytics.ok) {
    if (analytics.error.code === "UNSUPPORTED_CONTRACT")
      return fail(analytics.error);
    return invalid("shadow report analytics differ from source replay");
  }
  if (!sameCanonical(analytics.value, analyticsSource))
    return invalid("shadow report analytics differ from source replay");

  return ok({
    market: marketSource,
    liquidation: liquidationSource,
    analytics: analytics.value,
  });
}

export interface CreateTrustedShadowMarketReportInput {
  readonly environment: ShadowMarketReportEnvironment;
  readonly market: MarketEvidenceBundle;
  readonly liquidation: VersionedLiquidationEvidenceBundle;
  readonly analytics: AnalyticsEvidenceBundle;
  readonly symbol: MarketEvidenceBundle["symbols"][number]["symbol"];
  readonly evaluationTime: UtcTimestamp;
  readonly context: PreparedShadowContext;
}

/** Assemble an artifact from sources and context already validated in this run. */
export function createTrustedShadowMarketReportV1(
  input: CreateTrustedShadowMarketReportInput,
): Result<ShadowMarketReport> {
  if (!hasPreparedShadowContextV1Identity(input.context))
    return unsupportedContextContract();

  const identity = createAnalyticsInputIdentity(
    input.market,
    input.liquidation,
  );
  if (
    !ENVIRONMENTS.includes(input.environment) ||
    !MARKET_EVIDENCE_SYMBOLS.includes(input.symbol) ||
    input.market.status !== "complete" ||
    input.liquidation.schemaVersion !==
      LIQUIDATION_EVIDENCE_V3_SCHEMA_VERSION ||
    input.market.runId !== input.liquidation.runId ||
    input.analytics.inputIdentity.compatibility !== "compatible" ||
    input.analytics.inputIdentity.runId !== input.market.runId ||
    input.analytics.inputIdentity.liquidationRunId !==
      input.liquidation.runId ||
    !identity.ok ||
    !sameCanonical(identity.value, input.analytics.inputIdentity) ||
    input.context.status !== "recorded" ||
    input.context.shadow === undefined ||
    input.context.assessment === undefined ||
    input.context.shadow.runId !== input.market.runId ||
    input.context.shadow.symbol !== input.symbol ||
    input.context.shadow.evaluationTime !== input.evaluationTime
  )
    return invalid(
      "shadow report validated sources or context are inconsistent",
    );

  const payload = {
    schemaVersion: SHADOW_MARKET_REPORT_SCHEMA_VERSION,
    environment: input.environment,
    runId: input.market.runId,
    symbol: input.symbol,
    evaluationTime: input.evaluationTime,
    sources: {
      market: input.market,
      liquidation: input.liquidation,
      analytics: input.analytics,
    },
    context: input.context,
  };
  const contentHash = hashCanonical(payload);
  return contentHash.ok
    ? ok(deepFreeze({ ...payload, contentHash: contentHash.value }))
    : contentHash;
}

/** Build a report only from complete market and replayable v3 liquidation sources. */
export function createShadowMarketReportV1(
  rawInput: unknown,
): Result<ShadowMarketReport> {
  if (
    !exactRecord(rawInput, [
      "environment",
      "market",
      "liquidation",
      "analytics",
      "symbol",
      "evaluationTime",
    ])
  )
    return invalid("shadow report inputs are invalid");

  const environment = rawInput.environment;
  if (!ENVIRONMENTS.includes(environment as ShadowMarketReportEnvironment))
    return invalid("shadow report environment is invalid");
  const symbol = requireIdentifier(rawInput.symbol, "symbol");
  const evaluationTime = parseUtcTimestamp(rawInput.evaluationTime);
  if (
    !symbol.ok ||
    !evaluationTime.ok ||
    !MARKET_EVIDENCE_SYMBOLS.includes(
      symbol.value as (typeof MARKET_EVIDENCE_SYMBOLS)[number],
    )
  )
    return invalid("shadow report source identity is invalid");

  const sources = rehydrateShadowReportSources({
    market: rawInput.market,
    liquidation: rawInput.liquidation,
    analytics: rawInput.analytics,
  });
  if (!sources.ok) return sources;
  const { market, liquidation, analytics } = sources.value;

  const context = createPreparedShadowContextV1({
    market,
    analytics,
    liquidation,
    symbol: symbol.value,
    evaluationTime: evaluationTime.value,
  });
  if (!context.ok || context.value.status !== "recorded")
    return invalid("shadow report assessment is unavailable");
  return createTrustedShadowMarketReportV1({
    environment: environment as ShadowMarketReportEnvironment,
    market,
    liquidation,
    analytics,
    symbol: symbol.value as ShadowMarketReport["symbol"],
    evaluationTime: evaluationTime.value,
    context: context.value,
  });
}

/** Recompute all derived claims; a caller-supplied rehash cannot bless false context. */
export function rehydrateShadowMarketReport(
  rawInput: unknown,
): Result<ShadowMarketReport> {
  if (!isRecord(rawInput)) return invalid("shadow report artifact is invalid");
  const embeddedHash = rawInput.contentHash;
  const { contentHash: _embeddedHash, ...payload } = rawInput;
  void _embeddedHash;
  const expectedHash = hashCanonical(payload);
  if (
    typeof embeddedHash !== "string" ||
    !expectedHash.ok ||
    expectedHash.value !== embeddedHash
  )
    return fail(
      domainError(
        "PLAN_HASH_MISMATCH",
        "shadow report content hash does not match its payload",
      ),
    );
  if (!isVersionedContractIdentity(rawInput.schemaVersion))
    return invalid("shadow report schema version is malformed");
  if (rawInput.schemaVersion !== SHADOW_MARKET_REPORT_SCHEMA_VERSION)
    return fail(
      domainError(
        "UNSUPPORTED_CONTRACT",
        "shadow market report schema version is unsupported",
      ),
    );
  if (!exactRecord(rawInput, REPORT_KEYS) || !isRecord(rawInput.sources))
    return invalid("shadow report artifact is invalid");
  if (!exactRecord(rawInput.sources, SOURCE_KEYS))
    return invalid("shadow report sources are invalid");
  if (!hasPreparedShadowContextVersionShape(rawInput.context))
    return invalid("shadow report context identity is malformed");
  const runId = requireIdentifier(rawInput.runId, "runId");
  const symbol = requireIdentifier(rawInput.symbol, "symbol");
  const evaluationTime = parseUtcTimestamp(rawInput.evaluationTime);
  if (
    !ENVIRONMENTS.includes(
      rawInput.environment as ShadowMarketReportEnvironment,
    ) ||
    !runId.ok ||
    !symbol.ok ||
    !MARKET_EVIDENCE_SYMBOLS.includes(
      symbol.value as (typeof MARKET_EVIDENCE_SYMBOLS)[number],
    ) ||
    !evaluationTime.ok
  )
    return invalid("shadow report identity is invalid");

  if (
    hasPreparedShadowContextV1Identity(rawInput.context) &&
    !hasPreparedShadowContextV1Shape(rawInput.context)
  )
    return invalid("shadow report v1 context structure is invalid");
  if (
    isRecord(rawInput.context) &&
    hasPreparedShadowContextV1Identity(rawInput.context)
  ) {
    const contextShadow = rawInput.context.shadow;
    if (
      !isRecord(contextShadow) ||
      contextShadow.runId !== runId.value ||
      contextShadow.symbol !== symbol.value ||
      contextShadow.evaluationTime !== evaluationTime.value
    )
      return invalid("shadow report v1 context identity differs from report");
  }

  const sources = rehydrateShadowReportSources(rawInput.sources, {
    runId: runId.value,
    symbol: symbol.value,
  });
  if (!sources.ok) return sources;
  if (!hasPreparedShadowContextV1Identity(rawInput.context))
    return unsupportedContextContract();

  const context = createPreparedShadowContextV1({
    market: sources.value.market,
    analytics: sources.value.analytics,
    liquidation: sources.value.liquidation,
    symbol: symbol.value,
    evaluationTime: evaluationTime.value,
  });
  if (!context.ok || context.value.status !== "recorded")
    return invalid("shadow report assessment is unavailable");
  const rebuilt = createTrustedShadowMarketReportV1({
    environment: rawInput.environment as ShadowMarketReportEnvironment,
    market: sources.value.market,
    liquidation: sources.value.liquidation,
    analytics: sources.value.analytics,
    symbol: symbol.value as ShadowMarketReport["symbol"],
    evaluationTime: evaluationTime.value,
    context: context.value,
  });
  if (!rebuilt.ok) return rebuilt;
  return sameCanonical(rawInput, rebuilt.value)
    ? rebuilt
    : fail(
        domainError(
          "PLAN_HASH_MISMATCH",
          "shadow report differs from deterministic source replay",
        ),
      );
}
