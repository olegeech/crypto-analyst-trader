import {
  responseServerTimeMs,
  type BybitPublicResponse,
  validateBybitPublicResponse,
} from "./public-response.js";

export const BYBIT_PUBLIC_ORIGIN = "https://api.bybit.com";
export const BYBIT_PUBLIC_TIME_PATH = "/v5/market/time";
export const DEFAULT_PUBLIC_REQUEST_TIMEOUT_MS = 10_000;

type HttpMethod = "GET";

export type PublicQueryInput =
  | string
  | URLSearchParams
  | Record<string, string>
  | readonly (readonly [string, string])[];

export type PublicTransportFailureKind =
  | "rate-limited"
  | "transport-failed"
  | "invalid-request"
  | "invalid-response"
  | "exchange-failure";

export class BybitPublicTransportError extends Error {
  readonly kind: PublicTransportFailureKind;
  readonly retCode: number | undefined;
  readonly httpStatus: number | undefined;

  constructor(
    kind: PublicTransportFailureKind,
    message: string,
    options: { retCode?: number; httpStatus?: number } = {},
  ) {
    super(message);
    this.name = "BybitPublicTransportError";
    this.kind = kind;
    this.retCode = options.retCode;
    this.httpStatus = options.httpStatus;
  }
}

export interface BybitPublicTransportOptions {
  readonly request?: typeof fetch;
  readonly timeoutMs?: number;
}

function queryString(input: PublicQueryInput | undefined): string {
  if (input === undefined) return "";
  if (typeof input === "string") return input.replace(/^\?/u, "");
  if (input instanceof URLSearchParams) return input.toString();
  const params = new URLSearchParams();
  if (Array.isArray(input)) {
    for (const [key, value] of input) params.append(key, value);
  } else {
    for (const [key, value] of Object.entries(input)) params.append(key, value);
  }
  return params.toString();
}

function requestUrl(path: string, query: string): string {
  if (!path.startsWith("/") || path.includes("//") || path.includes("#")) {
    throw new BybitPublicTransportError(
      "invalid-request",
      "The Bybit public endpoint path is invalid.",
    );
  }
  const url = new URL(path, BYBIT_PUBLIC_ORIGIN);
  if (url.origin !== BYBIT_PUBLIC_ORIGIN) {
    throw new BybitPublicTransportError(
      "invalid-request",
      "The public market adapter accepts only the canonical Bybit origin.",
    );
  }
  if (query) url.search = query;
  return url.toString();
}

function classifyRetCode(retCode: number): PublicTransportFailureKind {
  return retCode === 10006 ? "rate-limited" : "exchange-failure";
}

function errorForResponse(
  response: BybitPublicResponse,
): BybitPublicTransportError | null {
  if (response.retCode === 0) return null;
  return new BybitPublicTransportError(
    classifyRetCode(response.retCode),
    response.retCode === 10006
      ? "Bybit public API rate-limited the request."
      : "Bybit public API returned an unsuccessful response.",
    { retCode: response.retCode },
  );
}

export class BybitPublicTransport {
  private readonly request: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: BybitPublicTransportOptions = {}) {
    this.request = options.request ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_PUBLIC_REQUEST_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 120_000
    ) {
      throw new TypeError(
        "timeoutMs must be a safe integer between 1 and 120000",
      );
    }
  }

  async get(
    path: string,
    query?: PublicQueryInput,
  ): Promise<BybitPublicResponse> {
    return this.send("GET", path, queryString(query));
  }

  async getExchangeTime(): Promise<number> {
    const response = await this.get(BYBIT_PUBLIC_TIME_PATH);
    const epoch = responseServerTimeMs(response);
    if (epoch === undefined || epoch <= 0) {
      throw new BybitPublicTransportError(
        "invalid-response",
        "Bybit public time response did not contain a valid exchange timestamp.",
      );
    }
    return epoch;
  }

  private async send(
    method: HttpMethod,
    path: string,
    query: string,
  ): Promise<BybitPublicResponse> {
    const url = requestUrl(path, query);
    let response: Response;
    try {
      response = await this.request(url, {
        method,
        headers: { Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new BybitPublicTransportError(
        "transport-failed",
        "The Bybit public request could not be completed.",
      );
    }
    const finalUrl = response.url === "" ? url : response.url;
    let finalOrigin: string;
    try {
      finalOrigin = new URL(finalUrl).origin;
    } catch {
      throw new BybitPublicTransportError(
        "invalid-response",
        "Bybit public API returned an invalid response URL.",
      );
    }
    if (finalOrigin !== BYBIT_PUBLIC_ORIGIN) {
      throw new BybitPublicTransportError(
        "invalid-response",
        "Bybit public API returned a response from a non-canonical origin.",
      );
    }
    if (!response.ok) {
      throw new BybitPublicTransportError(
        response.status === 429 ? "rate-limited" : "transport-failed",
        response.status === 429
          ? "Bybit public API rate-limited the request."
          : `Bybit public API returned HTTP ${response.status}.`,
        { httpStatus: response.status },
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new BybitPublicTransportError(
        "invalid-response",
        "Bybit public API returned a non-JSON response.",
      );
    }
    let validated: BybitPublicResponse;
    try {
      validated = validateBybitPublicResponse(payload);
    } catch {
      throw new BybitPublicTransportError(
        "invalid-response",
        "Bybit public API returned an invalid response envelope.",
      );
    }
    const failure = errorForResponse(validated);
    if (failure) throw failure;
    return validated;
  }
}

export function createBybitPublicTransport(
  options: BybitPublicTransportOptions = {},
): BybitPublicTransport {
  return new BybitPublicTransport(options);
}
