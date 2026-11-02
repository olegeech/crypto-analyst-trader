import {
  createShadowMarketIntelligence,
  SHADOW_MARKET_INTELLIGENCE_MAX_SOURCE_AGE_MS,
  SHADOW_MARKET_INTELLIGENCE_MODEL_VERSION,
  SHADOW_MARKET_INTELLIGENCE_PROFILE_VERSION,
  SHADOW_MARKET_INTELLIGENCE_PRODUCER,
  SHADOW_MARKET_INTELLIGENCE_SCHEMA_VERSION,
  type ShadowFamilyOutcome,
  type ShadowMarketIntelligenceBundle,
  type ShadowMarketFamily,
} from "../analytics/shadow-market-intelligence.js";
import { onlyKeys } from "../analytics/analytics-validation.js";
import {
  hashCanonical,
  type PlanHash,
} from "../identity/canonical-serialization.js";
import {
  createLiquidationEvidenceRef,
  rehydrateLiquidationEvidenceBundle,
} from "../liquidation/liquidation-evidence-bundle.js";
import type { MarketEvidenceBundle } from "../market/market-evidence-bundle.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { domainError } from "../shared/errors.js";
import { fail, ok, type Result } from "../shared/result.js";
import { parseUtcTimestamp, type UtcTimestamp } from "../shared/time.js";
import { isRecord, requireHash } from "../shared/validation.js";
import {
  admitQualitySource,
  type QualityInputRecord,
} from "./quality-inputs.js";
import {
  INVARIANT_QUALITY_REASONS,
  type QualityReasonCode,
} from "./data-quality-findings.js";
import { classifyQualityEvidence } from "./quality-validation.js";
import { createQualityProfile } from "./quality-profile.js";

export const SHADOW_QUALITY_ASSESSMENT_SCHEMA_VERSION =
  "shadow-quality-assessment/v1" as const;
export const SHADOW_QUALITY_ASSESSMENT_PRODUCER =
  "crypto-analyst-trader/shadow-quality-assessment" as const;
export const SHADOW_QUALITY_PROFILE_VERSION = "shadow-quality/v1" as const;

export type ShadowQualityReasonCode =
  QualityReasonCode | "SHADOW_REPLAY_MISMATCH" | "SOURCE_REFERENCE_MISMATCH";

export interface ShadowQualityObservationDisposition {
  readonly observationId: string;
  readonly sourceRole?: "market" | "analytics";
  readonly sourceId: string;
  readonly sourceHash: PlanHash;
  readonly disposition: "accepted" | "rejected";
  readonly reasonCodes: readonly ShadowQualityReasonCode[];
}

export interface ShadowQualitySourceDisposition {
  readonly role: "market" | "analytics" | "liquidation";
  readonly disposition: "accepted" | "partial" | "rejected" | "missing";
  readonly contentHash?: string;
  readonly bundleHash?: string;
  readonly reasonCodes: readonly QualityReasonCode[];
}

export interface ShadowQualityFamilyDisposition {
  readonly family: ShadowMarketFamily;
  readonly status: "accepted" | "partial" | "rejected" | "unavailable";
  readonly assessmentStatus: "unavailable";
  readonly assessmentReason: "NO_CALIBRATED_MODEL";
  readonly acceptedObservationIds: readonly string[];
  readonly rejectedObservationIds: readonly string[];
  readonly missingSourceInputs: readonly string[];
  readonly missingModelInputs: readonly string[];
  readonly reasonCodes: readonly ShadowQualityReasonCode[];
}

export interface ShadowQualityFinding {
  readonly role: string;
  readonly reasonCode: ShadowQualityReasonCode;
}

export interface ShadowQualityAssessment {
  readonly schemaVersion: typeof SHADOW_QUALITY_ASSESSMENT_SCHEMA_VERSION;
  readonly producer: typeof SHADOW_QUALITY_ASSESSMENT_PRODUCER;
  readonly profileVersion: typeof SHADOW_QUALITY_PROFILE_VERSION;
  readonly profileHash: PlanHash;
  readonly trustedModel: {
    readonly producer: typeof SHADOW_MARKET_INTELLIGENCE_PRODUCER;
    readonly schemaVersion: typeof SHADOW_MARKET_INTELLIGENCE_SCHEMA_VERSION;
    readonly modelVersion: typeof SHADOW_MARKET_INTELLIGENCE_MODEL_VERSION;
  };
  readonly shadowContentHash: PlanHash;
  readonly asOf: UtcTimestamp;
  readonly validForMs: number;
  readonly evaluationTime: UtcTimestamp;
  readonly status: "accepted" | "partial" | "rejected";
  readonly sourceDispositions: readonly ShadowQualitySourceDisposition[];
  readonly observationDispositions: readonly ShadowQualityObservationDisposition[];
  readonly familyDispositions: readonly ShadowQualityFamilyDisposition[];
  readonly findings: readonly ShadowQualityFinding[];
  readonly contentHash: PlanHash;
}

export interface CreateShadowQualityAssessmentInput {
  readonly shadow: unknown;
  readonly market: unknown;
  readonly analytics: unknown;
  readonly liquidation?: unknown;
  readonly evaluationTime: unknown;
}

type AssessmentPayload = Omit<ShadowQualityAssessment, "contentHash">;
type ShadowQualitySourceRole = "market" | "analytics" | "liquidation";

const SHADOW_QUALITY_PROFILE_INPUT = {
  schemaVersion: "quality-profile/v1",
  profileVersion: SHADOW_QUALITY_PROFILE_VERSION,
  roles: ["market", "analytics", "liquidation"].map((id) => ({
    id,
    required: false,
    maxAgeMs: SHADOW_MARKET_INTELLIGENCE_MAX_SOURCE_AGE_MS,
  })),
  metadataSkewMs: 1_000,
  trust: [
    {
      issuer: "crypto-analyst-trader/shadow-quality/v1",
      family: "shadow-market-intelligence",
      producer: SHADOW_MARKET_INTELLIGENCE_PRODUCER,
      schemaVersion: SHADOW_MARKET_INTELLIGENCE_SCHEMA_VERSION,
      modelVersion: SHADOW_MARKET_INTELLIGENCE_MODEL_VERSION,
    },
  ],
  penalties: [],
} as const;

const HARD_REJECTION_REASONS: ReadonlySet<QualityReasonCode> = new Set([
  ...INVARIANT_QUALITY_REASONS,
  "UNTRUSTED_EVIDENCE",
  "STALE_EVIDENCE",
  "METADATA_CLOCK_SKEW",
  "INVALID_GENERATION_TIME",
]);

const TICKER_OBSERVATION_IDS = new Set([
  "funding-current",
  "quote-spread",
  "quote-relative-spread",
]);

const LIQUIDATION_OBSERVATION_IDS = new Set([
  "liquidation-12h-imbalance",
  "liquidation-12h-long-usd",
  "liquidation-12h-short-usd",
  "liquidation-12h-total-usd",
]);

function invalid(message: string): Result<never> {
  return fail(domainError("INVALID_VALUE", message));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort(compareText);
}

function mapFindingRole(role: string): ShadowQualitySourceRole | undefined {
  if (role === "market" || role === "analytics" || role === "liquidation")
    return role;
  if (role.startsWith("analytics:") || role.startsWith("external:"))
    return "analytics";
  return undefined;
}

function isHardReason(reason: QualityReasonCode): boolean {
  return HARD_REJECTION_REASONS.has(reason);
}

function parseObservationRows(value: unknown): Result<
  readonly {
    readonly id: string;
    readonly sourceId: string;
    readonly sourceHash: PlanHash;
  }[]
> {
  if (!isRecord(value) || !Array.isArray(value.observations))
    return invalid("shadow assessment requires a shadow observation bundle");
  const rows: {
    id: string;
    sourceId: string;
    sourceHash: PlanHash;
  }[] = [];
  for (const observation of value.observations) {
    if (
      !isRecord(observation) ||
      typeof observation.id !== "string" ||
      observation.id.length === 0 ||
      typeof observation.sourceId !== "string" ||
      typeof observation.sourceHash !== "string"
    )
      return invalid("shadow observation identity is malformed");
    rows.push({
      id: observation.id,
      sourceId: observation.sourceId,
      sourceHash: observation.sourceHash as PlanHash,
    });
  }
  return ok(rows);
}

function makeSourceRecords(input: {
  readonly market: unknown;
  readonly analytics: unknown;
  readonly liquidation?: unknown;
  readonly expected?: ShadowMarketIntelligenceBundle;
  readonly profileAgeMs: number;
}): Result<readonly QualityInputRecord[]> {
  const marketHash = input.expected?.sourceManifest.market.bundleHash;
  const analyticsHash = input.expected?.sourceManifest.analytics.bundleHash;
  const market = admitQualitySource({
    role: "market",
    value: input.market,
    ...(marketHash === undefined ? {} : { expectedBundleHash: marketHash }),
  });
  const analytics = admitQualitySource({
    role: "analytics",
    value: input.analytics,
    ...(analyticsHash === undefined
      ? {}
      : { expectedBundleHash: analyticsHash }),
  });
  const records: QualityInputRecord[] = [market, analytics];
  if (input.liquidation !== undefined) {
    const liquidation = rehydrateLiquidationEvidenceBundle(input.liquidation);
    if (!liquidation.ok) {
      records.push(
        admitQualitySource({ role: "liquidation", value: input.liquidation }),
      );
    } else {
      const liquidationHash = hashCanonical(liquidation.value);
      if (!liquidationHash.ok) return liquidationHash;
      const evidenceRef = createLiquidationEvidenceRef(
        liquidation.value,
        liquidationHash.value,
        input.profileAgeMs,
      );
      if (!evidenceRef.ok) return evidenceRef;
      const expectedHash =
        input.expected?.sourceManifest.liquidation?.bundleHash;
      records.push(
        admitQualitySource({
          role: "liquidation",
          value: liquidation.value,
          evidenceRef: evidenceRef.value,
          ...(expectedHash === undefined
            ? {}
            : { expectedBundleHash: expectedHash }),
        }),
      );
    }
  }
  return ok(records);
}

function sourceFailures(
  records: readonly QualityInputRecord[],
  findings: ReturnType<typeof classifyQualityEvidence>,
): Map<ShadowQualitySourceRole, Set<QualityReasonCode>> {
  const output = new Map<ShadowQualitySourceRole, Set<QualityReasonCode>>([
    ["market", new Set()],
    ["analytics", new Set()],
    ["liquidation", new Set()],
  ]);
  for (const record of records) {
    const target = output.get(record.role);
    if (target) for (const reason of record.failures) target.add(reason);
  }
  for (const finding of findings) {
    const target = mapFindingRole(finding.role);
    if (!target || !isHardReason(finding.reasonCode)) continue;
    output.get(target)?.add(finding.reasonCode);
  }
  return output;
}

function mapQualityFindings(
  findings: ReturnType<typeof classifyQualityEvidence>,
): ShadowQualityFinding[] {
  return findings.map((finding) => ({
    role: finding.role,
    reasonCode: finding.reasonCode,
  }));
}

function assessmentStatus(
  dispositions: readonly ShadowQualityObservationDisposition[],
  globalReasons: readonly ShadowQualityReasonCode[],
): ShadowQualityAssessment["status"] {
  const accepted = dispositions.filter(
    (item) => item.disposition === "accepted",
  ).length;
  const rejected = dispositions.length - accepted;
  if (rejected === 0 && globalReasons.length === 0) return "accepted";
  if (accepted > 0) return "partial";
  return "rejected";
}

function familyDispositions(
  outcomes: readonly ShadowFamilyOutcome[],
  dispositions: readonly ShadowQualityObservationDisposition[],
): ShadowQualityFamilyDisposition[] {
  const byId = new Map(dispositions.map((item) => [item.observationId, item]));
  return outcomes.map((outcome) => {
    const acceptedObservationIds = outcome.observationIds.filter(
      (id) => byId.get(id)?.disposition === "accepted",
    );
    const rejectedObservationIds = outcome.observationIds.filter(
      (id) => byId.get(id)?.disposition === "rejected",
    );
    const reasonCodes = sortedUnique(
      outcome.observationIds.flatMap((id) => byId.get(id)?.reasonCodes ?? []),
    );
    let status: ShadowQualityFamilyDisposition["status"];
    if (outcome.observationIds.length === 0) status = "unavailable";
    else if (acceptedObservationIds.length === 0) status = "rejected";
    else if (rejectedObservationIds.length > 0) status = "partial";
    else status = "accepted";
    return {
      family: outcome.family,
      status,
      assessmentStatus: outcome.assessmentStatus,
      assessmentReason: outcome.assessmentReason,
      acceptedObservationIds,
      rejectedObservationIds,
      missingSourceInputs: outcome.missingSourceInputs,
      missingModelInputs: outcome.missingModelInputs,
      reasonCodes,
    };
  });
}

function sourceDispositions(
  records: readonly QualityInputRecord[],
  findings: ReturnType<typeof classifyQualityEvidence>,
  failures: ReadonlyMap<
    ShadowQualitySourceRole,
    ReadonlySet<QualityReasonCode>
  >,
): ShadowQualitySourceDisposition[] {
  const roles: readonly ShadowQualitySourceRole[] = [
    "market",
    "analytics",
    "liquidation",
  ];
  return roles.map((role) => {
    const record = records.find((item) => item.role === role);
    const reasonCodes = sortedUnique([
      ...(record?.failures ?? []),
      ...findings
        .filter((finding) => mapFindingRole(finding.role) === role)
        .map((finding) => finding.reasonCode),
    ]);
    const hardFailures = failures.get(role);
    const disposition: ShadowQualitySourceDisposition["disposition"] =
      record === undefined || record.value === undefined
        ? "missing"
        : hardFailures && hardFailures.size > 0
          ? "rejected"
          : reasonCodes.length > 0
            ? "partial"
            : "accepted";
    return {
      role,
      disposition,
      ...(record?.contentHash === undefined
        ? {}
        : { contentHash: record.contentHash }),
      ...(record?.bundleHash === undefined
        ? {}
        : { bundleHash: record.bundleHash }),
      reasonCodes,
    };
  });
}

export function createShadowQualityAssessment(
  rawInput: unknown,
): Result<ShadowQualityAssessment> {
  if (
    !isRecord(rawInput) ||
    !onlyKeys(rawInput, [
      "shadow",
      "market",
      "analytics",
      "liquidation",
      "evaluationTime",
    ]) ||
    !Object.hasOwn(rawInput, "shadow") ||
    !Object.hasOwn(rawInput, "market") ||
    !Object.hasOwn(rawInput, "analytics") ||
    !Object.hasOwn(rawInput, "evaluationTime")
  )
    return invalid("shadow quality assessment input is invalid");

  const parsedRows = parseObservationRows(rawInput.shadow);
  const evaluationTime = parseUtcTimestamp(rawInput.evaluationTime);
  if (!parsedRows.ok) return parsedRows;
  if (!evaluationTime.ok) return evaluationTime;
  if (!isRecord(rawInput.shadow))
    return invalid("shadow assessment bundle is invalid");
  const shadow = rawInput.shadow as unknown as ShadowMarketIntelligenceBundle;
  const parsedCutoff = parseUtcTimestamp(shadow.cutoff);
  if (!parsedCutoff.ok) return parsedCutoff;

  const profile = createQualityProfile(SHADOW_QUALITY_PROFILE_INPUT);
  if (!profile.ok) return profile;
  const profileHash = hashCanonical(profile.value);
  if (!profileHash.ok) return profileHash;
  const trustedModel = profile.value.trust.some(
    (item) =>
      item.issuer === "crypto-analyst-trader/shadow-quality/v1" &&
      item.family === "shadow-market-intelligence" &&
      item.producer === SHADOW_MARKET_INTELLIGENCE_PRODUCER &&
      item.schemaVersion === SHADOW_MARKET_INTELLIGENCE_SCHEMA_VERSION &&
      item.modelVersion === SHADOW_MARKET_INTELLIGENCE_MODEL_VERSION,
  );
  const claimedModelIsTrusted =
    trustedModel &&
    shadow.producer === SHADOW_MARKET_INTELLIGENCE_PRODUCER &&
    shadow.schemaVersion === SHADOW_MARKET_INTELLIGENCE_SCHEMA_VERSION &&
    shadow.modelVersion === SHADOW_MARKET_INTELLIGENCE_MODEL_VERSION &&
    shadow.profileVersion === SHADOW_MARKET_INTELLIGENCE_PROFILE_VERSION;

  const replay = createShadowMarketIntelligence({
    market: rawInput.market,
    analytics: rawInput.analytics,
    ...(rawInput.liquidation === undefined
      ? {}
      : { liquidation: rawInput.liquidation }),
    symbol: shadow.symbol,
    evaluationTime: evaluationTime.value,
  });
  if (!replay.ok) return replay;
  const suppliedHash = hashCanonical(shadow);
  const replayHash = hashCanonical(replay.value);
  if (!suppliedHash.ok) return suppliedHash;
  if (!replayHash.ok) return replayHash;
  const replayMatches =
    shadow.contentHash === replay.value.contentHash &&
    suppliedHash.value === replayHash.value &&
    shadow.evaluationTime === evaluationTime.value &&
    shadow.runId === replay.value.runId &&
    shadow.universeVersion === replay.value.universeVersion &&
    shadow.symbol === replay.value.symbol &&
    shadow.cutoff === replay.value.cutoff &&
    shadow.asOf === replay.value.asOf;

  const records = makeSourceRecords({
    market: rawInput.market,
    analytics: rawInput.analytics,
    ...(rawInput.liquidation === undefined
      ? {}
      : { liquidation: rawInput.liquidation }),
    expected: replay.value,
    profileAgeMs: SHADOW_MARKET_INTELLIGENCE_MAX_SOURCE_AGE_MS,
  });
  if (!records.ok) return records;
  const findings = classifyQualityEvidence(
    records.value,
    profile.value,
    parsedCutoff.value,
    evaluationTime.value,
  );
  if (
    Date.parse(evaluationTime.value) >=
    Date.parse(replay.value.asOf) + replay.value.validForMs
  ) {
    for (const role of ["market", "analytics"] as const)
      findings.push({ role, reasonCode: "STALE_EVIDENCE", blocking: true });
    if (rawInput.liquidation !== undefined)
      findings.push({
        role: "liquidation",
        reasonCode: "STALE_EVIDENCE",
        blocking: true,
      });
  }
  const failures = sourceFailures(records.value, findings);
  for (const reason of failures.get("market") ?? []) {
    failures.get("analytics")?.add(reason);
    if (rawInput.liquidation !== undefined)
      failures.get("liquidation")?.add(reason);
  }
  const globalReasons: ShadowQualityReasonCode[] = [];
  if (!claimedModelIsTrusted) globalReasons.push("UNTRUSTED_EVIDENCE");
  if (!replayMatches) globalReasons.push("SHADOW_REPLAY_MISMATCH");

  const marketRecord = records.value.find((item) => item.role === "market");
  const marketSource = marketRecord?.value as MarketEvidenceBundle | undefined;
  const ticker = marketSource?.symbols.find(
    (item) => item.symbol === replay.value.symbol,
  )?.ticker;
  const dispositions = parsedRows.value.map((row) => {
    const reasons = new Set<ShadowQualityReasonCode>(globalReasons);
    let sourceRole: "market" | "analytics" | undefined;
    if (
      row.sourceId === replay.value.sourceManifest.market.sourceId &&
      row.sourceHash === replay.value.sourceManifest.market.bundleHash
    )
      sourceRole = "market";
    else if (
      row.sourceId === replay.value.sourceManifest.analytics.sourceId &&
      row.sourceHash === replay.value.sourceManifest.analytics.bundleHash
    )
      sourceRole = "analytics";
    else reasons.add("SOURCE_REFERENCE_MISMATCH");

    if (sourceRole !== undefined)
      for (const reason of failures.get(sourceRole) ?? []) reasons.add(reason);
    if (LIQUIDATION_OBSERVATION_IDS.has(row.id)) {
      const liquidationFailures = failures.get("liquidation");
      if (rawInput.liquidation === undefined) reasons.add("MISSING_EVIDENCE");
      for (const reason of liquidationFailures ?? []) reasons.add(reason);
    }
    if (TICKER_OBSERVATION_IDS.has(row.id)) {
      if (ticker === undefined) reasons.add("MISSING_EVIDENCE");
      else if (Date.parse(ticker.observedAt) > Date.parse(evaluationTime.value))
        reasons.add("FUTURE_INFORMATION");
      else if (
        Date.parse(evaluationTime.value) >=
        Date.parse(ticker.observedAt) +
          SHADOW_MARKET_INTELLIGENCE_MAX_SOURCE_AGE_MS
      )
        reasons.add("STALE_EVIDENCE");
    }
    const reasonCodes = sortedUnique([...reasons]);
    return {
      observationId: row.id,
      ...(sourceRole === undefined ? {} : { sourceRole }),
      sourceId: row.sourceId,
      sourceHash: row.sourceHash,
      disposition: reasonCodes.length === 0 ? "accepted" : "rejected",
      reasonCodes,
    } as const;
  });

  const outcomes = replay.value.families;
  const familyResults = familyDispositions(outcomes, dispositions);
  const reportFindings = mapQualityFindings(findings);
  if (!claimedModelIsTrusted)
    reportFindings.push({ role: "shadow", reasonCode: "UNTRUSTED_EVIDENCE" });
  if (!replayMatches)
    reportFindings.push({
      role: "shadow",
      reasonCode: "SHADOW_REPLAY_MISMATCH",
    });
  const uniqueFindings = new Map(
    reportFindings.map((item) => [`${item.role}\0${item.reasonCode}`, item]),
  );
  const normalizedFindings = [...uniqueFindings.values()].sort(
    (left, right) =>
      compareText(left.role, right.role) ||
      compareText(left.reasonCode, right.reasonCode),
  );
  const sourceResults = sourceDispositions(records.value, findings, failures);
  const shadowContentHash = requireHash(
    shadow.contentHash,
    "shadow.contentHash",
  );
  if (!shadowContentHash.ok) return shadowContentHash;
  const payload: AssessmentPayload = {
    schemaVersion: SHADOW_QUALITY_ASSESSMENT_SCHEMA_VERSION,
    producer: SHADOW_QUALITY_ASSESSMENT_PRODUCER,
    profileVersion: SHADOW_QUALITY_PROFILE_VERSION,
    profileHash: profileHash.value,
    trustedModel: {
      producer: SHADOW_MARKET_INTELLIGENCE_PRODUCER,
      schemaVersion: SHADOW_MARKET_INTELLIGENCE_SCHEMA_VERSION,
      modelVersion: SHADOW_MARKET_INTELLIGENCE_MODEL_VERSION,
    },
    shadowContentHash: shadowContentHash.value as PlanHash,
    asOf: replay.value.asOf,
    validForMs: replay.value.validForMs,
    evaluationTime: evaluationTime.value,
    status: assessmentStatus(dispositions, [
      ...globalReasons,
      ...[...failures.values()].flatMap((codes) => [...codes]),
    ]),
    sourceDispositions: deepFreeze(sourceResults),
    observationDispositions: deepFreeze(dispositions),
    familyDispositions: deepFreeze(familyResults),
    findings: deepFreeze(normalizedFindings),
  };
  const contentHash = hashCanonical(payload);
  if (!contentHash.ok) return contentHash;
  return ok(deepFreeze({ ...payload, contentHash: contentHash.value }));
}
