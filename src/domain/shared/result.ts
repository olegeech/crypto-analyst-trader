import type { DomainError } from "./errors.js";

export type Result<T, E extends DomainError = DomainError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function fail<T = never>(error: DomainError): Result<T> {
  return { ok: false, error };
}

export function mapResult<T, U>(
  result: Result<T>,
  mapper: (value: T) => U,
): Result<U> {
  return result.ok ? ok(mapper(result.value)) : result;
}
