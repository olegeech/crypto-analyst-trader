import {
  rehydrateAnalyticsEvidenceBundle,
  type AnalyticsEvidenceBundle,
} from "../analytics/analytics-evidence-bundle.js";
import { ANALYTICS_FEATURES_VERSION_V2 } from "../analytics/analytics-profile.js";
import { compareAnalyticsText } from "../analytics/analytics-diagnostics.js";
import { qualityRoleForOutcome } from "./quality-inputs.js";
import { createAnalyticsInputIdentity } from "../analytics/analytics-inputs.js";
import { validateExternalRegimeEvidence } from "../analytics/external-regime-evidence.js";
import { hashCanonical } from "../identity/canonical-serialization.js";
import { isCanonicalMissingBucketHistory } from "../liquidation/liquidation-history-classification.js";
import {
  marketEvidenceContentHash,
  type MarketEvidenceBundle,
} from "../market/market-evidence-bundle.js";
import {
  marketIntervalMilliseconds,
  fundingIntervalMilliseconds,
} from "../market/market-evidence-windows.js";
import type { VersionedLiquidationEvidenceBundle } from "../liquidation/liquidation-evidence-bundle.js";
import type { UtcTimestamp } from "../shared/time.js";
import {
  INVARIANT_QUALITY_REASONS,
  type DataQualityFinding,
  type QualityReasonCode,
} from "./data-quality-findings.js";
import type { QualityInputRecord } from "./quality-inputs.js";
import type { QualityProfile } from "./quality-profile.js";

function analyticsDeclaresVerifiedRequiredWindows(
  analytics: AnalyticsEvidenceBundle,
  market: MarketEvidenceBundle,
  liquidation: VersionedLiquidationEvidenceBundle,
  qualityProfile: QualityProfile,
): boolean {
  if (analytics.featuresVersion !== ANALYTICS_FEATURES_VERSION_V2) return false;
  const expectedIdentity = createAnalyticsInputIdentity(market, liquidation);
  const expectedIdentityHash = expectedIdentity.ok
    ? hashCanonical(expectedIdentity.value)
    : undefined;
  const claimedIdentityHash = hashCanonical(analytics.inputIdentity);
  if (
    !expectedIdentityHash?.ok ||
    !claimedIdentityHash.ok ||
    expectedIdentityHash.value !== claimedIdentityHash.value
  )
    return false;

  const requests = analytics.profile.features.filter(
    (
      request,
    ): request is Extract<
      AnalyticsEvidenceBundle["profile"]["features"][number],
      { readonly kind: "liquidation-window" }
    > => request.kind === "liquidation-window" && request.required,
  );
  if (requests.length === 0) return false;
  for (const request of requests) {
    const role = qualityRoleForOutcome(request.id);
    if (
      qualityProfile.roles.find((item) => item.id === role)?.required !== true
    )
      return false;
    const target = liquidation.targets.find(
      (item) => item.asset === request.asset,
    );
    const sourceWindow = target?.windows.find(
      (item) => item.hours === request.windowHours,
    );
    const outcomes = analytics.derivativeFeatures.filter(
      (item) => item.requestId === request.id,
    );
    const outcome = outcomes[0];
    const featureWindow = outcome?.window;
    if (
      outcomes.length !== 1 ||
      outcome?.kind !== "liquidation-window" ||
      outcome.asset !== request.asset ||
      sourceWindow === undefined ||
      featureWindow === undefined ||
      !("hours" in featureWindow) ||
      featureWindow.hours !== sourceWindow.hours ||
      featureWindow.from !== sourceWindow.from ||
      featureWindow.to !== sourceWindow.to ||
      featureWindow.observedConstituentBuckets !==
        sourceWindow.observedConstituentBuckets ||
      featureWindow.expectedConstituentBuckets !==
        sourceWindow.expectedConstituentBuckets ||
      featureWindow.complete !== sourceWindow.complete ||
      outcome.coverageProof !== liquidation.coverageProof ||
      outcome.historyProof !== liquidation.historyProof ||
      outcome.status !== "complete" ||
      !sourceWindow.complete
    )
      return false;
  }
  return true;
}

/** Classify supplied facts only. Missing roles, trust and confidence belong to the host. */
export function classifyQualityEvidence(
  records: readonly QualityInputRecord[],
  profile: QualityProfile,
  bundleCutoff: UtcTimestamp,
  evaluationTime: UtcTimestamp,
): DataQualityFinding[] {
  const findings: DataQualityFinding[] = [];
  const cutoff = Date.parse(bundleCutoff);
  const evaluation = Date.parse(evaluationTime);
  const sourceHashes = new Map<
    NonNullable<QualityInputRecord["value"]>,
    ReturnType<typeof hashCanonical>
  >();
  function sourceHash(value: NonNullable<QualityInputRecord["value"]>) {
    let result = sourceHashes.get(value);
    if (result === undefined) {
      result = hashCanonical(value);
      sourceHashes.set(value, result);
    }
    return result;
  }
  const policy = (role: string) => profile.roles.find((p) => p.id === role);
  const add = (role: string, reasonCode: QualityReasonCode) => {
    findings.push({
      role,
      reasonCode,
      blocking:
        INVARIANT_QUALITY_REASONS.has(reasonCode) ||
        (policy(role)?.required ?? true),
    });
  };
  if (cutoff > evaluation) add("assessment", "FUTURE_INFORMATION");
  function clocks(
    role: string,
    asOf: UtcTimestamp,
    validForMs?: number,
    generatedAt?: UtcTimestamp,
  ) {
    const information = Date.parse(asOf);
    if (information > cutoff) add(role, "FUTURE_INFORMATION");
    const age = policy(role)?.maxAgeMs;
    if (
      (validForMs !== undefined && evaluation >= information + validForMs) ||
      (age !== undefined && evaluation >= information + age)
    )
      add(role, "STALE_EVIDENCE");
    if (
      generatedAt !== undefined &&
      (Date.parse(generatedAt) < information ||
        Date.parse(generatedAt) > evaluation)
    )
      add(role, "INVALID_GENERATION_TIME");
  }
  function diagnostics(
    role: string,
    rows: readonly { readonly code: string }[],
    ignoreCanonicalMissingBuckets = false,
  ) {
    const mapping: Record<string, QualityReasonCode> = {
      "duplicate-observation": "DUPLICATE_OBSERVATION",
      "duplicate-market": "DUPLICATE_OBSERVATION",
      "contradictory-observation": "INVALID_EVIDENCE",
      "invalid-observation": "INVALID_EVIDENCE",
      "wrong-identity": "LINEAGE_MISMATCH",
      "future-observation": "FUTURE_INFORMATION",
      "non-monotonic-time": "INCOMPATIBLE_WINDOW",
      "unfinished-candle": "INCOMPATIBLE_WINDOW",
      "incompatible-metadata": "INCOMPATIBLE_WINDOW",
      "missing-bucket": "GAPPED_WINDOW",
      "missing-required-data": "GAPPED_WINDOW",
      "history-incomplete": "GAPPED_WINDOW",
    };
    for (const row of rows) {
      if (ignoreCanonicalMissingBuckets && row.code === "missing-bucket")
        continue;
      if (mapping[row.code]) add(role, mapping[row.code]!);
    }
  }
  function sourceTime(role: string, timestamp: UtcTimestamp | undefined) {
    if (timestamp !== undefined && Date.parse(timestamp) > cutoff)
      add(role, "FUTURE_INFORMATION");
  }
  function window(
    role: string,
    observations: readonly { readonly timestamp: UtcTimestamp }[],
    stepMs: number,
  ) {
    for (let index = 1; index < observations.length; index++) {
      const delta =
        Date.parse(observations[index]!.timestamp) -
        Date.parse(observations[index - 1]!.timestamp);
      if (delta === 0) add(role, "DUPLICATE_OBSERVATION");
      else if (delta < 0 || delta % stepMs !== 0)
        add(role, "INCOMPATIBLE_WINDOW");
      else if (delta > stepMs) add(role, "GAPPED_WINDOW");
    }
  }
  const markets = records
    .filter((r) => r.role === "market" && r.value !== undefined)
    .map((r) => r.value as MarketEvidenceBundle);
  const liquidations = records
    .filter((r) => r.role === "liquidation" && r.value !== undefined)
    .map((r) => r.value as VersionedLiquidationEvidenceBundle);
  const scopedHistoryLiquidations =
    new Set<VersionedLiquidationEvidenceBundle>();
  if (profile.liquidationHistoryScope === "requested-feature-windows/v1") {
    for (const liquidation of liquidations) {
      if (!isCanonicalMissingBucketHistory(liquidation)) continue;
      for (const market of markets) {
        for (const record of records) {
          if (
            record.role !== "analytics" ||
            record.value === undefined ||
            record.failures.length > 0
          )
            continue;
          if (
            analyticsDeclaresVerifiedRequiredWindows(
              record.value as AnalyticsEvidenceBundle,
              market,
              liquidation,
              profile,
            )
          )
            scopedHistoryLiquidations.add(liquidation);
        }
      }
    }
  }
  for (const market of markets)
    for (const liquidation of liquidations) {
      const identity = createAnalyticsInputIdentity(market, liquidation);
      if (!identity.ok || identity.value.compatibility !== "compatible")
        add("liquidation", "LINEAGE_MISMATCH");
    }
  for (const record of records) {
    for (const failure of record.failures) add(record.role, failure);
    if (record.value === undefined) continue;
    const fullHash = sourceHash(record.value);
    if (
      !fullHash.ok ||
      (record.bundleHash !== undefined && record.bundleHash !== fullHash.value)
    )
      add(record.role, "HASH_MISMATCH");
    if (record.role === "market" || record.role === "liquidation") {
      const value = record.value as
        MarketEvidenceBundle | VersionedLiquidationEvidenceBundle;
      if (value.bundleCutoff !== bundleCutoff)
        add(record.role, "LINEAGE_MISMATCH");
      clocks(record.role, value.bundleCutoff);
      if (
        Date.parse(value.collectionStartedAt) >
          evaluation + profile.metadataSkewMs ||
        Date.parse(value.collectionEndedAt) >
          evaluation + profile.metadataSkewMs
      )
        add(record.role, "METADATA_CLOCK_SKEW");
      diagnostics(
        record.role,
        value.diagnostics,
        record.role === "liquidation" &&
          scopedHistoryLiquidations.has(
            value as VersionedLiquidationEvidenceBundle,
          ),
      );
      const content =
        record.role === "market"
          ? marketEvidenceContentHash(value as MarketEvidenceBundle)
          : fullHash;
      if (
        !content.ok ||
        (record.contentHash !== undefined &&
          record.contentHash !== content.value)
      )
        add(record.role, "HASH_MISMATCH");
      const refs =
        record.role === "market"
          ? (value as MarketEvidenceBundle).evidence
          : record.evidenceRef
            ? [record.evidenceRef]
            : [];
      for (const ref of refs) {
        clocks(record.role, ref.asOf, ref.validForMs);
        if (
          ref.kind === `${record.role}-evidence-bundle` &&
          content.ok &&
          ref.contentHash !== content.value
        )
          add(record.role, "HASH_MISMATCH");
      }
      if (
        record.evidenceRef &&
        content.ok &&
        record.evidenceRef.contentHash !== content.value
      )
        add(record.role, "HASH_MISMATCH");
      if (record.role === "market") {
        const market = value as MarketEvidenceBundle;
        if (market.status !== "complete") add("market", "INCOMPLETE_EVIDENCE");
        for (const row of [
          ...market.diagnostics,
          ...market.symbols.flatMap((s) => s.diagnostics),
        ])
          sourceTime("market", row.sourceTimestamp);
        for (const symbol of market.symbols) {
          diagnostics("market", symbol.diagnostics);
          sourceTime("market", symbol.instrument?.sourceTimestamp);
          sourceTime("market", symbol.ticker?.observedAt);
          for (const series of [...symbol.ohlcv, ...symbol.openInterest])
            window(
              "market",
              series.observations,
              marketIntervalMilliseconds(series.interval),
            );
          if (symbol.instrument)
            window(
              "market",
              symbol.funding,
              fundingIntervalMilliseconds(symbol.instrument.fundingInterval),
            );
          for (const observation of [
            ...symbol.ohlcv.flatMap((s) => s.observations),
            ...symbol.funding,
            ...symbol.openInterest.flatMap((s) => s.observations),
          ])
            sourceTime("market", observation.timestamp);
        }
      } else {
        const liquidation = value as VersionedLiquidationEvidenceBundle;
        const scopedMissingBuckets = scopedHistoryLiquidations.has(liquidation);
        if (liquidation.coverageProof !== "complete")
          add("liquidation", "INCOMPLETE_LIQUIDATION_COVERAGE");
        if (liquidation.historyProof !== "complete" && !scopedMissingBuckets)
          add("liquidation", "INCOMPLETE_LIQUIDATION_HISTORY");
        if (
          liquidation.marketEvidence.runId !== liquidation.runId ||
          liquidation.marketEvidence.bundleCutoff !== liquidation.bundleCutoff
        )
          add("liquidation", "LINEAGE_MISMATCH");
        for (const target of liquidation.targets) {
          if (
            target.windows.some((w) => !w.complete) &&
            (!scopedMissingBuckets || target.constituents.length === 0)
          )
            add("liquidation", "GAPPED_WINDOW");
          for (const row of target.constituents.flatMap((c) => c.observations))
            sourceTime("liquidation", row.timestamp);
        }
      }
    } else {
      const analytics = record.value as AnalyticsEvidenceBundle;
      const parsed = rehydrateAnalyticsEvidenceBundle(analytics);
      if (!parsed.ok)
        add(
          "analytics",
          parsed.error.code === "PLAN_HASH_MISMATCH" ||
            parsed.error.code === "INVALID_HASH"
            ? "HASH_MISMATCH"
            : "INVALID_EVIDENCE",
        );
      if (
        record.contentHash !== undefined &&
        record.contentHash !== analytics.contentHash
      )
        add("analytics", "HASH_MISMATCH");
      const identity = analytics.inputIdentity;
      clocks("analytics", identity.bundleCutoff);
      if (
        identity.bundleCutoff !== bundleCutoff ||
        identity.compatibility !== "compatible"
      )
        add("analytics", "LINEAGE_MISMATCH");
      for (const market of markets) {
        const expected = createAnalyticsInputIdentity(market);
        if (
          !expected.ok ||
          [
            "runId",
            "universeVersion",
            "bundleCutoff",
            "marketContentHash",
            "marketBundleHash",
          ].some(
            (key) =>
              identity[key as keyof typeof identity] !==
              (expected.ok
                ? expected.value[key as keyof typeof identity]
                : undefined),
          )
        )
          add("analytics", "LINEAGE_MISMATCH");
      }
      if (identity.liquidationBundleHash !== undefined)
        for (const liquidation of liquidations) {
          const hash = sourceHash(liquidation);
          if (
            !hash.ok ||
            identity.liquidationBundleHash !== hash.value ||
            identity.liquidationRunId !== liquidation.runId ||
            identity.liquidationUniverseVersion !==
              liquidation.marketEvidence.universeVersion ||
            identity.liquidationBundleCutoff !== liquidation.bundleCutoff ||
            identity.liquidationMarketContentHash !==
              liquidation.marketEvidence.contentHash
          )
            add("analytics", "LINEAGE_MISMATCH");
        }
      const outcomes = [
        ...analytics.priceFeatures,
        ...analytics.derivativeFeatures,
        ...analytics.externalOutcomes,
      ];
      for (const outcome of outcomes) {
        const role = qualityRoleForOutcome(outcome.requestId);
        if (role.startsWith("analytics:")) clocks(role, identity.bundleCutoff);
        if (outcome.status !== "complete")
          add(
            role,
            outcome.status === "partial"
              ? "PARTIAL_ANALYTICS"
              : "UNAVAILABLE_ANALYTICS",
          );
        for (const reason of outcome.reasonCodes) {
          if (reason === "INPUT_IDENTITY_MISMATCH")
            add(role, "LINEAGE_MISMATCH");
          if (reason === "EXTERNAL_EVIDENCE_HASH_MISMATCH")
            add(role, "HASH_MISMATCH");
          if (reason === "EXTERNAL_EVIDENCE_AFTER_CUTOFF")
            add(role, "FUTURE_INFORMATION");
          if (reason === "INSUFFICIENT_WINDOW") add(role, "GAPPED_WINDOW");
          if (
            reason === "INCOMPLETE_LIQUIDATION_COVERAGE" ||
            reason === "INCOMPLETE_LIQUIDATION_HISTORY"
          )
            add(role, reason);
        }
      }
      for (const external of analytics.externalEvidence) {
        const role = `external:${external.family}`;
        clocks(role, external.asOf, external.validForMs, external.generatedAt);
        const validation = validateExternalRegimeEvidence(
          external,
          external.family,
          identity,
        );
        if (validation.reasonCodes.includes("EXTERNAL_EVIDENCE_HASH_MISMATCH"))
          add(role, "HASH_MISMATCH");
        if (validation.reasonCodes.includes("INPUT_IDENTITY_MISMATCH"))
          add(role, "LINEAGE_MISMATCH");
        for (const ref of external.inputEvidenceRefs) {
          const sources =
            ref.kind === "market-evidence-bundle"
              ? markets
              : ref.kind === "liquidation-evidence-bundle"
                ? liquidations
                : [];
          for (const source of sources) {
            const hash = sourceHash(source);
            const universe =
              "universeVersion" in source
                ? source.universeVersion
                : source.marketEvidence.universeVersion;
            if (
              !hash.ok ||
              ref.contentHash !== hash.value ||
              ref.sourceId !== source.runId ||
              ref.producer !== source.producer ||
              ref.schemaVersion !== source.schemaVersion ||
              (ref.runContext &&
                (ref.runContext.runId !== source.runId ||
                  ref.runContext.universeVersion !== universe ||
                  ref.runContext.bundleCutoff !== source.bundleCutoff))
            )
              add(role, "LINEAGE_MISMATCH");
          }
        }
      }
    }
  }
  const unique = new Map(
    findings.map((f) => [`${f.role}\0${f.reasonCode}`, f]),
  );
  return [...unique.values()].sort(
    (a, b) =>
      compareAnalyticsText(a.role, b.role) ||
      compareAnalyticsText(a.reasonCode, b.reasonCode),
  );
}
