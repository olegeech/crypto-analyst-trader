import { hashCanonical } from "../identity/canonical-serialization.js";
import { DecimalValue, isDecimalValue } from "../shared/decimal.js";
import { domainError } from "../shared/errors.js";
import { fail, ok, type Result } from "../shared/result.js";
import { parseUtcTimestamp, type UtcTimestamp } from "../shared/time.js";
import {
  isRecord,
  onlyKeys,
  requireFiniteInteger,
  requireHash,
  requireIdentifier,
  requireSafeText,
} from "../shared/validation.js";
import {
  LIQUIDATION_EVIDENCE_PRODUCER,
  LIQUIDATION_EVIDENCE_V2_PROVIDER_SEMANTIC_IDENTITY,
  isLiquidationTargetAsset,
  type LiquidationTargetAsset,
} from "./liquidation-evidence-contracts.js";
import {
  parseLiquidationEvidenceDiagnostics,
  type LiquidationEvidenceDiagnostic,
  type LiquidationEvidenceDiagnosticInput,
} from "./liquidation-evidence-diagnostics.js";
import {
  deriveLiquidationWindows,
  LIQUIDATION_HOUR_MS,
  liquidationHistoryWindow,
  type LiquidationHourlyAggregate,
  type LiquidationWindowEvidence,
} from "./liquidation-evidence-windows.js";
import type {
  LiquidationEvidenceStatus,
  LiquidationMarketEvidenceIdentity,
  LiquidationObservationProvenance,
  LiquidationProofStatus,
} from "./liquidation-evidence-bundle.js";

export const LIQUIDATION_EVIDENCE_V3_SCHEMA_VERSION =
  "liquidation-evidence/v3" as const;
export const LIQUIDATION_EVIDENCE_V3_POLICY_VERSION =
  "liquidation-market-aggregate/v2" as const;
export const DECISION_COVERAGE_POLICY_VERSION = "decision-coverage/v1" as const;
export const LIQUIDATION_EVIDENCE_V3_SELECTION_HASH_SCHEMA =
  "decision-liquidation-selection/v1" as const;
export const LIQUIDATION_EVIDENCE_V3_CATALOGUE_HASH_SCHEMA =
  "coinalyze-catalogue-snapshot/v1" as const;
const DECISION_SELECTION_REASON_CODES = Object.freeze([
  "CATALOGUE_INCOMPLETE",
  "CONFLICTING_MARKET_IDENTITY",
  "NO_ELIGIBLE_MARKETS",
] as const);
const MARKET_EXCLUSION_REASONS = Object.freeze([
  "asset-mismatch",
  "not-perpetual",
  "expired",
  "ambiguous-identity",
] as const);

type DecisionSelectionReasonCode =
  (typeof DECISION_SELECTION_REASON_CODES)[number];

export interface LiquidationCatalogueMarket {
  readonly symbol: string;
  readonly exchange: string;
  readonly symbolOnExchange: string;
  readonly baseAsset: string;
  readonly quoteAsset: string;
  readonly isPerpetual: boolean;
  readonly marginType: string;
  readonly expireAt: number;
  readonly notionalDenominatedIn: string;
}

export type LiquidationMarketExclusionReason =
  (typeof MARKET_EXCLUSION_REASONS)[number];

export interface LiquidationMarketExclusion {
  readonly providerSymbol: string;
  readonly exchange: string;
  readonly symbolOnExchange: string;
  readonly reason: LiquidationMarketExclusionReason;
}

export interface DecisionLiquidationMarketSelectionEvidence {
  readonly coveragePolicyVersion: typeof DECISION_COVERAGE_POLICY_VERSION;
  readonly selectedAsset: LiquidationTargetAsset;
  readonly cutoff: UtcTimestamp;
  /** Set only after the trusted catalogue adapter validates the whole response. */
  readonly catalogueComplete: boolean;
  readonly catalogueMarkets: readonly LiquidationCatalogueMarket[];
  readonly catalogueHash: string;
  readonly exclusions: readonly LiquidationMarketExclusion[];
  readonly selectedSetHash: string;
  readonly reasonCodes: readonly DecisionSelectionReasonCode[];
}

export interface DecisionLiquidationMarketSelection extends DecisionLiquidationMarketSelectionEvidence {
  readonly selectedMarkets: readonly (LiquidationCatalogueMarket & {
    readonly asset: LiquidationTargetAsset;
  })[];
  readonly coverageProof: LiquidationProofStatus;
  readonly status: LiquidationEvidenceStatus;
}

export interface LiquidationEvidenceV3ConstituentInput {
  readonly providerSymbol: string;
  readonly exchange: string;
  readonly symbolOnExchange: string;
  readonly baseAsset: LiquidationTargetAsset;
  readonly quoteAsset: string;
  readonly isPerpetual: true;
  readonly marginType: string;
  readonly expireAt: number;
  readonly notionalDenominatedIn: string;
  readonly observations: readonly {
    readonly timestamp: string;
    readonly longUsd: string;
    readonly shortUsd: string;
    readonly provenance: LiquidationObservationProvenance;
  }[];
}

export interface LiquidationEvidenceV3TargetInput {
  readonly asset: LiquidationTargetAsset;
  readonly constituents: readonly LiquidationEvidenceV3ConstituentInput[];
  readonly hourlyAggregates?: readonly unknown[];
  readonly windows?: readonly unknown[];
}

export interface LiquidationEvidenceBundleV3Input {
  readonly runId: string;
  readonly schemaVersion: typeof LIQUIDATION_EVIDENCE_V3_SCHEMA_VERSION;
  readonly providerSemanticIdentity: typeof LIQUIDATION_EVIDENCE_V2_PROVIDER_SEMANTIC_IDENTITY;
  readonly producer: typeof LIQUIDATION_EVIDENCE_PRODUCER;
  readonly provider: "coinalyze";
  readonly policyVersion: typeof LIQUIDATION_EVIDENCE_V3_POLICY_VERSION;
  readonly collectionStartedAt: string;
  readonly collectionEndedAt: string;
  readonly bundleCutoff: string;
  readonly marketEvidence: {
    readonly runId: string;
    readonly universeVersion: string;
    readonly bundleCutoff: string;
    readonly contentHash: string;
  };
  readonly selection: DecisionLiquidationMarketSelectionEvidence;
  readonly coverageProof: LiquidationProofStatus;
  readonly historyProof: LiquidationProofStatus;
  readonly status: LiquidationEvidenceStatus;
  readonly targets: readonly LiquidationEvidenceV3TargetInput[];
  readonly diagnostics: readonly LiquidationEvidenceDiagnosticInput[];
}

export interface LiquidationEvidenceV3Constituent extends Omit<
  LiquidationEvidenceV3ConstituentInput,
  "observations"
> {
  readonly observations: readonly {
    readonly timestamp: UtcTimestamp;
    readonly longUsd: DecimalValue;
    readonly shortUsd: DecimalValue;
    readonly provenance: LiquidationObservationProvenance;
  }[];
}

export interface LiquidationEvidenceV3Target extends Omit<
  LiquidationEvidenceV3TargetInput,
  "constituents" | "hourlyAggregates" | "windows"
> {
  readonly constituents: readonly LiquidationEvidenceV3Constituent[];
  readonly hourlyAggregates: readonly LiquidationHourlyAggregate[];
  readonly windows: readonly LiquidationWindowEvidence[];
}

export interface LiquidationEvidenceBundleV3 {
  readonly runId: string;
  readonly schemaVersion: typeof LIQUIDATION_EVIDENCE_V3_SCHEMA_VERSION;
  readonly providerSemanticIdentity: typeof LIQUIDATION_EVIDENCE_V2_PROVIDER_SEMANTIC_IDENTITY;
  readonly producer: typeof LIQUIDATION_EVIDENCE_PRODUCER;
  readonly provider: "coinalyze";
  readonly policyVersion: typeof LIQUIDATION_EVIDENCE_V3_POLICY_VERSION;
  readonly collectionStartedAt: UtcTimestamp;
  readonly collectionEndedAt: UtcTimestamp;
  readonly bundleCutoff: UtcTimestamp;
  readonly marketEvidence: LiquidationMarketEvidenceIdentity;
  readonly selection: DecisionLiquidationMarketSelectionEvidence;
  readonly coverageProof: LiquidationProofStatus;
  readonly historyProof: LiquidationProofStatus;
  readonly status: LiquidationEvidenceStatus;
  readonly targets: readonly LiquidationEvidenceV3Target[];
  readonly diagnostics: readonly LiquidationEvidenceDiagnostic[];
}

function invalid(message: string, field?: string): Result<never> {
  return fail(
    domainError(
      "INVALID_VALUE",
      message,
      field === undefined ? undefined : { field },
    ),
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function marketSortKey(market: LiquidationCatalogueMarket): string {
  return JSON.stringify([
    market.exchange,
    market.symbolOnExchange,
    market.symbol,
    market.baseAsset,
    market.quoteAsset,
    market.isPerpetual,
    market.marginType,
    market.expireAt,
    market.notionalDenominatedIn,
  ]);
}

function sortMarketsByKey<T extends LiquidationCatalogueMarket>(
  markets: readonly T[],
): T[] {
  return markets
    .map((market) => ({ market, key: marketSortKey(market) }))
    .sort((left, right) => compareText(left.key, right.key))
    .map(({ market }) => market);
}

function isDecisionSelectionReasonCode(
  value: unknown,
): value is DecisionSelectionReasonCode {
  return (
    typeof value === "string" &&
    DECISION_SELECTION_REASON_CODES.some((code) => code === value)
  );
}

function isMarketExclusionReason(
  value: unknown,
): value is LiquidationMarketExclusionReason {
  return (
    typeof value === "string" &&
    MARKET_EXCLUSION_REASONS.some((reason) => reason === value)
  );
}

function contractIdentity(market: LiquidationCatalogueMarket): string {
  return JSON.stringify([market.exchange, market.symbolOnExchange]);
}

function isNormalizedMarket(
  value: unknown,
): value is LiquidationCatalogueMarket {
  if (!isRecord(value)) return false;
  const text = (item: unknown, maxLength = 128) => {
    const parsed = requireSafeText(item, "catalogueMarket.text");
    return (
      parsed.ok && parsed.value.length <= maxLength && parsed.value === item
    );
  };
  return (
    onlyKeys(value, [
      "symbol",
      "exchange",
      "symbolOnExchange",
      "baseAsset",
      "quoteAsset",
      "isPerpetual",
      "marginType",
      "expireAt",
      "notionalDenominatedIn",
    ]) &&
    text(value.symbol) &&
    text(value.exchange, 64) &&
    text(value.symbolOnExchange) &&
    text(value.baseAsset, 64) &&
    text(value.quoteAsset, 64) &&
    typeof value.isPerpetual === "boolean" &&
    text(value.marginType, 64) &&
    typeof value.expireAt === "number" &&
    Number.isSafeInteger(value.expireAt) &&
    value.expireAt >= 0 &&
    text(value.notionalDenominatedIn, 64)
  );
}

function catalogueMarketFromUnknown(
  value: unknown,
): LiquidationCatalogueMarket | undefined {
  if (!isRecord(value)) return undefined;
  if (!isNormalizedMarket(value)) return undefined;
  return Object.freeze({
    symbol: value.symbol,
    exchange: value.exchange,
    symbolOnExchange: value.symbolOnExchange,
    baseAsset: value.baseAsset,
    quoteAsset: value.quoteAsset,
    isPerpetual: value.isPerpetual,
    marginType: value.marginType,
    expireAt: value.expireAt,
    notionalDenominatedIn: value.notionalDenominatedIn,
  });
}

function hashEqual(left: unknown, right: unknown): boolean {
  const leftHash = hashCanonical(left);
  const rightHash = hashCanonical(right);
  return leftHash.ok && rightHash.ok && leftHash.value === rightHash.value;
}

/** Pure versioned selection policy shared by collection and replay validation. */
export function selectDecisionLiquidationMarkets(input: {
  readonly asset: unknown;
  readonly markets: readonly LiquidationCatalogueMarket[];
  readonly catalogueComplete: boolean;
  readonly cutoffMs: number;
}): Result<DecisionLiquidationMarketSelection> {
  if (
    !isLiquidationTargetAsset(input.asset) ||
    typeof input.catalogueComplete !== "boolean" ||
    !Number.isSafeInteger(input.cutoffMs) ||
    input.cutoffMs < 0 ||
    !Array.isArray(input.markets) ||
    input.markets.some((market) => !isNormalizedMarket(market))
  ) {
    return invalid("decision liquidation selection inputs are invalid");
  }
  const date = new Date(input.cutoffMs);
  if (!Number.isFinite(date.valueOf())) {
    return fail(
      domainError("INVALID_TIMESTAMP", "decision selection cutoff is invalid"),
    );
  }
  const parsedCutoff = parseUtcTimestamp(date.toISOString());
  if (!parsedCutoff.ok) return parsedCutoff;
  const cutoff = parsedCutoff.value;
  const cutoffSeconds = Math.floor(input.cutoffMs / 1_000);
  const catalogueMarkets = sortMarketsByKey(input.markets);
  const catalogueHash = hashCanonical({
    schemaVersion: LIQUIDATION_EVIDENCE_V3_CATALOGUE_HASH_SCHEMA,
    markets: catalogueMarkets,
  });
  if (!catalogueHash.ok) return catalogueHash;

  const symbolCounts = new Map<string, number>();
  const contractCounts = new Map<string, number>();
  for (const market of catalogueMarkets) {
    symbolCounts.set(market.symbol, (symbolCounts.get(market.symbol) ?? 0) + 1);
    const key = contractIdentity(market);
    contractCounts.set(key, (contractCounts.get(key) ?? 0) + 1);
  }
  const ambiguous = catalogueMarkets.filter(
    (market) =>
      (symbolCounts.get(market.symbol) ?? 0) > 1 ||
      (contractCounts.get(contractIdentity(market)) ?? 0) > 1,
  );
  const ambiguousSymbols = new Set(ambiguous.map(({ symbol }) => symbol));
  const ambiguousContracts = new Set(ambiguous.map(contractIdentity));
  const selectedMarkets: (LiquidationCatalogueMarket & {
    readonly asset: LiquidationTargetAsset;
  })[] = [];
  const exclusions: LiquidationMarketExclusion[] = [];
  for (const market of catalogueMarkets) {
    let reason: LiquidationMarketExclusionReason | undefined;
    if (
      ambiguousSymbols.has(market.symbol) ||
      ambiguousContracts.has(contractIdentity(market))
    ) {
      reason = "ambiguous-identity";
    } else if (market.baseAsset !== input.asset) {
      reason = "asset-mismatch";
    } else if (!market.isPerpetual) {
      reason = "not-perpetual";
    } else if (market.expireAt !== 0 && market.expireAt <= cutoffSeconds) {
      reason = "expired";
    }
    if (reason !== undefined) {
      exclusions.push(
        Object.freeze({
          providerSymbol: market.symbol,
          exchange: market.exchange,
          symbolOnExchange: market.symbolOnExchange,
          reason,
        }),
      );
    } else {
      selectedMarkets.push(Object.freeze({ ...market, asset: input.asset }));
    }
  }

  const hasAmbiguousIdentity = ambiguous.length > 0;
  const coverageProof: LiquidationProofStatus =
    input.catalogueComplete &&
    !hasAmbiguousIdentity &&
    selectedMarkets.length > 0
      ? "complete"
      : "incomplete";
  const reasonCodes: DecisionSelectionReasonCode[] = [];
  if (!input.catalogueComplete) reasonCodes.push("CATALOGUE_INCOMPLETE");
  if (hasAmbiguousIdentity) reasonCodes.push("CONFLICTING_MARKET_IDENTITY");
  if (selectedMarkets.length === 0) reasonCodes.push("NO_ELIGIBLE_MARKETS");
  reasonCodes.sort(compareText);
  const selectedSetHash = hashCanonical({
    schemaVersion: LIQUIDATION_EVIDENCE_V3_SELECTION_HASH_SCHEMA,
    coveragePolicyVersion: DECISION_COVERAGE_POLICY_VERSION,
    selectedAsset: input.asset,
    cutoff,
    catalogueComplete: input.catalogueComplete,
    catalogueHash: catalogueHash.value,
    selectedMarkets,
    exclusions,
    reasonCodes,
  });
  if (!selectedSetHash.ok) return selectedSetHash;

  return ok(
    Object.freeze({
      coveragePolicyVersion: DECISION_COVERAGE_POLICY_VERSION,
      selectedAsset: input.asset,
      cutoff,
      catalogueComplete: input.catalogueComplete,
      catalogueMarkets: Object.freeze(catalogueMarkets),
      catalogueHash: catalogueHash.value,
      selectedMarkets: Object.freeze(selectedMarkets),
      exclusions: Object.freeze(exclusions),
      selectedSetHash: selectedSetHash.value,
      reasonCodes: Object.freeze(reasonCodes),
      coverageProof,
      status:
        selectedMarkets.length === 0
          ? "failed"
          : coverageProof === "complete"
            ? "complete"
            : "incomplete",
    }),
  );
}

function parseSelection(
  value: unknown,
  bundleCutoff: UtcTimestamp,
): Result<{
  readonly evidence: DecisionLiquidationMarketSelectionEvidence;
  readonly derived: DecisionLiquidationMarketSelection;
}> {
  if (
    !isRecord(value) ||
    !onlyKeys(value, [
      "coveragePolicyVersion",
      "selectedAsset",
      "cutoff",
      "catalogueComplete",
      "catalogueMarkets",
      "catalogueHash",
      "exclusions",
      "selectedSetHash",
      "reasonCodes",
    ]) ||
    value.coveragePolicyVersion !== DECISION_COVERAGE_POLICY_VERSION ||
    !isLiquidationTargetAsset(value.selectedAsset) ||
    typeof value.catalogueComplete !== "boolean" ||
    !Array.isArray(value.catalogueMarkets) ||
    !Array.isArray(value.exclusions) ||
    !Array.isArray(value.reasonCodes)
  ) {
    return invalid("liquidation v3 selection evidence is invalid");
  }
  const cutoff = parseUtcTimestamp(value.cutoff);
  const catalogueHash = requireHash(
    value.catalogueHash,
    "selection.catalogueHash",
  );
  const selectedSetHash = requireHash(
    value.selectedSetHash,
    "selection.selectedSetHash",
  );
  if (
    !cutoff.ok ||
    !catalogueHash.ok ||
    !selectedSetHash.ok ||
    cutoff.value !== bundleCutoff
  ) {
    return invalid("liquidation v3 selection cutoff or hash is invalid");
  }
  const catalogueMarkets: LiquidationCatalogueMarket[] = [];
  for (const item of value.catalogueMarkets) {
    const market = catalogueMarketFromUnknown(item);
    if (market === undefined)
      return invalid("liquidation v3 catalogue row is invalid");
    catalogueMarkets.push(market);
  }
  const exclusions: LiquidationMarketExclusion[] = [];
  for (const item of value.exclusions) {
    if (
      !isRecord(item) ||
      !onlyKeys(item, [
        "providerSymbol",
        "exchange",
        "symbolOnExchange",
        "reason",
      ]) ||
      !isMarketExclusionReason(item.reason)
    ) {
      return invalid("liquidation v3 market exclusion is invalid");
    }
    const providerSymbol = requireSafeText(
      item.providerSymbol,
      "exclusion.providerSymbol",
    );
    const exchange = requireSafeText(item.exchange, "exclusion.exchange");
    const symbolOnExchange = requireSafeText(
      item.symbolOnExchange,
      "exclusion.symbolOnExchange",
    );
    if (!providerSymbol.ok || !exchange.ok || !symbolOnExchange.ok)
      return invalid("liquidation v3 market exclusion identity is invalid");
    exclusions.push(
      Object.freeze({
        providerSymbol: providerSymbol.value,
        exchange: exchange.value,
        symbolOnExchange: symbolOnExchange.value,
        reason: item.reason,
      }),
    );
  }
  const reasonCodes: DecisionSelectionReasonCode[] = [];
  for (const code of value.reasonCodes) {
    if (!isDecisionSelectionReasonCode(code)) {
      return invalid("liquidation v3 selection reason code is invalid");
    }
    reasonCodes.push(code);
  }
  if (new Set(reasonCodes).size !== reasonCodes.length) {
    return invalid("liquidation v3 selection reason codes are duplicated");
  }
  const derived = selectDecisionLiquidationMarkets({
    asset: value.selectedAsset,
    markets: catalogueMarkets,
    catalogueComplete: value.catalogueComplete,
    cutoffMs: Date.parse(cutoff.value),
  });
  if (!derived.ok) return derived;
  const evidence: DecisionLiquidationMarketSelectionEvidence = Object.freeze({
    coveragePolicyVersion: DECISION_COVERAGE_POLICY_VERSION,
    selectedAsset: value.selectedAsset,
    cutoff: cutoff.value,
    catalogueComplete: value.catalogueComplete,
    catalogueMarkets: derived.value.catalogueMarkets,
    catalogueHash: catalogueHash.value,
    exclusions: Object.freeze(exclusions),
    selectedSetHash: selectedSetHash.value,
    reasonCodes: Object.freeze(reasonCodes),
  });
  if (
    evidence.catalogueHash !== derived.value.catalogueHash ||
    evidence.selectedSetHash !== derived.value.selectedSetHash ||
    !hashEqual(evidence.exclusions, derived.value.exclusions) ||
    !hashEqual(evidence.reasonCodes, derived.value.reasonCodes)
  ) {
    return invalid("liquidation v3 selection proof does not match catalogue");
  }
  return ok(Object.freeze({ evidence, derived: derived.value }));
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

function parseMarketEvidenceIdentity(
  value: unknown,
  runId: string,
  bundleCutoff: UtcTimestamp,
): Result<LiquidationMarketEvidenceIdentity> {
  if (
    !isRecord(value) ||
    !onlyKeys(value, [
      "runId",
      "universeVersion",
      "bundleCutoff",
      "contentHash",
    ])
  ) {
    return invalid("liquidation v3 market identity is invalid");
  }
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
    return invalid("liquidation v3 market identity is incompatible");
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

function parseConstituent(
  value: unknown,
  asset: LiquidationTargetAsset,
  bundleCutoff: UtcTimestamp,
): Result<LiquidationEvidenceV3Constituent> {
  if (
    !isRecord(value) ||
    !onlyKeys(value, [
      "providerSymbol",
      "exchange",
      "symbolOnExchange",
      "baseAsset",
      "quoteAsset",
      "isPerpetual",
      "marginType",
      "expireAt",
      "notionalDenominatedIn",
      "observations",
    ])
  ) {
    return invalid("liquidation v3 constituent shape is invalid");
  }
  const providerSymbol = requireSafeText(
    value.providerSymbol,
    "providerSymbol",
  );
  const exchange = requireSafeText(value.exchange, "exchange");
  const symbolOnExchange = requireSafeText(
    value.symbolOnExchange,
    "symbolOnExchange",
  );
  const baseAsset = requireSafeText(value.baseAsset, "baseAsset");
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
    !baseAsset.ok ||
    !quoteAsset.ok ||
    !marginType.ok ||
    !expireAt.ok ||
    expireAt.value < 0 ||
    !notionalDenominatedIn.ok ||
    value.baseAsset !== asset ||
    value.isPerpetual !== true ||
    !Array.isArray(value.observations)
  ) {
    return invalid("liquidation v3 constituent identity is invalid");
  }
  const bounds = liquidationHistoryWindow(Date.parse(bundleCutoff));
  const observations: LiquidationEvidenceV3Constituent["observations"][number][] =
    [];
  const seen = new Set<string>();
  for (const raw of value.observations) {
    if (
      !isRecord(raw) ||
      !onlyKeys(raw, ["timestamp", "longUsd", "shortUsd", "provenance"]) ||
      (raw.provenance !== "provider-explicit" &&
        raw.provenance !== "provider-implied-zero")
    ) {
      return invalid("liquidation v3 observation shape is invalid");
    }
    const observedAt = timestamp(raw.timestamp, "observation.timestamp");
    const longUsd = decimal(raw.longUsd, "observation.longUsd");
    const shortUsd = decimal(raw.shortUsd, "observation.shortUsd");
    if (!observedAt.ok || !longUsd.ok || !shortUsd.ok) {
      return invalid("liquidation v3 observation value is invalid");
    }
    const epoch = Date.parse(observedAt.value);
    if (
      epoch % LIQUIDATION_HOUR_MS !== 0 ||
      epoch < bounds.oldestEpoch ||
      epoch > bounds.latestClosedEpoch ||
      seen.has(observedAt.value)
    ) {
      return invalid(
        "liquidation v3 observation is duplicate or outside window",
      );
    }
    if (
      raw.provenance === "provider-implied-zero" &&
      (!longUsd.value.isZero() || !shortUsd.value.isZero())
    ) {
      return invalid("provider-implied-zero must contain exact zero values");
    }
    seen.add(observedAt.value);
    observations.push(
      Object.freeze({
        timestamp: observedAt.value,
        longUsd: longUsd.value,
        shortUsd: shortUsd.value,
        provenance: raw.provenance,
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

function constituentMarket(
  constituent: LiquidationEvidenceV3Constituent,
): LiquidationCatalogueMarket {
  return Object.freeze({
    symbol: constituent.providerSymbol,
    exchange: constituent.exchange,
    symbolOnExchange: constituent.symbolOnExchange,
    baseAsset: constituent.baseAsset,
    quoteAsset: constituent.quoteAsset,
    isPerpetual: true,
    marginType: constituent.marginType,
    expireAt: constituent.expireAt,
    notionalDenominatedIn: constituent.notionalDenominatedIn,
  });
}

function sameDerivedDecimal(value: unknown, expected: DecimalValue): boolean {
  const parsed = decimal(value, "derivedDecimal");
  return parsed.ok && parsed.value.compare(expected) === 0;
}

function validateStoredAggregates(
  value: unknown,
  expected: readonly LiquidationHourlyAggregate[],
): Result<void> {
  if (value === undefined) return ok(undefined);
  if (!Array.isArray(value) || value.length !== expected.length)
    return invalid("stored v3 liquidation aggregates are invalid");
  for (let index = 0; index < expected.length; index += 1) {
    const stored = value[index];
    const derived = expected[index];
    if (
      !isRecord(stored) ||
      !onlyKeys(stored, [
        "timestamp",
        "longUsd",
        "shortUsd",
        "totalUsd",
        "observedConstituents",
        "expectedConstituents",
        "complete",
      ]) ||
      derived === undefined
    )
      return invalid("stored v3 aggregate is invalid");
    const observedAt = timestamp(stored.timestamp, "aggregate.timestamp");
    if (
      !observedAt.ok ||
      observedAt.value !== derived.timestamp ||
      !sameDerivedDecimal(stored.longUsd, derived.longUsd) ||
      !sameDerivedDecimal(stored.shortUsd, derived.shortUsd) ||
      !sameDerivedDecimal(stored.totalUsd, derived.totalUsd) ||
      stored.observedConstituents !== derived.observedConstituents ||
      stored.expectedConstituents !== derived.expectedConstituents ||
      stored.complete !== derived.complete
    ) {
      return invalid("stored v3 aggregate does not match source facts");
    }
  }
  return ok(undefined);
}

function validateStoredWindows(
  value: unknown,
  expected: readonly LiquidationWindowEvidence[],
): Result<void> {
  if (value === undefined) return ok(undefined);
  if (!Array.isArray(value) || value.length !== expected.length)
    return invalid("stored v3 liquidation windows are invalid");
  for (let index = 0; index < expected.length; index += 1) {
    const stored = value[index];
    const derived = expected[index];
    if (
      !isRecord(stored) ||
      !onlyKeys(stored, [
        "hours",
        "from",
        "to",
        "longUsd",
        "shortUsd",
        "totalUsd",
        "observedConstituentBuckets",
        "expectedConstituentBuckets",
        "complete",
      ]) ||
      derived === undefined
    )
      return invalid("stored v3 window is invalid");
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
      return invalid("stored v3 window does not match source facts");
    }
  }
  return ok(undefined);
}

function fullHistory(
  constituents: readonly LiquidationEvidenceV3Constituent[],
  bundleCutoff: UtcTimestamp,
): boolean {
  const expected = liquidationHistoryWindow(Date.parse(bundleCutoff)).epochs;
  return constituents.every((constituent) =>
    expected.every(
      (bucket, index) =>
        Date.parse(constituent.observations[index]?.timestamp ?? "") === bucket,
    ),
  );
}

export function createLiquidationEvidenceBundleV3(
  input: unknown,
): Result<LiquidationEvidenceBundleV3> {
  if (
    !isRecord(input) ||
    !onlyKeys(input, [
      "runId",
      "schemaVersion",
      "providerSemanticIdentity",
      "producer",
      "provider",
      "policyVersion",
      "collectionStartedAt",
      "collectionEndedAt",
      "bundleCutoff",
      "marketEvidence",
      "selection",
      "coverageProof",
      "historyProof",
      "status",
      "targets",
      "diagnostics",
    ]) ||
    input.schemaVersion !== LIQUIDATION_EVIDENCE_V3_SCHEMA_VERSION ||
    input.providerSemanticIdentity !==
      LIQUIDATION_EVIDENCE_V2_PROVIDER_SEMANTIC_IDENTITY ||
    input.producer !== LIQUIDATION_EVIDENCE_PRODUCER ||
    input.provider !== "coinalyze" ||
    input.policyVersion !== LIQUIDATION_EVIDENCE_V3_POLICY_VERSION ||
    (input.coverageProof !== "complete" &&
      input.coverageProof !== "incomplete") ||
    (input.historyProof !== "complete" &&
      input.historyProof !== "incomplete") ||
    (input.status !== "complete" &&
      input.status !== "incomplete" &&
      input.status !== "failed") ||
    !Array.isArray(input.targets) ||
    input.targets.length !== 1
  ) {
    return invalid("liquidation evidence v3 identity or shape is invalid");
  }
  const runId = requireIdentifier(input.runId, "runId");
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
    !runId.ok ||
    !collectionStartedAt.ok ||
    !collectionEndedAt.ok ||
    !bundleCutoff.ok ||
    !diagnostics.ok ||
    Date.parse(collectionEndedAt.value) < Date.parse(collectionStartedAt.value)
  ) {
    return invalid("liquidation evidence v3 timing or diagnostics are invalid");
  }
  const marketEvidence = parseMarketEvidenceIdentity(
    input.marketEvidence,
    runId.value,
    bundleCutoff.value,
  );
  const selection = parseSelection(input.selection, bundleCutoff.value);
  if (!marketEvidence.ok) return marketEvidence;
  if (!selection.ok) return selection;
  if (!isRecord(input.targets[0]))
    return invalid("liquidation v3 target is invalid");
  const rawTarget = input.targets[0];
  if (
    !onlyKeys(rawTarget, [
      "asset",
      "constituents",
      "hourlyAggregates",
      "windows",
    ]) ||
    rawTarget.asset !== selection.value.evidence.selectedAsset ||
    !Array.isArray(rawTarget.constituents)
  ) {
    return invalid(
      "liquidation v3 must contain its selected asset target only",
    );
  }
  const constituents: LiquidationEvidenceV3Constituent[] = [];
  for (const rawConstituent of rawTarget.constituents) {
    const constituent = parseConstituent(
      rawConstituent,
      selection.value.evidence.selectedAsset,
      bundleCutoff.value,
    );
    if (!constituent.ok) return constituent;
    constituents.push(constituent.value);
  }
  constituents.sort((left, right) =>
    compareText(left.providerSymbol, right.providerSymbol),
  );

  const selectedMarkets = sortMarketsByKey(
    constituents.map((constituent) => ({
      ...constituentMarket(constituent),
      asset: rawTarget.asset as LiquidationTargetAsset,
    })),
  );
  if (!hashEqual(selectedMarkets, selection.value.derived.selectedMarkets)) {
    return invalid(
      "liquidation v3 target does not match selected catalogue set",
    );
  }
  const hasImpliedZeros = constituents.some((constituent) =>
    constituent.observations.some(
      ({ provenance }) => provenance === "provider-implied-zero",
    ),
  );
  const hasHistoryFailure = diagnostics.value.some(
    ({ operation }) => operation === "fetch-liquidation-history",
  );
  const hasCatalogueFailure = diagnostics.value.some(
    ({ code, operation }) =>
      operation === "discover-markets" && code !== "no-eligible-markets",
  );
  const completeHistory = fullHistory(constituents, bundleCutoff.value);
  if (
    input.coverageProof !== selection.value.derived.coverageProof ||
    selection.value.evidence.catalogueComplete === hasCatalogueFailure ||
    (input.historyProof === "complete" &&
      (!completeHistory || hasHistoryFailure)) ||
    (hasImpliedZeros &&
      (input.coverageProof !== "complete" ||
        input.historyProof !== "complete" ||
        hasHistoryFailure ||
        !selection.value.evidence.catalogueComplete))
  ) {
    return invalid("liquidation evidence v3 proof claims are inconsistent");
  }

  const derived = deriveLiquidationWindows(constituents, bundleCutoff.value);
  const storedAggregates = validateStoredAggregates(
    rawTarget.hourlyAggregates,
    derived.hourlyAggregates,
  );
  const storedWindows = validateStoredWindows(
    rawTarget.windows,
    derived.windows,
  );
  if (!storedAggregates.ok) return storedAggregates;
  if (!storedWindows.ok) return storedWindows;

  const target: LiquidationEvidenceV3Target = Object.freeze({
    asset: rawTarget.asset as LiquidationTargetAsset,
    constituents: Object.freeze(constituents),
    hourlyAggregates: derived.hourlyAggregates,
    windows: derived.windows,
  });
  if (input.status === "complete") {
    if (
      selection.value.derived.status !== "complete" ||
      input.coverageProof !== "complete" ||
      input.historyProof !== "complete" ||
      !completeHistory ||
      diagnostics.value.length > 0
    ) {
      return invalid("complete liquidation v3 lacks complete proofs");
    }
  } else if (input.status === "incomplete") {
    if (constituents.length === 0 || diagnostics.value.length === 0) {
      return invalid(
        "incomplete liquidation v3 lacks partial facts or diagnostics",
      );
    }
  } else if (
    constituents.length !== 0 ||
    input.coverageProof !== "incomplete" ||
    input.historyProof !== "incomplete" ||
    diagnostics.value.length === 0 ||
    selection.value.derived.status !== "failed"
  ) {
    return invalid("failed liquidation v3 requires one negative-proof target");
  }

  return ok(
    Object.freeze({
      runId: runId.value,
      schemaVersion: LIQUIDATION_EVIDENCE_V3_SCHEMA_VERSION,
      providerSemanticIdentity:
        LIQUIDATION_EVIDENCE_V2_PROVIDER_SEMANTIC_IDENTITY,
      producer: LIQUIDATION_EVIDENCE_PRODUCER,
      provider: "coinalyze" as const,
      policyVersion: LIQUIDATION_EVIDENCE_V3_POLICY_VERSION,
      collectionStartedAt: collectionStartedAt.value,
      collectionEndedAt: collectionEndedAt.value,
      bundleCutoff: bundleCutoff.value,
      marketEvidence: marketEvidence.value,
      selection: selection.value.evidence,
      coverageProof: input.coverageProof,
      historyProof: input.historyProof,
      status: input.status,
      targets: Object.freeze([target]),
      diagnostics: diagnostics.value,
    }),
  );
}
