import { buildSignaturePayload, hmacSha256 } from "./request-signing.js";
import {
  classifyRetCode,
  type TransportFailureKind,
} from "./response-errors.js";
export {
  classifyRetCode,
  type TransportFailureKind,
  type RetCodeClassification,
} from "./response-errors.js";

export { buildSignaturePayload, hmacSha256 } from "./request-signing.js";

import type { ExchangeCredentials } from "../../ports/credential-provider.js";
import { BYBIT_CANONICAL_ORIGINS } from "./origins.js";
export {
  BYBIT_CANONICAL_ORIGINS,
  BYBIT_DEMO_ORIGIN,
  BYBIT_MAINNET_ORIGIN,
} from "./origins.js";

export const BYBIT_TIME_PATH = "/v5/market/time";
export const BYBIT_DEMO_TIME_PATH = BYBIT_TIME_PATH;
export const DEFAULT_RECV_WINDOW = "5000";
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

type JsonObject = Record<string, unknown>;
type HttpMethod = "GET" | "POST";
export type BybitPrivateEnvironment = "demo" | "mainnet";

export interface BybitResponse {
  readonly retCode: number;
  readonly retMsg: string;
  readonly result: JsonObject;
  readonly time?: number;
}

export type QueryInput =
  | string
  | URLSearchParams
  | Record<string, string>
  | readonly (readonly [string, string])[];

export class BybitDemoTransportError extends Error {
  readonly kind: TransportFailureKind;
  readonly retCode: number | undefined;
  readonly httpStatus: number | undefined;
  readonly recommendReconnect: boolean;

  constructor(
    kind: TransportFailureKind,
    message: string,
    options: {
      retCode?: number;
      httpStatus?: number;
      recommendReconnect?: boolean;
    } = {},
  ) {
    super(message);
    this.name = "BybitDemoTransportError";
    this.kind = kind;
    this.retCode = options.retCode;
    this.httpStatus = options.httpStatus;
    this.recommendReconnect = options.recommendReconnect ?? false;
  }
}

export { BybitDemoTransportError as BybitPrivateTransportError };

export interface BybitPrivateTransportOptions {
  readonly environment: BybitPrivateEnvironment;
  readonly credentials: ExchangeCredentials;
  readonly request?: typeof fetch;
  readonly clock?: () => number;
  readonly clockOffsetMs?: number;
  readonly recvWindow?: string;
  readonly timeoutMs?: number;
}

export type BybitDemoTransportOptions = Omit<
  BybitPrivateTransportOptions,
  "environment"
>;

function asObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function numericCode(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value);
  return null;
}

function safeResponseTime(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

export function validateBybitResponse(value: unknown): BybitResponse {
  const object = asObject(value);
  const retCode = numericCode(object?.retCode);
  const retMsg = object?.retMsg;
  const result = asObject(object?.result);
  if (retCode === null || typeof retMsg !== "string" || result === null) {
    throw new BybitDemoTransportError(
      "invalid-response",
      "Bybit returned an invalid response envelope; no exchange evidence was accepted.",
    );
  }
  const time = safeResponseTime(object?.time);
  return time === undefined
    ? { retCode, retMsg, result }
    : { retCode, retMsg, result, time };
}

export function responseList(
  response: BybitResponse,
): readonly JsonObject[] | undefined {
  const list = response.result.list;
  if (!Array.isArray(list)) return undefined;
  const records = list.filter(
    (value): value is JsonObject =>
      typeof value === "object" && value !== null && !Array.isArray(value),
  );
  return records.length === list.length ? records : undefined;
}

function queryString(input: QueryInput | undefined): string {
  if (input === undefined) return "";
  if (typeof input === "string") return input.replace(/^\?/, "");
  if (input instanceof URLSearchParams) return input.toString();
  const params = new URLSearchParams();
  if (Array.isArray(input)) {
    for (const [key, value] of input) params.append(key, value);
  } else {
    for (const [key, value] of Object.entries(input)) params.append(key, value);
  }
  return params.toString();
}

function environmentLabel(environment: BybitPrivateEnvironment): string {
  return environment === "demo" ? "Demo" : "Mainnet";
}

function requestUrl(
  environment: BybitPrivateEnvironment,
  path: string,
  query: string,
): string {
  const origin = BYBIT_CANONICAL_ORIGINS[environment];
  const label = environmentLabel(environment);
  if (
    !path.startsWith("/") ||
    path.includes("//") ||
    path.includes("#") ||
    path.includes("?") ||
    path.includes("\\")
  ) {
    throw new BybitDemoTransportError(
      "invalid-request",
      `The Bybit ${label} endpoint path is invalid.`,
    );
  }
  const url = new URL(path, origin);
  if (
    url.origin !== origin ||
    url.pathname !== path ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new BybitDemoTransportError(
      "invalid-request",
      `The Bybit ${label} adapter accepts only its canonical origin.`,
    );
  }
  if (query) url.search = query;
  return url.toString();
}

function parseServerTime(response: BybitResponse): number {
  const resultTime =
    safeResponseTime(response.result.timeSecond) !== undefined
      ? safeResponseTime(response.result.timeSecond)! * 1_000
      : safeResponseTime(response.result.timeNano) !== undefined
        ? Math.trunc(safeResponseTime(response.result.timeNano)! / 1_000_000)
        : response.time;
  if (
    resultTime === undefined ||
    !Number.isFinite(resultTime) ||
    resultTime <= 0
  ) {
    throw new BybitDemoTransportError(
      "invalid-response",
      "Bybit time response did not contain a valid server timestamp.",
    );
  }
  return resultTime;
}

function errorForResponse(
  response: BybitResponse,
  environment: BybitPrivateEnvironment,
): BybitDemoTransportError | null {
  if (response.retCode === 0) return null;
  const classification = classifyRetCode(response.retCode);
  const message =
    environment === "demo"
      ? classification.message
      : classification.message.replaceAll("Demo", "Mainnet");
  return new BybitDemoTransportError(classification.kind, message, {
    retCode: classification.retCode,
    recommendReconnect: classification.recommendReconnect,
  });
}

export class BybitPrivateTransport {
  readonly #environment: BybitPrivateEnvironment;
  readonly #origin: string;
  private readonly credentials: ExchangeCredentials;
  private readonly request: typeof fetch;
  private readonly clock: () => number;
  private readonly recvWindow: string;
  private readonly timeoutMs: number;
  private clockOffset: number | undefined;

  constructor(options: BybitPrivateTransportOptions) {
    if (
      !options ||
      (options.environment !== "demo" && options.environment !== "mainnet")
    ) {
      throw new BybitDemoTransportError(
        "invalid-request",
        "The Bybit private adapter accepts only canonical Demo or Mainnet environments.",
      );
    }
    this.#environment = options.environment;
    this.#origin = BYBIT_CANONICAL_ORIGINS[options.environment];
    this.credentials = options.credentials;
    this.request = options.request ?? fetch;
    this.clock = options.clock ?? Date.now;
    this.clockOffset = options.clockOffsetMs;
    this.recvWindow = options.recvWindow ?? DEFAULT_RECV_WINDOW;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /** The fixed environment selected from the closed canonical-origin map. */
  get environment(): BybitPrivateEnvironment {
    return this.#environment;
  }

  /** The canonical origin for the fixed environment; callers cannot override it. */
  get origin(): string {
    return this.#origin;
  }

  async get(path: string, query?: QueryInput): Promise<BybitResponse> {
    return this.send("GET", path, queryString(query));
  }

  async post(path: string, body: JsonObject | string): Promise<BybitResponse> {
    const serialized = typeof body === "string" ? body : JSON.stringify(body);
    return this.send("POST", path, "", serialized);
  }

  async getServerTimeOffset(): Promise<number> {
    return this.ensureClockOffset();
  }

  async getServerTime(): Promise<number> {
    return parseServerTime(await this.sendUnsigned(BYBIT_TIME_PATH));
  }

  private async ensureClockOffset(): Promise<number> {
    if (this.clockOffset !== undefined) return this.clockOffset;
    const before = this.clock();
    const response = await this.sendUnsigned(BYBIT_TIME_PATH);
    const after = this.clock();
    const serverTime = parseServerTime(response);
    this.clockOffset = serverTime - Math.round((before + after) / 2);
    return this.clockOffset;
  }

  private async send(
    method: HttpMethod,
    path: string,
    query: string,
    body?: string,
  ): Promise<BybitResponse> {
    const url = requestUrl(this.#environment, path, query);
    const offset = await this.ensureClockOffset();
    const timestamp = String(Math.trunc(this.clock() + offset));
    const signedBytes = body ?? query;
    const signature = hmacSha256(
      buildSignaturePayload(
        timestamp,
        this.credentials.apiKey,
        this.recvWindow,
        signedBytes,
      ),
      this.credentials.apiSecret,
    );
    const headers: Record<string, string> = {
      Accept: "application/json",
      "X-BAPI-API-KEY": this.credentials.apiKey,
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-SIGN": signature,
      "X-BAPI-RECV-WINDOW": this.recvWindow,
      "X-BAPI-SIGN-TYPE": "2",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return this.fetchValidated(url, {
      method,
      headers,
      redirect: "error",
      ...(body === undefined ? {} : { body }),
    });
  }

  private async sendUnsigned(path: string): Promise<BybitResponse> {
    return this.fetchValidated(requestUrl(this.#environment, path, ""), {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "error",
    });
  }

  private async fetchValidated(
    url: string,
    init: RequestInit,
  ): Promise<BybitResponse> {
    const label = environmentLabel(this.#environment);
    let response: Response;
    try {
      response = await this.request(url, {
        ...init,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new BybitDemoTransportError(
        "transport-failed",
        `The Bybit ${label} request could not be completed.`,
      );
    }
    const finalUrl = response.url === "" ? url : response.url;
    let finalOrigin: string;
    try {
      finalOrigin = new URL(finalUrl).origin;
    } catch {
      throw new BybitDemoTransportError(
        "invalid-response",
        `Bybit ${label} returned a response with an invalid final origin.`,
      );
    }
    if (finalOrigin !== this.#origin || response.redirected) {
      throw new BybitDemoTransportError(
        "invalid-response",
        `Bybit ${label} returned a response from a non-canonical origin.`,
      );
    }
    if (!response.ok) {
      throw new BybitDemoTransportError(
        response.status === 429 ? "rate-limited" : "transport-failed",
        response.status === 429
          ? `Bybit ${label} rate-limited the request.`
          : `Bybit ${label} returned HTTP ${response.status}.`,
        { httpStatus: response.status },
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new BybitDemoTransportError(
        "invalid-response",
        `Bybit ${label} returned a non-JSON response; no exchange evidence was accepted.`,
      );
    }
    const validated = validateBybitResponse(payload);
    const failure = errorForResponse(validated, this.#environment);
    if (failure) throw failure;
    return validated;
  }
}

export class BybitDemoTransport extends BybitPrivateTransport {
  constructor(options: BybitDemoTransportOptions) {
    super({ ...options, environment: "demo" });
  }
}

export function createBybitPrivateTransport(
  options: BybitPrivateTransportOptions,
): BybitPrivateTransport {
  return new BybitPrivateTransport(options);
}

export function createBybitDemoTransport(
  options: BybitDemoTransportOptions,
): BybitDemoTransport {
  return new BybitDemoTransport(options);
}

export const composeSignaturePayload = buildSignaturePayload;
export const signRequest = hmacSha256;
