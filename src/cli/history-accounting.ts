import { pathToFileURL } from "node:url";

import {
  captureHistoryAccountingAnchor,
  type CapturedHistoryAccountingAnchor,
} from "../application/history-accounting-anchor-capture.js";
import {
  reconcileHistoryAccounting,
  type ReconcileHistoryAccountingInput,
} from "../application/history-accounting-composition.js";
import type { HistoryAccountingReconciliationReport } from "../application/history-accounting-report.js";
import { fail, type Result } from "../domain/shared/result.js";
import { domainError } from "../domain/shared/errors.js";
import { requireIdentifier } from "../domain/shared/validation.js";
import type { CredentialEnvironment } from "../ports/credential-provider.js";

export const HISTORY_ACCOUNTING_USAGE = `Usage:
  npm run accounting:reconcile -- --mode capture-anchor --environment <demo|testnet|mainnet> --database <absolute-path> --kind <opening|closing>
  npm run accounting:reconcile -- --mode reconcile --environment <demo|testnet|mainnet> --database <absolute-path> --opening-anchor-id <id> --closing-anchor-id <id>

Reconcile reads only local SQLite evidence. capture-anchor performs authenticated Bybit GETs only.`;

export interface HistoryAccountingCliOutput {
  write(text: string): void;
}

type Parsed =
  | { readonly kind: "help" }
  | { readonly kind: "invalid" }
  | {
      readonly kind: "capture-anchor";
      readonly input: {
        readonly environment: CredentialEnvironment;
        readonly databasePath: string;
        readonly kind: "opening" | "closing";
      };
    }
  | {
      readonly kind: "reconcile";
      readonly input: ReconcileHistoryAccountingInput;
    };

function parse(argv: readonly string[]): Parsed {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h"))
    return { kind: "help" };
  if (argv.length === 0 || argv.length % 2 !== 0) return { kind: "invalid" };
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
  const environment = values.get("--environment");
  const databasePath = values.get("--database");
  const mode = values.get("--mode");
  if (
    (environment !== "demo" &&
      environment !== "testnet" &&
      environment !== "mainnet") ||
    databasePath === undefined ||
    !databasePath.startsWith("/") ||
    databasePath.length > 2_048 ||
    /[\u0000-\u001f\u007f]/u.test(databasePath)
  )
    return { kind: "invalid" };
  if (mode === "capture-anchor") {
    if (
      values.size !== 4 ||
      (values.get("--kind") !== "opening" &&
        values.get("--kind") !== "closing") ||
      [...values.keys()].some(
        (key) =>
          !["--mode", "--environment", "--database", "--kind"].includes(key),
      )
    )
      return { kind: "invalid" };
    return {
      kind: "capture-anchor",
      input: {
        environment,
        databasePath,
        kind: values.get("--kind") as "opening" | "closing",
      },
    };
  }
  if (mode === "reconcile") {
    const openingAnchorId = values.get("--opening-anchor-id");
    const closingAnchorId = values.get("--closing-anchor-id");
    if (
      values.size !== 5 ||
      openingAnchorId === undefined ||
      closingAnchorId === undefined ||
      !requireIdentifier(openingAnchorId, "openingAnchorId").ok ||
      !requireIdentifier(closingAnchorId, "closingAnchorId").ok ||
      [...values.keys()].some(
        (key) =>
          ![
            "--mode",
            "--environment",
            "--database",
            "--opening-anchor-id",
            "--closing-anchor-id",
          ].includes(key),
      )
    )
      return { kind: "invalid" };
    return {
      kind: "reconcile",
      input: { environment, databasePath, openingAnchorId, closingAnchorId },
    };
  }
  return { kind: "invalid" };
}

function reason(result: {
  readonly error: { readonly message: string; readonly code: string };
}): string {
  return (
    /^([A-Z0-9_]{1,64}):/u.exec(result.error.message)?.[1] ?? result.error.code
  );
}

function numberDetail(
  result: {
    readonly error: { readonly details?: Readonly<Record<string, unknown>> };
  },
  key: string,
): number | undefined {
  const value = result.error.details?.[key];
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : undefined;
}

function safeCodeList(codes: readonly string[]): string {
  return (
    codes.filter((code) => /^[A-Z0-9_]{1,64}$/u.test(code)).join(",") || "NONE"
  );
}

function printReport(
  output: HistoryAccountingCliOutput,
  report: HistoryAccountingReconciliationReport,
): void {
  output.write(
    `MODE=RECONCILE\nSTATUS=${report.status}\nREPORT_ID=${report.reportId}\n` +
      `EPOCH=${report.epoch.epoch.openingBoundary}:${report.epoch.epoch.closingBoundary}\n` +
      `PRE_EPOCH_HISTORY=${report.preEpochHistory}\n` +
      `TRANSACTIONS=${report.transactions.length}\n` +
      `ACCOUNT_UNREALIZED_PNL_USD=${report.accountUnrealizedPnlUsd.amount ?? "UNKNOWN"} AS_OF=${report.accountUnrealizedPnlUsd.asOf} ALLOCATION=${report.accountUnrealizedPnlUsd.allocation}\n`,
  );
  for (const currency of report.epoch.currencies)
    output.write(
      `CURRENCY=${currency.currency} OPENING=${currency.openingBalance ?? "UNKNOWN"} ` +
        `MOVEMENT=${currency.transactionChange ?? "UNKNOWN"} TRANSFERS=${currency.transferChange ?? "UNKNOWN"} ` +
        `EXPECTED_CLOSING=${currency.expectedClosingBalance ?? "UNKNOWN"} ` +
        `CLOSING=${currency.closingBalance ?? "UNKNOWN"} UNEXPLAINED_DRIFT=${currency.unexplainedDrift ?? "UNKNOWN"}\n`,
    );
  for (const source of report.epoch.sourceCoverage)
    output.write(
      `SOURCE=${source.source} COVERED=${source.covered ? "YES" : "NO"} GAPS=${source.gaps.length}\n`,
    );
  for (const row of report.performance.ownedRunSymbolDays)
    output.write(
      `OWNED_RUN_SYMBOL_DAY=${row.source?.sourceId ?? "UNKNOWN"}:${row.symbol ?? "UNKNOWN"}:${row.utcDay} ` +
        `CURRENCY=${row.currency ?? "UNKNOWN"} REPORTED_CLOSED_PNL=${row.amount ?? "UNKNOWN"} ` +
        `STATUS=${row.status.toUpperCase()} REASONS=${safeCodeList(row.reasonCodes)}\n`,
    );
  output.write(
    `UNMATCHED_OR_AMBIGUOUS_CLOSED_PNL=${report.performance.notStrategyPerformance.length}\n` +
      `ACCOUNTING_READY=${report.status === "ACCOUNTING_READY" ? "YES" : "NO"}\n` +
      `REASON_CODES=${safeCodeList(report.epoch.reasonCodes)}\n` +
      `NEXT_ACTION=${report.status === "ACCOUNTING_READY" ? "Use this report only for its verified period and evidence scope." : "Review the reason codes, fill any in-period history gaps, and recapture anchors after account changes."}\n` +
      "EXCHANGE_READS=0\nEXCHANGE_WRITES=0\n",
  );
}

export async function runHistoryAccountingCli(
  argv: readonly string[],
  dependencies: {
    readonly output?: HistoryAccountingCliOutput;
    readonly capture?: typeof captureHistoryAccountingAnchor;
    readonly reconcile?: typeof reconcileHistoryAccounting;
  } = {},
): Promise<number> {
  const output = dependencies.output ?? {
    write: (text: string) => process.stdout.write(text),
  };
  const parsed = parse(argv);
  if (parsed.kind === "help") {
    output.write(`${HISTORY_ACCOUNTING_USAGE}\n`);
    return 0;
  }
  if (parsed.kind === "invalid") {
    output.write(
      `${HISTORY_ACCOUNTING_USAGE}\nSTATUS=BLOCKED\nREASON=INVALID_REQUEST\nEXCHANGE_WRITES=0\n`,
    );
    return 2;
  }
  if (parsed.kind === "capture-anchor") {
    let result: Result<CapturedHistoryAccountingAnchor>;
    try {
      result = await (dependencies.capture ?? captureHistoryAccountingAnchor)(
        parsed.input,
      );
    } catch {
      result = fail(
        domainError(
          "INVALID_VALUE",
          "ANCHOR_CAPTURE_FAILED: wallet anchor was not recorded",
          { exchangeWrites: 0 },
        ),
      );
    }
    if (!result.ok) {
      output.write(
        `MODE=CAPTURE_ANCHOR\nENVIRONMENT=${parsed.input.environment}\nKIND=${parsed.input.kind}\n` +
          `STATUS=BLOCKED\nREASON=${reason(result)}\nEXCHANGE_READS=${numberDetail(result, "exchangeReads") ?? "UNKNOWN"}\nEXCHANGE_WRITES=0\n`,
      );
      return 1;
    }
    output.write(
      `MODE=CAPTURE_ANCHOR\nENVIRONMENT=${parsed.input.environment}\nKIND=${result.value.anchor.kind}\n` +
        `ANCHOR_ID=${result.value.anchor.anchorId}\nPROVIDER_RESPONSE_TIME=${result.value.anchor.capture.providerResponseTime}\n` +
        `ASSETS=${result.value.anchor.assets.length}\nSTATUS=RECORDED\n` +
        `EXCHANGE_READS=${result.value.getAttempts}\nEXCHANGE_WRITES=0\n`,
    );
    return 0;
  }
  let report: Result<HistoryAccountingReconciliationReport>;
  try {
    report = await (dependencies.reconcile ?? reconcileHistoryAccounting)(
      parsed.input,
    );
  } catch {
    report = fail(
      domainError(
        "INVALID_ACCOUNTING",
        "RECONCILIATION_FAILED: local report unavailable",
        { exchangeReads: 0, exchangeWrites: 0 },
      ),
    );
  }
  if (!report.ok) {
    output.write(
      `MODE=RECONCILE\nENVIRONMENT=${parsed.input.environment}\nSTATUS=BLOCKED\n` +
        `REASON=${reason(report)}\nEXCHANGE_READS=0\nEXCHANGE_WRITES=0\n` +
        `NEXT_ACTION=Inspect the local evidence database and selected anchor IDs.\n`,
    );
    return 1;
  }
  printReport(output, report.value);
  return report.value.status === "ACCOUNTING_READY" ? 0 : 4;
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href)
  process.exitCode = await runHistoryAccountingCli(process.argv.slice(2));
