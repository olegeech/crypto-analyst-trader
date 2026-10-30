import {
  hashCanonical,
  type PlanHash,
} from "../identity/canonical-serialization.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { domainError } from "../shared/errors.js";
import { fail, ok, type Result } from "../shared/result.js";
import { requireHash } from "../shared/validation.js";

export const HISTORY_ACCOUNTING_SCOPE_SCHEMA_VERSION =
  "history-accounting-scope/v1" as const;
export const HISTORY_ACCOUNTING_SCOPE_PRODUCT_KIND = "usdt-linear" as const;
export const HISTORY_ACCOUNTING_CONTRACT_VERSION =
  "native-currency-bridge/v1" as const;
export const HISTORY_ACCOUNTING_NATIVE_CURRENCY = "USDT" as const;

export interface HistoryAccountingScopePayload {
  readonly schemaVersion: typeof HISTORY_ACCOUNTING_SCOPE_SCHEMA_VERSION;
  readonly policyIdentity: string;
  readonly policyVersion: string;
  readonly productKind: typeof HISTORY_ACCOUNTING_SCOPE_PRODUCT_KIND;
  readonly accountingContractVersion: typeof HISTORY_ACCOUNTING_CONTRACT_VERSION;
  readonly nativeCurrencies: readonly string[];
}

export interface HistoryAccountingScope extends HistoryAccountingScopePayload {
  readonly scopeHash: PlanHash;
}

const CREATE_FIELDS = [
  "schemaVersion",
  "policyIdentity",
  "policyVersion",
  "productKind",
  "accountingContractVersion",
  "nativeCurrencies",
] as const;
const DESCRIPTOR_FIELDS = [...CREATE_FIELDS, "scopeHash"] as const;
const CURRENCY_ARRAY_MAX_LENGTH = 32;

function invalid(message: string, field?: string): Result<never> {
  return fail(
    domainError(
      "INVALID_ACCOUNTING",
      message,
      field === undefined ? undefined : { field },
    ),
  );
}

type DataRecord = Readonly<Record<string, unknown>>;

/** Read only own enumerable data properties; never evaluate caller getters. */
function readClosedDataRecord(
  value: unknown,
  allowedKeys: readonly string[],
): Result<DataRecord> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid("accounting scope must be a plain object");
  }

  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return invalid("accounting scope must be a plain object");
    }

    const keys = Reflect.ownKeys(value);
    if (
      keys.some((key) => typeof key !== "string") ||
      keys.some(
        (key) => typeof key === "string" && !allowedKeys.includes(key),
      ) ||
      allowedKeys.some((key) => !keys.includes(key))
    ) {
      return invalid("accounting scope has missing or unknown fields");
    }

    const descriptors = Object.getOwnPropertyDescriptors(value);
    const record: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const key of allowedKeys) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !Object.hasOwn(descriptor, "value") ||
        descriptor.enumerable !== true
      ) {
        return invalid("accounting scope fields must be enumerable data", key);
      }
      record[key] = descriptor.value;
    }
    return ok(record);
  } catch {
    return invalid("accounting scope could not be inspected safely");
  }
}

function readCurrencyArray(value: unknown): Result<readonly string[]> {
  if (!Array.isArray(value)) {
    return invalid("nativeCurrencies must be an array", "nativeCurrencies");
  }

  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      return invalid(
        "nativeCurrencies must be a plain array",
        "nativeCurrencies",
      );
    }

    const keys = Reflect.ownKeys(value);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      lengthDescriptor === undefined ||
      !Object.hasOwn(lengthDescriptor, "value") ||
      typeof lengthDescriptor.value !== "number" ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 1 ||
      lengthDescriptor.value > CURRENCY_ARRAY_MAX_LENGTH ||
      keys.length !== lengthDescriptor.value + 1 ||
      !keys.includes("length") ||
      keys.some(
        (key) =>
          typeof key !== "string" ||
          (key !== "length" && !/^(0|[1-9][0-9]*)$/u.test(key)),
      )
    ) {
      return invalid(
        "nativeCurrencies must be a dense plain array",
        "nativeCurrencies",
      );
    }

    const currencies: string[] = [];
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined ||
        !Object.hasOwn(descriptor, "value") ||
        descriptor.enumerable !== true ||
        typeof descriptor.value !== "string"
      ) {
        return invalid(
          "nativeCurrencies must contain data strings",
          "nativeCurrencies",
        );
      }
      currencies.push(descriptor.value);
    }
    return ok(currencies);
  } catch {
    return invalid(
      "nativeCurrencies could not be inspected safely",
      "nativeCurrencies",
    );
  }
}

function validatePolicyIdentity(value: unknown): Result<string> {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z][A-Za-z0-9.-]{0,63}$/u.test(value)
  ) {
    return invalid("policyIdentity is invalid", "policyIdentity");
  }
  return ok(value);
}

function validatePolicyVersion(value: unknown): Result<string> {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(value)
  ) {
    return invalid("policyVersion is invalid", "policyVersion");
  }
  return ok(value);
}

function validateFixedFields(
  record: DataRecord,
): Result<{ readonly policyIdentity: string; readonly policyVersion: string }> {
  if (record.schemaVersion !== HISTORY_ACCOUNTING_SCOPE_SCHEMA_VERSION) {
    return invalid("unsupported accounting scope schema", "schemaVersion");
  }
  const policyIdentity = validatePolicyIdentity(record.policyIdentity);
  if (!policyIdentity.ok) return policyIdentity;
  const policyVersion = validatePolicyVersion(record.policyVersion);
  if (!policyVersion.ok) return policyVersion;
  if (record.productKind !== HISTORY_ACCOUNTING_SCOPE_PRODUCT_KIND) {
    return invalid("unsupported accounting product kind", "productKind");
  }
  if (
    record.accountingContractVersion !== HISTORY_ACCOUNTING_CONTRACT_VERSION
  ) {
    return invalid(
      "unsupported accounting contract version",
      "accountingContractVersion",
    );
  }
  return ok({
    policyIdentity: policyIdentity.value,
    policyVersion: policyVersion.value,
  });
}

function canonicalCurrencies(
  parsed: readonly string[],
): Result<readonly string[]> {
  if (
    parsed.some((currency) => currency !== HISTORY_ACCOUNTING_NATIVE_CURRENCY)
  ) {
    return invalid(
      "this accounting contract supports only native USDT",
      "nativeCurrencies",
    );
  }
  return ok(
    [...new Set(parsed)].sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );
}

function canonicalPayload(
  record: DataRecord,
  canonicalizeCurrencies: boolean,
): Result<HistoryAccountingScopePayload> {
  const fixed = validateFixedFields(record);
  if (!fixed.ok) return fixed;
  const rawCurrencies = readCurrencyArray(record.nativeCurrencies);
  if (!rawCurrencies.ok) return rawCurrencies;
  const currencies = canonicalCurrencies(rawCurrencies.value);
  if (!currencies.ok) return currencies;
  if (
    !canonicalizeCurrencies &&
    (currencies.value.length !== rawCurrencies.value.length ||
      currencies.value.some(
        (currency, index) => currency !== rawCurrencies.value[index],
      ))
  ) {
    return invalid(
      "nativeCurrencies must be sorted and unique",
      "nativeCurrencies",
    );
  }

  return ok({
    schemaVersion: HISTORY_ACCOUNTING_SCOPE_SCHEMA_VERSION,
    policyIdentity: fixed.value.policyIdentity,
    policyVersion: fixed.value.policyVersion,
    productKind: HISTORY_ACCOUNTING_SCOPE_PRODUCT_KIND,
    accountingContractVersion: HISTORY_ACCOUNTING_CONTRACT_VERSION,
    nativeCurrencies: currencies.value,
  });
}

/** Create the canonical, immutable domain value for a code-owned policy scope. */
export function createHistoryAccountingScope(
  input: unknown,
): Result<HistoryAccountingScope> {
  const record = readClosedDataRecord(input, CREATE_FIELDS);
  if (!record.ok) return record;
  const payload = canonicalPayload(record.value, true);
  if (!payload.ok) return payload;
  const scopeHash = hashCanonical(payload.value);
  if (!scopeHash.ok) return scopeHash;
  return ok(
    deepFreeze({
      ...payload.value,
      scopeHash: scopeHash.value,
    }),
  );
}

/** Validate and rehydrate a canonical scope descriptor at an untrusted boundary. */
export function decodeHistoryAccountingScope(
  input: unknown,
): Result<HistoryAccountingScope> {
  const record = readClosedDataRecord(input, DESCRIPTOR_FIELDS);
  if (!record.ok) return record;
  const payload = canonicalPayload(record.value, false);
  if (!payload.ok) return payload;
  const declaredHash = requireHash(record.value.scopeHash, "scopeHash");
  if (!declaredHash.ok) return declaredHash;
  const actualHash = hashCanonical(payload.value);
  if (!actualHash.ok) return actualHash;
  if (declaredHash.value !== actualHash.value) {
    return fail(
      domainError(
        "PLAN_HASH_MISMATCH",
        "accounting scope hash does not match its descriptor",
        { field: "scopeHash" },
      ),
    );
  }
  return ok(
    deepFreeze({
      ...payload.value,
      scopeHash: declaredHash.value as PlanHash,
    }),
  );
}
