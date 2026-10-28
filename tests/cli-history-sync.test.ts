import assert from "node:assert/strict";
import test from "node:test";

import {
  parseHistorySyncArgs,
  runHistorySyncCli,
} from "../src/cli/history-sync.js";
import { HISTORY_READ_SOURCES } from "../src/ports/history-read.js";
import type { HistorySyncReport } from "../src/application/history-ingestion.js";
import type { Result } from "../src/domain/shared/result.js";

function capture() {
  let value = "";
  return {
    output: {
      write: (text: string) => {
        value += text;
      },
    },
    get value() {
      return value;
    },
  };
}

function report(): HistorySyncReport {
  return {
    schemaVersion: "history-sync-report/v1",
    selection: "resume",
    status: "COMPLETE",
    scope: {
      exchange: "bybit",
      environment: "mainnet",
      accountId: `sha256:${"a".repeat(64)}`,
    },
    frozenUpperBoundMs: 1793188800000,
    elapsedMs: 100,
    getAttempts: 8,
    rowsReceived: 0,
    coverageLimitations: HISTORY_READ_SOURCES.map((source) => ({
      source,
      reasonCodes: ["TWO_YEAR_LOOKBACK_BOUNDARY"],
    })),
    sources: HISTORY_READ_SOURCES.map((source) => ({
      source,
      getAttempts: 1,
      pageRequests: 1,
      rowsReceived: 0,
      inserted: 0,
      duplicates: 0,
      conflicts: 0,
      unmatched: 0,
      gaps: 0,
      status: "traversed",
      lastFullyCoveredWindow: { fromMs: 1793102400000, toMs: 1793188800000 },
      reasonCodes: [],
    })),
    nextAction: "No pending windows.",
  };
}

test("no-argument CLI runs offline fixtures and never calls the live composition", async () => {
  const sink = capture();
  const code = await runHistorySyncCli([], {
    output: sink.output,
    runLive: async () => {
      throw new Error("live path must remain unused");
    },
  });
  assert.equal(code, 0);
  assert.match(sink.value, /MODE=OFFLINE_FIXTURE/u);
  assert.match(sink.value, /DATABASE=IN_MEMORY/u);
  assert.match(sink.value, /EXCHANGE_READS=0/u);
  assert.match(sink.value, /EXCHANGE_WRITES=0/u);
  assert.match(sink.value, /OPENING_BALANCE=UNKNOWN/u);
  assert.match(sink.value, /ACCOUNTING_READY=NOT_CLAIMED/u);
  assert.doesNotMatch(sink.value, /accountId|apiKey|apiSecret|https?:/iu);
});

test("live mode requires explicit environment, absolute database path and one selection", () => {
  assert.equal(parseHistorySyncArgs(["--mode", "live"]).kind, "invalid");
  assert.equal(
    parseHistorySyncArgs([
      "--mode",
      "live",
      "--environment",
      "mainnet",
      "--database",
      "relative.db",
      "--range",
      "resume",
    ]).kind,
    "invalid",
  );
  assert.equal(
    parseHistorySyncArgs([
      "--mode",
      "live",
      "--environment",
      "mainnet",
      "--database",
      "/tmp/history.db",
      "--range",
      "resume",
      "--max-gets",
      "101",
    ]).kind,
    "invalid",
  );
  const parsed = parseHistorySyncArgs([
    "--mode",
    "live",
    "--environment",
    "testnet",
    "--database",
    "/tmp/history.db",
    "--range",
    "resume",
    "--max-gets",
    "10",
  ]);
  assert.equal(parsed.kind, "live");
  if (parsed.kind === "live") {
    assert.equal(parsed.input.environment, "testnet");
    assert.equal(parsed.input.selection.kind, "resume");
    assert.equal(parsed.input.budget.maxGetAttempts, 10);
  }
});

test("live CLI forwards an explicit bounded request and prints only a compact report", async () => {
  const sink = capture();
  let passed = false;
  const code = await runHistorySyncCli(
    [
      "--mode",
      "live",
      "--environment",
      "mainnet",
      "--database",
      "/tmp/cli-history-test.db",
      "--range",
      "maximum-history",
      "--max-gets",
      "9",
    ],
    {
      output: sink.output,
      runLive: async (input) => {
        passed =
          input.environment === "mainnet" &&
          input.databasePath === "/tmp/cli-history-test.db" &&
          input.selection.kind === "maximum-history" &&
          input.budget?.maxGetAttempts === 9;
        return {
          ok: true,
          value: report(),
        } satisfies Result<HistorySyncReport>;
      },
    },
  );
  assert.equal(code, 0);
  assert.equal(passed, true);
  assert.match(sink.value, /MODE=LIVE/u);
  assert.match(sink.value, /GET_ATTEMPTS=8/u);
  assert.match(sink.value, /EXCHANGE_WRITES=0/u);
  assert.doesNotMatch(sink.value, /accountId|apiKey|apiSecret|https?:/iu);
});
