import type { LiquidationEvidenceDiagnosticInput } from "../../domain/liquidation/liquidation-evidence-bundle.js";
import {
  mapCoinalyzeFutureMarkets,
  mapCoinalyzeLiquidationHistory,
  type CoinalyzeCatalogueMapping,
  type CoinalyzeHistoryMapping,
} from "./coinalyze-mappers.js";
import {
  CoinalyzeTransport,
  CoinalyzeTransportError,
  type CoinalyzeHistoryRequest,
} from "./coinalyze-transport.js";
import {
  COINALYZE_HISTORY_MAX_RANGE_SECONDS,
  COINALYZE_HISTORY_SYMBOL_LIMIT,
} from "./coinalyze-transport.js";

export const COINALYZE_API_CALLS_PER_MINUTE = 40;
export const COINALYZE_RATE_WINDOW_MS = 60_000;
export const DEFAULT_COINALYZE_MAX_RATE_WAIT_MS = 5 * 60_000;
const MAX_RETRY_AFTER_MS = 60_000;
const MAX_RATE_LIMIT_RETRIES = 1;

export interface CoinalyzeTransportPort {
  getFutureMarkets(apiKey: string): Promise<unknown>;
  getLiquidationHistory(
    apiKey: string,
    request: CoinalyzeHistoryRequest,
  ): Promise<unknown>;
}

export interface CoinalyzeClientOptions {
  readonly transport?: CoinalyzeTransportPort;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly maxRateWaitMs?: number;
}

interface WaitBudget {
  spentMs: number;
}

interface QuotaCharge {
  readonly at: number;
  readonly calls: number;
}

function diagnostic(
  code: LiquidationEvidenceDiagnosticInput["code"],
  operation: LiquidationEvidenceDiagnosticInput["operation"],
  providerSymbol?: string,
): LiquidationEvidenceDiagnosticInput {
  return Object.freeze({
    code,
    operation,
    ...(providerSymbol === undefined ? {} : { providerSymbol }),
  });
}

function typedTransportError(error: unknown): CoinalyzeTransportError {
  return error instanceof CoinalyzeTransportError
    ? error
    : new CoinalyzeTransportError(
        "transport-failed",
        "Coinalyze public request could not be completed.",
      );
}

function catalogueFailureDiagnostic(
  error: CoinalyzeTransportError,
): LiquidationEvidenceDiagnosticInput {
  if (error.kind === "rate-limited") {
    return diagnostic("rate-limited", "discover-markets");
  }
  if (error.kind === "response-too-large") {
    return diagnostic("response-budget-exhausted", "discover-markets");
  }
  return diagnostic("catalogue-unavailable", "discover-markets");
}

function historyFailureCode(
  error: CoinalyzeTransportError,
): LiquidationEvidenceDiagnosticInput["code"] {
  switch (error.kind) {
    case "rate-limited":
      return "rate-limited";
    case "response-too-large":
      return "response-budget-exhausted";
    case "invalid-response":
      return "invalid-observation";
    default:
      return "history-unavailable";
  }
}

function emptyHistory(symbol: string) {
  return Object.freeze({ symbol, observations: Object.freeze([]) });
}

function sleepDefault(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class CoinalyzeClient {
  private readonly transport: CoinalyzeTransportPort;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly maxRateWaitMs: number;
  private readonly quotaCharges: QuotaCharge[] = [];

  constructor(options: CoinalyzeClientOptions = {}) {
    this.transport = options.transport ?? new CoinalyzeTransport();
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? sleepDefault;
    this.maxRateWaitMs =
      options.maxRateWaitMs ?? DEFAULT_COINALYZE_MAX_RATE_WAIT_MS;
    if (
      !Number.isSafeInteger(this.maxRateWaitMs) ||
      this.maxRateWaitMs < 0 ||
      this.maxRateWaitMs > 15 * 60_000
    ) {
      throw new TypeError("maxRateWaitMs must be between 0 and 900000");
    }
  }

  async fetchFutureMarkets(apiKey: string): Promise<CoinalyzeCatalogueMapping> {
    const budget: WaitBudget = { spentMs: 0 };
    try {
      const payload = await this.requestWithLimit(1, budget, () =>
        this.transport.getFutureMarkets(apiKey),
      );
      return mapCoinalyzeFutureMarkets(payload);
    } catch (error) {
      const transportError = typedTransportError(error);
      return Object.freeze({
        markets: Object.freeze([]),
        complete: false,
        diagnostics: Object.freeze([
          catalogueFailureDiagnostic(transportError),
        ]),
      });
    }
  }

  async fetchLiquidationHistory(
    apiKey: string,
    symbols: readonly string[],
    from: number,
    to: number,
  ): Promise<CoinalyzeHistoryMapping> {
    if (
      symbols.length === 0 ||
      new Set(symbols).size !== symbols.length ||
      !Number.isSafeInteger(from) ||
      !Number.isSafeInteger(to) ||
      from < 0 ||
      to < from ||
      to - from > COINALYZE_HISTORY_MAX_RANGE_SECONDS
    ) {
      return mapCoinalyzeLiquidationHistory(null, [], from, to);
    }

    const budget: WaitBudget = { spentMs: 0 };
    const histories = new Map<
      string,
      CoinalyzeHistoryMapping["histories"][number]
    >();
    const diagnostics: LiquidationEvidenceDiagnosticInput[] = [];
    let responseValid = true;
    const batches: string[][] = [];
    for (
      let offset = 0;
      offset < symbols.length;
      offset += COINALYZE_HISTORY_SYMBOL_LIMIT
    ) {
      batches.push(
        symbols.slice(offset, offset + COINALYZE_HISTORY_SYMBOL_LIMIT),
      );
    }

    for (let index = 0; index < batches.length; index += 1) {
      const batch = batches[index];
      if (batch === undefined) continue;
      let payload: unknown;
      try {
        payload = await this.requestWithLimit(batch.length, budget, () =>
          this.transport.getLiquidationHistory(apiKey, {
            symbols: batch,
            from,
            to,
          }),
        );
      } catch (error) {
        const transportError = typedTransportError(error);
        responseValid = false;
        diagnostics.push(
          diagnostic(
            historyFailureCode(transportError),
            "fetch-liquidation-history",
          ),
        );
        for (const symbol of batch) histories.set(symbol, emptyHistory(symbol));
        if (
          transportError.kind === "rate-limited" ||
          transportError.kind === "unauthorized"
        ) {
          for (const remainingBatch of batches.slice(index + 1)) {
            for (const symbol of remainingBatch ?? []) {
              histories.set(symbol, emptyHistory(symbol));
            }
          }
          break;
        }
        continue;
      }

      const mapped = mapCoinalyzeLiquidationHistory(payload, batch, from, to);
      responseValid &&= mapped.responseValid;
      diagnostics.push(...mapped.diagnostics);
      for (const history of mapped.histories) {
        histories.set(history.symbol, history);
      }
    }

    const orderedHistories = symbols.map(
      (symbol) => histories.get(symbol) ?? emptyHistory(symbol),
    );
    return Object.freeze({
      histories: Object.freeze(orderedHistories),
      responseValid,
      diagnostics: Object.freeze(diagnostics),
    });
  }

  private async requestWithLimit<T>(
    cost: number,
    budget: WaitBudget,
    request: () => Promise<T>,
  ): Promise<T> {
    let rateLimitRetries = 0;
    while (true) {
      await this.acquireQuota(cost, budget);
      try {
        return await request();
      } catch (error) {
        const transportError = typedTransportError(error);
        const retryAfterMs =
          transportError.retryAfterSeconds === undefined
            ? undefined
            : transportError.retryAfterSeconds * 1_000;
        if (
          transportError.kind !== "rate-limited" ||
          rateLimitRetries >= MAX_RATE_LIMIT_RETRIES ||
          retryAfterMs === undefined ||
          retryAfterMs > MAX_RETRY_AFTER_MS ||
          budget.spentMs + retryAfterMs > this.maxRateWaitMs
        ) {
          throw transportError;
        }
        await this.sleep(retryAfterMs);
        budget.spentMs += retryAfterMs;
        rateLimitRetries += 1;
      }
    }
  }

  private async acquireQuota(cost: number, budget: WaitBudget): Promise<void> {
    if (
      !Number.isSafeInteger(cost) ||
      cost < 1 ||
      cost > COINALYZE_API_CALLS_PER_MINUTE
    ) {
      throw new CoinalyzeTransportError(
        "invalid-request",
        "Coinalyze request cost exceeds its API quota.",
      );
    }
    while (true) {
      const now = this.now();
      while (
        this.quotaCharges[0] !== undefined &&
        now - this.quotaCharges[0].at >= COINALYZE_RATE_WINDOW_MS
      ) {
        this.quotaCharges.shift();
      }
      const usedCalls = this.quotaCharges.reduce(
        (sum, charge) => sum + charge.calls,
        0,
      );
      if (usedCalls + cost <= COINALYZE_API_CALLS_PER_MINUTE) {
        this.quotaCharges.push({ at: now, calls: cost });
        return;
      }
      const oldest = this.quotaCharges[0];
      if (oldest === undefined) return;
      const waitMs = Math.max(1, oldest.at + COINALYZE_RATE_WINDOW_MS - now);
      if (budget.spentMs + waitMs > this.maxRateWaitMs) {
        throw new CoinalyzeTransportError(
          "rate-limited",
          "Coinalyze request quota exceeds the bounded collection wait.",
        );
      }
      await this.sleep(waitMs);
      budget.spentMs += waitMs;
    }
  }
}
