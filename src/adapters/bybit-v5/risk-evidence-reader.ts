import {
  ACCOUNT_READ_ORIGINS,
  BybitAccountReadError,
  BybitAccountReadTransport,
} from "./account-read-transport.js";
import { BybitAccountReadClient } from "./account-read-client.js";
import { mapAccountPositions } from "./account-read-mappers.js";
import type {
  PortfolioRiskEvidenceReadPort,
  PortfolioRiskEvidenceReaderFactoryInput,
} from "../../ports/portfolio-risk-evidence.js";
import { timestampFromEpochMs } from "../../domain/shared/time.js";
import { requireIdentifier } from "../../domain/shared/validation.js";

const READER_BUDGET_MS = 10_000;
const MAX_HTTP_ATTEMPTS = 8;
const MAX_RESPONSE_BYTES = 262_144;

/**
 * A deliberately narrow GET-only adapter for #17's optional target leverage
 * read. The selected environment is pinned by the existing account transport.
 */
export function createBybitRiskEvidenceReader(
  options: PortfolioRiskEvidenceReaderFactoryInput & {
    readonly request?: typeof fetch;
    readonly utcClock?: () => number;
    readonly monotonicClock?: () => number;
  },
): PortfolioRiskEvidenceReadPort {
  const monotonicClock = options.monotonicClock ?? (() => performance.now());
  const budget = {
    deadline: monotonicClock() + READER_BUDGET_MS,
    attempts: 0,
    maxAttempts: MAX_HTTP_ATTEMPTS,
    maxResponseBytes: MAX_RESPONSE_BYTES,
    maxObservedResponseBytes: 0,
  };
  const transport = new BybitAccountReadTransport({
    environment: options.environment,
    credentials: options.credentials,
    budget,
    ...(options.request ? { request: options.request } : {}),
    ...(options.utcClock ? { clock: options.utcClock } : {}),
    monotonicClock,
  });
  const client = new BybitAccountReadClient({
    transport,
    ...(options.utcClock ? { utcClock: options.utcClock } : {}),
  });

  return Object.freeze({
    environment: options.environment,
    origin: ACCOUNT_READ_ORIGINS[options.environment],
    readIdentity: () => client.readIdentity(),
    async readTargetPositions(symbol: string) {
      if (!requireIdentifier(symbol, "symbol").ok)
        throw new BybitAccountReadError("INVALID_RESPONSE");
      const result = await client.readPartition({
        endpoint: "positions",
        pass: "B",
        category: "linear",
        settleCoin: null,
        baseCoin: null,
        symbol,
      });
      if (result.coverage.status !== "traversed")
        throw new BybitAccountReadError(
          result.coverage.reasonCodes[0] ?? "COVERAGE_INCOMPLETE",
        );
      if (
        !result.observation ||
        result.observation.timeProvenance !== "response-envelope" ||
        result.observation.exchangeResponseTime === null
      )
        throw new BybitAccountReadError("INVALID_RESPONSE");
      const rows = result.responses.flatMap((response) =>
        mapAccountPositions(response, "linear"),
      );
      if (
        rows.some((row) => row.category !== "linear" || row.symbol !== symbol)
      )
        throw new BybitAccountReadError("INVALID_RESPONSE");
      return Object.freeze({
        rows: Object.freeze(rows),
        observedAt: result.observation.exchangeResponseTime,
      });
    },
    async readExchangeTime() {
      const time = await client.readExchangeTime();
      const parsed = timestampFromEpochMs(time);
      if (!parsed.ok) throw new BybitAccountReadError("INVALID_RESPONSE");
      return parsed.value;
    },
    requestCount: () => budget.attempts,
  });
}
