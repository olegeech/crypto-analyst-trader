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

export type MainnetMeasurementStage = "prepare" | "execute" | "status";
export type MainnetEvidencePath =
  "none" | "compact" | "full" | "compact-to-full";
export type MainnetGetCountsStatus = "available" | "mismatch" | "unavailable";

export interface MainnetInvocationMetrics {
  readonly exchangeStage: MainnetMeasurementStage;
  readonly exchangeStageElapsedMs?: number;
  readonly exchangeEvidencePath?: MainnetEvidencePath;
  readonly compactFallbackReason?: string;
  readonly exchangeGetCountsStatus: MainnetGetCountsStatus;
  readonly exchangeGetCounts?: string;
}

/** Validates the grouped recorder against the independently maintained GET total. */
export function mainnetGetCountsStatus(
  counts: unknown,
  exchangeReads: unknown,
): MainnetGetCountsStatus {
  const safeCounts = safeMainnetGetCounts(counts);
  if (
    safeCounts === undefined ||
    typeof exchangeReads !== "number" ||
    !Number.isSafeInteger(exchangeReads) ||
    exchangeReads < 0
  )
    return "unavailable";
  const total = Object.values(
    JSON.parse(safeCounts) as Record<string, number>,
  ).reduce((sum, count) => sum + count, 0);
  if (!Number.isSafeInteger(total)) return "unavailable";
  return total === exchangeReads ? "available" : "mismatch";
}

export function createMainnetInvocationMetrics<
  Stage extends MainnetMeasurementStage,
>(input: {
  readonly stage: Stage;
  readonly exchangeReads: number;
  readonly exchangeGetCounts: string;
  readonly exchangeStageElapsedMs?: number;
  readonly exchangeEvidencePath?: MainnetEvidencePath;
  readonly compactFallbackReason?: string;
}): MainnetInvocationMetrics & { readonly exchangeStage: Stage } {
  const status = mainnetGetCountsStatus(
    input.exchangeGetCounts,
    input.exchangeReads,
  );
  const elapsed = input.exchangeStageElapsedMs;
  return {
    exchangeStage: input.stage,
    ...(typeof elapsed === "number" && Number.isFinite(elapsed) && elapsed >= 0
      ? { exchangeStageElapsedMs: elapsed }
      : {}),
    ...(input.exchangeEvidencePath === undefined
      ? {}
      : { exchangeEvidencePath: input.exchangeEvidencePath }),
    ...(typeof input.compactFallbackReason === "string" &&
    /^[A-Z][A-Z0-9_]{0,79}$/u.test(input.compactFallbackReason)
      ? { compactFallbackReason: input.compactFallbackReason }
      : {}),
    exchangeGetCountsStatus: status,
    ...(status === "available"
      ? { exchangeGetCounts: safeMainnetGetCounts(input.exchangeGetCounts)! }
      : {}),
  };
}

/** Adds fixed invocation diagnostics to error details without changing admission. */
export function withMainnetInvocationMetrics<T>(
  result: Result<T>,
  exchangeReads: number,
  exchangeWrites: number,
  metrics: MainnetInvocationMetrics,
): Result<T> {
  const counted = withExchangeCounts(
    result,
    exchangeReads,
    exchangeWrites,
    metrics.exchangeGetCounts,
  );
  if (counted.ok) return counted;
  return {
    ok: false,
    error: domainError(counted.error.code, counted.error.message, {
      ...counted.error.details,
      ...metrics,
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
