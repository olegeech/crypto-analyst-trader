import assert from "node:assert/strict";
import test from "node:test";

import {
  createHistoryAccountingScope,
  decodeHistoryAccountingScope,
} from "../src/domain/accounting/accounting-scope.js";
import { OPERATOR_MAINNET_TEST_POLICY_VERSION } from "../src/domain/execution/operator-mainnet-test-plan.js";
import { PROVISIONAL_M1_POLICY_VERSION } from "../src/application/policies/provisional-m1.js";
import type { Result } from "../src/domain/shared/result.js";

function value<T>(result: Result<T>): T {
  if (!result.ok)
    throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function scopeInput(
  overrides: Partial<{
    policyIdentity: string;
    policyVersion: string;
    nativeCurrencies: readonly string[];
  }> = {},
) {
  return {
    schemaVersion: "history-accounting-scope/v1",
    policyIdentity: "operator-mainnet-test",
    policyVersion: OPERATOR_MAINNET_TEST_POLICY_VERSION,
    productKind: "usdt-linear",
    accountingContractVersion: "native-currency-bridge/v1",
    nativeCurrencies: ["USDT"],
    ...overrides,
  };
}

test("scope creation canonicalizes duplicate currencies and binds policy identity", () => {
  const canonical = value(createHistoryAccountingScope(scopeInput()));
  const duplicated = value(
    createHistoryAccountingScope(
      scopeInput({ nativeCurrencies: ["USDT", "USDT"] }),
    ),
  );

  assert.deepEqual(duplicated, canonical);
  assert.deepEqual(canonical.nativeCurrencies, ["USDT"]);
  assert.equal(canonical.schemaVersion, "history-accounting-scope/v1");
  assert.equal(canonical.productKind, "usdt-linear");
  assert.equal(
    canonical.accountingContractVersion,
    "native-currency-bridge/v1",
  );
  assert.equal(canonical.policyVersion, OPERATOR_MAINNET_TEST_POLICY_VERSION);
  assert.equal(Object.isFrozen(canonical), true);
  assert.equal(Object.isFrozen(canonical.nativeCurrencies), true);

  const otherPolicy = value(
    createHistoryAccountingScope(
      scopeInput({
        policyIdentity: "provisional-m1",
        policyVersion: PROVISIONAL_M1_POLICY_VERSION,
      }),
    ),
  );
  assert.notEqual(otherPolicy.scopeHash, canonical.scopeHash);
});

test("scope decoder accepts canonical descriptors and rejects a tampered hash", () => {
  const scope = value(createHistoryAccountingScope(scopeInput()));
  assert.deepEqual(value(decodeHistoryAccountingScope(scope)), scope);

  const tampered = { ...scope, policyVersion: PROVISIONAL_M1_POLICY_VERSION };
  assert.equal(decodeHistoryAccountingScope(tampered).ok, false);
});

test("scope validation rejects arbitrary currencies and unknown descriptor fields", () => {
  assert.equal(
    createHistoryAccountingScope(
      scopeInput({ nativeCurrencies: ["USDT", "MNT"] }),
    ).ok,
    false,
  );
  assert.equal(
    createHistoryAccountingScope({
      ...scopeInput(),
      excludedCurrencies: ["MNT"],
    }).ok,
    false,
  );

  const scope = value(createHistoryAccountingScope(scopeInput()));
  assert.equal(
    decodeHistoryAccountingScope({ ...scope, excludedCurrencies: ["MNT"] }).ok,
    false,
  );
});

test("scope validation rejects accessors and non-plain descriptor objects without invoking accessors", () => {
  const scope = value(createHistoryAccountingScope(scopeInput()));
  let invoked = false;
  const accessor = { ...scope } as Record<string, unknown>;
  Object.defineProperty(accessor, "policyVersion", {
    enumerable: true,
    get() {
      invoked = true;
      throw new Error("scope accessor must not be invoked");
    },
  });

  assert.equal(decodeHistoryAccountingScope(accessor).ok, false);
  assert.equal(invoked, false);

  const inherited = Object.assign(
    Object.create({ injected: true }) as Record<string, unknown>,
    scope,
  );
  assert.equal(decodeHistoryAccountingScope(inherited).ok, false);

  const malformedCurrencies = { ...scope, nativeCurrencies: new Array(1) };
  assert.equal(decodeHistoryAccountingScope(malformedCurrencies).ok, false);
});

test("current policy descriptor hashes remain golden", () => {
  const operator = value(createHistoryAccountingScope(scopeInput()));
  const provisional = value(
    createHistoryAccountingScope(
      scopeInput({
        policyIdentity: "provisional-m1",
        policyVersion: PROVISIONAL_M1_POLICY_VERSION,
      }),
    ),
  );

  assert.equal(
    operator.scopeHash,
    "sha256:85e4890595ca8d581f27c0d84cb073edf0fbb2ddb0f14bd598cffc0b5d0b4b31",
  );
  assert.equal(
    provisional.scopeHash,
    "sha256:8f3e86cb103f632f0173e2b55948d2edb2046b3c2957c47821289f9d1aec7b15",
  );
  assert.deepEqual(operator, {
    schemaVersion: "history-accounting-scope/v1",
    policyIdentity: "operator-mainnet-test",
    policyVersion: "operator-mainnet-test/v1",
    productKind: "usdt-linear",
    accountingContractVersion: "native-currency-bridge/v1",
    nativeCurrencies: ["USDT"],
    scopeHash:
      "sha256:85e4890595ca8d581f27c0d84cb073edf0fbb2ddb0f14bd598cffc0b5d0b4b31",
  });
  assert.deepEqual(provisional, {
    schemaVersion: "history-accounting-scope/v1",
    policyIdentity: "provisional-m1",
    policyVersion: "provisional-m1-v1",
    productKind: "usdt-linear",
    accountingContractVersion: "native-currency-bridge/v1",
    nativeCurrencies: ["USDT"],
    scopeHash:
      "sha256:8f3e86cb103f632f0173e2b55948d2edb2046b3c2957c47821289f9d1aec7b15",
  });
  assert.deepEqual(
    Object.keys(operator).sort(),
    [
      "accountingContractVersion",
      "nativeCurrencies",
      "policyIdentity",
      "policyVersion",
      "productKind",
      "schemaVersion",
      "scopeHash",
    ].sort(),
  );
  assert.deepEqual(operator.nativeCurrencies, ["USDT"]);
  assert.deepEqual(provisional.nativeCurrencies, ["USDT"]);
});
