import {
  createAccountAssetEvidence,
  createAccountCriticalPass,
  createAccountPositionEvidence,
  createAccountOrderEvidence,
  createAccountExecutionEvidence,
  createAccountCollateralTierEvidence,
  type AccountModeEvidence,
  type AccountTotalsEvidence,
  type AccountAssetEvidence,
  type AccountCollateralEvidence,
  type AccountPositionEvidence,
  type AccountOrderEvidence,
  type AccountExecutionEvidence,
  type AccountCollateralTierEvidence,
} from "../../domain/account/account-evidence-bundle.js";
import { DecimalValue } from "../../domain/shared/decimal.js";
import { deepFreeze } from "../../domain/shared/deep-freeze.js";
import { canonicalSerialize } from "../../domain/identity/canonical-serialization.js";
import type { Result } from "../../domain/shared/result.js";
import { timestampFromEpochMs } from "../../domain/shared/time.js";
import { requireIdentifier } from "../../domain/shared/validation.js";
import {
  BybitAccountReadError,
  type AccountReadResponse,
} from "./account-read-transport.js";

/** Pure response-to-fact APIs. Each accepts AccountReadResponse, throws sanitized
 * BybitAccountReadError(INVALID_RESPONSE) on malformed/conflicting input, and
 * returns deeply frozen domain facts validated by the existing closed constructors.
 * Identity scope is the response category; account/environment binding belongs to
 * the collector. Duplicates are observation-local, never merged across passes.
 * No ownership, availability-to-withdraw, conversion or capacity is inferred.
 */
function invalid(): never {
  throw new BybitAccountReadError("INVALID_RESPONSE");
}
function unwrap<T>(result: Result<T>): T {
  return result.ok ? result.value : invalid();
}
function record(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.values(Object.getOwnPropertyDescriptors(value)).some(
      (d) => !Object.hasOwn(d, "value"),
    )
  )
    invalid();
  return value as Record<string, unknown>;
}
function array(value: unknown): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    value.length > 10000 ||
    Object.values(Object.getOwnPropertyDescriptors(value)).some(
      (d) => !Object.hasOwn(d, "value"),
    )
  )
    invalid();
  return value;
}
function result(response: AccountReadResponse) {
  return record(record(response).result);
}
function rows(response: AccountReadResponse) {
  return array(result(response).list).map(record);
}
function responseCategory(
  response: AccountReadResponse,
  scope?: string,
): string {
  const native = result(response).category;
  if (scope !== undefined) {
    const category = text(scope);
    if (native !== undefined && text(native) !== category) invalid();
    return category;
  }
  return text(native);
}
const missing = (v: unknown) => v === undefined || v === null || v === "";
const unavailable = () =>
  ({ state: "unavailable", reason: "not-returned" }) as const;
const known = <T>(value: T) => ({ state: "known", value }) as const;
function text(v: unknown) {
  return unwrap(requireIdentifier(v, "identity"));
}
function integer(v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) invalid();
  return v;
}
function bool(v: unknown) {
  if (typeof v !== "boolean") invalid();
  return v;
}
function fact(v: unknown, parse: (v: unknown) => unknown = text) {
  return missing(v) ? unavailable() : known(parse(v));
}
function decimal(
  v: unknown,
  unit: "coin" | "USD" | "rate" | "contracts" | "price",
) {
  return { ...fact(v, (v) => unwrap(DecimalValue.fromString(v))), unit };
}
function time(v: unknown) {
  if (typeof v !== "string" || !/^\d+$/u.test(v)) invalid();
  const epoch = Number(v);
  if (!Number.isSafeInteger(epoch)) invalid();
  return unwrap(timestampFromEpochMs(epoch));
}
function link(v: unknown) {
  return missing(v) ? null : text(v);
}
function normalized<T>(
  values: readonly T[],
  key: (v: T) => string,
  compare?: (a: T, b: T) => number,
): readonly T[] {
  const unique = new Map<string, T>();
  for (const value of values) {
    const id = key(value),
      previous = unique.get(id);
    if (
      previous !== undefined &&
      unwrap(canonicalSerialize(previous)) !== unwrap(canonicalSerialize(value))
    )
      invalid();
    unique.set(id, value);
  }
  return deepFreeze(
    [...unique.values()].sort(
      compare ?? ((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)),
    ),
  );
}
function totals(row: Record<string, unknown>) {
  return {
    totalEquity: decimal(row.totalEquity, "USD"),
    totalWalletBalance: decimal(row.totalWalletBalance, "USD"),
    totalMarginBalance: decimal(row.totalMarginBalance, "USD"),
    totalPerpUPL: decimal(row.totalPerpUPL, "USD"),
    totalAvailableBalance: decimal(row.totalAvailableBalance, "USD"),
    totalInitialMargin: decimal(row.totalInitialMargin, "USD"),
    totalMaintenanceMargin: decimal(row.totalMaintenanceMargin, "USD"),
    accountIMRate: decimal(row.accountIMRate, "rate"),
    accountMMRate: decimal(row.accountMMRate, "rate"),
    equityBasis: "unestablished",
  };
}
// Account/totals/collateral have no standalone constructor; validate them through
// the exact closed critical-pass schema, with explicitly unavailable unused facts.
function pass(account: unknown, totalFacts: unknown, collateral: unknown = []) {
  return unwrap(
    createAccountCriticalPass({
      account,
      totals: totalFacts,
      collateral,
      assets: [],
      positions: [],
      orders: [],
      modeProbes: [],
      observations: [],
    }),
  );
}
const unknownAccount = () => ({
  utaStatus: unavailable(),
  marginMode: unavailable(),
  spotHedging: unavailable(),
});
/** Returns AccountModeEvidence; ON/OFF are the documented spot-hedging booleans. */
export function mapAccountInfo(
  response: AccountReadResponse,
): AccountModeEvidence {
  const row = result(response);
  const hedging = row.spotHedgingStatus;
  const spotHedging = missing(hedging)
    ? unavailable()
    : hedging === "ON"
      ? known(true)
      : hedging === "OFF"
        ? known(false)
        : { state: "unavailable", reason: "unsupported" };
  return pass(
    {
      utaStatus: fact(row.unifiedMarginStatus, integer),
      marginMode: fact(row.marginMode),
      spotHedging,
    },
    totals({}),
  ).account;
}
/** Returns {totals: AccountTotalsEvidence, assets: readonly AccountAssetEvidence[]}.
 * Requires exactly one UNIFIED wallet; absent USD-equity basis stays unestablished.
 */
export function mapAccountWallet(response: AccountReadResponse): {
  readonly totals: AccountTotalsEvidence;
  readonly assets: readonly AccountAssetEvidence[];
} {
  const wallets = rows(response);
  if (wallets.length !== 1 || wallets[0]?.accountType !== "UNIFIED") invalid();
  const row = wallets[0];
  const assets = array(row.coin).map((v) => {
    const a = record(v);
    return unwrap(
      createAccountAssetEvidence({
        coin: text(a.coin),
        walletBalance: decimal(a.walletBalance, "coin"),
        equity: decimal(a.equity, "coin"),
        usdValue: decimal(a.usdValue, "USD"),
        usdEquity: decimal(undefined, "USD"),
        locked: decimal(a.locked, "coin"),
        bonus: decimal(a.bonus, "coin"),
        borrowAmount: decimal(a.borrowAmount, "coin"),
        spotBorrow: decimal(a.spotBorrow, "coin"),
        accruedInterest: decimal(a.accruedInterest, "coin"),
        totalOrderIM: decimal(a.totalOrderIM, "USD"),
        totalPositionIM: decimal(a.totalPositionIM, "USD"),
        totalPositionMM: decimal(a.totalPositionMM, "USD"),
        unrealisedPnl: decimal(a.unrealisedPnl, "coin"),
        collateralEligible: fact(a.marginCollateral, bool),
        collateralSwitch:
          a.marginCollateral === false
            ? { state: "not-applicable" }
            : fact(a.collateralSwitch, bool),
        restricted: unavailable(),
      }),
    );
  });
  return deepFreeze({
    totals: pass(unknownAccount(), totals(row)).totals,
    assets: normalized(assets, (a) => a.coin),
  });
}
/** Returns readonly AccountCollateralEvidence[]; shared debt is retained separately. */
export function mapAccountCollateral(
  response: AccountReadResponse,
): readonly AccountCollateralEvidence[] {
  const collateral = rows(response).map((a) => ({
    coin: text(a.currency),
    collateralEligible: fact(a.marginCollateral, bool),
    collateralSwitch:
      a.marginCollateral === false
        ? { state: "not-applicable" }
        : fact(a.collateralSwitch, bool),
    restricted: unavailable(),
    borrowable: fact(a.borrowable, bool),
    borrowAmount: decimal(a.borrowAmount, "coin"),
    otherBorrowAmount: decimal(a.otherBorrowAmount, "coin"),
    maxBorrowingAmount: decimal(a.maxBorrowingAmount, "coin"),
    hourlyBorrowRate: decimal(a.hourlyBorrowRate, "rate"),
  }));
  return pass(unknownAccount(), totals({}), collateral).collateral;
}
/** Returns readonly AccountPositionEvidence[], keyed by category/symbol/index.
 * Provider blank side on a proven zero-size row maps to the domain's None sentinel.
 */
export function mapAccountPositions(
  response: AccountReadResponse,
  scope?: string,
): readonly AccountPositionEvidence[] {
  const category = responseCategory(response, scope);
  const amountUnit = category === "inverse" ? "coin" : "USD";
  const values = rows(response).map((a) =>
    unwrap(
      createAccountPositionEvidence({
        category,
        symbol: text(a.symbol),
        positionIdx: integer(a.positionIdx),
        side:
          a.side === "" &&
          !missing(a.size) &&
          unwrap(DecimalValue.fromString(a.size)).isZero()
            ? "None"
            : text(a.side),
        size: decimal(a.size, "contracts"),
        avgPrice: decimal(a.avgPrice, "price"),
        markPrice: decimal(a.markPrice, "price"),
        positionValue: decimal(a.positionValue, amountUnit),
        unrealisedPnl: decimal(a.unrealisedPnl, amountUnit),
        positionIM: decimal(a.positionIM, amountUnit),
        positionMM: decimal(a.positionMM, amountUnit),
        leverage: decimal(a.leverage, "rate"),
        riskId: fact(a.riskId, integer),
        tradeMode: fact(a.tradeMode, integer),
        isReduceOnly: fact(a.isReduceOnly, bool),
        // Bybit explicitly defines -1 as "symbol never traded".
        seq:
          a.seq === "-1" || a.seq === -1
            ? { state: "not-applicable" }
            : fact(a.seq, (v) =>
                typeof v === "number" && Number.isSafeInteger(v)
                  ? String(v)
                  : text(v),
              ),
        createdAt: fact(a.createdTime, time),
        updatedAt: fact(a.updatedTime, time),
        takeProfit: decimal(a.takeProfit, "price"),
        stopLoss: decimal(a.stopLoss, "price"),
        trailingStop: decimal(a.trailingStop, "price"),
      }),
    ),
  );
  return normalized(values, (a) =>
    JSON.stringify([a.category, a.symbol, a.positionIdx]),
  );
}
/** Returns readonly AccountOrderEvidence[], keyed by category/orderId. Client IDs
 * are optional metadata, including manual orders; native enums are retained verbatim.
 */
export function mapAccountOrders(
  response: AccountReadResponse,
  scope?: string,
): readonly AccountOrderEvidence[] {
  const category = responseCategory(response, scope);
  const values = rows(response).map((a) =>
    unwrap(
      createAccountOrderEvidence({
        category,
        symbol: text(a.symbol),
        orderId: text(a.orderId),
        orderLinkId: link(a.orderLinkId),
        status: text(a.orderStatus),
        side: text(a.side),
        orderType: text(a.orderType),
        price: decimal(a.price, "price"),
        qty: decimal(a.qty, "contracts"),
        cumExecQty: decimal(a.cumExecQty, "contracts"),
        leavesQty: decimal(a.leavesQty, "contracts"),
        positionIdx: fact(a.positionIdx, integer),
        reduceOnly: fact(a.reduceOnly, bool),
        closeOnTrigger: fact(a.closeOnTrigger, bool),
        triggerPrice: decimal(a.triggerPrice, "price"),
        triggerDirection: fact(a.triggerDirection, integer),
        triggerBy: fact(a.triggerBy),
        stopOrderType: fact(a.stopOrderType),
        takeProfit: decimal(a.takeProfit, "price"),
        stopLoss: decimal(a.stopLoss, "price"),
        tpslMode: fact(a.tpslMode),
        timeInForce: fact(a.timeInForce),
        orderFilter: fact(a.orderFilter),
        createdAt: fact(a.createdTime, time),
        updatedAt: fact(a.updatedTime, time),
      }),
    ),
  );
  return normalized(values, (a) => JSON.stringify([a.category, a.orderId]));
}
function extraFees(v: unknown) {
  if (missing(v)) return unavailable();
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      invalid();
    }
  }
  return known(
    array(v).map((v) => {
      const a = record(v);
      return {
        feeCoin: fact(a.feeCoin),
        feeType: fact(a.feeType),
        subFeeType: fact(a.subFeeType),
        feeRate: decimal(a.feeRate, "rate"),
        fee: decimal(a.fee, "coin"),
      };
    }),
  );
}
/** Returns readonly AccountExecutionEvidence[], identity category/execId, sorted
 * by time then identity. execFee, FutureSpread's execFeeV2 and extraFees remain
 * separate provider facts. Empty feeCurrency never implies settlement currency.
 * https://bybit-exchange.github.io/docs/v5/order/execution
 */
export function mapAccountExecutions(
  response: AccountReadResponse,
  scope?: string,
): readonly AccountExecutionEvidence[] {
  const category = responseCategory(response, scope);
  const values = rows(response).map((a) =>
    unwrap(
      createAccountExecutionEvidence({
        category,
        symbol: text(a.symbol),
        execId: text(a.execId),
        orderId: text(a.orderId),
        orderLinkId: link(a.orderLinkId),
        execType: text(a.execType),
        side: text(a.side),
        execTime: time(a.execTime),
        price: decimal(a.execPrice, "price"),
        qty: decimal(a.execQty, "contracts"),
        fee: decimal(a.execFee, "coin"),
        feeCurrency: fact(a.feeCurrency),
        feeRate: decimal(a.feeRate, "rate"),
        execFeeV2: decimal(a.execFeeV2, "coin"),
        extraFees: extraFees(a.extraFees),
      }),
    ),
  );
  const key = (a: AccountExecutionEvidence) =>
    JSON.stringify([a.category, a.execId]);
  return normalized(values, key, (a, b) =>
    a.execTime < b.execTime
      ? -1
      : a.execTime > b.execTime
        ? 1
        : key(a) < key(b)
          ? -1
          : key(a) > key(b)
            ? 1
            : 0,
  );
}
function alias(
  row: Record<string, unknown>,
  first: string,
  second: string,
): unknown {
  if (
    Object.hasOwn(row, first) &&
    Object.hasOwn(row, second) &&
    JSON.stringify(row[first]) !== JSON.stringify(row[second])
  )
    invalid();
  return Object.hasOwn(row, first) ? row[first] : row[second];
}
/** Returns readonly AccountCollateralTierEvidence[]. Supports the official
 * currency/collateralRatioList/collateralRatio shape and coin/tiers/ratio shape.
 * Only tier-level ratios are read; blank maxQty means unbounded, never missing.
 * Validates bounds and overlap, preserving provider-unspecified inclusivity.
 * https://bybit-exchange.github.io/docs/v5/spot-margin-uta/tier-collateral-ratio
 */
export function mapAccountTiers(
  response: AccountReadResponse,
): readonly AccountCollateralTierEvidence[] {
  const values = rows(response).flatMap((a) => {
    const coin = text(alias(a, "currency", "coin"));
    return array(alias(a, "collateralRatioList", "tiers")).map((v) => {
      const t = record(v);
      if (
        missing(t.minQty) ||
        t.maxQty === undefined ||
        t.maxQty === null ||
        missing(alias(t, "collateralRatio", "ratio"))
      )
        invalid();
      return unwrap(
        createAccountCollateralTierEvidence({
          coin,
          minQty: decimal(t.minQty, "coin"),
          maxQty: t.maxQty === "" ? null : decimal(t.maxQty, "coin"),
          collateralRatio: decimal(
            alias(t, "collateralRatio", "ratio"),
            "rate",
          ),
          boundSemantics: "provider-unspecified",
        }),
      );
    });
  });
  const min = (a: AccountCollateralTierEvidence) =>
    a.minQty.state === "known" ? a.minQty.value : invalid();
  const sorted = normalized(
    values,
    (a) => JSON.stringify([a.coin, min(a).toString()]),
    (a, b) =>
      a.coin < b.coin ? -1 : a.coin > b.coin ? 1 : min(a).compare(min(b)),
  );
  const one = unwrap(DecimalValue.fromString("1"));
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i]!;
    if (
      a.collateralRatio.state !== "known" ||
      a.collateralRatio.value.isNegative() ||
      a.collateralRatio.value.compare(one) > 0
    )
      invalid();
    if (
      a.maxQty !== null &&
      (a.maxQty.state !== "known" || a.maxQty.value.compare(min(a)) <= 0)
    )
      invalid();
    const next = sorted[i + 1];
    if (
      next?.coin === a.coin &&
      (a.maxQty === null ||
        a.maxQty.state !== "known" ||
        a.maxQty.value.compare(min(next)) > 0)
    )
      invalid();
  }
  return sorted;
}
