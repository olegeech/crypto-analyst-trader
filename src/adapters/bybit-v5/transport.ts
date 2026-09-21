import { createHmac } from "node:crypto";

import type { ExchangeCredentials } from "../../ports/credential-provider.js";

export const BYBIT_DEMO_ORIGIN = "https://api-demo.bybit.com";
export const BYBIT_DEMO_TIME_PATH = "/v5/market/time";
export const DEFAULT_RECV_WINDOW = "5000";
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

type JsonObject = Record<string, unknown>;
type HttpMethod = "GET" | "POST";

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

export type TransportFailureKind =
  | "clock-skew"
  | "signing-defect"
  | "invalid-credentials"
  | "expired-credentials"
  | "permission-denied"
  | "ip-restriction"
  | "rate-limited"
  | "ambiguous-server"
  | "ownership-conflict"
  | "validation-failed"
  | "exchange-failure"
  | "transport-failed"
  | "invalid-request"
  | "invalid-response";

export interface RetCodeClassification {
  readonly kind: TransportFailureKind;
  readonly retCode: number;
  readonly recommendReconnect: boolean;
  readonly message: string;
}

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

export interface BybitDemoTransportOptions {
  readonly credentials: ExchangeCredentials;
  readonly request?: typeof fetch;
  readonly clock?: () => number;
  readonly clockOffsetMs?: number;
  readonly recvWindow?: string;
  readonly timeoutMs?: number;
}

export function buildSignaturePayload(
  timestamp: string,
  apiKey: string,
  recvWindow: string,
  queryStringOrRawBody: string,
): string {
  return `${timestamp}${apiKey}${recvWindow}${queryStringOrRawBody}`;
}

export function hmacSha256(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

export function classifyRetCode(retCode: number): RetCodeClassification {
  switch (retCode) {
    case 10000:
    case 10016:
      return {
        kind: "ambiguous-server",
        retCode,
        recommendReconnect: false,
        message:
          "Bybit returned an ambiguous server outcome; reconcile exchange state before retrying.",
      };
    case 10002:
      return {
        kind: "clock-skew",
        retCode,
        recommendReconnect: false,
        message:
          "Bybit rejected the request because the signing clock is outside the allowed window.",
      };
    case 10004:
      return {
        kind: "signing-defect",
        retCode,
        recommendReconnect: false,
        message:
          "Bybit rejected the signature; inspect the signing implementation before retrying.",
      };
    case 10003:
      return {
        kind: "invalid-credentials",
        retCode,
        recommendReconnect: true,
        message: "Bybit rejected the Demo API credentials.",
      };
    case 33004:
      return {
        kind: "expired-credentials",
        retCode,
        recommendReconnect: true,
        message: "The Bybit Demo API key is expired.",
      };
    case 10005:
      return {
        kind: "permission-denied",
        retCode,
        recommendReconnect: true,
        message: "The Bybit Demo credential lacks the required permission.",
      };
    case 10010:
      return {
        kind: "ip-restriction",
        retCode,
        recommendReconnect: false,
        message: "Bybit rejected the request because the caller IP is not allowed.",
      };
    case 10006:
      return {
        kind: "rate-limited",
        retCode,
        recommendReconnect: false,
        message: "Bybit rate-limited the request; retry only within the read budget.",
      };
    case 110072:
      return {
        kind: "ownership-conflict",
        retCode,
        recommendReconnect: false,
        message:
          "Bybit reported that the supplied orderLinkId is already in use; reconcile that exact identity.",
      };
    case 110001:
    case 110008:
    case 110010:
      return {
        kind: "ownership-conflict",
        retCode,
        recommendReconnect: false,
        message: "Bybit reported an order ownership or lifecycle conflict.",
      };
    case 10001:
    case 110003:
    case 110007:
    case 110017:
    case 110023:
    case 110094:
    case 110100:
    case 181017:
      return {
        kind: "validation-failed",
        retCode,
        recommendReconnect: false,
        message: "Bybit rejected the request as invalid or unavailable for this scope.",
      };
    default:
      return {
        kind: "exchange-failure",
        retCode,
        recommendReconnect: false,
        message: `Bybit returned an unclassified failure code (${retCode}).`,
      };
  }
}

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

function requestUrl(path: string, query: string): string {
  if (!path.startsWith("/") || path.includes("//") || path.includes("#")) {
    throw new BybitDemoTransportError(
      "invalid-request",
      "The Bybit Demo endpoint path is invalid.",
    );
  }
  const url = new URL(path, BYBIT_DEMO_ORIGIN);
  if (url.origin !== BYBIT_DEMO_ORIGIN) {
    throw new BybitDemoTransportError(
      "invalid-request",
      "The Bybit Demo adapter accepts only its canonical origin.",
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
): BybitDemoTransportError | null {
  if (response.retCode === 0) return null;
  const classification = classifyRetCode(response.retCode);
  return new BybitDemoTransportError(classification.kind, classification.message, {
    retCode: classification.retCode,
    recommendReconnect: classification.recommendReconnect,
  });
}

export class BybitDemoTransport {
  private readonly credentials: ExchangeCredentials;
  private readonly request: typeof fetch;
  private readonly clock: () => number;
  private readonly recvWindow: string;
  private readonly timeoutMs: number;
  private clockOffset: number | undefined;

  constructor(options: BybitDemoTransportOptions) {
    this.credentials = options.credentials;
    this.request = options.request ?? fetch;
    this.clock = options.clock ?? Date.now;
    this.clockOffset = options.clockOffsetMs;
    this.recvWindow = options.recvWindow ?? DEFAULT_RECV_WINDOW;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
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

  private async ensureClockOffset(): Promise<number> {
    if (this.clockOffset !== undefined) return this.clockOffset;
    const before = this.clock();
    const response = await this.sendUnsigned(BYBIT_DEMO_TIME_PATH);
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
    const url = requestUrl(path, query);
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
    return this.fetchValidated(requestUrl(path, ""), {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "error",
    });
  }

  private async fetchValidated(
    url: string,
    init: RequestInit,
  ): Promise<BybitResponse> {
    let response: Response;
    try {
      response = await this.request(url, {
        ...init,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new BybitDemoTransportError(
        "transport-failed",
        "The Bybit Demo request could not be completed.",
      );
    }
    const finalUrl = response.url === "" ? url : response.url;
    if (new URL(finalUrl).origin !== BYBIT_DEMO_ORIGIN) {
      throw new BybitDemoTransportError(
        "invalid-response",
        "Bybit Demo returned a response from a non-canonical origin.",
      );
    }
    if (!response.ok) {
      throw new BybitDemoTransportError(
        response.status === 429 ? "rate-limited" : "transport-failed",
        response.status === 429
          ? "Bybit Demo rate-limited the request."
          : `Bybit Demo returned HTTP ${response.status}.`,
        { httpStatus: response.status },
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new BybitDemoTransportError(
        "invalid-response",
        "Bybit Demo returned a non-JSON response; no exchange evidence was accepted.",
      );
    }
    const validated = validateBybitResponse(payload);
    const failure = errorForResponse(validated);
    if (failure) throw failure;
    return validated;
  }
}

export function createBybitDemoTransport(
  options: BybitDemoTransportOptions,
): BybitDemoTransport {
  return new BybitDemoTransport(options);
}

export const composeSignaturePayload = buildSignaturePayload;
export const signRequest = hmacSha256;
