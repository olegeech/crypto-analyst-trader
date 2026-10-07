import {
  hashCanonical,
  type PlanHash,
} from "../identity/canonical-serialization.js";
import type { LiquidationEvidenceBundle } from "../liquidation/liquidation-evidence-bundle.js";
import type { MarketEvidenceBundle } from "../market/market-evidence-bundle.js";
import { domainError } from "../shared/errors.js";
import { isDecimalValue } from "../shared/decimal.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { fail, ok, type Result } from "../shared/result.js";
import { parseUtcTimestamp } from "../shared/time.js";
import {
  isRecord,
  requireHash,
  requireIdentifier,
  requireSafeText,
} from "../shared/validation.js";
import {
  ANALYTICS_FEATURES_VERSION,
  isAnalyticsFeaturesVersion,
  createAnalyticsProfile,
  hashAnalyticsProfile,
  isExternalEvidenceFamily,
  type AnalyticsFeatureRequest,
  type AnalyticsFeaturesVersion,
  type AnalyticsProfile,
  type ExternalEvidenceFamily,
} from "./analytics-profile.js";
import {
  compareAnalyticsText,
  normalizeAnalyticsReasonCodes,
  type AnalyticsReasonCode,
} from "./analytics-diagnostics.js";
import { onlyKeys } from "./analytics-validation.js";
import {
  createAnalyticsInputIdentity,
  type AnalyticsInputIdentity,
} from "./analytics-inputs.js";
import {
  reduceAnalyticsSufficiency,
  type AnalyticsOutputOutcome,
  type AnalyticsSufficiency,
} from "./analytics-sufficiency.js";
import {
  validateExternalRegimeEvidence,
  type ExternalEvidenceValidation,
  type ExternalRegimeEvidence,
} from "./external-regime-evidence.js";
import {
  computeDerivativeFeatures,
  type DerivativeFeatureOutcome,
} from "./derivatives-features.js";
import {
  computePriceFeatures,
  type PriceFeatureOutcome,
} from "./price-features.js";

export const ANALYTICS_EVIDENCE_SCHEMA_VERSION =
  "analytics-evidence/v1" as const;

export interface AnalyticsEvidenceBundle {
  readonly schemaVersion: typeof ANALYTICS_EVIDENCE_SCHEMA_VERSION;
  readonly featuresVersion: AnalyticsFeaturesVersion;
  readonly inputIdentity: AnalyticsInputIdentity;
  readonly profile: AnalyticsProfile;
  readonly profileHash: PlanHash;
  readonly priceFeatures: readonly PriceFeatureOutcome[];
  readonly derivativeFeatures: readonly DerivativeFeatureOutcome[];
  readonly externalOutcomes: readonly AnalyticsOutputOutcome[];
  readonly externalEvidence: readonly ExternalRegimeEvidence[];
  readonly sufficiency: AnalyticsSufficiency;
  readonly contentHash: PlanHash;
}

export interface CreateAnalyticsEvidenceBundleInput {
  readonly market: MarketEvidenceBundle;
  readonly liquidation?: LiquidationEvidenceBundle;
  readonly profile: unknown;
  readonly featuresVersion?: AnalyticsFeaturesVersion;
  readonly externalEvidence?: unknown;
}

type BundlePayload = Omit<AnalyticsEvidenceBundle, "contentHash">;

function invalid(message: string, field?: string): Result<never> {
  return fail(
    domainError(
      "INVALID_VALUE",
      message,
      field === undefined ? undefined : { field },
    ),
  );
}

function payloadHash(payload: BundlePayload): Result<PlanHash> {
  return hashCanonical(payload);
}

function createBundleFromPayload(
  payload: BundlePayload,
  knownContentHash?: PlanHash,
): Result<AnalyticsEvidenceBundle> {
  const contentHash =
    knownContentHash === undefined
      ? payloadHash(payload)
      : ok(knownContentHash);
  if (!contentHash.ok) return contentHash;
  return ok(
    deepFreeze({
      ...payload,
      contentHash: contentHash.value,
    }),
  );
}

function requestedExternalFamilies(
  profile: AnalyticsProfile,
): ReadonlySet<ExternalEvidenceFamily> {
  return new Set(profile.externalEvidence.map((request) => request.family));
}

function collectExternalEvidence(
  profile: AnalyticsProfile,
  input: unknown,
  identity: AnalyticsInputIdentity,
): Result<{
  readonly outcomes: readonly AnalyticsOutputOutcome[];
  readonly evidence: readonly ExternalRegimeEvidence[];
}> {
  if (input !== undefined && !isRecord(input)) {
    return invalid(
      "external evidence must be a family-keyed object",
      "externalEvidence",
    );
  }
  const supplied = (input ?? {}) as Record<string, unknown>;
  const requested = requestedExternalFamilies(profile);
  if (
    Object.keys(supplied).some(
      (family) => !requested.has(family as ExternalEvidenceFamily),
    )
  ) {
    return invalid(
      "external evidence contains an unrequested family",
      "externalEvidence",
    );
  }

  const outcomes: AnalyticsOutputOutcome[] = [];
  const accepted: ExternalRegimeEvidence[] = [];
  for (const request of profile.externalEvidence) {
    const candidate = supplied[request.family];
    if (candidate === undefined) {
      outcomes.push(
        Object.freeze({
          requestId: `external:${request.family}`,
          status: "unavailable",
          reasonCodes: normalizeAnalyticsReasonCodes([
            "MISSING_EXTERNAL_EVIDENCE",
          ]),
        }),
      );
      continue;
    }
    const validation = validateExternalRegimeEvidence(
      candidate,
      request.family,
      identity,
    );
    const claimsBothSources =
      isRecord(candidate) &&
      candidate.marketEvidenceHash !== undefined &&
      candidate.liquidationEvidenceHash !== undefined;
    const joinedIdentityConflict =
      claimsBothSources && identity.compatibility === "incompatible";
    const result = externalOutcome(validation, joinedIdentityConflict);
    outcomes.push(result.outcome);
    if (result.evidence !== undefined) accepted.push(result.evidence);
  }
  accepted.sort((left, right) =>
    compareAnalyticsText(left.family, right.family),
  );
  return ok({
    outcomes: Object.freeze(outcomes),
    evidence: Object.freeze(accepted),
  });
}

function externalOutcome(
  validation: ExternalEvidenceValidation,
  joinedIdentityConflict: boolean,
): {
  readonly outcome: AnalyticsOutputOutcome;
  readonly evidence?: ExternalRegimeEvidence;
} {
  const requestId = `external:${validation.family}`;
  if (
    validation.status === "complete" &&
    validation.evidence !== undefined &&
    !joinedIdentityConflict
  ) {
    return {
      outcome: Object.freeze({
        requestId,
        status: "complete",
        reasonCodes: normalizeAnalyticsReasonCodes(validation.reasonCodes),
      }),
      evidence: validation.evidence,
    };
  }
  const reasonCodes = normalizeAnalyticsReasonCodes(
    joinedIdentityConflict
      ? [...validation.reasonCodes, "INPUT_IDENTITY_MISMATCH"]
      : validation.reasonCodes,
  );
  return {
    outcome: Object.freeze({
      requestId,
      status: "unavailable",
      reasonCodes:
        reasonCodes.length > 0
          ? reasonCodes
          : normalizeAnalyticsReasonCodes([
              validation.family === "trap"
                ? "INVALID_TRAP_EVIDENCE"
                : "INVALID_EXTERNAL_SCORE",
            ]),
    }),
  };
}

function needsJoinedIdentity(profile: AnalyticsProfile): boolean {
  return profile.features.some(
    (feature) => feature.kind === "liquidation-window",
  );
}

function outcomeList(
  priceFeatures: readonly PriceFeatureOutcome[],
  derivativeFeatures: readonly DerivativeFeatureOutcome[],
  externalOutcomes: readonly AnalyticsOutputOutcome[],
): readonly AnalyticsOutputOutcome[] {
  return Object.freeze([
    ...priceFeatures,
    ...derivativeFeatures,
    ...externalOutcomes,
  ]);
}

function payloadFromParts(input: {
  readonly featuresVersion: AnalyticsFeaturesVersion;
  readonly inputIdentity: AnalyticsInputIdentity;
  readonly profile: AnalyticsProfile;
  readonly profileHash: PlanHash;
  readonly priceFeatures: readonly PriceFeatureOutcome[];
  readonly derivativeFeatures: readonly DerivativeFeatureOutcome[];
  readonly externalOutcomes: readonly AnalyticsOutputOutcome[];
  readonly externalEvidence: readonly ExternalRegimeEvidence[];
  readonly sufficiency: AnalyticsSufficiency;
}): BundlePayload {
  return {
    schemaVersion: ANALYTICS_EVIDENCE_SCHEMA_VERSION,
    featuresVersion: input.featuresVersion,
    inputIdentity: input.inputIdentity,
    profile: input.profile,
    profileHash: input.profileHash,
    priceFeatures: input.priceFeatures,
    derivativeFeatures: input.derivativeFeatures,
    externalOutcomes: input.externalOutcomes,
    externalEvidence: input.externalEvidence,
    sufficiency: input.sufficiency,
  };
}

function buildSufficiency(
  profile: AnalyticsProfile,
  priceFeatures: readonly PriceFeatureOutcome[],
  derivativeFeatures: readonly DerivativeFeatureOutcome[],
  externalOutcomes: readonly AnalyticsOutputOutcome[],
  identity: AnalyticsInputIdentity,
): Result<AnalyticsSufficiency> {
  return reduceAnalyticsSufficiency(
    profile,
    outcomeList(priceFeatures, derivativeFeatures, externalOutcomes),
    needsJoinedIdentity(profile) ? identity : undefined,
  );
}

export function createAnalyticsEvidenceBundle(
  input: CreateAnalyticsEvidenceBundleInput,
): Result<AnalyticsEvidenceBundle> {
  const featuresVersion = input.featuresVersion ?? ANALYTICS_FEATURES_VERSION;
  if (!isAnalyticsFeaturesVersion(featuresVersion)) {
    return fail(
      domainError(
        "UNSUPPORTED_CONTRACT",
        "analytics feature version is unsupported",
      ),
    );
  }
  const profile = createAnalyticsProfile(input.profile);
  if (!profile.ok) return profile;
  const identity = createAnalyticsInputIdentity(
    input.market,
    input.liquidation,
  );
  if (!identity.ok) return identity;
  const profileHash = hashAnalyticsProfile(profile.value);
  if (!profileHash.ok) return profileHash;

  const priceFeatures = computePriceFeatures(input.market, profile.value);
  const derivativeFeatures = computeDerivativeFeatures(
    input.market,
    input.liquidation,
    profile.value,
    featuresVersion,
  );
  const external = collectExternalEvidence(
    profile.value,
    input.externalEvidence,
    identity.value,
  );
  if (!external.ok) return external;
  const sufficiency = buildSufficiency(
    profile.value,
    priceFeatures,
    derivativeFeatures,
    external.value.outcomes,
    identity.value,
  );
  if (!sufficiency.ok) return sufficiency;

  return createBundleFromPayload(
    payloadFromParts({
      featuresVersion,
      inputIdentity: identity.value,
      profile: profile.value,
      profileHash: profileHash.value,
      priceFeatures,
      derivativeFeatures,
      externalOutcomes: external.value.outcomes,
      externalEvidence: external.value.evidence,
      sufficiency: sufficiency.value,
    }),
  );
}

function validReasonCodes(
  value: unknown,
): value is readonly AnalyticsReasonCode[] {
  if (!Array.isArray(value)) return false;
  const normalized = normalizeAnalyticsReasonCodes(
    value as AnalyticsReasonCode[],
  );
  return (
    normalized.length === value.length &&
    normalized.every((item, index) => item === value[index])
  );
}

function parseIdentity(value: unknown): Result<AnalyticsInputIdentity> {
  if (
    !isRecord(value) ||
    !onlyKeys(value, [
      "runId",
      "universeVersion",
      "bundleCutoff",
      "marketContentHash",
      "marketBundleHash",
      "liquidationRunId",
      "liquidationUniverseVersion",
      "liquidationBundleCutoff",
      "liquidationMarketContentHash",
      "liquidationBundleHash",
      "compatibility",
      "reasonCodes",
    ])
  )
    return invalid("analytics source identity must be an object");
  const runId = requireIdentifier(value.runId, "inputIdentity.runId");
  const universeVersion = requireSafeText(
    value.universeVersion,
    "inputIdentity.universeVersion",
  );
  const bundleCutoff = parseUtcTimestamp(value.bundleCutoff);
  const marketContentHash = requireHash(
    value.marketContentHash,
    "inputIdentity.marketContentHash",
  );
  const marketBundleHash = requireHash(
    value.marketBundleHash,
    "inputIdentity.marketBundleHash",
  );
  const hasLiquidation = [
    "liquidationRunId",
    "liquidationUniverseVersion",
    "liquidationBundleCutoff",
    "liquidationMarketContentHash",
    "liquidationBundleHash",
  ].some((key) => Object.hasOwn(value, key));
  if (
    !runId.ok ||
    !universeVersion.ok ||
    !bundleCutoff.ok ||
    !marketContentHash.ok ||
    !marketBundleHash.ok
  ) {
    return invalid("analytics source identity is invalid");
  }

  const common = {
    runId: runId.value,
    universeVersion: universeVersion.value,
    bundleCutoff: bundleCutoff.value,
    marketContentHash: marketContentHash.value,
    marketBundleHash: marketBundleHash.value,
  };
  if (!hasLiquidation) {
    if (
      value.compatibility !== "compatible" ||
      !validReasonCodes(value.reasonCodes) ||
      value.reasonCodes.length !== 0
    ) {
      return invalid("market-only analytics identity is inconsistent");
    }
    return ok(
      Object.freeze({
        ...common,
        compatibility: "compatible",
        reasonCodes: Object.freeze([]),
      }),
    );
  }

  const liquidationRunId = requireIdentifier(
    value.liquidationRunId,
    "inputIdentity.liquidationRunId",
  );
  const liquidationUniverseVersion = requireSafeText(
    value.liquidationUniverseVersion,
    "inputIdentity.liquidationUniverseVersion",
  );
  const liquidationBundleCutoff = parseUtcTimestamp(
    value.liquidationBundleCutoff,
  );
  const liquidationMarketContentHash = requireHash(
    value.liquidationMarketContentHash,
    "inputIdentity.liquidationMarketContentHash",
  );
  const liquidationBundleHash = requireHash(
    value.liquidationBundleHash,
    "inputIdentity.liquidationBundleHash",
  );
  if (
    !liquidationRunId.ok ||
    !liquidationUniverseVersion.ok ||
    !liquidationBundleCutoff.ok ||
    !liquidationMarketContentHash.ok ||
    !liquidationBundleHash.ok
  ) {
    return invalid("liquidation analytics identity is incomplete");
  }
  const compatible =
    liquidationRunId.value === runId.value &&
    liquidationUniverseVersion.value === universeVersion.value &&
    liquidationBundleCutoff.value === bundleCutoff.value &&
    liquidationMarketContentHash.value === marketContentHash.value;
  const expectedReasons: AnalyticsReasonCode[] = compatible
    ? []
    : ["INPUT_IDENTITY_MISMATCH"];
  if (
    value.compatibility !== (compatible ? "compatible" : "incompatible") ||
    !validReasonCodes(value.reasonCodes) ||
    value.reasonCodes.length !== expectedReasons.length ||
    value.reasonCodes.some((reason, index) => reason !== expectedReasons[index])
  ) {
    return invalid(
      "liquidation analytics identity compatibility is inconsistent",
    );
  }
  return ok(
    Object.freeze({
      ...common,
      liquidationRunId: liquidationRunId.value,
      liquidationUniverseVersion: liquidationUniverseVersion.value,
      liquidationBundleCutoff: liquidationBundleCutoff.value,
      liquidationMarketContentHash: liquidationMarketContentHash.value,
      liquidationBundleHash: liquidationBundleHash.value,
      compatibility: compatible ? "compatible" : "incompatible",
      reasonCodes: normalizeAnalyticsReasonCodes(expectedReasons),
    }),
  );
}

function validFeatureWindow(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const from = parseUtcTimestamp(value.from);
  const to = parseUtcTimestamp(value.to);
  if (!from.ok || !to.ok || Date.parse(to.value) < Date.parse(from.value)) {
    return false;
  }
  if (Object.hasOwn(value, "observationCount")) {
    const hasCadence = Object.hasOwn(value, "cadenceMs");
    return (
      onlyKeys(
        value,
        hasCadence
          ? ["from", "to", "observationCount", "cadenceMs"]
          : ["from", "to", "observationCount"],
      ) &&
      typeof value.observationCount === "number" &&
      Number.isSafeInteger(value.observationCount) &&
      value.observationCount > 0 &&
      (!hasCadence ||
        (typeof value.cadenceMs === "number" &&
          Number.isSafeInteger(value.cadenceMs) &&
          value.cadenceMs > 0))
    );
  }
  return (
    onlyKeys(value, [
      "from",
      "to",
      "hours",
      "observedConstituentBuckets",
      "expectedConstituentBuckets",
      "complete",
    ]) &&
    typeof value.hours === "number" &&
    Number.isSafeInteger(value.hours) &&
    value.hours > 0 &&
    typeof value.expectedConstituentBuckets === "number" &&
    Number.isSafeInteger(value.expectedConstituentBuckets) &&
    value.expectedConstituentBuckets > 0 &&
    typeof value.observedConstituentBuckets === "number" &&
    Number.isSafeInteger(value.observedConstituentBuckets) &&
    value.observedConstituentBuckets >= 0 &&
    typeof value.complete === "boolean"
  );
}

function validLiquidationProofs(
  outcome: Record<string, unknown>,
  featuresVersion: AnalyticsFeaturesVersion,
): boolean {
  const coverageProof = outcome.coverageProof;
  const historyProof = outcome.historyProof;
  const validCoverageProof =
    coverageProof === undefined ||
    coverageProof === "complete" ||
    coverageProof === "incomplete";
  const validHistoryProof =
    historyProof === undefined ||
    historyProof === "complete" ||
    historyProof === "incomplete";
  if (!validCoverageProof || !validHistoryProof) return false;
  if (outcome.status !== "complete") return true;
  if (
    coverageProof !== "complete" ||
    !isRecord(outcome.window) ||
    outcome.window.complete !== true
  )
    return false;
  if (featuresVersion === ANALYTICS_FEATURES_VERSION)
    return historyProof === "complete";
  return (
    (historyProof === "complete" || historyProof === "incomplete") &&
    Array.isArray(outcome.reasonCodes) &&
    !outcome.reasonCodes.includes("INCOMPLETE_LIQUIDATION_HISTORY")
  );
}

function validFeatureValue(value: unknown, kind: string): boolean {
  if (!isRecord(value) || value.type !== kind) return false;
  const decimalField = (field: string) => isDecimalValue(value[field]);
  switch (kind) {
    case "close-return":
    case "maximum-drawdown":
    case "realized-volatility":
      return (
        onlyKeys(value, ["type", "percent", "unit"]) &&
        decimalField("percent") &&
        value.unit === "percent"
      );
    case "atr":
      return (
        onlyKeys(value, ["type", "atr", "normalizedPercent", "unit"]) &&
        decimalField("atr") &&
        decimalField("normalizedPercent") &&
        value.unit === "price"
      );
    case "volatility-comparison":
      return (
        onlyKeys(value, [
          "type",
          "recentPercent",
          "referencePercent",
          "ratio",
          "relation",
        ]) &&
        decimalField("recentPercent") &&
        decimalField("referencePercent") &&
        decimalField("ratio") &&
        ["expansion", "compression", "unchanged"].includes(
          value.relation as string,
        )
      );
    case "funding-change":
      return (
        onlyKeys(value, ["type", "change", "unit"]) &&
        decimalField("change") &&
        value.unit === "funding-rate"
      );
    case "open-interest-absolute-change":
      return (
        onlyKeys(value, ["type", "change", "unit"]) &&
        decimalField("change") &&
        value.unit === "source-open-interest"
      );
    case "open-interest-relative-change":
      return (
        onlyKeys(value, ["type", "percent", "unit"]) &&
        decimalField("percent") &&
        value.unit === "percent"
      );
    case "liquidation-window":
      return (
        onlyKeys(value, [
          "type",
          "longUsd",
          "shortUsd",
          "totalUsd",
          "imbalance",
          "unit",
        ]) &&
        decimalField("longUsd") &&
        decimalField("shortUsd") &&
        decimalField("totalUsd") &&
        (value.imbalance === undefined || decimalField("imbalance")) &&
        value.unit === "USD"
      );
    default:
      return false;
  }
}

function validateOutcome(
  value: unknown,
  requestId: string,
  status: readonly string[],
  allowedKeys: readonly string[],
): value is AnalyticsOutputOutcome {
  const explicitZeroDiagnostic =
    isRecord(value) &&
    value.kind === "liquidation-window" &&
    Array.isArray(value.reasonCodes) &&
    value.reasonCodes.length === 1 &&
    value.reasonCodes[0] === "ZERO_LIQUIDATION_NOTIONAL" &&
    isRecord(value.value) &&
    [value.value.longUsd, value.value.shortUsd, value.value.totalUsd].every(
      (amount) => isDecimalValue(amount) && amount.isZero(),
    ) &&
    value.value.imbalance === undefined;
  return (
    isRecord(value) &&
    onlyKeys(value, allowedKeys) &&
    value.requestId === requestId &&
    value.status !== undefined &&
    status.includes(value.status as string) &&
    validReasonCodes(value.reasonCodes) &&
    (value.status === "complete"
      ? value.reasonCodes.length === 0 || explicitZeroDiagnostic
      : value.reasonCodes.length > 0)
  );
}

function validateFeatureArrays(
  profile: AnalyticsProfile,
  featuresVersion: AnalyticsFeaturesVersion,
  priceFeatures: unknown,
  derivativeFeatures: unknown,
): boolean {
  if (!Array.isArray(priceFeatures) || !Array.isArray(derivativeFeatures))
    return false;
  const priceRequests = profile.features.filter(
    (
      feature,
    ): feature is Extract<
      AnalyticsFeatureRequest,
      {
        readonly kind:
          | "close-return"
          | "maximum-drawdown"
          | "atr"
          | "realized-volatility"
          | "volatility-comparison";
      }
    > =>
      feature.kind === "close-return" ||
      feature.kind === "maximum-drawdown" ||
      feature.kind === "atr" ||
      feature.kind === "realized-volatility" ||
      feature.kind === "volatility-comparison",
  );
  const derivativeRequests = profile.features.filter(
    (
      feature,
    ): feature is Extract<
      AnalyticsFeatureRequest,
      {
        readonly kind:
          | "funding-change"
          | "open-interest-absolute-change"
          | "open-interest-relative-change"
          | "liquidation-window";
      }
    > =>
      feature.kind === "funding-change" ||
      feature.kind === "open-interest-absolute-change" ||
      feature.kind === "open-interest-relative-change" ||
      feature.kind === "liquidation-window",
  );
  if (
    priceFeatures.length !== priceRequests.length ||
    derivativeFeatures.length !== derivativeRequests.length
  )
    return false;
  for (const [index, request] of priceRequests.entries()) {
    const outcome = priceFeatures[index];
    if (!isRecord(outcome)) return false;
    const validWindow =
      outcome.window === undefined || validFeatureWindow(outcome.window);
    const validValue =
      outcome.value === undefined ||
      validFeatureValue(outcome.value, request.kind);
    if (
      !validateOutcome(
        outcome,
        request.id,
        ["complete", "partial", "unavailable"],
        [
          "requestId",
          "status",
          "reasonCodes",
          "kind",
          "symbol",
          "interval",
          "window",
          "value",
        ],
      ) ||
      !isRecord(outcome) ||
      outcome.kind !== request.kind ||
      outcome.symbol !== request.symbol ||
      outcome.interval !== request.interval ||
      !validWindow ||
      !validValue ||
      (outcome.status === "complete" &&
        (outcome.window === undefined || outcome.value === undefined))
    )
      return false;
  }
  for (const [index, request] of derivativeRequests.entries()) {
    const outcome = derivativeFeatures[index];
    if (!isRecord(outcome)) return false;
    const validProofs =
      request.kind !== "liquidation-window" ||
      validLiquidationProofs(outcome, featuresVersion);
    const validWindow =
      outcome.window === undefined || validFeatureWindow(outcome.window);
    const validValue =
      outcome.value === undefined ||
      validFeatureValue(outcome.value, request.kind);
    if (
      !validateOutcome(
        outcome,
        request.id,
        ["complete", "partial", "unavailable"],
        [
          "requestId",
          "status",
          "reasonCodes",
          "kind",
          "symbol",
          "asset",
          "window",
          "coverageProof",
          "historyProof",
          "value",
        ],
      ) ||
      !isRecord(outcome) ||
      outcome.kind !== request.kind
    )
      return false;
    if (
      request.kind === "liquidation-window"
        ? outcome.asset !== request.asset
        : outcome.symbol !== request.symbol
    )
      return false;
    if (
      !validWindow ||
      !validValue ||
      !validProofs ||
      (outcome.status === "complete" &&
        (outcome.window === undefined || outcome.value === undefined))
    )
      return false;
  }
  return true;
}

function validateExternalParts(
  profile: AnalyticsProfile,
  identity: AnalyticsInputIdentity,
  externalOutcomes: unknown,
  evidence: unknown,
): externalOutcomes is readonly AnalyticsOutputOutcome[] {
  if (!Array.isArray(externalOutcomes) || !Array.isArray(evidence))
    return false;
  if (externalOutcomes.length !== profile.externalEvidence.length) return false;
  if (
    externalOutcomes.some(
      (item, index) =>
        !isRecord(item) ||
        item.requestId !==
          `external:${profile.externalEvidence[index]?.family ?? ""}`,
    )
  )
    return false;
  const acceptedByFamily = new Map<string, ExternalRegimeEvidence>();
  for (const item of evidence) {
    if (
      !isRecord(item) ||
      !isExternalEvidenceFamily(item.family) ||
      acceptedByFamily.has(item.family)
    )
      return false;
    const validation = validateExternalRegimeEvidence(
      item,
      item.family,
      identity,
    );
    if (validation.status !== "complete" || validation.evidence === undefined)
      return false;
    acceptedByFamily.set(item.family, validation.evidence);
  }
  const acceptedFamilies: string[] = [];
  for (const [index, request] of profile.externalEvidence.entries()) {
    const outcome = externalOutcomes[index];
    if (
      !validateOutcome(
        outcome,
        `external:${request.family}`,
        ["complete", "unavailable"],
        ["requestId", "status", "reasonCodes"],
      )
    )
      return false;
    const hasEvidence = acceptedByFamily.has(request.family);
    if ((outcome.status === "complete") !== hasEvidence) return false;
    if (hasEvidence) acceptedFamilies.push(request.family);
  }
  return (
    acceptedByFamily.size === acceptedFamilies.length &&
    evidence.every(
      (item, index) =>
        isRecord(item) && item.family === acceptedFamilies[index],
    )
  );
}

export function rehydrateAnalyticsEvidenceBundle(
  input: unknown,
): Result<AnalyticsEvidenceBundle> {
  if (
    !isRecord(input) ||
    !onlyKeys(input, [
      "schemaVersion",
      "featuresVersion",
      "inputIdentity",
      "profile",
      "profileHash",
      "priceFeatures",
      "derivativeFeatures",
      "externalOutcomes",
      "externalEvidence",
      "sufficiency",
      "contentHash",
    ])
  )
    return invalid("analytics evidence bundle contains unsupported fields");
  if (
    input.schemaVersion !== ANALYTICS_EVIDENCE_SCHEMA_VERSION ||
    !isAnalyticsFeaturesVersion(input.featuresVersion)
  ) {
    return fail(
      domainError(
        "UNSUPPORTED_CONTRACT",
        "analytics evidence version is unsupported",
      ),
    );
  }
  const profile = createAnalyticsProfile(input.profile);
  const identity = parseIdentity(input.inputIdentity);
  const profileHash = requireHash(input.profileHash, "profileHash");
  const claimedHash = requireHash(input.contentHash, "contentHash");
  if (!profile.ok || !identity.ok || !profileHash.ok || !claimedHash.ok)
    return invalid("analytics evidence identity is invalid");
  const computedProfileHash = hashAnalyticsProfile(profile.value);
  if (
    !computedProfileHash.ok ||
    computedProfileHash.value !== profileHash.value
  ) {
    return fail(
      domainError(
        "PLAN_HASH_MISMATCH",
        "analytics profile hash does not match its profile",
      ),
    );
  }
  if (
    !validateFeatureArrays(
      profile.value,
      input.featuresVersion,
      input.priceFeatures,
      input.derivativeFeatures,
    )
  ) {
    return invalid(
      "analytics feature outcomes do not match the requested profile",
    );
  }
  if (
    !validateExternalParts(
      profile.value,
      identity.value,
      input.externalOutcomes,
      input.externalEvidence,
    )
  ) {
    return invalid(
      "analytics external evidence does not match the requested profile",
    );
  }
  if (
    !isRecord(input.sufficiency) ||
    !onlyKeys(input.sufficiency, ["status", "reasonCodes"])
  ) {
    return invalid("analytics sufficiency is invalid");
  }
  const outcomes = outcomeList(
    input.priceFeatures as readonly PriceFeatureOutcome[],
    input.derivativeFeatures as readonly DerivativeFeatureOutcome[],
    input.externalOutcomes,
  );
  const sufficiency = reduceAnalyticsSufficiency(
    profile.value,
    outcomes,
    needsJoinedIdentity(profile.value) ? identity.value : undefined,
  );
  if (!sufficiency.ok) return sufficiency;
  if (
    input.sufficiency.status !== sufficiency.value.status ||
    !validReasonCodes(input.sufficiency.reasonCodes) ||
    input.sufficiency.reasonCodes.length !==
      sufficiency.value.reasonCodes.length ||
    input.sufficiency.reasonCodes.some(
      (reason, index) => reason !== sufficiency.value.reasonCodes[index],
    )
  )
    return invalid("analytics sufficiency does not match its outcomes");
  const payload = payloadFromParts({
    featuresVersion: input.featuresVersion,
    inputIdentity: identity.value,
    profile: profile.value,
    profileHash: computedProfileHash.value,
    priceFeatures: input.priceFeatures as readonly PriceFeatureOutcome[],
    derivativeFeatures:
      input.derivativeFeatures as readonly DerivativeFeatureOutcome[],
    externalOutcomes: input.externalOutcomes,
    externalEvidence:
      input.externalEvidence as readonly ExternalRegimeEvidence[],
    sufficiency: sufficiency.value,
  });
  const computedHash = payloadHash(payload);
  if (!computedHash.ok || computedHash.value !== claimedHash.value) {
    return fail(
      domainError(
        "PLAN_HASH_MISMATCH",
        "analytics evidence content hash does not match its contents",
      ),
    );
  }
  return createBundleFromPayload(payload, computedHash.value);
}
