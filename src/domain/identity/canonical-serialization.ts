import { createHash } from "node:crypto";

import { isDecimalValue } from "../shared/decimal.js";
import { domainError } from "../shared/errors.js";
import { fail, ok, type Result } from "../shared/result.js";

export const CANONICAL_SERIALIZATION_VERSION = "canonical/v1";
export type PlanHash = string & { readonly __planHash: unique symbol };

function serializationFailure(message: string): Result<never> {
  return fail(domainError("INVALID_PLAN", message));
}

function hasAccessorProperty(value: object): boolean {
  return Object.values(Object.getOwnPropertyDescriptors(value)).some(
    (descriptor) => !Object.hasOwn(descriptor, "value"),
  );
}

function serializeValue(value: unknown, active: Set<object>): Result<string> {
  if (value === null) return ok("null");
  if (isDecimalValue(value)) {
    return ok(`{"$decimal":${JSON.stringify(value.toString())}}`);
  }
  switch (typeof value) {
    case "string":
      return ok(JSON.stringify(value.normalize("NFC")));
    case "boolean":
      return ok(value ? "true" : "false");
    case "number":
      if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
        return serializationFailure(
          "only finite safe integers can be canonicalized as numbers",
        );
      }
      return ok(JSON.stringify(value === 0 ? 0 : value));
    case "undefined":
      return serializationFailure(
        "undefined is not canonical; omit the field or use null",
      );
    case "bigint":
    case "function":
    case "symbol":
      return serializationFailure("unsupported value in canonical input");
    case "object":
      break;
    default:
      return serializationFailure("unsupported value in canonical input");
  }

  if (active.has(value))
    return serializationFailure("cyclic values are not canonical");
  active.add(value);
  try {
    if (hasAccessorProperty(value)) {
      return serializationFailure(
        "accessor properties are not canonical input",
      );
    }
    if (Array.isArray(value)) {
      const parts: string[] = [];
      for (const item of value) {
        const serialized = serializeValue(item, active);
        if (!serialized.ok) return serialized;
        parts.push(serialized.value);
      }
      return ok(`[${parts.join(",")}]`);
    }
    if (
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    ) {
      return serializationFailure("only plain objects can be canonicalized");
    }
    const record = value as Record<string, unknown>;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const entries = Object.keys(record)
      .map((key) => ({
        key: key.normalize("NFC"),
        entryValue: descriptors[key]?.value,
      }))
      .sort((left, right) =>
        left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
      );
    if (entries.some((entry) => entry.key === "$decimal")) {
      return serializationFailure(
        "reserved canonical key cannot appear in a plain object",
      );
    }
    if (entries.some((entry, index) => entry.key === entries[index - 1]?.key)) {
      return serializationFailure(
        "object keys collide after Unicode normalization",
      );
    }
    const parts: string[] = [];
    for (const entry of entries) {
      const serialized = serializeValue(entry.entryValue, active);
      if (!serialized.ok) return serialized;
      parts.push(`${JSON.stringify(entry.key)}:${serialized.value}`);
    }
    return ok(`{${parts.join(",")}}`);
  } finally {
    active.delete(value);
  }
}

export function canonicalSerialize(value: unknown): Result<string> {
  return serializeValue(value, new Set<object>());
}

export function hashCanonical(value: unknown): Result<PlanHash> {
  const serialized = canonicalSerialize(value);
  if (!serialized.ok) return serialized;
  const digest = createHash("sha256")
    .update(serialized.value, "utf8")
    .digest("hex");
  return ok(`sha256:${digest}` as PlanHash);
}
