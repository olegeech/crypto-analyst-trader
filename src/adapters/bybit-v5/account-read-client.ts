import type {
  AccountEvidenceReadPort,
  AccountPartitionRead,
  AccountReadEnvelope,
  AccountReadWindow,
} from "../../ports/account-evidence.js";
import {
  ACCOUNT_EVIDENCE_COLLECTION_POLICY as policy,
  type AccountEvidencePartition,
} from "../../domain/account/account-evidence-policy.js";
import type { AccountEvidenceFailureCode } from "../../domain/account/account-evidence-diagnostics.js";
import { isRecord, requireIdentifier } from "../../domain/shared/validation.js";
import {
  timestampFromEpochMs,
  type UtcTimestamp,
} from "../../domain/shared/time.js";
import { BybitAccountReadError } from "./account-read-transport.js";

type ReadTransport = {
  get(
    path: string,
    query?: Readonly<Record<string, string>>,
  ): Promise<AccountReadEnvelope>;
  readExchangeTime(): Promise<number>;
};
export function accountReadFailureCode(
  error: unknown,
): AccountEvidenceFailureCode {
  return error instanceof BybitAccountReadError
    ? error.code
    : "TRANSPORT_FAILED";
}
function utc(value: number): UtcTimestamp {
  const parsed = timestampFromEpochMs(value);
  if (!parsed.ok) throw new BybitAccountReadError("INVALID_RESPONSE");
  return parsed.value;
}
function route(
  p: AccountEvidencePartition,
  window?: AccountReadWindow,
): { path: string; query: Record<string, string>; paged: boolean } {
  const query: Record<string, string> = {};
  if (p.category) query.category = p.category;
  if (p.settleCoin) query.settleCoin = p.settleCoin;
  if (p.baseCoin) query.baseCoin = p.baseCoin;
  if (p.symbol) query.symbol = p.symbol;
  let path: string,
    paged = false;
  switch (p.endpoint) {
    case "account-info":
      path = "/v5/account/info";
      break;
    case "wallet":
      path = "/v5/account/wallet-balance";
      query.accountType = "UNIFIED";
      break;
    case "collateral":
      path = "/v5/account/collateral-info";
      break;
    case "tiers":
      path = "/v5/spot-margin-trade/collateral";
      break;
    case "option-base-discovery":
      path = "/v5/market/option-base-coins";
      break;
    case "settlement-discovery":
      path = "/v5/market/instruments-info";
      query.category = "linear";
      query.limit = "1000";
      paged = true;
      break;
    case "instrument-metadata":
      path = "/v5/market/instruments-info";
      query.category = "option";
      query.limit = "1000";
      paged = true;
      break;
    case "positions":
    case "mode-probe":
      path = "/v5/position/list";
      query.limit = String(policy.positionPageLimit);
      paged = true;
      break;
    case "open-orders":
      path = "/v5/order/realtime";
      query.openOnly = "0";
      query.limit = String(policy.orderPageLimit);
      paged = true;
      break;
    case "order-history":
      path = "/v5/order/history";
      query.limit = String(policy.orderPageLimit);
      paged = true;
      break;
    case "executions":
      path = "/v5/execution/list";
      query.limit = String(policy.executionPageLimit);
      paged = true;
      break;
    default:
      throw new BybitAccountReadError("UNSUPPORTED_CAPABILITY");
  }
  if (p.endpoint === "executions" || p.endpoint === "order-history") {
    if (
      !window ||
      !Number.isSafeInteger(window.from) ||
      !Number.isSafeInteger(window.to) ||
      window.from < 0 ||
      window.to - window.from !== policy.historyWindowMs
    )
      throw new BybitAccountReadError("INVALID_RESPONSE");
    query.startTime = String(window.from);
    query.endTime = String(window.to);
  }
  return { path, query, paged };
}

/** GET-only traversal. No cursors or source envelopes are part of the canonical artifact. */
export class BybitAccountReadClient implements AccountEvidenceReadPort {
  private readonly transport: ReadTransport;
  private readonly clock: () => number;
  private rows = 0;
  constructor(options: { transport: ReadTransport; utcClock?: () => number }) {
    this.transport = options.transport;
    this.clock = options.utcClock ?? Date.now;
  }
  readIdentity(): Promise<AccountReadEnvelope> {
    return this.transport.get("/v5/user/query-api");
  }
  readExchangeTime(): Promise<number> {
    return this.transport.readExchangeTime();
  }
  readOptionInstrument(symbol: string): Promise<AccountReadEnvelope> {
    if (!requireIdentifier(symbol, "symbol").ok)
      throw new BybitAccountReadError("INVALID_RESPONSE");
    return this.transport.get("/v5/market/instruments-info", {
      category: "option",
      symbol,
    });
  }
  async readPartition(
    partition: AccountEvidencePartition,
    window?: AccountReadWindow,
  ): Promise<AccountPartitionRead> {
    const startedAt = utc(this.clock()),
      responses: AccountReadEnvelope[] = [],
      nativeRowTimes: UtcTimestamp[] = [],
      cursors = new Set<string>();
    let pages = 0,
      rows = 0,
      reason: AccountEvidenceFailureCode | undefined;
    try {
      const { path, query, paged } = route(partition, window);
      // A default catalogue omits pre-market linear instruments; both scopes belong to this partition.
      const statuses =
        partition.endpoint === "settlement-discovery"
          ? [undefined, "PreLaunch", "Delivering"]
          : [undefined];
      for (const status of statuses) {
        let cursor = "";
        cursors.clear();
        do {
          if (pages >= policy.maxPagesPerPartition)
            throw new BybitAccountReadError("PAGE_BUDGET_EXCEEDED");
          const response = await this.transport.get(path, {
            ...query,
            ...(status ? { status } : {}),
            ...(cursor ? { cursor } : {}),
          });
          pages++;
          if (response.time === undefined) {
            if (partition.endpoint !== "account-info")
              throw new BybitAccountReadError("INVALID_RESPONSE");
          } else utc(response.time);
          if (
            partition.category &&
            response.result.category !== undefined &&
            response.result.category !== partition.category
          )
            throw new BybitAccountReadError("INVALID_RESPONSE");
          const list = response.result.list;
          if (
            paged &&
            (!Array.isArray(list) || list.some((row) => !isRecord(row)))
          )
            throw new BybitAccountReadError("INVALID_RESPONSE");
          let count = Array.isArray(list) ? list.length : 1;
          if (partition.endpoint === "wallet" && Array.isArray(list))
            count = list.reduce(
              (sum, row) =>
                sum +
                (isRecord(row) && Array.isArray(row.coin)
                  ? Math.max(1, row.coin.length)
                  : 1),
              0,
            );
          if (partition.endpoint === "tiers" && Array.isArray(list))
            count = list.reduce((sum, row) => {
              const tiers = isRecord(row)
                ? (row.collateralRatioList ?? row.tiers)
                : undefined;
              return sum + (Array.isArray(tiers) ? tiers.length : 1);
            }, 0);
          if (this.rows + count > policy.maxRetainedRows)
            throw new BybitAccountReadError("ROW_BUDGET_EXCEEDED");
          this.rows += count;
          rows += count;
          responses.push(response);
          if (Array.isArray(list))
            for (const row of list) {
              if (!isRecord(row)) continue;
              for (const field of ["execTime", "createdTime", "updatedTime"]) {
                const value = row[field];
                if (
                  typeof value === "string" &&
                  /^\d+$/u.test(value) &&
                  Number.isSafeInteger(Number(value))
                )
                  nativeRowTimes.push(utc(Number(value)));
              }
            }
          const next = response.result.nextPageCursor;
          if (paged && typeof next !== "string")
            throw new BybitAccountReadError("INVALID_RESPONSE");
          if (
            next !== undefined &&
            (typeof next !== "string" ||
              next.length > 8192 ||
              /[\u0000-\u001f\u007f]/u.test(next))
          )
            throw new BybitAccountReadError("INVALID_RESPONSE");
          cursor = paged && typeof next === "string" ? next : "";
          if (cursor) {
            if (cursors.has(cursor))
              throw new BybitAccountReadError("INVALID_RESPONSE");
            cursors.add(cursor);
          }
        } while (cursor);
      }
    } catch (error) {
      reason = accountReadFailureCode(error);
    }
    const endedAt = utc(this.clock());
    const responseTimes = responses.flatMap((response) =>
      response.time === undefined ? [] : [response.time],
    );
    const exactTime =
      responseTimes.length === responses.length && responses.length > 0
        ? utc(Math.max(...responseTimes))
        : null;
    return {
      responses,
      coverage: {
        partition,
        status: reason ? "failed" : "traversed",
        pages,
        rows,
        startedAt,
        endedAt,
        reasonCodes: reason ? [reason] : [],
      },
      observation: responses.length
        ? {
            partition,
            startedAt,
            endedAt,
            exchangeResponseTime: exactTime,
            timeProvenance:
              exactTime === null ? "collection-bracket" : "response-envelope",
            nativeRowTimes: [...new Set(nativeRowTimes)].sort(),
          }
        : null,
    };
  }
}
