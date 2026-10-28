import assert from "node:assert/strict";
import test from "node:test";

import { runHistoryAccountingCli } from "../src/cli/history-accounting.js";
import { createHistoryAccountingReport } from "../src/application/history-accounting-report.js";
import {
  completeReportInput,
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
  assert.match(capture.read(), /EXCHANGE_READS=5/u);
  assert.match(capture.read(), /EXCHANGE_WRITES=0/u);
  assert.equal(
    capture.read().includes(historyAccountingScope.accountId),
    false,
  );
  assert.equal(capture.read().includes("100"), false);
});
