import {
  createHistorySourceFact,
  type HistorySourceFact,
  type HistorySourceFactInput,
} from "../../domain/accounting/history-source-fact.js";
import { DecimalValue } from "../../domain/shared/decimal.js";
import {
  timestampFromEpochMs,
  type UtcTimestamp,
} from "../../domain/shared/time.js";
import type { HistoryReadSource } from "../../ports/history-read.js";
import type { AccountReadResponse } from "./account-read-transport.js";
import { BybitAccountReadError } from "./account-read-transport.js";

function invalid(): never {
  throw new BybitAccountReadError("INVALID_RESPONSE");
}

function record(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.values(Object.getOwnPropertyDescriptors(value)).some(
      (descriptor) => !Object.hasOwn(descriptor, "value"),
    )
  )
    invalid();
  return value as Record<string, unknown>;
}

function rows(response: AccountReadResponse): readonly Record<string, unknown>[] {
  const envelope = record(response);
  const result = record(envelope.result);
  const list = result.list;
  if (
    !Array.isArray(list) ||
    list.length > 100 ||
    Object.values(Object.getOwnPropertyDescriptors(list)).some(
      (descriptor) => !Object.hasOwn(descriptor, "value"),
    )
  )
    invalid();
  return list.map(record);
}

function text(value: unknown, required = false): string | null {
  if (value === undefined || value === null || value === "") {
    if (required) invalid();
    return null;
  }
  if (
    typeof value !== "string" ||
    value.length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    invalid();
  return value;
}

function identifier(value: unknown): string {
  const valueText = text(value, true);
  if (
    valueText === null ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(valueText)
  )
    invalid();
  return valueText;
}

function decimal(value: unknown, required = false): string | null {
  if (value === undefined || value === null || value === "") {
    if (required) invalid();
    return null;
  }
  if (typeof value !== "string") invalid();
  const parsed = DecimalValue.fromString(value);
  if (!parsed.ok) invalid();
  return parsed.value.toString();
}

function timestamp(value: unknown, required = true): UtcTimestamp | null {
  if (value === undefined || value === null || value === "") {
    if (required) invalid();
    return null;
  }
  if (typeof value !== "string" || !/^\d+$/u.test(value)) invalid();
  const ms = Number(value);
  if (!Number.isSafeInteger(ms) || ms <= 0) invalid();
  const parsed = timestampFromEpochMs(ms);
  if (!parsed.ok) invalid();
  return parsed.value;
}

function bool(value: unknown): boolean | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "boolean") invalid();
  return value;
}

function sequence(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    return String(value);
  if (typeof value === "string" && /^\d+$/u.test(value) && value.length <= 32)
    return value;
  invalid();
}

function feeDetails(
  value: unknown,
): readonly { currency: string; amount: string }[] {
  if (value === undefined || value === null) return [];
  const fees = record(value);
  const keys = Reflect.ownKeys(fees);
  if (
    keys.length > 100 ||
    keys.some(
      (key) =>
        typeof key !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(key),
    )
  )
    invalid();
  return keys
    .map((key) => ({
      currency: key as string,
      amount: decimal(fees[key as string], true)!,
    }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

function category(
  row: Record<string, unknown>,
  response: AccountReadResponse,
): string {
  const result = record(record(response).result);
  const native = row.category ?? result.category;
  if (native === undefined || native === null || native === "") return "linear";
  if (native !== "linear") invalid();
  return "linear";
}

function fact(input: HistorySourceFactInput): HistorySourceFact {
  const parsed = createHistorySourceFact(input);
  if (!parsed.ok) invalid();
  return parsed.value;
}

function collectAt(value: unknown): UtcTimestamp {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    invalid();
  const date = timestampFromEpochMs(value);
  if (!date.ok) invalid();
  return date.value;
}

function sortFacts<T extends HistorySourceFact>(
  values: readonly T[],
  key: (value: T) => string,
): readonly T[] {
  return [...values].sort((a, b) => {
    const time = a.providerEventTime.localeCompare(b.providerEventTime);
    return time || key(a).localeCompare(key(b));
  });
}

function collapseIdenticalImmutable<T extends HistorySourceFact>(
  values: readonly T[],
  key: (value: T) => string,
): readonly T[] {
  const seen = new Map<string, T>();
  for (const value of values) {
    const id = key(value);
    const previous = seen.get(id);
    if (previous && previous.contentHash !== value.contentHash) invalid();
    seen.set(id, previous ?? value);
  }
  return [...seen.values()];
}

export function mapBybitOrderHistoryResponse(
  response: AccountReadResponse,
  collectedAt: number,
): readonly HistorySourceFact[] {
  const at = collectAt(collectedAt);
  const mapped = rows(response).map((row) =>
    fact({
      factKind: "order",
      source: "order-history",
      providerEventTime: timestamp(row.createdTime)!,
      providerRevisionTime: timestamp(row.updatedTime, false),
      collectedAt: at,
      category: category(row, response),
      symbol: identifier(row.symbol),
      orderId: identifier(row.orderId),
      orderLinkId: text(row.orderLinkId),
      parentOrderLinkId: text(row.parentOrderLinkId),
      side: text(row.side, true)!,
      orderType: text(row.orderType, true)!,
      orderStatus: text(row.orderStatus, true)!,
      timeInForce: text(row.timeInForce),
      qty: decimal(row.qty, true)!,
      price: decimal(row.price, true)!,
      avgPrice: decimal(row.avgPrice),
      cumExecQty: decimal(row.cumExecQty),
      cumExecValue: decimal(row.cumExecValue),
      cumExecFee: decimal(row.cumExecFee),
      feeDetails: feeDetails(row.cumFeeDetail),
      leavesQty: decimal(row.leavesQty),
      leavesValue: decimal(row.leavesValue),
      createType: text(row.createType),
      cancelType: text(row.cancelType),
      rejectReason: text(row.rejectReason),
      tpslMode: text(row.tpslMode),
      tpTriggerBy: text(row.tpTriggerBy),
      slTriggerBy: text(row.slTriggerBy),
      triggerBy: text(row.triggerBy),
      triggerPrice: decimal(row.triggerPrice),
      takeProfit: decimal(row.takeProfit),
      stopLoss: decimal(row.stopLoss),
      stopOrderType: text(row.stopOrderType),
      marketUnit: text(row.marketUnit),
      isLeverage: text(row.isLeverage),
      blockTradeId: text(row.blockTradeId),
      reduceOnly: bool(row.reduceOnly),
      closeOnTrigger: bool(row.closeOnTrigger),
      positionIdx: sequence(row.positionIdx),
    }),
  );
  const versions = new Map<string, HistorySourceFact>();
  for (const order of mapped) {
    if (order.factKind !== "order") invalid();
    const identity =
      order.orderId + "\u0000" + (order.providerRevisionTime ?? "");
    const prior = versions.get(identity);
    if (prior && prior.contentHash !== order.contentHash) invalid();
    versions.set(identity, prior ?? order);
  }
  return sortFacts([...versions.values()], (value) =>
    value.factKind === "order"
      ? value.orderId + "\u0000" + (value.providerRevisionTime ?? "")
      : "",
  );
}

export function mapBybitExecutionResponse(
  response: AccountReadResponse,
  collectedAt: number,
): readonly HistorySourceFact[] {
  const at = collectAt(collectedAt);
  const mapped = rows(response).map((row) =>
    fact({
      factKind: "execution",
      source: "executions",
      providerEventTime: timestamp(row.execTime)!,
      providerRevisionTime: null,
      collectedAt: at,
      category: category(row, response),
      symbol: identifier(row.symbol),
      orderId: identifier(row.orderId),
      orderLinkId: text(row.orderLinkId),
      execId: identifier(row.execId),
      side: text(row.side, true)!,
      execType: text(row.execType, true)!,
      execPrice: decimal(row.execPrice, true)!,
      execQty: decimal(row.execQty, true)!,
      execValue: decimal(row.execValue),
      execFee: decimal(row.execFee),
      feeCurrency: text(row.feeCurrency),
      feeRate: decimal(row.feeRate),
      execFeeV2: decimal(row.execFeeV2),
      execPnl: decimal(row.execPnl),
      closedSize: decimal(row.closedSize),
      isMaker: bool(row.isMaker),
      seq: sequence(row.seq),
      leavesQty: decimal(row.leavesQty),
      markPrice: decimal(row.markPrice),
      indexPrice: decimal(row.indexPrice),
      underlyingPrice: decimal(row.underlyingPrice),
      createType: text(row.createType),
    }),
  );
  const unique = collapseIdenticalImmutable(mapped, (value) =>
    value.factKind === "execution" ? value.execId : "",
  );
  return sortFacts(unique, (value) =>
    value.factKind === "execution" ? value.execId : "",
  );
}

export function mapBybitClosedPnlResponse(
  response: AccountReadResponse,
  collectedAt: number,
): readonly HistorySourceFact[] {
  const at = collectAt(collectedAt);
  const mapped = rows(response).map((row) => {
    const createdTime = timestamp(row.createdTime)!;
    return fact({
      factKind: "closed-pnl",
      source: "closed-pnl",
      providerEventTime: createdTime,
      providerRevisionTime: timestamp(row.updatedTime, false),
      collectedAt: at,
      category: category(row, response),
      symbol: identifier(row.symbol),
      orderId: identifier(row.orderId),
      side: text(row.side, true)!,
      orderType: text(row.orderType, true)!,
      execType: text(row.execType, true)!,
      qty: decimal(row.qty),
      orderPrice: decimal(row.orderPrice),
      closedSize: decimal(row.closedSize),
      cumEntryValue: decimal(row.cumEntryValue),
      avgEntryPrice: decimal(row.avgEntryPrice),
      cumExitValue: decimal(row.cumExitValue),
      avgExitPrice: decimal(row.avgExitPrice),
      closedPnl: decimal(row.closedPnl),
      openFee: decimal(row.openFee),
      closeFee: decimal(row.closeFee),
      fundingFee: decimal(row.fundingFee),
      fillCount: decimal(row.fillCount),
      leverage: decimal(row.leverage),
    });
  });
  return sortFacts(mapped, (value) =>
    value.factKind === "closed-pnl"
      ? value.orderId + "\u0000" + value.contentHash
      : "",
  );
}

export function mapBybitTransactionLogResponse(
  response: AccountReadResponse,
  collectedAt: number,
): readonly HistorySourceFact[] {
  const at = collectAt(collectedAt);
  const mapped = rows(response).map((row) =>
    fact({
      factKind: "transaction",
      source: "transaction-log",
      providerEventTime: timestamp(row.transactionTime)!,
      providerRevisionTime: null,
      collectedAt: at,
      transactionId: identifier(row.id),
      category: text(row.category),
      symbol: text(row.symbol),
      side: text(row.side),
      currency: text(row.currency),
      type: text(row.type),
      transSubType: text(row.transSubType),
      qty: decimal(row.qty),
      size: decimal(row.size),
      tradePrice: decimal(row.tradePrice),
      cashFlow: decimal(row.cashFlow),
      funding: decimal(row.funding),
      fee: decimal(row.fee),
      feeRate: decimal(row.feeRate),
      change: decimal(row.change),
      bonusChange: decimal(row.bonusChange),
      cashBalance: decimal(row.cashBalance),
      tradeId: text(row.tradeId),
      orderId: text(row.orderId),
      orderLinkId: text(row.orderLinkId),
      displayType: text(row.displayType),
      extraFees: text(row.extraFees),
    }),
  );
  const unique = collapseIdenticalImmutable(mapped, (value) =>
    value.factKind === "transaction" ? value.transactionId : "",
  );
  return sortFacts(unique, (value) =>
    value.factKind === "transaction" ? value.transactionId : "",
  );
}

export function mapBybitHistoryResponse(
  source: HistoryReadSource,
  response: AccountReadResponse,
  collectedAt: number,
): readonly HistorySourceFact[] {
  switch (source) {
    case "order-history":
      return mapBybitOrderHistoryResponse(response, collectedAt);
    case "executions":
      return mapBybitExecutionResponse(response, collectedAt);
    case "closed-pnl":
      return mapBybitClosedPnlResponse(response, collectedAt);
    case "transaction-log":
      return mapBybitTransactionLogResponse(response, collectedAt);
  }
}
