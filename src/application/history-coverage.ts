import { domainError } from "../domain/shared/errors.js";
import { fail, ok, type Result } from "../domain/shared/result.js";
import type {
  HistoryCheckpoint,
  HistoryStoreScope,
  HistoryStoredObservation,
} from "../ports/history-store.js";
import {
  HISTORY_READ_SOURCES,
  type HistoryReadSource,
} from "../ports/history-read.js";
import {
  historyMoneyComponents,
  type HistoryMoneyComponent,
} from "./history-attribution.js";

export interface HistoryCoverageWindow {
  readonly window: HistoryCheckpoint["window"];
  readonly status: HistoryCheckpoint["status"];
  readonly reasonCode: string | null;
  readonly rowCount: number;
  readonly insertedCount: number;
  readonly duplicateCount: number;
  readonly conflictCount: number;
}

export interface HistoryStreamCoverage {
  readonly source: HistoryReadSource;
  readonly status:
    "missing" | "paging" | "partial" | "traversed" | "unavailable";
  readonly windows: readonly HistoryCoverageWindow[];
}

export type HistoryCoverageGap =
  | {
      readonly kind: "history-expired";
      readonly source: HistoryReadSource;
      readonly window: HistoryCheckpoint["window"];
      readonly reasonCode: string;
    }
  | {
      readonly kind: "history-unavailable";
      readonly source: HistoryReadSource;
      readonly window: HistoryCheckpoint["window"];
      readonly reasonCode: string;
    }
  | {
      readonly kind: "coverage-incomplete";
      readonly source: HistoryReadSource;
      readonly window: HistoryCheckpoint["window"];
      readonly status: "paging" | "partial";
    }
  | {
      readonly kind: "unqueried-window";
      readonly source: HistoryReadSource;
      readonly filterHash: string;
      readonly window: HistoryCheckpoint["window"];
    }
  | {
      readonly kind: "stream-coverage-missing";
      readonly source: HistoryReadSource;
    }
  | {
      readonly kind: "opening-balance-unknown";
      readonly reasonCode: "OPENING_BALANCE_NOT_PROVIDED";
    }
  | {
      readonly kind: "unknown-currency";
      readonly observationId: string;
      readonly component: HistoryMoneyComponent["component"];
      readonly amount: string | null;
    }
  | {
      readonly kind: "unknown-amount";
      readonly observationId: string;
      readonly component: HistoryMoneyComponent["component"];
      readonly currency: string | null;
    }
  | {
      readonly kind: "funding-amount-unknown";
      readonly observationId: string;
      readonly component: "funding" | "funding-fee";
    }
  | { readonly kind: "funding-not-observed" };

export interface HistoryFundingCoverage {
  readonly status: "observed" | "unknown" | "not-observed";
  readonly evidence: readonly {
    readonly observationId: string;
    readonly component: "funding" | "funding-fee";
    readonly amount: string | null;
    readonly currency: string | null;
  }[];
}

export interface HistoryCoverageProjection {
  readonly schemaVersion: "history-coverage-projection/v1";
  readonly scope: HistoryStoreScope;
  readonly streams: readonly HistoryStreamCoverage[];
  readonly moneyComponents: readonly HistoryMoneyComponent[];
  readonly openingBalance: {
    readonly status: "unknown";
    readonly reasonCode: "OPENING_BALANCE_NOT_PROVIDED";
  };
  readonly funding: HistoryFundingCoverage;
  readonly gaps: readonly HistoryCoverageGap[];
}

export interface HistoryCoverageInput {
  readonly scope: HistoryStoreScope;
  readonly checkpoints: readonly HistoryCheckpoint[];
  readonly observations: readonly HistoryStoredObservation[];
}

function sameScope(left: HistoryStoreScope, right: HistoryStoreScope): boolean {
  return (
    left.exchange === right.exchange &&
    left.environment === right.environment &&
    left.accountId === right.accountId
  );
}

function sourceStatus(
  checkpoints: readonly HistoryCheckpoint[],
): HistoryStreamCoverage["status"] {
  if (checkpoints.length === 0) return "missing";
  if (checkpoints.some((row) => row.status === "unavailable"))
    return "unavailable";
  if (checkpoints.some((row) => row.status === "partial")) return "partial";
  if (checkpoints.some((row) => row.status === "paging")) return "paging";
  return "traversed";
}

function knownExpired(reasonCode: string | null): boolean {
  return reasonCode === "HISTORY_EXPIRED" || reasonCode === "RETENTION_EXPIRED";
}

function fundingEvidence(
  observation: HistoryStoredObservation,
): readonly HistoryFundingCoverage["evidence"][number][] {
  const fact = observation.fact;
  if (fact.factKind === "transaction") {
    const isFunding =
      fact.funding !== null ||
      /fund/iu.test(`${fact.type ?? ""} ${fact.transSubType ?? ""}`);
    return isFunding
      ? [
          {
            observationId: observation.observationId,
            component: "funding",
            amount: fact.funding,
            currency: fact.currency,
          },
        ]
      : [];
  }
  if (fact.factKind === "closed-pnl")
    return [
      {
        observationId: observation.observationId,
        component: "funding-fee",
        amount: fact.fundingFee,
        currency: null,
      },
    ];
  return [];
}

export function projectHistoryCoverage(
  input: HistoryCoverageInput,
): Result<HistoryCoverageProjection> {
  if (
    input.checkpoints.some(
      (checkpoint) => !sameScope(checkpoint.scope, input.scope),
    ) ||
    input.observations.some(
      (observation) => !sameScope(observation.scope, input.scope),
    )
  )
    return fail(
      domainError(
        "INVALID_VALUE",
        "history coverage inputs do not share one account scope",
      ),
    );

  const gaps: HistoryCoverageGap[] = [];
  const streams = HISTORY_READ_SOURCES.map((source): HistoryStreamCoverage => {
    const selected = input.checkpoints
      .filter((checkpoint) => checkpoint.source === source)
      .sort(
        (left, right) =>
          left.window.fromMs - right.window.fromMs ||
          left.window.toMs - right.window.toMs,
      );
    if (selected.length === 0)
      gaps.push({ kind: "stream-coverage-missing", source });
    const windowsByFilter = new Map<string, HistoryCheckpoint[]>();
    for (const checkpoint of selected) {
      const group = windowsByFilter.get(checkpoint.filterHash) ?? [];
      group.push(checkpoint);
      windowsByFilter.set(checkpoint.filterHash, group);
    }
    for (const [filterHash, checkpoints] of windowsByFilter) {
      let coveredThrough: number | undefined;
      for (const checkpoint of checkpoints) {
        if (
          coveredThrough !== undefined &&
          checkpoint.window.fromMs > coveredThrough + 1
        )
          gaps.push({
            kind: "unqueried-window",
            source,
            filterHash,
            window: {
              fromMs: coveredThrough + 1,
              toMs: checkpoint.window.fromMs - 1,
            },
          });
        coveredThrough = Math.max(
          coveredThrough ?? checkpoint.window.toMs,
          checkpoint.window.toMs,
        );
      }
    }
    for (const checkpoint of selected) {
      if (checkpoint.status === "unavailable") {
        if (knownExpired(checkpoint.reasonCode))
          gaps.push({
            kind: "history-expired",
            source,
            window: checkpoint.window,
            reasonCode: checkpoint.reasonCode!,
          });
        else
          gaps.push({
            kind: "history-unavailable",
            source,
            window: checkpoint.window,
            reasonCode: checkpoint.reasonCode ?? "UNAVAILABLE",
          });
      } else if (
        checkpoint.status === "partial" ||
        checkpoint.status === "paging"
      ) {
        gaps.push({
          kind: "coverage-incomplete",
          source,
          window: checkpoint.window,
          status: checkpoint.status,
        });
      }
    }
    return {
      source,
      status: sourceStatus(selected),
      windows: selected.map((checkpoint) => ({
        window: checkpoint.window,
        status: checkpoint.status,
        reasonCode: checkpoint.reasonCode,
        rowCount: checkpoint.rowCount,
        insertedCount: checkpoint.insertedCount,
        duplicateCount: checkpoint.duplicateCount,
        conflictCount: checkpoint.conflictCount,
      })),
    };
  });

  const moneyComponents = input.observations.flatMap(historyMoneyComponents);
  for (const component of moneyComponents) {
    if (component.unknownFields.includes("currency"))
      gaps.push({
        kind: "unknown-currency",
        observationId: component.provenance.observationId,
        component: component.component,
        amount: component.amount,
      });
    if (component.unknownFields.includes("amount")) {
      const unknownAmount: HistoryCoverageGap = {
        kind:
          component.component === "funding" ||
          component.component === "funding-fee"
            ? "funding-amount-unknown"
            : "unknown-amount",
        observationId: component.provenance.observationId,
        component:
          component.component === "funding" ||
          component.component === "funding-fee"
            ? component.component
            : component.component,
        ...(component.component === "funding" ||
        component.component === "funding-fee"
          ? {}
          : { currency: component.currency }),
      } as HistoryCoverageGap;
      gaps.push(unknownAmount);
    }
  }

  const funding = input.observations.flatMap(fundingEvidence);
  const observedFunding = funding.some(
    (item) => item.amount !== null && item.currency !== null,
  );
  const unknownFunding = funding.length > 0 && !observedFunding;
  if (funding.length === 0) gaps.push({ kind: "funding-not-observed" });
  const openingBalance = {
    status: "unknown" as const,
    reasonCode: "OPENING_BALANCE_NOT_PROVIDED" as const,
  };
  gaps.push({
    kind: "opening-balance-unknown",
    reasonCode: openingBalance.reasonCode,
  });

  return ok({
    schemaVersion: "history-coverage-projection/v1",
    scope: input.scope,
    streams,
    moneyComponents,
    openingBalance,
    funding: {
      status: observedFunding
        ? "observed"
        : unknownFunding
          ? "unknown"
          : "not-observed",
      evidence: funding,
    },
    gaps,
  });
}
