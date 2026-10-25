import { createMacOSKeychainProvider } from "../adapters/macos-keychain.js";
import {
  BybitAccountReadError,
  BybitAccountReadTransport,
  type AccountReadBudget,
} from "../adapters/bybit-v5/account-read-transport.js";
import { mapAccountReadIdentity } from "../adapters/bybit-v5/account-key-mapper.js";
import {
  mapExecutionRecords,
  mapOrderObservation,
  mapOrderRecords,
  mapPosition,
  nextPageCursor,
  type BybitExecutionRecord,
  type BybitOrderRecord,
} from "../adapters/bybit-v5/read-mappers.js";
import type { BybitPublicResponse } from "../adapters/bybit-v5/public-response.js";
import { resolveOperatorMainnetSource } from "../adapters/sqlite/operator-mainnet-test-lookup.js";
import { openSqlitePersistence } from "../adapters/sqlite/sqlite-persistence.js";
import type { ExchangeFillObservation } from "../domain/execution/exchange-fill.js";
import type { OperatorMainnetTestPlan } from "../domain/execution/operator-mainnet-test-plan.js";
import { domainError } from "../domain/shared/errors.js";
import { fail, type Result } from "../domain/shared/result.js";
import { timestampFromEpochMs } from "../domain/shared/time.js";
import type { ExchangeOrderObservation } from "../domain/execution/exchange-order.js";
import type { ExchangeOrderLookup } from "../ports/exchange-execution.js";
import type { ExchangeCredentials } from "../ports/credential-provider.js";
import {
  runMainnetOperatorTestStatus,
  type MainnetOperatorTestChildFills,
  type MainnetOperatorTestStatusObservation,
} from "./mainnet-operator-test-status.js";
import {
  snapshotExchangeCredentials,
  withExchangeCounts,
} from "./mainnet-composition-helpers.js";

const ORDER_REALTIME_PATH = "/v5/order/realtime";
const ORDER_HISTORY_PATH = "/v5/order/history";
const EXECUTION_LIST_PATH = "/v5/execution/list";
const POSITION_LIST_PATH = "/v5/position/list";
const PAGE_LIMIT = "50";
const MAX_PAGES = 3;
const MAX_ATTEMPTS = 32;
const MAX_RESPONSE_BYTES = 1_048_576;
const OBSERVATION_DEADLINE_MS = 60_000;

function failClosed(code: string): Result<never> {
  return fail(
    domainError(
      "UNRESOLVED_RECONCILIATION",
      "operator status read is unresolved",
      {
        reasonCode: code,
      },
    ),
  );
}

function failClosedWithReads(
  code: string,
  exchangeReads: number,
): Result<never> {
  return fail(
    domainError(
      "UNRESOLVED_RECONCILIATION",
      "operator status read is unresolved",
      { reasonCode: code, exchangeReads },
    ),
  );
}

function orderSignature(record: BybitOrderRecord): string {
  return JSON.stringify({
    exchangeOrderId: record.exchangeOrderId,
    clientOrderId: record.clientOrderId,
    instrument: record.instrument,
    side: record.side,
    requestedQuantity: record.requestedQuantity.toString(),
    filledQuantity: record.filledQuantity.toString(),
    status: record.status,
    positionIdx: record.positionIdx,
    reduceOnly: record.reduceOnly,
    parentOrderLinkId: record.parentOrderLinkId ?? null,
    providerOrderLinkId: record.providerOrderLinkId ?? null,
    providerStopOrderType: record.providerStopOrderType ?? null,
    providerTpslMode: record.providerTpslMode ?? null,
    triggerBy: record.triggerBy ?? null,
    takeProfitTriggerBy: record.takeProfitTriggerBy ?? null,
    providerCreatedAt: record.providerCreatedAt ?? null,
    providerUpdatedAt: record.providerUpdatedAt ?? null,
    price: record.price?.toString() ?? null,
    averagePrice: record.averagePrice?.toString() ?? null,
    protectionType: record.protectionType ?? null,
    category: record.category ?? null,
    orderType: record.orderType ?? null,
    timeInForce: record.timeInForce ?? null,
    triggerPrice: record.triggerPrice?.toString() ?? null,
    takeProfit: record.takeProfit?.toString() ?? null,
    stopLoss: record.stopLoss?.toString() ?? null,
  });
}

function deduplicateOrders(
  records: readonly BybitOrderRecord[],
): Result<readonly BybitOrderRecord[]> {
  const unique = new Map<string, BybitOrderRecord>();
  for (const record of records) {
    const previous = unique.get(record.exchangeOrderId);
    if (previous && orderSignature(previous) !== orderSignature(record))
      return failClosed("ORDER_READ_CONTRADICTION");
    if (
      previous === undefined ||
      (previous.readSource === "order/history" &&
        record.readSource === "order/realtime")
    )
      unique.set(record.exchangeOrderId, record);
  }
  return { ok: true, value: [...unique.values()] };
}

function orderFill(record: BybitExecutionRecord): ExchangeFillObservation {
  return Object.freeze({
    executionId: record.executionId,
    exchangeOrderId: record.exchangeOrderId,
    clientOrderId: record.clientOrderId,
    instrument: record.instrument,
    side: record.side,
    quantity: record.quantity,
    price: record.price,
    executedAt: record.executedAt,
    source: "bybit-mainnet/execution",
    ...(record.fee === undefined ? {} : { fee: record.fee }),
    ...(record.feeCurrency === undefined
      ? {}
      : { feeCurrency: record.feeCurrency }),
  });
}

async function pagedRecords<T>(input: {
  readonly path: string;
  readonly query: Record<string, string>;
  readonly map: (response: BybitPublicResponse) => readonly T[];
  readonly get: (
    path: string,
    query: Readonly<Record<string, string>>,
  ) => Promise<{
    readonly result: Record<string, unknown>;
    readonly time?: number;
  }>;
}): Promise<readonly T[]> {
  const records: T[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = {
      ...input.query,
      ...(cursor === undefined ? {} : { cursor }),
    };
    const raw = await input.get(input.path, query);
    const response: BybitPublicResponse = {
      retCode: 0,
      retMsg: "",
      result: raw.result,
      ...(raw.time === undefined ? {} : { time: raw.time }),
    };
    records.push(...input.map(response));
    const next = nextPageCursor(response, input.path);
    if (next === undefined) return records;
    if (cursors.has(next)) throw new Error("pagination cursor repeated");
    cursors.add(next);
    cursor = next;
  }
  throw new Error("status page budget exhausted");
}

class ReadOnlyOperatorStatusExchange {
  private readonly transport: BybitAccountReadTransport;
  private reads: number;

  constructor(
    credentials: Readonly<ExchangeCredentials>,
    monotonicClock: () => number,
    utcClock: () => number,
    request: typeof fetch,
    deadline: number,
    initialReads = 0,
  ) {
    const start = monotonicClock();
    if (
      !Number.isFinite(start) ||
      deadline <= start ||
      !Number.isSafeInteger(initialReads) ||
      initialReads < 0
    )
      throw new Error("status observation deadline expired");
    this.reads = initialReads;
    const budget: AccountReadBudget = {
      deadline,
      attempts: 0,
      maxAttempts: MAX_ATTEMPTS,
      maxResponseBytes: MAX_RESPONSE_BYTES,
      maxObservedResponseBytes: 0,
    };
    this.transport = new BybitAccountReadTransport({
      environment: "mainnet",
      credentials,
      budget,
      request: async (url, init) => {
        const method = (init?.method ?? "GET").toUpperCase();
        if (method !== "GET") throw new Error("status permits GET only");
        this.reads += 1;
        return request(url, init);
      },
      clock: utcClock,
      monotonicClock,
      timeoutMs: 5_000,
    });
  }

  readCount(): number {
    return this.reads;
  }

  private async readOrders(
    path: string,
    symbol: string,
    sourceLabel: "order/realtime" | "order/history",
    clientOrderId?: string,
    exchangeOrderId?: string,
  ): Promise<readonly BybitOrderRecord[]> {
    const query: Record<string, string> = {
      category: "linear",
      symbol,
      limit: PAGE_LIMIT,
      ...(path === ORDER_REALTIME_PATH ? { openOnly: "0" } : {}),
      ...(clientOrderId === undefined ? {} : { orderLinkId: clientOrderId }),
      ...(exchangeOrderId === undefined ? {} : { orderId: exchangeOrderId }),
    };
    const rows = await pagedRecords({
      path,
      query,
      get: (requestPath, requestQuery) =>
        this.transport.get(requestPath, requestQuery),
      map: (response) => mapOrderRecords(response, symbol, sourceLabel),
    });
    if (
      clientOrderId !== undefined &&
      rows.some(
        (record) =>
          record.clientOrderId !== clientOrderId ||
          (exchangeOrderId !== undefined &&
            record.exchangeOrderId !== exchangeOrderId),
      )
    )
      throw new Error("order lookup returned an identity mismatch");
    return rows;
  }

  private async readFills(
    lookup: ExchangeOrderLookup,
  ): Promise<readonly ExchangeFillObservation[]> {
    const raw = await pagedRecords({
      path: EXECUTION_LIST_PATH,
      query: {
        category: "linear",
        symbol: lookup.instrument,
        orderLinkId: lookup.clientOrderId,
        limit: PAGE_LIMIT,
        ...(lookup.exchangeOrderId === undefined
          ? {}
          : { orderId: lookup.exchangeOrderId }),
      },
      get: (requestPath, requestQuery) =>
        this.transport.get(requestPath, requestQuery),
      map: (response) => mapExecutionRecords(response, lookup.instrument),
    });
    const fills = raw.map(orderFill);
    if (
      fills.some(
        (fill) =>
          fill.instrument !== lookup.instrument ||
          (fill.clientOrderId !== lookup.clientOrderId &&
            !(
              fill.clientOrderId === "" &&
              lookup.exchangeOrderId !== undefined &&
              fill.exchangeOrderId === lookup.exchangeOrderId
            )) ||
          (lookup.exchangeOrderId !== undefined &&
            fill.exchangeOrderId !== lookup.exchangeOrderId),
      )
    )
      throw new Error("execution lookup returned an identity mismatch");
    return fills;
  }

  async observe(
    plan: OperatorMainnetTestPlan,
    exchangeOrderId?: string,
  ): Promise<Result<MainnetOperatorTestStatusObservation>> {
    try {
      const orderResults = await Promise.allSettled([
        this.readOrders(
          ORDER_REALTIME_PATH,
          plan.symbol,
          "order/realtime",
          plan.clientOrderId,
          exchangeOrderId,
        ),
        this.readOrders(
          ORDER_HISTORY_PATH,
          plan.symbol,
          "order/history",
          plan.clientOrderId,
          exchangeOrderId,
        ),
      ]);
      const [realtimeResult, historyResult] = orderResults;
      if (realtimeResult.status === "rejected") throw realtimeResult.reason;
      if (historyResult.status === "rejected") throw historyResult.reason;
      const realtime = realtimeResult.value;
      const history = historyResult.value;
      const parentRecords = deduplicateOrders([...realtime, ...history]);
      if (!parentRecords.ok)
        return failClosedWithReads("ORDER_READ_CONTRADICTION", this.reads);
      if (parentRecords.value.length > 1)
        return failClosedWithReads("MULTIPLE_PARENT_ORDERS", this.reads);
      const parentRecord = parentRecords.value[0];
      const exactParentOrderId =
        parentRecord?.exchangeOrderId ?? exchangeOrderId;
      const symbolResults = await Promise.allSettled([
        this.readFills({
          instrument: plan.symbol,
          clientOrderId: plan.clientOrderId,
          ...(exactParentOrderId === undefined
            ? {}
            : { exchangeOrderId: exactParentOrderId }),
        }),
        this.readOrders(ORDER_REALTIME_PATH, plan.symbol, "order/realtime"),
        this.readOrders(ORDER_HISTORY_PATH, plan.symbol, "order/history"),
      ]);
      const [entryResult, symbolRealtimeResult, symbolHistoryResult] =
        symbolResults;
      if (entryResult.status === "rejected") throw entryResult.reason;
      if (symbolRealtimeResult.status === "rejected")
        throw symbolRealtimeResult.reason;
      if (symbolHistoryResult.status === "rejected")
        throw symbolHistoryResult.reason;
      const entryFills = entryResult.value;
      const symbolRealtime = symbolRealtimeResult.value;
      const symbolHistory = symbolHistoryResult.value;
      const allRecords = deduplicateOrders([
        ...symbolRealtime,
        ...symbolHistory,
      ]);
      if (!allRecords.ok)
        return failClosedWithReads("ORDER_READ_CONTRADICTION", this.reads);
      const all = allRecords.value;
      const childRecords = all.filter(
        (record) => record.parentOrderLinkId === plan.clientOrderId,
      );
      const positionResponse = await this.transport.get(POSITION_LIST_PATH, {
        category: "linear",
        symbol: plan.symbol,
      });
      const position = mapPosition(positionResponse, plan.symbol);
      const childFills: MainnetOperatorTestChildFills[] = [];
      for (const child of childRecords) {
        const fills = await this.readFills({
          instrument: plan.symbol,
          clientOrderId: child.clientOrderId,
          exchangeOrderId: child.exchangeOrderId,
        });
        childFills.push({
          exchangeOrderId: child.exchangeOrderId,
          clientOrderId: child.clientOrderId,
          fills,
        });
      }
      const providerTime = await this.transport.readExchangeTime();
      const observedAt = timestampFromEpochMs(providerTime);
      if (!observedAt.ok)
        return failClosedWithReads("PROVIDER_TIME_INVALID", this.reads);
      const parent = parentRecord
        ? mapOrderObservation(
            parentRecord,
            observedAt.value,
            `bybit-mainnet/${parentRecord.readSource ?? "order/history"}`,
          )
        : undefined;
      const children = childRecords.map((record) =>
        mapOrderObservation(
          record,
          observedAt.value,
          "bybit-mainnet/protection",
        ),
      );
      const activeOrders: ExchangeOrderObservation[] = all
        .filter(
          (record) =>
            record.status === "open" || record.status === "partially-filled",
        )
        .map((record) =>
          mapOrderObservation(
            record,
            observedAt.value,
            `bybit-mainnet/${record.readSource ?? "order/realtime"}`,
          ),
        );
      return {
        ok: true,
        value: {
          observedAt: observedAt.value,
          parentLookupComplete: true,
          ...(parent === undefined ? {} : { parent }),
          entryFills,
          children,
          childFills,
          position: {
            instrument: position.instrument,
            side: position.side,
            quantity: position.quantity,
          },
          activeOrders,
          exchangeReads: this.reads,
        },
      };
    } catch (error) {
      return failClosedWithReads(
        error instanceof BybitAccountReadError
          ? `READ_${error.code}`
          : error instanceof Error &&
              error.message === "status page budget exhausted"
            ? "PAGE_BUDGET_EXHAUSTED"
            : "READ_FAILED",
        this.reads,
      );
    }
  }
}

/** Resolve the source from private SQLite, then expose only GET reads and append-only local evidence. */
export async function runMainnetOperatorTestStatusComposition(input: {
  readonly sourceId: unknown;
  readonly manualAction?:
    "entry-remainder-cancelled" | "position-closed" | "other";
  readonly actor?: unknown;
}) {
  let exchangeReads = 0;
  let statusExchange: ReadOnlyOperatorStatusExchange | undefined;
  const resolved = resolveOperatorMainnetSource(input.sourceId);
  if (!resolved.ok) return withExchangeCounts(resolved, exchangeReads, 0);
  if (!resolved.value)
    return withExchangeCounts(
      fail(
        domainError("INVALID_VALUE", "operator status source was not found"),
      ),
      exchangeReads,
      0,
    );
  const wall = Date.now;
  const monotonic = () => performance.now();
  const localClock = {
    now: () => {
      const timestamp = timestampFromEpochMs(wall());
      if (!timestamp.ok) throw new Error("local clock unavailable");
      return timestamp.value;
    },
  };
  const persistence = openSqlitePersistence({
    environment: "mainnet",
    scope: resolved.value.scope,
    clock: localClock,
  });
  if (!persistence.ok) return withExchangeCounts(persistence, exchangeReads, 0);
  try {
    const journal = persistence.value.operatorMainnetTest;
    if (!journal)
      return withExchangeCounts(
        failClosed("OPERATOR_JOURNAL_UNAVAILABLE"),
        exchangeReads,
        0,
      );
    const provider = createMacOSKeychainProvider();
    const credentials = snapshotExchangeCredentials(
      await provider.load("mainnet"),
    );
    const observationDeadline = monotonic() + OBSERVATION_DEADLINE_MS;
    const identityBudget: AccountReadBudget = {
      deadline: observationDeadline,
      attempts: 0,
      maxAttempts: MAX_ATTEMPTS,
      maxResponseBytes: MAX_RESPONSE_BYTES,
      maxObservedResponseBytes: 0,
    };
    const identityRequest: typeof fetch = async (url, init) => {
      if ((init?.method ?? "GET").toUpperCase() !== "GET")
        throw new Error("status permits GET only");
      exchangeReads += 1;
      return fetch(url, init);
    };
    const identityTransport = new BybitAccountReadTransport({
      environment: "mainnet",
      credentials,
      budget: identityBudget,
      request: identityRequest,
      clock: wall,
      monotonicClock: monotonic,
      timeoutMs: 5_000,
    });
    const authenticatedAtMs = await identityTransport.readExchangeTime();
    const authenticatedAt = timestampFromEpochMs(authenticatedAtMs);
    if (!authenticatedAt.ok)
      return withExchangeCounts(
        failClosed("ACCOUNT_TIME_INVALID"),
        exchangeReads,
        0,
      );
    const identity = mapAccountReadIdentity(
      await identityTransport.get("/v5/user/query-api"),
      credentials.accountId,
      "mainnet",
      authenticatedAt.value,
    );
    if (
      identity.accountBinding.accountIdentityHash !==
      resolved.value.snapshot.plan.accountIdentityHash
    )
      return withExchangeCounts(
        failClosed("ACCOUNT_IDENTITY_MISMATCH"),
        exchangeReads,
        0,
      );
    statusExchange = new ReadOnlyOperatorStatusExchange(
      credentials,
      monotonic,
      wall,
      fetch,
      observationDeadline,
      exchangeReads,
    );
    const result = await runMainnetOperatorTestStatus(input, {
      persistence: persistence.value,
      journal,
      exchange: statusExchange,
      clock: localClock,
    });
    return withExchangeCounts(result, statusExchange.readCount(), 0);
  } catch (error) {
    return withExchangeCounts(
      failClosed(
        error instanceof BybitAccountReadError
          ? `READ_${error.code}`
          : "STATUS_COMPOSITION_FAILED",
      ),
      statusExchange?.readCount() ?? exchangeReads,
      0,
    );
  } finally {
    persistence.value.close();
  }
}
