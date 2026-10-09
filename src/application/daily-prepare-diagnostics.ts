import type { AnalyticsProfile } from "../domain/analytics/analytics-profile.js";
import { createAnalyticsInputIdentity } from "../domain/analytics/analytics-inputs.js";
import { rehydrateLiquidationEvidenceBundle } from "../domain/liquidation/liquidation-evidence-bundle.js";
import { isCanonicalMissingBucketHistory } from "../domain/liquidation/liquidation-history-classification.js";
import { liquidationHistoryWindow } from "../domain/liquidation/liquidation-evidence-windows.js";
import { createMarketEvidenceBundle } from "../domain/market/market-evidence-bundle.js";
import { compareAnalyticsText } from "../domain/analytics/analytics-diagnostics.js";
import type { VersionedLiquidationEvidenceBundle } from "../domain/liquidation/liquidation-evidence-bundle.js";
import type { MarketEvidenceBundle } from "../domain/market/market-evidence-bundle.js";

export const MAX_REQUIRED_LIQUIDATION_VENUE_GROUPS = 20;

export interface RequiredLiquidationWindowDiagnostic {
  readonly requestId: string;
  readonly asset: string;
  readonly hours: number;
  readonly completeness: "complete" | "incomplete" | "unknown";
  readonly observedConstituentBuckets: number | null;
  readonly expectedConstituentBuckets: number | null;
  readonly missingByVenue:
    | readonly {
        readonly venue: string;
        readonly missingConstituentBuckets: number;
      }[]
    | null;
  readonly omittedVenueGroupCount: number | null;
  readonly omittedMissingConstituentBuckets: number | null;
}

function unknownWindow(
  request: Extract<
    AnalyticsProfile["features"][number],
    { readonly kind: "liquidation-window" }
  >,
): RequiredLiquidationWindowDiagnostic {
  return Object.freeze({
    requestId: request.id,
    asset: request.asset,
    hours: request.windowHours,
    completeness: "unknown",
    observedConstituentBuckets: null,
    expectedConstituentBuckets: null,
    missingByVenue: null,
    omittedVenueGroupCount: null,
    omittedMissingConstituentBuckets: null,
  });
}

function admittedSources(
  marketInput: MarketEvidenceBundle | undefined,
  liquidationInput: VersionedLiquidationEvidenceBundle | undefined,
):
  | {
      readonly market: MarketEvidenceBundle;
      readonly liquidation: VersionedLiquidationEvidenceBundle;
    }
  | undefined {
  if (marketInput === undefined || liquidationInput === undefined)
    return undefined;
  const market = createMarketEvidenceBundle(marketInput);
  const liquidation = rehydrateLiquidationEvidenceBundle(liquidationInput);
  if (!market.ok || !liquidation.ok) return undefined;
  const identity = createAnalyticsInputIdentity(
    market.value,
    liquidation.value,
  );
  if (!identity.ok || identity.value.compatibility !== "compatible")
    return undefined;
  return { market: market.value, liquidation: liquidation.value };
}

/** Bounded operator summary; unknown source/coverage never becomes a zero count. */
export function summarizeRequiredLiquidationWindows(
  profile: AnalyticsProfile,
  marketInput?: MarketEvidenceBundle,
  liquidationInput?: VersionedLiquidationEvidenceBundle,
): readonly RequiredLiquidationWindowDiagnostic[] {
  const requests = profile.features.filter(
    (
      request,
    ): request is Extract<
      AnalyticsProfile["features"][number],
      { readonly kind: "liquidation-window" }
    > => request.kind === "liquidation-window" && request.required,
  );
  if (requests.length === 0) return Object.freeze([]);

  const admitted = admittedSources(marketInput, liquidationInput);
  const historyAbsenceIsFullyClassified =
    admitted !== undefined &&
    (admitted.liquidation.status === "complete" ||
      isCanonicalMissingBucketHistory(admitted.liquidation));
  return Object.freeze(
    requests.map((request) => {
      if (
        admitted === undefined ||
        admitted.liquidation.status === "failed" ||
        admitted.liquidation.coverageProof !== "complete"
      )
        return unknownWindow(request);

      const target = admitted.liquidation.targets.find(
        (item) => item.asset === request.asset,
      );
      const sourceWindow = target?.windows.find(
        (item) => item.hours === request.windowHours,
      );
      if (target === undefined || sourceWindow === undefined)
        return unknownWindow(request);

      const allBuckets = liquidationHistoryWindow(
        Date.parse(admitted.liquidation.bundleCutoff),
      ).epochs;
      const requestedBuckets = new Set(allBuckets.slice(-request.windowHours));
      const missingByVenue = new Map<string, number>();
      for (const constituent of target.constituents) {
        const observed = new Set(
          constituent.observations
            .map((row) => Date.parse(row.timestamp))
            .filter((epoch) => requestedBuckets.has(epoch)),
        );
        const missing = request.windowHours - observed.size;
        if (missing > 0)
          missingByVenue.set(
            constituent.exchange,
            (missingByVenue.get(constituent.exchange) ?? 0) + missing,
          );
      }
      const groups = [...missingByVenue]
        .map(([venue, missingConstituentBuckets]) => ({
          venue,
          missingConstituentBuckets,
        }))
        .sort((left, right) => compareAnalyticsText(left.venue, right.venue));
      const shown = groups.slice(0, MAX_REQUIRED_LIQUIDATION_VENUE_GROUPS);
      const omitted = groups.slice(MAX_REQUIRED_LIQUIDATION_VENUE_GROUPS);
      return Object.freeze({
        requestId: request.id,
        asset: request.asset,
        hours: request.windowHours,
        completeness:
          sourceWindow.complete && historyAbsenceIsFullyClassified
            ? "complete"
            : "incomplete",
        observedConstituentBuckets: sourceWindow.observedConstituentBuckets,
        expectedConstituentBuckets: sourceWindow.expectedConstituentBuckets,
        missingByVenue: Object.freeze(shown),
        omittedVenueGroupCount: omitted.length,
        omittedMissingConstituentBuckets: omitted.reduce(
          (total, item) => total + item.missingConstituentBuckets,
          0,
        ),
      });
    }),
  );
}
