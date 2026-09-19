import { domainError } from "./errors.js";
import { fail, ok, type Result } from "./result.js";

export type UnknownRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireString(value: unknown, field: string): Result<string> {
  if (typeof value !== "string") {
    return fail(
      domainError("INVALID_VALUE", `${field} must be a string`, { field }),
    );
  }
  return ok(value);
}

export function requireSafeText(value: unknown, field: string): Result<string> {
  const stringResult = requireString(value, field);
  if (!stringResult.ok) return stringResult;
  if (stringResult.value.length === 0) {
    return fail(
      domainError("INVALID_TEXT", `${field} must not be empty`, { field }),
    );
  }
  if (/[\u0000-\u001f\u007f]/u.test(stringResult.value)) {
    return fail(
      domainError("INVALID_TEXT", `${field} contains control characters`, {
        field,
      }),
    );
  }
  return ok(stringResult.value.normalize("NFC"));
}

export function requireIdentifier(
  value: unknown,
  field: string,
): Result<string> {
  const textResult = requireString(value, field);
  if (!textResult.ok) {
    return fail(
      domainError("INVALID_IDENTIFIER", `${field} must be an identifier`, {
        field,
      }),
    );
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(textResult.value)) {
    return fail(
      domainError("INVALID_IDENTIFIER", `${field} is not a safe identifier`, {
        field,
      }),
    );
  }
  return ok(textResult.value);
}

export function requireHash(value: unknown, field: string): Result<string> {
  const stringResult = requireString(value, field);
  if (!stringResult.ok || !/^sha256:[0-9a-f]{64}$/u.test(stringResult.value)) {
    return fail(
      domainError("INVALID_HASH", `${field} must be a SHA-256 hash`, { field }),
    );
  }
  return ok(stringResult.value);
}

export function requireFiniteInteger(
  value: unknown,
  field: string,
  minimum = 0,
): Result<number> {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    return fail(
      domainError("INVALID_VALUE", `${field} must be a safe integer`, {
        field,
      }),
    );
  }
  return ok(value);
}

export function required<T>(
  record: UnknownRecord,
  field: string,
  parser: (value: unknown, field: string) => Result<T>,
): Result<T> {
  if (!(field in record)) {
    return fail(
      domainError("INVALID_VALUE", `${field} is required`, { field }),
    );
  }
  return parser(record[field], field);
}
