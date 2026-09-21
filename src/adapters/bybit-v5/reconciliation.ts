import type {
  ExchangeFillLookupRequest,
  ExchangeFillObservation,
  ExchangeOrderLookup,
  ExchangeOrderObservation,
  ExchangeResult,
} from "../../ports/exchange-execution.js";
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
  return Object.freeze({
    exchangeOrderId: record.exchangeOrderId,
    clientOrderId: record.clientOrderId,
    instrument: record.instrument,
    side: record.side,
    requestedQuantity: record.requestedQuantity,
    filledQuantity: record.filledQuantity,
    status: record.status,
    observedAt,
    source,
    ...(record.averagePrice === undefined
      ? {}
      : { averagePrice: record.averagePrice }),
  });
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
      (previous.status !== record.status ||
        previous.filledQuantity.compare(record.filledQuantity) !== 0)
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
    const realtimeSelection = selectOwnedOrder(
      realtime,
      request,
      "bybit-demo/realtime",
    );
    if (realtime.length > 0 && !realtimeSelection.ok) {
      return realtimeSelection;
    }
    if (realtimeSelection.ok) {
      return exchangeSuccess(
        orderObservation(
          realtimeSelection.value.record,
          observedAt,
          realtimeSelection.value.source,
        ),
      );
    }

    const history = await client.readOrderHistory(request);
    const historySelection = selectOwnedOrder(
      history,
      request,
      "bybit-demo/history",
    );
    if (historySelection.ok) {
      return exchangeSuccess(
        orderObservation(
          historySelection.value.record,
          observedAt,
          historySelection.value.source,
        ),
      );
    }
    return historySelection;
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
