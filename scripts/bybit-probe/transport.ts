import { createHmac } from "node:crypto";
import process from "node:process";

import { createMacOSKeychainProvider } from "../../src/adapters/macos-keychain.js";
import {
  CredentialProviderError,
  type CredentialProvider,
  type ExchangeCredentials,
} from "../../src/ports/credential-provider.js";

type JsonObject = Record<string, unknown>;
type HttpMethod = "GET" | "POST";

export const DEFAULT_RECV_WINDOW = "5000";
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
export const TESTNET_TIME_PATH = "/v5/market/time";

export interface BybitResponse {
  readonly retCode: number;
  readonly retMsg: string;
  readonly result: JsonObject;
  readonly time?: number;
}

export type TransportFailureKind =
  | "clock-skew"
  | "signing-defect"
  | "invalid-credentials"
  | "expired-credentials"
  | "permission-denied"
  | "ip-restriction"
  | "exchange-failure"
  | "transport-failed"
  | "invalid-response";

export interface RetCodeClassification {
  readonly kind: TransportFailureKind;
  readonly retCode: number;
  readonly recommendReconnect: boolean;
  readonly message: string;
}

export class BybitProbeTransportError extends Error {
  readonly kind: TransportFailureKind;
  readonly retCode: number | undefined;
  readonly recommendReconnect: boolean;

  constructor(
    kind: TransportFailureKind,
    message: string,
    options: { retCode?: number; recommendReconnect?: boolean } = {},
  ) {
    super(message);
    this.name = "BybitProbeTransportError";
    this.kind = kind;
    this.retCode = options.retCode;
    this.recommendReconnect = options.recommendReconnect ?? false;
  }
}

export interface ProbeTransportRequestOptions {
  readonly baseUrl: URL;
  readonly credentials?: ExchangeCredentials;
  readonly credentialProvider?: Pick<CredentialProvider, "load">;
  readonly request?: typeof fetch;
  readonly clock?: () => number;
  readonly clockOffsetMs?: number;
  readonly recvWindow?: string;
  readonly timeoutMs?: number;
}

export type QueryInput =
  | string
  | URLSearchParams
  | Record<string, string>
  | readonly (readonly [string, string])[];

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
    case 10002:
      return {
        kind: "clock-skew",
        retCode,
        recommendReconnect: false,
        message: "Bybit rejected the request because the signing clock is outside the allowed window.",
      };
    case 10004:
      return {
        kind: "signing-defect",
        retCode,
        recommendReconnect: false,
        message: "Bybit rejected the signature; inspect the probe signing implementation before reconnecting credentials.",
      };
    case 10003:
      return {
        kind: "invalid-credentials",
        retCode,
        recommendReconnect: true,
        message: "Bybit rejected the API key or environment. Verify the Testnet credential with npm run credentials:connect:testnet.",
      };
    case 33004:
      return {
        kind: "expired-credentials",
        retCode,
        recommendReconnect: true,
        message: "The Bybit API key is expired. Reconnect the Testnet credential with npm run credentials:connect:testnet.",
      };
    case 10005:
      return {
        kind: "permission-denied",
        retCode,
        recommendReconnect: true,
        message: "The Testnet credential lacks the required permission. Reconnect it with npm run credentials:connect:testnet.",
      };
    case 10010:
      return {
        kind: "ip-restriction",
        retCode,
        recommendReconnect: false,
        message: "Bybit rejected the request because the caller IP is not allowed for this key.",
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
  if (
    (retCode === null && retCode !== 0) ||
    typeof retMsg !== "string" ||
    !retMsg ||
    result === null
  ) {
    throw new BybitProbeTransportError(
      "invalid-response",
      "invalid Bybit response; no exchange evidence was accepted.",
    );
  }
  const time = safeResponseTime(object?.time);
  return time === undefined
    ? { retCode, retMsg, result }
    : { retCode, retMsg, result, time };
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

function requestUrl(baseUrl: URL, path: string, query: string): string {
  if (!path.startsWith("/") || path.includes("//") || path.includes("#")) {
    throw new BybitProbeTransportError(
      "invalid-response",
      "The probe endpoint path is invalid.",
    );
  }
  const url = new URL(path, baseUrl);
  if (query) url.search = query;
  return url.toString();
}

function errorForResponse(response: BybitResponse): BybitProbeTransportError | null {
  if (response.retCode === 0) return null;
  const classification = classifyRetCode(response.retCode);
  return new BybitProbeTransportError(classification.kind, classification.message, {
    retCode: classification.retCode,
    recommendReconnect: classification.recommendReconnect,
  });
}

function parseServerTime(response: BybitResponse): number {
  const resultTime =
    safeResponseTime(response.result.timeSecond) !== undefined
      ? safeResponseTime(response.result.timeSecond)! * 1_000
      : safeResponseTime(response.result.timeNano) !== undefined
        ? Math.trunc(safeResponseTime(response.result.timeNano)! / 1_000_000)
        : response.time;
  if (resultTime === undefined || !Number.isFinite(resultTime) || resultTime <= 0) {
    throw new BybitProbeTransportError(
      "invalid-response",
      "Bybit time response did not contain a valid server timestamp.",
    );
  }
  return resultTime;
}

function abortSignal(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}

export class BybitProbeTransport {
  private readonly baseUrl: URL;
  private readonly credentialProvider: Pick<CredentialProvider, "load">;
  private readonly injectedCredentials: ExchangeCredentials | undefined;
  private readonly request: typeof fetch;
  private readonly clock: () => number;
  private readonly recvWindow: string;
  private readonly timeoutMs: number;
  private clockOffset: number | undefined;
  private credentials: ExchangeCredentials | undefined;

  constructor(options: ProbeTransportRequestOptions) {
    this.baseUrl = new URL(options.baseUrl.toString());
    this.injectedCredentials = options.credentials;
    this.credentialProvider =
      options.credentialProvider ?? createMacOSKeychainProvider();
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

  private async loadCredentials(): Promise<ExchangeCredentials> {
    if (this.credentials) return this.credentials;
    try {
      this.credentials =
        this.injectedCredentials ?? (await this.credentialProvider.load("testnet"));
      return this.credentials;
    } catch (error) {
      if (error instanceof CredentialProviderError) throw error;
      throw new BybitProbeTransportError(
        "transport-failed",
        "The Testnet credential provider could not be accessed.",
      );
    }
  }

  private async ensureClockOffset(): Promise<number> {
    if (this.clockOffset !== undefined) return this.clockOffset;
    const before = this.clock();
    const response = await this.sendUnsigned(TESTNET_TIME_PATH);
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
    const credentials = await this.loadCredentials();
    const offset = await this.ensureClockOffset();
    const timestamp = String(Math.trunc(this.clock() + offset));
    const signedBytes = body ?? query;
    const signature = hmacSha256(
      buildSignaturePayload(timestamp, credentials.apiKey, this.recvWindow, signedBytes),
      credentials.apiSecret,
    );
    const headers: Record<string, string> = {
      "X-BAPI-API-KEY": credentials.apiKey,
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-SIGN": signature,
      "X-BAPI-RECV-WINDOW": this.recvWindow,
      "X-BAPI-SIGN-TYPE": "2",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return this.fetchValidated(requestUrl(this.baseUrl, path, query), {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
    });
  }

  private async sendUnsigned(path: string): Promise<BybitResponse> {
    return this.fetchValidated(requestUrl(this.baseUrl, path, ""), {
      method: "GET",
      headers: { Accept: "application/json" },
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
        signal: abortSignal(this.timeoutMs),
      });
    } catch {
      throw new BybitProbeTransportError(
        "transport-failed",
        "The Bybit Testnet request could not be completed.",
      );
    }
    if (!response.ok) {
      throw new BybitProbeTransportError(
        "transport-failed",
        `Bybit Testnet returned HTTP ${response.status}.`,
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new BybitProbeTransportError(
        "invalid-response",
        "Bybit returned a non-JSON response; no exchange evidence was accepted.",
      );
    }
    const validated = validateBybitResponse(payload);
    const failure = errorForResponse(validated);
    if (failure) throw failure;
    return validated;
  }
}

export function createBybitProbeTransport(
  options: ProbeTransportRequestOptions,
): BybitProbeTransport {
  return new BybitProbeTransport(options);
}

// Explicit aliases make the pure signing seam easy to discover in tests and
// keep the diagnostic module's API independent from the eventual #8 adapter.
export const composeSignaturePayload = buildSignaturePayload;
export const signRequest = hmacSha256;
