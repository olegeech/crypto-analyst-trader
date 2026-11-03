import {
  SHADOW_MARKET_INTELLIGENCE_MODEL_VERSION,
  SHADOW_MARKET_INTELLIGENCE_PROFILE_VERSION,
  SHADOW_MARKET_INTELLIGENCE_PRODUCER,
  SHADOW_MARKET_INTELLIGENCE_SCHEMA_VERSION,
  type ShadowMarketIntelligenceBundle,
} from "../analytics/shadow-market-intelligence.js";
import {
  createShadowMarketIntelligenceWithQualityAssessmentV1,
  SHADOW_QUALITY_PROFILE_VERSION,
  type ShadowQualityAssessment,
} from "../quality/shadow-quality-assessment.js";
import { compareAnalyticsText } from "../analytics/analytics-diagnostics.js";
import { closedRecord } from "../planning/planning-validation.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { domainError } from "../shared/errors.js";
import { fail, ok, type Result } from "../shared/result.js";
import { isRecord } from "../shared/validation.js";

export const PREPARED_SHADOW_CONTEXT_SCHEMA_VERSION =
  "prepared-shadow-context/v1" as const;

export interface PreparedShadowModelIdentity {
  readonly producer: typeof SHADOW_MARKET_INTELLIGENCE_PRODUCER;
  readonly schemaVersion: typeof SHADOW_MARKET_INTELLIGENCE_SCHEMA_VERSION;
  readonly modelVersion: typeof SHADOW_MARKET_INTELLIGENCE_MODEL_VERSION;
  readonly profileVersion: typeof SHADOW_MARKET_INTELLIGENCE_PROFILE_VERSION;
}

export interface PreparedShadowContext {
  readonly schemaVersion: typeof PREPARED_SHADOW_CONTEXT_SCHEMA_VERSION;
  readonly status: "recorded" | "unavailable";
  readonly model: PreparedShadowModelIdentity;
  readonly qualityProfileVersion: typeof SHADOW_QUALITY_PROFILE_VERSION;
  readonly reasonCodes: readonly string[];
  readonly shadow?: ShadowMarketIntelligenceBundle;
  readonly assessment?: ShadowQualityAssessment;
}

export interface CreatePreparedShadowContextInput {
  readonly market: unknown;
  readonly analytics: unknown;
  readonly liquidation?: unknown;
  readonly symbol: unknown;
  readonly evaluationTime: unknown;
}

const SHADOW_CONTEXT_INPUT_KEYS = [
  "market",
  "analytics",
  "liquidation",
  "symbol",
  "evaluationTime",
] as const;

const PREPARED_SHADOW_MODEL: PreparedShadowModelIdentity = {
  producer: SHADOW_MARKET_INTELLIGENCE_PRODUCER,
  schemaVersion: SHADOW_MARKET_INTELLIGENCE_SCHEMA_VERSION,
  modelVersion: SHADOW_MARKET_INTELLIGENCE_MODEL_VERSION,
  profileVersion: SHADOW_MARKET_INTELLIGENCE_PROFILE_VERSION,
};

function invalid(message: string): Result<never> {
  return fail(domainError("INVALID_EVIDENCE", message));
}

function shadowFailureReason(code: string): string {
  if (code === "INVALID_VALUE") return "SHADOW_SOURCE_INCOMPATIBLE";
  if (
    code === "INVALID_EVIDENCE" ||
    code === "PLAN_HASH_MISMATCH" ||
    code === "INVALID_HASH"
  )
    return "SHADOW_SOURCE_REJECTED";
  if (code === "UNSUPPORTED_CONTRACT") return "SHADOW_SOURCE_UNSUPPORTED";
  return "SHADOW_CONTEXT_UNAVAILABLE";
}

function unavailableShadowContext(reasonCode: string): PreparedShadowContext {
  return deepFreeze({
    schemaVersion: PREPARED_SHADOW_CONTEXT_SCHEMA_VERSION,
    status: "unavailable",
    model: PREPARED_SHADOW_MODEL,
    qualityProfileVersion: SHADOW_QUALITY_PROFILE_VERSION,
    reasonCodes: [reasonCode],
  });
}

/** Build the pinned v1 shadow artifact from canonical saved sources. */
export function createPreparedShadowContextV1(
  rawInput: unknown,
): Result<PreparedShadowContext> {
  if (
    !closedRecord(rawInput, SHADOW_CONTEXT_INPUT_KEYS) ||
    !Object.hasOwn(rawInput, "market") ||
    !Object.hasOwn(rawInput, "analytics") ||
    !Object.hasOwn(rawInput, "symbol") ||
    !Object.hasOwn(rawInput, "evaluationTime")
  )
    return invalid("prepared shadow context inputs are invalid");

  try {
    const build =
      createShadowMarketIntelligenceWithQualityAssessmentV1(rawInput);
    if (!build.ok)
      return ok(
        unavailableShadowContext(shadowFailureReason(build.error.code)),
      );
    const reasonCodes = [
      ...new Set(
        build.value.assessment.findings.map((finding) => finding.reasonCode),
      ),
    ].sort(compareAnalyticsText);
    return ok(
      deepFreeze({
        schemaVersion: PREPARED_SHADOW_CONTEXT_SCHEMA_VERSION,
        status: "recorded",
        model: PREPARED_SHADOW_MODEL,
        qualityProfileVersion: SHADOW_QUALITY_PROFILE_VERSION,
        reasonCodes,
        shadow: build.value.shadow,
        assessment: build.value.assessment,
      }),
    );
  } catch {
    return ok(unavailableShadowContext("SHADOW_CONTEXT_UNAVAILABLE"));
  }
}

/** Build the current shadow artifact. New versions must retain this v1 path. */
export function createPreparedShadowContext(
  rawInput: unknown,
): Result<PreparedShadowContext> {
  return createPreparedShadowContextV1(rawInput);
}

/** Rebuild a saved context through the matching version-pinned calculation. */
export function replayPreparedShadowContext(
  rawInput: unknown,
  suppliedContext: unknown,
): Result<PreparedShadowContext> {
  if (
    !isRecord(suppliedContext) ||
    !isRecord(suppliedContext.model) ||
    suppliedContext.schemaVersion !== PREPARED_SHADOW_CONTEXT_SCHEMA_VERSION ||
    suppliedContext.qualityProfileVersion !== SHADOW_QUALITY_PROFILE_VERSION ||
    suppliedContext.model.producer !== SHADOW_MARKET_INTELLIGENCE_PRODUCER ||
    suppliedContext.model.schemaVersion !==
      SHADOW_MARKET_INTELLIGENCE_SCHEMA_VERSION ||
    suppliedContext.model.modelVersion !==
      SHADOW_MARKET_INTELLIGENCE_MODEL_VERSION ||
    suppliedContext.model.profileVersion !==
      SHADOW_MARKET_INTELLIGENCE_PROFILE_VERSION
  )
    return fail(
      domainError(
        "UNSUPPORTED_CONTRACT",
        "prepared shadow model version is unsupported",
      ),
    );
  return createPreparedShadowContextV1(rawInput);
}

/** Safe, data-minimized view shared by preparation and failure diagnostics. */
export function summarizePreparedShadowContext(context: PreparedShadowContext) {
  const common = {
    status: context.status,
    model: context.model,
    qualityProfileVersion: context.qualityProfileVersion,
    reasonCodes: context.reasonCodes,
  };
  if (
    context.status !== "recorded" ||
    context.shadow === undefined ||
    context.assessment === undefined
  )
    return common;
  const qualityByObservation = new Map(
    context.assessment.observationDispositions.map((row) => [
      row.observationId,
      row,
    ]),
  );
  const qualityByFamily = new Map(
    context.assessment.familyDispositions.map((row) => [row.family, row]),
  );
  return {
    ...common,
    shadowContentHash: context.shadow.contentHash,
    qualityAssessment: {
      status: context.assessment.status,
      contentHash: context.assessment.contentHash,
      profileHash: context.assessment.profileHash,
      findings: context.assessment.findings,
    },
    asOf: context.shadow.asOf,
    validForMs: context.shadow.validForMs,
    evaluationTime: context.shadow.evaluationTime,
    sourceManifest: context.shadow.sourceManifest,
    observations: context.shadow.observations.map((observation) => {
      const quality = qualityByObservation.get(observation.id);
      return {
        ...observation,
        qualityDisposition: quality?.disposition ?? "rejected",
        qualityReasonCodes: quality?.reasonCodes ?? [
          "SOURCE_REFERENCE_MISMATCH",
        ],
      };
    }),
    families: context.shadow.families.map((family) => {
      const quality = qualityByFamily.get(family.family);
      return {
        ...family,
        qualityStatus: quality?.status ?? "unavailable",
        acceptedObservationIds: quality?.acceptedObservationIds ?? [],
        rejectedObservationIds: quality?.rejectedObservationIds ?? [],
        qualityReasonCodes: quality?.reasonCodes ?? [],
      };
    }),
  };
}
