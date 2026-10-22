import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { domainError } from "../domain/shared/errors.js";
import { fail, ok, type Result } from "../domain/shared/result.js";
import type { PersistenceScope } from "../ports/persistence.js";
import {
  createOperatorMainnetTestApproval,
  deriveOperatorMainnetTestSourceId,
  type OperatorMainnetTestPlan,
} from "../domain/execution/operator-mainnet-test-plan.js";
import { timestampFromEpochMs } from "../domain/shared/time.js";
import { requireHash } from "../domain/shared/validation.js";
import { resolveOperatorMainnetPlan } from "../adapters/sqlite/operator-mainnet-test-lookup.js";
import { openSqlitePersistence } from "../adapters/sqlite/sqlite-persistence.js";
import { runMainnetOperatorTestStatusComposition } from "../application/mainnet-operator-test-status-composition.js";
import { prepareMainnetOperatorTest } from "../application/mainnet-operator-test-preparation-composition.js";
import { promptVisible, PromptInterruptedError } from "./interactive-prompt.js";

export const MAINNET_OPERATOR_TEST_USAGE = `Usage:
  npm run mainnet:test -- prepare --symbol <BTCUSDT|ETHUSDT|XRPUSDT|DOGEUSDT> --allocation <USDT> --gross-cap <USDT> --max-deviation-bps <bps>
  npm run mainnet:test -- execute --plan-hash <sha256:...>
  npm run mainnet:test -- status --source-id <operator-mainnet-test:...>`;

type InputStream = NodeJS.ReadableStream & { readonly isTTY?: boolean };
type OutputStream = NodeJS.WritableStream & { readonly isTTY?: boolean };

export interface MainnetOperatorTestCliDependencies {
  readonly input?: InputStream;
  readonly output?: OutputStream;
  readonly prepare?: typeof prepareMainnetOperatorTest;
  readonly resolvePlan?: typeof resolveOperatorMainnetPlan;
  readonly hasDurableIntent?: (
    scope: PersistenceScope,
    sourceId: string,
  ) => Result<boolean>;
  readonly execute?: (input: {
    readonly approval: unknown;
    readonly approvalHash: unknown;
    readonly runId: unknown;
  }) => Promise<unknown>;
  readonly status?: typeof runMainnetOperatorTestStatusComposition;
  readonly prompt?: typeof promptVisible;
  readonly clock?: () => number;
  readonly actor?: () => string;
}

type ParsedCommand =
  | {
      readonly command: "prepare";
      readonly symbol: string;
      readonly allocation: string;
      readonly grossNotionalCap: string;
      readonly maxDeviationBps: string;
    }
  | { readonly command: "execute"; readonly planHash: string }
  | { readonly command: "status"; readonly sourceId: string };

function safe(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, "")
    .slice(0, 2_000);
}

function line(output: OutputStream, value: string): void {
  output.write(`${safe(value)}\n`);
}

function flags(argv: readonly string[]): Map<string, string> | undefined {
  if (argv.length % 2 !== 0) return undefined;
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (
      typeof key !== "string" ||
      !/^--[a-z-]+$/u.test(key) ||
      typeof value !== "string" ||
      value.length === 0 ||
      values.has(key)
    )
      return undefined;
    values.set(key, value);
  }
  return values;
}

function parseArgs(argv: readonly string[]): ParsedCommand | undefined {
  const [command, ...rest] = argv;
  if (command === "prepare") {
    const values = flags(rest);
    if (
      !values ||
      values.size !== 4 ||
      !values.has("--symbol") ||
      !values.has("--allocation") ||
      !values.has("--gross-cap") ||
      !values.has("--max-deviation-bps")
    )
      return undefined;
    return {
      command,
      symbol: values.get("--symbol")!,
      allocation: values.get("--allocation")!,
      grossNotionalCap: values.get("--gross-cap")!,
      maxDeviationBps: values.get("--max-deviation-bps")!,
    };
  }
  if (command === "execute") {
    const values = flags(rest);
    if (!values || values.size !== 1 || !values.has("--plan-hash"))
      return undefined;
    return { command, planHash: values.get("--plan-hash")! };
  }
  if (command === "status") {
    const values = flags(rest);
    if (!values || values.size !== 1 || !values.has("--source-id"))
      return undefined;
    return { command, sourceId: values.get("--source-id")! };
  }
  return undefined;
}

function planReview(output: OutputStream, plan: OperatorMainnetTestPlan): void {
  line(output, "ENVIRONMENT=MAINNET");
  line(output, `SYMBOL=${plan.symbol}`);
  line(output, "ACCOUNT_SCOPE=VERIFIED_BYBIT_MAINNET_LINEAR_ONE_WAY");
  line(output, `PLAN_HASH=${plan.contentHash}`);
  line(output, `CLIENT_ORDER_ID=${plan.clientOrderId}`);
  line(output, `QUOTE_BID=${plan.quote.bid}`);
  line(output, `QUOTE_ASK=${plan.quote.ask}`);
  line(output, `QUOTE_TIME=${plan.quote.observedAt}`);
  line(output, `MAX_DEVIATION_BPS=${plan.maxDeviationBps}`);
  line(
    output,
    `APPROVED_BID_RANGE=${plan.quoteBidRange.lower}..${plan.quoteBidRange.upper}`,
  );
  line(
    output,
    `ENTRY=Buy Limit/GTC ${plan.entry.quantity} @ ${plan.entry.limitPrice}`,
  );
  line(output, `GROSS_NOTIONAL=${plan.effectiveGrossNotional} USDT`);
  line(output, `ALLOCATION=${plan.allocation} USDT`);
  line(output, `GROSS_CAP=${plan.grossNotionalCap} USDT`);
  line(
    output,
    "GROSS_CAP_SCOPE=entry gross notional only; fees, slippage, funding and total loss are not capped by this value",
  );
  line(
    output,
    `TAKE_PROFIT=Partial Market LastPrice ${plan.entry.takeProfit.triggerPrice}`,
  );
  line(output, `WARNING_CODES=${plan.warningCodes.join(",") || "NONE"}`);
  line(
    output,
    `APPROVAL_VALID_FOR_MS=${plan.approvalTtlMs} after exact consent`,
  );
}

function mapErrorCode(value: unknown): string {
  if (typeof value !== "object" || value === null || !("error" in value))
    return "OPERATION_FAILED";
  const error = (value as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return "OPERATION_FAILED";
  const details = "details" in error ? error.details : undefined;
  if (
    typeof details === "object" &&
    details !== null &&
    "reasonCode" in details
  ) {
    const reasonCode = details.reasonCode;
    return typeof reasonCode === "string" &&
      /^[A-Z0-9_:-]{1,100}$/u.test(reasonCode)
      ? reasonCode
      : "OPERATION_FAILED";
  }
  const code = "code" in error ? error.code : undefined;
  return typeof code === "string" && /^[A-Z0-9_:-]{1,100}$/u.test(code)
    ? code
    : "OPERATION_FAILED";
}

function printStatusResult(output: OutputStream, result: unknown): number {
  line(output, "EXCHANGE_WRITES=0");
  if (typeof result !== "object" || result === null || !("ok" in result)) {
    line(output, "LIFECYCLE_OUTCOME=UNKNOWN");
    line(output, "CLEANUP_STATUS=unknown");
    line(output, "REASON_CODE=STATUS_RESULT_INVALID");
    return 5;
  }
  const typed = result as {
    readonly ok: boolean;
    readonly value?: {
      readonly sourceId: string;
      readonly lifecycleOutcome: string;
      readonly cleanupStatus: string;
      readonly exchangeReads: number;
      readonly journaled: boolean;
      readonly halt: { readonly active: boolean; readonly revision: number };
      readonly reasons: readonly string[];
      readonly latestSnapshot: {
        readonly source: { readonly clientOrderId: string };
        readonly attempt?: {
          readonly exchangeOrderId?: string;
          readonly outcome: string;
        };
      };
    };
  };
  if (!typed.ok || !typed.value) {
    line(output, "LIFECYCLE_OUTCOME=UNKNOWN");
    line(output, "CLEANUP_STATUS=unknown");
    line(output, `REASON_CODE=${mapErrorCode(result)}`);
    line(
      output,
      "NEXT_ACTION=inspect the saved source and retry status after the read issue is understood",
    );
    return 5;
  }
  const value = typed.value;
  line(output, `SOURCE_ID=${value.sourceId}`);
  line(output, `CLIENT_ORDER_ID=${value.latestSnapshot.source.clientOrderId}`);
  if (value.latestSnapshot.attempt?.exchangeOrderId)
    line(
      output,
      `EXCHANGE_ORDER_ID=${value.latestSnapshot.attempt.exchangeOrderId}`,
    );
  line(
    output,
    `ATTEMPT_OUTCOME=${value.latestSnapshot.attempt?.outcome ?? "unknown"}`,
  );
  line(output, `LIFECYCLE_OUTCOME=${value.lifecycleOutcome}`);
  line(output, `CLEANUP_STATUS=${value.cleanupStatus}`);
  line(output, `EXCHANGE_READS=${value.exchangeReads}`);
  line(output, `STATUS_JOURNALED=${value.journaled ? "yes" : "no"}`);
  line(output, `HALT_ACTIVE=${value.halt.active ? "yes" : "no"}`);
  line(output, `HALT_REVISION=${value.halt.revision}`);
  line(output, `REASONS=${value.reasons.join(",") || "NONE"}`);
  if (
    value.lifecycleOutcome === "TP_LIFECYCLE_PASS" &&
    value.cleanupStatus === "verified-clean"
  )
    return 0;
  if (
    value.lifecycleOutcome === "NOT_EXERCISED" &&
    value.cleanupStatus === "verified-clean"
  )
    return 0;
  return 5;
}

function hasDurableIntent(
  scope: PersistenceScope,
  sourceId: string,
): Result<boolean> {
  const persistence = openSqlitePersistence({ environment: "mainnet", scope });
  if (!persistence.ok) return persistence;
  try {
    const journal = persistence.value.operatorMainnetTest;
    if (!journal)
      return fail(
        domainError(
          "PERSISTENCE_SCHEMA",
          "operator status journal is unavailable",
        ),
      );
    const snapshot = journal.readOperatorMainnetTestSource(sourceId);
    return snapshot.ok ? ok(snapshot.value !== undefined) : snapshot;
  } finally {
    persistence.value.close();
  }
}

export async function runMainnetOperatorTestCli(
  argv: readonly string[],
  dependencies: MainnetOperatorTestCliDependencies = {},
): Promise<number> {
  const input = dependencies.input ?? process.stdin;
  const output = dependencies.output ?? process.stdout;
  const prompt = dependencies.prompt ?? promptVisible;
  const parsed = parseArgs(argv);
  if (!parsed) {
    line(output, MAINNET_OPERATOR_TEST_USAGE);
    line(output, "REASON_CODE=INVALID_REQUEST");
    return 2;
  }

  if (parsed.command === "prepare") {
    line(output, "STAGE=READ_ONLY_PREPARATION");
    try {
      const prepared = await (
        dependencies.prepare ?? prepareMainnetOperatorTest
      )({
        symbol: parsed.symbol,
        allocation: parsed.allocation,
        grossNotionalCap: parsed.grossNotionalCap,
        maxDeviationBps: parsed.maxDeviationBps,
      });
      if (!prepared.ok) {
        line(output, "VERDICT=BLOCKED");
        line(output, `REASON_CODE=${mapErrorCode(prepared)}`);
        line(output, "EXCHANGE_WRITES=0");
        line(
          output,
          "NEXT_ACTION=correct the explicit preparation input or readiness issue",
        );
        return 4;
      }
      planReview(output, prepared.value);
      line(output, "VERDICT=PREPARED");
      line(output, "EXCHANGE_WRITES=0");
      const sourceId = deriveOperatorMainnetTestSourceId(
        prepared.value.contentHash,
      );
      if (sourceId.ok) line(output, `SOURCE_ID=${sourceId.value}`);
      return 0;
    } catch {
      line(output, "VERDICT=BLOCKED");
      line(output, "REASON_CODE=PREPARATION_FAILED_CLOSED");
      line(output, "EXCHANGE_WRITES=0");
      line(
        output,
        "NEXT_ACTION=inspect local sanitized diagnostics and retry after the read issue is understood",
      );
      return 4;
    }
  }

  if (parsed.command === "execute") {
    if (!input.isTTY) {
      line(output, "VERDICT=DECLINED");
      line(output, "REASON_CODE=NON_INTERACTIVE_WRITE_SESSION");
      line(output, "EXCHANGE_WRITES=0");
      line(
        output,
        "NEXT_ACTION=run execute from an attended terminal after reviewing the exact prepared plan",
      );
      return 3;
    }
    const planHash = requireHash(parsed.planHash, "planHash");
    if (!planHash.ok) {
      line(output, "VERDICT=BLOCKED");
      line(output, "REASON_CODE=INVALID_PLAN_HASH");
      return 2;
    }
    const resolved = (dependencies.resolvePlan ?? resolveOperatorMainnetPlan)(
      planHash.value,
    );
    if (!resolved.ok || !resolved.value) {
      line(output, "VERDICT=BLOCKED");
      line(
        output,
        `REASON_CODE=${resolved.ok ? "PREPARED_PLAN_NOT_FOUND" : mapErrorCode(resolved)}`,
      );
      line(output, "EXCHANGE_WRITES=0");
      return 4;
    }
    const { scope, plan } = resolved.value;
    const sourceIdResult = deriveOperatorMainnetTestSourceId(plan.contentHash);
    if (!sourceIdResult.ok) {
      line(output, "VERDICT=BLOCKED");
      line(output, "REASON_CODE=SOURCE_ID_INVALID");
      return 4;
    }
    const existing = (dependencies.hasDurableIntent ?? hasDurableIntent)(
      scope,
      sourceIdResult.value,
    );
    if (!existing.ok) {
      line(output, "VERDICT=BLOCKED");
      line(output, `REASON_CODE=${mapErrorCode(existing)}`);
      line(output, "EXCHANGE_WRITES=0");
      return 4;
    }
    if (existing.value) {
      line(output, "VERDICT=RECOVERY_ONLY");
      line(output, "REASON_CODE=DURABLE_INTENT_ALREADY_EXISTS");
      line(output, `SOURCE_ID=${sourceIdResult.value}`);
      line(
        output,
        "NEXT_ACTION=run mainnet:test status with this source ID; execute will never resend it",
      );
      return printStatusResult(
        output,
        await (dependencies.status ?? runMainnetOperatorTestStatusComposition)({
          sourceId: sourceIdResult.value,
        }),
      );
    }

    planReview(output, plan);
    line(
      output,
      "EXACT_APPROVAL=type lowercase yes to authorize one bounded CREATE attempt",
    );
    let answer: string;
    try {
      answer = await prompt(
        "Approve this exact plan",
        "Attended terminal input is required.",
        {
          timeoutMs: 15 * 60_000,
          input,
          output,
        },
      );
    } catch (error) {
      line(output, "VERDICT=DECLINED");
      line(
        output,
        `REASON_CODE=${error instanceof PromptInterruptedError ? "CONSENT_INTERRUPTED" : "CONSENT_UNAVAILABLE"}`,
      );
      line(output, "EXCHANGE_WRITES=0");
      line(
        output,
        "NEXT_ACTION=review the unchanged plan and start a fresh attended execute command",
      );
      return 3;
    }
    if (answer !== "yes") {
      line(output, "VERDICT=DECLINED");
      line(output, "REASON_CODE=CONSENT_NOT_EXACT_YES");
      line(output, "EXCHANGE_WRITES=0");
      line(output, "NEXT_ACTION=prepare again if the order terms need changes");
      return 3;
    }
    const approvedAt = timestampFromEpochMs((dependencies.clock ?? Date.now)());
    if (!approvedAt.ok) {
      line(output, "VERDICT=BLOCKED");
      line(output, "REASON_CODE=LOCAL_TIME_INVALID");
      line(output, "EXCHANGE_WRITES=0");
      return 4;
    }
    const actor = dependencies.actor?.() ?? userInfo().username;
    const approval = createOperatorMainnetTestApproval({
      plan,
      planHash: plan.contentHash,
      actor,
      consent: true,
      approvedAt: approvedAt.value,
    });
    if (!approval.ok) {
      line(output, "VERDICT=BLOCKED");
      line(output, `REASON_CODE=${mapErrorCode(approval)}`);
      line(output, "EXCHANGE_WRITES=0");
      return 4;
    }
    line(output, "STAGE=FRESH_ADMISSION_AND_SINGLE_CREATE");
    try {
      const execute =
        dependencies.execute ??
        (async (value) => {
          const composition =
            await import("../application/mainnet-operator-test-composition.js");
          return composition.runMainnetOperatorTestComposition(value);
        });
      const result = await execute({
        approval: approval.value,
        approvalHash: approval.value.contentHash,
        runId: `operator-execute-${randomUUID()}`,
      });
      if (
        typeof result === "object" &&
        result !== null &&
        "ok" in result &&
        (result as { readonly ok: boolean }).ok
      ) {
        const outcome = (
          result as {
            readonly value?: {
              readonly kind?: string;
              readonly sourceId?: string;
              readonly clientOrderId?: string;
              readonly attemptOutcome?: string;
            };
          }
        ).value;
        line(
          output,
          `EXECUTION_STATE=${outcome?.kind === "recovery" ? "RECOVERY_ONLY" : "ATTEMPTED"}`,
        );
        line(
          output,
          `EXCHANGE_WRITES=${outcome?.kind === "attempted" ? "1" : "0"}`,
        );
        line(output, `SOURCE_ID=${outcome?.sourceId ?? sourceIdResult.value}`);
        line(
          output,
          `CLIENT_ORDER_ID=${outcome?.clientOrderId ?? plan.clientOrderId}`,
        );
        line(output, `ATTEMPT_OUTCOME=${outcome?.attemptOutcome ?? "unknown"}`);
        line(
          output,
          "NEXT_ACTION=run mainnet:test status with the source ID; inspect Bybit UI if cleanup remains pending",
        );
        return 5;
      }
      line(output, "VERDICT=BLOCKED");
      line(output, `REASON_CODE=${mapErrorCode(result)}`);
      line(output, `SOURCE_ID=${sourceIdResult.value}`);
      line(output, "EXCHANGE_WRITES=UNKNOWN");
      line(
        output,
        "NEXT_ACTION=run mainnet:test status with the source ID; do not retry execute",
      );
      return 5;
    } catch {
      line(output, "VERDICT=RECOVERY_ONLY");
      line(output, "REASON_CODE=EXECUTION_OUTCOME_UNKNOWN");
      line(output, `SOURCE_ID=${sourceIdResult.value}`);
      line(output, "EXCHANGE_WRITES=UNKNOWN");
      line(
        output,
        "NEXT_ACTION=run mainnet:test status with the source ID; do not retry execute",
      );
      return 5;
    }
  }

  let manualAction:
    "entry-remainder-cancelled" | "position-closed" | "other" | undefined;
  if (input.isTTY) {
    try {
      const answer = await prompt(
        "Since the last check, did you act in Bybit UI? type none | cancel | close | other",
        "Manual-action recording requires an attended terminal.",
        { timeoutMs: 60_000, input, output },
      );
      if (answer === "cancel") manualAction = "entry-remainder-cancelled";
      else if (answer === "close") manualAction = "position-closed";
      else if (answer === "other") manualAction = "other";
      else if (answer !== "none") {
        line(output, "VERDICT=UNKNOWN");
        line(output, "REASON_CODE=MANUAL_ACTION_ANSWER_INVALID");
        line(output, "EXCHANGE_WRITES=0");
        return 5;
      }
    } catch {
      line(output, "VERDICT=UNKNOWN");
      line(output, "REASON_CODE=STATUS_PROMPT_INTERRUPTED");
      line(output, "EXCHANGE_WRITES=0");
      return 5;
    }
  }
  line(output, `MANUAL_ACTION=${manualAction ?? "NOT_RECORDED"}`);
  try {
    return printStatusResult(
      output,
      await (dependencies.status ?? runMainnetOperatorTestStatusComposition)({
        sourceId: parsed.sourceId,
        ...(manualAction === undefined ? {} : { manualAction }),
        actor: dependencies.actor?.() ?? userInfo().username,
      }),
    );
  } catch {
    line(output, "LIFECYCLE_OUTCOME=UNKNOWN");
    line(output, "CLEANUP_STATUS=unknown");
    line(output, "REASON_CODE=STATUS_FAILED_CLOSED");
    line(output, "EXCHANGE_WRITES=0");
    return 5;
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = await runMainnetOperatorTestCli(process.argv.slice(2));
}
