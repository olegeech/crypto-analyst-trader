import {
  ANALYTICS_FEATURES_VERSION_V2,
  createAnalyticsProfile,
} from "../../domain/analytics/analytics-profile.js";
import {
  createQualityProfile,
  hashQualityProfile,
} from "../../domain/quality/quality-profile.js";
import { qualityRoleForOutcome } from "../../domain/quality/quality-inputs.js";
import {
  createDecisionPolicy,
  isPlanningSymbol,
  type NumericComparison,
} from "../../domain/planning/decision-policy.js";
import { createPlanningPolicy } from "../../domain/planning/planning-policy.js";
import { createPortfolioRiskPolicy } from "../../domain/risk/portfolio-risk-policy.js";
import { parseDecimal } from "../../domain/shared/decimal.js";
import { deepFreeze } from "../../domain/shared/deep-freeze.js";
import { domainError } from "../../domain/shared/errors.js";
import { fail, ok } from "../../domain/shared/result.js";
import { closedRecord } from "../../domain/planning/planning-validation.js";

export const PROVISIONAL_M1_POLICY_VERSION = "provisional-m1-v1" as const;
export const PROVISIONAL_M1_EXTERNAL_AVAILABILITY = deepFreeze(
  (
    [
      "market-regime-score",
      "early-warning-risk",
      "liquidity-stress",
      "trap",
    ] as const
  ).map((family) => ({ family, status: "not-configured" as const })),
);

/** Application authority: only symbol/allocation are caller inputs; no policy overrides. */
export function createProvisionalM1Composition(input: unknown) {
  if (
    !closedRecord(input, ["symbol", "allocation"]) ||
    !isPlanningSymbol(input.symbol) ||
    typeof input.allocation !== "string" ||
    input.allocation.length > 128
  ) {
    return fail(
      domainError(
        "INVALID_VALUE",
        "invalid provisional M1 symbol or allocation",
      ),
    );
  }
  const allocation = parseDecimal(input.allocation);
  if (!allocation.ok || !allocation.value.isPositive()) {
    return fail(
      domainError(
        "INVALID_VALUE",
        "allocation must be a positive exact decimal",
      ),
    );
  }
  const symbol = input.symbol;
  const asset = {
    BTCUSDT: "BTC",
    ETHUSDT: "ETH",
    SOLUSDT: "SOL",
    DOGEUSDT: "DOGE",
  }[symbol];
  const version = PROVISIONAL_M1_POLICY_VERSION;
  const analyticsProfile = createAnalyticsProfile({
    schemaVersion: "analytics-profile/v1",
    features: [
      {
        id: "return-24h",
        kind: "close-return",
        symbol,
        interval: "1h",
        periods: 24,
        required: true,
      },
      {
        id: "return-3d",
        kind: "close-return",
        symbol,
        interval: "1d",
        periods: 3,
        required: true,
      },
      {
        id: "oi-24h",
        kind: "open-interest-relative-change",
        symbol,
        interval: "1h",
        observationCount: 25,
        required: true,
      },
      {
        id: "liquidation-12h",
        kind: "liquidation-window",
        asset,
        windowHours: 12,
        required: true,
      },
      {
        id: "atr-4h",
        kind: "atr",
        symbol,
        interval: "4h",
        period: 14,
        required: true,
      },
    ],
    externalEvidence: [],
  });
  if (!analyticsProfile.ok) return analyticsProfile;
  const qualityProfile = createQualityProfile({
    schemaVersion: "quality-profile/v1",
    profileVersion: "provisional-m1-quality/v2",
    liquidationHistoryScope: "requested-feature-windows/v1",
    roles: [
      "market",
      "analytics",
      "liquidation",
      ...analyticsProfile.value.features.map((f) =>
        qualityRoleForOutcome(f.id),
      ),
    ].map((id) => ({ id, required: true, maxAgeMs: 300000 })),
    metadataSkewMs: 1000,
    trust: [],
    penalties: [],
  });
  if (!qualityProfile.ok) return qualityProfile;
  const qualityProfileHash = hashQualityProfile(qualityProfile.value);
  if (!qualityProfileHash.ok) return qualityProfileHash;
  const condition = (selectorId: string, comparison: NumericComparison) => ({
    selectorId,
    comparison,
    threshold: "0",
  });
  const group = (
    id: string,
    add: ReturnType<typeof condition>[],
    reduce: ReturnType<typeof condition>[],
  ) => ({
    id,
    weight: "0.25",
    rules: [
      { id: `${id}-add`, target: "ADD_LONG", support: "100", conditions: add },
      {
        id: `${id}-reduce`,
        target: "REDUCE_LONG",
        support: "100",
        conditions: reduce,
      },
    ],
  });
  const decisionPolicy = createDecisionPolicy({
    schemaVersion: "decision-policy/v1",
    policyVersion: version,
    symbolApplicability: [symbol],
    selectors: [
      ...["return-24h", "return-3d"].map((id) => ({
        id,
        source: "native",
        requestId: id,
        kind: "close-return",
        field: "percent",
        symbol,
        required: true,
      })),
      {
        id: "oi-24h",
        source: "native",
        requestId: "oi-24h",
        kind: "open-interest-relative-change",
        field: "percent",
        symbol,
        required: true,
      },
      {
        id: "liquidation-12h",
        source: "native",
        requestId: "liquidation-12h",
        kind: "liquidation-window",
        field: "imbalance",
        asset,
        required: true,
      },
      {
        id: "funding",
        source: "ticker",
        symbol,
        field: "fundingRate",
        required: true,
      },
    ],
    groups: [
      group(
        "short-trend",
        [condition("return-24h", "gt")],
        [condition("return-24h", "lt")],
      ),
      group(
        "medium-trend",
        [condition("return-3d", "gt")],
        [condition("return-3d", "lt")],
      ),
      group(
        "derivatives",
        [condition("funding", "lte"), condition("oi-24h", "lte")],
        [condition("funding", "gt"), condition("oi-24h", "gt")],
      ),
      group(
        "liquidations",
        [condition("liquidation-12h", "gt")],
        [condition("liquidation-12h", "lt")],
      ),
    ],
    addLong: { supportThreshold: "75", minAgreeingGroups: 3 },
    reduceLong: { supportThreshold: "75", minAgreeingGroups: 3 },
    reductionFraction: "0.25",
  });
  if (!decisionPolicy.ok) return decisionPolicy;
  const planningPolicy = createPlanningPolicy({
    schemaVersion: "planning-policy/v1",
    policyVersion: version,
    atrSelector: {
      source: "native",
      requestId: "atr-4h",
      kind: "atr",
      field: "atr",
      symbol,
      required: true,
    },
    anchor: "bid-capped-below-ask/v1",
    entryRounding: "floor",
    quantityRounding: "floor",
    takeProfitRounding: "ceil",
    timeInForce: "GTC",
    levels: ["0.5", "1", "1.5", "2"].map((atrOffset) => ({
      atrOffset,
      allocationWeight: "0.25",
      takeProfitAtrDistance: "1",
    })),
  });
  if (!planningPolicy.ok) return planningPolicy;
  const riskPolicy = createPortfolioRiskPolicy({
    schemaVersion: "portfolio-risk-policy/v1",
    policyVersion: "m1-v1",
    maxAccountEvidenceAgeMs: 60000,
    marginReserveRatio: "0.1",
    maxDerivativesLeverage: "1",
    entryFeeRate: "0.0002",
    exitFeeRate: "0.00055",
    slippageBufferRate: "0.0005",
    minimumNetEdgeRate: "0.001",
  });
  if (!riskPolicy.ok) return riskPolicy;
  return ok(
    deepFreeze({
      policyVersion: version,
      symbol,
      allocation: allocation.value,
      analyticsProfile: analyticsProfile.value,
      analyticsFeaturesVersion: ANALYTICS_FEATURES_VERSION_V2,
      qualityProfile: qualityProfile.value,
      qualityProfileHash: qualityProfileHash.value,
      decisionPolicy: decisionPolicy.value,
      planningPolicy: planningPolicy.value,
      riskPolicy: riskPolicy.value,
      externalAdmissions: [],
      externalAvailability: PROVISIONAL_M1_EXTERNAL_AVAILABILITY,
      reviewPolicy: {
        schemaVersion: "daily-review-policy/v1" as const,
        policyVersion: version,
        provisionalRequiresReview: false as const,
        unconfiguredExternalRequiresReview: false as const,
        informationalCodes: ["PROVISIONAL_POLICY"] as const,
        exceptionalWarnings: [],
      },
      approvalPolicy: {
        schemaVersion: "daily-approval-policy/v1" as const,
        policyVersion: version,
        ttlMs: 900000 as const,
      },
    }),
  );
}

export type ProvisionalM1Composition = Extract<
  ReturnType<typeof createProvisionalM1Composition>,
  { ok: true }
>["value"];
