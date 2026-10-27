import { deepFreeze } from "../shared/deep-freeze.js";
import { DecimalValue } from "../shared/decimal.js";
import { domainError } from "../shared/errors.js";
import { hashCanonical, type PlanHash } from "../identity/canonical-serialization.js";
import type { Result } from "../shared/result.js";
import { fail, ok } from "../shared/result.js";
import { parseUtcTimestamp, type UtcTimestamp } from "../shared/time.js";
import { requireIdentifier } from "../shared/validation.js";

export const HISTORY_SOURCE_FACT_SCHEMA = "bybit-history-source-fact/v1" as const;

export interface HistoryFeeDetail {
  readonly currency: string;
  readonly amount: string;
}

interface HistorySourceFactBase {
  readonly schemaVersion: typeof HISTORY_SOURCE_FACT_SCHEMA;
  readonly providerEventTime: UtcTimestamp;
  readonly providerRevisionTime: UtcTimestamp | null;
  readonly collectedAt: UtcTimestamp;
  readonly contentHash: PlanHash;
}

export interface OrderHistorySourceFact extends HistorySourceFactBase {
  readonly factKind: "order";
  readonly source: "order-history";
  readonly category: string;
  readonly symbol: string;
  readonly orderId: string;
  readonly orderLinkId: string | null;
  readonly parentOrderLinkId: string | null;
  readonly side: string;
  readonly orderType: string;
  readonly orderStatus: string;
  readonly timeInForce: string | null;
  readonly qty: string;
  readonly price: string;
  readonly avgPrice: string | null;
  readonly cumExecQty: string | null;
  readonly cumExecValue: string | null;
  readonly cumExecFee: string | null;
  readonly feeDetails: readonly HistoryFeeDetail[];
  readonly leavesQty: string | null;
  readonly leavesValue: string | null;
  readonly createType: string | null;
  readonly cancelType: string | null;
  readonly rejectReason: string | null;
  readonly tpslMode: string | null;
  readonly tpTriggerBy: string | null;
  readonly slTriggerBy: string | null;
  readonly triggerBy: string | null;
  readonly triggerPrice: string | null;
  readonly takeProfit: string | null;
  readonly stopLoss: string | null;
  readonly stopOrderType: string | null;
  readonly marketUnit: string | null;
  readonly isLeverage: string | null;
  readonly blockTradeId: string | null;
  readonly reduceOnly: boolean | null;
  readonly closeOnTrigger: boolean | null;
  readonly positionIdx: string | null;
}

export interface ExecutionHistorySourceFact extends HistorySourceFactBase {
  readonly factKind: "execution";
  readonly source: "executions";
  readonly category: string;
  readonly symbol: string;
  readonly orderId: string;
  readonly orderLinkId: string | null;
  readonly execId: string;
  readonly side: string;
  readonly execType: string;
  readonly execPrice: string;
  readonly execQty: string;
  readonly execValue: string | null;
  readonly execFee: string | null;
  readonly execFeeV2: string | null;
  readonly feeCurrency: string | null;
  readonly feeRate: string | null;
  readonly execPnl: string | null;
  readonly closedSize: string | null;
  readonly isMaker: boolean | null;
  readonly seq: string | null;
  readonly leavesQty: string | null;
  readonly markPrice: string | null;
  readonly indexPrice: string | null;
  readonly underlyingPrice: string | null;
  readonly createType: string | null;
}

export interface ClosedPnlHistorySourceFact extends HistorySourceFactBase {
  readonly factKind: "closed-pnl";
  readonly source: "closed-pnl";
  readonly category: string;
  readonly symbol: string;
  readonly orderId: string;
  /** Provenance/grouping data only; Bybit does not document this as a row ID. */
  readonly groupingKey: {
    readonly category: string;
    readonly symbol: string;
    readonly orderId: string;
    readonly createdTime: UtcTimestamp;
  };
  readonly side: string;
  readonly orderType: string;
  readonly execType: string;
  readonly qty: string | null;
  readonly orderPrice: string | null;
  readonly closedSize: string | null;
  readonly cumEntryValue: string | null;
  readonly avgEntryPrice: string | null;
  readonly cumExitValue: string | null;
  readonly avgExitPrice: string | null;
  readonly closedPnl: string | null;
  readonly openFee: string | null;
  readonly closeFee: string | null;
  readonly fundingFee: string | null;
  readonly fillCount: string | null;
  readonly leverage: string | null;
}

export interface TransactionHistorySourceFact extends HistorySourceFactBase {
  readonly factKind: "transaction";
  readonly source: "transaction-log";
  readonly transactionId: string;
  readonly category: string | null;
  readonly symbol: string | null;
  readonly side: string | null;
  readonly currency: string | null;
  /** Provider values stay open strings so new Bybit types remain visible. */
  readonly type: string | null;
  readonly transSubType: string | null;
  readonly qty: string | null;
  readonly size: string | null;
  readonly tradePrice: string | null;
  readonly cashFlow: string | null;
  readonly funding: string | null;
  readonly fee: string | null;
  readonly feeRate: string | null;
  readonly change: string | null;
  readonly bonusChange: string | null;
  readonly cashBalance: string | null;
  readonly tradeId: string | null;
  readonly orderId: string | null;
  readonly orderLinkId: string | null;
  readonly displayType: string | null;
  readonly extraFees: string | null;
}

export type HistorySourceFact =
  | OrderHistorySourceFact
  | ExecutionHistorySourceFact
  | ClosedPnlHistorySourceFact
  | TransactionHistorySourceFact;

type FactInput<T> = Omit<
  T,
  | "schemaVersion"
  | "contentHash"
  | "providerEventTime"
  | "providerRevisionTime"
  | "collectedAt"
> & {
  readonly providerEventTime: string;
  readonly providerRevisionTime: string | null;
  readonly collectedAt: string;
};
export type HistorySourceFactInput =
  | FactInput<OrderHistorySourceFact>
  | FactInput<ExecutionHistorySourceFact>
  | FactInput<Omit<ClosedPnlHistorySourceFact, "groupingKey">>
  | FactInput<TransactionHistorySourceFact>;

function invalid(): Result<never> {
  return fail(
    domainError("INVALID_VALUE", "Bybit history source fact is invalid"),
  );
}

function safeProviderText(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    value.length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    return undefined;
  return value === "" ? null : value;
}

function identifier(value: unknown): string | undefined {
  const parsed = requireIdentifier(value, "history source identity");
  return parsed.ok ? parsed.value : undefined;
}

function decimal(value: unknown): string | null | undefined {
  if (value === null) return null;
  const parsed = DecimalValue.fromString(value);
  return parsed.ok ? parsed.value.toString() : undefined;
}

function time(value: unknown): UtcTimestamp | undefined {
  const parsed = parseUtcTimestamp(value);
  return parsed.ok ? parsed.value : undefined;
}

function validBool(value: unknown): boolean | null | undefined {
  return value === null || typeof value === "boolean" ? value : undefined;
}

function validFeeDetails(value: unknown): readonly HistoryFeeDetail[] | undefined {
  if (!Array.isArray(value) || value.length > 100) return undefined;
  const output: HistoryFeeDetail[] = [];
  for (const entry of value) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      Object.getPrototypeOf(entry) !== Object.prototype ||
      Object.values(Object.getOwnPropertyDescriptors(entry)).some(
        (descriptor) => !Object.hasOwn(descriptor, "value"),
      )
    )
      return undefined;
    const row = entry as Record<string, unknown>;
    const currency = identifier(row.currency);
    const amount = decimal(row.amount);
    if (currency === undefined || amount === undefined || amount === null)
      return undefined;
    output.push({ currency, amount });
  }
  return deepFreeze(output);
}

function validCommon(input: {
  providerEventTime: unknown;
  providerRevisionTime: unknown;
  collectedAt: unknown;
}):
  | {
      providerEventTime: UtcTimestamp;
      providerRevisionTime: UtcTimestamp | null;
      collectedAt: UtcTimestamp;
    }
  | undefined {
  const providerEventTime = time(input.providerEventTime);
  const providerRevisionTime =
    input.providerRevisionTime === null
      ? null
      : time(input.providerRevisionTime);
  const collectedAt = time(input.collectedAt);
  if (
    providerEventTime === undefined ||
    providerRevisionTime === undefined ||
    collectedAt === undefined
  )
    return undefined;
  return { providerEventTime, providerRevisionTime, collectedAt };
}

function semanticCommon(
  common: ReturnType<typeof validCommon> & {},
): {
  providerEventTime: UtcTimestamp;
  providerRevisionTime: UtcTimestamp | null;
} {
  return {
    providerEventTime: common.providerEventTime,
    providerRevisionTime: common.providerRevisionTime,
  };
}

/**
 * Validates and freezes one typed provider observation. The hash covers only
 * normalized source facts; local collection time is deliberately excluded.
 * Account/environment scope is attached by the collector, not this domain type.
 */
export function createHistorySourceFact(
  input: HistorySourceFactInput,
): Result<HistorySourceFact> {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype ||
    Object.values(Object.getOwnPropertyDescriptors(input)).some(
      (descriptor) => !Object.hasOwn(descriptor, "value"),
    )
  )
    return invalid();
  const common = validCommon(input);
  if (!common) return invalid();

  let core:
    | Omit<OrderHistorySourceFact, "schemaVersion" | "collectedAt" | "contentHash">
    | Omit<ExecutionHistorySourceFact, "schemaVersion" | "collectedAt" | "contentHash">
    | Omit<ClosedPnlHistorySourceFact, "schemaVersion" | "collectedAt" | "contentHash">
    | Omit<TransactionHistorySourceFact, "schemaVersion" | "collectedAt" | "contentHash">
    | undefined;

  if (input.factKind === "order" && input.source === "order-history") {
    const category = identifier(input.category);
    const symbol = identifier(input.symbol);
    const orderId = identifier(input.orderId);
    const side = safeProviderText(input.side);
    const orderType = safeProviderText(input.orderType);
    const orderStatus = safeProviderText(input.orderStatus);
    const qty = decimal(input.qty);
    const price = decimal(input.price);
    const feeDetails = validFeeDetails(input.feeDetails);
    if (
      category === undefined ||
      symbol === undefined ||
      orderId === undefined ||
      side === null ||
      side === undefined ||
      orderType === null ||
      orderType === undefined ||
      orderStatus === null ||
      orderStatus === undefined ||
      qty === undefined ||
      qty === null ||
      price === undefined ||
      price === null ||
      feeDetails === undefined
    )
      return invalid();
    const nullable = {
      orderLinkId: safeProviderText(input.orderLinkId),
      parentOrderLinkId: safeProviderText(input.parentOrderLinkId),
      timeInForce: safeProviderText(input.timeInForce),
      avgPrice: decimal(input.avgPrice),
      cumExecQty: decimal(input.cumExecQty),
      cumExecValue: decimal(input.cumExecValue),
      cumExecFee: decimal(input.cumExecFee),
      leavesQty: decimal(input.leavesQty),
      leavesValue: decimal(input.leavesValue),
      createType: safeProviderText(input.createType),
      cancelType: safeProviderText(input.cancelType),
      rejectReason: safeProviderText(input.rejectReason),
      tpslMode: safeProviderText(input.tpslMode),
      tpTriggerBy: safeProviderText(input.tpTriggerBy),
      slTriggerBy: safeProviderText(input.slTriggerBy),
      triggerBy: safeProviderText(input.triggerBy),
      triggerPrice: decimal(input.triggerPrice),
      takeProfit: decimal(input.takeProfit),
      stopLoss: decimal(input.stopLoss),
      stopOrderType: safeProviderText(input.stopOrderType),
      marketUnit: safeProviderText(input.marketUnit),
      isLeverage: safeProviderText(input.isLeverage),
      blockTradeId: safeProviderText(input.blockTradeId),
      reduceOnly: validBool(input.reduceOnly),
      closeOnTrigger: validBool(input.closeOnTrigger),
      positionIdx: safeProviderText(input.positionIdx),
    };
    if (Object.values(nullable).some((value) => value === undefined))
      return invalid();
    core = {
      factKind: "order",
      source: "order-history",
      ...semanticCommon(common),
      category,
      symbol,
      orderId,
      side,
      orderType,
      orderStatus,
      qty,
      price,
      feeDetails,
      ...nullable,
    } as Omit<OrderHistorySourceFact, "schemaVersion" | "collectedAt" | "contentHash">;
  } else if (input.factKind === "execution" && input.source === "executions") {
    const category = identifier(input.category);
    const symbol = identifier(input.symbol);
    const orderId = identifier(input.orderId);
    const execId = identifier(input.execId);
    const side = safeProviderText(input.side);
    const execType = safeProviderText(input.execType);
    const execPrice = decimal(input.execPrice);
    const execQty = decimal(input.execQty);
    if (
      category === undefined ||
      symbol === undefined ||
      orderId === undefined ||
      execId === undefined ||
      side === null ||
      side === undefined ||
      execType === null ||
      execType === undefined ||
      execPrice === undefined ||
      execPrice === null ||
      execQty === undefined ||
      execQty === null
    )
      return invalid();
    const nullable = {
      orderLinkId: safeProviderText(input.orderLinkId),
      execValue: decimal(input.execValue),
      execFee: decimal(input.execFee),
      execFeeV2: decimal(input.execFeeV2),
      feeCurrency: safeProviderText(input.feeCurrency),
      feeRate: decimal(input.feeRate),
      execPnl: decimal(input.execPnl),
      closedSize: decimal(input.closedSize),
      isMaker: validBool(input.isMaker),
      seq: safeProviderText(input.seq),
      leavesQty: decimal(input.leavesQty),
      markPrice: decimal(input.markPrice),
      indexPrice: decimal(input.indexPrice),
      underlyingPrice: decimal(input.underlyingPrice),
      createType: safeProviderText(input.createType),
    };
    if (Object.values(nullable).some((value) => value === undefined))
      return invalid();
    core = {
      factKind: "execution",
      source: "executions",
      ...semanticCommon(common),
      category,
      symbol,
      orderId,
      execId,
      side,
      execType,
      execPrice,
      execQty,
      ...nullable,
    } as Omit<ExecutionHistorySourceFact, "schemaVersion" | "collectedAt" | "contentHash">;
  } else if (input.factKind === "closed-pnl" && input.source === "closed-pnl") {
    const category = identifier(input.category);
    const symbol = identifier(input.symbol);
    const orderId = identifier(input.orderId);
    const side = safeProviderText(input.side);
    const orderType = safeProviderText(input.orderType);
    const execType = safeProviderText(input.execType);
    if (
      category === undefined ||
      symbol === undefined ||
      orderId === undefined ||
      side === null ||
      side === undefined ||
      orderType === null ||
      orderType === undefined ||
      execType === null ||
      execType === undefined
    )
      return invalid();
    const decimalFields = {
      qty: decimal(input.qty),
      orderPrice: decimal(input.orderPrice),
      closedSize: decimal(input.closedSize),
      cumEntryValue: decimal(input.cumEntryValue),
      avgEntryPrice: decimal(input.avgEntryPrice),
      cumExitValue: decimal(input.cumExitValue),
      avgExitPrice: decimal(input.avgExitPrice),
      closedPnl: decimal(input.closedPnl),
      openFee: decimal(input.openFee),
      closeFee: decimal(input.closeFee),
      fundingFee: decimal(input.fundingFee),
      fillCount: decimal(input.fillCount),
      leverage: decimal(input.leverage),
    };
    if (Object.values(decimalFields).some((value) => value === undefined))
      return invalid();
    core = {
      factKind: "closed-pnl",
      source: "closed-pnl",
      ...semanticCommon(common),
      category,
      symbol,
      orderId,
      groupingKey: {
        category,
        symbol,
        orderId,
        createdTime: common.providerEventTime,
      },
      side,
      orderType,
      execType,
      ...decimalFields,
    } as Omit<ClosedPnlHistorySourceFact, "schemaVersion" | "collectedAt" | "contentHash">;
  } else if (
    input.factKind === "transaction" &&
    input.source === "transaction-log"
  ) {
    const transactionId = identifier(input.transactionId);
    if (transactionId === undefined) return invalid();
    const nullable = {
      category: safeProviderText(input.category),
      symbol: safeProviderText(input.symbol),
      side: safeProviderText(input.side),
      currency: safeProviderText(input.currency),
      type: safeProviderText(input.type),
      transSubType: safeProviderText(input.transSubType),
      qty: decimal(input.qty),
      size: decimal(input.size),
      tradePrice: decimal(input.tradePrice),
      cashFlow: decimal(input.cashFlow),
      funding: decimal(input.funding),
      fee: decimal(input.fee),
      feeRate: decimal(input.feeRate),
      change: decimal(input.change),
      bonusChange: decimal(input.bonusChange),
      cashBalance: decimal(input.cashBalance),
      tradeId: safeProviderText(input.tradeId),
      orderId: safeProviderText(input.orderId),
      orderLinkId: safeProviderText(input.orderLinkId),
      displayType: safeProviderText(input.displayType),
      extraFees: safeProviderText(input.extraFees),
    };
    if (Object.values(nullable).some((value) => value === undefined))
      return invalid();
    core = {
      factKind: "transaction",
      source: "transaction-log",
      ...semanticCommon(common),
      transactionId,
      ...nullable,
    } as Omit<TransactionHistorySourceFact, "schemaVersion" | "collectedAt" | "contentHash">;
  }
  if (!core) return invalid();
  const hash = hashCanonical(core);
  if (!hash.ok) return invalid();
  return ok(
    deepFreeze({
      schemaVersion: HISTORY_SOURCE_FACT_SCHEMA,
      ...core,
      collectedAt: common.collectedAt,
      contentHash: hash.value,
    }) as HistorySourceFact,
  );
}
