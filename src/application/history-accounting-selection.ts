import {
  decodeHistoryAccountingScope,
  type HistoryAccountingScope,
} from "../domain/accounting/accounting-scope.js";
import type {
  HistorySourceFact,
  TransactionHistorySourceFact,
} from "../domain/accounting/history-source-fact.js";
import type { PlanHash } from "../domain/identity/canonical-serialization.js";
import { deepFreeze } from "../domain/shared/deep-freeze.js";
import { domainError } from "../domain/shared/errors.js";
import { fail, ok, type Result } from "../domain/shared/result.js";
import { parseUtcTimestamp, type UtcTimestamp } from "../domain/shared/time.js";
import { requireHash } from "../domain/shared/validation.js";
import { HISTORY_READ_SOURCES } from "../ports/history-read.js";
import type {
  HistoryConflictSummary,
  HistoryCheckpoint,
  HistoryStoreScope,
  HistoryStoredObservation,
} from "../ports/history-store.js";
import {
  compareObservationOrder,
  selectCanonicalHistoryEvidence,
  type HistoryAccountingSelectionConflict,
} from "./history-accounting-normalization.js";

export interface HistoryAccountingCaptureBracket {
  readonly fromMs: number;
  readonly toMs: number;
}

export interface ScopedHistoryAccountingEpochBounds {
  readonly openingBoundary: UtcTimestamp;
  readonly closingBoundary: UtcTimestamp;
  readonly openingCaptureBracket: HistoryAccountingCaptureBracket;
  readonly closingCaptureBracket: HistoryAccountingCaptureBracket;
}

export interface SelectScopedHistoryAccountingEvidenceInput {
  readonly scope: HistoryStoreScope;
  readonly accountingScope: HistoryAccountingScope;
  readonly epoch: ScopedHistoryAccountingEpochBounds;
  readonly observations: readonly HistoryStoredObservation[];
  readonly conflicts: readonly HistoryConflictSummary[];
}

export interface ScopedHistoryAccountingEvidenceIdentity {
  readonly source: HistoryStoredObservation["source"];
  readonly eventIdentity: string;
  readonly contentHash: string;
  readonly observationId: string;
}

export interface ScopedHistoryAccountingConflictDisposition {
  readonly source: HistoryStoredObservation["source"];
  readonly eventIdentity: string;
  readonly disposition: "blocking" | "independent-excluded";
  readonly conflictIds: readonly string[];
  readonly observationIds: readonly string[];
  readonly reason:
    | "stored-conflict"
    | "transaction-identity-conflict"
    | "closed-pnl-revision-conflict";
}

export interface ScopedHistoryAccountingExclusion {
  readonly source: "transaction-log";
  readonly eventIdentity: string;
  readonly observationIds: readonly string[];
  readonly currency: string;
  readonly type: string;
  readonly reason: "independent-out-of-scope-transaction";
}

export interface ScopedHistoryAccountingEvidence {
  readonly accountingScope: HistoryAccountingScope;
  readonly accountingScopeHash: PlanHash;
  /** Canonical evidence in the epoch or exactly linked to it. */
  readonly selectedObservations: readonly HistoryStoredObservation[];
  /** Stable content identities for report and dependency hashing. */
  readonly identities: readonly ScopedHistoryAccountingEvidenceIdentity[];
  readonly conflicts: readonly ScopedHistoryAccountingConflictDisposition[];
  /** Display evidence only; callers must not include these in dependency hashes. */
  readonly exclusions: readonly ScopedHistoryAccountingExclusion[];
  readonly exclusionCount: number;
  readonly exclusionsTruncated: boolean;
}

export function ignoreProvenIndependentScopedConflicts(
  checkpoints: readonly HistoryCheckpoint[],
  conflicts: readonly HistoryConflictSummary[],
  selection: ScopedHistoryAccountingEvidence,
): readonly HistoryCheckpoint[] {
  const dispositionByConflictId = new Map(
    selection.conflicts.flatMap((disposition) =>
      disposition.conflictIds.map(
        (id) => [id, disposition.disposition] as const,
      ),
    ),
  );
  return checkpoints.map((checkpoint) => {
    // Ingestion marks even a terminal conflict page partial; scoped coverage
    // may restore traversal only after proving every located conflict below.
    const terminalConflict =
      checkpoint.cursor === null &&
      (checkpoint.status === "traversed" || checkpoint.status === "partial");
    if (
      checkpoint.reasonCode !== "SOURCE_CONFLICT" ||
      !terminalConflict ||
      !Number.isSafeInteger(checkpoint.conflictCount) ||
      checkpoint.conflictCount <= 0
    )
      return checkpoint;
    const located = conflicts.filter(
      (conflict) =>
        conflict.source === checkpoint.source &&
        conflict.windows?.some(
          ({ filterHash, window }) =>
            filterHash === checkpoint.filterHash &&
            window.fromMs === checkpoint.window.fromMs &&
            window.toMs === checkpoint.window.toMs,
        ),
    );
    if (
      located.length !== checkpoint.conflictCount ||
      located.some((conflict) => {
        const disposition = dispositionByConflictId.get(conflict.conflictId);
        return disposition !== "independent-excluded";
      })
    )
      return checkpoint;
    return { ...checkpoint, status: "traversed", reasonCode: null };
  });
}

const MAX_EXCLUSIONS = 128;
const SAFE_OUTSIDE_TYPES = new Set([
  "TRANSFER_IN",
  "TRANSFER_OUT",
  "AIRDROP",
  "BONUS",
  "BONUS_RECOLLECT",
  "BONUS_TRANSFER_IN",
  "BONUS_TRANSFER_OUT",
]);

interface ConflictDispositionBuilder {
  readonly source: HistoryStoredObservation["source"];
  readonly eventIdentity: string;
  disposition: "blocking" | "independent-excluded";
  readonly conflictIds: Set<string>;
  readonly observationIds: Set<string>;
  reason: ScopedHistoryAccountingConflictDisposition["reason"];
}

function invalid(message: string): Result<never> {
  return fail(domainError("INVALID_ACCOUNTING", message));
}

function timestampMs(value: unknown): number | undefined {
  const parsed = parseUtcTimestamp(value);
  if (!parsed.ok) return undefined;
  const epoch = Date.parse(parsed.value);
  return Number.isSafeInteger(epoch) ? epoch : undefined;
}

function validEpoch(
  value: unknown,
): value is ScopedHistoryAccountingEpochBounds {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const epoch = value as Record<string, unknown>;
  const opening = timestampMs(epoch.openingBoundary);
  const closing = timestampMs(epoch.closingBoundary);
  const validBracket = (bracket: unknown, boundary: number): boolean => {
    if (
      bracket === null ||
      typeof bracket !== "object" ||
      Array.isArray(bracket)
    )
      return false;
    const candidate = bracket as Record<string, unknown>;
    return (
      Number.isSafeInteger(candidate.fromMs) &&
      Number.isSafeInteger(candidate.toMs) &&
      (candidate.fromMs as number) >= 0 &&
      (candidate.fromMs as number) <= boundary &&
      (candidate.toMs as number) >= boundary &&
      (candidate.toMs as number) >= (candidate.fromMs as number)
    );
  };
  return (
    opening !== undefined &&
    closing !== undefined &&
    opening < closing &&
    validBracket(epoch.openingCaptureBracket, opening) &&
    validBracket(epoch.closingCaptureBracket, closing)
  );
}

function inCaptureBracket(
  time: number,
  epoch: ScopedHistoryAccountingEpochBounds,
): boolean {
  return [epoch.openingCaptureBracket, epoch.closingCaptureBracket].some(
    ({ fromMs, toMs }) => time >= fromMs && time <= toMs,
  );
}

function inEpochOrBoundary(
  observation: HistoryStoredObservation,
  epoch: ScopedHistoryAccountingEpochBounds,
): boolean {
  const time = timestampMs(observation.providerEventTime);
  if (time === undefined) return true;
  const opening = timestampMs(epoch.openingBoundary)!;
  const closing = timestampMs(epoch.closingBoundary)!;
  return (time >= opening && time <= closing) || inCaptureBracket(time, epoch);
}

function groupTransactions(
  observations: readonly HistoryStoredObservation[],
): Map<string, HistoryStoredObservation[]> {
  const groups = new Map<string, HistoryStoredObservation[]>();
  for (const row of observations) {
    if (row.fact.factKind !== "transaction") continue;
    const rows = groups.get(row.fact.transactionId) ?? [];
    rows.push(row);
    groups.set(row.fact.transactionId, rows);
  }
  return groups;
}

function transactionType(fact: TransactionHistorySourceFact): string | null {
  const type = fact.type?.trim().toUpperCase() ?? "";
  return type.length === 0 ? null : type;
}

function hasProviderLinks(fact: TransactionHistorySourceFact): boolean {
  return [fact.orderId, fact.tradeId, fact.orderLinkId].some(
    (value) => value !== null && value.trim().length > 0,
  );
}

function proveIndependentTransaction(
  rows: readonly HistoryStoredObservation[],
  conflicts: readonly HistoryConflictSummary[],
  includedCurrencies: readonly string[],
): { readonly currency: string; readonly type: string } | undefined {
  const facts = rows.flatMap((row) =>
    row.fact.factKind === "transaction" ? [row.fact] : [],
  );
  if (facts.length !== rows.length || facts.length === 0) return undefined;
  const currency = facts[0]!.currency?.trim().toUpperCase() ?? "";
  const type = transactionType(facts[0]!);
  if (
    currency.length === 0 ||
    includedCurrencies.includes(currency) ||
    type === null ||
    !SAFE_OUTSIDE_TYPES.has(type) ||
    facts.some(hasProviderLinks)
  )
    return undefined;
  if (
    !facts.every(
      (fact) =>
        fact.currency?.trim().toUpperCase() === currency &&
        transactionType(fact) === type,
    )
  )
    return undefined;

  for (const conflict of conflicts) {
    if (
      conflict.reason !== "IMMUTABLE_ID_CONTENT_CHANGED" ||
      conflict.source !== "transaction-log" ||
      conflict.existingHash === conflict.incomingHash
    )
      return undefined;
    const hashes = new Set(rows.map(({ contentHash }) => contentHash));
    if (
      !hashes.has(conflict.existingHash) ||
      !hashes.has(conflict.incomingHash)
    )
      return undefined;
  }
  return { currency, type };
}

function factLinks(fact: HistorySourceFact): readonly string[] {
  const links: string[] = [];
  const add = (kind: string, value: string | null): void => {
    if (value !== null && value.trim().length > 0)
      links.push(`${kind}:${value.trim()}`);
  };
  switch (fact.factKind) {
    case "transaction":
      add("order", fact.orderId);
      add("order-link", fact.orderLinkId);
      add("trade", fact.tradeId);
      break;
    case "execution":
      add("order", fact.orderId);
      add("order-link", fact.orderLinkId);
      add("exec", fact.execId);
      break;
    case "order":
      add("order", fact.orderId);
      add("order-link", fact.orderLinkId);
      add("order-link", fact.parentOrderLinkId);
      break;
    case "closed-pnl":
      add("order", fact.orderId);
      break;
  }
  return links;
}

function linksMatch(
  row: HistoryStoredObservation,
  links: ReadonlySet<string>,
): boolean {
  return factLinks(row.fact).some((link) => links.has(link));
}

function validConflict(value: unknown): value is HistoryConflictSummary {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const conflict = value as Record<string, unknown>;
  if (
    typeof conflict.conflictId !== "string" ||
    conflict.conflictId.length === 0 ||
    typeof conflict.source !== "string" ||
    !(HISTORY_READ_SOURCES as readonly string[]).includes(conflict.source) ||
    typeof conflict.eventIdentity !== "string" ||
    conflict.eventIdentity.length === 0 ||
    !requireHash(conflict.existingHash, "existingHash").ok ||
    !requireHash(conflict.incomingHash, "incomingHash").ok ||
    ![
      "IMMUTABLE_ID_CONTENT_CHANGED",
      "ORDER_REVISION_CONTENT_CHANGED",
    ].includes(String(conflict.reason)) ||
    timestampMs(conflict.recordedAt) === undefined
  )
    return false;
  if (conflict.windows === undefined) return true;
  if (!Array.isArray(conflict.windows)) return false;
  return conflict.windows.every((value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return false;
    const entry = value as Record<string, unknown>;
    if (
      typeof entry.filterHash !== "string" ||
      entry.window === null ||
      typeof entry.window !== "object"
    )
      return false;
    const window = entry.window as Record<string, unknown>;
    return (
      Number.isSafeInteger(window.fromMs) &&
      Number.isSafeInteger(window.toMs) &&
      (window.fromMs as number) >= 0 &&
      (window.toMs as number) >= (window.fromMs as number)
    );
  });
}

function conflictInEpoch(
  conflict: HistoryConflictSummary,
  rows: readonly HistoryStoredObservation[],
  epoch: ScopedHistoryAccountingEpochBounds,
): boolean {
  const overlapsCaptureBracket = ({
    window,
  }: NonNullable<HistoryConflictSummary["windows"]>[number]) =>
    window.fromMs <= epoch.closingCaptureBracket.toMs &&
    window.toMs >= epoch.openingCaptureBracket.fromMs;

  if (rows.length > 0) {
    if (rows.some((row) => inEpochOrBoundary(row, epoch))) return true;
    return conflict.windows?.some(overlapsCaptureBracket) ?? false;
  }
  if (!conflict.windows || conflict.windows.length === 0) return true;
  return conflict.windows.some(overlapsCaptureBracket);
}

function addDisposition(
  output: Map<string, ConflictDispositionBuilder>,
  input: Omit<
    ScopedHistoryAccountingConflictDisposition,
    "conflictIds" | "observationIds"
  > & {
    readonly conflictIds: readonly string[];
    readonly observationIds: readonly string[];
  },
): void {
  const key = `${input.source}\u0000${input.eventIdentity}`;
  const existing = output.get(key);
  if (existing) {
    if (input.disposition === "blocking") existing.disposition = "blocking";
    for (const id of input.conflictIds) existing.conflictIds.add(id);
    for (const id of input.observationIds) existing.observationIds.add(id);
    return;
  }
  output.set(key, {
    source: input.source,
    eventIdentity: input.eventIdentity,
    disposition: input.disposition,
    conflictIds: new Set(input.conflictIds),
    observationIds: new Set(input.observationIds),
    reason: input.reason,
  });
}

function canonicalConflictIdentity(
  conflict: HistoryAccountingSelectionConflict,
): {
  readonly source: HistoryStoredObservation["source"];
  readonly eventIdentity: string;
} {
  if (conflict.kind === "transaction-identity-conflict")
    return {
      source: "transaction-log",
      eventIdentity: `transaction:${conflict.transactionId}`,
    };
  return {
    source: "closed-pnl",
    eventIdentity: `closed-pnl-group:${JSON.stringify([
      conflict.groupingKey.category,
      conflict.groupingKey.symbol,
      conflict.groupingKey.orderId,
      conflict.groupingKey.createdTime,
    ])}`,
  };
}

function select(
  input: SelectScopedHistoryAccountingEvidenceInput,
): Result<ScopedHistoryAccountingEvidence> {
  if (
    input === null ||
    typeof input !== "object" ||
    !Array.isArray(input.observations) ||
    !Array.isArray(input.conflicts) ||
    !validEpoch(input.epoch)
  )
    return invalid("scoped history accounting selection input is malformed");
  const accountingScope = decodeHistoryAccountingScope(input.accountingScope);
  if (!accountingScope.ok) return accountingScope;
  const canonical = selectCanonicalHistoryEvidence({
    scope: input.scope,
    observations: input.observations,
    conflicts: [],
  });
  if (!canonical.ok) return canonical;
  if (!input.conflicts.every(validConflict))
    return invalid("stored history conflict is malformed");

  const groups = groupTransactions(input.observations);
  const byIdentity = new Map<string, HistoryStoredObservation[]>();
  const byObservationId = new Map<string, HistoryStoredObservation[]>();
  for (const row of input.observations) {
    const matchingIds = byObservationId.get(row.observationId) ?? [];
    matchingIds.push(row);
    byObservationId.set(row.observationId, matchingIds);
    const key = `${row.source}\u0000${row.eventIdentity}`;
    const matches = byIdentity.get(key) ?? [];
    matches.push(row);
    byIdentity.set(key, matches);
  }
  const summariesByTransaction = new Map<string, HistoryConflictSummary[]>();
  for (const conflict of input.conflicts) {
    if (
      conflict.source !== "transaction-log" ||
      !conflict.eventIdentity.startsWith("transaction:")
    )
      continue;
    const id = conflict.eventIdentity.slice("transaction:".length);
    const matches = summariesByTransaction.get(id) ?? [];
    matches.push(conflict);
    summariesByTransaction.set(id, matches);
  }

  const canonicalByTransaction = new Map<string, HistoryStoredObservation>();
  const selected = new Map<string, HistoryStoredObservation>();
  for (const row of canonical.value.observations) {
    if (row.fact.factKind === "transaction")
      canonicalByTransaction.set(row.fact.transactionId, row);
    else if (inEpochOrBoundary(row, input.epoch))
      selected.set(row.observationId, row);
  }

  const exclusions: ScopedHistoryAccountingExclusion[] = [];
  let exclusionCount = 0;
  const compareExclusions = (
    left: Pick<ScopedHistoryAccountingExclusion, "currency" | "eventIdentity">,
    right: Pick<ScopedHistoryAccountingExclusion, "currency" | "eventIdentity">,
  ): number =>
    left.currency.localeCompare(right.currency) ||
    left.eventIdentity.localeCompare(right.eventIdentity);
  const independentIds = new Set<string>();
  for (const [id, rows] of groups) {
    const inWindow = rows.some((row) => inEpochOrBoundary(row, input.epoch));
    const summaries = (summariesByTransaction.get(id) ?? []).filter(
      (conflict) => conflictInEpoch(conflict, rows, input.epoch),
    );
    const independent = proveIndependentTransaction(
      rows,
      summaries,
      accountingScope.value.nativeCurrencies,
    );
    if (independent) {
      independentIds.add(id);
      if (inWindow) {
        exclusionCount += 1;
        const exclusion = {
          source: "transaction-log",
          eventIdentity: `transaction:${id}`,
          currency: independent.currency,
          type: independent.type,
          reason: "independent-out-of-scope-transaction",
        } as const;
        const last = exclusions.at(-1);
        if (
          exclusions.length === MAX_EXCLUSIONS &&
          last !== undefined &&
          compareExclusions(exclusion, last) >= 0
        )
          continue;
        const completeExclusion: ScopedHistoryAccountingExclusion = {
          ...exclusion,
          observationIds: rows.map(({ observationId }) => observationId).sort(),
        };
        const insertionIndex = exclusions.findIndex(
          (existing) => compareExclusions(completeExclusion, existing) < 0,
        );
        exclusions.splice(
          insertionIndex < 0 ? exclusions.length : insertionIndex,
          0,
          completeExclusion,
        );
        if (exclusions.length > MAX_EXCLUSIONS) exclusions.pop();
      }
    } else if (inWindow) {
      const canonicalRow = canonicalByTransaction.get(id);
      if (canonicalRow) selected.set(canonicalRow.observationId, canonicalRow);
    }
  }

  // Close over exact order, order-link, parent-order-link, trade and exec identities.
  let changed = true;
  while (changed) {
    changed = false;
    const links = new Set<string>();
    for (const row of selected.values())
      for (const link of factLinks(row.fact)) links.add(link);
    for (const row of canonical.value.observations) {
      if (selected.has(row.observationId)) continue;
      if (
        row.fact.factKind === "transaction" &&
        independentIds.has(row.fact.transactionId)
      )
        continue;
      if (!linksMatch(row, links)) continue;
      selected.set(row.observationId, row);
      changed = true;
    }
  }
  const selectedLinks = new Set<string>();
  for (const row of selected.values())
    for (const link of factLinks(row.fact)) selectedLinks.add(link);

  const dispositions = new Map<string, ConflictDispositionBuilder>();
  for (const conflict of input.conflicts) {
    const rows =
      byIdentity.get(`${conflict.source}\u0000${conflict.eventIdentity}`) ?? [];
    const relevant =
      conflictInEpoch(conflict, rows, input.epoch) ||
      rows.some((row) => linksMatch(row, selectedLinks));
    if (!relevant) continue;
    const id = conflict.eventIdentity.startsWith("transaction:")
      ? conflict.eventIdentity.slice("transaction:".length)
      : "";
    const independent =
      conflict.source === "transaction-log" &&
      id.length > 0 &&
      proveIndependentTransaction(
        groups.get(id) ?? [],
        summariesByTransaction.get(id) ?? [],
        accountingScope.value.nativeCurrencies,
      ) !== undefined;
    addDisposition(dispositions, {
      source: conflict.source,
      eventIdentity: conflict.eventIdentity,
      disposition: independent ? "independent-excluded" : "blocking",
      conflictIds: [conflict.conflictId],
      observationIds: rows.map(({ observationId }) => observationId),
      reason: "stored-conflict",
    });
  }

  for (const conflict of canonical.value.conflicts) {
    const identity = canonicalConflictIdentity(conflict);
    const rows = conflict.observationIds.flatMap(
      (observationId) => byObservationId.get(observationId) ?? [],
    );
    const relevant = rows.some(
      (row) =>
        inEpochOrBoundary(row, input.epoch) || linksMatch(row, selectedLinks),
    );
    if (!relevant) continue;
    const transactionId =
      conflict.kind === "transaction-identity-conflict"
        ? conflict.transactionId
        : "";
    const independent =
      transactionId.length > 0 &&
      proveIndependentTransaction(
        groups.get(transactionId) ?? [],
        summariesByTransaction.get(transactionId) ?? [],
        accountingScope.value.nativeCurrencies,
      ) !== undefined;
    addDisposition(dispositions, {
      source: identity.source,
      eventIdentity: identity.eventIdentity,
      disposition: independent ? "independent-excluded" : "blocking",
      conflictIds:
        conflict.kind === "transaction-identity-conflict"
          ? conflict.conflictIds
          : [],
      observationIds: conflict.observationIds,
      reason:
        conflict.kind === "transaction-identity-conflict"
          ? "transaction-identity-conflict"
          : "closed-pnl-revision-conflict",
    });
  }

  const selectedObservations = [...selected.values()].sort(
    compareObservationOrder,
  );
  const identities = selectedObservations.map((row) => ({
    source: row.source,
    eventIdentity: row.eventIdentity,
    contentHash: row.contentHash,
    observationId: row.observationId,
  }));
  const conflicts = [...dispositions.values()]
    .map((value) => ({
      source: value.source,
      eventIdentity: value.eventIdentity,
      disposition: value.disposition,
      conflictIds: [...value.conflictIds].sort(),
      observationIds: [...value.observationIds].sort(),
      reason: value.reason,
    }))
    .sort(
      (left, right) =>
        left.source.localeCompare(right.source) ||
        left.eventIdentity.localeCompare(right.eventIdentity),
    );

  return ok(
    deepFreeze({
      accountingScope: accountingScope.value,
      accountingScopeHash: accountingScope.value.scopeHash,
      selectedObservations,
      identities,
      conflicts,
      exclusions,
      exclusionCount,
      exclusionsTruncated: exclusionCount > MAX_EXCLUSIONS,
    }),
  );
}

export function selectScopedHistoryAccountingEvidence(
  input: SelectScopedHistoryAccountingEvidenceInput,
): Result<ScopedHistoryAccountingEvidence> {
  try {
    return select(input);
  } catch {
    return invalid(
      "scoped history accounting evidence could not be inspected safely",
    );
  }
}
