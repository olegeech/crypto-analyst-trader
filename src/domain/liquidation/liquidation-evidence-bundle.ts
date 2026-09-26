import {
  createEvidenceRef,
  type EvidenceRef,
} from "../evidence/evidence-ref.js";
import { DecimalValue, isDecimalValue } from "../shared/decimal.js";
import { domainError } from "../shared/errors.js";
import { fail, ok, type Result } from "../shared/result.js";
import { parseUtcTimestamp, type UtcTimestamp } from "../shared/time.js";
import {
  isRecord,
  requireFiniteInteger,
  requireHash,
  requireIdentifier,
  requireSafeText,
} from "../shared/validation.js";
import {
  parseLiquidationEvidenceDiagnostics,
  type LiquidationEvidenceDiagnostic,
  type LiquidationEvidenceDiagnosticInput,
} from "./liquidation-evidence-diagnostics.js";
import {
  deriveLiquidationWindows,
  LIQUIDATION_HISTORY_BUCKETS,
  LIQUIDATION_HOUR_MS,
  type LiquidationHourlyAggregate,
  type LiquidationWindowEvidence,
} from "./liquidation-evidence-windows.js";

export {
  createLiquidationEvidenceDiagnostic,
  type LiquidationEvidenceDiagnostic,
  type LiquidationEvidenceDiagnosticCode,
  type LiquidationEvidenceDiagnosticInput,
  type LiquidationEvidenceOperation,
} from "./liquidation-evidence-diagnostics.js";
export {
  LIQUIDATION_HISTORY_BUCKETS,
  LIQUIDATION_HOUR_MS,
  LIQUIDATION_WINDOW_HOURS,
  type LiquidationHourlyAggregate,
  type LiquidationWindowEvidence,
  type LiquidationWindowHours,
} from "./liquidation-evidence-windows.js";

export const LIQUIDATION_EVIDENCE_SCHEMA_VERSION =
  "liquidation-evidence/v1" as const;
export const LIQUIDATION_EVIDENCE_PRODUCER =
  "crypto-analyst-trader/coinalyze-liquidation" as const;
export const LIQUIDATION_EVIDENCE_POLICY_VERSION =
  "liquidation-market-aggregate/v1" as const;
export const LIQUIDATION_EVIDENCE_ASSETS = Object.freeze([
  "BTC",
  "ETH",
  "SOL",
  "DOGE",
] as const);

export type LiquidationTargetAsset =
  (typeof LIQUIDATION_EVIDENCE_ASSETS)[number];
export type LiquidationProofStatus = "complete" | "incomplete";
export type LiquidationEvidenceStatus = "complete" | "incomplete" | "failed";

export interface LiquidationMarketEvidenceIdentity {
  readonly runId: string;
  readonly universeVersion: string;
  readonly bundleCutoff: UtcTimestamp;
  readonly contentHash: string;
}

export interface LiquidationObservation {
  readonly timestamp: UtcTimestamp;
  readonly longUsd: DecimalValue;
  readonly shortUsd: DecimalValue;
}

export interface LiquidationConstituentEvidence {
  readonly providerSymbol: string;
  readonly exchange: string;
  readonly symbolOnExchange: string;
  readonly baseAsset: LiquidationTargetAsset;
  readonly quoteAsset: string;
  readonly isPerpetual: true;
  readonly marginType: string;
  readonly expireAt: number;
  readonly notionalDenominatedIn: string;
  readonly observations: readonly LiquidationObservation[];
}

export interface LiquidationTargetEvidence {
  readonly asset: LiquidationTargetAsset;
  readonly constituents: readonly LiquidationConstituentEvidence[];
  readonly hourlyAggregates: readonly LiquidationHourlyAggregate[];
  readonly windows: readonly LiquidationWindowEvidence[];
}

export interface LiquidationEvidenceBundle {
  readonly runId: string;
  readonly schemaVersion: typeof LIQUIDATION_EVIDENCE_SCHEMA_VERSION;
  readonly producer: string;
  readonly provider: "coinalyze";
  readonly policyVersion: typeof LIQUIDATION_EVIDENCE_POLICY_VERSION;
  readonly collectionStartedAt: UtcTimestamp;
  readonly collectionEndedAt: UtcTimestamp;
  readonly bundleCutoff: UtcTimestamp;
  readonly marketEvidence: LiquidationMarketEvidenceIdentity;
  readonly coverageProof: LiquidationProofStatus;
  readonly historyProof: LiquidationProofStatus;
  readonly status: LiquidationEvidenceStatus;
  readonly targets: readonly LiquidationTargetEvidence[];
  readonly diagnostics: readonly LiquidationEvidenceDiagnostic[];
}

export interface LiquidationObservationInput {
  readonly timestamp: string;
  readonly longUsd: string;
  readonly shortUsd: string;
}

export interface LiquidationConstituentInput {
  readonly providerSymbol: string;
  readonly exchange: string;
  readonly symbolOnExchange: string;
  readonly baseAsset: LiquidationTargetAsset;
  readonly quoteAsset: string;
  readonly isPerpetual: true;
  readonly marginType: string;
  readonly expireAt: number;
  readonly notionalDenominatedIn: string;
  readonly observations: readonly LiquidationObservationInput[];
}

export interface LiquidationTargetInput {
  readonly asset: LiquidationTargetAsset;
  readonly constituents: readonly LiquidationConstituentInput[];
}

export interface LiquidationEvidenceBundleInput {
  readonly runId: string;
  readonly schemaVersion: typeof LIQUIDATION_EVIDENCE_SCHEMA_VERSION;
  readonly producer: string;
  readonly provider: "coinalyze";
  readonly policyVersion: typeof LIQUIDATION_EVIDENCE_POLICY_VERSION;
  readonly collectionStartedAt: string;
  readonly collectionEndedAt: string;
  readonly bundleCutoff: string;
  readonly marketEvidence: {
    readonly runId: string;
    readonly universeVersion: string;
    readonly bundleCutoff: string;
    readonly contentHash: string;
  };
  readonly coverageProof: LiquidationProofStatus;
  readonly historyProof: LiquidationProofStatus;
  readonly status: LiquidationEvidenceStatus;
  readonly targets: readonly LiquidationTargetInput[];
  readonly diagnostics: readonly LiquidationEvidenceDiagnosticInput[];
}

type ProofStatusInput = LiquidationProofStatus;

function invalid(message: string, field?: string): Result<never> {
  return fail(
    domainError(
      "INVALID_VALUE",
      message,
      field === undefined ? undefined : { field },
    ),
  );
}

function timestamp(value: unknown, field: string): Result<UtcTimestamp> {
  const parsed = parseUtcTimestamp(value);
  return parsed.ok
    ? parsed
    : fail(domainError("INVALID_TIMESTAMP", `${field} is invalid`, { field }));
}

function decimal(value: unknown, field: string): Result<DecimalValue> {
  const parsed = isDecimalValue(value)
    ? ok(value)
    : DecimalValue.fromString(value);
  if (!parsed.ok) return parsed;
  if (parsed.value.isNegative()) {
    return fail(
      domainError("INVALID_VALUE", `${field} must be non-negative`, { field }),
    );
  }
  return parsed;
}

function isTargetAsset(value: unknown): value is LiquidationTargetAsset {
  return (
    typeof value === "string" &&
    LIQUIDATION_EVIDENCE_ASSETS.some((asset) => asset === value)
  );
}

function parseMarketEvidenceIdentity(
  value: unknown,
  runId: string,
  bundleCutoff: UtcTimestamp,
): Result<LiquidationMarketEvidenceIdentity> {
  if (!isRecord(value))
    return invalid("market evidence identity must be an object");
  const identityRunId = requireIdentifier(value.runId, "marketEvidence.runId");
  const universeVersion = requireSafeText(
    value.universeVersion,
    "marketEvidence.universeVersion",
  );
  const identityCutoff = timestamp(
    value.bundleCutoff,
    "marketEvidence.bundleCutoff",
  );
  const contentHash = requireHash(
    value.contentHash,
    "marketEvidence.contentHash",
  );
  if (
    !identityRunId.ok ||
    !universeVersion.ok ||
    !identityCutoff.ok ||
    !contentHash.ok ||
    identityRunId.value !== runId ||
    identityCutoff.value !== bundleCutoff
  ) {
    return invalid(
      "market evidence identity is incompatible with liquidation run",
    );
  }
  return ok(
    Object.freeze({
      runId: identityRunId.value,
      universeVersion: universeVersion.value,
      bundleCutoff: identityCutoff.value,
      contentHash: contentHash.value,
    }),
  );
}

function historyBounds(bundleCutoff: UtcTimestamp): {
  readonly oldestBucket: number;
  readonly latestClosedBucket: number;
} {
  const latestClosedBucket =
    Math.floor(Date.parse(bundleCutoff) / LIQUIDATION_HOUR_MS) *
      LIQUIDATION_HOUR_MS -
    LIQUIDATION_HOUR_MS;
  return {
    oldestBucket:
      latestClosedBucket -
      (LIQUIDATION_HISTORY_BUCKETS - 1) * LIQUIDATION_HOUR_MS,
    latestClosedBucket,
  };
}

function parseConstituent(
  value: unknown,
  asset: LiquidationTargetAsset,
  bundleCutoff: UtcTimestamp,
): Result<LiquidationConstituentEvidence> {
  if (!isRecord(value))
    return invalid("liquidation constituent must be an object");
  const providerSymbol = requireSafeText(
    value.providerSymbol,
    "providerSymbol",
  );
  const exchange = requireSafeText(value.exchange, "exchange");
  const symbolOnExchange = requireSafeText(
    value.symbolOnExchange,
    "symbolOnExchange",
  );
  const quoteAsset = requireSafeText(value.quoteAsset, "quoteAsset");
  const marginType = requireSafeText(value.marginType, "marginType");
  const expireAt = requireFiniteInteger(value.expireAt, "expireAt");
  const notionalDenominatedIn = requireSafeText(
    value.notionalDenominatedIn,
    "notionalDenominatedIn",
  );
  if (
    !providerSymbol.ok ||
    !exchange.ok ||
    !symbolOnExchange.ok ||
    !quoteAsset.ok ||
    !marginType.ok ||
    !expireAt.ok ||
    !notionalDenominatedIn.ok ||
    value.baseAsset !== asset ||
    !isTargetAsset(value.baseAsset) ||
    value.isPerpetual !== true ||
    !Array.isArray(value.observations)
  ) {
    return invalid("liquidation constituent identity is invalid");
  }

  const bounds = historyBounds(bundleCutoff);
  const observations: LiquidationObservation[] = [];
  const seenTimestamps = new Set<string>();
  for (const item of value.observations) {
    if (!isRecord(item))
      return invalid("liquidation observation must be an object");
    const observedAt = timestamp(item.timestamp, "observation.timestamp");
    const longUsd = decimal(item.longUsd, "observation.longUsd");
    const shortUsd = decimal(item.shortUsd, "observation.shortUsd");
    if (!observedAt.ok || !longUsd.ok || !shortUsd.ok) {
      return invalid("liquidation observation contains an invalid field");
    }
    const epoch = Date.parse(observedAt.value);
    if (
      epoch % LIQUIDATION_HOUR_MS !== 0 ||
      epoch < bounds.oldestBucket ||
      epoch > bounds.latestClosedBucket
    ) {
      return invalid(
        "liquidation observation is outside the closed cutoff window",
      );
    }
    if (seenTimestamps.has(observedAt.value)) {
      return invalid("liquidation constituent contains a duplicate bucket");
    }
    seenTimestamps.add(observedAt.value);
    observations.push(
      Object.freeze({
        timestamp: observedAt.value,
        longUsd: longUsd.value,
        shortUsd: shortUsd.value,
      }),
    );
  }
  observations.sort(
    (left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp),
  );

  return ok(
    Object.freeze({
      providerSymbol: providerSymbol.value,
      exchange: exchange.value,
      symbolOnExchange: symbolOnExchange.value,
      baseAsset: asset,
      quoteAsset: quoteAsset.value,
      isPerpetual: true,
      marginType: marginType.value,
      expireAt: expireAt.value,
      notionalDenominatedIn: notionalDenominatedIn.value,
      observations: Object.freeze(observations),
    }),
  );
}

function sameDerivedDecimal(value: unknown, expected: DecimalValue): boolean {
  const parsed = decimal(value, "derivedDecimal");
  return parsed.ok && parsed.value.compare(expected) === 0;
}

function validateStoredHourlyAggregates(
  value: unknown,
  expected: readonly LiquidationHourlyAggregate[],
): Result<void> {
  if (value === undefined) return ok(undefined);
  if (!Array.isArray(value) || value.length !== expected.length) {
    return invalid(
      "stored hourly liquidation aggregate does not match source facts",
    );
  }
  for (let index = 0; index < expected.length; index += 1) {
    const stored = value[index];
    const derived = expected[index];
    if (!isRecord(stored) || derived === undefined) {
      return invalid("stored hourly liquidation aggregate is invalid");
    }
    const storedTimestamp = timestamp(stored.timestamp, "aggregate.timestamp");
    if (
      !storedTimestamp.ok ||
      storedTimestamp.value !== derived.timestamp ||
      !sameDerivedDecimal(stored.longUsd, derived.longUsd) ||
      !sameDerivedDecimal(stored.shortUsd, derived.shortUsd) ||
      !sameDerivedDecimal(stored.totalUsd, derived.totalUsd) ||
      stored.observedConstituents !== derived.observedConstituents ||
      stored.expectedConstituents !== derived.expectedConstituents ||
      stored.complete !== derived.complete
    ) {
      return invalid(
        "stored hourly liquidation aggregate does not match source facts",
      );
    }
  }
  return ok(undefined);
}

function validateStoredWindows(
  value: unknown,
  expected: readonly LiquidationWindowEvidence[],
): Result<void> {
  if (value === undefined) return ok(undefined);
  if (!Array.isArray(value) || value.length !== expected.length) {
    return invalid("stored liquidation windows do not match source facts");
  }
  for (let index = 0; index < expected.length; index += 1) {
    const stored = value[index];
    const derived = expected[index];
    if (!isRecord(stored) || derived === undefined) {
      return invalid("stored liquidation window is invalid");
    }
    const from = timestamp(stored.from, "window.from");
    const to = timestamp(stored.to, "window.to");
    if (
      !from.ok ||
      !to.ok ||
      stored.hours !== derived.hours ||
      from.value !== derived.from ||
      to.value !== derived.to ||
      !sameDerivedDecimal(stored.longUsd, derived.longUsd) ||
      !sameDerivedDecimal(stored.shortUsd, derived.shortUsd) ||
      !sameDerivedDecimal(stored.totalUsd, derived.totalUsd) ||
      stored.observedConstituentBuckets !==
        derived.observedConstituentBuckets ||
      stored.expectedConstituentBuckets !==
        derived.expectedConstituentBuckets ||
      stored.complete !== derived.complete
    ) {
      return invalid("stored liquidation window does not match source facts");
    }
  }
  return ok(undefined);
}

function parseTarget(
  value: unknown,
  bundleCutoff: UtcTimestamp,
): Result<LiquidationTargetEvidence> {
  if (!isRecord(value) || !isTargetAsset(value.asset)) {
    return invalid("liquidation target asset is invalid");
  }
  if (!Array.isArray(value.constituents)) {
    return invalid("liquidation target constituents must be an array");
  }
  const constituents: LiquidationConstituentEvidence[] = [];
  for (const item of value.constituents) {
    const parsed = parseConstituent(item, value.asset, bundleCutoff);
    if (!parsed.ok) return parsed;
    constituents.push(parsed.value);
  }
  constituents.sort((left, right) =>
    left.providerSymbol.localeCompare(right.providerSymbol),
  );
  const derived = deriveLiquidationWindows(constituents, bundleCutoff);
  const storedAggregates = validateStoredHourlyAggregates(
    value.hourlyAggregates,
    derived.hourlyAggregates,
  );
  const storedWindows = validateStoredWindows(value.windows, derived.windows);
  if (!storedAggregates.ok) return storedAggregates;
  if (!storedWindows.ok) return storedWindows;
  return ok(
    Object.freeze({
      asset: value.asset,
      constituents: Object.freeze(constituents),
      hourlyAggregates: derived.hourlyAggregates,
      windows: derived.windows,
    }),
  );
}

function hasFullHistory(
  constituent: LiquidationConstituentEvidence,
  bundleCutoff: UtcTimestamp,
): boolean {
  if (constituent.observations.length !== LIQUIDATION_HISTORY_BUCKETS)
    return false;
  const bounds = historyBounds(bundleCutoff);
  return constituent.observations.every(
    (observation, index) =>
      Date.parse(observation.timestamp) ===
      bounds.oldestBucket + index * LIQUIDATION_HOUR_MS,
  );
}

function targetAssetsHaveFullHistory(
  targets: readonly LiquidationTargetEvidence[],
  bundleCutoff: UtcTimestamp,
): boolean {
  return targets.every(
    (target) =>
      target.constituents.length > 0 &&
      target.constituents.every((constituent) =>
        hasFullHistory(constituent, bundleCutoff),
      ),
  );
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (
    typeof value !== "object" ||
    value === null ||
    isDecimalValue(value) ||
    seen.has(value)
  ) {
    return value;
  }
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

export function createLiquidationEvidenceBundle(
  input: unknown,
): Result<LiquidationEvidenceBundle> {
  if (!isRecord(input))
    return invalid("liquidation evidence bundle must be an object");
  const runId = requireIdentifier(input.runId, "runId");
  const producer = requireSafeText(input.producer, "producer");
  const collectionStartedAt = timestamp(
    input.collectionStartedAt,
    "collectionStartedAt",
  );
  const collectionEndedAt = timestamp(
    input.collectionEndedAt,
    "collectionEndedAt",
  );
  const bundleCutoff = timestamp(input.bundleCutoff, "bundleCutoff");
  const diagnostics = parseLiquidationEvidenceDiagnostics(input.diagnostics);
  if (
    input.schemaVersion !== LIQUIDATION_EVIDENCE_SCHEMA_VERSION ||
    input.provider !== "coinalyze" ||
    input.policyVersion !== LIQUIDATION_EVIDENCE_POLICY_VERSION ||
    !runId.ok ||
    !producer.ok ||
    !collectionStartedAt.ok ||
    !collectionEndedAt.ok ||
    !bundleCutoff.ok ||
    !diagnostics.ok ||
    !Array.isArray(input.targets) ||
    (input.coverageProof !== "complete" &&
      input.coverageProof !== "incomplete") ||
    (input.historyProof !== "complete" &&
      input.historyProof !== "incomplete") ||
    (input.status !== "complete" &&
      input.status !== "incomplete" &&
      input.status !== "failed")
  ) {
    return invalid("liquidation evidence identity or status is invalid");
  }
  if (
    Date.parse(collectionEndedAt.value) < Date.parse(collectionStartedAt.value)
  ) {
    return invalid("liquidation collection end precedes collection start");
  }
  const marketEvidence = parseMarketEvidenceIdentity(
    input.marketEvidence,
    runId.value,
    bundleCutoff.value,
  );
  if (!marketEvidence.ok) return marketEvidence;

  const parsedTargets: LiquidationTargetEvidence[] = [];
  const seenAssets = new Set<LiquidationTargetAsset>();
  const seenProviderSymbols = new Set<string>();
  const seenContracts = new Set<string>();
  for (const item of input.targets) {
    const parsed = parseTarget(item, bundleCutoff.value);
    if (!parsed.ok) return parsed;
    if (seenAssets.has(parsed.value.asset)) {
      return invalid("liquidation bundle contains a duplicate target asset");
    }
    seenAssets.add(parsed.value.asset);
    for (const constituent of parsed.value.constituents) {
      if (seenProviderSymbols.has(constituent.providerSymbol)) {
        return invalid(
          "liquidation bundle contains a duplicate provider symbol",
        );
      }
      const contractKey = JSON.stringify([
        constituent.exchange,
        constituent.symbolOnExchange,
        constituent.baseAsset,
        constituent.quoteAsset,
        constituent.marginType,
        constituent.expireAt,
      ]);
      if (seenContracts.has(contractKey)) {
        return invalid(
          "liquidation bundle contains a duplicate contract identity",
        );
      }
      seenProviderSymbols.add(constituent.providerSymbol);
      seenContracts.add(contractKey);
    }
    parsedTargets.push(parsed.value);
  }
  if (
    parsedTargets.length !== LIQUIDATION_EVIDENCE_ASSETS.length ||
    LIQUIDATION_EVIDENCE_ASSETS.some((asset) => !seenAssets.has(asset))
  ) {
    return invalid(
      "liquidation bundle must contain every configured target asset",
    );
  }
  parsedTargets.sort(
    (left, right) =>
      LIQUIDATION_EVIDENCE_ASSETS.indexOf(left.asset) -
      LIQUIDATION_EVIDENCE_ASSETS.indexOf(right.asset),
  );

  const constituentCount = parsedTargets.reduce(
    (count, target) => count + target.constituents.length,
    0,
  );
  const fullHistory = targetAssetsHaveFullHistory(
    parsedTargets,
    bundleCutoff.value,
  );
  const coverageProof = input.coverageProof as ProofStatusInput;
  const historyProof = input.historyProof as ProofStatusInput;
  const status = input.status as LiquidationEvidenceStatus;
  if (historyProof === "complete" && !fullHistory) {
    return invalid("complete liquidation history proof has missing buckets");
  }
  if (status === "complete") {
    if (
      coverageProof !== "complete" ||
      historyProof !== "complete" ||
      !fullHistory ||
      diagnostics.value.length > 0
    ) {
      return invalid("complete liquidation bundle lacks complete proof");
    }
  } else if (status === "incomplete") {
    if (
      constituentCount === 0 ||
      (coverageProof === "complete" && historyProof === "complete") ||
      diagnostics.value.length === 0
    ) {
      return invalid(
        "incomplete liquidation bundle lacks partial evidence or diagnostics",
      );
    }
  } else if (
    constituentCount !== 0 ||
    coverageProof !== "incomplete" ||
    historyProof !== "incomplete" ||
    diagnostics.value.length === 0
  ) {
    return invalid("failed liquidation bundle must contain diagnostics only");
  }

  return ok(
    deepFreeze({
      runId: runId.value,
      schemaVersion: LIQUIDATION_EVIDENCE_SCHEMA_VERSION,
      producer: producer.value,
      provider: "coinalyze" as const,
      policyVersion: LIQUIDATION_EVIDENCE_POLICY_VERSION,
      collectionStartedAt: collectionStartedAt.value,
      collectionEndedAt: collectionEndedAt.value,
      bundleCutoff: bundleCutoff.value,
      marketEvidence: marketEvidence.value,
      coverageProof,
      historyProof,
      status,
      targets: Object.freeze(parsedTargets),
      diagnostics: diagnostics.value,
    }),
  );
}

export function createLiquidationEvidenceRef(
  bundle: LiquidationEvidenceBundle,
  canonicalHash: string,
  validForMs: number,
): Result<EvidenceRef> {
  return createEvidenceRef({
    kind: "liquidation-evidence-bundle",
    schemaVersion: bundle.schemaVersion,
    producer: bundle.producer,
    sourceId: bundle.runId,
    asOf: bundle.bundleCutoff,
    validForMs,
    contentHash: canonicalHash,
  });
}
