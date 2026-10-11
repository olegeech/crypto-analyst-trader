import {
  LIQUIDATION_EVIDENCE_ASSETS,
  type LiquidationTargetAsset,
} from "../domain/liquidation/liquidation-evidence-bundle.js";
import { hashCanonical } from "../domain/identity/canonical-serialization.js";
import { domainError } from "../domain/shared/errors.js";
import { fail, ok, type Result } from "../domain/shared/result.js";
import { parseUtcTimestamp, type UtcTimestamp } from "../domain/shared/time.js";
import type { CoinalyzeMarket } from "../ports/coinalyze-liquidation-data.js";

export const DECISION_COVERAGE_POLICY_VERSION = "decision-coverage/v1" as const;

export interface SelectedLiquidationMarket extends CoinalyzeMarket {
  readonly asset: LiquidationTargetAsset;
}

export type LiquidationMarketExclusionReason =
  "asset-mismatch" | "not-perpetual" | "expired" | "ambiguous-identity";

export interface LiquidationMarketExclusion {
  readonly providerSymbol: string;
  readonly exchange: string;
  readonly symbolOnExchange: string;
  readonly reason: LiquidationMarketExclusionReason;
}

export interface DecisionLiquidationMarketSelection {
  readonly coveragePolicyVersion: typeof DECISION_COVERAGE_POLICY_VERSION;
  readonly selectedAsset: LiquidationTargetAsset;
  readonly cutoff: UtcTimestamp;
  readonly catalogueComplete: boolean;
  readonly catalogueMarkets: readonly CoinalyzeMarket[];
  readonly catalogueHash: string;
  readonly selectedMarkets: readonly SelectedLiquidationMarket[];
  readonly exclusions: readonly LiquidationMarketExclusion[];
  readonly selectedSetHash: string;
  readonly coverageProof: "complete" | "incomplete";
  readonly status: "complete" | "incomplete" | "failed";
  readonly reasonCodes: readonly string[];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function marketSortKey(market: CoinalyzeMarket): string {
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

function contractIdentity(market: CoinalyzeMarket): string {
  return JSON.stringify([market.exchange, market.symbolOnExchange]);
}

function supportedAsset(value: unknown): value is LiquidationTargetAsset {
  return (
    typeof value === "string" &&
    LIQUIDATION_EVIDENCE_ASSETS.some((asset) => asset === value)
  );
}

/**
 * Derives the decision-scoped selected set from a provider-validated catalogue.
 * The hashes bind stored rows and selection; only the caller's trusted catalogue
 * boundary may set catalogueComplete after validating the whole response.
 */
export function selectDecisionLiquidationMarkets(input: {
  readonly asset: unknown;
  readonly markets: readonly CoinalyzeMarket[];
  readonly catalogueComplete: boolean;
  readonly cutoffMs: number;
}): Result<DecisionLiquidationMarketSelection> {
  if (
    !supportedAsset(input.asset) ||
    typeof input.catalogueComplete !== "boolean" ||
    !Number.isSafeInteger(input.cutoffMs) ||
    input.cutoffMs < 0 ||
    !Array.isArray(input.markets) ||
    input.markets.some((market) => !isNormalizedMarket(market))
  ) {
    return fail(
      domainError(
        "INVALID_VALUE",
        "decision liquidation selection inputs are invalid",
      ),
    );
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
  const catalogueMarkets = [...input.markets].sort((left, right) =>
    compareText(marketSortKey(left), marketSortKey(right)),
  );
  const catalogueHash = hashCanonical({
    schemaVersion: "coinalyze-catalogue-snapshot/v1",
    markets: catalogueMarkets,
  });
  if (!catalogueHash.ok) return catalogueHash;

  const symbols = new Map<string, number>();
  const contracts = new Map<string, number>();
  for (const market of catalogueMarkets) {
    symbols.set(market.symbol, (symbols.get(market.symbol) ?? 0) + 1);
    const key = contractIdentity(market);
    contracts.set(key, (contracts.get(key) ?? 0) + 1);
  }
  const ambiguous = catalogueMarkets.filter(
    (market) =>
      (symbols.get(market.symbol) ?? 0) > 1 ||
      (contracts.get(contractIdentity(market)) ?? 0) > 1,
  );
  const ambiguousSymbols = new Set(ambiguous.map(({ symbol }) => symbol));
  const ambiguousContracts = new Set(ambiguous.map(contractIdentity));
  const selectedMarkets: SelectedLiquidationMarket[] = [];
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
      continue;
    }
    selectedMarkets.push(Object.freeze({ ...market, asset: input.asset }));
  }

  const hasAmbiguousIdentity = ambiguous.length > 0;
  const coverageProof =
    input.catalogueComplete &&
    !hasAmbiguousIdentity &&
    selectedMarkets.length > 0
      ? "complete"
      : "incomplete";
  const reasonCodes = [
    ...(!input.catalogueComplete ? ["CATALOGUE_INCOMPLETE"] : []),
    ...(hasAmbiguousIdentity ? ["CONFLICTING_MARKET_IDENTITY"] : []),
    ...(selectedMarkets.length === 0 ? ["NO_ELIGIBLE_MARKETS"] : []),
  ].sort(compareText);
  const selectedSetHash = hashCanonical({
    schemaVersion: "decision-liquidation-selection/v1",
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
      coverageProof,
      status:
        selectedMarkets.length === 0
          ? "failed"
          : coverageProof === "complete"
            ? "complete"
            : "incomplete",
      reasonCodes: Object.freeze(reasonCodes),
    }),
  );
}

function isNormalizedMarket(value: unknown): value is CoinalyzeMarket {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const market = value as Record<string, unknown>;
  const safeText = (text: unknown, maxLength = 128) =>
    typeof text === "string" &&
    text.length > 0 &&
    text.length <= maxLength &&
    text === text.normalize("NFC") &&
    !/[\u0000-\u001f\u007f]/u.test(text);
  return (
    safeText(market.symbol) &&
    safeText(market.exchange, 64) &&
    safeText(market.symbolOnExchange) &&
    safeText(market.baseAsset, 64) &&
    safeText(market.quoteAsset, 64) &&
    typeof market.isPerpetual === "boolean" &&
    safeText(market.marginType, 64) &&
    typeof market.expireAt === "number" &&
    Number.isSafeInteger(market.expireAt) &&
    market.expireAt >= 0 &&
    safeText(market.notionalDenominatedIn, 64)
  );
}

export function selectEligibleLiquidationMarkets(
  markets: readonly CoinalyzeMarket[],
  cutoffMs: number,
): readonly SelectedLiquidationMarket[] {
  const cutoffSeconds = Math.floor(cutoffMs / 1_000);
  return Object.freeze(
    markets
      .filter(
        (market) =>
          market.isPerpetual &&
          LIQUIDATION_EVIDENCE_ASSETS.some(
            (asset) => asset === market.baseAsset,
          ) &&
          (market.expireAt === 0 || market.expireAt > cutoffSeconds),
      )
      .map((market) =>
        Object.freeze({
          ...market,
          asset: market.baseAsset as LiquidationTargetAsset,
        }),
      )
      .sort((left, right) => left.symbol.localeCompare(right.symbol)),
  );
}

export function sampleLiquidationMarkets(
  eligibleMarkets: readonly SelectedLiquidationMarket[],
): readonly SelectedLiquidationMarket[] {
  const firstByAsset = new Map<
    LiquidationTargetAsset,
    SelectedLiquidationMarket
  >();
  for (const market of eligibleMarkets) {
    if (!firstByAsset.has(market.asset)) firstByAsset.set(market.asset, market);
  }
  return Object.freeze(
    LIQUIDATION_EVIDENCE_ASSETS.flatMap((asset) => {
      const market = firstByAsset.get(asset);
      return market === undefined ? [] : [market];
    }),
  );
}
