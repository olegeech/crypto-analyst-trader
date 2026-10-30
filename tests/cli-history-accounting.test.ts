import assert from "node:assert/strict";
import test from "node:test";

import { runHistoryAccountingCli } from "../src/cli/history-accounting.js";
import {
  createHistoryAccountingReport,
  encodeHistoryAccountingReport,
} from "../src/application/history-accounting-report.js";
import { resolveHistoryAccountingScope } from "../src/application/history-accounting-scope.js";
import { OPERATOR_MAINNET_TEST_POLICY_VERSION } from "../src/domain/execution/operator-mainnet-test-plan.js";
import {
  completeReportInput,
  capturedWalletAnchorForStoreTest,
  historyAccountingScope,
} from "./history-accounting-fixtures.js";

function outputBuffer() {
  let value = "";
  return {
    output: {
      write: (text: string) => {
        value += text;
      },
    },
    read: () => value,
  };
}

function mixedAssetInput() {
  const base = completeReportInput();
  const openingMnt = {
    ...base.opening.assets[0]!,
    coin: "MNT",
  };
  const closingMnt = {
    ...openingMnt,
    walletBalance: { ...openingMnt.walletBalance },
  };
  return {
    ...base,
    opening: capturedWalletAnchorForStoreTest({
      ...base.opening,
      assets: [...base.opening.assets, openingMnt],
    }),
    closing: capturedWalletAnchorForStoreTest({
      ...base.closing,
      assets: [...base.closing.assets, closingMnt],
    }),
  };
}

test("CLI rejects incomplete and unknown flags without invoking either operation", async () => {
  const capture = outputBuffer();
  let calls = 0;
  const exit = await runHistoryAccountingCli(
    [
      "--mode",
      "reconcile",
      "--environment",
      "mainnet",
      "--database",
      "/tmp/a.db",
      "--unknown",
      "x",
    ],
    {
      output: capture.output,
      capture: async () => {
        calls += 1;
        throw new Error("unexpected capture");
      },
      reconcile: () => {
        calls += 1;
        throw new Error("unexpected reconcile");
      },
    },
  );
  assert.equal(exit, 2);
  assert.equal(calls, 0);
  assert.match(capture.read(), /STATUS=BLOCKED/u);
  assert.match(capture.read(), /EXCHANGE_WRITES=0/u);
});

test("CLI rejects unknown accounting policies before calling reconciliation", async () => {
  const capture = outputBuffer();
  let calls = 0;
  const exit = await runHistoryAccountingCli(
    [
      "--mode",
      "reconcile",
      "--environment",
      "mainnet",
      "--database",
      "/tmp/a.db",
      "--opening-anchor-id",
      "opening",
      "--closing-anchor-id",
      "closing",
      "--accounting-policy",
      "usdc-linear/v1",
    ],
    {
      output: capture.output,
      reconcile: () => {
        calls += 1;
        throw new Error("must not reconcile unsupported policy");
      },
    },
  );
  assert.equal(exit, 2);
  assert.equal(calls, 0);
  assert.match(capture.read(), /REASON=INVALID_REQUEST/u);
  assert.match(capture.read(), /EXCHANGE_WRITES=0/u);
});

test("reconcile CLI reports bounded result locally without exchange access or account identifiers", async () => {
  const capture = outputBuffer();
  const report = createHistoryAccountingReport(completeReportInput());
  assert.equal(report.ok, true);
  if (!report.ok) return;
  const exit = await runHistoryAccountingCli(
    [
      "--mode",
      "reconcile",
      "--environment",
      "demo",
      "--database",
      "/tmp/local.db",
      "--opening-anchor-id",
      report.value.epoch.epoch.openingAnchorId,
      "--closing-anchor-id",
      report.value.epoch.epoch.closingAnchorId,
    ],
    {
      output: capture.output,
      reconcile: async () => report,
      capture: async () => {
        throw new Error("must not capture");
      },
    },
  );
  assert.equal(exit, 0);
  assert.match(capture.read(), /STATUS=ACCOUNTING_READY/u);
  assert.match(capture.read(), /EXCHANGE_READS=0/u);
  assert.match(capture.read(), /EXCHANGE_WRITES=0/u);
  assert.equal(
    capture.read().includes(historyAccountingScope.accountId),
    false,
  );
});

test("scoped CLI output identifies policy and excluded anchor assets without claiming whole-account readiness", async () => {
  const capture = outputBuffer();
  const accountingScope = resolveHistoryAccountingScope(
    OPERATOR_MAINNET_TEST_POLICY_VERSION,
  );
  assert.equal(accountingScope.ok, true);
  if (!accountingScope.ok) return;
  const report = createHistoryAccountingReport({
    ...mixedAssetInput(),
    accountingScope: accountingScope.value,
  });
  assert.equal(report.ok, true, report.ok ? "" : report.error.message);
  if (!report.ok) return;
  let selectedPolicy: string | undefined;
  const exit = await runHistoryAccountingCli(
    [
      "--mode",
      "reconcile",
      "--environment",
      "demo",
      "--database",
      "/tmp/local.db",
      "--opening-anchor-id",
      report.value.epoch.epoch.openingAnchorId,
      "--closing-anchor-id",
      report.value.epoch.epoch.closingAnchorId,
      "--accounting-policy",
      OPERATOR_MAINNET_TEST_POLICY_VERSION,
    ],
    {
      output: capture.output,
      reconcile: async (input) => {
        selectedPolicy = input.accountingPolicyVersion;
        return report;
      },
    },
  );
  assert.equal(exit, 0);
  assert.equal(selectedPolicy, OPERATOR_MAINNET_TEST_POLICY_VERSION);
  assert.match(
    capture.read(),
    /REPORT_CONTRACT=history-accounting-reconciliation-report\/v2/u,
  );
  assert.match(
    capture.read(),
    new RegExp(
      `ACCOUNTING_POLICY_VERSION=${OPERATOR_MAINNET_TEST_POLICY_VERSION}`,
    ),
  );
  assert.match(capture.read(), /INCLUDED_CURRENCIES=USDT/u);
  assert.match(capture.read(), /EXCLUDED_ANCHOR_CURRENCIES=MNT/u);
  assert.match(capture.read(), /EXCLUDED_ANCHOR_CURRENCY_COUNT=1/u);
  assert.match(capture.read(), /EXCLUDED_ANCHOR_CURRENCIES_TRUNCATED=NO/u);
  assert.match(capture.read(), /WHOLE_ACCOUNT_RECONCILIATION=UNCLAIMED/u);
  assert.match(capture.read(), /EXCHANGE_READS=0/u);
  assert.match(capture.read(), /EXCHANGE_WRITES=0/u);
});

test("scoped CLI labels a truncated excluded-anchor sample with its full count", async () => {
  const capture = outputBuffer();
  const accountingScope = resolveHistoryAccountingScope(
    OPERATOR_MAINNET_TEST_POLICY_VERSION,
  );
  assert.equal(accountingScope.ok, true);
  if (!accountingScope.ok) return;

  const base = mixedAssetInput();
  const template = base.opening.assets[0]!;
  const technicalAssets = Array.from({ length: 128 }, (_, index) => ({
    ...template,
    coin: `TECH${String(index).padStart(3, "0")}`,
  }));
  const input = {
    ...base,
    opening: capturedWalletAnchorForStoreTest({
      ...base.opening,
      assets: [...base.opening.assets, ...technicalAssets],
    }),
    closing: capturedWalletAnchorForStoreTest({
      ...base.closing,
      assets: [...base.closing.assets, ...technicalAssets],
    }),
  };
  const report = createHistoryAccountingReport({
    ...input,
    accountingScope: accountingScope.value,
  });
  assert.equal(report.ok, true, report.ok ? "" : report.error.message);
  if (!report.ok) return;

  const exit = await runHistoryAccountingCli(
    [
      "--mode",
      "reconcile",
      "--environment",
      "demo",
      "--database",
      "/tmp/local.db",
      "--opening-anchor-id",
      report.value.epoch.epoch.openingAnchorId,
      "--closing-anchor-id",
      report.value.epoch.epoch.closingAnchorId,
      "--accounting-policy",
      OPERATOR_MAINNET_TEST_POLICY_VERSION,
    ],
    {
      output: capture.output,
      reconcile: async () => report,
    },
  );

  assert.equal(exit, 0);
  assert.match(capture.read(), /EXCLUDED_ANCHOR_CURRENCY_COUNT=129/u);
  assert.match(capture.read(), /EXCLUDED_ANCHOR_CURRENCIES_TRUNCATED=YES/u);
  assert.match(capture.read(), /WHOLE_ACCOUNT_RECONCILIATION=UNCLAIMED/u);
});

test("CLI accepts the second known USDT policy as an explicit scoped selector", async () => {
  const capture = outputBuffer();
  const policyVersion = "provisional-m1-v1";
  const accountingScope = resolveHistoryAccountingScope(policyVersion);
  assert.equal(accountingScope.ok, true);
  if (!accountingScope.ok) return;
  const report = createHistoryAccountingReport({
    ...mixedAssetInput(),
    accountingScope: accountingScope.value,
  });
  assert.equal(report.ok, true, report.ok ? "" : report.error.message);
  if (!report.ok) return;
  let selectedPolicy: string | undefined;
  const exit = await runHistoryAccountingCli(
    [
      "--mode",
      "reconcile",
      "--environment",
      "demo",
      "--database",
      "/tmp/local.db",
      "--opening-anchor-id",
      report.value.epoch.epoch.openingAnchorId,
      "--closing-anchor-id",
      report.value.epoch.epoch.closingAnchorId,
      "--accounting-policy",
      policyVersion,
    ],
    {
      output: capture.output,
      reconcile: async (input) => {
        selectedPolicy = input.accountingPolicyVersion;
        return report;
      },
    },
  );
  assert.equal(exit, 0);
  assert.equal(selectedPolicy, policyVersion);
  assert.match(capture.read(), /ACCOUNTING_POLICY_VERSION=provisional-m1-v1/u);
  assert.match(capture.read(), /WHOLE_ACCOUNT_RECONCILIATION=UNCLAIMED/u);
  assert.match(capture.read(), /EXCHANGE_WRITES=0/u);
});

test("legacy unsupported-currency result suggests explicit scoped selection without changing the v1 report", async () => {
  const capture = outputBuffer();
  const input = mixedAssetInput();
  const report = createHistoryAccountingReport(input);
  assert.equal(report.ok, true, report.ok ? "" : report.error.message);
  if (!report.ok) return;
  assert.equal(
    report.value.schemaVersion,
    "history-accounting-reconciliation-report/v1",
  );
  assert.equal(report.value.status, "NOT_READY");
  assert.ok(report.value.epoch.reasonCodes.includes("UNSUPPORTED_CURRENCY"));
  const before = encodeHistoryAccountingReport(report.value);
  assert.equal(before.ok, true);
  if (!before.ok) return;

  const exit = await runHistoryAccountingCli(
    [
      "--mode",
      "reconcile",
      "--environment",
      "demo",
      "--database",
      "/tmp/local.db",
      "--opening-anchor-id",
      report.value.epoch.epoch.openingAnchorId,
      "--closing-anchor-id",
      report.value.epoch.epoch.closingAnchorId,
    ],
    { output: capture.output, reconcile: async () => report },
  );
  const after = encodeHistoryAccountingReport(report.value);
  assert.equal(exit, 4);
  assert.match(capture.read(), /SCOPED_SELECTOR_HINT=.*--accounting-policy/u);
  assert.match(capture.read(), /WHOLE_ACCOUNT_RECONCILIATION=NOT_READY/u);
  assert.equal(
    after.ok && after.value.canonicalJson,
    before.value.canonicalJson,
  );
});

test("capture CLI keeps GET count visible but does not print account or balance evidence", async () => {
  const capture = outputBuffer();
  const anchor = completeReportInput().opening;
  const exit = await runHistoryAccountingCli(
    [
      "--mode",
      "capture-anchor",
      "--environment",
      "demo",
      "--database",
      "/tmp/local.db",
      "--kind",
      "opening",
    ],
    {
      output: capture.output,
      capture: async () => ({ ok: true, value: { anchor, getAttempts: 5 } }),
      reconcile: () => {
        throw new Error("must not reconcile");
      },
    },
  );
  assert.equal(exit, 0);
  assert.match(capture.read(), /STATUS=RECORDED/u);
  assert.ok(
    capture
      .read()
      .includes(`PROVIDER_TIME_BEFORE=${anchor.capture.providerTimeBefore}`),
  );
  assert.match(capture.read(), /EXCHANGE_READS=5/u);
  assert.ok(
    capture
      .read()
      .includes(`PROVIDER_TIME_AFTER=${anchor.capture.providerTimeAfter}`),
  );
  assert.match(capture.read(), /EXCHANGE_WRITES=0/u);
  assert.equal(
    capture.read().includes(historyAccountingScope.accountId),
    false,
  );
  assert.equal(capture.read().includes("100"), false);
});
