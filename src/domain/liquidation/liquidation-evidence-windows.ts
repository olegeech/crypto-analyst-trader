import { DecimalValue } from "../shared/decimal.js";
import type { UtcTimestamp } from "../shared/time.js";
import type { LiquidationConstituentEvidence } from "./liquidation-evidence-bundle.js";

export const LIQUIDATION_HISTORY_BUCKETS = 24;
export const LIQUIDATION_HOUR_MS = 60 * 60 * 1_000;
export const LIQUIDATION_WINDOW_HOURS = Object.freeze([1, 4, 12, 24] as const);

export type LiquidationWindowHours = (typeof LIQUIDATION_WINDOW_HOURS)[number];

export interface LiquidationHourlyAggregate {
  readonly timestamp: UtcTimestamp;
  readonly longUsd: DecimalValue;
  readonly shortUsd: DecimalValue;
  readonly totalUsd: DecimalValue;
  readonly observedConstituents: number;
  readonly expectedConstituents: number;
  readonly complete: boolean;
}

export interface LiquidationWindowEvidence {
  readonly hours: LiquidationWindowHours;
  readonly from: UtcTimestamp;
  readonly to: UtcTimestamp;
  readonly longUsd: DecimalValue;
  readonly shortUsd: DecimalValue;
  readonly totalUsd: DecimalValue;
  readonly observedConstituentBuckets: number;
  readonly expectedConstituentBuckets: number;
  readonly complete: boolean;
}

export interface LiquidationDerivedWindows {
  readonly hourlyAggregates: readonly LiquidationHourlyAggregate[];
  readonly windows: readonly LiquidationWindowEvidence[];
}

const zeroResult = DecimalValue.fromString("0");
if (!zeroResult.ok) throw new Error("zero decimal constant is invalid");
const ZERO = zeroResult.value;

function bucketBoundary(cutoff: UtcTimestamp): number {
  return (
    Math.floor(Date.parse(cutoff) / LIQUIDATION_HOUR_MS) * LIQUIDATION_HOUR_MS -
    LIQUIDATION_HOUR_MS
  );
}

function asTimestamp(epoch: number): UtcTimestamp {
  return new Date(epoch).toISOString() as UtcTimestamp;
}

export function deriveLiquidationWindows(
  constituents: readonly LiquidationConstituentEvidence[],
  bundleCutoff: UtcTimestamp,
): LiquidationDerivedWindows {
  const expectedConstituents = constituents.length;
  const aggregatesByBucket = new Map<
    string,
    {
      longUsd: DecimalValue;
      shortUsd: DecimalValue;
      observed: Set<string>;
    }
  >();

  for (const constituent of constituents) {
    for (const observation of constituent.observations) {
      const current = aggregatesByBucket.get(observation.timestamp) ?? {
        longUsd: ZERO,
        shortUsd: ZERO,
        observed: new Set<string>(),
      };
      current.longUsd = current.longUsd.add(observation.longUsd);
      current.shortUsd = current.shortUsd.add(observation.shortUsd);
      current.observed.add(constituent.providerSymbol);
      aggregatesByBucket.set(observation.timestamp, current);
    }
  }

  const hourlyAggregates = [...aggregatesByBucket.entries()]
    .sort(([left], [right]) => Date.parse(left) - Date.parse(right))
    .map(([timestamp, aggregate]) =>
      Object.freeze({
        timestamp: timestamp as UtcTimestamp,
        longUsd: aggregate.longUsd,
        shortUsd: aggregate.shortUsd,
        totalUsd: aggregate.longUsd.add(aggregate.shortUsd),
        observedConstituents: aggregate.observed.size,
        expectedConstituents,
        complete:
          expectedConstituents > 0 &&
          aggregate.observed.size === expectedConstituents,
      }),
    );

  const lastClosedStart = bucketBoundary(bundleCutoff);
  const windows = LIQUIDATION_WINDOW_HOURS.map((hours) => {
    const fromEpoch = lastClosedStart - (hours - 1) * LIQUIDATION_HOUR_MS;
    const toEpoch = lastClosedStart;
    let longUsd = ZERO;
    let shortUsd = ZERO;
    let observedConstituentBuckets = 0;
    for (const constituent of constituents) {
      for (const observation of constituent.observations) {
        const epoch = Date.parse(observation.timestamp);
        if (epoch < fromEpoch || epoch > toEpoch) continue;
        longUsd = longUsd.add(observation.longUsd);
        shortUsd = shortUsd.add(observation.shortUsd);
        observedConstituentBuckets += 1;
      }
    }
    const expectedConstituentBuckets = expectedConstituents * hours;
    return Object.freeze({
      hours,
      from: asTimestamp(fromEpoch),
      to: asTimestamp(toEpoch),
      longUsd,
      shortUsd,
      totalUsd: longUsd.add(shortUsd),
      observedConstituentBuckets,
      expectedConstituentBuckets,
      complete:
        expectedConstituentBuckets > 0 &&
        observedConstituentBuckets === expectedConstituentBuckets,
    });
  });

  return Object.freeze({
    hourlyAggregates: Object.freeze(hourlyAggregates),
    windows: Object.freeze(windows),
  });
}
