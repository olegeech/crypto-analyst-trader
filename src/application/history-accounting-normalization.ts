import type {
  ClosedPnlHistorySourceFact,
  HistorySourceFact,
  TransactionHistorySourceFact,
} from "../domain/accounting/history-source-fact.js";
import { DecimalValue } from "../domain/shared/decimal.js";
import { domainError } from "../domain/shared/errors.js";
import { fail, ok, type Result } from "../domain/shared/result.js";
import type {
  HistoryConflictSummary,
  HistoryStoreScope,
  HistoryStoredObservation,
} from "../ports/history-store.js";
import type { HistoryReadSource } from "../ports/history-read.js";

export type HistoryTransactionMovementKind =
  "trade" | "funding" | "transfer" | "unknown";

export function indexHistoryObservationsByIdentity(
  observations: readonly HistoryStoredObservation[],
): Map<HistoryReadSource, Map<string, HistoryStoredObservation[]>> {
  const index = new Map<
    HistoryReadSource,
    Map<string, HistoryStoredObservation[]>
  >();
  for (const observation of observations) {
    let identities = index.get(observation.source);
    if (identities === undefined) {
      identities = new Map();
      index.set(observation.source, identities);
    }
    const matches = identities.get(observation.eventIdentity);
    if (matches === undefined)
      identities.set(observation.eventIdentity, [observation]);
    else matches.push(observation);
  }
  return index;
}

export interface NormalizedHistoryTransaction {
  readonly observationId: string;
  readonly transactionId: string;
  readonly category: string | null;
  readonly movementKind: HistoryTransactionMovementKind;
  readonly currency: string | null;
  /** The one native-currency posting candidate reported by this transaction. */
  readonly change: string | null;
  /** Signed provider components; missing values remain null, never zero-filled. */
  readonly cashFlow: string | null;
  readonly funding: string | null;
  readonly fee: string | null;
  readonly bonusChange: string | null;
  /** Post-event balance evidence; it is not an additional movement. */
  readonly cashBalance: string | null;
  /** Check value only: cashFlow + funding - fee when all components exist. */
  readonly expectedChange: string | null;
  readonly componentCheck: "matched" | "mismatched" | "incomplete";
  readonly strategyDisposition: "corroboration-only" | "account-movement-only";
}

export type HistoryAccountingSelectionConflict =
  | {
      readonly kind: "transaction-identity-conflict";
      readonly transactionId: string;
      readonly observationIds: readonly string[];
      readonly conflictIds: readonly string[];
    }
  | {
      readonly kind: "closed-pnl-revision-conflict";
      readonly groupingKey: ClosedPnlHistorySourceFact["groupingKey"];
      readonly observationIds: readonly string[];
    };

export interface CanonicalHistoryEvidence {
  /** Transaction identities are unique; closed-PnL groups have one selected revision. */
  readonly observations: readonly HistoryStoredObservation[];
  /** Ambiguous identities/groups are omitted from observations and listed here. */
  readonly conflicts: readonly HistoryAccountingSelectionConflict[];
}

export interface SelectCanonicalHistoryEvidenceInput {
  readonly scope: HistoryStoreScope;
  readonly observations: readonly HistoryStoredObservation[];
  /** Conflicts returned by `readConflicts` for this same scope. */
  readonly conflicts: readonly HistoryConflictSummary[];
}

function invalidValue(message: string): Result<never> {
  return fail(domainError("INVALID_VALUE", message));
}

function invalidAccounting(message: string): Result<never> {
  return fail(domainError("INVALID_ACCOUNTING", message));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  );
}

function sameScope(left: HistoryStoreScope, right: HistoryStoreScope): boolean {
  return (
    left.exchange === right.exchange &&
    left.environment === right.environment &&
    left.accountId === right.accountId
  );
}

function compareObservationRecency(
  left: HistoryStoredObservation,
  right: HistoryStoredObservation,
): number {
  return (
    right.collectedAt.localeCompare(left.collectedAt) ||
    left.observationId.localeCompare(right.observationId)
  );
}

export function compareObservationOrder(
  left: HistoryStoredObservation,
  right: HistoryStoredObservation,
): number {
  return (
    left.source.localeCompare(right.source) ||
    left.providerEventTime.localeCompare(right.providerEventTime) ||
    left.eventIdentity.localeCompare(right.eventIdentity) ||
    (left.providerRevisionTime ?? "").localeCompare(
      right.providerRevisionTime ?? "",
    ) ||
    left.contentHash.localeCompare(right.contentHash) ||
    left.observationId.localeCompare(right.observationId)
  );
}

function validateObservation(value: unknown): Result<HistoryStoredObservation> {
  if (!isRecord(value) || !isRecord(value.fact) || !isRecord(value.scope))
    return invalidValue("history accounting observation is malformed");

  const observation = value as unknown as HistoryStoredObservation;
  const fact = observation.fact as HistorySourceFact;
  if (
    typeof observation.observationId !== "string" ||
    observation.observationId.length === 0 ||
    typeof observation.eventIdentity !== "string" ||
    typeof observation.contentHash !== "string" ||
    observation.contentHash !== fact.contentHash ||
    typeof observation.canonicalHash !== "string" ||
    observation.source !== fact.source ||
    observation.providerEventTime !== fact.providerEventTime ||
    observation.providerRevisionTime !== fact.providerRevisionTime ||
    observation.collectedAt !== fact.collectedAt
  )
    return invalidValue("history accounting observation fields disagree");

  const expectedSource = sourceForFactKind(fact.factKind);
  if (expectedSource === undefined || observation.source !== expectedSource)
    return invalidValue("history accounting fact kind and source disagree");

  if (
    fact.factKind === "transaction" &&
    observation.eventIdentity !== `transaction:${fact.transactionId}`
  )
    return invalidValue("history transaction identity does not match its fact");

  return ok(observation);
}

function sourceForFactKind(
  factKind: HistorySourceFact["factKind"],
): HistoryReadSource | undefined {
  switch (factKind) {
    case "order":
      return "order-history";
    case "execution":
      return "executions";
    case "closed-pnl":
      return "closed-pnl";
    case "transaction":
      return "transaction-log";
    default:
      return undefined;
  }
}

function groupingKey(fact: ClosedPnlHistorySourceFact): string {
  return JSON.stringify([
    fact.groupingKey.category,
    fact.groupingKey.symbol,
    fact.groupingKey.orderId,
    fact.groupingKey.createdTime,
  ]);
}

function selectClosedPnlGroup(
  rows: readonly HistoryStoredObservation[],
  groupKey: ClosedPnlHistorySourceFact["groupingKey"],
): {
  readonly selected?: HistoryStoredObservation;
  readonly conflict?: HistoryAccountingSelectionConflict;
} {
  const unique = new Map<string, HistoryStoredObservation[]>();
  for (const row of rows) {
    const versions = unique.get(row.contentHash) ?? [];
    versions.push(row);
    unique.set(row.contentHash, versions);
  }
  const distinct = [...unique.values()].map(
    (versions) => [...versions].sort(compareObservationRecency)[0]!,
  );
  if (distinct.length === 1) {
    const only = distinct[0];
    return only === undefined ? {} : { selected: only };
  }

  const closedRows = distinct.filter(
    (
      row,
    ): row is HistoryStoredObservation & { fact: ClosedPnlHistorySourceFact } =>
      row.fact.factKind === "closed-pnl",
  );
  if (
    closedRows.length !== distinct.length ||
    closedRows.some((row) => row.providerRevisionTime === null)
  ) {
    return {
      conflict: {
        kind: "closed-pnl-revision-conflict",
        groupingKey: groupKey,
        observationIds: rows.map(({ observationId }) => observationId).sort(),
      },
    };
  }

  const latestRevision = closedRows
    .map(({ providerRevisionTime }) => providerRevisionTime!)
    .sort((left, right) => right.localeCompare(left))[0];
  const latest = closedRows.filter(
    (row) => row.providerRevisionTime === latestRevision,
  );
  if (new Set(latest.map(({ contentHash }) => contentHash)).size > 1) {
    return {
      conflict: {
        kind: "closed-pnl-revision-conflict",
        groupingKey: latest[0]!.fact.groupingKey,
        observationIds: rows.map(({ observationId }) => observationId).sort(),
      },
    };
  }
  const selected = [...latest].sort(compareObservationRecency)[0];
  return selected === undefined ? {} : { selected };
}

export function selectCanonicalHistoryEvidence(
  input: SelectCanonicalHistoryEvidenceInput,
): Result<CanonicalHistoryEvidence> {
  if (
    !Array.isArray(input.observations) ||
    !Array.isArray(input.conflicts) ||
    !isRecord(input.scope)
  )
    return invalidValue("history accounting selection input is malformed");

  const observations: HistoryStoredObservation[] = [];
  for (const raw of input.observations) {
    const validated = validateObservation(raw);
    if (!validated.ok) return validated;
    if (!sameScope(validated.value.scope, input.scope))
      return invalidValue(
        "history accounting observations must share one account scope",
      );
    observations.push(validated.value);
  }

  const transactionConflicts = new Map<string, string[]>();
  for (const conflict of input.conflicts) {
    if (conflict.source !== "transaction-log") continue;
    const prefix = "transaction:";
    if (
      !conflict.eventIdentity.startsWith(prefix) ||
      conflict.eventIdentity.length === prefix.length ||
      conflict.reason !== "IMMUTABLE_ID_CONTENT_CHANGED"
    )
      return invalidValue("stored transaction conflict identity is malformed");
    const transactionId = conflict.eventIdentity.slice(prefix.length);
    const conflictIds = transactionConflicts.get(transactionId) ?? [];
    conflictIds.push(conflict.conflictId);
    transactionConflicts.set(transactionId, conflictIds);
  }

  const selected: HistoryStoredObservation[] = [];
  const selectionConflicts: HistoryAccountingSelectionConflict[] = [];
  const transactionsById = new Map<string, HistoryStoredObservation[]>();
  const closedPnlByGroup = new Map<string, HistoryStoredObservation[]>();

  for (const observation of observations) {
    if (observation.fact.factKind === "transaction") {
      const group = transactionsById.get(observation.fact.transactionId) ?? [];
      group.push(observation);
      transactionsById.set(observation.fact.transactionId, group);
    } else if (observation.fact.factKind === "closed-pnl") {
      const key = groupingKey(observation.fact);
      const group = closedPnlByGroup.get(key) ?? [];
      group.push(observation);
      closedPnlByGroup.set(key, group);
    } else {
      selected.push(observation);
    }
  }

  for (const [transactionId, rows] of transactionsById) {
    const conflictIds = transactionConflicts.get(transactionId) ?? [];
    const contentHashes = new Set(rows.map(({ contentHash }) => contentHash));
    if (contentHashes.size > 1 || conflictIds.length > 0) {
      selectionConflicts.push({
        kind: "transaction-identity-conflict",
        transactionId,
        observationIds: rows.map(({ observationId }) => observationId).sort(),
        conflictIds: [...new Set(conflictIds)].sort(),
      });
      transactionConflicts.delete(transactionId);
      continue;
    }
    selected.push([...rows].sort(compareObservationRecency)[0]!);
    transactionConflicts.delete(transactionId);
  }

  for (const [transactionId, conflictIds] of transactionConflicts) {
    selectionConflicts.push({
      kind: "transaction-identity-conflict",
      transactionId,
      observationIds: [],
      conflictIds: [...new Set(conflictIds)].sort(),
    });
  }

  for (const rows of closedPnlByGroup.values()) {
    const first = rows[0]?.fact;
    if (!first || first.factKind !== "closed-pnl")
      return invalidValue("closed-PnL group is malformed");
    const result = selectClosedPnlGroup(rows, first.groupingKey);
    if (result.selected) selected.push(result.selected);
    if (result.conflict) selectionConflicts.push(result.conflict);
  }

  selected.sort(compareObservationOrder);
  selectionConflicts.sort((left, right) => {
    const identity = (conflict: HistoryAccountingSelectionConflict) =>
      conflict.kind === "transaction-identity-conflict"
        ? `transaction:${conflict.transactionId}`
        : `closed-pnl:${JSON.stringify([
            conflict.groupingKey.category,
            conflict.groupingKey.symbol,
            conflict.groupingKey.orderId,
            conflict.groupingKey.createdTime,
          ])}`;
    return identity(left).localeCompare(identity(right));
  });

  return ok({ observations: selected, conflicts: selectionConflicts });
}

function decimalField(
  value: string | null,
  field: string,
): Result<DecimalValue | null> {
  if (value === null) return ok(null);
  const parsed = DecimalValue.fromString(value);
  if (!parsed.ok)
    return invalidAccounting(`transaction ${field} is not a valid decimal`);
  return ok(parsed.value);
}

function movementKind(
  fact: TransactionHistorySourceFact,
): HistoryTransactionMovementKind {
  const type = (fact.type ?? "").trim().toUpperCase();
  const subtype = (fact.transSubType ?? "").trim().toUpperCase();
  if (type === "TRANSFER_IN" || type === "TRANSFER_OUT") return "transfer";
  if (type === "TRADE" || type === "TRADE_REBATE") return "trade";
  if (type === "SETTLEMENT" || /FUND/iu.test(`${type} ${subtype}`))
    return "funding";
  return "unknown";
}

/** Normalize one selected transaction; call selectCanonicalHistoryEvidence first. */
export function normalizeHistoryTransaction(
  observation: HistoryStoredObservation,
): Result<NormalizedHistoryTransaction> {
  const validated = validateObservation(observation);
  if (!validated.ok) return validated;
  const fact = validated.value.fact;
  if (fact.factKind !== "transaction")
    return invalidAccounting("history observation is not a transaction");

  const cashFlow = decimalField(fact.cashFlow, "cashFlow");
  const funding = decimalField(fact.funding, "funding");
  const fee = decimalField(fact.fee, "fee");
  const change = decimalField(fact.change, "change");
  const bonusChange = decimalField(fact.bonusChange, "bonusChange");
  const cashBalance = decimalField(fact.cashBalance, "cashBalance");
  if (!cashFlow.ok) return cashFlow;
  if (!funding.ok) return funding;
  if (!fee.ok) return fee;
  if (!change.ok) return change;
  if (!bonusChange.ok) return bonusChange;
  if (!cashBalance.ok) return cashBalance;

  const tradeMayOmitFunding =
    (fact.type ?? "").trim().toUpperCase() === "TRADE";
  let expectedChange: DecimalValue | null = null;
  if (cashFlow.value !== null && fee.value !== null) {
    if (funding.value !== null) {
      expectedChange = cashFlow.value.add(funding.value).subtract(fee.value);
    } else if (tradeMayOmitFunding) {
      expectedChange = cashFlow.value.subtract(fee.value);
    }
  }
  const componentCheck =
    expectedChange === null || change.value === null
      ? "incomplete"
      : expectedChange.compare(change.value) === 0
        ? "matched"
        : "mismatched";
  const kind = movementKind(fact);

  return ok({
    observationId: validated.value.observationId,
    transactionId: fact.transactionId,
    category: fact.category,
    movementKind: kind,
    currency: fact.currency,
    change: change.value?.toString() ?? null,
    cashFlow: cashFlow.value?.toString() ?? null,
    funding: funding.value?.toString() ?? null,
    fee: fee.value?.toString() ?? null,
    bonusChange: bonusChange.value?.toString() ?? null,
    cashBalance: cashBalance.value?.toString() ?? null,
    expectedChange: expectedChange?.toString() ?? null,
    componentCheck,
    strategyDisposition:
      kind === "trade" || kind === "funding"
        ? "corroboration-only"
        : "account-movement-only",
  });
}
