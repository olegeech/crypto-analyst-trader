import assert from "node:assert/strict";
import test from "node:test";

import { resolveHistoryAccountingScope } from "../src/application/history-accounting-scope.js";
import { PROVISIONAL_M1_POLICY_VERSION } from "../src/application/policies/provisional-m1.js";
import { OPERATOR_MAINNET_TEST_POLICY_VERSION } from "../src/domain/execution/operator-mainnet-test-plan.js";
import { MARKET_EVIDENCE_SYMBOLS } from "../src/domain/market/market-evidence-bundle.js";
import type { Result } from "../src/domain/shared/result.js";
import type { HistoryAccountingScope } from "../src/domain/accounting/accounting-scope.js";

function value<T>(result: Result<T>): T {
  if (!result.ok)
    throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

test("both code-owned policy versions resolve immutable USDT-linear scopes", () => {
  const operator = value(
    resolveHistoryAccountingScope(OPERATOR_MAINNET_TEST_POLICY_VERSION),
  );
  const provisional = value(
    resolveHistoryAccountingScope(PROVISIONAL_M1_POLICY_VERSION),
  );

  assert.equal(operator.policyIdentity, "operator-mainnet-test");
  assert.equal(operator.policyVersion, OPERATOR_MAINNET_TEST_POLICY_VERSION);
  assert.equal(provisional.policyIdentity, "provisional-m1");
  assert.equal(provisional.policyVersion, PROVISIONAL_M1_POLICY_VERSION);
  assert.equal(
    operator.scopeHash,
    "sha256:85e4890595ca8d581f27c0d84cb073edf0fbb2ddb0f14bd598cffc0b5d0b4b31",
  );
  assert.equal(
    provisional.scopeHash,
    "sha256:8f3e86cb103f632f0173e2b55948d2edb2046b3c2957c47821289f9d1aec7b15",
  );
  for (const scope of [operator, provisional]) {
    assert.equal(scope.schemaVersion, "history-accounting-scope/v1");
    assert.equal(scope.productKind, "usdt-linear");
    assert.equal(scope.accountingContractVersion, "native-currency-bridge/v1");
    assert.deepEqual(scope.nativeCurrencies, ["USDT"]);
    assert.equal(Object.isFrozen(scope), true);
    assert.equal(Object.isFrozen(scope.nativeCurrencies), true);
  }
  assert.notEqual(operator.scopeHash, provisional.scopeHash);
});

test("scope resolution uses only policy identity and is repeatable", () => {
  const policyVersion = PROVISIONAL_M1_POLICY_VERSION;
  const first = value(resolveHistoryAccountingScope(policyVersion));
  const second = value(resolveHistoryAccountingScope(policyVersion));

  assert.strictEqual(first, second);
  assert.equal(first.nativeCurrencies.includes("MNT"), false);
  assert.equal(
    resolveHistoryAccountingScope({
      policyVersion,
      wallet: { MNT: "0" },
    }).ok,
    false,
  );
  assert.equal(
    resolveHistoryAccountingScope({
      policyVersion,
      wallet: { MNT: "27.5" },
    }).ok,
    false,
  );
  assert.equal(
    resolveHistoryAccountingScope({ policyVersion, savedOrderId: "order-1" })
      .ok,
    false,
  );
  assert.equal(
    resolveHistoryAccountingScope({ policyVersion, approval: "approval-1" }).ok,
    false,
  );
});

test("unknown policies and caller-supplied currency or exclusion overrides refuse", () => {
  assert.equal(resolveHistoryAccountingScope("unknown-policy/v1").ok, false);
  assert.equal(
    resolveHistoryAccountingScope({
      policyVersion: PROVISIONAL_M1_POLICY_VERSION,
      nativeCurrencies: ["MNT"],
    }).ok,
    false,
  );
  assert.equal(
    resolveHistoryAccountingScope({
      policyVersion: PROVISIONAL_M1_POLICY_VERSION,
      excludedCurrencies: ["MNT"],
    }).ok,
    false,
  );
});

test("descriptor stays pinned when the referenced market symbol universe changes", () => {
  const policyVersion = OPERATOR_MAINNET_TEST_POLICY_VERSION;
  const before = value(resolveHistoryAccountingScope(policyVersion));
  const expandedCapabilityReference = [...MARKET_EVIDENCE_SYMBOLS, "XRPUSDT"];
  assert.equal(
    expandedCapabilityReference.length,
    MARKET_EVIDENCE_SYMBOLS.length + 1,
  );

  const after = value(resolveHistoryAccountingScope(policyVersion));
  assert.deepEqual(after, before);
  assert.equal(
    "symbols" in (before as HistoryAccountingScope & Record<string, unknown>),
    false,
  );
});

test("scope resolution does not fabricate provider fee or instrument denomination evidence", () => {
  const scope = value(
    resolveHistoryAccountingScope(PROVISIONAL_M1_POLICY_VERSION),
  );
  const descriptor = scope as HistoryAccountingScope & Record<string, unknown>;

  assert.equal("feeCurrency" in descriptor, false);
  assert.equal("feeDenomination" in descriptor, false);
  assert.equal("instrumentSettlement" in descriptor, false);
  assert.equal("instrumentDenomination" in descriptor, false);
});

test("policy resolution rejects accessor inputs without evaluating them", () => {
  let invoked = false;
  const input = Object.defineProperty({}, "policyVersion", {
    enumerable: true,
    get() {
      invoked = true;
      throw new Error("policy accessor must not be invoked");
    },
  });

  assert.equal(resolveHistoryAccountingScope(input).ok, false);
  assert.equal(invoked, false);
});
