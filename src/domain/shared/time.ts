import { domainError } from "./errors.js";
import { fail, ok, type Result } from "./result.js";

export type UtcTimestamp = string & { readonly __utcTimestamp: unique symbol };

export interface Clock {
  readonly now: () => UtcTimestamp;
}

const UTC_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/u;

function hasValidTimestampComponents(match: RegExpExecArray): boolean {
  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    zoneText,
  ] = match;
  const zone = zoneText ?? "";
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (
    month < 1 ||
    month > 12 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    (zone !== "Z" &&
      (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59))
  ) {
    return false;
  }
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][month - 1];
  return day >= 1 && day <= (daysInMonth ?? 0);
}

export function parseUtcTimestamp(value: unknown): Result<UtcTimestamp> {
  if (typeof value !== "string") {
    return fail(
      domainError(
        "INVALID_TIMESTAMP",
        "timestamp must be an ISO-8601 instant",
        {
          field: "timestamp",
        },
      ),
    );
  }
  const match = UTC_TIMESTAMP_PATTERN.exec(value);
  if (match === null || !hasValidTimestampComponents(match)) {
    return fail(
      domainError(
        "INVALID_TIMESTAMP",
        "timestamp must be an ISO-8601 instant",
        {
          field: "timestamp",
        },
      ),
    );
  }
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) {
    return fail(
      domainError("INVALID_TIMESTAMP", "timestamp is not a valid instant", {
        field: "timestamp",
      }),
    );
  }
  return ok(new Date(epoch).toISOString() as UtcTimestamp);
}

export function timestampFromEpochMs(epoch: number): Result<UtcTimestamp> {
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    return fail(
      domainError(
        "INVALID_TIMESTAMP",
        "epoch must be a non-negative safe integer",
        {
          field: "epoch",
        },
      ),
    );
  }
  try {
    return ok(new Date(epoch).toISOString() as UtcTimestamp);
  } catch {
    return fail(
      domainError("INVALID_TIMESTAMP", "epoch is outside the supported range", {
        field: "epoch",
      }),
    );
  }
}

export function timestampToEpochMs(timestamp: UtcTimestamp): number {
  return Date.parse(timestamp);
}

export function isAtOrAfter(
  timestamp: UtcTimestamp,
  boundary: UtcTimestamp,
): boolean {
  return timestampToEpochMs(timestamp) >= timestampToEpochMs(boundary);
}

export function addMilliseconds(
  timestamp: UtcTimestamp,
  milliseconds: number,
): Result<UtcTimestamp> {
  if (!Number.isSafeInteger(milliseconds)) {
    return fail(
      domainError("INVALID_TIMESTAMP", "milliseconds must be a safe integer", {
        field: "milliseconds",
      }),
    );
  }
  return timestampFromEpochMs(timestampToEpochMs(timestamp) + milliseconds);
}

export function fixedClock(value: unknown): Result<Clock> {
  const timestampResult = parseUtcTimestamp(value);
  if (!timestampResult.ok) return timestampResult;
  const timestamp = timestampResult.value;
  return ok(Object.freeze({ now: () => timestamp }));
}

export const systemClock: Clock = Object.freeze({
  now: () => new Date().toISOString() as UtcTimestamp,
});
