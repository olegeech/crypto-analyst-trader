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
  if (object?.time !== undefined && (time === undefined || time <= 0))
    throw new Error("Bybit public response has an invalid provider timestamp.");
  return time === undefined
    ? { retCode, retMsg, result }
    : { retCode, retMsg, result, time };
}

export function responseList(
  response: Pick<BybitPublicResponse, "result">,
): readonly JsonObject[] | undefined {
  const list = response.result.list;
  if (!Array.isArray(list)) return undefined;
  const records = list.filter(
    (value): value is JsonObject =>
      typeof value === "object" && value !== null && !Array.isArray(value),
  );
  return records.length === list.length ? records : undefined;
}

/** Parse only positive exact integers; nanoseconds remain BigInt until division. */
function providerInteger(value: unknown): bigint | undefined {
  if (typeof value === "number")
    return Number.isSafeInteger(value) && value > 0 ? BigInt(value) : undefined;
  if (typeof value !== "string" || !/^\d{1,32}$/u.test(value)) return undefined;
  const parsed = BigInt(value);
  return parsed > 0n ? parsed : undefined;
}

export function responseServerTimeMs(
  response: BybitPublicResponse,
): number | undefined {
  const nanoInput = response.result.timeNano;
  const secondsInput = response.result.timeSecond;
  const nano = nanoInput === undefined ? undefined : providerInteger(nanoInput);
  const seconds =
    secondsInput === undefined ? undefined : providerInteger(secondsInput);
  const envelope =
    response.time === undefined ? undefined : providerInteger(response.time);
  if (
    (nanoInput !== undefined && nano === undefined) ||
    (secondsInput !== undefined && seconds === undefined) ||
    (response.time !== undefined && envelope === undefined)
  )
    return undefined;

  const nanoMs = nano === undefined ? undefined : nano / 1_000_000n;
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  if (
    (nanoMs !== undefined && (nanoMs <= 0n || nanoMs > max)) ||
    (seconds !== undefined && seconds * 1_000n > max)
  )
    return undefined;
  if (
    nano !== undefined &&
    seconds !== undefined &&
    nano / 1_000_000_000n !== seconds
  )
    return undefined;
  // The envelope may be stamped after the result, including across a second
  // boundary. A discrepancy of a full second is contradictory provider data.
  if (
    nanoMs !== undefined &&
    envelope !== undefined &&
    (nanoMs - envelope >= 1_000n || envelope - nanoMs >= 1_000n)
  )
    return undefined;
  if (
    nanoMs === undefined &&
    seconds !== undefined &&
    envelope !== undefined &&
    envelope / 1_000n !== seconds
  )
    return undefined;
  const milliseconds =
    nanoMs ??
    envelope ??
    (seconds === undefined ? undefined : seconds * 1_000n);
  return milliseconds !== undefined && milliseconds > 0n && milliseconds <= max
    ? Number(milliseconds)
    : undefined;
}
