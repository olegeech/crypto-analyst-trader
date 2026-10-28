import { hashCanonical } from "../domain/identity/canonical-serialization.js";
import { domainError } from "../domain/shared/errors.js";
import { fail, ok, type Result } from "../domain/shared/result.js";
import { timestampFromEpochMs } from "../domain/shared/time.js";
import type { HistorySourceFact } from "../domain/accounting/history-source-fact.js";
import {
  HISTORY_READ_LIMITS,
  HISTORY_READ_SOURCES,
  type HistoryReadPage,
  type HistoryReadPort,
  type HistoryReadSource,
  type HistoryReadWindow,
} from "../ports/history-read.js";
import type {
  HistoryCheckpoint,
  HistoryFilterValue,
  HistoryStorePort,
  HistoryStoreScope,
} from "../ports/history-store.js";
import type { OperatorMainnetTestSnapshot } from "../ports/operator-mainnet-test-persistence.js";
import type { PreparedLegRunSnapshot } from "../ports/persistence.js";
import { attributeHistoryObservations } from "./history-attribution.js";
import { projectHistoryCoverage } from "./history-coverage.js";

const MAX_LOOKBACK_YEARS = 2;
export const HISTORY_SYNC_LIMITS = Object.freeze({
  maxGetAttempts: 100,
  maxDurationMs: 60_000,
  maxPagesPerWindow: HISTORY_READ_LIMITS.maxPagesPerWindow,
  maxRows: HISTORY_READ_LIMITS.maxRowsPerWindow,
});

export type HistorySyncSelection =
  | { readonly kind: "maximum-history" }
  | { readonly kind: "resume" }
  | {
      readonly kind: "explicit-range";
      readonly fromMs: number;
      readonly toMs: number;
      readonly replayId: string;
    };

export interface HistorySyncBudget {
  readonly maxGetAttempts?: number;
  readonly maxDurationMs?: number;
  readonly maxPagesPerWindow?: number;
  readonly maxRows?: number;
}

export interface HistorySourceSyncSummary {
  readonly source: HistoryReadSource;
  readonly getAttempts: number;
  readonly pageRequests: number;
  readonly rowsReceived: number;
  readonly inserted: number;
  readonly duplicates: number;
  readonly conflicts: number;
  readonly unmatched: number;
  readonly gaps: number;
  readonly status:
    "missing" | "paging" | "partial" | "traversed" | "unavailable";
  readonly lastFullyCoveredWindow?: HistoryReadWindow;
  readonly nextResumeWindow?: HistoryReadWindow;
  readonly reasonCodes: readonly string[];
  readonly diagnostic?: HistorySyncDiagnostic;
}

export interface HistorySyncDiagnostic {
  readonly stage: string;
  readonly attemptedAction: string;
  readonly reasonCode: string;
  readonly explanation: string;
  readonly nextAction: string;
  readonly outcome:
    "NOT_STARTED" | "READ_FAILED" | "PROVIDER_REJECTED" | "INVALID_RESPONSE";
  readonly source?: HistoryReadSource;
  readonly providerRetCode?: number;
  readonly httpStatus?: number;
}

export interface HistorySyncReport {
  readonly schemaVersion: "history-sync-report/v1";
  readonly selection: HistorySyncSelection["kind"];
  readonly status: "COMPLETE" | "PARTIAL";
  readonly scope: HistoryStoreScope;
  readonly frozenUpperBoundMs: number;
  readonly elapsedMs: number;
  readonly getAttempts: number;
  readonly rowsReceived: number;
  readonly coverageLimitations: readonly {
    readonly source: HistoryReadSource;
    readonly reasonCodes: readonly string[];
  }[];
  readonly sources: readonly HistorySourceSyncSummary[];
  readonly nextAction: string;
}

export interface HistoryIngestionInput {
  readonly scope: HistoryStoreScope;
  readonly selection: HistorySyncSelection;
  /** Frozen Bybit server time used as the upper boundary for this invocation. */
  readonly frozenUpperBoundMs: number;
  readonly budget?: HistorySyncBudget;
  readonly operatorSources?: readonly OperatorMainnetTestSnapshot[];
  readonly preparedSources?: readonly PreparedLegRunSnapshot[];
}

export interface HistoryIngestionDependencies {
  readonly reader: HistoryReadPort;
  readonly store: HistoryStorePort;
  readonly monotonicClock?: () => number;
  /** Optional physical attempt counter from the shared signed GET transport. */
  readonly getAttemptCount?: () => number;
}

interface HistoryRange {
  readonly purpose: "backfill" | "recent-refresh" | "explicit-replay";
  readonly fromMs: number;
  readonly toMs: number;
  readonly replayId?: string;
}

interface WorkItem {
  readonly source: HistoryReadSource;
  readonly filters: Readonly<Record<string, HistoryFilterValue>>;
  readonly filterHash: string;
  readonly window: HistoryReadWindow;
  readonly prior?: HistoryCheckpoint;
  cursor: string | null;
  revision: number;
  pages: number;
  readonly seenCursors: Set<string>;
}

interface MutableSourceSummary {
  getAttempts: number;
  pageRequests: number;
  rowsReceived: number;
  inserted: number;
  duplicates: number;
  conflicts: number;
  reasonCodes: Set<string>;
  diagnostic?: HistorySyncDiagnostic;
}

function invalid(message: string): Result<never> {
  return fail(domainError("INVALID_ARGUMENT", message));
}

const CREDENTIAL_REASON_CODES: Readonly<Record<string, string>> = {
  missing: "CREDENTIALS_MISSING",
  inaccessible: "CREDENTIALS_INACCESSIBLE",
  unsupported: "CREDENTIALS_UNSUPPORTED",
  invalid: "CREDENTIALS_INVALID",
  "command-failed": "CREDENTIALS_LOAD_FAILED",
};

const HISTORY_ERROR_EXPLANATIONS: Readonly<Record<string, string>> = {
  CREDENTIALS_MISSING:
    "Credentials are not configured for the selected environment.",
  CREDENTIALS_INACCESSIBLE:
    "The selected environment credentials could not be read from Keychain.",
  CREDENTIALS_UNSUPPORTED: "Credential access is unsupported in this runtime.",
  CREDENTIALS_INVALID: "The selected environment credentials are malformed.",
  CREDENTIALS_LOAD_FAILED:
    "The credential provider could not load the selected environment credentials.",
  AUTHENTICATION_FAILED:
    "Bybit rejected the read credentials or their signing data.",
  READ_PERMISSION_DENIED: "Bybit denied a required account read permission.",
  ACCOUNT_IDENTITY_MISMATCH:
    "The selected API key belongs to a different Bybit account than the configured account.",
  WITHDRAWAL_PERMISSION_FORBIDDEN:
    "The selected API key includes withdrawal permission, which is not permitted for history sync.",
  RATE_LIMITED: "Bybit rate-limited a history read.",
  TIMESTAMP_SKEW: "Bybit rejected the request timestamp used for signing.",
  INVALID_RESPONSE:
    "The Bybit response did not satisfy the validated history contract.",
  UNSUPPORTED_CAPABILITY:
    "Bybit reports that this history request is unavailable for the selected account or range.",
  TRANSPORT_FAILED: "A Bybit history response could not be received reliably.",
  COLLECTION_DEADLINE_EXCEEDED:
    "The history read reached its bounded time limit.",
  GET_BUDGET_EXCEEDED: "The history read reached its bounded GET limit.",
  PAGE_BUDGET_EXCEEDED: "A history window reached its bounded page limit.",
  ROW_BUDGET_EXCEEDED: "The history read reached its bounded raw-row limit.",
};

function errorProperty(error: unknown, key: string): unknown {
  return error !== null && typeof error === "object" && key in error
    ? (error as Record<string, unknown>)[key]
    : undefined;
}

export function safeHistorySyncReasonCode(error: unknown): string {
  const candidate =
    typeof error === "string" ? error : errorProperty(error, "code");
  if (
    typeof candidate === "string" &&
    Object.hasOwn(CREDENTIAL_REASON_CODES, candidate)
  )
    return CREDENTIAL_REASON_CODES[candidate]!;
  return typeof candidate === "string" && /^[A-Z0-9_]{1,64}$/u.test(candidate)
    ? candidate
    : "HISTORY_SYNC_FAILED";
}

export function createHistorySyncDiagnostic(
  error: unknown,
  stage: string,
  attemptedAction: string,
  environment?: string,
  source?: HistoryReadSource,
): HistorySyncDiagnostic {
  const reasonCode = safeHistorySyncReasonCode(error);
  const providerRetCode = errorProperty(error, "retCode");
  const httpStatus = errorProperty(error, "httpStatus");
  const hasProviderReply =
    Number.isSafeInteger(providerRetCode) || Number.isSafeInteger(httpStatus);
  const explanation =
    HISTORY_ERROR_EXPLANATIONS[reasonCode] ??
    `The history operation stopped with ${reasonCode}.`;
  const nextAction =
    reasonCode === "CREDENTIALS_MISSING"
      ? `Configure the ${environment ?? "selected"} Bybit credentials, then rerun history sync.`
      : reasonCode === "CREDENTIALS_INACCESSIBLE"
        ? `Unlock the macOS Keychain or approve its prompt, then rerun history sync.`
        : reasonCode.startsWith("CREDENTIALS_")
          ? `Check the ${environment ?? "selected"} credential setup, then rerun history sync.`
          : reasonCode === "RATE_LIMITED"
            ? "Wait for the Bybit rate window, then resume with --range resume."
            : reasonCode === "AUTHENTICATION_FAILED" ||
                reasonCode === "READ_PERMISSION_DENIED"
              ? "Check the selected environment's read-only API key and permissions before resuming."
              : reasonCode === "ACCOUNT_IDENTITY_MISMATCH"
                ? "Verify the selected environment and configured account ID; do not resume until they identify the same account."
                : reasonCode === "WITHDRAWAL_PERMISSION_FORBIDDEN"
                  ? "Use a Bybit API key without withdrawal permission before running history sync."
                  : reasonCode === "TIMESTAMP_SKEW"
                    ? "Check the local clock and signing configuration before resuming."
                    : reasonCode === "INVALID_RESPONSE"
                      ? "Keep the window partial and inspect the sanitized provider fixture or adapter mapping before retrying."
                      : reasonCode === "UNSUPPORTED_CAPABILITY"
                        ? "Review endpoint retention for this range; keep unavailable history explicit."
                        : "Resume the fixed window with --range resume after the reported cause is resolved.";
  return {
    stage,
    attemptedAction,
    reasonCode,
    explanation,
    nextAction,
    outcome:
      reasonCode === "INVALID_RESPONSE"
        ? "INVALID_RESPONSE"
        : hasProviderReply
          ? "PROVIDER_REJECTED"
          : stage === "credential-load" || stage === "request-validation"
            ? "NOT_STARTED"
            : "READ_FAILED",
    ...(source === undefined ? {} : { source }),
    ...(Number.isSafeInteger(providerRetCode) &&
    (providerRetCode as number) >= 0 &&
    (providerRetCode as number) <= 2_147_483_647
      ? { providerRetCode: providerRetCode as number }
      : {}),
    ...(Number.isSafeInteger(httpStatus) &&
    (httpStatus as number) >= 100 &&
    (httpStatus as number) <= 599
      ? { httpStatus: httpStatus as number }
      : {}),
  };
}

export function historySyncDiagnosticDetails(
  diagnostic: HistorySyncDiagnostic,
  exchangeReads: number,
): Readonly<Record<string, string | number | boolean | null>> {
  return {
    stage: diagnostic.stage,
    attemptedAction: diagnostic.attemptedAction,
    reasonCode: diagnostic.reasonCode,
    explanation: diagnostic.explanation,
    nextAction: diagnostic.nextAction,
    outcome: diagnostic.outcome,
    exchangeReads:
      Number.isSafeInteger(exchangeReads) && exchangeReads >= 0
        ? exchangeReads
        : 0,
    exchangeWrites: 0,
    ...(diagnostic.providerRetCode === undefined
      ? {}
      : { providerRetCode: diagnostic.providerRetCode }),
    ...(diagnostic.httpStatus === undefined
      ? {}
      : { httpStatus: diagnostic.httpStatus }),
  };
}

function validBound(value: number): boolean {
  return value > 0 && timestampFromEpochMs(value).ok;
}

function previousCalendarYear(value: number, years: number): number {
  const date = new Date(value);
  const originalDay = date.getUTCDate();
  const targetYear = date.getUTCFullYear() - years;
  date.setUTCDate(1);
  date.setUTCFullYear(targetYear);
  const lastTargetDay = new Date(
    Date.UTC(targetYear, date.getUTCMonth() + 1, 0),
  ).getUTCDate();
  date.setUTCDate(Math.min(originalDay, lastTargetDay));
  return date.getTime();
}

function makeWindows(
  fromMs: number,
  toMs: number,
): readonly HistoryReadWindow[] {
  const windows: HistoryReadWindow[] = [];
  let start = fromMs;
  while (start < toMs) {
    const end = Math.min(toMs, start + HISTORY_READ_LIMITS.maxWindowMs);
    if (end <= start) break;
    windows.push({ fromMs: start, toMs: end });
    if (end === toMs) break;
    // The shared timestamp is intentional: history endpoints may be inclusive.
    start = end;
  }
  return windows;
}

function purposeOf(checkpoint: HistoryCheckpoint): unknown {
  return checkpoint.filters.purpose;
}

function rangeFromCheckpoint(
  checkpoint: HistoryCheckpoint,
): HistoryRange | undefined {
  const { purpose, rangeStartMs, rangeEndMs, replayId } = checkpoint.filters;
  if (
    (purpose !== "backfill" &&
      purpose !== "recent-refresh" &&
      purpose !== "explicit-replay") ||
    typeof rangeStartMs !== "number" ||
    typeof rangeEndMs !== "number" ||
    !validBound(rangeStartMs) ||
    !validBound(rangeEndMs) ||
    rangeEndMs <= rangeStartMs
  )
    return undefined;
  return {
    purpose,
    fromMs: rangeStartMs,
    toMs: rangeEndMs,
    ...(typeof replayId === "string" ? { replayId } : {}),
  };
}

function distinctRanges(
  checkpoints: readonly HistoryCheckpoint[],
  predicate: (checkpoint: HistoryCheckpoint) => boolean,
): readonly HistoryRange[] {
  const ranges = new Map<string, HistoryRange>();
  for (const checkpoint of checkpoints) {
    if (!predicate(checkpoint)) continue;
    const range = rangeFromCheckpoint(checkpoint);
    if (range === undefined) continue;
    const key = `${range.purpose}\u0000${range.fromMs}\u0000${range.toMs}\u0000${range.replayId ?? ""}`;
    ranges.set(key, range);
  }
  return [...ranges.values()].sort(
    (a, b) =>
      a.fromMs - b.fromMs ||
      a.toMs - b.toMs ||
      a.purpose.localeCompare(b.purpose),
  );
}

function filtersFor(
  source: HistoryReadSource,
  range: HistoryRange,
): Readonly<Record<string, HistoryFilterValue>> {
  return {
    ...(source === "transaction-log"
      ? { accountType: "UNIFIED" }
      : { category: "linear" }),
    purpose: range.purpose,
    rangeStartMs: range.fromMs,
    rangeEndMs: range.toMs,
    ...(range.replayId === undefined ? {} : { replayId: range.replayId }),
  };
}

function expectedPage(page: unknown, item: WorkItem): boolean {
  if (
    page === null ||
    typeof page !== "object" ||
    Array.isArray(page) ||
    Object.getPrototypeOf(page) !== Object.prototype
  )
    return false;
  const candidate = page as Partial<HistoryReadPage>;
  if (
    candidate.window === null ||
    typeof candidate.window !== "object" ||
    candidate.facts === null ||
    !Array.isArray(candidate.facts)
  )
    return false;
  const nextCursor = candidate.nextCursor;
  const cursorValid =
    nextCursor === null ||
    (typeof nextCursor === "string" &&
      nextCursor.length > 0 &&
      nextCursor.length <= 8_192 &&
      !/[\u0000-\u001f\u007f]/u.test(nextCursor));
  return (
    candidate.source === item.source &&
    candidate.window.fromMs === item.window.fromMs &&
    candidate.window.toMs === item.window.toMs &&
    candidate.cursor === item.cursor &&
    cursorValid &&
    Number.isSafeInteger(candidate.receivedRowCount) &&
    candidate.receivedRowCount! >= 0 &&
    candidate.receivedRowCount! >= candidate.facts.length
  );
}

function isInvocationBudgetError(code: string): boolean {
  return [
    "ATTEMPT_BUDGET_EXCEEDED",
    "COLLECTION_DEADLINE_EXCEEDED",
    "PAGE_BUDGET_EXCEEDED",
    "ROW_BUDGET_EXCEEDED",
    "GET_BUDGET_EXCEEDED",
  ].includes(code);
}

function isFatalAuthenticationError(code: string): boolean {
  return [
    "AUTHENTICATION_FAILED",
    "READ_PERMISSION_DENIED",
    "ACCOUNT_IDENTITY_MISMATCH",
    "TIMESTAMP_SKEW",
  ].includes(code);
}

function coverageLimitations(): HistorySyncReport["coverageLimitations"] {
  return HISTORY_READ_SOURCES.map((source) => ({
    source,
    reasonCodes:
      source === "order-history"
        ? [
            "TWO_YEAR_LOOKBACK_BOUNDARY",
            "OLDER_UNFILLED_ORDER_VISIBILITY_LIMITED",
            "CANCELLED_REJECTED_DEACTIVATED_ORDERS_VISIBLE_ONLY_LAST_24H",
          ]
        : ["TWO_YEAR_LOOKBACK_BOUNDARY"],
  }));
}

export function validateHistorySyncBudget(
  input?: HistorySyncBudget,
): Result<Required<HistorySyncBudget>> {
  const budget = { ...HISTORY_SYNC_LIMITS, ...input };
  if (
    !Number.isSafeInteger(budget.maxGetAttempts) ||
    budget.maxGetAttempts < 1 ||
    budget.maxGetAttempts > HISTORY_SYNC_LIMITS.maxGetAttempts ||
    !Number.isSafeInteger(budget.maxDurationMs) ||
    budget.maxDurationMs < 1 ||
    budget.maxDurationMs > HISTORY_SYNC_LIMITS.maxDurationMs ||
    !Number.isSafeInteger(budget.maxPagesPerWindow) ||
    budget.maxPagesPerWindow < 1 ||
    budget.maxPagesPerWindow > HISTORY_SYNC_LIMITS.maxPagesPerWindow ||
    !Number.isSafeInteger(budget.maxRows) ||
    budget.maxRows < 1 ||
    budget.maxRows > HISTORY_SYNC_LIMITS.maxRows
  )
    return invalid(
      "history sync budgets must be positive and within the hard limits",
    );
  return ok(budget);
}

function budgetFor(
  input: HistoryIngestionInput,
): Result<Required<HistorySyncBudget>> {
  return validateHistorySyncBudget(input.budget);
}

function rangesForSelection(
  input: HistoryIngestionInput,
  checkpoints: readonly HistoryCheckpoint[],
): Result<readonly HistoryRange[]> {
  const { selection, frozenUpperBoundMs } = input;
  if (selection.kind === "explicit-range") {
    if (
      !validBound(selection.fromMs) ||
      !validBound(selection.toMs) ||
      selection.toMs <= selection.fromMs ||
      selection.toMs > frozenUpperBoundMs ||
      selection.fromMs <
        previousCalendarYear(frozenUpperBoundMs, MAX_LOOKBACK_YEARS) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(selection.replayId)
    )
      return invalid(
        "explicit history range must be a valid range within the two-year lookback",
      );
    return ok([
      {
        purpose: "explicit-replay",
        fromMs: selection.fromMs,
        toMs: selection.toMs,
        replayId: selection.replayId,
      },
    ]);
  }
  if (selection.kind === "maximum-history") {
    const existing = [
      ...distinctRanges(
        checkpoints,
        (checkpoint) => purposeOf(checkpoint) === "backfill",
      ),
    ].sort((a, b) => b.toMs - a.toMs);
    return ok(
      existing[0]
        ? [existing[0]]
        : [
            {
              purpose: "backfill",
              fromMs: previousCalendarYear(
                frozenUpperBoundMs,
                MAX_LOOKBACK_YEARS,
              ),
              toMs: frozenUpperBoundMs,
            },
          ],
    );
  }

  const unfinished = distinctRanges(
    checkpoints,
    (checkpoint) =>
      purposeOf(checkpoint) === "backfill" &&
      (checkpoint.status === "partial" ||
        checkpoint.status === "paging" ||
        checkpoint.status === "unavailable"),
  );
  const pendingReplays = distinctRanges(
    checkpoints,
    (checkpoint) =>
      (purposeOf(checkpoint) === "explicit-replay" ||
        purposeOf(checkpoint) === "recent-refresh") &&
      (checkpoint.status === "partial" ||
        checkpoint.status === "paging" ||
        checkpoint.status === "unavailable"),
  );
  const recent: HistoryRange = {
    purpose: "recent-refresh",
    fromMs: Math.max(0, frozenUpperBoundMs - HISTORY_READ_LIMITS.maxWindowMs),
    toMs: frozenUpperBoundMs,
  };
  const all = [...unfinished, ...pendingReplays, recent];
  const unique = new Map<string, HistoryRange>();
  for (const range of all) {
    const key = `${range.purpose}\u0000${range.fromMs}\u0000${range.toMs}\u0000${range.replayId ?? ""}`;
    unique.set(key, range);
  }
  return ok([...unique.values()]);
}

/** Validate caller-controlled values before opening a store or making provider reads. */
export function validateHistoryIngestionInput(
  input: HistoryIngestionInput,
): Result<Required<HistorySyncBudget>> {
  const limits = budgetFor(input);
  if (!limits.ok) return limits;
  if (
    input.scope.exchange !== "bybit" ||
    !/^sha256:[0-9a-f]{64}$/u.test(input.scope.accountId) ||
    !validBound(input.frozenUpperBoundMs)
  )
    return invalid(
      "history sync requires a verified Bybit scope and frozen server time",
    );
  const ranges = rangesForSelection(input, []);
  return ranges.ok ? limits : ranges;
}

function orderedWorkItems(
  ranges: readonly HistoryRange[],
  checkpoints: readonly HistoryCheckpoint[],
): Result<WorkItem[]> {
  const output: WorkItem[] = [];
  for (const range of ranges) {
    for (const source of HISTORY_READ_SOURCES) {
      const filters = filtersFor(source, range);
      const hash = hashCanonical(filters);
      if (!hash.ok) return hash;
      const matchingCheckpoints = checkpoints.filter(
        (row) => row.source === source && row.filterHash === hash.value,
      );
      const windowRows = new Map(
        matchingCheckpoints.map((row) => [
          `${row.window.fromMs}:${row.window.toMs}`,
          row,
        ]),
      );
      for (const window of makeWindows(range.fromMs, range.toMs)) {
        const prior = windowRows.get(`${window.fromMs}:${window.toMs}`);
        if (
          prior?.status === "traversed" ||
          (prior?.status === "unavailable" &&
            (prior.reasonCode === "HISTORY_EXPIRED" ||
              prior.reasonCode === "RETENTION_EXPIRED"))
        )
          continue;
        output.push({
          source,
          filters,
          filterHash: hash.value,
          window,
          ...(prior === undefined ? {} : { prior }),
          // Continue durable progress where available. If Bybit rejects a
          // stale cursor, the unavailable checkpoint is retried from the
          // window start on the next invocation.
          cursor:
            prior !== undefined &&
            (prior.status === "paging" ||
              (prior.status === "partial" &&
                prior.reasonCode !== "SOURCE_CONFLICT"))
              ? prior.cursor
              : null,
          revision: prior?.revision ?? 0,
          pages: 0,
          seenCursors: new Set(
            prior?.cursor &&
              (prior.status === "paging" ||
                (prior.status === "partial" &&
                  prior.reasonCode !== "SOURCE_CONFLICT"))
              ? [prior.cursor]
              : [],
          ),
        });
      }
    }
  }
  const sourceOrder = new Map(
    HISTORY_READ_SOURCES.map((source, index) => [source, index]),
  );
  output.sort(
    (left, right) =>
      left.window.fromMs - right.window.fromMs ||
      left.window.toMs - right.window.toMs ||
      sourceOrder.get(left.source)! - sourceOrder.get(right.source)! ||
      left.filterHash.localeCompare(right.filterHash),
  );
  return ok(output);
}

function mark(
  store: HistoryStorePort,
  scope: HistoryStoreScope,
  item: WorkItem,
  status: "partial" | "unavailable",
  reasonCode: string,
  cursor?: string | null,
): Result<HistoryCheckpoint> {
  return store.markCoverage({
    scope,
    source: item.source,
    filters: item.filters,
    window: item.window,
    expectedRevision: item.revision,
    status,
    reasonCode,
    ...(cursor === undefined ? {} : { cursor }),
  });
}

export async function runHistoryIngestion(
  input: HistoryIngestionInput,
  dependencies: HistoryIngestionDependencies,
): Promise<Result<HistorySyncReport>> {
  const validated = validateHistoryIngestionInput(input);
  if (!validated.ok) return validated;
  const limits = validated;

  const monotonic = dependencies.monotonicClock ?? (() => performance.now());
  const startedAt = monotonic();
  if (!Number.isFinite(startedAt))
    return invalid("history sync monotonic clock is invalid");

  const checkpointResult = dependencies.store.listCoverage(input.scope);
  if (!checkpointResult.ok) return checkpointResult;
  const ranges = rangesForSelection(input, checkpointResult.value);
  if (!ranges.ok) return ranges;
  const workItems = orderedWorkItems(ranges.value, checkpointResult.value);
  if (!workItems.ok) return workItems;

  const summary = new Map<HistoryReadSource, MutableSourceSummary>(
    HISTORY_READ_SOURCES.map((source) => [
      source,
      {
        getAttempts: 0,
        pageRequests: 0,
        rowsReceived: 0,
        inserted: 0,
        duplicates: 0,
        conflicts: 0,
        reasonCodes: new Set(),
      },
    ]),
  );
  const localAttempts = new Map<HistoryReadSource, number>(
    HISTORY_READ_SOURCES.map((source) => [source, 0]),
  );
  const localGetCount = () =>
    [...localAttempts.values()].reduce((total, count) => total + count, 0);
  const getCount = dependencies.getAttemptCount ?? localGetCount;
  const attemptsAtStart = getCount();
  const workQueue = [...workItems.value];
  const pendingWindows = new Map<string, HistoryReadWindow>();
  let rowsReceived = 0;
  let globalStop = false;
  let nextAction =
    "Run history sync again with --range resume to continue pending windows.";

  const rememberPending = (item: WorkItem) => {
    const key = `${item.source}:${item.window.fromMs}:${item.window.toMs}`;
    pendingWindows.set(key, item.window);
  };
  const rememberRemainingWork = (current?: WorkItem) => {
    if (current !== undefined) rememberPending(current);
    for (const item of workQueue) rememberPending(item);
  };
  const recordDiagnostic = (
    sourceSummary: MutableSourceSummary,
    error: unknown,
    stage: string,
    attemptedAction: string,
    source: HistoryReadSource,
  ) => {
    if (sourceSummary.diagnostic !== undefined) return;
    sourceSummary.diagnostic = createHistorySyncDiagnostic(
      error,
      stage,
      attemptedAction,
      input.scope.environment,
      source,
    );
    if (
      nextAction ===
      "Run history sync again with --range resume to continue pending windows."
    )
      nextAction = sourceSummary.diagnostic.nextAction;
  };

  while (workQueue.length > 0) {
    const item = workQueue.shift()!;
    const sourceSummary = summary.get(item.source)!;
    const elapsed = monotonic() - startedAt;
    const attempts = getCount();
    if (
      !Number.isFinite(elapsed) ||
      elapsed >= limits.value.maxDurationMs ||
      attempts >= limits.value.maxGetAttempts
    ) {
      const reasonCode =
        attempts >= limits.value.maxGetAttempts
          ? "GET_BUDGET_EXCEEDED"
          : "COLLECTION_DEADLINE_EXCEEDED";
      const checkpoint = mark(
        dependencies.store,
        input.scope,
        item,
        "partial",
        reasonCode,
        item.cursor,
      );
      if (!checkpoint.ok) return checkpoint;
      sourceSummary.reasonCodes.add(reasonCode);
      rememberRemainingWork(item);
      globalStop = true;
      nextAction =
        "Resume later from the saved provider cursor; if Bybit rejects it as stale, the next retry restarts the fixed window.";
      break;
    }
    if (item.pages >= limits.value.maxPagesPerWindow) {
      const checkpoint = mark(
        dependencies.store,
        input.scope,
        item,
        "partial",
        "PAGE_BUDGET_EXCEEDED",
        item.cursor,
      );
      if (!checkpoint.ok) return checkpoint;
      sourceSummary.reasonCodes.add("PAGE_BUDGET_EXCEEDED");
      rememberPending(item);
      continue;
    }

    let page: unknown;
    const attemptsBeforePage = getCount();
    sourceSummary.pageRequests += 1;
    try {
      localAttempts.set(item.source, localAttempts.get(item.source)! + 1);
      page = await dependencies.reader.readPage({
        source: item.source,
        window: item.window,
        ...(item.cursor === null ? {} : { cursor: item.cursor }),
      });
    } catch (error) {
      const attemptsAfterPage = getCount();
      sourceSummary.getAttempts += dependencies.getAttemptCount
        ? Math.max(0, attemptsAfterPage - attemptsBeforePage)
        : 1;
      const reasonCode = safeHistorySyncReasonCode(error);
      const status = isInvocationBudgetError(reasonCode)
        ? "partial"
        : "unavailable";
      const checkpoint = mark(
        dependencies.store,
        input.scope,
        item,
        status,
        reasonCode,
      );
      if (!checkpoint.ok) return checkpoint;
      sourceSummary.reasonCodes.add(reasonCode);
      recordDiagnostic(
        sourceSummary,
        error,
        "history-page-read",
        `Read ${item.source} history`,
        item.source,
      );
      if (status === "partial" || status === "unavailable")
        rememberPending(item);
      if (isFatalAuthenticationError(reasonCode)) {
        rememberRemainingWork(item);
        globalStop = true;
        nextAction =
          "Check the read-only API key, environment and account identity before another sync.";
        break;
      }
      if (isInvocationBudgetError(reasonCode)) {
        rememberRemainingWork(item);
        globalStop = true;
        nextAction =
          "Resume later from the saved provider cursor; if Bybit rejects it as stale, the next retry restarts the fixed window.";
        break;
      }
      continue;
    }
    const physicalAfter = getCount();
    sourceSummary.getAttempts += Math.max(
      0,
      physicalAfter - attemptsBeforePage,
    );
    if (!expectedPage(page, item)) {
      const checkpoint = mark(
        dependencies.store,
        input.scope,
        item,
        "unavailable",
        "INVALID_RESPONSE",
        null,
      );
      if (!checkpoint.ok) return checkpoint;
      sourceSummary.reasonCodes.add("INVALID_RESPONSE");
      recordDiagnostic(
        sourceSummary,
        { code: "INVALID_RESPONSE" },
        "history-page-validation",
        `Validate ${item.source} history response`,
        item.source,
      );
      rememberPending(item);
      continue;
    }
    const validPage = page as HistoryReadPage;
    sourceSummary.rowsReceived += validPage.receivedRowCount;
    rowsReceived += validPage.receivedRowCount;
    if (rowsReceived > limits.value.maxRows) {
      const checkpoint = mark(
        dependencies.store,
        input.scope,
        item,
        "partial",
        "ROW_BUDGET_EXCEEDED",
        item.cursor,
      );
      if (!checkpoint.ok) return checkpoint;
      sourceSummary.reasonCodes.add("ROW_BUDGET_EXCEEDED");
      rememberRemainingWork(item);
      globalStop = true;
      nextAction =
        "Resume later; the uncommitted provider page will be fetched again.";
      break;
    }
    if (
      validPage.nextCursor !== null &&
      (validPage.nextCursor === item.cursor ||
        item.seenCursors.has(validPage.nextCursor))
    ) {
      const checkpoint = mark(
        dependencies.store,
        input.scope,
        item,
        "unavailable",
        "INVALID_RESPONSE",
        null,
      );
      if (!checkpoint.ok) return checkpoint;
      sourceSummary.reasonCodes.add("INVALID_RESPONSE");
      recordDiagnostic(
        sourceSummary,
        { code: "INVALID_RESPONSE" },
        "history-page-validation",
        `Validate ${item.source} history cursor`,
        item.source,
      );
      rememberPending(item);
      continue;
    }
    const committed = dependencies.store.commitPage({
      scope: input.scope,
      source: item.source,
      filters: item.filters,
      window: item.window,
      expectedRevision: item.revision,
      cursor: item.cursor,
      nextCursor: validPage.nextCursor,
      facts: validPage.facts,
    });
    if (!committed.ok) return committed;
    sourceSummary.inserted += committed.value.inserted;
    sourceSummary.duplicates += committed.value.duplicates;
    sourceSummary.conflicts += committed.value.conflicts.length;
    item.revision = committed.value.checkpoint.revision;
    item.pages += 1;
    if (validPage.nextCursor !== null)
      item.seenCursors.add(validPage.nextCursor);
    if (committed.value.conflicts.length > 0) {
      const marked = mark(
        dependencies.store,
        input.scope,
        item,
        "partial",
        "SOURCE_CONFLICT",
        validPage.nextCursor,
      );
      if (!marked.ok) return marked;
      sourceSummary.reasonCodes.add("SOURCE_CONFLICT");
      rememberPending(item);
      continue;
    }
    if (validPage.nextCursor !== null) {
      item.cursor = validPage.nextCursor;
      if (item.pages >= limits.value.maxPagesPerWindow) {
        const marked = mark(
          dependencies.store,
          input.scope,
          item,
          "partial",
          "PAGE_BUDGET_EXCEEDED",
          validPage.nextCursor,
        );
        if (!marked.ok) return marked;
        sourceSummary.reasonCodes.add("PAGE_BUDGET_EXCEEDED");
        rememberPending(item);
      } else {
        // Let every already-queued source/window get a turn before reading
        // this stream's next page. The persisted cursor resumes it next run.
        workQueue.push(item);
      }
    }
  }

  const finalCheckpoints = dependencies.store.listCoverage(input.scope);
  if (!finalCheckpoints.ok) return finalCheckpoints;
  const observations = dependencies.store.readFacts(input.scope);
  if (!observations.ok) return observations;
  const coverage = projectHistoryCoverage({
    scope: input.scope,
    checkpoints: finalCheckpoints.value,
    observations: observations.value,
  });
  if (!coverage.ok) return coverage;
  const attribution = attributeHistoryObservations({
    observations: observations.value,
    operatorSources: input.operatorSources ?? [],
    preparedSources: input.preparedSources ?? [],
  });
  if (!attribution.ok) return attribution;
  const conflicts = dependencies.store.readConflicts(input.scope);
  if (!conflicts.ok) return conflicts;

  const duration = monotonic() - startedAt;
  if (!Number.isFinite(duration) || duration < 0)
    return invalid("history sync monotonic clock moved unexpectedly");
  const output: HistorySourceSyncSummary[] = HISTORY_READ_SOURCES.map(
    (source) => {
      const current = summary.get(source)!;
      const stream = coverage.value.streams.find(
        (entry) => entry.source === source,
      )!;
      const sourceCheckpoints = finalCheckpoints.value
        .filter((checkpoint) => checkpoint.source === source)
        .sort((left, right) => left.window.fromMs - right.window.fromMs);
      const lastFullyCoveredWindow = sourceCheckpoints
        .filter((checkpoint) => checkpoint.status === "traversed")
        .at(-1)?.window;
      const nextResumeWindow = [...pendingWindows.entries()]
        .filter(([key]) => key.startsWith(`${source}:`))
        .map(([, window]) => window)
        .sort((left, right) => left.fromMs - right.fromMs)[0];
      const sourceConflicts = conflicts.value.filter(
        (row) => row.source === source,
      ).length;
      const sourceGaps = coverage.value.gaps.filter(
        (gap) => "source" in gap && gap.source === source,
      ).length;
      const unmatched = attribution.value.observations.filter(
        (row) =>
          row.observation.source === source &&
          row.ownership.status !== "matched",
      ).length;
      const reasonCodes = new Set(current.reasonCodes);
      for (const checkpoint of sourceCheckpoints)
        if (checkpoint.reasonCode !== null)
          reasonCodes.add(checkpoint.reasonCode);
      if (sourceConflicts > 0) reasonCodes.add("SOURCE_CONFLICT");
      return {
        source,
        getAttempts: current.getAttempts,
        pageRequests: current.pageRequests,
        rowsReceived: current.rowsReceived,
        inserted: current.inserted,
        duplicates: current.duplicates,
        conflicts: sourceConflicts,
        unmatched,
        gaps: sourceGaps,
        status: stream.status,
        ...(lastFullyCoveredWindow === undefined
          ? {}
          : { lastFullyCoveredWindow }),
        ...(nextResumeWindow === undefined ? {} : { nextResumeWindow }),
        reasonCodes: [...reasonCodes].sort(),
        ...(current.diagnostic === undefined
          ? {}
          : { diagnostic: current.diagnostic }),
      };
    },
  );
  const pending = output.some(
    (source) => source.status === "partial" || source.status === "unavailable",
  );
  const getAttempts = dependencies.getAttemptCount
    ? Math.max(0, dependencies.getAttemptCount() - attemptsAtStart)
    : localGetCount();
  const status =
    pending || globalStop || conflicts.value.length > 0
      ? "PARTIAL"
      : "COMPLETE";
  return ok({
    schemaVersion: "history-sync-report/v1",
    selection: input.selection.kind,
    status,
    scope: input.scope,
    frozenUpperBoundMs: input.frozenUpperBoundMs,
    elapsedMs: Math.trunc(duration),
    getAttempts,
    rowsReceived,
    coverageLimitations: coverageLimitations(),
    sources: output,
    nextAction:
      status === "COMPLETE"
        ? "No selected windows remain pending; use --range resume for a later incremental refresh."
        : nextAction,
  });
}

export function createHistoryFixturePage(
  source: HistoryReadSource,
  window: HistoryReadWindow,
  cursor: string | null,
): HistoryReadPage {
  return Object.freeze({
    source,
    window: Object.freeze({ ...window }),
    cursor,
    nextCursor: null,
    receivedRowCount: 0,
    facts: Object.freeze([]) as readonly HistorySourceFact[],
  });
}
