import { OPERATOR_MAINNET_TEST_POLICY_VERSION } from "../domain/execution/operator-mainnet-test-plan.js";
import { fail, type Result } from "../domain/shared/result.js";
import { domainError } from "../domain/shared/errors.js";
import {
  createHistoryAccountingScope,
  type HistoryAccountingScope,
} from "../domain/accounting/accounting-scope.js";
import { PROVISIONAL_M1_POLICY_VERSION } from "./policies/provisional-m1.js";

const OPERATOR_SCOPE = createHistoryAccountingScope({
  schemaVersion: "history-accounting-scope/v1",
  policyIdentity: "operator-mainnet-test",
  policyVersion: OPERATOR_MAINNET_TEST_POLICY_VERSION,
  productKind: "usdt-linear",
  accountingContractVersion: "native-currency-bridge/v1",
  nativeCurrencies: ["USDT"],
});

const PROVISIONAL_M1_SCOPE = createHistoryAccountingScope({
  schemaVersion: "history-accounting-scope/v1",
  policyIdentity: "provisional-m1",
  policyVersion: PROVISIONAL_M1_POLICY_VERSION,
  productKind: "usdt-linear",
  accountingContractVersion: "native-currency-bridge/v1",
  nativeCurrencies: ["USDT"],
});

function invalidPolicy(): Result<never> {
  return fail(
    domainError(
      "INVALID_ACCOUNTING",
      "accounting scope requires a supported policy version",
      { field: "policyVersion" },
    ),
  );
}

/** Resolve only the immutable accounting capability owned by a known policy. */
export function resolveHistoryAccountingScope(
  policyVersion: unknown,
): Result<HistoryAccountingScope> {
  if (typeof policyVersion !== "string") return invalidPolicy();
  if (policyVersion === OPERATOR_MAINNET_TEST_POLICY_VERSION) {
    return OPERATOR_SCOPE;
  }
  if (policyVersion === PROVISIONAL_M1_POLICY_VERSION) {
    return PROVISIONAL_M1_SCOPE;
  }
  return invalidPolicy();
}
