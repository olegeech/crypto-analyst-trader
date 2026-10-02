import { canonicalSerialize } from "../identity/canonical-serialization.js";
import {
  type DecimalValue,
  isDecimalValue,
  parseDecimal,
} from "../shared/decimal.js";
import { domainError } from "../shared/errors.js";
import { fail, ok, type Result } from "../shared/result.js";
import { isRecord, type UnknownRecord } from "../shared/validation.js";

export function invalidPlanning(
  message = "planning policy is invalid or unsupported",
): Result<never> {
  return fail(domainError("INVALID_PLAN", message));
}

/** Closed, plain data only: do not invoke accessors supplied as policy input. */
export function closedRecord(
  value: unknown,
  fields: readonly string[],
): value is UnknownRecord {
  if (
    !isRecord(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  )
    return false;
  return Reflect.ownKeys(value).every(
    (key) =>
      typeof key === "string" &&
      fields.includes(key) &&
      Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value"),
  );
}

export function planningDecimal(
  value: unknown,
  positive = false,
  maximum?: DecimalValue,
): Result<DecimalValue> {
  // Bound decimal input as well as collection sizes before expensive exact arithmetic.
  if (
    !isDecimalValue(value) &&
    (typeof value !== "string" || value.length > 128)
  )
    return invalidPlanning(
      "expected a bounded decimal string or domain Decimal",
    );
  const parsed = isDecimalValue(value) ? ok(value) : parseDecimal(value);
  if (
    !parsed.ok ||
    parsed.value.isNegative() ||
    (positive && !parsed.value.isPositive()) ||
    (maximum && parsed.value.compare(maximum) > 0) ||
    parsed.value.toString().length > 128
  )
    return invalidPlanning("decimal is outside the policy range");
  return parsed;
}

export function planningConstant(value: string): DecimalValue {
  const parsed = parseDecimal(value);
  if (!parsed.ok) throw new Error("invalid internal planning constant");
  return parsed.value;
}

export function boundedList(
  value: unknown,
  maximum: number,
): value is unknown[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= maximum &&
    Reflect.ownKeys(value).length === value.length + 1 &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every((d) =>
      Object.hasOwn(d, "value"),
    )
  );
}

export function textOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function canonicalOrder<T>(items: readonly T[]): Result<T[]> {
  const rows: { item: T; bytes: string }[] = [];
  for (const item of items) {
    const serialized = canonicalSerialize(item);
    if (!serialized.ok) return serialized;
    rows.push({ item, bytes: serialized.value });
  }
  rows.sort((a, b) => textOrder(a.bytes, b.bytes));
  return ok(
    rows.filter((r, i) => r.bytes !== rows[i - 1]?.bytes).map((r) => r.item),
  );
}
