import type {
  AccountSnapshot,
  MarketSnapshot,
} from "../domain/market/snapshots.js";
import type { DecimalValue } from "../domain/shared/decimal.js";
import type { UtcTimestamp } from "../domain/shared/time.js";
import type { OrderIntent } from "../domain/planning/order-intent.js";
import type { ExchangeOrderObservation } from "../domain/execution/exchange-order.js";

export type { ExchangeOrderObservation } from "../domain/execution/exchange-order.js";

export type ExchangeOperation =
  "read" | "create" | "observe" | "fills" | "cancel";

export type ExchangeFailureKind =
  | "configuration"
  | "authentication"
  | "permission"
  | "clock-skew"
  | "rate-limited"
  | "ambiguous"
  | "ownership"
  | "precondition"
  | "invalid-response"
  | "transport"
  | "exchange";

export type ExchangeRetryDisposition =
  "never" | "read-only" | "reconcile" | "safe";

/**
 * A safe, exchange-neutral description of an adapter failure. It deliberately
 * contains no response body, signed headers, credentials or transport object.
 */
export interface ExchangeExecutionFailure {
  readonly kind: ExchangeFailureKind;
  readonly message: string;
  readonly retry: ExchangeRetryDisposition;
  readonly operation?: ExchangeOperation;
  readonly exchangeCode?: number;
  readonly httpStatus?: number;
  readonly clientOrderId?: string;
  readonly exchangeOrderId?: string;
}

export type ExchangeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ExchangeExecutionFailure };

export function exchangeSuccess<T>(value: T): ExchangeResult<T> {
  return { ok: true, value };
}

export function exchangeFailure(
  error: ExchangeExecutionFailure,
): ExchangeResult<never> {
  return { ok: false, error };
}

export interface ExchangeReadStateRequest {
  readonly instrument: string;
}

export type AccountReadinessStatus = "ready" | "unready";

export interface AccountReadiness {
  readonly status: AccountReadinessStatus;
  readonly reason?: string;
}

/**
 * The complete bounded read used by preflight and reconciliation. The
 * snapshots carry the selected-symbol position and owned active orders; the
 * adapter remains responsible for constructing them from exchange records.
 */
export interface ExchangeReadState {
  readonly serverTime: UtcTimestamp;
  readonly market: MarketSnapshot;
  readonly account: AccountSnapshot;
  readonly openOrders: readonly ExchangeOrderObservation[];
  readonly accountReadiness: AccountReadiness;
}

export type ExchangeTimeInForce = "GTC" | "IOC" | "FOK" | "PostOnly";

/**
 * Caller-owned order identity and execution semantics. The adapter validates
 * the identity for its exchange and sends it unchanged; it never generates a
 * replacement client ID.
 */
export interface ExchangeOrderRequest {
  readonly intent: OrderIntent;
  readonly clientOrderId: string;
  readonly timeInForce: ExchangeTimeInForce;
  readonly reduceOnly: boolean;
}

export type ExchangeAcknowledgementStatus = "accepted" | "pending";

/**
 * An HTTP/exchange acknowledgement is intentionally not a terminal order
 * observation. Callers must reconcile it using the original identities.
 */
export interface ExchangeOrderAcknowledgement {
  readonly clientOrderId: string;
  readonly exchangeOrderId?: string;
  readonly acknowledgedAt: UtcTimestamp;
  readonly status: ExchangeAcknowledgementStatus;
}

export interface ExchangeOrderLookup {
  readonly instrument: string;
  readonly clientOrderId: string;
  readonly exchangeOrderId?: string;
}

export type ExchangeOrderObservationRequest = ExchangeOrderLookup;
export type ExchangeFillLookupRequest = ExchangeOrderLookup;

/**
 * An adapter-level execution observation is not yet a domain Fill: the
 * application supplies its owned attempt/lineage identity before persisting
 * accounting facts.
 */
export interface ExchangeFillObservation {
  readonly executionId: string;
  readonly exchangeOrderId: string;
  readonly clientOrderId: string;
  readonly instrument: string;
  readonly side: "buy" | "sell";
  readonly quantity: DecimalValue;
  readonly price: DecimalValue;
  readonly executedAt: UtcTimestamp;
  readonly source: string;
  readonly fee?: DecimalValue;
  readonly feeCurrency?: string;
}

export type ExchangeCancelOrderRequest = ExchangeOrderLookup;

export interface ExchangeExecutionPort {
  readState(
    request: ExchangeReadStateRequest,
  ): Promise<ExchangeResult<ExchangeReadState>>;
  createOrder(
    request: ExchangeOrderRequest,
  ): Promise<ExchangeResult<ExchangeOrderAcknowledgement>>;
  observeOrder(
    request: ExchangeOrderObservationRequest,
  ): Promise<ExchangeResult<ExchangeOrderObservation>>;
  listFills(
    request: ExchangeFillLookupRequest,
  ): Promise<ExchangeResult<readonly ExchangeFillObservation[]>>;
  cancelOrder(
    request: ExchangeCancelOrderRequest,
  ): Promise<ExchangeResult<ExchangeOrderAcknowledgement>>;
}
