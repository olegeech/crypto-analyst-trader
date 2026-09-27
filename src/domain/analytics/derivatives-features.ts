import type { AnalyticsOutputOutcome } from "./analytics-sufficiency.js";
import type {
  AnalyticsFeatureRequest,
  AnalyticsProfile,
} from "./analytics-profile.js";
import {
  normalizeAnalyticsReasonCodes,
  type AnalyticsReasonCode,
} from "./analytics-diagnostics.js";
import {
  createAnalyticsInputIdentity,
  type AnalyticsInputIdentity,
} from "./analytics-inputs.js";
import {
  type LiquidationEvidenceBundle,
  type LiquidationTargetAsset,
  type LiquidationWindowEvidence,
} from "../liquidation/liquidation-evidence-bundle.js";
import {
  fundingIntervalMilliseconds,
  marketIntervalMilliseconds,
} from "../market/market-evidence-windows.js";
import {
  type MarketEvidenceBundle,
  type MarketEvidenceSymbol,
} from "../market/market-evidence-bundle.js";
import {
  DecimalValue,
  RoundingMode,
  type DecimalValue as Decimal,
} from "../shared/decimal.js";
import type { UtcTimestamp } from "../shared/time.js";

export type DerivativeFeatureKind = Extract<
  AnalyticsFeatureRequest["kind"],
  | "funding-change"
  | "open-interest-absolute-change"
  | "open-interest-relative-change"
  | "liquidation-window"
>;

export interface DerivativeObservationWindow {
  readonly from: UtcTimestamp;
  readonly to: UtcTimestamp;
  readonly observationCount: number;
  readonly cadenceMs: number;
}

export interface DerivativeLiquidationWindow {
  readonly from: UtcTimestamp;
  readonly to: UtcTimestamp;
  readonly hours: number;
  readonly observedConstituentBuckets: number;
  readonly expectedConstituentBuckets: number;
  readonly complete: boolean;
}

export type DerivativeFeatureValue =
  | {
      readonly type: "funding-change";
      readonly change: Decimal;
      readonly unit: "funding-rate";
    }
  | {
      readonly type: "open-interest-absolute-change";
      readonly change: Decimal;
      readonly unit: "source-open-interest";
    }
  | {
      readonly type: "open-interest-relative-change";
      readonly percent: Decimal;
      readonly unit: "percent";
    }
  | {
      readonly type: "liquidation-window";
      readonly longUsd: Decimal;
      readonly shortUsd: Decimal;
      readonly totalUsd: Decimal;
      readonly imbalance?: Decimal;
      readonly unit: "USD";
    };

export interface DerivativeFeatureOutcome extends AnalyticsOutputOutcome {
  readonly kind: DerivativeFeatureKind;
  readonly symbol?: MarketEvidenceSymbol;
  readonly asset?: LiquidationTargetAsset;
  readonly window?: DerivativeObservationWindow | DerivativeLiquidationWindow;
  readonly coverageProof?: "complete" | "incomplete";
  readonly historyProof?: "complete" | "incomplete";
  readonly value?: DerivativeFeatureValue;
}

type DerivativeRequest = Extract<
  AnalyticsFeatureRequest,
  { readonly kind: DerivativeFeatureKind }
>;

type CadencedSelection<T> =
  | { readonly ok: true; readonly observations: readonly T[] }
  | { readonly ok: false; readonly reason: AnalyticsReasonCode };

function isDerivativeRequest(
  request: AnalyticsFeatureRequest,
): request is DerivativeRequest {
  return (
    request.kind === "funding-change" ||
    request.kind === "open-interest-absolute-change" ||
    request.kind === "open-interest-relative-change" ||
    request.kind === "liquidation-window"
  );
}

function hasCadence<T extends { readonly timestamp: UtcTimestamp }>(
  observations: readonly T[],
  cadenceMs: number,
): boolean {
  if (!Number.isSafeInteger(cadenceMs) || cadenceMs <= 0) return false;
  for (let index = 0; index < observations.length; index += 1) {
    const current = observations[index];
    const previous = observations[index - 1];
    if (current === undefined) return false;
    if (
      previous !== undefined &&
      Date.parse(current.timestamp) - Date.parse(previous.timestamp) !==
        cadenceMs
    ) {
      return false;
    }
  }
  return true;
}

function selectTrailingCadenced<T extends { readonly timestamp: UtcTimestamp }>(
  observations: readonly T[],
  count: number,
  cadenceMs: number,
  cutoff: UtcTimestamp,
): CadencedSelection<T> {
  if (observations.length < count) {
    return { ok: false, reason: "INSUFFICIENT_WINDOW" };
  }
  const selected = observations.slice(observations.length - count);
  if (
    selected.some((item) => Date.parse(item.timestamp) > Date.parse(cutoff)) ||
    !hasCadence(selected, cadenceMs)
  ) {
    return { ok: false, reason: "INSUFFICIENT_WINDOW" };
  }
  const first = selected[0];
  const last = selected[selected.length - 1];
  if (
    first === undefined ||
    last === undefined ||
    selected.some((item, index) => {
      const previous = selected[index - 1];
      return (
        previous !== undefined &&
        Date.parse(item.timestamp) <= Date.parse(previous.timestamp)
      );
    })
  ) {
    return { ok: false, reason: "INSUFFICIENT_WINDOW" };
  }
  return { ok: true, observations: selected };
}

function observationWindow(
  observations: readonly { readonly timestamp: UtcTimestamp }[],
  cadenceMs: number,
): DerivativeObservationWindow | undefined {
  const first = observations[0];
  const last = observations[observations.length - 1];
  if (first === undefined || last === undefined) return undefined;
  return Object.freeze({
    from: first.timestamp,
    to: last.timestamp,
    observationCount: observations.length,
    cadenceMs,
  });
}

function unavailable(
  request: DerivativeRequest,
  reasons: readonly AnalyticsReasonCode[],
  proof?: Pick<LiquidationEvidenceBundle, "coverageProof" | "historyProof">,
  window?: DerivativeObservationWindow | DerivativeLiquidationWindow,
): DerivativeFeatureOutcome {
  return Object.freeze({
    requestId: request.id,
    status: "unavailable",
    reasonCodes: normalizeAnalyticsReasonCodes(reasons),
    kind: request.kind,
    ...(request.kind === "liquidation-window"
      ? {
          asset: request.asset,
          ...(proof === undefined
            ? {}
            : {
                coverageProof: proof.coverageProof,
                historyProof: proof.historyProof,
              }),
        }
      : { symbol: request.symbol }),
    ...(window === undefined ? {} : { window }),
  });
}

function complete(
  request: DerivativeRequest,
  window: DerivativeObservationWindow,
  value: DerivativeFeatureValue,
): DerivativeFeatureOutcome {
  return Object.freeze({
    requestId: request.id,
    status: "complete",
    reasonCodes: normalizeAnalyticsReasonCodes([]),
    kind: request.kind,
    ...(request.kind === "liquidation-window"
      ? { asset: request.asset }
      : { symbol: request.symbol }),
    window,
    value: Object.freeze(value),
  });
}

function featureReasonForLiquidationProofs(
  bundle: LiquidationEvidenceBundle,
): AnalyticsReasonCode[] {
  const reasons: AnalyticsReasonCode[] = [];
  if (bundle.coverageProof !== "complete") {
    reasons.push("INCOMPLETE_LIQUIDATION_COVERAGE");
  }
  if (bundle.historyProof !== "complete") {
    reasons.push("INCOMPLETE_LIQUIDATION_HISTORY");
  }
  return reasons;
}

function canJoinLiquidation(
  inputIdentity: AnalyticsInputIdentity | undefined,
): boolean {
  return inputIdentity?.compatibility === "compatible";
}

function liquidationFeature(
  request: Extract<DerivativeRequest, { readonly kind: "liquidation-window" }>,
  liquidation: LiquidationEvidenceBundle | undefined,
  inputIdentity: AnalyticsInputIdentity | undefined,
): DerivativeFeatureOutcome {
  if (liquidation === undefined) {
    return unavailable(request, ["MISSING_LIQUIDATION_EVIDENCE"]);
  }
  const proof = {
    coverageProof: liquidation.coverageProof,
    historyProof: liquidation.historyProof,
  } as const;
  if (!canJoinLiquidation(inputIdentity)) {
    return unavailable(request, ["INPUT_IDENTITY_MISMATCH"], proof);
  }

  const target = liquidation.targets.find(
    (item) => item.asset === request.asset,
  );
  const window = target?.windows.find(
    (item) => item.hours === request.windowHours,
  );
  const proofReasons = featureReasonForLiquidationProofs(liquidation);
  if (
    liquidation.status === "failed" ||
    window === undefined ||
    window.observedConstituentBuckets === 0
  ) {
    return unavailable(
      request,
      ["MISSING_LIQUIDATION_EVIDENCE", ...proofReasons],
      proof,
      window === undefined ? undefined : liquidationWindow(window),
    );
  }

  if (
    !window.complete &&
    !proofReasons.includes("INCOMPLETE_LIQUIDATION_HISTORY")
  ) {
    proofReasons.push("INCOMPLETE_LIQUIDATION_HISTORY");
  }
  if (window.totalUsd.isZero()) {
    const value: DerivativeFeatureValue = {
      type: "liquidation-window",
      longUsd: window.longUsd,
      shortUsd: window.shortUsd,
      totalUsd: window.totalUsd,
      unit: "USD",
    };
    return Object.freeze({
      requestId: request.id,
      status: "partial",
      reasonCodes: normalizeAnalyticsReasonCodes([
        ...proofReasons,
        "ZERO_LIQUIDATION_NOTIONAL",
      ]),
      kind: request.kind,
      asset: request.asset,
      window: liquidationWindow(window),
      coverageProof: proof.coverageProof,
      historyProof: proof.historyProof,
      value: Object.freeze(value),
    });
  }

  const imbalance = window.shortUsd
    .subtract(window.longUsd)
    .divide(window.totalUsd, 18, RoundingMode.HALF_EVEN);
  if (!imbalance.ok) {
    return unavailable(
      request,
      [...proofReasons, "ZERO_LIQUIDATION_NOTIONAL"],
      proof,
    );
  }
  const value: DerivativeFeatureValue = {
    type: "liquidation-window",
    longUsd: window.longUsd,
    shortUsd: window.shortUsd,
    totalUsd: window.totalUsd,
    imbalance: imbalance.value,
    unit: "USD",
  };
  const status =
    liquidation.status === "complete" &&
    proof.coverageProof === "complete" &&
    proof.historyProof === "complete" &&
    window.complete
      ? "complete"
      : "partial";
  return Object.freeze({
    requestId: request.id,
    status,
    reasonCodes: normalizeAnalyticsReasonCodes(proofReasons),
    kind: request.kind,
    asset: request.asset,
    window: liquidationWindow(window),
    coverageProof: proof.coverageProof,
    historyProof: proof.historyProof,
    value: Object.freeze(value),
  });
}

function liquidationWindow(
  window: LiquidationWindowEvidence,
): DerivativeLiquidationWindow {
  return Object.freeze({
    from: window.from,
    to: window.to,
    hours: window.hours,
    observedConstituentBuckets: window.observedConstituentBuckets,
    expectedConstituentBuckets: window.expectedConstituentBuckets,
    complete: window.complete,
  });
}

function computeFundingChange(
  market: MarketEvidenceBundle,
  request: Extract<DerivativeRequest, { readonly kind: "funding-change" }>,
): DerivativeFeatureOutcome {
  const source = market.symbols.find((item) => item.symbol === request.symbol);
  const instrument = source?.instrument;
  if (source === undefined || instrument === undefined) {
    return unavailable(request, ["INSUFFICIENT_WINDOW"]);
  }
  const cadenceMs = fundingIntervalMilliseconds(instrument.fundingInterval);
  const selection = selectTrailingCadenced(
    source.funding,
    request.observationCount,
    cadenceMs,
    market.bundleCutoff,
  );
  if (!selection.ok) return unavailable(request, [selection.reason]);
  const first = selection.observations[0];
  const last = selection.observations[selection.observations.length - 1];
  const window = observationWindow(selection.observations, cadenceMs);
  if (first === undefined || last === undefined || window === undefined) {
    return unavailable(request, ["INSUFFICIENT_WINDOW"]);
  }
  return complete(request, window, {
    type: "funding-change",
    change: last.rate.subtract(first.rate),
    unit: "funding-rate",
  });
}

function openInterestFeature(
  market: MarketEvidenceBundle,
  request: Extract<
    DerivativeRequest,
    {
      readonly kind:
        "open-interest-absolute-change" | "open-interest-relative-change";
    }
  >,
): DerivativeFeatureOutcome {
  const source = market.symbols.find((item) => item.symbol === request.symbol);
  const series = source?.openInterest.find(
    (item) => item.interval === request.interval,
  );
  if (series === undefined) {
    return unavailable(request, ["INSUFFICIENT_WINDOW"]);
  }
  const selection = selectTrailingCadenced(
    series.observations,
    request.observationCount,
    marketIntervalMilliseconds(request.interval),
    market.bundleCutoff,
  );
  if (!selection.ok) return unavailable(request, [selection.reason]);
  const first = selection.observations[0];
  const last = selection.observations[selection.observations.length - 1];
  const window = observationWindow(
    selection.observations,
    marketIntervalMilliseconds(request.interval),
  );
  if (first === undefined || last === undefined || window === undefined) {
    return unavailable(request, ["INSUFFICIENT_WINDOW"]);
  }
  if (request.kind === "open-interest-absolute-change") {
    return complete(request, window, {
      type: request.kind,
      change: last.openInterest.subtract(first.openInterest),
      unit: "source-open-interest",
    });
  }
  if (first.openInterest.isZero()) {
    return unavailable(
      request,
      ["ZERO_OPEN_INTEREST_REFERENCE"],
      undefined,
      window,
    );
  }
  const ratio = last.openInterest
    .subtract(first.openInterest)
    .divide(first.openInterest, 18, RoundingMode.HALF_EVEN);
  if (!ratio.ok) {
    return unavailable(
      request,
      ["ZERO_OPEN_INTEREST_REFERENCE"],
      undefined,
      window,
    );
  }
  const hundred = decimalConstant("100");
  return complete(request, window, {
    type: request.kind,
    percent: ratio.value.multiply(hundred),
    unit: "percent",
  });
}

function decimalConstant(value: string): Decimal {
  const result = DecimalValue.fromString(value);
  if (!result.ok) {
    throw new Error(`invalid analytics decimal constant: ${value}`);
  }
  return result.value;
}

export function computeDerivativeFeatures(
  market: MarketEvidenceBundle,
  liquidation: LiquidationEvidenceBundle | undefined,
  profile: AnalyticsProfile,
): readonly DerivativeFeatureOutcome[] {
  const hasLiquidationRequest = profile.features.some(
    (request) => request.kind === "liquidation-window",
  );
  const inputIdentity =
    hasLiquidationRequest && liquidation !== undefined
      ? createAnalyticsInputIdentity(market, liquidation)
      : undefined;
  const identity = inputIdentity?.ok === true ? inputIdentity.value : undefined;
  return Object.freeze(
    profile.features.flatMap((request) => {
      if (!isDerivativeRequest(request)) return [];
      if (request.kind === "funding-change") {
        return [computeFundingChange(market, request)];
      }
      if (
        request.kind === "open-interest-absolute-change" ||
        request.kind === "open-interest-relative-change"
      ) {
        return [openInterestFeature(market, request)];
      }
      if (request.kind !== "liquidation-window") return [];
      return [liquidationFeature(request, liquidation, identity)];
    }),
  );
}
