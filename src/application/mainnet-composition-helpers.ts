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
): Result<T> {
  if (result.ok) return result;
  return {
    ok: false,
    error: domainError(result.error.code, result.error.message, {
      ...result.error.details,
      exchangeReads,
      exchangeWrites,
    }),
  };
}
