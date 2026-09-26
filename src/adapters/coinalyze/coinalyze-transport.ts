import { parseCoinalyzeJson } from "./coinalyze-response.js";

export const COINALYZE_API_ORIGIN = "https://api.coinalyze.net";
export const COINALYZE_FUTURE_MARKETS_PATH = "/v1/future-markets";
export const COINALYZE_LIQUIDATION_HISTORY_PATH = "/v1/liquidation-history";
export const COINALYZE_HISTORY_SYMBOL_LIMIT = 20;
export const COINALYZE_HISTORY_MAX_RANGE_SECONDS = 23 * 60 * 60;
export const DEFAULT_COINALYZE_REQUEST_TIMEOUT_MS = 15_000;
export const DEFAULT_COINALYZE_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export type CoinalyzeTransportFailureKind =
  | "invalid-request"
  | "transport-failed"
  | "unauthorized"
  | "rate-limited"
  | "http-failed"
  | "response-too-large"
  | "invalid-response";

export class CoinalyzeTransportError extends Error {
  readonly kind: CoinalyzeTransportFailureKind;
  readonly httpStatus: number | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(
    kind: CoinalyzeTransportFailureKind,
    message: string,
    options: { httpStatus?: number; retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.name = "CoinalyzeTransportError";
    this.kind = kind;
    this.httpStatus = options.httpStatus;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export interface CoinalyzeHistoryRequest {
  readonly symbols: readonly string[];
  readonly from: number;
  readonly to: number;
}

export interface CoinalyzeTransportOptions {
  readonly request?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

function validateApiKey(apiKey: string): void {
  if (
    typeof apiKey !== "string" ||
    apiKey.length === 0 ||
    apiKey.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(apiKey)
  ) {
    throw new CoinalyzeTransportError(
      "invalid-request",
      "Coinalyze API credentials are invalid.",
    );
  }
}

function validateHistoryRequest(request: CoinalyzeHistoryRequest): void {
  if (
    !Array.isArray(request.symbols) ||
    request.symbols.length === 0 ||
    request.symbols.length > COINALYZE_HISTORY_SYMBOL_LIMIT ||
    request.symbols.some(
      (symbol) =>
        typeof symbol !== "string" || !/^[A-Za-z0-9._-]{1,128}$/u.test(symbol),
    ) ||
    new Set(request.symbols).size !== request.symbols.length ||
    !Number.isSafeInteger(request.from) ||
    request.from < 0 ||
    !Number.isSafeInteger(request.to) ||
    request.to < request.from ||
    request.to - request.from > COINALYZE_HISTORY_MAX_RANGE_SECONDS
  ) {
    throw new CoinalyzeTransportError(
      "invalid-request",
      "Coinalyze liquidation-history parameters are invalid.",
    );
  }
}

function retryAfterSeconds(value: string | null): number | undefined {
  if (value === null || !/^\d+$/u.test(value)) return undefined;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : undefined;
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && /^\d+$/u.test(contentLength)) {
    const declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength > maxBytes) {
      throw new CoinalyzeTransportError(
        "response-too-large",
        "Coinalyze response exceeded the configured response budget.",
      );
    }
  }
  if (response.body === null) {
    throw new CoinalyzeTransportError(
      "invalid-response",
      "Coinalyze returned a response without a body.",
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let receivedBytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      receivedBytes += chunk.value.byteLength;
      if (receivedBytes > maxBytes) {
        await reader.cancel();
        throw new CoinalyzeTransportError(
          "response-too-large",
          "Coinalyze response exceeded the configured response budget.",
        );
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (error instanceof CoinalyzeTransportError) throw error;
    throw new CoinalyzeTransportError(
      "invalid-response",
      "Coinalyze response body could not be read as bounded UTF-8.",
    );
  }
  return text;
}

export class CoinalyzeTransport {
  private readonly request: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(options: CoinalyzeTransportOptions = {}) {
    this.request = options.request ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_COINALYZE_REQUEST_TIMEOUT_MS;
    this.maxResponseBytes =
      options.maxResponseBytes ?? DEFAULT_COINALYZE_MAX_RESPONSE_BYTES;
    if (
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 120_000
    ) {
      throw new TypeError("timeoutMs must be between 1 and 120000");
    }
    if (
      !Number.isSafeInteger(this.maxResponseBytes) ||
      this.maxResponseBytes < 1_024 ||
      this.maxResponseBytes > 64 * 1024 * 1024
    ) {
      throw new TypeError("maxResponseBytes must be between 1024 and 67108864");
    }
  }

  async getFutureMarkets(apiKey: string): Promise<unknown> {
    validateApiKey(apiKey);
    return this.get(
      COINALYZE_FUTURE_MARKETS_PATH,
      new URLSearchParams(),
      apiKey,
    );
  }

  async getLiquidationHistory(
    apiKey: string,
    request: CoinalyzeHistoryRequest,
  ): Promise<unknown> {
    validateApiKey(apiKey);
    validateHistoryRequest(request);
    const query = new URLSearchParams({
      symbols: request.symbols.join(","),
      interval: "1hour",
      from: String(request.from),
      to: String(request.to),
      convert_to_usd: "true",
    });
    return this.get(COINALYZE_LIQUIDATION_HISTORY_PATH, query, apiKey);
  }

  private async get(
    path: string,
    query: URLSearchParams,
    apiKey: string,
  ): Promise<unknown> {
    const url = new URL(path, COINALYZE_API_ORIGIN);
    url.search = query.toString();
    let response: Response;
    try {
      response = await this.request(url, {
        method: "GET",
        headers: { Accept: "application/json", api_key: apiKey },
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new CoinalyzeTransportError(
        "transport-failed",
        "Coinalyze public request could not be completed.",
      );
    }

    const responseUrl = response.url === "" ? url.toString() : response.url;
    let responseOrigin: string;
    try {
      responseOrigin = new URL(responseUrl).origin;
    } catch {
      throw new CoinalyzeTransportError(
        "invalid-response",
        "Coinalyze returned an invalid response origin.",
      );
    }
    if (responseOrigin !== COINALYZE_API_ORIGIN) {
      throw new CoinalyzeTransportError(
        "invalid-response",
        "Coinalyze response came from a non-canonical origin.",
      );
    }
    if (!response.ok) {
      if (response.status === 401) {
        throw new CoinalyzeTransportError(
          "unauthorized",
          "Coinalyze rejected the configured API key.",
          { httpStatus: 401 },
        );
      }
      if (response.status === 429) {
        const retryAfter = retryAfterSeconds(
          response.headers.get("retry-after"),
        );
        throw new CoinalyzeTransportError(
          "rate-limited",
          "Coinalyze rate-limited the request.",
          {
            httpStatus: 429,
            ...(retryAfter === undefined
              ? {}
              : { retryAfterSeconds: retryAfter }),
          },
        );
      }
      throw new CoinalyzeTransportError(
        "http-failed",
        `Coinalyze returned HTTP ${response.status}.`,
        { httpStatus: response.status },
      );
    }

    const body = await readBoundedBody(response, this.maxResponseBytes);
    try {
      return parseCoinalyzeJson(body);
    } catch {
      throw new CoinalyzeTransportError(
        "invalid-response",
        "Coinalyze returned malformed JSON.",
      );
    }
  }
}
