import type { VersionedLiquidationEvidenceBundle } from "./liquidation-evidence-bundle.js";
import { liquidationHistoryWindow } from "./liquidation-evidence-windows.js";

/** True only when canonical rows and scoped diagnostics prove missing buckets
 * are the sole reason a covered catalogue has incomplete history. */
export function isCanonicalMissingBucketHistory(
  bundle: VersionedLiquidationEvidenceBundle,
): boolean {
  if (
    bundle.status !== "incomplete" ||
    bundle.coverageProof !== "complete" ||
    bundle.historyProof !== "incomplete" ||
    bundle.diagnostics.length === 0 ||
    bundle.diagnostics.some(
      (diagnostic) =>
        diagnostic.code !== "missing-bucket" ||
        diagnostic.operation !== "fetch-liquidation-history",
    )
  ) {
    return false;
  }

  const expectedBuckets = liquidationHistoryWindow(
    Date.parse(bundle.bundleCutoff),
  ).epochs;
  const missingByConstituent = new Map<string, Set<number>>();
  for (const target of bundle.targets) {
    for (const constituent of target.constituents) {
      const observed = new Set(
        constituent.observations.map((row) => Date.parse(row.timestamp)),
      );
      const missing = expectedBuckets.filter((bucket) => !observed.has(bucket));
      if (missing.length > 0) {
        const key = `${target.asset}\0${constituent.providerSymbol}`;
        missingByConstituent.set(key, new Set(missing));
      }
    }
  }
  if (missingByConstituent.size === 0) return false;

  const diagnosedConstituents = new Set<string>();
  for (const diagnostic of bundle.diagnostics) {
    if (
      diagnostic.asset === undefined ||
      diagnostic.providerSymbol === undefined ||
      diagnostic.bucketTimestamp === undefined
    ) {
      return false;
    }
    const key = `${diagnostic.asset}\0${diagnostic.providerSymbol}`;
    const missing = missingByConstituent.get(key);
    const bucket = Date.parse(diagnostic.bucketTimestamp);
    if (
      missing === undefined ||
      !missing.has(bucket) ||
      diagnosedConstituents.has(key)
    ) {
      return false;
    }
    diagnosedConstituents.add(key);
  }
  return (
    diagnosedConstituents.size === missingByConstituent.size &&
    [...missingByConstituent.keys()].every((key) =>
      diagnosedConstituents.has(key),
    )
  );
}
