import { domainError } from "../domain/shared/errors.js";
import { type Result } from "../domain/shared/result.js";
import type { ExchangeCredentials } from "../ports/credential-provider.js";

export function snapshotExchangeCredentials(
  credentials: ExchangeCredentials,
): Readonly<ExchangeCredentials> {
  return Object.freeze({
    apiKey: credentials.apiKey,
    apiSecret: credentials.apiSecret,
    accountId: credentials.accountId,
  });
}

export function withExchangeCounts<T>(
  result: Result<T>,
  exchangeReads: number,
  exchangeWrites: number,
  exchangeGetCounts?: string,
): Result<T> {
  if (result.ok) return result;
  return {
    ok: false,
    error: domainError(result.error.code, result.error.message, {
      ...result.error.details,
      exchangeReads,
      exchangeWrites,
      ...(exchangeGetCounts === undefined ? {} : { exchangeGetCounts }),
    }),
  };
}

const MAINNET_GET_GROUPS: Readonly<Record<string, string>> = {
  "/v5/market/time": "time",
  "/v5/user/query-api": "identity",
  "/v5/account/info": "account",
  "/v5/account/wallet-balance": "wallet",
  "/v5/account/collateral-info": "collateral",
  "/v5/spot-margin-trade/collateral": "collateral-tiers",
  "/v5/position/list": "positions",
  "/v5/order/realtime": "open-orders",
  "/v5/order/history": "order-history",
  "/v5/execution/list": "executions",
  "/v5/market/instruments-info": "instruments",
  "/v5/market/option-base-coins": "option-discovery",
  "/v5/market/tickers": "quote",
  "/v5/account/fee-rate": "fees",
};

/** Counts existing GET attempts only; never retains URLs, query strings or headers. */
export function createMainnetGetCounts() {
  const counts: Record<string, number> = {};
  return {
    record(input: Parameters<typeof fetch>[0], init?: RequestInit): void {
      const method = (
        init?.method ?? (input instanceof Request ? input.method : "GET")
      ).toUpperCase();
      if (method !== "GET") return;
      let group = "other";
      try {
        group =
          MAINNET_GET_GROUPS[
            new URL(input instanceof Request ? input.url : String(input))
              .pathname
          ] ?? "other";
      } catch {
        /* Keep counting malformed request attempts without retaining input. */
      }
      counts[group] = (counts[group] ?? 0) + 1;
    },
    summary(): string {
      return JSON.stringify(
        Object.fromEntries(
          Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)),
        ),
      );
    },
  };
}

export function safeMainnetGetCounts(input: unknown): string | undefined {
  if (typeof input !== "string" || input.length > 2048) return undefined;
  try {
    const value: unknown = JSON.parse(input);
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return undefined;
    const entries = Object.entries(value);
    const groups = [...Object.values(MAINNET_GET_GROUPS), "other"];
    if (
      entries.some(
        ([key, count]) =>
          !groups.includes(key) ||
          typeof count !== "number" ||
          !Number.isSafeInteger(count) ||
          count < 0,
      )
    )
      return undefined;
    return JSON.stringify(
      Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b))),
    );
  } catch {
    return undefined;
  }
}
