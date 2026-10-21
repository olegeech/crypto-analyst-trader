import type { DecimalValue } from "../shared/decimal.js";
import type { UtcTimestamp } from "../shared/time.js";

/** Provider fill evidence before the application binds it to accounting lineage. */
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
