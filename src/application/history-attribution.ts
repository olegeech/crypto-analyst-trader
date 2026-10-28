import type {
  HistorySourceFact,
  OrderHistorySourceFact,
} from "../domain/accounting/history-source-fact.js";
import type { OperatorMainnetTestSnapshot } from "../ports/operator-mainnet-test-persistence.js";
import type {
  PersistenceScope,
  PreparedLegRunSnapshot,
} from "../ports/persistence.js";
import type {
  HistoryStoreScope,
  HistoryStoredObservation,
} from "../ports/history-store.js";
import { fail, ok, type Result } from "../domain/shared/result.js";
import { domainError } from "../domain/shared/errors.js";
import { hashCanonical } from "../domain/identity/canonical-serialization.js";

export type HistoryLineageKind = "operator-mainnet-test" | "prepared-leg";
export type HistoryOwnershipMatch =
  | "client-order-id"
  | "exchange-order-id"
  | "execution-id"
  | "parent-order-link"
  | "linked-child-order";

export interface HistoryMoneyComponent {
  readonly component:
    | "order-cumulative-fee"
    | "order-fee-detail"
    | "execution-fee"
    | "execution-fee-v2"
    | "execution-pnl"
    | "closed-pnl"
    | "open-fee"
    | "close-fee"
    | "funding-fee"
    | "cash-flow"
    | "funding"
    | "fee"
    | "change"
    | "bonus-change"
    | "cash-balance";
  /** The provider's signed canonical decimal. Null means the amount is unknown. */
  readonly amount: string | null;
  /** Kept separately from the amount; null means the currency is unknown. */
  readonly currency: string | null;
  readonly completeness: "complete" | "incomplete";
  readonly unknownFields: readonly ("amount" | "currency")[];
  readonly provenance: {
    readonly observationId: string;
    readonly source: HistoryStoredObservation["source"];
    readonly factKind: HistorySourceFact["factKind"];
    readonly field: string;
  };
}

export interface HistoryOwnershipEvidence {
  readonly sourceKind: HistoryLineageKind;
  readonly sourceId: string;
  readonly matchedBy: HistoryOwnershipMatch;
  readonly observationId?: string;
  readonly exchangeOrderId?: string;
}

export type HistoryOwnership =
  | {
      readonly status: "matched";
      readonly source: {
        readonly kind: HistoryLineageKind;
        readonly sourceId: string;
      };
      readonly evidence: readonly HistoryOwnershipEvidence[];
    }
  | {
      readonly status: "unmatched";
      readonly reason: "NO_EXACT_LINEAGE";
      readonly evidence: readonly [];
    }
  | {
      readonly status: "ambiguous";
      readonly reason: "MULTIPLE_EXACT_LINEAGES";
      readonly candidates: readonly {
        readonly kind: HistoryLineageKind;
        readonly sourceId: string;
      }[];
      readonly evidence: readonly HistoryOwnershipEvidence[];
    };

export interface AttributedHistoryObservation {
  readonly observation: HistoryStoredObservation;
  readonly ownership: HistoryOwnership;
  readonly moneyComponents: readonly HistoryMoneyComponent[];
  readonly completeness: "complete" | "incomplete";
}

export interface HistoryAttributionProjection {
  readonly schemaVersion: "history-attribution-projection/v1";
  readonly observations: readonly AttributedHistoryObservation[];
}

export interface HistoryAttributionInput {
  readonly observations: readonly HistoryStoredObservation[];
  /** Snapshots returned by the existing operator source lookup contract. */
  readonly operatorSources: readonly OperatorMainnetTestSnapshot[];
  /** Snapshots returned by the existing prepared-leg source lookup contract. */
  readonly preparedSources: readonly PreparedLegRunSnapshot[];
}

interface Lineage {
  readonly kind: HistoryLineageKind;
  readonly sourceId: string;
  readonly scope: PersistenceScope;
  readonly clientOrderId: string;
  readonly exchangeOrderIds: ReadonlySet<string>;
  readonly executionIds: ReadonlySet<string>;
}

interface MatchSet {
  readonly lineage: Lineage;
  readonly evidence: HistoryOwnershipEvidence[];
}

function usableScope(
  scope: PersistenceScope,
  history: HistoryStoreScope,
): boolean {
  return (
    scope.exchange === history.exchange &&
    scope.environment === history.environment &&
    scope.accountId === history.accountId &&
    scope.exchange === "bybit"
  );
}

function recordOperatorExecutionIds(
  snapshot: OperatorMainnetTestSnapshot,
): readonly {
  readonly orderIds: readonly string[];
  readonly executionIds: readonly string[];
}[] {
  const output: { orderIds: string[]; executionIds: string[] }[] = [];
  for (const record of snapshot.reconciliations) {
    if (record.sourceId !== snapshot.source.sourceId) continue;
    let decoded: unknown;
    try {
      decoded = JSON.parse(record.canonicalJson) as unknown;
    } catch {
      continue;
    }
    const encodedHash = hashCanonical(decoded);
    if (!encodedHash.ok || encodedHash.value !== record.canonicalHash) continue;
    if (
      decoded === null ||
      typeof decoded !== "object" ||
      Array.isArray(decoded) ||
      !("schemaVersion" in decoded) ||
      decoded.schemaVersion !== "operator-mainnet-test-reconciliation/v1" ||
      !("sourceId" in decoded) ||
      decoded.sourceId !== snapshot.source.sourceId ||
      !("evidence" in decoded)
    )
      continue;
    const evidence = decoded.evidence;
    if (
      evidence === null ||
      typeof evidence !== "object" ||
      Array.isArray(evidence) ||
      !("schemaVersion" in evidence) ||
      evidence.schemaVersion !== "operator-mainnet-test-status-evidence/v1"
    )
      continue;
    const orderIds: string[] = [];
    const executionIds: string[] = [];
    const parent = "parent" in evidence ? evidence.parent : undefined;
    if (
      parent !== null &&
      parent !== undefined &&
      typeof parent === "object" &&
      !Array.isArray(parent) &&
      "exchangeOrderId" in parent &&
      typeof parent.exchangeOrderId === "string"
    )
      orderIds.push(parent.exchangeOrderId);
    const children = "tpChildren" in evidence ? evidence.tpChildren : undefined;
    if (Array.isArray(children))
      for (const child of children)
        if (
          child !== null &&
          typeof child === "object" &&
          !Array.isArray(child) &&
          "exchangeOrderId" in child &&
          typeof child.exchangeOrderId === "string"
        )
          orderIds.push(child.exchangeOrderId);
    const entries = "entryFills" in evidence ? evidence.entryFills : undefined;
    if (Array.isArray(entries))
      for (const fill of entries)
        if (
          fill !== null &&
          typeof fill === "object" &&
          !Array.isArray(fill) &&
          "executionId" in fill &&
          typeof fill.executionId === "string"
        )
          executionIds.push(fill.executionId);
    const exits =
      "tpExitExecutionIds" in evidence
        ? evidence.tpExitExecutionIds
        : undefined;
    if (Array.isArray(exits))
      for (const executionId of exits)
        if (typeof executionId === "string") executionIds.push(executionId);
    output.push({ orderIds, executionIds });
  }
  return output;
}

function operatorLineage(
  snapshot: OperatorMainnetTestSnapshot,
): Lineage | undefined {
  if (
    snapshot.source.sourceId !== snapshot.intent.sourceId ||
    snapshot.intent.operation !== "CREATE" ||
    snapshot.source.planHash !== snapshot.plan.contentHash ||
    snapshot.source.clientOrderId !== snapshot.plan.clientOrderId ||
    snapshot.plan.accountIdentityHash !== snapshot.source.scope.accountId
  )
    return undefined;
  const exchangeOrderIds = new Set<string>();
  const executionIds = new Set<string>();
  if (snapshot.attempt?.exchangeOrderId)
    exchangeOrderIds.add(snapshot.attempt.exchangeOrderId);
  for (const evidence of recordOperatorExecutionIds(snapshot)) {
    for (const id of evidence.orderIds) exchangeOrderIds.add(id);
    for (const id of evidence.executionIds) executionIds.add(id);
  }
  return {
    kind: "operator-mainnet-test",
    sourceId: snapshot.source.sourceId,
    scope: snapshot.source.scope,
    clientOrderId: snapshot.source.clientOrderId,
    exchangeOrderIds,
    executionIds,
  };
}

function preparedLineage(
  snapshot: PreparedLegRunSnapshot,
): Lineage | undefined {
  if (
    snapshot.createIntent.sourceId !== snapshot.lineage.sourceId ||
    snapshot.createIntent.operation !== "create" ||
    snapshot.createIntent.clientOrderId !== snapshot.lineage.clientOrderId
  )
    return undefined;
  const exchangeOrderIds = new Set<string>();
  const executionIds = new Set<string>();
  if (snapshot.createIntent.exchangeOrderId)
    exchangeOrderIds.add(snapshot.createIntent.exchangeOrderId);
  for (const reconciliation of snapshot.reconciliations) {
    if (reconciliation.sourceId !== snapshot.lineage.sourceId) continue;
    if (reconciliation.exchangeOrderId)
      exchangeOrderIds.add(reconciliation.exchangeOrderId);
    const protection = reconciliation.protectionEvidence;
    if (!protection || protection.sourceId !== snapshot.lineage.sourceId)
      continue;
    exchangeOrderIds.add(protection.parent.exchangeOrderId);
    for (const child of protection.children)
      exchangeOrderIds.add(child.exchangeOrderId);
    for (const fill of [...protection.entries.fills, ...protection.exits.fills])
      executionIds.add(fill.executionId);
  }
  return {
    kind: "prepared-leg",
    sourceId: snapshot.lineage.sourceId,
    scope: snapshot.lineage.scope,
    clientOrderId: snapshot.lineage.clientOrderId,
    exchangeOrderIds,
    executionIds,
  };
}

function evidence(
  lineage: Lineage,
  matchedBy: HistoryOwnershipMatch,
  options: {
    readonly observationId?: string;
    readonly exchangeOrderId?: string;
  } = {},
): HistoryOwnershipEvidence {
  return {
    sourceKind: lineage.kind,
    sourceId: lineage.sourceId,
    matchedBy,
    ...(options.observationId === undefined
      ? {}
      : { observationId: options.observationId }),
    ...(options.exchangeOrderId === undefined
      ? {}
      : { exchangeOrderId: options.exchangeOrderId }),
  };
}

function mergeMatch(
  matches: Map<string, MatchSet>,
  lineage: Lineage,
  proof: HistoryOwnershipEvidence,
): void {
  const key = `${lineage.kind}:${lineage.sourceId}`;
  const existing = matches.get(key);
  if (existing) existing.evidence.push(proof);
  else matches.set(key, { lineage, evidence: [proof] });
}

function orderMatches(
  fact: OrderHistorySourceFact,
  lineages: readonly Lineage[],
): Map<string, MatchSet> {
  const matches = new Map<string, MatchSet>();
  for (const lineage of lineages) {
    if (lineage.exchangeOrderIds.has(fact.orderId))
      mergeMatch(
        matches,
        lineage,
        evidence(lineage, "exchange-order-id", {
          exchangeOrderId: fact.orderId,
        }),
      );
    if (fact.orderLinkId === lineage.clientOrderId)
      mergeMatch(
        matches,
        lineage,
        evidence(lineage, "client-order-id", { exchangeOrderId: fact.orderId }),
      );
    if (
      fact.parentOrderLinkId === lineage.clientOrderId &&
      lineage.exchangeOrderIds.size > 0
    )
      mergeMatch(
        matches,
        lineage,
        evidence(lineage, "parent-order-link", {
          exchangeOrderId: fact.orderId,
        }),
      );
  }
  return matches;
}

function resolveMatches(matches: Map<string, MatchSet>): HistoryOwnership {
  const candidates = [...matches.values()].sort((left, right) =>
    `${left.lineage.kind}:${left.lineage.sourceId}`.localeCompare(
      `${right.lineage.kind}:${right.lineage.sourceId}`,
    ),
  );
  if (candidates.length === 0)
    return { status: "unmatched", reason: "NO_EXACT_LINEAGE", evidence: [] };
  if (candidates.length > 1)
    return {
      status: "ambiguous",
      reason: "MULTIPLE_EXACT_LINEAGES",
      candidates: candidates.map(({ lineage }) => ({
        kind: lineage.kind,
        sourceId: lineage.sourceId,
      })),
      evidence: candidates.flatMap(({ evidence: refs }) => refs),
    };
  const single = candidates[0];
  if (!single)
    return { status: "unmatched", reason: "NO_EXACT_LINEAGE", evidence: [] };
  const { lineage, evidence: refs } = single;
  return {
    status: "matched",
    source: { kind: lineage.kind, sourceId: lineage.sourceId },
    evidence: refs,
  };
}

function addLineageMatches(
  matches: Map<string, MatchSet>,
  lineages: readonly Lineage[],
  test: (lineage: Lineage) => readonly HistoryOwnershipEvidence[],
): void {
  for (const lineage of lineages)
    for (const proof of test(lineage)) mergeMatch(matches, lineage, proof);
}

function factMatches(
  observation: HistoryStoredObservation,
  lineages: readonly Lineage[],
  ordersByExchangeId: ReadonlyMap<string, HistoryOwnership>,
): HistoryOwnership {
  const fact = observation.fact;
  const matches = new Map<string, MatchSet>();
  if (fact.factKind === "order")
    return resolveMatches(orderMatches(fact, lineages));
  addLineageMatches(matches, lineages, (lineage) => {
    const refs: HistoryOwnershipEvidence[] = [];
    if (fact.factKind === "execution") {
      if (lineage.exchangeOrderIds.has(fact.orderId))
        refs.push(
          evidence(lineage, "exchange-order-id", {
            exchangeOrderId: fact.orderId,
          }),
        );
      if (lineage.executionIds.has(fact.execId))
        refs.push(
          evidence(lineage, "execution-id", { exchangeOrderId: fact.orderId }),
        );
      if (fact.orderLinkId === lineage.clientOrderId)
        refs.push(
          evidence(lineage, "client-order-id", {
            exchangeOrderId: fact.orderId,
          }),
        );
    } else if (fact.factKind === "closed-pnl") {
      if (lineage.exchangeOrderIds.has(fact.orderId))
        refs.push(
          evidence(lineage, "exchange-order-id", {
            exchangeOrderId: fact.orderId,
          }),
        );
    } else {
      if (fact.orderId !== null && lineage.exchangeOrderIds.has(fact.orderId))
        refs.push(
          evidence(lineage, "exchange-order-id", {
            exchangeOrderId: fact.orderId,
          }),
        );
      if (fact.orderLinkId === lineage.clientOrderId)
        refs.push(evidence(lineage, "client-order-id"));
    }
    return refs;
  });
  if (fact.factKind === "execution") {
    const parent = ordersByExchangeId.get(fact.orderId);
    if (parent?.status === "matched") {
      const lineage = lineages.find(
        (candidate) =>
          candidate.kind === parent.source.kind &&
          candidate.sourceId === parent.source.sourceId,
      );
      if (lineage)
        mergeMatch(
          matches,
          lineage,
          evidence(lineage, "linked-child-order", {
            ...(parent.evidence.find((ref) => ref.observationId)
              ?.observationId === undefined
              ? {}
              : {
                  observationId: parent.evidence.find(
                    (ref) => ref.observationId,
                  )!.observationId,
                }),
            exchangeOrderId: fact.orderId,
          }),
        );
    } else if (parent?.status === "ambiguous") {
      for (const candidate of parent.candidates) {
        const lineage = lineages.find(
          (row) =>
            row.kind === candidate.kind && row.sourceId === candidate.sourceId,
        );
        if (lineage)
          mergeMatch(
            matches,
            lineage,
            evidence(lineage, "linked-child-order", {
              exchangeOrderId: fact.orderId,
            }),
          );
      }
    }
  }
  return resolveMatches(matches);
}

function moneyComponent(
  observation: HistoryStoredObservation,
  field: string,
  component: HistoryMoneyComponent["component"],
  amount: string | null,
  currency: string | null,
): HistoryMoneyComponent {
  const unknownFields: ("amount" | "currency")[] = [];
  if (amount === null) unknownFields.push("amount");
  if (currency === null) unknownFields.push("currency");
  return {
    component,
    amount,
    currency,
    completeness: unknownFields.length === 0 ? "complete" : "incomplete",
    unknownFields,
    provenance: {
      observationId: observation.observationId,
      source: observation.source,
      factKind: observation.fact.factKind,
      field,
    },
  };
}

export function historyMoneyComponents(
  observation: HistoryStoredObservation,
): readonly HistoryMoneyComponent[] {
  const fact = observation.fact;
  const output: HistoryMoneyComponent[] = [];
  if (fact.factKind === "order") {
    if (fact.cumExecFee !== null)
      output.push(
        moneyComponent(
          observation,
          "cumExecFee",
          "order-cumulative-fee",
          fact.cumExecFee,
          null,
        ),
      );
    for (const detail of fact.feeDetails)
      output.push(
        moneyComponent(
          observation,
          "feeDetails",
          "order-fee-detail",
          detail.amount,
          detail.currency,
        ),
      );
  } else if (fact.factKind === "execution") {
    output.push(
      moneyComponent(
        observation,
        "execFee",
        "execution-fee",
        fact.execFee,
        fact.feeCurrency,
      ),
    );
    if (fact.execFeeV2 !== null)
      output.push(
        moneyComponent(
          observation,
          "execFeeV2",
          "execution-fee-v2",
          fact.execFeeV2,
          fact.feeCurrency,
        ),
      );
    if (fact.execPnl !== null)
      output.push(
        moneyComponent(
          observation,
          "execPnl",
          "execution-pnl",
          fact.execPnl,
          null,
        ),
      );
  } else if (fact.factKind === "closed-pnl") {
    output.push(
      moneyComponent(
        observation,
        "closedPnl",
        "closed-pnl",
        fact.closedPnl,
        null,
      ),
    );
    output.push(
      moneyComponent(observation, "openFee", "open-fee", fact.openFee, null),
    );
    output.push(
      moneyComponent(observation, "closeFee", "close-fee", fact.closeFee, null),
    );
    output.push(
      moneyComponent(
        observation,
        "fundingFee",
        "funding-fee",
        fact.fundingFee,
        null,
      ),
    );
  } else {
    const values: readonly [
      string,
      HistoryMoneyComponent["component"],
      string | null,
    ][] = [
      ["cashFlow", "cash-flow", fact.cashFlow],
      ["funding", "funding", fact.funding],
      ["fee", "fee", fact.fee],
      ["change", "change", fact.change],
      ["bonusChange", "bonus-change", fact.bonusChange],
      ["cashBalance", "cash-balance", fact.cashBalance],
    ];
    for (const [field, component, amount] of values) {
      const expected =
        field === "funding" &&
        /fund/iu.test(`${fact.type ?? ""} ${fact.transSubType ?? ""}`);
      if (amount !== null || expected)
        output.push(
          moneyComponent(observation, field, component, amount, fact.currency),
        );
    }
  }
  return output;
}

export function attributeHistoryObservations(
  input: HistoryAttributionInput,
): Result<HistoryAttributionProjection> {
  const observationScopes = new Set(
    input.observations.map(
      ({ scope }) =>
        `${scope.exchange}\u0000${scope.environment}\u0000${scope.accountId}`,
    ),
  );
  if (observationScopes.size > 1)
    return fail(
      domainError(
        "INVALID_VALUE",
        "history attribution observations must share one account scope",
      ),
    );

  const lineages: Lineage[] = [];
  for (const snapshot of input.operatorSources) {
    const lineage = operatorLineage(snapshot);
    if (lineage) lineages.push(lineage);
  }
  for (const snapshot of input.preparedSources) {
    const lineage = preparedLineage(snapshot);
    if (lineage) lineages.push(lineage);
  }
  const historyScope = input.observations[0]?.scope;
  const validLineages =
    historyScope === undefined
      ? []
      : lineages.filter((lineage) => usableScope(lineage.scope, historyScope));
  const orderResolutions = new Map<string, HistoryOwnership>();
  const orderObservationIds = new Map<string, string>();
  for (const observation of input.observations) {
    if (observation.fact.factKind !== "order") continue;
    const scoped = validLineages;
    const ownership = resolveMatches(orderMatches(observation.fact, scoped));
    orderResolutions.set(observation.fact.orderId, ownership);
    if (ownership.status === "matched") {
      const ref = ownership.evidence.find(
        (row) => row.matchedBy === "parent-order-link",
      );
      if (ref)
        orderObservationIds.set(
          observation.fact.orderId,
          observation.observationId,
        );
    }
  }
  const ordersByExchangeId = new Map<string, HistoryOwnership>();
  for (const [exchangeOrderId, ownership] of orderResolutions) {
    const observationId = orderObservationIds.get(exchangeOrderId);
    if (ownership.status === "matched" && observationId) {
      ordersByExchangeId.set(exchangeOrderId, {
        ...ownership,
        evidence: [
          ...ownership.evidence,
          ...ownership.evidence.map((ref) => ({ ...ref, observationId })),
        ],
      });
    } else {
      ordersByExchangeId.set(exchangeOrderId, ownership);
    }
  }
  const rows: AttributedHistoryObservation[] = [];
  for (const observation of input.observations) {
    const scoped = validLineages;
    const ownership =
      observation.fact.factKind === "order"
        ? (orderResolutions.get(observation.fact.orderId) ?? {
            status: "unmatched" as const,
            reason: "NO_EXACT_LINEAGE" as const,
            evidence: [] as const,
          })
        : factMatches(observation, scoped, ordersByExchangeId);
    const moneyComponents = historyMoneyComponents(observation);
    const completeness = moneyComponents.some(
      (component) => component.completeness === "incomplete",
    )
      ? "incomplete"
      : "complete";
    rows.push({ observation, ownership, moneyComponents, completeness });
  }
  if (rows.length !== input.observations.length)
    return fail(
      domainError(
        "INVALID_VALUE",
        "history attribution projection is incomplete",
      ),
    );
  return ok({
    schemaVersion: "history-attribution-projection/v1",
    observations: rows,
  });
}
