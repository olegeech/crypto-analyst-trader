import { safeMainnetGetCounts } from "../application/mainnet-composition-helpers.js";
import { readFileSync } from "node:fs";
import { ACCOUNT_CRITICAL_GROUPS } from "../domain/account/account-evidence-consistency.js";
import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { domainError } from "../domain/shared/errors.js";
import { fail, ok, type Result } from "../domain/shared/result.js";
import { DecimalValue } from "../domain/shared/decimal.js";
import type { PersistenceScope } from "../ports/persistence.js";
import {
  createOperatorMainnetTestApproval,
  deriveOperatorMainnetTestSourceId,
  type OperatorMainnetTestPlan,
} from "../domain/execution/operator-mainnet-test-plan.js";
import {
  recoveryGrantEvidenceExpiry,
  recoveryGrantPlanExpiry,
  type OperatorMainnetRecoveryAttestation,
} from "../domain/execution/operator-mainnet-recovery.js";
import { hashCanonical } from "../domain/identity/canonical-serialization.js";
import {
  parseUtcTimestamp,
  timestampFromEpochMs,
  timestampToEpochMs,
  type UtcTimestamp,
} from "../domain/shared/time.js";
import { requireHash } from "../domain/shared/validation.js";
import {
  resolveOperatorMainnetPlan,
  resolveOperatorMainnetSource,
} from "../adapters/sqlite/operator-mainnet-test-lookup.js";
import { openSqlitePersistence } from "../adapters/sqlite/sqlite-persistence.js";
import { runMainnetOperatorTestStatusComposition } from "../application/mainnet-operator-test-status-composition.js";
import { prepareMainnetOperatorTest } from "../application/mainnet-operator-test-preparation-composition.js";
import {
  persistManualOperatorRecoveryAttestation,
  recoverMainnetOperatorTest,
} from "../application/mainnet-operator-test-recovery.js";
import { createOperatorMainnetCreateRequest } from "../application/mainnet-entry-evidence.js";
import { promptVisible, PromptInterruptedError } from "./interactive-prompt.js";

export const MAINNET_OPERATOR_TEST_USAGE = `Usage:
  npm run mainnet:test -- prepare --symbol <BTCUSDT|ETHUSDT|XRPUSDT|DOGEUSDT> --allocation <USDT> --gross-cap <USDT> --max-deviation-bps <bps> [--recovery-source-id <operator-mainnet-test:...> --recovery-inspection-file <path>]
  npm run mainnet:test -- execute --plan-hash <sha256:...>
  npm run mainnet:test -- recover --source-id <operator-mainnet-test:...> --plan-hash <sha256:...> --resolution <api|manual>
  npm run mainnet:test -- status --source-id <operator-mainnet-test:...>`;

type InputStream = NodeJS.ReadableStream & { readonly isTTY?: boolean };
type OutputStream = NodeJS.WritableStream & { readonly isTTY?: boolean };

export interface MainnetOperatorTestCliDependencies {
  readonly input?: InputStream;
  readonly output?: OutputStream;
  readonly prepare?: typeof prepareMainnetOperatorTest;
  readonly resolvePlan?: typeof resolveOperatorMainnetPlan;
  readonly resolveSource?: typeof resolveOperatorMainnetSource;
  readonly prepareRecoveryAttestation?: typeof persistManualOperatorRecoveryAttestation;
  readonly recover?: typeof recoverMainnetOperatorTest;
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
      readonly recoverySourceId?: string;
      readonly recoveryInspectionFile?: string;
    }
  | { readonly command: "execute"; readonly planHash: string }
  | {
      readonly command: "recover";
      readonly sourceId: string;
      readonly planHash: string;
      readonly resolution: "api-resolved" | "manual-attested";
    }
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
      (values.size !== 4 && values.size !== 6) ||
      !values.has("--symbol") ||
      !values.has("--allocation") ||
      !values.has("--gross-cap") ||
      !values.has("--max-deviation-bps") ||
      values.has("--recovery-source-id") !==
        values.has("--recovery-inspection-file") ||
      [...values.keys()].some(
        (key) =>
          ![
            "--symbol",
            "--allocation",
            "--gross-cap",
            "--max-deviation-bps",
            "--recovery-source-id",
            "--recovery-inspection-file",
          ].includes(key),
      )
    )
      return undefined;
    return {
      command,
      symbol: values.get("--symbol")!,
      allocation: values.get("--allocation")!,
      grossNotionalCap: values.get("--gross-cap")!,
      maxDeviationBps: values.get("--max-deviation-bps")!,
      ...(values.has("--recovery-source-id")
        ? {
            recoverySourceId: values.get("--recovery-source-id")!,
            recoveryInspectionFile: values.get("--recovery-inspection-file")!,
          }
        : {}),
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
  if (command === "recover") {
    const values = flags(rest);
    if (
      !values ||
      values.size !== 3 ||
      !values.has("--source-id") ||
      !values.has("--plan-hash") ||
      !values.has("--resolution") ||
      [...values.keys()].some(
        (key) => !["--source-id", "--plan-hash", "--resolution"].includes(key),
      ) ||
      !["api", "manual"].includes(values.get("--resolution")!)
    )
      return undefined;
    return {
      command,
      sourceId: values.get("--source-id")!,
      planHash: values.get("--plan-hash")!,
      resolution:
        values.get("--resolution") === "api"
          ? "api-resolved"
          : "manual-attested",
    };
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
  if (plan.recoveryAttestationHash) {
    line(output, "RECOVERY_PROVENANCE=MANUAL_ATTESTED_NOT_API_VERIFIED");
    line(output, `RECOVERY_ATTESTATION_HASH=${plan.recoveryAttestationHash}`);
  }
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

function printGetCounts(
  output: OutputStream,
  result: unknown,
  stage: "PREPARE" | "EXECUTE",
): void {
  const envelope = evidenceRecord(result);
  const payload =
    envelope?.ok === true
      ? evidenceRecord(envelope.value)
      : evidenceRecord(evidenceRecord(envelope?.error)?.details);
  const fallback = payload?.compactFallbackReason;
  if (
    stage === "PREPARE" &&
    typeof fallback === "string" &&
    /^[A-Z][A-Z0-9_]{0,79}$/u.test(fallback)
  )
    line(output, `PREPARE_COMPACT_FALLBACK_REASON=${fallback}`);
  const counts = safeMainnetGetCounts(payload?.exchangeGetCounts);
  if (counts !== undefined) line(output, `GET_COUNTS_${stage}=${counts}`);
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

interface OperatorCapacityDiagnostic {
  readonly availableBalance: string;
  readonly orderNotional: string;
  readonly entryFeeReserve: string;
  readonly exitFeeReserve: string;
  readonly totalReserve: string;
  readonly requiredAvailableBalance: string;
  readonly shortfall: string;
}

function operatorCapacityDiagnostic(
  value: unknown,
): OperatorCapacityDiagnostic | undefined {
  if (typeof value !== "object" || value === null || !("error" in value))
    return undefined;
  const error = value.error;
  if (typeof error !== "object" || error === null || !("details" in error))
    return undefined;
  const details = evidenceRecord(error.details);
  if (
    !details ||
    details.reasonCode !== "AVAILABLE_MARGIN_OR_FEE_RESERVE_INSUFFICIENT"
  )
    return undefined;

  const readAmount = (key: keyof OperatorCapacityDiagnostic) => {
    const amount = key in details ? details[key] : undefined;
    if (
      typeof amount !== "string" ||
      amount.length > 128 ||
      !/^-?\d+(?:\.\d+)?$/u.test(amount)
    )
      return undefined;
    const parsed = DecimalValue.fromString(amount);
    return parsed.ok ? parsed.value : undefined;
  };
  const availableBalance = readAmount("availableBalance");
  const orderNotional = readAmount("orderNotional");
  const entryFeeReserve = readAmount("entryFeeReserve");
  const exitFeeReserve = readAmount("exitFeeReserve");
  const totalReserve = readAmount("totalReserve");
  const requiredAvailableBalance = readAmount("requiredAvailableBalance");
  const shortfall = readAmount("shortfall");
  if (
    !availableBalance ||
    !orderNotional ||
    !entryFeeReserve ||
    !exitFeeReserve ||
    !totalReserve ||
    !requiredAvailableBalance ||
    !shortfall ||
    !shortfall.isPositive()
  )
    return undefined;
  return {
    availableBalance: availableBalance.toString(),
    orderNotional: orderNotional.toString(),
    entryFeeReserve: entryFeeReserve.toString(),
    exitFeeReserve: exitFeeReserve.toString(),
    totalReserve: totalReserve.toString(),
    requiredAvailableBalance: requiredAvailableBalance.toString(),
    shortfall: shortfall.toString(),
  };
}

function printOperatorCapacityDiagnostic(
  output: OutputStream,
  diagnostic: OperatorCapacityDiagnostic | undefined,
): void {
  line(
    output,
    "DIAGNOSTIC=Insufficient funds — account-wide USD-equivalent available balance is too low",
  );
  if (diagnostic) {
    line(output, `ORDER_NOTIONAL_USDT=${diagnostic.orderNotional}`);
    line(
      output,
      `AVAILABLE_BALANCE_USD_EQUIVALENT=${diagnostic.availableBalance}`,
    );
    line(output, `ENTRY_FEE_RESERVE_USDT=${diagnostic.entryFeeReserve}`);
    line(output, `EXIT_FEE_RESERVE_USDT=${diagnostic.exitFeeReserve}`);
    line(output, `TOTAL_FEE_RESERVE_USDT=${diagnostic.totalReserve}`);
    line(
      output,
      `REQUIRED_AVAILABLE_BALANCE_USD_EQUIVALENT=${diagnostic.requiredAvailableBalance}`,
    );
    line(output, `SHORTFALL_USD_EQUIVALENT=${diagnostic.shortfall}`);
  }
  line(
    output,
    "CAPACITY_EXPLANATION=Bybit totalAvailableBalance is account-wide USD-equivalent capacity; it must cover the approved USDT notional plus entry and exit fee reserve",
  );
}

interface OperatorFailureDiagnostic {
  readonly explanation: string;
  readonly why: string;
  readonly nextAction: string;
}

function safeChangedGroups(details: Record<string, unknown> | undefined) {
  const value = details?.criticalChangedGroups;
  if (typeof value !== "string") return undefined;
  const groups = value.split(",");
  return groups.length > 0 &&
    groups.every((group) =>
      [...ACCOUNT_CRITICAL_GROUPS, "UNESTABLISHED"].some(
        (allowed) => allowed === group,
      ),
    )
    ? value
    : undefined;
}

function safeDecimalDetail(
  details: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = details?.[key];
  if (
    typeof value === "string" &&
    /^(?:0|[1-9]\d{0,19})(?:\.\d{1,18})?$/u.test(value)
  )
    return value;
  return undefined;
}

function safeCountDetail(
  details: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = details?.[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function safeTimestampDetail(
  details: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const timestamp = parseUtcTimestamp(details?.[key]);
  return timestamp.ok ? timestamp.value : undefined;
}

function safeCodeDetail(
  details: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = details?.[key];
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,99}$/u.test(value)
    ? value
    : undefined;
}

function safeChangedConstraint(
  details: Record<string, unknown> | undefined,
): string | undefined {
  const value = details?.changedConstraint;
  return typeof value === "string" &&
    [
      "instrument",
      "version",
      "priceTickSize",
      "quantityStep",
      "minQuantity",
      "minNotional",
      "minPrice",
      "maxPrice",
      "maxLimitQuantity",
      "constraintSet",
    ].includes(value)
    ? value
    : undefined;
}

function operatorFailureDiagnostic(
  reasonCode: string,
  details: Record<string, unknown> | undefined,
  notStarted: boolean,
): OperatorFailureDiagnostic {
  if (
    notStarted &&
    reasonCode === "AVAILABLE_MARGIN_OR_FEE_RESERVE_INSUFFICIENT"
  )
    return {
      explanation:
        details?.availableBalance === "0" &&
        details.requiredAvailableBalance === undefined
          ? "The account has no available balance for a positive order."
          : "The approved order exceeds the account-wide available balance after reserving entry and exit fees.",
      why:
        details?.availableBalance === "0" &&
        details.requiredAvailableBalance === undefined
          ? "Fresh Bybit totalAvailableBalance is zero; no positive order can fit. Exact order and fee amounts were not calculated."
          : "Bybit totalAvailableBalance was compared with the exact USDT notional and entry/exit fee reserve.",
      nextAction:
        "add funds to the trading account or reduce the proposed order; prepare a new plan and obtain fresh exact-plan confirmation before another attempt",
    };
  if (
    reasonCode === "CRITICAL_STATE_CHANGED" ||
    reasonCode.endsWith("_CRITICAL_STATE_CHANGED")
  ) {
    const groups = safeChangedGroups(details);
    return {
      explanation:
        "Two fresh account or target-state observations did not agree.",
      why: groups
        ? `The changed evidence group is ${groups}.`
        : "The exact changed field was not localized by the collected evidence.",
      nextAction: notStarted
        ? "inspect the account, target position and open orders in Bybit; use fresh GET-only preparation after the state is understood; no source exists for status and execute should not be repeated for diagnosis"
        : "run mainnet:test status with the source ID; inspect Bybit orders, fills and position using CLIENT_ORDER_ID; do not retry execute",
    };
  }
  if (reasonCode === "QUOTE_OUTSIDE_APPROVED_RANGE")
    return {
      explanation:
        "The fresh best bid is outside the exact price range approved in this plan.",
      why: (() => {
        const bid = safeDecimalDetail(details, "quoteBid");
        const lower = safeDecimalDetail(details, "approvedBidLower");
        const upper = safeDecimalDetail(details, "approvedBidUpper");
        return bid && lower && upper
          ? `Fresh bid ${bid} is outside the approved range ${lower}–${upper}.`
          : "The current quote no longer satisfies the stored plan's price bounds; exact prices were not available in the collected evidence.";
      })(),
      nextAction:
        "prepare a fresh plan and obtain new exact-plan confirmation before another attempt",
    };
  if (
    reasonCode === "QUOTE_STALE_OR_FUTURE" ||
    reasonCode === "MAINNET_EVIDENCE_STALE"
  )
    return {
      explanation: "Fresh market or account evidence failed its time check.",
      why: (() => {
        const source = details?.source;
        const ageMs = safeCountDetail(details, "ageMs");
        const futureByMs = safeCountDetail(details, "futureByMs");
        const limitMs = safeCountDetail(details, "limitMs");
        if (typeof source !== "string" || limitMs === undefined)
          return "The evidence timestamp was stale, in the future, or outside the allowed freshness window; the exact age was not localized.";
        if (futureByMs !== undefined)
          return `${source} evidence is ${futureByMs} ms in the future; the allowed freshness limit is ${limitMs} ms.`;
        if (ageMs !== undefined)
          return `${source} evidence is ${ageMs} ms old; the allowed freshness limit is ${limitMs} ms.`;
        return `${source} evidence is outside the allowed freshness window of ${limitMs} ms.`;
      })(),
      nextAction: notStarted
        ? "check the local clock and Bybit read health, then use GET-only preparation; no source exists for status"
        : "run mainnet:test status with the source ID; inspect Bybit orders, fills and position using CLIENT_ORDER_ID; do not retry execute",
    };
  if (
    reasonCode === "PROVIDER_TIME_PRECISION_INSUFFICIENT" ||
    reasonCode === "PROVIDER_TIME_INVALID_OR_INCONSISTENT" ||
    reasonCode === "PROVIDER_TIME_UNAVAILABLE" ||
    reasonCode === "EVIDENCE_TIME_INVALID"
  )
    return {
      explanation:
        "Bybit time evidence did not meet the timestamp contract required for this read.",
      why:
        reasonCode === "PROVIDER_TIME_PRECISION_INSUFFICIENT"
          ? "The response did not provide the millisecond precision needed to order the quote collection window."
          : "The provider time was missing, malformed, or contradictory.",
      nextAction:
        "check the local sanitized time diagnostics and use GET-only preparation after the Bybit time response is understood",
    };
  if (
    reasonCode === "PUBLIC_MARKET_PRECONDITION" ||
    reasonCode.startsWith("PUBLIC_MARKET_")
  )
    return {
      explanation:
        "Bybit public market evidence did not satisfy the source or price contract.",
      why:
        typeof details?.causeCode === "string" &&
        /^[A-Z][A-Z0-9_]{0,99}$/u.test(details.causeCode)
          ? `The public market validator reported ${details.causeCode}.`
          : "The quote source, price values, or collection times could not be validated.",
      nextAction:
        "check the local sanitized quote diagnostics and use GET-only preparation after the response is understood",
    };
  if (reasonCode === "ACCOUNT_CAPACITY_INCOMPLETE")
    return {
      explanation:
        "Bybit did not provide a complete account-wide available-balance value.",
      why: "The value could not be proved from the account and wallet responses already collected.",
      nextAction: notStarted
        ? "check the account or wallet response in the local sanitized diagnostics; no source exists for status and do not retry execute for diagnosis"
        : "run mainnet:test status with the source ID; inspect Bybit orders, fills and position using CLIENT_ORDER_ID; do not retry execute",
    };
  if (reasonCode === "CREDENTIAL_PERMISSION_BLOCKED")
    return {
      explanation:
        "The connected API key does not meet the permissions required for this operator test.",
      why: (() => {
        const flags = [
          ["read-only", details?.readOnly],
          ["contract order", details?.contractOrder],
          ["contract position", details?.contractPosition],
          ["wallet transfer", details?.walletTransfer],
          ["withdrawal", details?.withdraw],
        ]
          .filter(([, value]) => typeof value === "boolean")
          .map(([name, value]) => `${name}=${String(value)}`);
        if (flags.length > 0)
          return `Collected permission flags: ${flags.join(", ")}.`;
        const causeCode = safeCodeDetail(details, "causeCode");
        return causeCode
          ? `The credential check reported ${causeCode}.`
          : "The already-collected credential posture failed a required permission check; exact flags were not available.";
      })(),
      nextAction:
        "review the API key permissions and account identity; prepare a new plan and obtain fresh exact-plan confirmation",
    };
  if (reasonCode === "TARGET_STATE_OR_CAPABILITY_BLOCKED")
    return {
      explanation:
        "The target symbol is not in the required flat, one-way 1x state or its required capability is unavailable.",
      why: (() => {
        const causeCode = safeCodeDetail(details, "causeCode");
        const side = details?.positionSide;
        const quantity = safeDecimalDetail(details, "positionQuantity");
        const activeOrderCount = safeCountDetail(details, "activeOrderCount");
        const leverage = safeDecimalDetail(details, "leverage");
        if (causeCode) return `The target-state check reported ${causeCode}.`;
        if (side === "long" || side === "short")
          return `A ${side} target position of ${quantity ?? "unknown quantity"} was already present.`;
        if (activeOrderCount !== undefined)
          return `${activeOrderCount} active order(s) already exist for the target symbol.`;
        if (leverage)
          return `The collected target leverage is ${leverage}x; the plan requires 1x.`;
        return "The collected position, open-order, leverage or capability evidence did not prove the required state; the exact cause was not localized.";
      })(),
      nextAction: notStarted
        ? "inspect the target position and open orders in Bybit; resolve the state manually and use GET-only preparation"
        : "run mainnet:test status with the source ID; inspect Bybit orders, fills and position using CLIENT_ORDER_ID; do not retry execute",
    };
  if (
    reasonCode === "APPROVED_INSTRUMENT_CONSTRAINTS_CHANGED" ||
    reasonCode === "TARGET_INSTRUMENT_UNSUPPORTED" ||
    reasonCode === "INSTRUMENT_CONSTRAINTS_INCOMPLETE_OR_MISMATCHED"
  )
    return {
      explanation:
        "The current Bybit instrument details do not match the prepared plan.",
      why: (() => {
        const changedConstraint = safeChangedConstraint(details);
        return changedConstraint
          ? `The public ${changedConstraint} constraint differs from the exact approved plan.`
          : "The symbol status, contract properties, or exchange order limits failed the stored plan checks; the specific field was not localized.";
      })(),
      nextAction:
        reasonCode === "INSTRUMENT_CONSTRAINTS_INCOMPLETE_OR_MISMATCHED"
          ? "verify complete same-symbol instruments-info mapping; do not execute until preparation succeeds"
          : "verify the instrument details with GET-only preparation and prepare a new plan before approval",
    };
  if (
    reasonCode === "FEE_RATE_RESPONSE_INVALID" ||
    reasonCode === "FEE_RATE_READ_FAILED" ||
    reasonCode === "FEE_RATE_EVIDENCE_INVALID" ||
    reasonCode === "FEE_RATE_SYMBOL_MISMATCH"
  )
    return {
      explanation: "The current Bybit fee-rate evidence could not be used.",
      why: "The fee response was incomplete, malformed, or unavailable in the existing read.",
      nextAction: notStarted
        ? "check the local sanitized fee-rate diagnostics; no source exists for status and do not retry execute for diagnosis"
        : "run mainnet:test status with the source ID; inspect Bybit orders, fills and position using CLIENT_ORDER_ID; do not retry execute",
    };
  if (
    reasonCode === "QUOTE_READ_FAILED" ||
    reasonCode === "QUOTE_EVIDENCE_INVALID" ||
    reasonCode === "TARGET_STATE_READ_FAILED" ||
    reasonCode === "ACCOUNT_EVIDENCE_INVALID" ||
    reasonCode === "FRESH_MAINNET_EVIDENCE_INVALID" ||
    reasonCode === "FRESH_MAINNET_EVIDENCE_UNAVAILABLE"
  )
    return {
      explanation:
        "Fresh Bybit evidence could not be collected or validated; this operator attempt did not reach CREATE.",
      why:
        typeof details?.source === "string"
          ? `The failing evidence group was ${details.source}.`
          : typeof details?.causeCode === "string" &&
              /^[A-Z][A-Z0-9_]{0,99}$/u.test(details.causeCode)
            ? `The validator reported ${details.causeCode}; no more specific field was localized.`
            : "The exact field or endpoint was not localized by the evidence available to this run.",
      nextAction:
        "inspect the local sanitized diagnostics and use GET-only preparation to identify the failing read; no source exists for status and do not retry execute for diagnosis",
    };
  if (
    reasonCode === "ACCOUNT_MODE_UNKNOWN" ||
    reasonCode === "ACCOUNT_MODE_UNSUPPORTED" ||
    reasonCode === "SPOT_HEDGING_ENABLED" ||
    reasonCode === "ACCOUNT_READINESS_OR_IDENTITY_BLOCKED"
  )
    return {
      explanation:
        "Fresh account mode or identity evidence does not meet the operator test requirements.",
      why: (() => {
        const causeCode = safeCodeDetail(details, "causeCode");
        const utaStatus = safeCountDetail(details, "utaStatus");
        const marginMode = details?.marginMode;
        if (reasonCode === "SPOT_HEDGING_ENABLED")
          return "The collected account-mode evidence reports that spot hedging is enabled.";
        if (causeCode) return `The account check reported ${causeCode}.`;
        if (utaStatus !== undefined || typeof marginMode === "string")
          return `Collected account mode: utaStatus=${utaStatus ?? "unknown"}, marginMode=${typeof marginMode === "string" ? marginMode : "unknown"}.`;
        return "The required account mode or verified identity was unknown or unsupported in the evidence already collected.";
      })(),
      nextAction:
        "inspect the account mode and API-key identity in Bybit; use GET-only preparation after correcting or understanding the state",
    };
  if (notStarted && reasonCode === "HALT_OR_RECONCILIATION_REQUIRED")
    return {
      explanation:
        "An existing HALT or reconciliation requirement blocks this operation.",
      why: "The application checked the persisted incident state before collecting admission evidence.",
      nextAction:
        "preserve the existing HALT and follow its recorded recovery guidance before another operation",
    };
  return {
    explanation: notStarted
      ? "The operator attempt was blocked before CREATE."
      : "A durable CREATE intent exists, so the exchange outcome must be checked before any further action.",
    why: "The technical reason code is available, but this run did not collect a more specific safe explanation.",
    nextAction: notStarted
      ? "diagnose the blocked pre-intent stage from REASON_CODE using existing local evidence; no source exists for status and do not retry execute for diagnosis"
      : "run mainnet:test status with the source ID; inspect Bybit orders, fills and position using CLIENT_ORDER_ID; do not retry execute",
  };
}

function printOperatorFailureDiagnostic(
  output: OutputStream,
  reasonCode: string,
  details: Record<string, unknown> | undefined,
  notStarted: boolean,
): void {
  const diagnostic = operatorFailureDiagnostic(reasonCode, details, notStarted);
  line(output, `EXPLANATION=${diagnostic.explanation}`);
  line(output, `WHY=${diagnostic.why}`);
  if (details) {
    const numericFields = [
      ["QUOTE_BID", "quoteBid"],
      ["APPROVED_BID_LOWER", "approvedBidLower"],
      ["APPROVED_BID_UPPER", "approvedBidUpper"],
      ["ALLOWED_DEVIATION_BPS", "allowedDeviationBps"],
      ["POSITION_QUANTITY", "positionQuantity"],
      ["LEVERAGE", "leverage"],
      ["LEVERAGE_BUY", "leverageBuy"],
      ["LEVERAGE_SELL", "leverageSell"],
      ["LEVERAGE_EFFECTIVE", "leverageEffective"],
    ] as const;
    for (const [label, key] of numericFields) {
      const value = safeDecimalDetail(details, key);
      if (value !== undefined) line(output, `${label}=${value}`);
    }
    const counts = [
      ["EVIDENCE_AGE_MS", "ageMs"],
      ["EVIDENCE_FUTURE_MS", "futureByMs"],
      ["FRESHNESS_LIMIT_MS", "limitMs"],
      ["COLLECTION_FUTURE_MS", "collectionFutureByMs"],
      ["ACTIVE_ORDER_COUNT", "activeOrderCount"],
      ["UTA_STATUS", "utaStatus"],
    ] as const;
    for (const [label, key] of counts) {
      const value = safeCountDetail(details, key);
      if (value !== undefined) line(output, `${label}=${value}`);
    }
    const observedAt = safeTimestampDetail(details, "quoteObservedAt");
    if (observedAt) line(output, `QUOTE_OBSERVED_AT=${observedAt}`);
    const source = details.source;
    if (
      typeof source === "string" &&
      /^(?:account|balance|quote|fee|instrument|position|orders|target-state|provider-time)$/u.test(
        source,
      )
    )
      line(output, `EVIDENCE_SOURCE=${source}`);
    const causeCode = safeCodeDetail(details, "causeCode");
    if (causeCode) line(output, `DETAIL_CAUSE_CODE=${causeCode}`);
    const changedConstraint = safeChangedConstraint(details);
    if (changedConstraint)
      line(output, `CHANGED_INSTRUMENT_CONSTRAINT=${changedConstraint}`);
    for (const [label, key] of [
      ["READ_ONLY", "readOnly"],
      ["CONTRACT_ORDER_PERMISSION", "contractOrder"],
      ["CONTRACT_POSITION_PERMISSION", "contractPosition"],
      ["WALLET_TRANSFER_PERMISSION", "walletTransfer"],
      ["WITHDRAW_PERMISSION", "withdraw"],
      ["SPOT_HEDGING", "spotHedging"],
    ] as const) {
      if (typeof details[key] === "boolean")
        line(output, `${label}=${String(details[key])}`);
    }
    if (
      details.positionSide === "flat" ||
      details.positionSide === "long" ||
      details.positionSide === "short"
    )
      line(output, `POSITION_SIDE=${details.positionSide}`);
    if (
      details.marginMode === "REGULAR_MARGIN" ||
      details.marginMode === "PORTFOLIO_MARGIN"
    )
      line(output, `MARGIN_MODE=${details.marginMode}`);
  }
  const groups = safeChangedGroups(details);
  if (
    (reasonCode === "CRITICAL_STATE_CHANGED" ||
      reasonCode.endsWith("_CRITICAL_STATE_CHANGED")) &&
    groups
  )
    line(output, `CRITICAL_CHANGED_GROUPS=${groups}`);
  line(output, `NEXT_ACTION=${diagnostic.nextAction}`);
}

function printStatusResult(output: OutputStream, result: unknown): number {
  line(output, "EXCHANGE_WRITES=0");
  if (typeof result !== "object" || result === null || !("ok" in result)) {
    line(output, "LIFECYCLE_OUTCOME=UNKNOWN");
    line(output, "CLEANUP_STATUS=unknown");
    line(output, "EXCHANGE_READS=UNKNOWN");
    line(output, "UNCERTAINTY=STATUS_RESULT_INVALID");
    line(output, "REASON_CODE=STATUS_RESULT_INVALID");
    line(
      output,
      "EXPLANATION=The saved order lifecycle could not be verified from the status result.",
    );
    line(
      output,
      "WHY=The status result did not have the expected shape, so no cleanup conclusion is supported.",
    );
    line(
      output,
      "NEXT_ACTION=inspect the order, fills and position in Bybit; preserve any HALT and rerun status after the local issue is understood",
    );
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
      "EXPLANATION=The saved order lifecycle could not be verified by this status read.",
    );
    line(
      output,
      "WHY=The exchange read or its evidence validation failed; the exact endpoint or field was not localized by this result.",
    );
    line(
      output,
      "NEXT_ACTION=inspect the order, fills and position in Bybit; preserve any HALT and rerun status after the read issue is understood",
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
      let recoveryAttestation: OperatorMainnetRecoveryAttestation | undefined;
      if (parsed.recoverySourceId && parsed.recoveryInspectionFile) {
        if (!input.isTTY || !output.isTTY) {
          line(output, "VERDICT=BLOCKED");
          line(
            output,
            "REASON_CODE=MANUAL_RECOVERY_REQUIRES_ATTENDED_TERMINAL",
          );
          line(output, "EXCHANGE_READS=0");
          line(output, "EXCHANGE_WRITES=0");
          return 3;
        }
        let rawInspection: unknown;
        try {
          rawInspection = JSON.parse(
            readFileSync(parsed.recoveryInspectionFile, "utf8"),
          );
        } catch {
          line(output, "VERDICT=BLOCKED");
          line(output, "REASON_CODE=RECOVERY_INSPECTION_FILE_INVALID");
          line(output, "EXCHANGE_READS=0");
          line(output, "EXCHANGE_WRITES=0");
          line(
            output,
            "NEXT_ACTION=provide a local JSON file containing the complete Bybit UI inspection fields; do not include screenshots, credentials or account secrets",
          );
          return 4;
        }
        const recordedAt = timestampFromEpochMs(
          (dependencies.clock ?? Date.now)(),
        );
        if (!recordedAt.ok) {
          line(output, "VERDICT=BLOCKED");
          line(output, "REASON_CODE=LOCAL_TIME_INVALID");
          line(output, "EXCHANGE_READS=0");
          line(output, "EXCHANGE_WRITES=0");
          return 4;
        }
        const attested = (
          dependencies.prepareRecoveryAttestation ??
          persistManualOperatorRecoveryAttestation
        )({
          sourceId: parsed.recoverySourceId,
          inspection: rawInspection as Parameters<
            typeof persistManualOperatorRecoveryAttestation
          >[0]["inspection"],
          actor: dependencies.actor?.() ?? userInfo().username,
          recordedAt: recordedAt.value,
        });
        if (!attested.ok) {
          line(output, "VERDICT=BLOCKED");
          line(output, `REASON_CODE=${mapErrorCode(attested)}`);
          line(output, "EXCHANGE_READS=0");
          line(output, "EXCHANGE_WRITES=0");
          line(
            output,
            "NEXT_ACTION=inspect the current source and account-wide Bybit UI fields, correct the local inspection file, and prepare again",
          );
          return 4;
        }
        recoveryAttestation = attested.value.attestation;
        line(
          output,
          `RECOVERY_ATTESTATION_HASH=${recoveryAttestation.contentHash}`,
        );
        line(output, "RECOVERY_PROVENANCE=MANUAL_ATTESTED_NOT_API_VERIFIED");
      }
      const prepared = await (
        dependencies.prepare ?? prepareMainnetOperatorTest
      )({
        symbol: parsed.symbol,
        allocation: parsed.allocation,
        grossNotionalCap: parsed.grossNotionalCap,
        maxDeviationBps: parsed.maxDeviationBps,
        ...(recoveryAttestation
          ? {
              recoveryAttestationHash: recoveryAttestation.contentHash,
              recoveryAttestation,
            }
          : {}),
      });
      printGetCounts(output, prepared, "PREPARE");
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
        const error = evidenceRecord(evidenceRecord(prepared)?.error);
        if (reasonCode === "AVAILABLE_MARGIN_OR_FEE_RESERVE_INSUFFICIENT") {
          const capacity = operatorCapacityDiagnostic(prepared);
          printOperatorCapacityDiagnostic(output, capacity);
          if (
            !capacity &&
            evidenceRecord(error?.details)?.availableBalance === "0"
          )
            line(output, "AVAILABLE_BALANCE_USD_EQUIVALENT=0");
        }
        printOperatorFailureDiagnostic(
          output,
          reasonCode,
          evidenceRecord(error?.details),
          true,
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

  if (parsed.command === "recover") {
    if (!input.isTTY || !output.isTTY) {
      line(output, "VERDICT=DECLINED");
      line(output, "REASON_CODE=RECOVERY_REQUIRES_ATTENDED_TERMINAL");
      line(output, "EXCHANGE_READS=0");
      line(output, "EXCHANGE_WRITES=0");
      return 3;
    }
    const sourceId = evidenceIdentifier(parsed.sourceId);
    const planHash = requireHash(parsed.planHash, "planHash");
    if (!sourceId || !planHash.ok) {
      line(output, "VERDICT=BLOCKED");
      line(output, "REASON_CODE=INVALID_RECOVERY_SOURCE_OR_PLAN");
      line(output, "EXCHANGE_READS=0");
      line(output, "EXCHANGE_WRITES=0");
      return 2;
    }
    const source = (dependencies.resolveSource ?? resolveOperatorMainnetSource)(
      sourceId,
    );
    const plan = (dependencies.resolvePlan ?? resolveOperatorMainnetPlan)(
      planHash.value,
    );
    if (!source.ok || !plan.ok || !source.value || !plan.value) {
      line(output, "VERDICT=BLOCKED");
      line(
        output,
        `REASON_CODE=${!source.ok ? mapErrorCode(source) : !plan.ok ? mapErrorCode(plan) : "RECOVERY_ARTIFACT_NOT_FOUND"}`,
      );
      line(output, "EXCHANGE_READS=0");
      line(output, "EXCHANGE_WRITES=0");
      return 4;
    }
    const snapshot = source.value.snapshot;
    const savedPlan = plan.value.plan;
    if (
      source.value.scope.accountId !== plan.value.scope.accountId ||
      source.value.scope.exchange !== plan.value.scope.exchange ||
      source.value.scope.environment !== plan.value.scope.environment ||
      source.value.scope.category !== plan.value.scope.category ||
      source.value.scope.positionMode !== plan.value.scope.positionMode ||
      savedPlan.accountIdentityHash !== source.value.scope.accountId
    ) {
      line(output, "VERDICT=BLOCKED");
      line(output, "REASON_CODE=RECOVERY_SCOPE_MISMATCH");
      line(output, "EXCHANGE_READS=0");
      line(output, "EXCHANGE_WRITES=0");
      return 4;
    }
    if (
      (parsed.resolution === "manual-attested" &&
        !savedPlan.recoveryAttestationHash) ||
      (parsed.resolution === "api-resolved" &&
        savedPlan.recoveryAttestationHash !== undefined)
    ) {
      line(output, "VERDICT=BLOCKED");
      line(output, "REASON_CODE=RECOVERY_RESOLUTION_PLAN_MISMATCH");
      line(output, "EXCHANGE_READS=0");
      line(output, "EXCHANGE_WRITES=0");
      return 4;
    }
    let observedAt: UtcTimestamp | undefined;
    if (parsed.resolution === "api-resolved") {
      const latest = snapshot.reconciliations.at(-1);
      if (!latest || latest.cleanupStatus !== "verified-clean") {
        line(output, "VERDICT=BLOCKED");
        line(output, "REASON_CODE=API_CLEANUP_NOT_VERIFIED");
        line(output, "EXCHANGE_READS=0");
        line(output, "EXCHANGE_WRITES=0");
        line(
          output,
          "NEXT_ACTION=run GET-only status and recover only from its latest verified-clean reconciliation",
        );
        return 4;
      }
      observedAt = latest.observedAt;
      line(output, `API_RECONCILIATION_ID=${latest.reconciliationId}`);
      line(output, `API_RECONCILIATION_HASH=${latest.canonicalHash}`);
    } else {
      const persistence = openSqlitePersistence({
        environment: "mainnet",
        scope: source.value.scope,
      });
      if (!persistence.ok) {
        line(output, "VERDICT=BLOCKED");
        line(output, `REASON_CODE=${mapErrorCode(persistence)}`);
        line(output, "EXCHANGE_READS=0");
        line(output, "EXCHANGE_WRITES=0");
        return 4;
      }
      try {
        const journal = persistence.value.operatorMainnetTest;
        const saved = journal?.readOperatorMainnetRecoveryAttestation(
          savedPlan.recoveryAttestationHash!,
        );
        if (!saved?.ok || !saved.value) {
          line(output, "VERDICT=BLOCKED");
          line(output, "REASON_CODE=MANUAL_RECOVERY_ATTESTATION_NOT_FOUND");
          line(output, "EXCHANGE_READS=0");
          line(output, "EXCHANGE_WRITES=0");
          return 4;
        }
        observedAt = saved.value.observedAt;
        line(output, `RECOVERY_ATTESTATION_HASH=${saved.value.contentHash}`);
        line(output, `RECOVERY_PROVENANCE=${saved.value.provenance}`);
      } finally {
        persistence.value.close();
      }
    }
    const planExpiry = recoveryGrantPlanExpiry(savedPlan);
    const observedExpiry =
      observedAt && planExpiry.ok
        ? recoveryGrantEvidenceExpiry(observedAt, planExpiry.value)
        : undefined;
    const now = timestampFromEpochMs((dependencies.clock ?? Date.now)());
    if (!planExpiry.ok || !observedExpiry?.ok || !now.ok || !observedAt) {
      line(output, "VERDICT=BLOCKED");
      line(output, "REASON_CODE=RECOVERY_TIME_INVALID");
      line(output, "EXCHANGE_READS=0");
      line(output, "EXCHANGE_WRITES=0");
      return 4;
    }
    const grantExpiresAt = observedExpiry.value;
    if (timestampToEpochMs(now.value) >= timestampToEpochMs(grantExpiresAt)) {
      line(output, "VERDICT=BLOCKED");
      line(output, "REASON_CODE=RECOVERY_EVIDENCE_EXPIRED");
      line(output, "EXCHANGE_READS=0");
      line(output, "EXCHANGE_WRITES=0");
      return 4;
    }
    line(output, "STAGE=EXPLICIT_LOCAL_RECOVERY_AUTHORIZATION");
    line(output, `SOURCE_ID=${snapshot.source.sourceId}`);
    line(output, `SOURCE_PLAN_HASH=${snapshot.source.planHash}`);
    line(output, `SOURCE_INTENT_ID=${snapshot.intent.writeIntentId}`);
    line(output, `HALT_ACTIVE=${snapshot.halt.active ? "true" : "false"}`);
    line(output, `HALT_REVISION=${snapshot.halt.revision}`);
    line(output, `NEXT_PLAN_HASH=${savedPlan.contentHash}`);
    line(output, `NEXT_CLIENT_ORDER_ID=${savedPlan.clientOrderId}`);
    line(output, `RECOVERY_RESOLUTION=${parsed.resolution}`);
    line(output, `RECOVERY_OBSERVED_AT=${observedAt}`);
    line(output, `GRANT_EXPIRES_AT=${grantExpiresAt}`);
    line(output, "EXCHANGE_READS=0");
    line(output, "EXCHANGE_WRITES=0");
    line(
      output,
      "RECOVERY_EFFECT=clear only the eligible source-linked HALT; authorize one exact plan; CREATE still requires separate exact-plan consent",
    );
    line(
      output,
      "EXACT_RECOVERY_CONSENT=type lowercase yes to authorize this recovery",
    );
    let answer: string;
    try {
      answer = await prompt(
        "Authorize this exact source-bound recovery",
        "Attended terminal input is required.",
        { timeoutMs: 15 * 60_000, input, output },
      );
    } catch (error) {
      line(output, "VERDICT=DECLINED");
      line(
        output,
        `REASON_CODE=${error instanceof PromptInterruptedError ? "RECOVERY_CONSENT_INTERRUPTED" : "RECOVERY_CONSENT_UNAVAILABLE"}`,
      );
      line(output, "EXCHANGE_READS=0");
      line(output, "EXCHANGE_WRITES=0");
      return 3;
    }
    if (answer !== "yes") {
      line(output, "VERDICT=DECLINED");
      line(output, "REASON_CODE=RECOVERY_CONSENT_NOT_EXACT_YES");
      line(output, "EXCHANGE_READS=0");
      line(output, "EXCHANGE_WRITES=0");
      return 3;
    }
    const issuedAt = timestampFromEpochMs((dependencies.clock ?? Date.now)());
    if (!issuedAt.ok) {
      line(output, "VERDICT=BLOCKED");
      line(output, "REASON_CODE=LOCAL_TIME_INVALID");
      line(output, "EXCHANGE_READS=0");
      line(output, "EXCHANGE_WRITES=0");
      return 4;
    }
    const recovered = (dependencies.recover ?? recoverMainnetOperatorTest)({
      sourceId: snapshot.source.sourceId,
      planHash: savedPlan.contentHash,
      resolution: parsed.resolution,
      actor: dependencies.actor?.() ?? userInfo().username,
      consent: true,
      issuedAt: issuedAt.value,
    });
    if (!recovered.ok) {
      line(output, "VERDICT=BLOCKED");
      line(output, `REASON_CODE=${mapErrorCode(recovered)}`);
      line(output, "EXCHANGE_READS=0");
      line(output, "EXCHANGE_WRITES=0");
      line(
        output,
        "NEXT_ACTION=preserve the source and HALT; resolve the specific local journal conflict or collect a newer eligible cleanup proof",
      );
      return 4;
    }
    line(output, "VERDICT=RECOVERY_AUTHORIZED");
    line(output, `RECOVERY_GRANT_ID=${recovered.value.grant.grantId}`);
    line(output, `RECOVERY_GRANT_HASH=${recovered.value.grant.contentHash}`);
    line(output, `GRANT_EXPIRES_AT=${recovered.value.grant.expiresAt}`);
    line(
      output,
      `HALT_CLEARANCE=${recovered.value.grant.haltOrigin ? "recorded" : "not-needed"}`,
    );
    line(output, "EXCHANGE_READS=0");
    line(output, "EXCHANGE_WRITES=0");
    line(
      output,
      "NEXT_ACTION=review and separately approve the exact plan with mainnet:test execute before any CREATE",
    );
    return 0;
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
      printGetCounts(output, result, "EXECUTE");
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
      const reasonCode = mapErrorCode(result);
      line(output, "VERDICT=BLOCKED");
      line(
        output,
        `EXECUTION_STATE=${notStarted ? "EXECUTION_NOT_STARTED" : "RECOVERY_ONLY"}`,
      );
      line(output, `REASON_CODE=${reasonCode}`);
      if (reasonCode === "QUOTE_OUTSIDE_APPROVED_RANGE")
        line(
          output,
          "EXPLANATION=fresh best bid is outside the approved range; prepare a fresh plan and obtain new exact-plan confirmation",
        );
      const failure = evidenceRecord(result);
      const error = evidenceRecord(failure?.error);
      const details = evidenceRecord(error?.details);

      line(output, `SOURCE_ID=${sourceIdResult.value}`);
      line(output, `EXCHANGE_READS=${resultCount(result, "exchangeReads")}`);
      line(output, `EXCHANGE_WRITES=${resultCount(result, "exchangeWrites")}`);
      const insufficientCapacity =
        notStarted &&
        reasonCode === "AVAILABLE_MARGIN_OR_FEE_RESERVE_INSUFFICIENT";
      if (insufficientCapacity)
        printOperatorCapacityDiagnostic(
          output,
          operatorCapacityDiagnostic(result),
        );
      printOperatorFailureDiagnostic(output, reasonCode, details, notStarted);
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
