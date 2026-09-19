import { createHash } from "node:crypto";

import type { ProbeEnvironment } from "./config.js";
import { parseDecimal, toDecimalString } from "./decimal.js";

export const PROBE_PLAN_SCHEMA_VERSION = 1 as const;

export type ProbePlanMethod = "GET" | "POST";
export type ProbeSide = "Buy" | "Sell";
export type ProbeOrderType = "Limit" | "Market";
export type ProbeTimeInForce = "GTC" | "IOC" | "FOK" | "PostOnly";
export type ProbeTpslMode = "Full";
export type ProbeTriggerOrderType = "Market" | "Limit";
export type ProbeTriggerBy = "LastPrice" | "MarkPrice" | "IndexPrice";

export interface ProbeOrderParameters {
  readonly category: string;
  readonly symbol: string;
  readonly side: ProbeSide;
  readonly orderLinkId?: string;
  readonly orderId?: string;
  readonly price?: string;
  readonly qty?: string;
  readonly takeProfit?: string;
  readonly stopLoss?: string;
  readonly orderType?: ProbeOrderType;
  readonly timeInForce?: ProbeTimeInForce;
  readonly reduceOnly?: boolean;
  readonly positionIdx?: number;
  readonly tpslMode?: ProbeTpslMode;
  readonly tpOrderType?: ProbeTriggerOrderType;
  readonly slOrderType?: ProbeTriggerOrderType;
  readonly tpTriggerBy?: ProbeTriggerBy;
  readonly slTriggerBy?: ProbeTriggerBy;
  readonly closeOnTrigger?: boolean;
}

export interface ProbePlanInput {
  readonly environment: ProbeEnvironment;
  readonly accountId: string;
  readonly scenario: string;
  readonly expiresAt: number;
  readonly method: ProbePlanMethod;
  readonly endpoint: string;
  readonly params: ProbeOrderParameters;
}

export interface ProbePlan {
  readonly schemaVersion: typeof PROBE_PLAN_SCHEMA_VERSION;
  readonly environment: ProbeEnvironment;
  readonly accountId: string;
  readonly scenario: string;
  readonly expiresAt: number;
  readonly method: ProbePlanMethod;
  readonly endpoint: string;
  readonly params: ProbeOrderParameters;
}

const DECIMAL_FIELDS = new Set(["price", "qty", "takeProfit", "stopLoss"]);
const ALLOWED_FIELDS = new Set([
  "category",
  "symbol",
  "side",
  "orderLinkId",
  "orderId",
  "price",
  "qty",
  "takeProfit",
  "stopLoss",
  "orderType",
  "timeInForce",
  "reduceOnly",
  "positionIdx",
  "tpslMode",
  "tpOrderType",
  "slOrderType",
  "tpTriggerBy",
  "slTriggerBy",
  "closeOnTrigger",
]);

const ENUM_FIELDS = {
  orderType: new Set<ProbeOrderType>(["Limit", "Market"]),
  timeInForce: new Set<ProbeTimeInForce>(["GTC", "IOC", "FOK", "PostOnly"]),
  tpslMode: new Set<ProbeTpslMode>(["Full"]),
  tpOrderType: new Set<ProbeTriggerOrderType>(["Market", "Limit"]),
  slOrderType: new Set<ProbeTriggerOrderType>(["Market", "Limit"]),
  tpTriggerBy: new Set<ProbeTriggerBy>([
    "LastPrice",
    "MarkPrice",
    "IndexPrice",
  ]),
  slTriggerBy: new Set<ProbeTriggerBy>([
    "LastPrice",
    "MarkPrice",
    "IndexPrice",
  ]),
} as const;

function safeText(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    /[\u0000-\u001f\u007f\r\n]/.test(value)
  ) {
    throw new Error(`${field} must be a non-empty single-line string`);
  }
  return value;
}

function rejectSensitiveKeys(value: object): void {
  for (const key of Object.keys(value)) {
    if (/(?:secret|signature|header|token|password)/i.test(key)) {
      throw new Error("unsupported sensitive plan field");
    }
  }
}

function normalizedParams(input: ProbeOrderParameters): ProbeOrderParameters {
  rejectSensitiveKeys(input);
  const source = input as unknown as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    if (!ALLOWED_FIELDS.has(key))
      throw new Error(`unsupported probe plan field: ${key}`);
  }
  const params: Record<string, unknown> = {};
  for (const field of ALLOWED_FIELDS) {
    const value = source[field];
    if (value === undefined) continue;
    if (DECIMAL_FIELDS.has(field)) {
      params[field] = toDecimalString(parseDecimal(value));
    } else {
      params[field] = value;
    }
  }
  safeText(params.category, "category");
  safeText(params.symbol, "symbol");
  if (params.side !== "Buy" && params.side !== "Sell") {
    throw new Error("side must be Buy or Sell");
  }
  for (const [field, allowed] of Object.entries(ENUM_FIELDS)) {
    const value = params[field];
    if (value !== undefined && !allowed.has(value as never)) {
      throw new Error(`${field} has an unsupported value`);
    }
  }
  const positionIdx = params.positionIdx;
  if (
    positionIdx !== undefined &&
    (typeof positionIdx !== "number" ||
      !Number.isInteger(positionIdx) ||
      positionIdx < 0)
  ) {
    throw new Error("positionIdx must be a non-negative integer");
  }
  if (params.orderLinkId !== undefined)
    safeText(params.orderLinkId, "orderLinkId");
  if (params.orderId !== undefined) safeText(params.orderId, "orderId");
  return params as unknown as ProbeOrderParameters;
}

export function buildProbePlan(input: ProbePlanInput): ProbePlan {
  rejectSensitiveKeys(input);
  if (input.environment !== "testnet" && input.environment !== "demo")
    throw new Error("probe plan environment must be testnet or demo");
  const accountId = safeText(input.accountId, "accountId");
  const scenario = safeText(input.scenario, "scenario");
  if (!Number.isInteger(input.expiresAt) || input.expiresAt <= 0) {
    throw new Error("expiresAt must be a positive integer timestamp");
  }
  if (input.method !== "GET" && input.method !== "POST")
    throw new Error("method must be GET or POST");
  const endpoint = safeText(input.endpoint, "endpoint");
  if (
    !endpoint.startsWith("/") ||
    endpoint.includes("//") ||
    endpoint.includes("#")
  ) {
    throw new Error("endpoint must be a relative API path");
  }
  return {
    schemaVersion: PROBE_PLAN_SCHEMA_VERSION,
    environment: input.environment,
    accountId,
    scenario,
    expiresAt: input.expiresAt,
    method: input.method,
    endpoint,
    params: normalizedParams(input.params),
  };
}

function canonicalValue(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalValue(object[key])}`)
      .join(",")}}`;
  }
  throw new Error("unsupported value in canonical probe plan");
}

export function canonicalize(value: unknown): string {
  return canonicalValue(value);
}

export function hashProbePlan(plan: ProbePlan): string {
  return createHash("sha256").update(canonicalize(plan), "utf8").digest("hex");
}

export function isProbePlanExpired(plan: ProbePlan, now: number): boolean {
  return now >= plan.expiresAt;
}

export function assertProbePlanCurrent(
  plan: ProbePlan,
  expectedDigest: string,
  now: number,
  expectedAccountId = plan.accountId,
): void {
  if (isProbePlanExpired(plan, now))
    throw new Error("probe plan approval expired");
  if (plan.accountId !== expectedAccountId)
    throw new Error("probe plan account mismatch");
  if (hashProbePlan(plan) !== expectedDigest.toLowerCase()) {
    throw new Error("probe plan digest mismatch");
  }
}

export const digestProbePlan = hashProbePlan;
