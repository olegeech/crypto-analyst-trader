import { hashCanonical } from "../identity/canonical-serialization.js";
import { LIQUIDATION_EVIDENCE_ASSETS } from "../liquidation/liquidation-evidence-bundle.js";
import { LIQUIDATION_WINDOW_HOURS } from "../liquidation/liquidation-evidence-windows.js";
import {
  MARKET_EVIDENCE_SYMBOLS,
  type MarketEvidenceSymbol,
  type MarketSeriesInterval,
  type OpenInterestInterval,
} from "../market/market-evidence-bundle.js";
import { domainError } from "../shared/errors.js";
import { compareAnalyticsText } from "./analytics-diagnostics.js";
import { fail, ok, type Result } from "../shared/result.js";
import {
  isRecord,
  requireFiniteInteger,
  requireIdentifier,
} from "../shared/validation.js";
import type { LiquidationTargetAsset } from "../liquidation/liquidation-evidence-bundle.js";
import type { LiquidationWindowHours } from "../liquidation/liquidation-evidence-windows.js";

export const ANALYTICS_PROFILE_SCHEMA_VERSION = "analytics-profile/v1" as const;
export const ANALYTICS_FEATURES_VERSION = "analytics-features/v1" as const;

export type AnalyticsFeatureKind =
  | "close-return"
  | "maximum-drawdown"
  | "atr"
  | "realized-volatility"
  | "volatility-comparison"
  | "funding-change"
  | "open-interest-absolute-change"
  | "open-interest-relative-change"
  | "liquidation-window";

export type ExternalEvidenceFamily =
  "market-regime-score" | "early-warning-risk" | "liquidity-stress" | "trap";

interface FeatureRequestBase {
  readonly id: string;
  readonly required: boolean;
}

interface PriceFeatureRequestBase extends FeatureRequestBase {
  readonly symbol: MarketEvidenceSymbol;
  readonly interval: MarketSeriesInterval;
}

export type AnalyticsFeatureRequest =
  | (PriceFeatureRequestBase & {
      readonly kind: "close-return";
      readonly periods: number;
    })
  | (PriceFeatureRequestBase & {
      readonly kind: "maximum-drawdown";
      readonly observationCount: number;
    })
  | (PriceFeatureRequestBase & {
      readonly kind: "atr";
      readonly period: number;
    })
  | (PriceFeatureRequestBase & {
      readonly kind: "realized-volatility";
      readonly observationCount: number;
    })
  | (PriceFeatureRequestBase & {
      readonly kind: "volatility-comparison";
      readonly recentObservationCount: number;
      readonly referenceObservationCount: number;
    })
  | (FeatureRequestBase & {
      readonly kind: "funding-change";
      readonly symbol: MarketEvidenceSymbol;
      readonly observationCount: number;
    })
  | (FeatureRequestBase & {
      readonly kind:
        "open-interest-absolute-change" | "open-interest-relative-change";
      readonly symbol: MarketEvidenceSymbol;
      readonly interval: OpenInterestInterval;
      readonly observationCount: number;
    })
  | (FeatureRequestBase & {
      readonly kind: "liquidation-window";
      readonly asset: LiquidationTargetAsset;
      readonly windowHours: LiquidationWindowHours;
    });

export interface ExternalEvidenceRequest {
  readonly family: ExternalEvidenceFamily;
  readonly required: boolean;
}

export interface AnalyticsProfile {
  readonly schemaVersion: typeof ANALYTICS_PROFILE_SCHEMA_VERSION;
  readonly features: readonly AnalyticsFeatureRequest[];
  readonly externalEvidence: readonly ExternalEvidenceRequest[];
}

const MARKET_INTERVALS = new Set<MarketSeriesInterval>([
  "1h",
  "4h",
  "1d",
  "1w",
]);
const OPEN_INTEREST_INTERVALS = new Set<OpenInterestInterval>([
  "1h",
  "4h",
  "1d",
]);
const EXTERNAL_EVIDENCE_FAMILIES = new Set<ExternalEvidenceFamily>([
  "market-regime-score",
  "early-warning-risk",
  "liquidity-stress",
  "trap",
]);

function invalid(message: string, field?: string): Result<never> {
  return fail(
    domainError(
      "INVALID_VALUE",
      message,
      field === undefined ? undefined : { field },
    ),
  );
}

function onlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function parseRequired(value: unknown): Result<boolean> {
  return typeof value === "boolean"
    ? ok(value)
    : invalid("required must be an explicit boolean", "required");
}

function parsePositiveCount(
  value: unknown,
  field: string,
  minimum = 1,
): Result<number> {
  const parsed = requireFiniteInteger(value, field, minimum);
  return parsed.ok
    ? parsed
    : fail(
        domainError("INVALID_VALUE", `${field} must be a positive integer`, {
          field,
        }),
      );
}

function parseSymbol(value: unknown): Result<MarketEvidenceSymbol> {
  return typeof value === "string" &&
    MARKET_EVIDENCE_SYMBOLS.some((symbol) => symbol === value)
    ? ok(value as MarketEvidenceSymbol)
    : invalid("symbol is not in the configured market universe", "symbol");
}

function parsePriceBase(
  input: Record<string, unknown>,
): Result<PriceFeatureRequestBase & { readonly required: boolean }> {
  const id = requireIdentifier(input.id, "id");
  const symbol = parseSymbol(input.symbol);
  const interval = input.interval;
  const required = parseRequired(input.required);
  if (
    !id.ok ||
    !symbol.ok ||
    typeof interval !== "string" ||
    !MARKET_INTERVALS.has(interval as MarketSeriesInterval) ||
    !required.ok
  ) {
    return invalid("price feature identity or source interval is invalid");
  }
  return ok({
    id: id.value,
    symbol: symbol.value,
    interval: interval as MarketSeriesInterval,
    required: required.value,
  });
}

function parseFeature(value: unknown): Result<AnalyticsFeatureRequest> {
  if (!isRecord(value)) return invalid("feature request must be an object");
  if (Object.hasOwn(value, "precision") || Object.hasOwn(value, "rounding")) {
    return invalid(
      "feature precision and rounding belong to analytics-features/v1",
    );
  }
  const kind = value.kind;
  if (typeof kind !== "string")
    return invalid("feature kind is required", "kind");

  if (
    kind === "close-return" ||
    kind === "maximum-drawdown" ||
    kind === "atr" ||
    kind === "realized-volatility" ||
    kind === "volatility-comparison"
  ) {
    const base = parsePriceBase(value);
    if (!base.ok) return base;
    if (kind === "close-return") {
      if (
        !onlyKeys(value, [
          "id",
          "kind",
          "symbol",
          "interval",
          "periods",
          "required",
        ])
      ) {
        return invalid("close-return request contains unsupported fields");
      }
      const periods = parsePositiveCount(value.periods, "periods");
      return periods.ok
        ? ok(Object.freeze({ ...base.value, kind, periods: periods.value }))
        : periods;
    }
    if (kind === "maximum-drawdown") {
      if (
        !onlyKeys(value, [
          "id",
          "kind",
          "symbol",
          "interval",
          "observationCount",
          "required",
        ])
      ) {
        return invalid("maximum-drawdown request contains unsupported fields");
      }
      const observationCount = parsePositiveCount(
        value.observationCount,
        "observationCount",
        2,
      );
      return observationCount.ok
        ? ok(
            Object.freeze({
              ...base.value,
              kind,
              observationCount: observationCount.value,
            }),
          )
        : observationCount;
    }
    if (kind === "atr") {
      if (
        !onlyKeys(value, [
          "id",
          "kind",
          "symbol",
          "interval",
          "period",
          "required",
        ])
      ) {
        return invalid("ATR request contains unsupported fields");
      }
      const period = parsePositiveCount(value.period, "period");
      return period.ok
        ? ok(Object.freeze({ ...base.value, kind, period: period.value }))
        : period;
    }
    if (kind === "realized-volatility") {
      if (
        !onlyKeys(value, [
          "id",
          "kind",
          "symbol",
          "interval",
          "observationCount",
          "required",
        ])
      ) {
        return invalid(
          "realized-volatility request contains unsupported fields",
        );
      }
      const observationCount = parsePositiveCount(
        value.observationCount,
        "observationCount",
      );
      return observationCount.ok
        ? ok(
            Object.freeze({
              ...base.value,
              kind,
              observationCount: observationCount.value,
            }),
          )
        : observationCount;
    }
    if (
      !onlyKeys(value, [
        "id",
        "kind",
        "symbol",
        "interval",
        "recentObservationCount",
        "referenceObservationCount",
        "required",
      ])
    ) {
      return invalid(
        "volatility-comparison request contains unsupported fields",
      );
    }
    const recentObservationCount = parsePositiveCount(
      value.recentObservationCount,
      "recentObservationCount",
    );
    const referenceObservationCount = parsePositiveCount(
      value.referenceObservationCount,
      "referenceObservationCount",
    );
    if (!recentObservationCount.ok) return recentObservationCount;
    if (!referenceObservationCount.ok) return referenceObservationCount;
    if (recentObservationCount.value !== referenceObservationCount.value) {
      return invalid(
        "realized-volatility comparison windows must contain equal return intervals",
        "referenceObservationCount",
      );
    }
    return ok(
      Object.freeze({
        ...base.value,
        kind,
        recentObservationCount: recentObservationCount.value,
        referenceObservationCount: referenceObservationCount.value,
      }),
    );
  }

  if (kind === "funding-change") {
    if (
      !onlyKeys(value, ["id", "kind", "symbol", "observationCount", "required"])
    ) {
      return invalid("funding-change request contains unsupported fields");
    }
    const id = requireIdentifier(value.id, "id");
    const symbol = parseSymbol(value.symbol);
    const observationCount = parsePositiveCount(
      value.observationCount,
      "observationCount",
      2,
    );
    const required = parseRequired(value.required);
    if (!id.ok || !symbol.ok || !observationCount.ok || !required.ok) {
      return invalid("funding-change request is invalid");
    }
    return ok(
      Object.freeze({
        id: id.value,
        kind,
        symbol: symbol.value,
        observationCount: observationCount.value,
        required: required.value,
      }),
    );
  }

  if (
    kind === "open-interest-absolute-change" ||
    kind === "open-interest-relative-change"
  ) {
    if (
      !onlyKeys(value, [
        "id",
        "kind",
        "symbol",
        "interval",
        "observationCount",
        "required",
      ])
    ) {
      return invalid("open-interest request contains unsupported fields");
    }
    const id = requireIdentifier(value.id, "id");
    const symbol = parseSymbol(value.symbol);
    const interval = value.interval;
    const observationCount = parsePositiveCount(
      value.observationCount,
      "observationCount",
      2,
    );
    const required = parseRequired(value.required);
    if (
      !id.ok ||
      !symbol.ok ||
      typeof interval !== "string" ||
      !OPEN_INTEREST_INTERVALS.has(interval as OpenInterestInterval) ||
      !observationCount.ok ||
      !required.ok
    ) {
      return invalid("open-interest request identity or interval is invalid");
    }
    return ok(
      Object.freeze({
        id: id.value,
        kind,
        symbol: symbol.value,
        interval: interval as OpenInterestInterval,
        observationCount: observationCount.value,
        required: required.value,
      }),
    );
  }

  if (kind === "liquidation-window") {
    if (!onlyKeys(value, ["id", "kind", "asset", "windowHours", "required"])) {
      return invalid("liquidation-window request contains unsupported fields");
    }
    const id = requireIdentifier(value.id, "id");
    const asset = value.asset;
    const windowHours = value.windowHours;
    const required = parseRequired(value.required);
    if (
      !id.ok ||
      typeof asset !== "string" ||
      !LIQUIDATION_EVIDENCE_ASSETS.some((item) => item === asset) ||
      typeof windowHours !== "number" ||
      !LIQUIDATION_WINDOW_HOURS.some((item) => item === windowHours) ||
      !required.ok
    ) {
      return invalid("liquidation-window request is invalid");
    }
    return ok(
      Object.freeze({
        id: id.value,
        kind,
        asset: asset as LiquidationTargetAsset,
        windowHours: windowHours as LiquidationWindowHours,
        required: required.value,
      }),
    );
  }

  return invalid("feature kind is unsupported", "kind");
}

function parseExternalEvidence(
  value: unknown,
): Result<ExternalEvidenceRequest> {
  if (!isRecord(value)) {
    return invalid("external evidence request must be an object");
  }
  if (!onlyKeys(value, ["family", "required"])) {
    return invalid("external evidence request contains unsupported fields");
  }
  const family = value.family;
  const required = parseRequired(value.required);
  if (
    typeof family !== "string" ||
    !EXTERNAL_EVIDENCE_FAMILIES.has(family as ExternalEvidenceFamily) ||
    !required.ok
  ) {
    return invalid("external evidence family or required flag is invalid");
  }
  return ok(
    Object.freeze({
      family: family as ExternalEvidenceFamily,
      required: required.value,
    }),
  );
}

export function createAnalyticsProfile(
  input: unknown,
): Result<AnalyticsProfile> {
  if (!isRecord(input)) return invalid("analytics profile must be an object");
  if (!onlyKeys(input, ["schemaVersion", "features", "externalEvidence"])) {
    return invalid("analytics profile contains unsupported fields");
  }
  if (input.schemaVersion !== ANALYTICS_PROFILE_SCHEMA_VERSION) {
    return invalid(
      "analytics profile schema version is unsupported",
      "schemaVersion",
    );
  }
  if (
    !Array.isArray(input.features) ||
    !Array.isArray(input.externalEvidence)
  ) {
    return invalid("analytics profile requests must be explicit arrays");
  }

  const features: AnalyticsFeatureRequest[] = [];
  const featureIds = new Set<string>();
  for (const request of input.features) {
    const parsed = parseFeature(request);
    if (!parsed.ok) return parsed;
    if (featureIds.has(parsed.value.id)) {
      return invalid("analytics profile contains a duplicate feature id", "id");
    }
    featureIds.add(parsed.value.id);
    features.push(parsed.value);
  }

  const externalEvidence: ExternalEvidenceRequest[] = [];
  const externalFamilies = new Set<ExternalEvidenceFamily>();
  for (const request of input.externalEvidence) {
    const parsed = parseExternalEvidence(request);
    if (!parsed.ok) return parsed;
    if (externalFamilies.has(parsed.value.family)) {
      return invalid(
        "analytics profile contains a duplicate external evidence family",
        "family",
      );
    }
    externalFamilies.add(parsed.value.family);
    externalEvidence.push(parsed.value);
  }
  if (features.length === 0 && externalEvidence.length === 0) {
    return invalid("analytics profile must request at least one output");
  }

  features.sort((left, right) => compareAnalyticsText(left.id, right.id));
  externalEvidence.sort((left, right) =>
    compareAnalyticsText(left.family, right.family),
  );
  return ok(
    Object.freeze({
      schemaVersion: ANALYTICS_PROFILE_SCHEMA_VERSION,
      features: Object.freeze(features),
      externalEvidence: Object.freeze(externalEvidence),
    }),
  );
}

export function hashAnalyticsProfile(profile: AnalyticsProfile) {
  return hashCanonical(profile);
}
