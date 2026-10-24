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
import { hashCanonical } from "../domain/identity/canonical-serialization.js";
import { timestampFromEpochMs } from "../domain/shared/time.js";
import { requireHash } from "../domain/shared/validation.js";
import { resolveOperatorMainnetPlan } from "../adapters/sqlite/operator-mainnet-test-lookup.js";
import { openSqlitePersistence } from "../adapters/sqlite/sqlite-persistence.js";
import { runMainnetOperatorTestStatusComposition } from "../application/mainnet-operator-test-status-composition.js";
import { prepareMainnetOperatorTest } from "../application/mainnet-operator-test-preparation-composition.js";
import { createOperatorMainnetCreateRequest } from "../application/mainnet-entry-evidence.js";
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
  const policyIdentityHash = hashCanonical({
    schemaVersion: plan.schemaVersion,
    policyVersion: plan.policyVersion,
  });
  const createRequest = createOperatorMainnetCreateRequest(plan);
  line(output, "ENVIRONMENT=MAINNET");
  line(output, `SYMBOL=${plan.symbol}`);
  line(output, `PLAN_SCHEMA=${plan.schemaVersion}`);
  line(output, `POLICY_VERSION=${plan.policyVersion}`);
  line(
    output,
    `POLICY_IDENTITY_HASH=${policyIdentityHash.ok ? policyIdentityHash.value : "UNKNOWN"}`,
  );
  line(output, "ACCOUNT_SCOPE=VERIFIED_BYBIT_MAINNET_LINEAR_ONE_WAY");
  line(output, `PLAN_HASH=${plan.contentHash}`);
  line(
    output,
    `PAYLOAD_HASH=${createRequest.ok ? createRequest.value.payloadHash : "UNKNOWN"}`,
  );
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

function countText(value: unknown): string {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? String(value)
    : "UNKNOWN";
}

function resultCount(
  value: unknown,
  key: "exchangeReads" | "exchangeWrites",
): string {
  if (typeof value !== "object" || value === null || !("ok" in value))
    return "UNKNOWN";
  const result = value as {
    readonly ok: boolean;
    readonly value?: Record<string, unknown>;
    readonly error?: { readonly details?: Record<string, unknown> };
  };
  return countText(
    result.ok ? result.value?.[key] : result.error?.details?.[key],
  );
}

function evidenceText(value: unknown): string {
  return typeof value === "string" &&
    /^(?:unknown|flat|long|short|[0-9]+(?:\.[0-9]+)?)$/u.test(value)
    ? value
    : "unknown";
}

function evidenceRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function evidenceIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/u.test(value)
    ? value
    : undefined;
}

function latestEvidence(
  snapshot: unknown,
): Record<string, unknown> | undefined {
  if (typeof snapshot !== "object" || snapshot === null) return undefined;
  const reconciliations =
    "reconciliations" in snapshot ? snapshot.reconciliations : undefined;
  if (!Array.isArray(reconciliations)) return undefined;
  const latest = reconciliations.at(-1);
  if (
    typeof latest !== "object" ||
    latest === null ||
    !("canonicalJson" in latest)
  )
    return undefined;
  try {
    const record: unknown = JSON.parse(String(latest.canonicalJson));
    if (
      typeof record !== "object" ||
      record === null ||
      !("evidence" in record)
    )
      return undefined;
    const evidence = record.evidence;
    return typeof evidence === "object" &&
      evidence !== null &&
      !Array.isArray(evidence)
      ? (evidence as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
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
    line(output, "EXCHANGE_READS=UNKNOWN");
    line(output, "UNCERTAINTY=STATUS_RESULT_INVALID");
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
        readonly plan: {
          readonly schemaVersion?: string;
          readonly policyVersion?: string;
          readonly contentHash?: string;
        };
        readonly source: {
          readonly clientOrderId: string;
          readonly planHash?: string;
          readonly approvalHash?: string;
          readonly payloadHash?: string;
        };
        readonly attempt?: {
          readonly exchangeOrderId?: string;
          readonly outcome: string;
        };
        readonly reconciliations?: readonly {
          readonly canonicalJson: string;
        }[];
      };
    };
  };
  if (!typed.ok || !typed.value) {
    line(output, "LIFECYCLE_OUTCOME=UNKNOWN");
    line(output, "CLEANUP_STATUS=unknown");
    line(output, `EXCHANGE_READS=${resultCount(result, "exchangeReads")}`);
    line(output, "UNCERTAINTY=STATUS_READ_FAILED");
    line(output, `REASON_CODE=${mapErrorCode(result)}`);
    line(
      output,
      "NEXT_ACTION=inspect the saved source and retry status after the read issue is understood",
    );
    return 5;
  }
  const value = typed.value;
  const evidence = latestEvidence(value.latestSnapshot);
  const parent = evidenceRecord(evidence?.parent);
  const observedParentOrderId = evidenceIdentifier(parent?.exchangeOrderId);
  const attemptOrderId = evidenceIdentifier(
    value.latestSnapshot.attempt?.exchangeOrderId,
  );
  const policyIdentityHash = hashCanonical({
    schemaVersion: value.latestSnapshot.plan.schemaVersion,
    policyVersion: value.latestSnapshot.plan.policyVersion,
  });
  line(output, `SOURCE_ID=${value.sourceId}`);
  line(
    output,
    `PLAN_SCHEMA=${value.latestSnapshot.plan.schemaVersion ?? "unknown"}`,
  );
  line(
    output,
    `POLICY_VERSION=${value.latestSnapshot.plan.policyVersion ?? "unknown"}`,
  );
  line(
    output,
    `POLICY_IDENTITY_HASH=${policyIdentityHash.ok ? policyIdentityHash.value : "UNKNOWN"}`,
  );
  line(
    output,
    `PLAN_HASH=${value.latestSnapshot.source.planHash ?? value.latestSnapshot.plan.contentHash ?? "unknown"}`,
  );
  line(
    output,
    `APPROVAL_HASH=${value.latestSnapshot.source.approvalHash ?? "unknown"}`,
  );
  line(
    output,
    `PAYLOAD_HASH=${value.latestSnapshot.source.payloadHash ?? "unknown"}`,
  );
  line(output, `CLIENT_ORDER_ID=${value.latestSnapshot.source.clientOrderId}`);
  line(
    output,
    `EXCHANGE_ORDER_ID=${observedParentOrderId ?? attemptOrderId ?? "unknown"}`,
  );
  line(
    output,
    `ATTEMPT_OUTCOME=${value.latestSnapshot.attempt?.outcome ?? "unknown"}`,
  );
  line(output, `LIFECYCLE_OUTCOME=${value.lifecycleOutcome}`);
  line(output, `CLEANUP_STATUS=${value.cleanupStatus}`);
  line(output, `EXCHANGE_READS=${countText(value.exchangeReads)}`);
  line(output, `STATUS_JOURNALED=${value.journaled ? "yes" : "no"}`);
  line(output, `HALT_ACTIVE=${value.halt.active ? "yes" : "no"}`);
  line(output, `HALT_REVISION=${value.halt.revision}`);
  line(output, `REASONS=${value.reasons.join(",") || "NONE"}`);
  const tpChildren = Array.isArray(evidence?.tpChildren)
    ? evidence.tpChildren
    : [];
  line(output, `TP_CHILD_COUNT=${tpChildren.length}`);
  tpChildren.forEach((child, index) => {
    const childRecord = evidenceRecord(child);
    const prefix = `TP_CHILD_${index + 1}`;
    line(
      output,
      `${prefix}_EXCHANGE_ORDER_ID=${evidenceIdentifier(childRecord?.exchangeOrderId) ?? "unknown"}`,
    );
    line(
      output,
      `${prefix}_CLIENT_ORDER_ID=${evidenceIdentifier(childRecord?.clientOrderId) ?? "unknown"}`,
    );
    line(
      output,
      `${prefix}_STATUS=${evidenceIdentifier(childRecord?.status) ?? "unknown"}`,
    );
    line(
      output,
      `${prefix}_REQUESTED_QUANTITY=${evidenceText(childRecord?.requestedQuantity)}`,
    );
    line(
      output,
      `${prefix}_FILLED_QUANTITY=${evidenceText(childRecord?.filledQuantity)}`,
    );
    line(
      output,
      `${prefix}_TRIGGER_PRICE=${evidenceText(childRecord?.triggerPrice)}`,
    );
  });
  const activeOwnedOrderIds = Array.isArray(evidence?.activeOwnedOrderIds)
    ? evidence.activeOwnedOrderIds
    : [];
  line(output, `ACTIVE_OWNED_ORDER_COUNT=${activeOwnedOrderIds.length}`);
  activeOwnedOrderIds.forEach((orderId, index) => {
    line(
      output,
      `ACTIVE_OWNED_ORDER_ID_${index + 1}=${evidenceIdentifier(orderId) ?? "unknown"}`,
    );
  });
  const position = evidenceRecord(evidence?.position);
  line(
    output,
    `EXECUTED_ENTRY_QUANTITY=${evidenceText(evidence?.executedEntryQuantity)}`,
  );
  line(output, `TP_EXIT_QUANTITY=${evidenceText(evidence?.tpExitQuantity)}`);
  line(
    output,
    `ENTRY_REMAINDER_QUANTITY=${evidenceText(parent?.remainingQuantity)}`,
  );
  line(output, `POSITION_SIDE=${evidenceText(position?.side)}`);
  line(output, `POSITION_QUANTITY=${evidenceText(position?.quantity)}`);
  line(
    output,
    `UNCERTAINTY=${value.reasons.length ? value.reasons.join(",") : value.cleanupStatus === "verified-clean" ? "NONE" : "PENDING_CLEANUP"}`,
  );
  if (value.cleanupStatus === "verified-clean") {
    line(
      output,
      "NEXT_ACTION=no manual cleanup is indicated by fresh status evidence",
    );
  } else if (
    value.lifecycleOutcome === "UNKNOWN" ||
    value.cleanupStatus === "unknown"
  ) {
    line(
      output,
      "NEXT_ACTION=preserve HALT; inspect the listed parent, TP children and position in Bybit UI; act only on confirmed owned orders, then rerun status",
    );
  } else if (value.lifecycleOutcome === "MANUAL_CLEANUP") {
    line(
      output,
      "NEXT_ACTION=inspect the listed orders and position in Bybit UI, record any manual action, then rerun status for fresh proof",
    );
  } else {
    line(
      output,
      "NEXT_ACTION=inspect the parent remainder, TP children and position in Bybit UI; perform any needed cleanup manually, then rerun status",
    );
  }
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
    line(output, "EXCHANGE_READS=0");
    line(output, "EXCHANGE_WRITES=0");
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
        const reasonCode = mapErrorCode(prepared);
        line(output, "VERDICT=BLOCKED");
        line(output, `REASON_CODE=${reasonCode}`);
        if (reasonCode === "PROVIDER_TIME_PRECISION_INSUFFICIENT")
          line(
            output,
            "REASON_DETAIL=Bybit supplied only second-resolution time; millisecond precision is required for quote collection",
          );
        if (reasonCode === "PROVIDER_TIME_INVALID_OR_INCONSISTENT")
          line(
            output,
            "REASON_DETAIL=Bybit time fields are malformed or contradictory; preparation remains blocked",
          );
        if (reasonCode === "PUBLIC_MARKET_PRECONDITION")
          line(
            output,
            "REASON_DETAIL=public market evidence failed its source, price or collection-time contract; preparation remains blocked",
          );
        if (reasonCode === "INSTRUMENT_CONSTRAINTS_INCOMPLETE_OR_MISMATCHED")
          line(
            output,
            "REASON_DETAIL=quote/symbol must match and venue minNotional, minPrice, maxPrice, maxLimitQuantity must be present and valid",
          );
        line(
          output,
          `EXCHANGE_READS=${resultCount(prepared, "exchangeReads")}`,
        );
        line(
          output,
          `EXCHANGE_WRITES=${resultCount(prepared, "exchangeWrites")}`,
        );
        line(
          output,
          reasonCode === "INSTRUMENT_CONSTRAINTS_INCOMPLETE_OR_MISMATCHED"
            ? "NEXT_ACTION=verify complete same-symbol instruments-info mapping; do not execute until preparation succeeds"
            : "NEXT_ACTION=correct the explicit preparation input or readiness issue",
        );
        return 4;
      }
      const { plan } = prepared.value;
      planReview(output, plan);
      line(output, "VERDICT=PREPARED");
      line(output, `EXCHANGE_READS=${countText(prepared.value.exchangeReads)}`);
      line(output, `EXCHANGE_WRITES=${prepared.value.exchangeWrites}`);
      line(output, "APPROVAL_HASH=NOT_APPROVED");
      const sourceId = deriveOperatorMainnetTestSourceId(plan.contentHash);
      if (sourceId.ok) line(output, `SOURCE_ID=${sourceId.value}`);
      return 0;
    } catch {
      line(output, "VERDICT=BLOCKED");
      line(output, "REASON_CODE=PREPARATION_FAILED_CLOSED");
      line(output, "EXCHANGE_READS=UNKNOWN");
      line(output, "EXCHANGE_WRITES=0");
      line(
        output,
        "NEXT_ACTION=inspect local sanitized diagnostics and retry after the read issue is understood",
      );
      return 4;
    }
  }

  if (parsed.command === "execute") {
    if (!input.isTTY || !output.isTTY) {
      line(output, "VERDICT=DECLINED");
      line(output, "REASON_CODE=NON_INTERACTIVE_WRITE_SESSION");
      line(output, "EXCHANGE_READS=0");
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
      line(output, "EXCHANGE_READS=0");
      line(output, "EXCHANGE_WRITES=0");
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
      line(output, "EXCHANGE_READS=0");
      line(output, "EXCHANGE_WRITES=0");
      return 4;
    }
    const { scope, plan } = resolved.value;
    const sourceIdResult = deriveOperatorMainnetTestSourceId(plan.contentHash);
    if (!sourceIdResult.ok) {
      line(output, "VERDICT=BLOCKED");
      line(output, "REASON_CODE=SOURCE_ID_INVALID");
      line(output, "EXCHANGE_READS=0");
      line(output, "EXCHANGE_WRITES=0");
      return 4;
    }
    const existing = (dependencies.hasDurableIntent ?? hasDurableIntent)(
      scope,
      sourceIdResult.value,
    );
    if (!existing.ok) {
      line(output, "VERDICT=BLOCKED");
      line(output, `REASON_CODE=${mapErrorCode(existing)}`);
      line(output, "EXCHANGE_READS=0");
      line(output, "EXCHANGE_WRITES=0");
      return 4;
    }
    if (existing.value) {
      line(output, "VERDICT=RECOVERY_ONLY");
      line(output, "REASON_CODE=DURABLE_INTENT_ALREADY_EXISTS");
      line(output, `SOURCE_ID=${sourceIdResult.value}`);
      line(output, `CLIENT_ORDER_ID=${plan.clientOrderId}`);
      line(
        output,
        "NEXT_ACTION=run mainnet:test status with this source ID; inspect Bybit UI orders, fills and position using CLIENT_ORDER_ID; execute will never resend it",
      );
      try {
        return printStatusResult(
          output,
          await (
            dependencies.status ?? runMainnetOperatorTestStatusComposition
          )({
            sourceId: sourceIdResult.value,
          }),
        );
      } catch {
        line(output, "LIFECYCLE_OUTCOME=UNKNOWN");
        line(output, "CLEANUP_STATUS=unknown");
        line(output, "EXCHANGE_READS=UNKNOWN");
        line(output, "EXCHANGE_WRITES=0");
        line(output, "UNCERTAINTY=STATUS_FAILED_CLOSED");
        line(output, "REASON_CODE=STATUS_FAILED_CLOSED");
        return 5;
      }
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
      line(output, "APPROVAL_HASH=NOT_APPROVED");
      line(output, "EXCHANGE_READS=0");
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
      line(output, "APPROVAL_HASH=NOT_APPROVED");
      line(output, "EXCHANGE_READS=0");
      line(output, "EXCHANGE_WRITES=0");
      line(output, "NEXT_ACTION=prepare again if the order terms need changes");
      return 3;
    }
    const approvedAt = timestampFromEpochMs((dependencies.clock ?? Date.now)());
    if (!approvedAt.ok) {
      line(output, "VERDICT=BLOCKED");
      line(output, "REASON_CODE=LOCAL_TIME_INVALID");
      line(output, "APPROVAL_HASH=NOT_APPROVED");
      line(output, "EXCHANGE_READS=0");
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
      line(output, "APPROVAL_HASH=NOT_APPROVED");
      line(output, "EXCHANGE_READS=0");
      line(output, "EXCHANGE_WRITES=0");
      return 4;
    }
    line(output, `APPROVAL_HASH=${approval.value.contentHash}`);
    line(output, "STAGE=FRESH_ADMISSION_AND_SINGLE_CREATE");
    let productionCompositionStarted = false;
    try {
      const execute =
        dependencies.execute ??
        (async (value) => {
          const composition =
            await import("../application/mainnet-operator-test-composition.js");
          productionCompositionStarted = true;
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
              readonly exchangeReads?: number;
              readonly exchangeWrites?: number;
            };
          }
        ).value;
        line(
          output,
          `EXECUTION_STATE=${outcome?.kind === "recovery" ? "RECOVERY_ONLY" : "ATTEMPTED"}`,
        );
        line(output, `EXCHANGE_READS=${countText(outcome?.exchangeReads)}`);
        line(output, `EXCHANGE_WRITES=${countText(outcome?.exchangeWrites)}`);
        line(output, `SOURCE_ID=${outcome?.sourceId ?? sourceIdResult.value}`);
        line(
          output,
          `CLIENT_ORDER_ID=${outcome?.clientOrderId ?? plan.clientOrderId}`,
        );
        line(output, `ATTEMPT_OUTCOME=${outcome?.attemptOutcome ?? "unknown"}`);
        line(
          output,
          outcome?.kind === "recovery" ||
            outcome?.attemptOutcome === "ambiguous"
            ? "NEXT_ACTION=run mainnet:test status with the source ID; inspect Bybit UI orders, fills and position using CLIENT_ORDER_ID before another submission; do not resend this source"
            : "NEXT_ACTION=run mainnet:test status with the source ID; inspect Bybit UI if cleanup remains pending",
        );
        return 5;
      }
      // Re-read the journal after the failed attempt. Zero writes alone cannot
      // prove that recovery is unnecessary: an intent may already be durable.
      const persisted = (dependencies.hasDurableIntent ?? hasDurableIntent)(
        scope,
        sourceIdResult.value,
      );
      const notStarted =
        persisted.ok &&
        !persisted.value &&
        resultCount(result, "exchangeWrites") === "0";
      line(output, "VERDICT=BLOCKED");
      line(
        output,
        `EXECUTION_STATE=${notStarted ? "EXECUTION_NOT_STARTED" : "RECOVERY_ONLY"}`,
      );
      line(output, `REASON_CODE=${mapErrorCode(result)}`);
      line(output, `SOURCE_ID=${sourceIdResult.value}`);
      line(output, `EXCHANGE_READS=${resultCount(result, "exchangeReads")}`);
      line(output, `EXCHANGE_WRITES=${resultCount(result, "exchangeWrites")}`);
      line(
        output,
        notStarted
          ? "NEXT_ACTION=diagnose the blocked pre-intent stage from REASON_CODE; preserve any HALT; use GET-only reads for data failures; no source exists for status; do not retry execute for diagnosis"
          : "NEXT_ACTION=run mainnet:test status with the source ID; inspect Bybit UI orders, fills and position using CLIENT_ORDER_ID before another submission; do not retry execute",
      );
      return 5;
    } catch {
      line(output, "VERDICT=RECOVERY_ONLY");
      line(output, "REASON_CODE=EXECUTION_OUTCOME_UNKNOWN");
      line(output, `SOURCE_ID=${sourceIdResult.value}`);
      line(
        output,
        `EXCHANGE_READS=${dependencies.execute === undefined && !productionCompositionStarted ? "0" : "UNKNOWN"}`,
      );
      line(
        output,
        `EXCHANGE_WRITES=${dependencies.execute === undefined && !productionCompositionStarted ? "0" : "UNKNOWN"}`,
      );
      line(
        output,
        "NEXT_ACTION=run mainnet:test status with the source ID; inspect Bybit UI orders, fills and position using CLIENT_ORDER_ID before another submission; do not retry execute",
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
        line(output, "EXCHANGE_READS=0");
        line(output, "EXCHANGE_WRITES=0");
        return 5;
      }
    } catch {
      line(output, "VERDICT=UNKNOWN");
      line(output, "REASON_CODE=STATUS_PROMPT_INTERRUPTED");
      line(output, "EXCHANGE_READS=0");
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
    line(output, "EXCHANGE_READS=UNKNOWN");
    line(output, "EXCHANGE_WRITES=0");
    return 5;
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = await runMainnetOperatorTestCli(process.argv.slice(2));
}
