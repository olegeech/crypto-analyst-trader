import type {
  ExchangeFillLookupRequest,
  ExchangeFillObservation,
  ExchangeOrderLookup,
  ExchangeOrderObservation,
  ExchangeResult,
} from "../../ports/exchange-execution.js";
import { createExchangeOrder } from "../../domain/execution/exchange-order.js";
import {
  exchangeFailure,
  exchangeSuccess,
} from "../../ports/exchange-execution.js";
import type { UtcTimestamp } from "../../domain/shared/time.js";
import type { BybitDemoReadClient } from "./client.js";
import {
  normalizeBybitFailure,
  type BybitFailureContext,
} from "./error-mapping.js";
import type { BybitExecutionRecord, BybitOrderRecord } from "./read-mappers.js";

function context(
  operation: BybitFailureContext["operation"],
  request: ExchangeOrderLookup,
): BybitFailureContext {
  return {
    operation,
    clientOrderId: request.clientOrderId,
    ...(request.exchangeOrderId === undefined
      ? {}
      : { exchangeOrderId: request.exchangeOrderId }),
  };
}

function ownsOrder(
  record: BybitOrderRecord,
  request: ExchangeOrderLookup,
): boolean {
  return (
    record.instrument === request.instrument &&
    record.clientOrderId === request.clientOrderId &&
    (request.exchangeOrderId === undefined ||
      record.exchangeOrderId === request.exchangeOrderId)
  );
}

function ownsExecution(
  record: BybitExecutionRecord,
  request: ExchangeFillLookupRequest,
): boolean {
  return (
    record.instrument === request.instrument &&
    record.clientOrderId === request.clientOrderId &&
    (request.exchangeOrderId === undefined ||
      record.exchangeOrderId === request.exchangeOrderId)
  );
}

function orderObservation(
  record: BybitOrderRecord,
  observedAt: UtcTimestamp,
  source: string,
): ExchangeOrderObservation {
  const observation = createExchangeOrder({
    exchangeOrderId: record.exchangeOrderId,
    clientOrderId: record.clientOrderId,
    instrument: record.instrument,
    side: record.side,
    requestedQuantity: record.requestedQuantity.toString(),
    filledQuantity: record.filledQuantity.toString(),
    status: record.status,
    observedAt,
    source,
    ...(record.parentOrderLinkId === undefined
      ? {}
      : { parentOrderLinkId: record.parentOrderLinkId }),
    ...(record.averagePrice === undefined
      ? {}
      : { averagePrice: record.averagePrice.toString() }),
    ...(record.protectionType === undefined
      ? {}
      : { protectionType: record.protectionType }),
  });
  if (!observation.ok) {
    throw new Error("normalized Bybit order observation is invalid");
  }
  return observation.value;
}

function fillObservation(
  record: BybitExecutionRecord,
): ExchangeFillObservation {
  return Object.freeze({
    executionId: record.executionId,
    exchangeOrderId: record.exchangeOrderId,
    clientOrderId: record.clientOrderId,
    instrument: record.instrument,
    side: record.side,
    quantity: record.quantity,
    price: record.price,
    executedAt: record.executedAt,
    source: "bybit-demo/execution",
    ...(record.fee === undefined ? {} : { fee: record.fee }),
    ...(record.feeCurrency === undefined
      ? {}
      : { feeCurrency: record.feeCurrency }),
  });
}

function selectOwnedOrder(
  records: readonly BybitOrderRecord[],
  request: ExchangeOrderLookup,
  source: string,
): ExchangeResult<{
  readonly record: BybitOrderRecord;
  readonly source: string;
}> {
  if (records.some((record) => !ownsOrder(record, request))) {
    return exchangeFailure({
      kind: "ownership",
      message:
        "Bybit returned an order that does not match the supplied identity.",
      retry: "reconcile",
      operation: "observe",
      clientOrderId: request.clientOrderId,
      ...(request.exchangeOrderId === undefined
        ? {}
        : { exchangeOrderId: request.exchangeOrderId }),
    });
  }
  const unique = new Map<string, BybitOrderRecord>();
  for (const record of records) {
    const previous = unique.get(record.exchangeOrderId);
    if (
      previous !== undefined &&
      (previous.instrument !== record.instrument ||
        previous.clientOrderId !== record.clientOrderId ||
        previous.side !== record.side ||
        previous.requestedQuantity.compare(record.requestedQuantity) !== 0 ||
        previous.status !== record.status ||
        previous.filledQuantity.compare(record.filledQuantity) !== 0 ||
        previous.parentOrderLinkId !== record.parentOrderLinkId ||
        previous.reduceOnly !== record.reduceOnly ||
        previous.price?.toString() !== record.price?.toString() ||
        previous.averagePrice?.toString() !== record.averagePrice?.toString() ||
        previous.protectionType !== record.protectionType)
    ) {
      return exchangeFailure({
        kind: "ambiguous",
        message:
          "Bybit returned contradictory observations for one exchange order.",
        retry: "reconcile",
        operation: "observe",
        clientOrderId: request.clientOrderId,
        exchangeOrderId: record.exchangeOrderId,
      });
    }
    unique.set(record.exchangeOrderId, record);
  }
  const selected = [...unique.values()];
  if (selected.length === 0) {
    return exchangeFailure({
      kind: "ambiguous",
      message:
        "The owned order was not found in the selected reconciliation source.",
      retry: "reconcile",
      operation: "observe",
      clientOrderId: request.clientOrderId,
      ...(request.exchangeOrderId === undefined
        ? {}
        : { exchangeOrderId: request.exchangeOrderId }),
    });
  }
  if (selected.length !== 1) {
    return exchangeFailure({
      kind: "ambiguous",
      message:
        "Bybit returned multiple owned exchange orders for one client identity.",
      retry: "reconcile",
      operation: "observe",
      clientOrderId: request.clientOrderId,
    });
  }
  return exchangeSuccess({ record: selected[0]!, source });
}

export async function reconcileOrder(
  client: BybitDemoReadClient,
  request: ExchangeOrderLookup,
  observedAt: UtcTimestamp,
): Promise<ExchangeResult<ExchangeOrderObservation>> {
  const failureContext = context("observe", request);
  try {
    const realtime = await client.readRealtimeOrder(request);
    const history = await client.readOrderHistory(request);
    const executions = await client.readExecutions(request);
    const sourceSelections = [
      {
        records: realtime,
        source: "bybit-demo/realtime",
      },
      {
        records: history,
        source: "bybit-demo/history",
      },
    ] as const;
    const candidates = new Map<
      string,
      {
        readonly record: BybitOrderRecord;
        readonly source: string;
      }
    >();
    for (const source of sourceSelections) {
      if (source.records.length === 0) continue;
      const selected = selectOwnedOrder(source.records, request, source.source);
      if (!selected.ok) return selected;
      const existing = candidates.get(selected.value.record.exchangeOrderId);
      if (
        existing !== undefined &&
        (existing.record.instrument !== selected.value.record.instrument ||
          existing.record.clientOrderId !==
            selected.value.record.clientOrderId ||
          existing.record.status !== selected.value.record.status ||
          existing.record.filledQuantity.compare(
            selected.value.record.filledQuantity,
          ) !== 0 ||
          existing.record.requestedQuantity.compare(
            selected.value.record.requestedQuantity,
          ) !== 0 ||
          existing.record.side !== selected.value.record.side ||
          existing.record.parentOrderLinkId !==
            selected.value.record.parentOrderLinkId ||
          existing.record.reduceOnly !== selected.value.record.reduceOnly ||
          existing.record.price?.toString() !==
            selected.value.record.price?.toString() ||
          existing.record.averagePrice?.toString() !==
            selected.value.record.averagePrice?.toString() ||
          existing.record.protectionType !==
            selected.value.record.protectionType)
      ) {
        return exchangeFailure({
          kind: "ambiguous",
          message:
            "Bybit realtime and history evidence contradict for one exchange order.",
          retry: "reconcile",
          operation: "observe",
          clientOrderId: request.clientOrderId,
          exchangeOrderId: selected.value.record.exchangeOrderId,
        });
      }
      candidates.set(selected.value.record.exchangeOrderId, {
        record: selected.value.record,
        source:
          existing === undefined
            ? source.source
            : `${existing.source}+${source.source.split("/").at(-1)}`,
      });
    }

    if (executions.some((record) => !ownsExecution(record, request))) {
      return exchangeFailure({
        kind: "ownership",
        message:
          "Bybit returned execution evidence that does not match the supplied identity.",
        retry: "reconcile",
        operation: "observe",
        clientOrderId: request.clientOrderId,
        ...(request.exchangeOrderId === undefined
          ? {}
          : { exchangeOrderId: request.exchangeOrderId }),
      });
    }
    const executionOrderIds = new Set(
      executions.map((execution) => execution.exchangeOrderId),
    );
    if (
      executionOrderIds.size > 1 ||
      (executionOrderIds.size === 1 &&
        !candidates.has([...executionOrderIds][0]!))
    ) {
      return exchangeFailure({
        kind: "ambiguous",
        message:
          "Bybit realtime, history and execution evidence identify different exchange orders.",
        retry: "reconcile",
        operation: "observe",
        clientOrderId: request.clientOrderId,
      });
    }
    if (candidates.size !== 1) {
      return exchangeFailure({
        kind: "ambiguous",
        message:
          candidates.size === 0
            ? "The owned order was not found in bounded reconciliation evidence."
            : "Bybit returned multiple exchange orders for one client identity.",
        retry: "reconcile",
        operation: "observe",
        clientOrderId: request.clientOrderId,
      });
    }
    const selected = [...candidates.values()][0]!;
    return exchangeSuccess(
      orderObservation(
        selected.record,
        observedAt,
        executions.length === 0
          ? selected.source
          : `${selected.source}+execution`,
      ),
    );
  } catch (error) {
    return exchangeFailure(normalizeBybitFailure(error, failureContext));
  }
}

export async function listOwnedFills(
  client: BybitDemoReadClient,
  request: ExchangeFillLookupRequest,
): Promise<ExchangeResult<readonly ExchangeFillObservation[]>> {
  const failureContext = context("fills", request);
  try {
    const records = await client.readExecutions(request);
    if (records.some((record) => !ownsExecution(record, request))) {
      return exchangeFailure({
        kind: "ownership",
        message:
          "Bybit returned execution evidence that does not match the supplied identity.",
        retry: "reconcile",
        operation: "fills",
        clientOrderId: request.clientOrderId,
        ...(request.exchangeOrderId === undefined
          ? {}
          : { exchangeOrderId: request.exchangeOrderId }),
      });
    }
    const unique = new Map<string, ExchangeFillObservation>();
    for (const record of records) {
      const observation = fillObservation(record);
      const previous = unique.get(observation.executionId);
      if (
        previous !== undefined &&
        (previous.exchangeOrderId !== observation.exchangeOrderId ||
          previous.quantity.compare(observation.quantity) !== 0 ||
          previous.price.compare(observation.price) !== 0)
      ) {
        return exchangeFailure({
          kind: "ambiguous",
          message:
            "Bybit returned contradictory evidence for one execution identity.",
          retry: "reconcile",
          operation: "fills",
          clientOrderId: request.clientOrderId,
          exchangeOrderId: observation.exchangeOrderId,
        });
      }
      unique.set(observation.executionId, observation);
    }
    return exchangeSuccess([...unique.values()]);
  } catch (error) {
    return exchangeFailure(normalizeBybitFailure(error, failureContext));
  }
}
