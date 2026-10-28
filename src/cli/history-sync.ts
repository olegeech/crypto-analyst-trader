import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

import {
  createHistoryFixturePage,
  runHistoryIngestion,
  validateHistorySyncBudget,
  type HistorySyncBudget,
  type HistorySyncReport,
  type HistorySyncSelection,
} from "../application/history-ingestion.js";
import { runLiveHistorySync } from "../application/history-ingestion-composition.js";
import { createSqliteHistoryStore } from "../adapters/sqlite/history-store.js";
import { applyMigrations } from "../adapters/sqlite/migrations.js";
import { registerTrustedClock } from "../adapters/sqlite/sqlite-helpers.js";
import type { SqliteConnection } from "../adapters/sqlite/connection.js";
import { domainError } from "../domain/shared/errors.js";
import { fail, type Result } from "../domain/shared/result.js";
import { timestampFromEpochMs } from "../domain/shared/time.js";
import type { CredentialEnvironment } from "../ports/credential-provider.js";

export const HISTORY_SYNC_USAGE = `Usage:
  npm run history:sync
  npm run history:sync -- --mode live --environment <demo|testnet|mainnet> --database <absolute-path> --range <maximum-history|resume>
  npm run history:sync -- --mode live --environment <demo|testnet|mainnet> --database <absolute-path> --from-ms <epoch-ms> --to-ms <epoch-ms> [--replay-id <id>]

Optional bounded overrides: --max-gets <1..100> --max-duration-ms <1..60000>
  --max-pages-per-window <1..20> --max-rows <1..10000>`;

export interface HistorySyncCliOutput {
  write(text: string): void;
}

interface ParsedLive {
  readonly kind: "live";
  readonly input: {
    readonly environment: CredentialEnvironment;
    readonly databasePath: string;
    readonly selection: HistorySyncSelection;
    readonly budget: HistorySyncBudget;
  };
}

export type ParsedHistorySyncArgs =
  | { readonly kind: "offline-fixture" }
  | ParsedLive
  | { readonly kind: "help" }
  | { readonly kind: "invalid" };

function integer(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function parseHistorySyncArgs(
  argv: readonly string[],
): ParsedHistorySyncArgs {
  if (argv.length === 0) return { kind: "offline-fixture" };
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h"))
    return { kind: "help" };
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (
      key === undefined ||
      value === undefined ||
      !key.startsWith("--") ||
      values.has(key)
    )
      return { kind: "invalid" };
    values.set(key, value);
  }
  const known = new Set([
    "--mode",
    "--environment",
    "--database",
    "--range",
    "--from-ms",
    "--to-ms",
    "--replay-id",
    "--max-gets",
    "--max-duration-ms",
    "--max-pages-per-window",
    "--max-rows",
  ]);
  if ([...values.keys()].some((key) => !known.has(key)))
    return { kind: "invalid" };
  if (values.get("--mode") === "fixture")
    return values.size === 1
      ? { kind: "offline-fixture" }
      : { kind: "invalid" };
  if (values.get("--mode") !== "live") return { kind: "invalid" };
  const environment = values.get("--environment");
  const databasePath = values.get("--database");
  if (
    (environment !== "demo" &&
      environment !== "testnet" &&
      environment !== "mainnet") ||
    databasePath === undefined ||
    !isAbsolute(databasePath) ||
    databasePath.length > 2_048 ||
    /[\u0000-\u001f\u007f]/u.test(databasePath)
  )
    return { kind: "invalid" };
  let selection: HistorySyncSelection;
  const range = values.get("--range");
  const fromMs = values.get("--from-ms");
  const toMs = values.get("--to-ms");
  const replayId = values.get("--replay-id");
  if (
    range !== undefined &&
    fromMs === undefined &&
    toMs === undefined &&
    replayId === undefined
  ) {
    if (range !== "maximum-history" && range !== "resume")
      return { kind: "invalid" };
    selection = { kind: range };
  } else if (
    range === undefined &&
    fromMs !== undefined &&
    toMs !== undefined
  ) {
    const from = integer(fromMs);
    const to = integer(toMs);
    const id = replayId ?? randomUUID();
    if (
      from === undefined ||
      to === undefined ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(id)
    )
      return { kind: "invalid" };
    selection = {
      kind: "explicit-range",
      fromMs: from,
      toMs: to,
      replayId: id,
    };
  } else {
    return { kind: "invalid" };
  }
  const maxGets = values.has("--max-gets")
    ? integer(values.get("--max-gets"))
    : undefined;
  const maxDurationMs = values.has("--max-duration-ms")
    ? integer(values.get("--max-duration-ms"))
    : undefined;
  const maxPagesPerWindow = values.has("--max-pages-per-window")
    ? integer(values.get("--max-pages-per-window"))
    : undefined;
  const maxRows = values.has("--max-rows")
    ? integer(values.get("--max-rows"))
    : undefined;
  if (
    (values.has("--max-gets") && maxGets === undefined) ||
    (values.has("--max-duration-ms") && maxDurationMs === undefined) ||
    (values.has("--max-pages-per-window") && maxPagesPerWindow === undefined) ||
    (values.has("--max-rows") && maxRows === undefined)
  )
    return { kind: "invalid" };
  const budget: HistorySyncBudget = {
    ...(maxGets === undefined ? {} : { maxGetAttempts: maxGets }),
    ...(maxDurationMs === undefined ? {} : { maxDurationMs }),
    ...(maxPagesPerWindow === undefined ? {} : { maxPagesPerWindow }),
    ...(maxRows === undefined ? {} : { maxRows }),
  };
  if (!validateHistorySyncBudget(budget).ok) return { kind: "invalid" };
  return {
    kind: "live",
    input: { environment, databasePath, selection, budget },
  };
}

function fixtureConnection(): SqliteConnection {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const now = timestampFromEpochMs(Date.parse("2026-10-28T12:00:00.000Z"));
  if (!now.ok) throw new Error("fixture clock invalid");
  const clock = { now: () => now.value };
  const migrated = applyMigrations(db);
  if (!migrated.ok) throw new Error("fixture migrations failed");
  registerTrustedClock(db, clock);
  return {
    db,
    path: ":memory:",
    environment: "demo",
    runtime: { nodeVersion: "22.22.3", sqliteVersion: "3.51.3" },
    clock,
    close: () => db.close(),
  };
}

async function runOfflineFixture(): Promise<Result<HistorySyncReport>> {
  const connection = fixtureConnection();
  try {
    const store = createSqliteHistoryStore(connection);
    const frozenUpperBoundMs = Date.parse("2026-10-28T12:00:00.000Z");
    const fromMs = frozenUpperBoundMs - 24 * 60 * 60 * 1000;
    return await runHistoryIngestion(
      {
        scope: {
          exchange: "bybit",
          environment: "demo",
          accountId: `sha256:${"0".repeat(64)}`,
        },
        selection: {
          kind: "explicit-range",
          fromMs,
          toMs: frozenUpperBoundMs,
          replayId: "offline-fixture",
        },
        frozenUpperBoundMs,
      },
      {
        store,
        reader: {
          async readPage(request) {
            return createHistoryFixturePage(
              request.source,
              request.window,
              request.cursor ?? null,
            );
          },
        },
        monotonicClock: (() => {
          let tick = 0;
          return () => ++tick;
        })(),
      },
    );
  } catch {
    return fail(domainError("INVALID_VALUE", "OFFLINE_FIXTURE_FAILED"));
  } finally {
    connection.close();
  }
}

function reason(result: Result<HistorySyncReport>): string {
  if (result.ok) return "NONE";
  return (
    /^([A-Z0-9_]{1,64}):/u.exec(result.error.message)?.[1] ?? result.error.code
  );
}

function printReport(
  output: HistorySyncCliOutput,
  report: HistorySyncReport,
  mode: "OFFLINE_FIXTURE" | "LIVE",
  environment: string,
): void {
  output.write(`MODE=${mode}\n`);
  output.write(`ENVIRONMENT=${environment}\n`);
  output.write(`STATUS=${report.status}\n`);
  output.write(`SELECTION=${report.selection}\n`);
  output.write(`FROZEN_UPPER_BOUND_MS=${report.frozenUpperBoundMs}\n`);
  output.write(`ELAPSED_MS=${report.elapsedMs}\n`);
  output.write(`GET_ATTEMPTS=${report.getAttempts}\n`);
  output.write(`ROWS_RECEIVED=${report.rowsReceived}\n`);
  output.write("OPENING_BALANCE=UNKNOWN\nACCOUNTING_READY=NOT_CLAIMED\n");
  for (const limitation of report.coverageLimitations)
    output.write(
      `COVERAGE_LIMITATION=${limitation.source}:${limitation.reasonCodes.join(",")}\n`,
    );
  output.write("EXCHANGE_WRITES=0\n");
  for (const source of report.sources) {
    output.write(
      `SOURCE=${source.source} STATUS=${source.status} GETS=${source.getAttempts} PAGES=${source.pageRequests} ROWS=${source.rowsReceived} INSERTED=${source.inserted} DUPLICATES=${source.duplicates} CONFLICTS=${source.conflicts} UNMATCHED=${source.unmatched} GAPS=${source.gaps}` +
        ` LAST_COVERED=${source.lastFullyCoveredWindow ? `${source.lastFullyCoveredWindow.fromMs}:${source.lastFullyCoveredWindow.toMs}` : "NONE"}` +
        ` NEXT_RESUME=${source.nextResumeWindow ? `${source.nextResumeWindow.fromMs}:${source.nextResumeWindow.toMs}` : "NONE"}` +
        ` REASONS=${source.reasonCodes.join(",") || "NONE"}\n`,
    );
    if (source.diagnostic) {
      output.write(
        `DIAGNOSTIC_SOURCE=${source.source} STAGE=${source.diagnostic.stage} ACTION=${source.diagnostic.attemptedAction} REASON=${source.diagnostic.reasonCode} OUTCOME=${source.diagnostic.outcome}\n` +
          `DIAGNOSTIC_EXPLANATION=${source.diagnostic.explanation}\n` +
          (source.diagnostic.providerRetCode === undefined
            ? ""
            : `DIAGNOSTIC_PROVIDER_RET_CODE=${source.diagnostic.providerRetCode}\n`) +
          (source.diagnostic.httpStatus === undefined
            ? ""
            : `DIAGNOSTIC_HTTP_STATUS=${source.diagnostic.httpStatus}\n`) +
          `DIAGNOSTIC_NEXT_ACTION=${source.diagnostic.nextAction}\n`,
      );
    }
  }
  output.write(`NEXT_ACTION=${report.nextAction}\n`);
}

function safeDetailText(
  error: { readonly details?: Readonly<Record<string, unknown>> },
  key: string,
): string | undefined {
  const value = error.details?.[key];
  if (typeof value !== "string") return undefined;
  const line = value.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 240);
  return line.length > 0 ? line : undefined;
}

function safeDetailNumber(
  error: { readonly details?: Readonly<Record<string, unknown>> },
  key: string,
): number | undefined {
  const value = error.details?.[key];
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : undefined;
}

function printBlockedDiagnostic(
  output: HistorySyncCliOutput,
  error: { readonly details?: Readonly<Record<string, unknown>> },
): void {
  const stage = safeDetailText(error, "stage");
  const action = safeDetailText(error, "attemptedAction");
  const explanation = safeDetailText(error, "explanation");
  const nextAction = safeDetailText(error, "nextAction");
  const outcome = safeDetailText(error, "outcome");
  const providerRetCode = safeDetailNumber(error, "providerRetCode");
  const httpStatus = safeDetailNumber(error, "httpStatus");
  if (stage !== undefined) output.write(`STAGE=${stage}\n`);
  if (action !== undefined) output.write(`ATTEMPTED_ACTION=${action}\n`);
  if (outcome !== undefined) output.write(`OUTCOME=${outcome}\n`);
  if (explanation !== undefined) output.write(`EXPLANATION=${explanation}\n`);
  if (providerRetCode !== undefined)
    output.write(`PROVIDER_RET_CODE=${providerRetCode}\n`);
  if (httpStatus !== undefined) output.write(`HTTP_STATUS=${httpStatus}\n`);
  if (nextAction !== undefined) output.write(`NEXT_ACTION=${nextAction}\n`);
}

export async function runHistorySyncCli(
  argv: readonly string[],
  dependencies: {
    readonly output?: HistorySyncCliOutput;
    readonly runLive?: typeof runLiveHistorySync;
    readonly runOffline?: typeof runOfflineFixture;
  } = {},
): Promise<number> {
  const output = dependencies.output ?? {
    write: (text: string) => process.stdout.write(text),
  };
  const parsed = parseHistorySyncArgs(argv);
  if (parsed.kind === "help") {
    output.write(`${HISTORY_SYNC_USAGE}\n`);
    return 0;
  }
  if (parsed.kind === "invalid") {
    output.write(
      `${HISTORY_SYNC_USAGE}\nSTATUS=BLOCKED\nREASON=INVALID_REQUEST\nEXCHANGE_WRITES=0\n`,
    );
    return 2;
  }
  try {
    if (parsed.kind === "offline-fixture") {
      const result = await (dependencies.runOffline ?? runOfflineFixture)();
      if (!result.ok) {
        output.write(
          `MODE=OFFLINE_FIXTURE\nSTATUS=BLOCKED\nREASON=${reason(result)}\nEXCHANGE_READS=0\nEXCHANGE_WRITES=0\n`,
        );
        return 1;
      }
      output.write("DATABASE=IN_MEMORY\n");
      printReport(output, result.value, "OFFLINE_FIXTURE", "demo");
      output.write("EXCHANGE_READS=0\n");
      return 0;
    }
    const result = await (dependencies.runLive ?? runLiveHistorySync)(
      parsed.input,
    );
    if (!result.ok) {
      const reads = safeDetailNumber(result.error, "exchangeReads");
      output.write(
        `MODE=LIVE\nENVIRONMENT=${parsed.input.environment}\nSTATUS=BLOCKED\nREASON=${reason(result)}\nEXCHANGE_READS=${reads ?? "UNKNOWN"}\nEXCHANGE_WRITES=0\n`,
      );
      printBlockedDiagnostic(output, result.error);
      return 1;
    }
    printReport(output, result.value, "LIVE", parsed.input.environment);
    output.write(`EXCHANGE_READS=${result.value.getAttempts}\n`);
    return result.value.status === "COMPLETE" ? 0 : 4;
  } catch {
    output.write(
      `MODE=${parsed.kind === "live" ? "LIVE" : "OFFLINE_FIXTURE"}\nSTATUS=BLOCKED\nREASON=HISTORY_SYNC_FAILED\nEXCHANGE_READS=UNKNOWN\nEXCHANGE_WRITES=0\n`,
    );
    return 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href)
  process.exitCode = await runHistorySyncCli(process.argv.slice(2));
