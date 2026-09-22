type JsonObject = Record<string, unknown>;

export interface BybitPublicResponse {
  readonly retCode: number;
  readonly retMsg: string;
  readonly result: JsonObject;
  readonly time?: number;
}

function asObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function numericCode(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/u.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function responseTime(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/u.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function validateBybitPublicResponse(
  value: unknown,
): BybitPublicResponse {
  const object = asObject(value);
  const retCode = numericCode(object?.retCode);
  const retMsg = object?.retMsg;
  const result = asObject(object?.result);
  if (retCode === null || typeof retMsg !== "string" || result === null) {
    throw new Error(
      "Bybit public response has an invalid envelope; no market evidence was accepted.",
    );
  }
  const time = responseTime(object?.time);
  return time === undefined
    ? { retCode, retMsg, result }
    : { retCode, retMsg, result, time };
}

export function responseList(
  response: BybitPublicResponse,
): readonly JsonObject[] | undefined {
  const list = response.result.list;
  if (!Array.isArray(list)) return undefined;
  const records = list.filter(
    (value): value is JsonObject =>
      typeof value === "object" && value !== null && !Array.isArray(value),
  );
  return records.length === list.length ? records : undefined;
}

export function responseServerTimeMs(
  response: BybitPublicResponse,
): number | undefined {
  const seconds = response.result.timeSecond;
  if (
    (typeof seconds === "number" && Number.isSafeInteger(seconds)) ||
    (typeof seconds === "string" && /^\d+$/u.test(seconds))
  ) {
    const milliseconds = BigInt(String(seconds)) * 1_000n;
    if (milliseconds <= BigInt(Number.MAX_SAFE_INTEGER)) {
      return Number(milliseconds);
    }
  }
  const nanoseconds = response.result.timeNano;
  if (
    (typeof nanoseconds === "number" && Number.isSafeInteger(nanoseconds)) ||
    (typeof nanoseconds === "string" && /^\d+$/u.test(nanoseconds))
  ) {
    const milliseconds = BigInt(String(nanoseconds)) / 1_000_000n;
    if (milliseconds <= BigInt(Number.MAX_SAFE_INTEGER)) {
      return Number(milliseconds);
    }
  }
  return response.time;
}
