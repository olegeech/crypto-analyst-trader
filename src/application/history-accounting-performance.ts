import {
  selectCanonicalHistoryEvidence,
  type HistoryAccountingSelectionConflict,
} from "./history-accounting-normalization.js";
import type {
  HistoryAttributionProjection,
  HistoryLineageKind,
} from "./history-attribution.js";
import type { ClosedPnlHistorySourceFact } from "../domain/accounting/history-source-fact.js";
import { domainError } from "../domain/shared/errors.js";
import { DecimalValue } from "../domain/shared/decimal.js";
import { fail, ok, type Result } from "../domain/shared/result.js";
import { parseUtcTimestamp, type UtcTimestamp } from "../domain/shared/time.js";
import {
  isRecord,
  requireHash,
  requireIdentifier,
  requireSafeText,
} from "../domain/shared/validation.js";
import type {
  HistoryConflictSummary,
  HistoryStoreScope,
  HistoryStoredObservation,
} from "../ports/history-store.js";
import {
  HISTORY_READ_SOURCES,
  type HistoryReadSource,
} from "../ports/history-read.js";

export interface VerifiedSettlementCurrency {
  readonly currency: string | null;
  readonly verified: boolean;
  readonly evidence: string | null;
}

export interface HistoryPositionOwnerEvidence {
  readonly sourceKind: HistoryLineageKind;
  readonly sourceId: string;
  /** Exact attributed execution observations that establish position ownership. */
  readonly executionObservationIds: readonly string[];
}

export interface HistoryPositionUplEvidence {
  readonly scope: HistoryStoreScope;
  readonly asOf: UtcTimestamp;
  readonly positions: readonly {
    readonly positionId: string;
    readonly symbol: string;
    readonly unrealizedPnl: string;
    readonly currency: VerifiedSettlementCurrency;
    readonly ownerEvidence?: HistoryPositionOwnerEvidence;
  }[];
}

export interface HistoryAccountingPerformanceInput {
  readonly scope: HistoryStoreScope;
  readonly attribution: HistoryAttributionProjection;
  readonly sourceConflicts: readonly HistoryConflictSummary[];
  /** Only verified provider instrument metadata may denominate closed PnL. */
  readonly settlementCurrencyBySymbol: Readonly<
    Record<string, VerifiedSettlementCurrency>
  >;
  /** Bounded as-of evidence; never merged into realized performance. */
  readonly positionUplEvidence?: HistoryPositionUplEvidence;
}

export type HistoryPerformanceStatus = "complete" | "partial" | "unknown";

export interface HistoryFeeFundingCorroboration {
  readonly openFee: string | null;
  readonly closeFee: string | null;
  readonly fundingFee: string | null;
  readonly currency: string | null;
  readonly status: "complete" | "incomplete";
  /** These fields corroborate the provider net and are never added to it. */
  readonly includedInReportedClosedPnl: false;
}

export interface HistoryOwnedClosedPnlRow {
  readonly observationId: string;
  readonly source: {
    readonly kind: HistoryLineageKind;
    readonly sourceId: string;
  };
  readonly symbol: string;
  readonly utcDay: string;
  readonly currency: string | null;
  /** Provider-reported closedPnl, retained as-is; no component is re-added. */
  readonly reportedClosedPnl: string | null;
  readonly status: HistoryPerformanceStatus;
  readonly reasonCodes: readonly string[];
  readonly feeFunding: HistoryFeeFundingCorroboration;
}

export interface HistoryNonStrategyClosedPnlRow {
  readonly observationId: string;
  readonly symbol: string;
  readonly utcDay: string;
  readonly currency: string | null;
  readonly reportedClosedPnl: string | null;
  readonly ownership: "unmatched" | "ambiguous";
  readonly reason: "NO_EXACT_LINEAGE" | "MULTIPLE_EXACT_LINEAGES";
  readonly candidates: readonly {
    readonly kind: HistoryLineageKind;
    readonly sourceId: string;
  }[];
}

export interface HistoryRealizedGroup {
  readonly level: "account-day" | "owned-run-day" | "owned-run-symbol-day";
  readonly source: {
    readonly kind: HistoryLineageKind;
    readonly sourceId: string;
  } | null;
  readonly symbol: string | null;
  readonly utcDay: string;
  readonly currency: string | null;
  /** Null unless every included closed-PnL amount and denomination is known. */
  readonly amount: string | null;
  readonly status: HistoryPerformanceStatus;
  readonly reasonCodes: readonly string[];
  readonly observationIds: readonly string[];
}

export interface HistoryProjectedPositionUpl {
  readonly positionId: string;
  readonly symbol: string;
  readonly asOf: UtcTimestamp;
  readonly unrealizedPnl: string;
  readonly currency: string | null;
  readonly status: "known" | "unknown";
  readonly allocation: "account-level-unallocated" | "owned-run";
  readonly source?: {
    readonly kind: HistoryLineageKind;
    readonly sourceId: string;
  };
  readonly executionObservationIds: readonly string[];
}

export interface HistoryAccountingPerformanceProjection {
  readonly schemaVersion: "history-accounting-performance-projection/v1";
  readonly scope: HistoryStoreScope;
  readonly ownedClosedPnl: readonly HistoryOwnedClosedPnlRow[];
  readonly notStrategyPerformance: readonly HistoryNonStrategyClosedPnlRow[];
  readonly ownedRunSymbolDays: readonly HistoryRealizedGroup[];
  readonly ownedRunDays: readonly HistoryRealizedGroup[];
  readonly accountDays: readonly HistoryRealizedGroup[];
  readonly positionUpl: {
    readonly scope: HistoryStoreScope;
    readonly asOf: UtcTimestamp;
    readonly positions: readonly HistoryProjectedPositionUpl[];
  } | null;
  readonly selectionConflicts: readonly HistoryAccountingSelectionConflict[];
}

interface ParsedSettlementCurrency {
  readonly currency: string | null;
  readonly verified: boolean;
}

interface GroupAccumulator {
  readonly level: HistoryRealizedGroup["level"];
  readonly source: HistoryRealizedGroup["source"];
  readonly symbol: string | null;
  readonly utcDay: string;
  readonly rows: HistoryOwnedClosedPnlRow[];
}

function invalidValue(message: string, field?: string): Result<never> {
  return fail(
    domainError(
      "INVALID_VALUE",
      message,
      field === undefined ? undefined : { field },
    ),
  );
}

function sameScope(left: HistoryStoreScope, right: HistoryStoreScope): boolean {
  return (
    left.exchange === right.exchange &&
    left.environment === right.environment &&
    left.accountId === right.accountId
  );
}

function validateScope(
  value: unknown,
  field: string,
): Result<HistoryStoreScope> {
  if (!isRecord(value))
    return invalidValue(`${field} must be an object`, field);
  if (value.exchange !== "bybit")
    return invalidValue(`${field} exchange must be bybit`, field);
  if (
    value.environment !== "demo" &&
    value.environment !== "testnet" &&
    value.environment !== "mainnet"
  )
    return invalidValue(`${field} environment is invalid`, field);
  const accountId = requireHash(value.accountId, `${field}.accountId`);
  if (!accountId.ok) return accountId;
  return ok({
    exchange: "bybit",
    environment: value.environment,
    accountId: accountId.value,
  });
}

function validateCurrencyEvidence(
  value: unknown,
  field: string,
): Result<ParsedSettlementCurrency> {
  if (!isRecord(value) || typeof value.verified !== "boolean")
    return invalidValue(`${field} verification evidence is malformed`, field);
  let currency: string | null = null;
  if (value.currency !== null && value.currency !== undefined) {
    const parsedCurrency = requireIdentifier(
      value.currency,
      `${field}.currency`,
    );
    if (!parsedCurrency.ok) return parsedCurrency;
    if (!/^[A-Z0-9]{2,16}$/u.test(parsedCurrency.value))
      return invalidValue(`${field} currency must be uppercase`, field);
    currency = parsedCurrency.value;
  }
  if (value.evidence !== null && value.evidence !== undefined) {
    const evidence = requireSafeText(value.evidence, `${field}.evidence`);
    if (!evidence.ok) return evidence;
  }
  if (
    value.verified &&
    (value.currency === null || value.currency === undefined)
  )
    return invalidValue(`${field} verified currency is missing`, field);
  if (
    value.verified &&
    (value.evidence === null || value.evidence === undefined)
  )
    return invalidValue(`${field} verification evidence is missing`, field);
  return ok({
    currency: value.verified ? currency : null,
    verified: value.verified,
  });
}

function exactDecimal(
  value: unknown,
  field: string,
): Result<DecimalValue | null> {
  if (value === null) return ok(null);
  const parsed = DecimalValue.fromString(value);
  if (!parsed.ok)
    return fail(
      domainError("INVALID_VALUE", `${field} must be an exact decimal string`, {
        field,
      }),
    );
  return ok(parsed.value);
}

function validateAttribution(
  value: unknown,
  scope: HistoryStoreScope,
): Result<HistoryAttributionProjection> {
  if (
    !isRecord(value) ||
    value.schemaVersion !== "history-attribution-projection/v1" ||
    !Array.isArray(value.observations)
  )
    return invalidValue(
      "history attribution projection is malformed",
      "attribution",
    );
  const ids = new Set<string>();
  for (const raw of value.observations) {
    if (
      !isRecord(raw) ||
      !isRecord(raw.observation) ||
      !isRecord(raw.observation.scope) ||
      !isRecord(raw.observation.fact)
    )
      return invalidValue(
        "attributed history observation is malformed",
        "attribution",
      );
    const observation = raw.observation as unknown as HistoryStoredObservation;
    const fact = observation.fact;
    if (
      typeof observation.observationId !== "string" ||
      observation.observationId.length === 0 ||
      ids.has(observation.observationId) ||
      !sameScope(observation.scope, scope) ||
      observation.source !== fact.source ||
      observation.contentHash !== fact.contentHash ||
      observation.providerEventTime !== fact.providerEventTime
    )
      return invalidValue(
        "attributed history observation scope or identity is invalid",
        "attribution",
      );
    ids.add(observation.observationId);
    if (
      raw.ownership !== null &&
      typeof raw.ownership === "object" &&
      !Array.isArray(raw.ownership)
    ) {
      const ownership = raw.ownership as Record<string, unknown>;
      if (ownership.status === "matched") {
        const source = ownership.source;
        const evidence = ownership.evidence;
        if (
          !isRecord(source) ||
          (source.kind !== "operator-mainnet-test" &&
            source.kind !== "prepared-leg") ||
          typeof source.sourceId !== "string" ||
          !Array.isArray(evidence) ||
          evidence.length === 0 ||
          evidence.some(
            (proof) =>
              !isRecord(proof) ||
              proof.sourceKind !== source.kind ||
              proof.sourceId !== source.sourceId,
          )
        )
          return invalidValue(
            "matched history ownership is malformed",
            "attribution",
          );
      } else if (ownership.status === "unmatched") {
        if (
          ownership.reason !== "NO_EXACT_LINEAGE" ||
          !Array.isArray(ownership.evidence) ||
          ownership.evidence.length !== 0
        )
          return invalidValue(
            "unmatched history ownership is malformed",
            "attribution",
          );
      } else if (ownership.status === "ambiguous") {
        if (
          ownership.reason !== "MULTIPLE_EXACT_LINEAGES" ||
          !Array.isArray(ownership.candidates) ||
          ownership.candidates.length < 2 ||
          !Array.isArray(ownership.evidence) ||
          ownership.evidence.length === 0
        )
          return invalidValue(
            "ambiguous history ownership is malformed",
            "attribution",
          );
      } else
        return invalidValue(
          "history ownership status is invalid",
          "attribution",
        );
    } else return invalidValue("history ownership is missing", "attribution");
  }
  return ok(value as unknown as HistoryAttributionProjection);
}

function settlementCurrencies(
  value: unknown,
): Result<ReadonlyMap<string, ParsedSettlementCurrency>> {
  if (!isRecord(value))
    return invalidValue(
      "settlementCurrencyBySymbol must be an object",
      "settlementCurrencyBySymbol",
    );
  const output = new Map<string, ParsedSettlementCurrency>();
  for (const [rawSymbol, rawCurrency] of Object.entries(value)) {
    const symbol = requireIdentifier(
      rawSymbol,
      "settlementCurrencyBySymbol.symbol",
    );
    if (!symbol.ok) return symbol;
    if (!/^[A-Z0-9]{2,32}$/u.test(symbol.value))
      return invalidValue(
        "settlement symbol must be uppercase",
        "settlementCurrencyBySymbol",
      );
    const currency = validateCurrencyEvidence(
      rawCurrency,
      `settlementCurrencyBySymbol.${symbol.value}`,
    );
    if (!currency.ok) return currency;
    output.set(symbol.value, currency.value);
  }
  return ok(output);
}

function validateSourceConflicts(
  value: unknown,
): Result<readonly HistoryConflictSummary[]> {
  if (!Array.isArray(value))
    return invalidValue("sourceConflicts must be an array", "sourceConflicts");
  const sources = new Set<HistoryReadSource>(HISTORY_READ_SOURCES);
  const output: HistoryConflictSummary[] = [];
  for (const conflict of value) {
    if (
      !isRecord(conflict) ||
      typeof conflict.source !== "string" ||
      !sources.has(conflict.source as HistoryReadSource) ||
      typeof conflict.reason !== "string" ||
      (conflict.reason !== "IMMUTABLE_ID_CONTENT_CHANGED" &&
        conflict.reason !== "ORDER_REVISION_CONTENT_CHANGED")
    )
      return invalidValue(
        "history source conflict is malformed",
        "sourceConflicts",
      );
    const conflictId = requireIdentifier(
      conflict.conflictId,
      "sourceConflicts.conflictId",
    );
    const eventIdentity = requireSafeText(
      conflict.eventIdentity,
      "sourceConflicts.eventIdentity",
    );
    const existingHash = requireHash(
      conflict.existingHash,
      "sourceConflicts.existingHash",
    );
    const incomingHash = requireHash(
      conflict.incomingHash,
      "sourceConflicts.incomingHash",
    );
    const recordedAt = parseUtcTimestamp(conflict.recordedAt);
    if (!conflictId.ok) return conflictId;
    if (!eventIdentity.ok || eventIdentity.value.length === 0)
      return invalidValue(
        "history conflict identity is malformed",
        "sourceConflicts.eventIdentity",
      );
    if (!existingHash.ok) return existingHash;
    if (!incomingHash.ok) return incomingHash;
    if (!recordedAt.ok) return recordedAt;
    output.push({
      conflictId: conflictId.value,
      source: conflict.source as HistoryReadSource,
      eventIdentity: eventIdentity.value,
      existingHash: existingHash.value,
      incomingHash: incomingHash.value,
      reason: conflict.reason,
      recordedAt: recordedAt.value,
    });
  }
  return ok(output);
}

function utcDay(value: unknown): Result<string> {
  const timestamp = parseUtcTimestamp(value);
  if (!timestamp.ok) return timestamp;
  return ok(timestamp.value.slice(0, 10));
}

function factAsClosedPnl(
  observation: HistoryStoredObservation,
): observation is HistoryStoredObservation & {
  fact: ClosedPnlHistorySourceFact;
} {
  return observation.fact.factKind === "closed-pnl";
}

function ownershipEvidenceMatches(
  evidence: unknown,
  source: { readonly kind: HistoryLineageKind; readonly sourceId: string },
): boolean {
  return (
    isRecord(evidence) &&
    evidence.sourceKind === source.kind &&
    evidence.sourceId === source.sourceId
  );
}

function groupKey(
  level: GroupAccumulator["level"],
  source: GroupAccumulator["source"],
  symbol: string | null,
  day: string,
): string {
  return JSON.stringify([
    level,
    source?.kind ?? null,
    source?.sourceId ?? null,
    symbol,
    day,
  ]);
}

function makeGroups(
  rows: readonly HistoryOwnedClosedPnlRow[],
  level: GroupAccumulator["level"],
): Result<readonly HistoryRealizedGroup[]> {
  const groups = new Map<string, GroupAccumulator>();
  for (const row of rows) {
    const source = level === "account-day" ? null : row.source;
    const symbol = level === "owned-run-symbol-day" ? row.symbol : null;
    const key = groupKey(level, source, symbol, row.utcDay);
    const current = groups.get(key);
    if (current) current.rows.push(row);
    else
      groups.set(key, {
        level,
        source,
        symbol,
        utcDay: row.utcDay,
        rows: [row],
      });
  }

  const output: HistoryRealizedGroup[] = [];
  for (const group of groups.values()) {
    const currencies = new Set(group.rows.map(({ currency }) => currency));
    const reasonCodes = new Set<string>();
    if (currencies.size > 1) reasonCodes.add("MIXED_CURRENCY");
    if (currencies.has(null)) reasonCodes.add("SETTLEMENT_CURRENCY_UNVERIFIED");
    if (group.rows.some(({ reportedClosedPnl }) => reportedClosedPnl === null))
      reasonCodes.add("CLOSED_PNL_UNKNOWN");
    const currency = currencies.size === 1 ? [...currencies][0]! : null;
    const allAmountsKnown = group.rows.every(
      ({ reportedClosedPnl }) => reportedClosedPnl !== null,
    );
    const currencyKnown = currency !== null;
    let amount: string | null = null;
    if (currencyKnown && allAmountsKnown) {
      let total: DecimalValue | undefined;
      for (const row of group.rows) {
        const parsed = DecimalValue.fromString(row.reportedClosedPnl);
        if (!parsed.ok) return parsed;
        total = total === undefined ? parsed.value : total.add(parsed.value);
      }
      amount = total?.toString() ?? "0";
    }
    if (group.rows.some(({ feeFunding }) => feeFunding.status === "incomplete"))
      reasonCodes.add("FEE_FUNDING_COMPONENTS_INCOMPLETE");
    const unknownNet = !allAmountsKnown || !currencyKnown;
    const status: HistoryPerformanceStatus = unknownNet
      ? "unknown"
      : reasonCodes.size > 0
        ? "partial"
        : "complete";
    output.push({
      level: group.level,
      source: group.source,
      symbol: group.symbol,
      utcDay: group.utcDay,
      currency,
      amount,
      status,
      reasonCodes: [...reasonCodes].sort(),
      observationIds: group.rows
        .map(({ observationId }) => observationId)
        .sort(),
    });
  }
  output.sort(
    (left, right) =>
      left.utcDay.localeCompare(right.utcDay) ||
      (left.source?.kind ?? "").localeCompare(right.source?.kind ?? "") ||
      (left.source?.sourceId ?? "").localeCompare(
        right.source?.sourceId ?? "",
      ) ||
      (left.symbol ?? "").localeCompare(right.symbol ?? ""),
  );
  return ok(output);
}

function validatePositionUpl(
  raw: unknown,
  scope: HistoryStoreScope,
  attribution: HistoryAttributionProjection,
): Result<HistoryAccountingPerformanceProjection["positionUpl"]> {
  if (raw === undefined) return ok(null);
  if (!isRecord(raw) || !Array.isArray(raw.positions))
    return invalidValue(
      "position UPL evidence is malformed",
      "positionUplEvidence",
    );
  const positionScope = validateScope(raw.scope, "positionUplEvidence.scope");
  if (!positionScope.ok) return positionScope;
  if (!sameScope(positionScope.value, scope))
    return invalidValue(
      "position UPL evidence must share the history account scope",
      "positionUplEvidence.scope",
    );
  const asOf = parseUtcTimestamp(raw.asOf);
  if (!asOf.ok) return asOf;
  const attributedById = new Map(
    attribution.observations.map((row) => [row.observation.observationId, row]),
  );
  const positions: HistoryProjectedPositionUpl[] = [];
  const seen = new Set<string>();
  for (const rawPosition of raw.positions) {
    if (!isRecord(rawPosition))
      return invalidValue(
        "position UPL row is malformed",
        "positionUplEvidence.positions",
      );
    const positionId = requireIdentifier(
      rawPosition.positionId,
      "positionUplEvidence.positionId",
    );
    const symbol = requireIdentifier(
      rawPosition.symbol,
      "positionUplEvidence.symbol",
    );
    if (!positionId.ok) return positionId;
    if (!symbol.ok) return symbol;
    const key = `${symbol.value}\u0000${positionId.value}`;
    if (seen.has(key))
      return invalidValue(
        "position UPL identities must be unique",
        "positionUplEvidence.positions",
      );
    seen.add(key);
    if (!/^[A-Z0-9]{2,32}$/u.test(symbol.value))
      return invalidValue(
        "position UPL symbol must be uppercase",
        "positionUplEvidence.symbol",
      );
    const amount = exactDecimal(
      rawPosition.unrealizedPnl,
      "positionUplEvidence.unrealizedPnl",
    );
    if (!amount.ok) return amount;
    if (amount.value === null)
      return invalidValue(
        "position unrealized PnL must be present",
        "positionUplEvidence.unrealizedPnl",
      );
    const currency = validateCurrencyEvidence(
      rawPosition.currency,
      "positionUplEvidence.currency",
    );
    if (!currency.ok) return currency;
    let source: HistoryPositionOwnerEvidence | undefined;
    let executionObservationIds: string[] = [];
    if (rawPosition.ownerEvidence !== undefined) {
      const rawOwner = rawPosition.ownerEvidence;
      if (
        !isRecord(rawOwner) ||
        (rawOwner.sourceKind !== "operator-mainnet-test" &&
          rawOwner.sourceKind !== "prepared-leg") ||
        typeof rawOwner.sourceId !== "string" ||
        !Array.isArray(rawOwner.executionObservationIds) ||
        rawOwner.executionObservationIds.length === 0
      )
        return invalidValue(
          "position owner evidence is malformed",
          "positionUplEvidence.ownerEvidence",
        );
      source = {
        sourceKind: rawOwner.sourceKind,
        sourceId: rawOwner.sourceId,
        executionObservationIds: rawOwner.executionObservationIds as string[],
      };
      executionObservationIds = [...source.executionObservationIds];
      if (
        executionObservationIds.some(
          (id) => typeof id !== "string" || id.length === 0,
        ) ||
        new Set(executionObservationIds).size !== executionObservationIds.length
      )
        return invalidValue(
          "position owner execution references are invalid",
          "positionUplEvidence.ownerEvidence",
        );
      for (const observationId of executionObservationIds) {
        const matched = attributedById.get(observationId);
        if (
          matched === undefined ||
          matched.observation.fact.factKind !== "execution" ||
          matched.observation.fact.symbol !== symbol.value ||
          matched.ownership.status !== "matched" ||
          matched.ownership.source.kind !== source.sourceKind ||
          matched.ownership.source.sourceId !== source.sourceId ||
          !matched.ownership.evidence.some((proof) =>
            ownershipEvidenceMatches(proof, {
              kind: source!.sourceKind,
              sourceId: source!.sourceId,
            }),
          )
        )
          return invalidValue(
            "position owner evidence is not backed by exact attributed executions",
            "positionUplEvidence.ownerEvidence",
          );
      }
    }
    const verifiedCurrency = currency.value.verified
      ? currency.value.currency
      : null;
    positions.push({
      positionId: positionId.value,
      symbol: symbol.value,
      asOf: asOf.value,
      unrealizedPnl: amount.value.toString(),
      currency: verifiedCurrency,
      status: verifiedCurrency === null ? "unknown" : "known",
      allocation:
        source === undefined ? "account-level-unallocated" : "owned-run",
      ...(source === undefined
        ? {}
        : { source: { kind: source.sourceKind, sourceId: source.sourceId } }),
      executionObservationIds: executionObservationIds.sort(),
    });
  }
  positions.sort(
    (left, right) =>
      left.symbol.localeCompare(right.symbol) ||
      left.positionId.localeCompare(right.positionId),
  );
  return ok({ scope: positionScope.value, asOf: asOf.value, positions });
}

export function projectHistoryAccountingPerformance(
  input: HistoryAccountingPerformanceInput,
): Result<HistoryAccountingPerformanceProjection> {
  const scope = validateScope(input.scope, "scope");
  if (!scope.ok) return scope;
  const attribution = validateAttribution(input.attribution, scope.value);
  if (!attribution.ok) return attribution;
  const currencies = settlementCurrencies(input.settlementCurrencyBySymbol);
  if (!currencies.ok) return currencies;
  const sourceConflicts = validateSourceConflicts(input.sourceConflicts);
  if (!sourceConflicts.ok) return sourceConflicts;

  const canonical = selectCanonicalHistoryEvidence({
    scope: scope.value,
    observations: attribution.value.observations.map(
      ({ observation }) => observation,
    ),
    conflicts: sourceConflicts.value,
  });
  if (!canonical.ok) return canonical;
  const attributedById = new Map(
    attribution.value.observations.map((row) => [
      row.observation.observationId,
      row,
    ]),
  );
  const ownedClosedPnl: HistoryOwnedClosedPnlRow[] = [];
  const notStrategyPerformance: HistoryNonStrategyClosedPnlRow[] = [];

  for (const observation of canonical.value.observations) {
    if (!factAsClosedPnl(observation)) continue;
    const attributed = attributedById.get(observation.observationId);
    if (
      attributed === undefined ||
      attributed.observation.contentHash !== observation.contentHash ||
      attributed.observation.fact.factKind !== "closed-pnl"
    )
      return invalidValue(
        "canonical closed-PnL selection is absent from attribution",
        "attribution",
      );
    const day = utcDay(observation.providerEventTime);
    if (!day.ok) return day;
    const settlement = currencies.value.get(observation.fact.symbol);
    const verifiedCurrency = settlement?.verified ? settlement.currency : null;
    const pnl = exactDecimal(observation.fact.closedPnl, "closedPnl");
    const openFee = exactDecimal(observation.fact.openFee, "openFee");
    const closeFee = exactDecimal(observation.fact.closeFee, "closeFee");
    const fundingFee = exactDecimal(observation.fact.fundingFee, "fundingFee");
    if (!pnl.ok) return pnl;
    if (!openFee.ok) return openFee;
    if (!closeFee.ok) return closeFee;
    if (!fundingFee.ok) return fundingFee;
    const feeFundingComplete =
      openFee.value !== null &&
      closeFee.value !== null &&
      fundingFee.value !== null &&
      verifiedCurrency !== null;
    const feeFunding: HistoryFeeFundingCorroboration = {
      openFee: openFee.value?.toString() ?? null,
      closeFee: closeFee.value?.toString() ?? null,
      fundingFee: fundingFee.value?.toString() ?? null,
      currency: verifiedCurrency,
      status: feeFundingComplete ? "complete" : "incomplete",
      includedInReportedClosedPnl: false,
    };
    if (attributed.ownership.status === "matched") {
      const matchedSource = attributed.ownership.source;
      if (
        attributed.ownership.evidence.length === 0 ||
        !attributed.ownership.evidence.some((proof) =>
          ownershipEvidenceMatches(proof, matchedSource),
        )
      )
        return invalidValue(
          "matched closed-PnL lacks exact ownership evidence",
          "attribution",
        );
      const amountKnown = pnl.value !== null && verifiedCurrency !== null;
      const reasonCodes: string[] = [];
      if (verifiedCurrency === null)
        reasonCodes.push("SETTLEMENT_CURRENCY_UNVERIFIED");
      if (pnl.value === null) reasonCodes.push("CLOSED_PNL_UNKNOWN");
      if (!feeFundingComplete)
        reasonCodes.push("FEE_FUNDING_COMPONENTS_INCOMPLETE");
      ownedClosedPnl.push({
        observationId: observation.observationId,
        source: attributed.ownership.source,
        symbol: observation.fact.symbol,
        utcDay: day.value,
        currency: verifiedCurrency,
        reportedClosedPnl: amountKnown ? pnl.value!.toString() : null,
        status: amountKnown
          ? feeFundingComplete
            ? "complete"
            : "partial"
          : "unknown",
        reasonCodes: reasonCodes.sort(),
        feeFunding,
      });
    } else {
      notStrategyPerformance.push({
        observationId: observation.observationId,
        symbol: observation.fact.symbol,
        utcDay: day.value,
        currency: verifiedCurrency,
        reportedClosedPnl:
          pnl.value !== null && verifiedCurrency !== null
            ? pnl.value.toString()
            : null,
        ownership: attributed.ownership.status,
        reason: attributed.ownership.reason,
        candidates:
          attributed.ownership.status === "ambiguous"
            ? attributed.ownership.candidates
            : [],
      });
    }
  }

  const runSymbolDays = makeGroups(ownedClosedPnl, "owned-run-symbol-day");
  const runDays = makeGroups(ownedClosedPnl, "owned-run-day");
  const accountDays = makeGroups(ownedClosedPnl, "account-day");
  if (!runSymbolDays.ok) return runSymbolDays;
  if (!runDays.ok) return runDays;
  if (!accountDays.ok) return accountDays;
  const positionUpl = validatePositionUpl(
    input.positionUplEvidence,
    scope.value,
    attribution.value,
  );
  if (!positionUpl.ok) return positionUpl;

  ownedClosedPnl.sort(
    (left, right) =>
      left.utcDay.localeCompare(right.utcDay) ||
      left.source.kind.localeCompare(right.source.kind) ||
      left.source.sourceId.localeCompare(right.source.sourceId) ||
      left.symbol.localeCompare(right.symbol) ||
      left.observationId.localeCompare(right.observationId),
  );
  notStrategyPerformance.sort(
    (left, right) =>
      left.utcDay.localeCompare(right.utcDay) ||
      left.observationId.localeCompare(right.observationId),
  );
  return ok({
    schemaVersion: "history-accounting-performance-projection/v1",
    scope: scope.value,
    ownedClosedPnl,
    notStrategyPerformance,
    ownedRunSymbolDays: runSymbolDays.value,
    ownedRunDays: runDays.value,
    accountDays: accountDays.value,
    positionUpl: positionUpl.value,
    selectionConflicts: canonical.value.conflicts,
  });
}
