import type { AnalyticsInputIdentity } from "./analytics-inputs.js";
import type { AnalyticsOutputOutcome } from "./analytics-sufficiency.js";
import {
  compareAnalyticsText,
  type AnalyticsReasonCode,
} from "./analytics-diagnostics.js";
import { type ExternalEvidenceFamily as ProfileExternalEvidenceFamily } from "./analytics-profile.js";
import { domainError } from "../shared/errors.js";
import {
  DecimalValue,
  isDecimalValue,
  type DecimalValue as Decimal,
} from "../shared/decimal.js";
import { isEvidenceKind } from "../evidence/evidence-ref.js";
import { fail, ok, type Result } from "../shared/result.js";
import type { EvidenceKind } from "../evidence/evidence-ref.js";
import {
  hashCanonical,
  type PlanHash,
} from "../identity/canonical-serialization.js";
import {
  isRecord,
  requireFiniteInteger,
  requireHash,
  requireSafeText,
} from "../shared/validation.js";
import { parseUtcTimestamp, type UtcTimestamp } from "../shared/time.js";
import {
  MARKET_EVIDENCE_PRODUCER,
  MARKET_EVIDENCE_SCHEMA_VERSION,
} from "../market/market-evidence-bundle.js";
import {
  LIQUIDATION_EVIDENCE_PRODUCER,
  LIQUIDATION_EVIDENCE_SCHEMA_VERSION,
} from "../liquidation/liquidation-evidence-bundle.js";
import { analyticsDecimalConstant } from "./analytics-numeric-policy.js";
import { onlyKeys } from "./analytics-validation.js";

export const EXTERNAL_EVIDENCE_SCHEMA_VERSIONS = Object.freeze({
  "market-regime-score": "market-regime-score/v1",
  "early-warning-risk": "early-warning-risk/v1",
  "liquidity-stress": "liquidity-stress/v1",
  trap: "trap-evidence/v1",
} as const satisfies Readonly<Record<ProfileExternalEvidenceFamily, string>>);

export const EXTERNAL_EVIDENCE_MODEL_VERSIONS = Object.freeze({
  "market-regime-score": "mreg-v1",
  "early-warning-risk": "ewr-v1",
  "liquidity-stress": "lsi-v1",
  trap: "trap-v1",
} as const satisfies Readonly<Record<ProfileExternalEvidenceFamily, string>>);

export const HISTORICAL_CEWS_MIGRATION = Object.freeze({
  family: "cews",
  schemaVersion: "cews/v1",
  modelVersion: "cews/2026-06-07-warning-0-100",
  direction: "higher-is-warning",
  migrationId: "cews-2026-06-07-warning-0-100-to-ewr-v1",
} as const);

export type ExternalEvidenceFamily = ProfileExternalEvidenceFamily;
export type ExternalScoreFamily = Exclude<ExternalEvidenceFamily, "trap">;
export type TrapScenario = "continuation" | "reversal" | "squeeze" | "range";

export interface ExternalInputRunContext {
  readonly runId: string;
  readonly universeVersion: string;
  readonly bundleCutoff: UtcTimestamp;
}

export interface ExternalInputEvidenceRef {
  readonly kind: EvidenceKind;
  readonly schemaVersion: string;
  readonly producer: string;
  readonly sourceId: string;
  readonly contentHash: string;
  readonly runContext?: ExternalInputRunContext;
}

export interface ExternalEvidenceProvenance {
  readonly producer: string;
  readonly sourceId: string;
  readonly modelName: string;
  readonly migration?: {
    readonly migrationId: typeof HISTORICAL_CEWS_MIGRATION.migrationId;
    readonly sourceFamily: typeof HISTORICAL_CEWS_MIGRATION.family;
    readonly sourceSchemaVersion: typeof HISTORICAL_CEWS_MIGRATION.schemaVersion;
    readonly sourceModelVersion: typeof HISTORICAL_CEWS_MIGRATION.modelVersion;
    readonly sourceContentHash: string;
  };
}

interface ExternalEvidenceBase {
  readonly schemaVersion: string;
  readonly modelVersion: string;
  readonly provenance: ExternalEvidenceProvenance;
  readonly inputManifestHash: string;
  readonly inputEvidenceRefs: readonly ExternalInputEvidenceRef[];
  readonly marketEvidenceHash?: string;
  readonly liquidationEvidenceHash?: string;
  readonly asOf: UtcTimestamp;
  readonly validForMs: number;
  readonly generatedAt?: UtcTimestamp;
  readonly contentHash: string;
}

interface ScoreDirection {
  readonly "market-regime-score": "higher-is-healthier";
  readonly "early-warning-risk": "higher-is-warning";
  readonly "liquidity-stress": "higher-is-stress";
}

export type ExternalScoreEvidence = {
  [Family in ExternalScoreFamily]: ExternalEvidenceBase & {
    readonly family: Family;
    readonly direction: ScoreDirection[Family];
    readonly score: Decimal;
    readonly confidence: Decimal;
  };
}[ExternalScoreFamily];

export interface TrapEvidence extends ExternalEvidenceBase {
  readonly family: "trap";
  readonly trapType: string;
  readonly reasons: readonly string[];
  readonly subscores?: Readonly<Record<string, Decimal>>;
  readonly scenarioLikelihoods: Readonly<Record<TrapScenario, Decimal>>;
  readonly horizon: string;
  readonly confirmationSignals: readonly string[];
  readonly invalidationSignals: readonly string[];
  readonly confidence: Decimal;
}

export type ExternalRegimeEvidence = ExternalScoreEvidence | TrapEvidence;

export interface ExternalEvidenceValidation extends AnalyticsOutputOutcome {
  readonly family: ExternalEvidenceFamily;
  readonly evidence?: ExternalRegimeEvidence;
}

interface ScoreContract {
  readonly schemaVersion: string;
  readonly modelVersion: string;
  readonly direction: string;
}

type Check<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: AnalyticsReasonCode };

interface CanonicalManifest {
  readonly inputManifestHash: PlanHash;
  readonly inputEvidenceRefs: readonly ExternalInputEvidenceRef[];
  readonly marketEvidenceHash?: string;
  readonly liquidationEvidenceHash?: string;
}

interface CommonFields extends CanonicalManifest {
  readonly provenance: ExternalEvidenceProvenance;
  readonly asOf: UtcTimestamp;
  readonly validForMs: number;
  readonly generatedAt?: UtcTimestamp;
}

const SCORE_CONTRACTS: Readonly<Record<ExternalScoreFamily, ScoreContract>> =
  Object.freeze({
    "market-regime-score": {
      schemaVersion: EXTERNAL_EVIDENCE_SCHEMA_VERSIONS["market-regime-score"],
      modelVersion: EXTERNAL_EVIDENCE_MODEL_VERSIONS["market-regime-score"],
      direction: "higher-is-healthier",
    },
    "early-warning-risk": {
      schemaVersion: EXTERNAL_EVIDENCE_SCHEMA_VERSIONS["early-warning-risk"],
      modelVersion: EXTERNAL_EVIDENCE_MODEL_VERSIONS["early-warning-risk"],
      direction: "higher-is-warning",
    },
    "liquidity-stress": {
      schemaVersion: EXTERNAL_EVIDENCE_SCHEMA_VERSIONS["liquidity-stress"],
      modelVersion: EXTERNAL_EVIDENCE_MODEL_VERSIONS["liquidity-stress"],
      direction: "higher-is-stress",
    },
  });

const TRAP_SCENARIOS: readonly TrapScenario[] = Object.freeze([
  "continuation",
  "reversal",
  "squeeze",
  "range",
]);

const SCORE_KEYS = Object.freeze([
  "family",
  "schemaVersion",
  "modelVersion",
  "direction",
  "score",
  "confidence",
  "provenance",
  "inputManifestHash",
  "inputEvidenceRefs",
  "marketEvidenceHash",
  "liquidationEvidenceHash",
  "asOf",
  "validForMs",
  "generatedAt",
  "contentHash",
]);

const TRAP_KEYS = Object.freeze([
  "family",
  "schemaVersion",
  "modelVersion",
  "trapType",
  "reasons",
  "subscores",
  "scenarioLikelihoods",
  "horizon",
  "confirmationSignals",
  "invalidationSignals",
  "confidence",
  "provenance",
  "inputManifestHash",
  "inputEvidenceRefs",
  "marketEvidenceHash",
  "liquidationEvidenceHash",
  "asOf",
  "validForMs",
  "generatedAt",
  "contentHash",
]);

const LEGACY_CEWS_KEYS = Object.freeze([...SCORE_KEYS]);

const ZERO = analyticsDecimalConstant("0");
const ONE = analyticsDecimalConstant("1");
const ONE_HUNDRED = analyticsDecimalConstant("100");

function failed<T>(reason: AnalyticsReasonCode): Check<T> {
  return { ok: false, reason };
}

function parseRunContext(value: unknown): Check<ExternalInputRunContext> {
  if (
    !isRecord(value) ||
    !onlyKeys(value, ["runId", "universeVersion", "bundleCutoff"])
  ) {
    return failed("INPUT_IDENTITY_MISMATCH");
  }
  const runId = requireSafeText(value.runId, "runContext.runId");
  const universeVersion = requireSafeText(
    value.universeVersion,
    "runContext.universeVersion",
  );
  const bundleCutoff = parseUtcTimestamp(value.bundleCutoff);
  if (!runId.ok || !universeVersion.ok || !bundleCutoff.ok) {
    return failed("INPUT_IDENTITY_MISMATCH");
  }
  return {
    ok: true,
    value: Object.freeze({
      runId: runId.value,
      universeVersion: universeVersion.value,
      bundleCutoff: bundleCutoff.value,
    }),
  };
}

function inputReferenceKey(reference: ExternalInputEvidenceRef): string {
  const context = reference.runContext;
  return JSON.stringify([
    reference.kind,
    reference.schemaVersion,
    reference.contentHash,
    reference.producer,
    reference.sourceId,
    context?.runId,
    context?.universeVersion,
    context?.bundleCutoff,
  ]);
}

function inputReferenceIdentity(reference: ExternalInputEvidenceRef): string {
  return JSON.stringify([
    reference.kind,
    reference.schemaVersion,
    reference.contentHash,
    reference.producer,
    reference.sourceId,
  ]);
}

function parseInputReferences(
  value: unknown,
): Check<readonly ExternalInputEvidenceRef[]> {
  if (!Array.isArray(value) || value.length === 0) {
    return failed("EXTERNAL_EVIDENCE_HASH_MISMATCH");
  }
  const references: ExternalInputEvidenceRef[] = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      !onlyKeys(item, [
        "kind",
        "schemaVersion",
        "producer",
        "sourceId",
        "contentHash",
        "runContext",
      ]) ||
      !isEvidenceKind(item.kind)
    ) {
      return failed("EXTERNAL_EVIDENCE_HASH_MISMATCH");
    }
    const schemaVersion = requireSafeText(item.schemaVersion, "schemaVersion");
    const producer = requireSafeText(item.producer, "producer");
    const sourceId = requireSafeText(item.sourceId, "sourceId");
    const contentHash = requireHash(item.contentHash, "contentHash");
    const context =
      item.runContext === undefined
        ? undefined
        : parseRunContext(item.runContext);
    const isProjectBundle =
      item.kind === "market-evidence-bundle" ||
      item.kind === "liquidation-evidence-bundle";
    if (
      !schemaVersion.ok ||
      !producer.ok ||
      !sourceId.ok ||
      !contentHash.ok ||
      (context !== undefined && !context.ok) ||
      (isProjectBundle && context === undefined)
    ) {
      return failed(
        isProjectBundle
          ? "INPUT_IDENTITY_MISMATCH"
          : "EXTERNAL_EVIDENCE_HASH_MISMATCH",
      );
    }
    references.push(
      Object.freeze({
        kind: item.kind,
        schemaVersion: schemaVersion.value,
        producer: producer.value,
        sourceId: sourceId.value,
        contentHash: contentHash.value,
        ...(context?.ok === true ? { runContext: context.value } : {}),
      }),
    );
  }

  const keyedReferences = references
    .map((reference, index) => ({
      reference,
      index,
      key: inputReferenceKey(reference),
      identityKey: inputReferenceIdentity(reference),
    }))
    .sort(
      (left, right) =>
        compareAnalyticsText(left.key, right.key) || left.index - right.index,
    );
  const canonical: ExternalInputEvidenceRef[] = [];
  const seenIdentity = new Map<
    string,
    { readonly reference: ExternalInputEvidenceRef; readonly key: string }
  >();
  for (const { reference, key, identityKey } of keyedReferences) {
    const previous = seenIdentity.get(identityKey);
    if (previous !== undefined) {
      if (previous.key !== key) {
        return failed("INPUT_IDENTITY_MISMATCH");
      }
      continue;
    }
    seenIdentity.set(identityKey, { reference, key });
    canonical.push(reference);
  }
  return { ok: true, value: Object.freeze(canonical) };
}

export function normalizeExternalInputEvidenceRefs(
  inputEvidenceRefs: unknown,
): Result<readonly ExternalInputEvidenceRef[]> {
  const references = parseInputReferences(inputEvidenceRefs);
  if (!references.ok) {
    return fail(
      domainError("INVALID_EVIDENCE", "external input manifest is invalid"),
    );
  }
  return ok(references.value);
}

export function hashExternalInputManifest(
  inputEvidenceRefs: unknown,
): Result<PlanHash> {
  const references = normalizeExternalInputEvidenceRefs(inputEvidenceRefs);
  if (!references.ok) return references;
  return hashCanonical(references.value);
}

function verifyProjectInputReference(
  family: "market-evidence-bundle" | "liquidation-evidence-bundle",
  declaredHash: string | undefined,
  references: readonly ExternalInputEvidenceRef[],
  identity: AnalyticsInputIdentity,
): boolean {
  const projectReferences = references.filter(
    (reference) => reference.kind === family,
  );
  if (declaredHash === undefined) return projectReferences.length === 0;
  if (projectReferences.length !== 1) return false;

  const reference = projectReferences[0];
  const context = reference?.runContext;
  if (reference === undefined || context === undefined) return false;
  if (family === "market-evidence-bundle") {
    return (
      declaredHash === identity.marketBundleHash &&
      reference.schemaVersion === MARKET_EVIDENCE_SCHEMA_VERSION &&
      reference.producer === MARKET_EVIDENCE_PRODUCER &&
      reference.sourceId === identity.runId &&
      reference.contentHash === identity.marketBundleHash &&
      context.runId === identity.runId &&
      context.universeVersion === identity.universeVersion &&
      context.bundleCutoff === identity.bundleCutoff
    );
  }
  return (
    identity.liquidationBundleHash !== undefined &&
    identity.liquidationRunId !== undefined &&
    identity.liquidationUniverseVersion !== undefined &&
    identity.liquidationBundleCutoff !== undefined &&
    declaredHash === identity.liquidationBundleHash &&
    reference.schemaVersion ===
      (identity.liquidationEvidenceSchemaVersion ??
        LIQUIDATION_EVIDENCE_SCHEMA_VERSION) &&
    reference.producer === LIQUIDATION_EVIDENCE_PRODUCER &&
    reference.sourceId === identity.liquidationRunId &&
    reference.contentHash === identity.liquidationBundleHash &&
    context.runId === identity.liquidationRunId &&
    context.universeVersion === identity.liquidationUniverseVersion &&
    context.bundleCutoff === identity.liquidationBundleCutoff
  );
}

function parseProvenance(
  value: unknown,
  family: ExternalEvidenceFamily,
): Check<ExternalEvidenceProvenance> {
  if (
    !isRecord(value) ||
    !onlyKeys(value, ["producer", "sourceId", "modelName", "migration"])
  ) {
    return failed(
      family === "trap" ? "INVALID_TRAP_EVIDENCE" : "INVALID_EXTERNAL_SCORE",
    );
  }
  const producer = requireSafeText(value.producer, "provenance.producer");
  const sourceId = requireSafeText(value.sourceId, "provenance.sourceId");
  const modelName = requireSafeText(value.modelName, "provenance.modelName");
  if (!producer.ok || !sourceId.ok || !modelName.ok) {
    return failed(
      family === "trap" ? "INVALID_TRAP_EVIDENCE" : "INVALID_EXTERNAL_SCORE",
    );
  }
  if (value.migration === undefined) {
    return {
      ok: true,
      value: Object.freeze({
        producer: producer.value,
        sourceId: sourceId.value,
        modelName: modelName.value,
      }),
    };
  }
  const migration = value.migration;
  const sourceContentHash =
    isRecord(migration) &&
    onlyKeys(migration, [
      "migrationId",
      "sourceFamily",
      "sourceSchemaVersion",
      "sourceModelVersion",
      "sourceContentHash",
    ])
      ? requireHash(
          migration.sourceContentHash,
          "provenance.migration.sourceContentHash",
        )
      : undefined;
  if (
    family !== "early-warning-risk" ||
    !isRecord(migration) ||
    !onlyKeys(migration, [
      "migrationId",
      "sourceFamily",
      "sourceSchemaVersion",
      "sourceModelVersion",
      "sourceContentHash",
    ]) ||
    migration.migrationId !== HISTORICAL_CEWS_MIGRATION.migrationId ||
    migration.sourceFamily !== HISTORICAL_CEWS_MIGRATION.family ||
    migration.sourceSchemaVersion !== HISTORICAL_CEWS_MIGRATION.schemaVersion ||
    migration.sourceModelVersion !== HISTORICAL_CEWS_MIGRATION.modelVersion ||
    sourceContentHash?.ok !== true
  ) {
    return failed("AMBIGUOUS_CEWS_DIRECTION");
  }
  return {
    ok: true,
    value: Object.freeze({
      producer: producer.value,
      sourceId: sourceId.value,
      modelName: modelName.value,
      migration: Object.freeze({
        migrationId: HISTORICAL_CEWS_MIGRATION.migrationId,
        sourceFamily: HISTORICAL_CEWS_MIGRATION.family,
        sourceSchemaVersion: HISTORICAL_CEWS_MIGRATION.schemaVersion,
        sourceModelVersion: HISTORICAL_CEWS_MIGRATION.modelVersion,
        sourceContentHash: sourceContentHash.value,
      }),
    }),
  };
}

function parseCommonFields(
  value: Record<string, unknown>,
  family: ExternalEvidenceFamily,
  identity: AnalyticsInputIdentity,
): Check<CommonFields> {
  const provenance = parseProvenance(value.provenance, family);
  if (!provenance.ok) return provenance;

  const references = parseInputReferences(value.inputEvidenceRefs);
  if (!references.ok) return references;
  const declaredManifestHash = requireHash(
    value.inputManifestHash,
    "inputManifestHash",
  );
  const computedManifestHash = hashCanonical(references.value);
  if (
    !declaredManifestHash.ok ||
    !computedManifestHash.ok ||
    declaredManifestHash.value !== computedManifestHash.value
  ) {
    return failed("EXTERNAL_EVIDENCE_HASH_MISMATCH");
  }

  const marketEvidenceHash =
    value.marketEvidenceHash === undefined
      ? undefined
      : requireHash(value.marketEvidenceHash, "marketEvidenceHash");
  const liquidationEvidenceHash =
    value.liquidationEvidenceHash === undefined
      ? undefined
      : requireHash(value.liquidationEvidenceHash, "liquidationEvidenceHash");
  if (
    (marketEvidenceHash !== undefined && !marketEvidenceHash.ok) ||
    (liquidationEvidenceHash !== undefined && !liquidationEvidenceHash.ok)
  ) {
    return failed("INPUT_IDENTITY_MISMATCH");
  }
  const marketHash = marketEvidenceHash?.ok
    ? marketEvidenceHash.value
    : undefined;
  const liquidationHash = liquidationEvidenceHash?.ok
    ? liquidationEvidenceHash.value
    : undefined;
  if (
    !verifyProjectInputReference(
      "market-evidence-bundle",
      marketHash,
      references.value,
      identity,
    ) ||
    !verifyProjectInputReference(
      "liquidation-evidence-bundle",
      liquidationHash,
      references.value,
      identity,
    )
  ) {
    return failed("INPUT_IDENTITY_MISMATCH");
  }

  const asOf = parseUtcTimestamp(value.asOf);
  const validForMs = requireFiniteInteger(value.validForMs, "validForMs", 1);
  const generatedAt =
    value.generatedAt === undefined
      ? undefined
      : parseUtcTimestamp(value.generatedAt);
  if (
    !asOf.ok ||
    !validForMs.ok ||
    (generatedAt !== undefined && !generatedAt.ok)
  ) {
    return failed(
      family === "trap" ? "INVALID_TRAP_EVIDENCE" : "INVALID_EXTERNAL_SCORE",
    );
  }
  if (Date.parse(asOf.value) > Date.parse(identity.bundleCutoff)) {
    return failed("EXTERNAL_EVIDENCE_AFTER_CUTOFF");
  }
  if (
    generatedAt?.ok === true &&
    Date.parse(generatedAt.value) < Date.parse(asOf.value)
  ) {
    return failed(
      family === "trap" ? "INVALID_TRAP_EVIDENCE" : "INVALID_EXTERNAL_SCORE",
    );
  }
  return {
    ok: true,
    value: Object.freeze({
      provenance: provenance.value,
      inputManifestHash: computedManifestHash.value,
      inputEvidenceRefs: references.value,
      ...(marketHash === undefined ? {} : { marketEvidenceHash: marketHash }),
      ...(liquidationHash === undefined
        ? {}
        : { liquidationEvidenceHash: liquidationHash }),
      asOf: asOf.value,
      validForMs: validForMs.value,
      ...(generatedAt?.ok === true ? { generatedAt: generatedAt.value } : {}),
    }),
  };
}

function parseBoundedDecimal(
  value: unknown,
  minimum: DecimalValue,
  maximum: DecimalValue,
): DecimalValue | undefined {
  const parsed = isDecimalValue(value)
    ? { ok: true as const, value }
    : DecimalValue.fromString(value);
  if (
    !parsed.ok ||
    parsed.value.compare(minimum) < 0 ||
    parsed.value.compare(maximum) > 0
  ) {
    return undefined;
  }
  return parsed.value;
}

function payloadHashMatches(
  payload: Record<string, unknown>,
  claimedHash: unknown,
): boolean {
  const claimed = requireHash(claimedHash, "contentHash");
  const actual = hashCanonical(payload);
  return claimed.ok && actual.ok && claimed.value === actual.value;
}

function validationFailure(
  family: ExternalEvidenceFamily,
  reason: AnalyticsReasonCode,
): ExternalEvidenceValidation {
  return Object.freeze({
    requestId: `external:${family}`,
    family,
    status: "unavailable",
    reasonCodes: Object.freeze([reason]),
  });
}

function validationSuccess(
  family: ExternalEvidenceFamily,
  evidence: ExternalRegimeEvidence,
): ExternalEvidenceValidation {
  return Object.freeze({
    requestId: `external:${family}`,
    family,
    status: "complete",
    reasonCodes: Object.freeze([]),
    evidence,
  });
}

function parseScoreEvidence(
  input: Record<string, unknown>,
  family: ExternalScoreFamily,
  identity: AnalyticsInputIdentity,
): ExternalEvidenceValidation {
  const contract = SCORE_CONTRACTS[family];
  if (input.family !== family) {
    if (family === "early-warning-risk" && input.family === "cews") {
      return validationFailure(family, "AMBIGUOUS_CEWS_DIRECTION");
    }
    return validationFailure(family, "INCOMPATIBLE_SCORE_VERSION");
  }
  if (
    input.schemaVersion !== contract.schemaVersion ||
    input.modelVersion !== contract.modelVersion
  ) {
    if (
      family === "early-warning-risk" &&
      (input.modelVersion === undefined || input.direction === undefined)
    ) {
      return validationFailure(family, "AMBIGUOUS_CEWS_DIRECTION");
    }
    return validationFailure(family, "INCOMPATIBLE_SCORE_VERSION");
  }
  if (input.direction !== contract.direction) {
    return validationFailure(
      family,
      family === "early-warning-risk" && input.direction === undefined
        ? "AMBIGUOUS_CEWS_DIRECTION"
        : "SCORE_DIRECTION_MISMATCH",
    );
  }
  if (!onlyKeys(input, SCORE_KEYS)) {
    return validationFailure(family, "INCOMPATIBLE_SCORE_VERSION");
  }

  const score = parseBoundedDecimal(input.score, ZERO, ONE_HUNDRED);
  const confidence = parseBoundedDecimal(input.confidence, ZERO, ONE_HUNDRED);
  if (score === undefined || confidence === undefined) {
    return validationFailure(family, "INVALID_EXTERNAL_SCORE");
  }
  const common = parseCommonFields(input, family, identity);
  if (!common.ok) return validationFailure(family, common.reason);

  const payload = {
    family,
    schemaVersion: contract.schemaVersion,
    modelVersion: contract.modelVersion,
    direction: contract.direction,
    score,
    confidence,
    provenance: common.value.provenance,
    inputManifestHash: common.value.inputManifestHash,
    inputEvidenceRefs: common.value.inputEvidenceRefs,
    ...(common.value.marketEvidenceHash === undefined
      ? {}
      : { marketEvidenceHash: common.value.marketEvidenceHash }),
    ...(common.value.liquidationEvidenceHash === undefined
      ? {}
      : { liquidationEvidenceHash: common.value.liquidationEvidenceHash }),
    asOf: common.value.asOf,
    validForMs: common.value.validForMs,
    ...(common.value.generatedAt === undefined
      ? {}
      : { generatedAt: common.value.generatedAt }),
  };
  if (!payloadHashMatches(payload, input.contentHash)) {
    return validationFailure(family, "EXTERNAL_EVIDENCE_HASH_MISMATCH");
  }
  const evidence = {
    ...payload,
    contentHash: input.contentHash as string,
  } as ExternalScoreEvidence;
  return validationSuccess(family, Object.freeze(evidence));
}

function parseStringList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: string[] = [];
  for (const item of value) {
    const text = requireSafeText(item, "signal");
    if (!text.ok) return undefined;
    result.push(text.value);
  }
  return Object.freeze(result);
}

function parseSubscores(
  value: unknown,
): Readonly<Record<string, Decimal>> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).sort(([left], [right]) =>
    compareAnalyticsText(left, right),
  );
  if (entries.length === 0) return undefined;
  const result = Object.create(null) as Record<string, Decimal>;
  for (const [key, item] of entries) {
    const name = requireSafeText(key, "subscore.name");
    const score = parseBoundedDecimal(item, ZERO, ONE_HUNDRED);
    if (!name.ok || score === undefined) return undefined;
    result[name.value] = score;
  }
  return Object.freeze(result);
}

function parseScenarioLikelihoods(
  value: unknown,
): Readonly<Record<TrapScenario, Decimal>> | undefined {
  if (!isRecord(value) || !onlyKeys(value, TRAP_SCENARIOS)) return undefined;
  if (Object.keys(value).length !== TRAP_SCENARIOS.length) return undefined;
  const result = {} as Record<TrapScenario, Decimal>;
  for (const scenario of TRAP_SCENARIOS) {
    const likelihood = parseBoundedDecimal(value[scenario], ZERO, ONE);
    if (likelihood === undefined) return undefined;
    result[scenario] = likelihood;
  }
  return Object.freeze(result);
}

function parseTrapEvidence(
  input: Record<string, unknown>,
  identity: AnalyticsInputIdentity,
): ExternalEvidenceValidation {
  const family = "trap" as const;
  if (
    input.family !== family ||
    input.schemaVersion !== EXTERNAL_EVIDENCE_SCHEMA_VERSIONS.trap ||
    input.modelVersion !== EXTERNAL_EVIDENCE_MODEL_VERSIONS.trap ||
    !onlyKeys(input, TRAP_KEYS)
  ) {
    return validationFailure(family, "INVALID_TRAP_EVIDENCE");
  }
  const trapType = requireSafeText(input.trapType, "trapType");
  const reasons =
    input.reasons === undefined
      ? Object.freeze([])
      : parseStringList(input.reasons);
  const subscores =
    input.subscores === undefined ? undefined : parseSubscores(input.subscores);
  const scenarioLikelihoods = parseScenarioLikelihoods(
    input.scenarioLikelihoods,
  );
  const horizon = requireSafeText(input.horizon, "horizon");
  const confirmationSignals = parseStringList(input.confirmationSignals);
  const invalidationSignals = parseStringList(input.invalidationSignals);
  const confidence = parseBoundedDecimal(input.confidence, ZERO, ONE_HUNDRED);
  if (
    !trapType.ok ||
    reasons === undefined ||
    (subscores === undefined && reasons.length === 0) ||
    scenarioLikelihoods === undefined ||
    !horizon.ok ||
    confirmationSignals === undefined ||
    confirmationSignals.length === 0 ||
    invalidationSignals === undefined ||
    invalidationSignals.length === 0 ||
    confidence === undefined
  ) {
    return validationFailure(family, "INVALID_TRAP_EVIDENCE");
  }
  const common = parseCommonFields(input, family, identity);
  if (!common.ok) return validationFailure(family, common.reason);
  const payload = {
    family,
    schemaVersion: EXTERNAL_EVIDENCE_SCHEMA_VERSIONS.trap,
    modelVersion: EXTERNAL_EVIDENCE_MODEL_VERSIONS.trap,
    trapType: trapType.value,
    reasons,
    ...(subscores === undefined ? {} : { subscores }),
    scenarioLikelihoods,
    horizon: horizon.value,
    confirmationSignals,
    invalidationSignals,
    confidence,
    provenance: common.value.provenance,
    inputManifestHash: common.value.inputManifestHash,
    inputEvidenceRefs: common.value.inputEvidenceRefs,
    ...(common.value.marketEvidenceHash === undefined
      ? {}
      : { marketEvidenceHash: common.value.marketEvidenceHash }),
    ...(common.value.liquidationEvidenceHash === undefined
      ? {}
      : { liquidationEvidenceHash: common.value.liquidationEvidenceHash }),
    asOf: common.value.asOf,
    validForMs: common.value.validForMs,
    ...(common.value.generatedAt === undefined
      ? {}
      : { generatedAt: common.value.generatedAt }),
  };
  if (!payloadHashMatches(payload, input.contentHash)) {
    return validationFailure(family, "EXTERNAL_EVIDENCE_HASH_MISMATCH");
  }
  const evidence = {
    ...payload,
    contentHash: input.contentHash as string,
  } as TrapEvidence;
  return validationSuccess(family, Object.freeze(evidence));
}

export function validateExternalRegimeEvidence(
  input: unknown,
  expectedFamily: ExternalEvidenceFamily,
  inputIdentity: AnalyticsInputIdentity,
): ExternalEvidenceValidation {
  if (!isRecord(input)) {
    return validationFailure(
      expectedFamily,
      expectedFamily === "trap"
        ? "INVALID_TRAP_EVIDENCE"
        : "INCOMPATIBLE_SCORE_VERSION",
    );
  }
  if (expectedFamily === "trap") {
    return parseTrapEvidence(input, inputIdentity);
  }
  return parseScoreEvidence(input, expectedFamily, inputIdentity);
}

function legacyCewsPayloadHashMatches(
  input: Record<string, unknown>,
  payload: Record<string, unknown>,
): boolean {
  return payloadHashMatches(payload, input.contentHash);
}

export function migrateHistoricalCewsEvidence(
  input: unknown,
  inputIdentity: AnalyticsInputIdentity,
): ExternalEvidenceValidation {
  const family = "early-warning-risk" as const;
  if (!isRecord(input)) {
    return validationFailure(family, "AMBIGUOUS_CEWS_DIRECTION");
  }
  if (
    input.family !== HISTORICAL_CEWS_MIGRATION.family ||
    input.schemaVersion !== HISTORICAL_CEWS_MIGRATION.schemaVersion ||
    input.modelVersion !== HISTORICAL_CEWS_MIGRATION.modelVersion
  ) {
    return validationFailure(family, "AMBIGUOUS_CEWS_DIRECTION");
  }
  if (input.direction !== HISTORICAL_CEWS_MIGRATION.direction) {
    return validationFailure(
      family,
      input.direction === undefined
        ? "AMBIGUOUS_CEWS_DIRECTION"
        : "SCORE_DIRECTION_MISMATCH",
    );
  }
  if (!onlyKeys(input, LEGACY_CEWS_KEYS)) {
    return validationFailure(family, "AMBIGUOUS_CEWS_DIRECTION");
  }
  const score = parseBoundedDecimal(input.score, ZERO, ONE_HUNDRED);
  const confidence = parseBoundedDecimal(input.confidence, ZERO, ONE_HUNDRED);
  if (score === undefined || confidence === undefined) {
    return validationFailure(family, "INVALID_EXTERNAL_SCORE");
  }
  const common = parseCommonFields(input, family, inputIdentity);
  if (!common.ok) return validationFailure(family, common.reason);
  const originalPayload = {
    family: HISTORICAL_CEWS_MIGRATION.family,
    schemaVersion: HISTORICAL_CEWS_MIGRATION.schemaVersion,
    modelVersion: HISTORICAL_CEWS_MIGRATION.modelVersion,
    direction: HISTORICAL_CEWS_MIGRATION.direction,
    score,
    confidence,
    provenance: common.value.provenance,
    inputManifestHash: common.value.inputManifestHash,
    inputEvidenceRefs: common.value.inputEvidenceRefs,
    ...(common.value.marketEvidenceHash === undefined
      ? {}
      : { marketEvidenceHash: common.value.marketEvidenceHash }),
    ...(common.value.liquidationEvidenceHash === undefined
      ? {}
      : { liquidationEvidenceHash: common.value.liquidationEvidenceHash }),
    asOf: common.value.asOf,
    validForMs: common.value.validForMs,
    ...(common.value.generatedAt === undefined
      ? {}
      : { generatedAt: common.value.generatedAt }),
  };
  if (!legacyCewsPayloadHashMatches(input, originalPayload)) {
    return validationFailure(family, "EXTERNAL_EVIDENCE_HASH_MISMATCH");
  }
  const sourceContentHash = requireHash(input.contentHash, "contentHash");
  if (!sourceContentHash.ok) {
    return validationFailure(family, "EXTERNAL_EVIDENCE_HASH_MISMATCH");
  }
  const provenance: ExternalEvidenceProvenance = Object.freeze({
    ...common.value.provenance,
    migration: Object.freeze({
      migrationId: HISTORICAL_CEWS_MIGRATION.migrationId,
      sourceFamily: HISTORICAL_CEWS_MIGRATION.family,
      sourceSchemaVersion: HISTORICAL_CEWS_MIGRATION.schemaVersion,
      sourceModelVersion: HISTORICAL_CEWS_MIGRATION.modelVersion,
      sourceContentHash: sourceContentHash.value,
    }),
  });
  const migratedPayload = {
    family,
    schemaVersion: EXTERNAL_EVIDENCE_SCHEMA_VERSIONS[family],
    modelVersion: EXTERNAL_EVIDENCE_MODEL_VERSIONS[family],
    direction: "higher-is-warning" as const,
    score,
    confidence,
    provenance,
    inputManifestHash: common.value.inputManifestHash,
    inputEvidenceRefs: common.value.inputEvidenceRefs,
    ...(common.value.marketEvidenceHash === undefined
      ? {}
      : { marketEvidenceHash: common.value.marketEvidenceHash }),
    ...(common.value.liquidationEvidenceHash === undefined
      ? {}
      : { liquidationEvidenceHash: common.value.liquidationEvidenceHash }),
    asOf: common.value.asOf,
    validForMs: common.value.validForMs,
    ...(common.value.generatedAt === undefined
      ? {}
      : { generatedAt: common.value.generatedAt }),
  };
  const contentHash = hashCanonical(migratedPayload);
  if (!contentHash.ok) {
    return validationFailure(family, "EXTERNAL_EVIDENCE_HASH_MISMATCH");
  }
  return validateExternalRegimeEvidence(
    { ...migratedPayload, contentHash: contentHash.value },
    family,
    inputIdentity,
  );
}
