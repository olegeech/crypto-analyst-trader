import type {
  ExchangeCredentials,
  CredentialEnvironment,
} from "../../ports/credential-provider.js";
import { buildSignaturePayload, hmacSha256 } from "./request-signing.js";
import { classifyRetCode } from "./response-errors.js";
import {
  validateBybitPublicResponse,
  responseServerTimeMs,
} from "./public-response.js";
import type { AccountEvidenceFailureCode } from "../../domain/account/account-evidence-diagnostics.js";

export const ACCOUNT_READ_ORIGINS = Object.freeze({
  demo: "https://api-demo.bybit.com",
  testnet: "https://api-testnet.bybit.com",
  mainnet: "https://api.bybit.com",
});
const PUBLIC_PATHS = new Set([
  "/v5/market/time",
  "/v5/market/instruments-info",
  "/v5/market/option-base-coins",
  "/v5/spot-margin-trade/collateral",
]);
const PRIVATE_PATHS = new Set([
  "/v5/user/query-api",
  "/v5/account/info",
  "/v5/account/wallet-balance",
  "/v5/account/collateral-info",
  "/v5/position/list",
  "/v5/order/realtime",
  "/v5/order/history",
  "/v5/execution/list",
]);

export class BybitAccountReadError extends Error {
  constructor(
    readonly code: AccountEvidenceFailureCode,
    readonly httpStatus?: number,
    readonly retCode?: number,
    readonly retryAfterMs?: number,
  ) {
    super(code);
    this.name = "BybitAccountReadError";
  }
}
/** Mutable invocation-local counters are shared by every request/page/retry. */
export interface AccountReadBudget {
  deadline: number;
  attempts: number;
  maxAttempts: number;
  maxResponseBytes: number;
  maxObservedResponseBytes: number;
}
export interface AccountReadResponse {
  readonly result: Record<string, unknown>;
  readonly time: number;
}
export interface BybitAccountReadTransportOptions {
  readonly environment: CredentialEnvironment;
  readonly credentials: ExchangeCredentials;
  readonly budget: AccountReadBudget;
  readonly request?: typeof fetch;
  readonly clock?: () => number;
  readonly monotonicClock?: () => number;
  readonly clockOffsetMs?: number;
  readonly timeoutMs?: number;
}

function safeRetCode(code: number): AccountEvidenceFailureCode {
  switch (classifyRetCode(code).kind) {
    case "clock-skew":
      return "TIMESTAMP_SKEW";
    case "permission-denied":
      return "READ_PERMISSION_DENIED";
    case "rate-limited":
      return "RATE_LIMITED";
    case "invalid-credentials":
    case "expired-credentials":
    case "signing-defect":
    case "ip-restriction":
      return "AUTHENTICATION_FAILED";
    case "ambiguous-server":
      return "TRANSPORT_FAILED";
    case "validation-failed":
      return "UNSUPPORTED_CAPABILITY";
    default:
      return "INVALID_RESPONSE";
  }
}
function httpFailureCode(status: number): AccountEvidenceFailureCode {
  if (status === 429) return "RATE_LIMITED";
  if (status === 401) return "AUTHENTICATION_FAILED";
  if (status === 403) return "READ_PERMISSION_DENIED";
  if (status >= 500) return "TRANSPORT_FAILED";
  return "UNSUPPORTED_CAPABILITY";
}
async function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw signal.reason;
  let listener: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    listener = () => reject(signal.reason);
    signal.addEventListener("abort", listener, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", listener);
  }
}

/** No caller-selected method, origin, headers, body or redirect policy exists. */
export class BybitAccountReadTransport {
  readonly environment: CredentialEnvironment;
  readonly origin: string;
  readonly #credentials: Readonly<ExchangeCredentials>;
  private readonly request: typeof fetch;
  private readonly clock: () => number;
  private readonly monotonicClock: () => number;
  private readonly timeoutMs: number;
  private readonly budget: AccountReadBudget;
  private offset: number | undefined;
  private lastMonotonic = -Infinity;
  constructor(options: BybitAccountReadTransportOptions) {
    if (!options || !Object.hasOwn(ACCOUNT_READ_ORIGINS, options.environment))
      throw new BybitAccountReadError("ORIGIN_MISMATCH");
    const { credentials, budget } = options;
    if (
      !credentials ||
      [credentials.apiKey, credentials.apiSecret, credentials.accountId].some(
        (v) =>
          typeof v !== "string" ||
          !v ||
          v.length > 1024 ||
          /[\u0000-\u001f\u007f]/u.test(v),
      )
    )
      throw new BybitAccountReadError("AUTHENTICATION_FAILED");
    if (
      !budget ||
      !Number.isFinite(budget.deadline) ||
      ![
        budget.attempts,
        budget.maxAttempts,
        budget.maxResponseBytes,
        budget.maxObservedResponseBytes,
      ].every((v) => Number.isSafeInteger(v) && v >= 0) ||
      budget.maxAttempts < 1 ||
      budget.maxResponseBytes < 1
    )
      throw new BybitAccountReadError("INVALID_RESPONSE");
    this.environment = options.environment;
    this.origin = ACCOUNT_READ_ORIGINS[this.environment];
    this.#credentials = Object.freeze({ ...credentials });
    this.budget = budget;
    this.request = options.request ?? fetch;
    this.clock = options.clock ?? Date.now;
    this.monotonicClock = options.monotonicClock ?? (() => performance.now());
    this.offset = options.clockOffsetMs;
    this.timeoutMs = options.timeoutMs ?? 10000;
    if (
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 30000 ||
      (this.offset !== undefined && !Number.isFinite(this.offset))
    )
      throw new BybitAccountReadError("INVALID_RESPONSE");
  }
  async readExchangeTime(): Promise<number> {
    const response = await this.get("/v5/market/time");
    const time = responseServerTimeMs({
      retCode: 0,
      retMsg: "",
      result:
        response.result.timeNano === undefined
          ? response.result
          : { timeNano: response.result.timeNano },
      time: response.time,
    });
    if (time === undefined || !Number.isSafeInteger(time) || time <= 0)
      throw new BybitAccountReadError("INVALID_RESPONSE");
    return time;
  }
  async get(
    path: string,
    query: Readonly<Record<string, string>> = {},
  ): Promise<AccountReadResponse> {
    if (!PUBLIC_PATHS.has(path) && !PRIVATE_PATHS.has(path))
      throw new BybitAccountReadError("UNSUPPORTED_CAPABILITY");
    if (
      !query ||
      Object.values(query).some(
        (v) =>
          typeof v !== "string" ||
          v.length > 8192 ||
          /[\u0000-\u001f\u007f]/u.test(v),
      ) ||
      Object.keys(query).some(
        (k) =>
          !/^[A-Za-z][A-Za-z0-9]*$/u.test(k) ||
          /key|secret|sign|token/iu.test(k),
      )
    )
      throw new BybitAccountReadError("INVALID_RESPONSE");
    if (PRIVATE_PATHS.has(path) && this.offset === undefined) {
      const before = this.clock();
      const server = await this.readExchangeTime();
      const after = this.clock();
      this.offset = server - Math.round((before + after) / 2);
    }
    const url = new URL(path, this.origin);
    url.search = new URLSearchParams(query).toString();
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.send(url, PUBLIC_PATHS.has(path));
      } catch (error) {
        if (!(error instanceof BybitAccountReadError))
          throw new BybitAccountReadError("TRANSPORT_FAILED");
        const retryable =
          error.code === "TRANSPORT_FAILED" ||
          (error.code === "RATE_LIMITED" && error.retryAfterMs !== undefined);
        if (attempt > 0 || !retryable) throw error;
        const delay = error.retryAfterMs ?? 0;
        if (
          this.remaining() <= delay ||
          this.budget.attempts >= this.budget.maxAttempts
        )
          throw error;
        if (delay > 0)
          await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw new BybitAccountReadError("TRANSPORT_FAILED");
  }
  private remaining(): number {
    const now = this.monotonicClock();
    if (!Number.isFinite(now) || now < this.lastMonotonic)
      throw new BybitAccountReadError("COLLECTION_DEADLINE_EXCEEDED");
    this.lastMonotonic = now;
    return this.budget.deadline - now;
  }
  private async send(
    url: URL,
    unsigned: boolean,
  ): Promise<AccountReadResponse> {
    const remaining = this.remaining();
    if (remaining <= 0)
      throw new BybitAccountReadError("COLLECTION_DEADLINE_EXCEEDED");
    if (this.budget.attempts >= this.budget.maxAttempts)
      throw new BybitAccountReadError("ATTEMPT_BUDGET_EXCEEDED");
    this.budget.attempts++;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (!unsigned) {
      const timestamp = String(Math.trunc(this.clock() + (this.offset ?? 0)));
      if (!/^\d+$/u.test(timestamp) || !Number.isSafeInteger(Number(timestamp)))
        throw new BybitAccountReadError("TIMESTAMP_SKEW");
      Object.assign(headers, {
        "X-BAPI-API-KEY": this.#credentials.apiKey,
        "X-BAPI-TIMESTAMP": timestamp,
        "X-BAPI-RECV-WINDOW": "5000",
        "X-BAPI-SIGN-TYPE": "2",
        "X-BAPI-SIGN": hmacSha256(
          buildSignaturePayload(
            timestamp,
            this.#credentials.apiKey,
            "5000",
            url.search.slice(1),
          ),
          this.#credentials.apiSecret,
        ),
      });
    }
    const controller = new AbortController();
    const wait = Math.min(remaining, this.timeoutMs);
    const timer = setTimeout(
      () =>
        controller.abort(
          new BybitAccountReadError(
            remaining <= this.timeoutMs
              ? "COLLECTION_DEADLINE_EXCEEDED"
              : "TRANSPORT_FAILED",
          ),
        ),
      Math.max(1, Math.ceil(wait)),
    );
    let response: Response | undefined;
    try {
      response = await abortable(
        this.request(url, {
          method: "GET",
          headers,
          redirect: "error",
          signal: controller.signal,
        }),
        controller.signal,
      );
      let origin: string;
      try {
        origin = new URL(response.url || url.toString()).origin;
      } catch {
        throw new BybitAccountReadError("ORIGIN_MISMATCH");
      }
      if (
        origin !== this.origin ||
        response.redirected ||
        (response.status >= 300 && response.status < 400)
      )
        throw new BybitAccountReadError("ORIGIN_MISMATCH");
      if (!response.ok) {
        const retry = response.headers.get("retry-after");
        const seconds =
          retry !== null && /^\d+$/u.test(retry) ? Number(retry) : undefined;
        const delay =
          seconds !== undefined &&
          Number.isSafeInteger(seconds) &&
          seconds <= 30000
            ? seconds * 1000
            : undefined;
        throw new BybitAccountReadError(
          httpFailureCode(response.status),
          response.status,
          undefined,
          delay,
        );
      }
      const text = await this.readBody(response, controller.signal);
      let parsed;
      try {
        parsed = validateBybitPublicResponse(JSON.parse(text));
      } catch {
        throw new BybitAccountReadError("INVALID_RESPONSE");
      }
      if (parsed.retCode !== 0)
        throw new BybitAccountReadError(
          safeRetCode(parsed.retCode),
          undefined,
          parsed.retCode,
        );
      if (
        parsed.time === undefined ||
        !Number.isSafeInteger(parsed.time) ||
        parsed.time <= 0
      )
        throw new BybitAccountReadError("INVALID_RESPONSE");
      return { result: parsed.result, time: parsed.time };
    } catch (error) {
      if (error instanceof BybitAccountReadError) throw error;
      if (controller.signal.aborted) throw controller.signal.reason;
      throw new BybitAccountReadError("TRANSPORT_FAILED");
    } finally {
      clearTimeout(timer);
      if (response?.body && !response.body.locked)
        void response.body.cancel().catch(() => {});
    }
  }
  private async readBody(
    response: Response,
    signal: AbortSignal,
  ): Promise<string> {
    const declared = response.headers.get("content-length");
    if (
      declared !== null &&
      (!/^\d+$/u.test(declared) ||
        Number(declared) > this.budget.maxResponseBytes)
    )
      throw new BybitAccountReadError("RESPONSE_BYTE_LIMIT_EXCEEDED");
    if (!response.body) throw new BybitAccountReadError("INVALID_RESPONSE");
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0,
      text = "";
    try {
      while (true) {
        const chunk = await abortable(reader.read(), signal);
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        this.budget.maxObservedResponseBytes = Math.max(
          this.budget.maxObservedResponseBytes,
          bytes,
        );
        if (bytes > this.budget.maxResponseBytes)
          throw new BybitAccountReadError("RESPONSE_BYTE_LIMIT_EXCEEDED");
        text += decoder.decode(chunk.value, { stream: true });
      }
      return text + decoder.decode();
    } catch (error) {
      void reader.cancel().catch(() => {});
      if (error instanceof BybitAccountReadError) throw error;
      throw new BybitAccountReadError("INVALID_RESPONSE");
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* A cancelled pending read releases with its promise. */
      }
    }
  }
}
export function createBybitAccountReadTransport(
  options: BybitAccountReadTransportOptions,
): BybitAccountReadTransport {
  return new BybitAccountReadTransport(options);
}
