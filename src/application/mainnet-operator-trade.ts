import { randomUUID } from "node:crypto";

import { configuredBybitAccountIdentityHash } from "../adapters/bybit-v5/account-key-mapper.js";
import { createMacOSKeychainProvider } from "../adapters/macos-keychain.js";
import { resolveOperatorMainnetTradeCommand } from "../adapters/sqlite/operator-mainnet-test-lookup.js";
import { openSqlitePersistence } from "../adapters/sqlite/sqlite-persistence.js";
import { MARKET_EVIDENCE_SYMBOLS } from "../domain/market/market-evidence-bundle.js";
import {
  createOperatorMainnetTradeCommandBinding,
  createOperatorMainnetTradeCommandReceipt,
  rehydrateOperatorMainnetTradeCommandPlan,
  type OperatorMainnetTradeCommandReceipt,
} from "../domain/execution/operator-mainnet-trade-command.js";
import { createOperatorMainnetCreateRequest } from "./mainnet-entry-evidence.js";
import type { OperatorMainnetTestPlan } from "../domain/execution/operator-mainnet-test-plan.js";
import { localOperatorIdentityHash } from "./local-operator.js";
import { prepareMainnetOperatorTest } from "./mainnet-operator-test-preparation-composition.js";
import { runMainnetOperatorTestComposition } from "./mainnet-operator-test-composition.js";
import type {
  MainnetOperatorTestCompositionInput,
  MainnetOperatorTestOutcome,
} from "./mainnet-operator-test.js";
import { runMainnetOperatorTestStatusComposition } from "./mainnet-operator-test-status-composition.js";
import type { MainnetOperatorTestStatusResult } from "./mainnet-operator-test-status.js";
import { mainnetOperatorTestPersistenceScope } from "./mainnet-operator-test-scope.js";
import { domainError } from "../domain/shared/errors.js";
import { fail, ok, type Result } from "../domain/shared/result.js";
import {
  timestampFromEpochMs,
  timestampToEpochMs,
  type UtcTimestamp,
} from "../domain/shared/time.js";
import { requireIdentifier } from "../domain/shared/validation.js";
import type { PlanHash } from "../domain/identity/canonical-serialization.js";
import type {
  CredentialProvider,
  ExchangeCredentials,
} from "../ports/credential-provider.js";
import {
  OPERATOR_MAINNET_TRADE_COMMAND_DIAGNOSTIC_FIELDS,
  type OperatorMainnetTradeCommandDiagnosticDetails,
} from "../ports/operator-mainnet-test-persistence.js";

export interface MainnetOperatorTradeInput {
  readonly symbol: unknown;
  readonly allocation: unknown;
  readonly grossNotionalCap: unknown;
  readonly maxDeviationBps: unknown;
}

export interface MainnetOperatorTradeStageMetrics {
  readonly exchangeReads: number | undefined;
  readonly exchangeWrites: number | undefined;
  readonly exchangeGetCounts?: string;
  readonly exchangeStageElapsedMs?: number;
}

export interface MainnetOperatorTradeOutcome {
  readonly kind: "blocked" | "attempted" | "recovery" | "unknown";
  readonly commandId: string;
  readonly receiptSaved: boolean;
  readonly receiptHash?: PlanHash;
  readonly planHash?: PlanHash;
  readonly payloadHash?: PlanHash;
  readonly sourceId?: string;
  readonly clientOrderId?: string;
  readonly limitPrice?: string;
  readonly quantity?: string;
  readonly takeProfitTrigger?: string;
  readonly preparationQuoteAgeMs?: number;
  readonly admissionQuoteAgeAtReadMs?: number;
  readonly stoppedAt?:
    | "credentials"
    | "receipt"
    | "preparation"
    | "binding"
    | "admission"
    | "status";
  readonly reasonCode?: string;
  readonly diagnosticDetails?: OperatorMainnetTradeCommandDiagnosticDetails;
  readonly outcomeRecorded?: boolean;
  readonly execution?: MainnetOperatorTestOutcome;
  readonly executionStatusFailureCode?: string;
  readonly immediateStatus?: MainnetOperatorTestStatusResult;
  readonly immediateStatusFailureCode?: string;
  readonly stages: Readonly<{
    readonly prepare?: MainnetOperatorTradeStageMetrics;
    readonly execute?: MainnetOperatorTradeStageMetrics;
    readonly status?: MainnetOperatorTradeStageMetrics;
  }>;
  readonly exchangeReads: number | undefined;
  readonly exchangeWrites: number | undefined;
  readonly elapsedMs?: number;
}

export interface MainnetOperatorTradeDependencies {
  readonly credentialProvider?: Pick<CredentialProvider, "load">;
  readonly openPersistence?: typeof openSqlitePersistence;
  readonly prepare?: typeof prepareMainnetOperatorTest;
  readonly execute?: (
    input: MainnetOperatorTestCompositionInput,
  ) => Promise<Result<MainnetOperatorTestOutcome>>;
  readonly status?: (input: {
    readonly sourceId: unknown;
  }) => Promise<Result<MainnetOperatorTestStatusResult>>;
  readonly actorIdentityHash?: () => Result<PlanHash>;
  readonly clock?: () => number;
  readonly monotonicClock?: () => number;
  readonly onCommandIdGenerated?: (commandId: string) => void;
  readonly onReceiptSaved?: (
    receipt: OperatorMainnetTradeCommandReceipt,
  ) => void;
}

export interface MainnetOperatorTradeCommandStatus {
  readonly kind:
    | "not-found"
    | "interrupted-before-binding"
    | "interrupted-before-intent"
    | "pre-intent-refused"
    | "intent-present";
  readonly commandId: string;
  readonly receiptHash?: PlanHash;
  readonly planHash?: PlanHash;
  readonly sourceId?: string;
  readonly clientOrderId?: string;
  readonly reasonCode?: string;
  readonly diagnosticDetails?: OperatorMainnetTradeCommandDiagnosticDetails;
  readonly sourceStatus?: MainnetOperatorTestStatusResult;
  readonly statusFailureCode?: string;
  readonly exchangeReads: number | undefined;
}

export interface MainnetOperatorTradeStatusDependencies {
  readonly resolveCommand?: typeof resolveOperatorMainnetTradeCommand;
  readonly status?: (input: {
    readonly sourceId: unknown;
  }) => Promise<Result<MainnetOperatorTestStatusResult>>;
}

function reasonCode<T>(value: Result<T>): string {
  const reason = value.ok ? undefined : value.error.details?.reasonCode;
  if (typeof reason === "string" && /^[A-Z][A-Z0-9_]{0,79}$/u.test(reason))
    return reason;
  if (/^[A-Z][A-Z0-9_]{0,79}$/u.test(value.ok ? "" : value.error.code))
    return value.ok ? "UNSPECIFIED_FAILURE" : value.error.code;
  return "UNSPECIFIED_FAILURE";
}

function stageMetrics<T>(
  value: Result<T>,
  defaultWrites: number | undefined,
): MainnetOperatorTradeStageMetrics {
  const result = value.ok ? value.value : undefined;
  const details = value.ok ? undefined : value.error.details;
  const resultRecord =
    typeof result === "object" && result !== null
      ? (result as Record<string, unknown>)
      : undefined;
  const getNumber = (key: string): number | undefined => {
    const candidate = resultRecord?.[key] ?? details?.[key];
    if (
      typeof candidate === "number" &&
      Number.isSafeInteger(candidate) &&
      candidate >= 0
    )
      return candidate;
    return undefined;
  };
  const reads = getNumber("exchangeReads");
  const writes = getNumber("exchangeWrites");
  const elapsed = getNumber("exchangeStageElapsedMs");
  const counts = resultRecord?.exchangeGetCounts ?? details?.exchangeGetCounts;
  return {
    exchangeReads: reads,
    exchangeWrites: writes ?? defaultWrites,
    ...(typeof elapsed === "number" ? { exchangeStageElapsedMs: elapsed } : {}),
    ...(typeof counts === "string" ? { exchangeGetCounts: counts } : {}),
  };
}

function totalReads(
  stages: MainnetOperatorTradeOutcome["stages"],
): number | undefined {
  const completed = Object.values(stages).filter(
    (stage): stage is MainnetOperatorTradeStageMetrics => stage !== undefined,
  );
  if (completed.some((stage) => stage.exchangeReads === undefined))
    return undefined;
  return completed.reduce((sum, stage) => sum + (stage.exchangeReads ?? 0), 0);
}

function totalWrites(
  stages: MainnetOperatorTradeOutcome["stages"],
): number | undefined {
  const values = Object.values(stages).map((stage) => stage?.exchangeWrites);
  return values.some((value) => value === undefined)
    ? undefined
    : values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

function localTimestamp(clock: () => number): Result<UtcTimestamp> {
  try {
    return timestampFromEpochMs(clock());
  } catch {
    return fail(domainError("INVALID_TIMESTAMP", "local clock is unavailable"));
  }
}

function validTradeInput(input: unknown): input is {
  readonly symbol: string;
  readonly allocation: string;
  readonly grossNotionalCap: string;
  readonly maxDeviationBps: string;
} {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    Reflect.ownKeys(input).length !== 4 ||
    !["symbol", "allocation", "grossNotionalCap", "maxDeviationBps"].every(
      (key) => Object.hasOwn(input, key),
    )
  )
    return false;
  const record = input as Record<string, unknown>;
  return (
    typeof record.symbol === "string" &&
    MARKET_EVIDENCE_SYMBOLS.some((symbol) => symbol === record.symbol) &&
    typeof record.allocation === "string" &&
    record.allocation.length > 0 &&
    record.allocation.length <= 128 &&
    typeof record.grossNotionalCap === "string" &&
    record.grossNotionalCap.length > 0 &&
    record.grossNotionalCap.length <= 128 &&
    typeof record.maxDeviationBps === "string" &&
    record.maxDeviationBps.length > 0 &&
    record.maxDeviationBps.length <= 128
  );
}

function safeDiagnostics<T>(
  value: Result<T>,
): OperatorMainnetTradeCommandDiagnosticDetails {
  const details = value.ok ? undefined : value.error.details;
  if (!details) return {};
  const output: Record<string, string | number | boolean> = {};
  for (const key of OPERATOR_MAINNET_TRADE_COMMAND_DIAGNOSTIC_FIELDS) {
    const field = details[key];
    if (
      typeof field === "string" ||
      (typeof field === "number" && Number.isFinite(field)) ||
      typeof field === "boolean"
    )
      output[key] = field;
  }
  return output;
}

function stopped(
  commandId: string,
  receiptSaved: boolean,
  reason: string,
  stoppedAt: NonNullable<MainnetOperatorTradeOutcome["stoppedAt"]>,
  stages: MainnetOperatorTradeOutcome["stages"],
  startedAt: number,
  monotonic: () => number,
  values: Partial<MainnetOperatorTradeOutcome> = {},
): MainnetOperatorTradeOutcome {
  let elapsedMs: number | undefined;
  try {
    const current = monotonic();
    if (Number.isFinite(current) && current >= startedAt)
      elapsedMs = current - startedAt;
  } catch {
    // Duration is diagnostic only.
  }
  return {
    kind: "blocked",
    commandId,
    receiptSaved,
    stoppedAt,
    reasonCode: reason,
    stages,
    exchangeReads: totalReads(stages),
    exchangeWrites: totalWrites(stages),
    ...(elapsedMs === undefined ? {} : { elapsedMs }),
    ...values,
  };
}

/** One local instruction, immutable receipt first, one dispatch opportunity, then one immediate read-only status. */
export async function runMainnetOperatorTrade(
  input: MainnetOperatorTradeInput,
  dependencies: MainnetOperatorTradeDependencies = {},
): Promise<Result<MainnetOperatorTradeOutcome>> {
  if (!validTradeInput(input))
    return fail(
      domainError("INVALID_VALUE", "direct trade instruction is invalid", {
        reasonCode: "INVALID_TRADE_INSTRUCTION",
      }),
    );
  const clock = dependencies.clock ?? Date.now;
  const monotonic = dependencies.monotonicClock ?? (() => performance.now());
  let startedAt = Number.NaN;
  try {
    startedAt = monotonic();
  } catch {
    // Diagnostic timing is optional.
  }
  const commandId = randomUUID();
  try {
    dependencies.onCommandIdGenerated?.(commandId);
  } catch {
    return ok(
      stopped(
        commandId,
        false,
        "COMMAND_ID_OUTPUT_FAILED",
        "credentials",
        {},
        startedAt,
        monotonic,
      ),
    );
  }
  const acceptedAt = localTimestamp(clock);
  if (!acceptedAt.ok)
    return ok(
      stopped(
        commandId,
        false,
        "LOCAL_TIME_INVALID",
        "credentials",
        {},
        startedAt,
        monotonic,
      ),
    );
  const actor = (dependencies.actorIdentityHash ?? localOperatorIdentityHash)();
  if (!actor.ok)
    return ok(
      stopped(
        commandId,
        false,
        "LOCAL_OPERATOR_IDENTITY_UNAVAILABLE",
        "credentials",
        {},
        startedAt,
        monotonic,
      ),
    );

  let credentials: Readonly<ExchangeCredentials>;
  try {
    const provider = dependencies.credentialProvider;
    credentials = Object.freeze(
      provider
        ? await provider.load("mainnet")
        : await createMacOSKeychainProvider().load("mainnet"),
    );
  } catch {
    return ok(
      stopped(
        commandId,
        false,
        "MAINNET_CREDENTIALS_UNAVAILABLE",
        "credentials",
        {},
        startedAt,
        monotonic,
      ),
    );
  }
  const accountIdentityHash = configuredBybitAccountIdentityHash(
    credentials.accountId,
    "mainnet",
  );
  if (!accountIdentityHash.ok)
    return ok(
      stopped(
        commandId,
        false,
        "CONFIGURED_MAINNET_ACCOUNT_INVALID",
        "credentials",
        {},
        startedAt,
        monotonic,
      ),
    );
  const receipt = createOperatorMainnetTradeCommandReceipt({
    commandId,
    actorIdentityHash: actor.value,
    accountIdentityHash: accountIdentityHash.value,
    symbol: input.symbol,
    allocation: input.allocation,
    grossNotionalCap: input.grossNotionalCap,
    maxDeviationBps: input.maxDeviationBps,
    acceptedAt: acceptedAt.value,
  });
  if (!receipt.ok)
    return ok(
      stopped(
        commandId,
        false,
        reasonCode(receipt),
        "receipt",
        {},
        startedAt,
        monotonic,
      ),
    );

  const scope = mainnetOperatorTestPersistenceScope(accountIdentityHash.value);
  const persistence = (dependencies.openPersistence ?? openSqlitePersistence)({
    environment: "mainnet",
    scope,
    clock: { now: () => acceptedAt.value },
  });
  if (!persistence.ok)
    return ok(
      stopped(
        commandId,
        false,
        reasonCode(persistence),
        "receipt",
        {},
        startedAt,
        monotonic,
      ),
    );

  try {
    const journal = persistence.value.operatorMainnetTest;
    if (!journal)
      return ok(
        stopped(
          commandId,
          false,
          "OPERATOR_JOURNAL_UNAVAILABLE",
          "receipt",
          {},
          startedAt,
          monotonic,
        ),
      );
    const saved = journal.persistOperatorMainnetTradeCommandReceipt({
      receipt: receipt.value,
      recordedAt: acceptedAt.value,
    });
    if (!saved.ok)
      return ok(
        stopped(
          commandId,
          false,
          reasonCode(saved),
          "receipt",
          {},
          startedAt,
          monotonic,
          { receiptHash: receipt.value.contentHash },
        ),
      );
    try {
      dependencies.onReceiptSaved?.(saved.value);
    } catch {
      return ok(
        stopped(
          commandId,
          true,
          "RECEIPT_STATUS_OUTPUT_FAILED",
          "receipt",
          {},
          startedAt,
          monotonic,
          { receiptHash: receipt.value.contentHash },
        ),
      );
    }

    const stages: {
      prepare?: MainnetOperatorTradeStageMetrics;
      execute?: MainnetOperatorTradeStageMetrics;
      status?: MainnetOperatorTradeStageMetrics;
    } = {};
    const stopAfterReceipt = (
      code: string,
      stoppedAt: NonNullable<MainnetOperatorTradeOutcome["stoppedAt"]>,
      values: Partial<MainnetOperatorTradeOutcome> = {},
    ): Result<MainnetOperatorTradeOutcome> =>
      ok(
        stopped(
          commandId,
          true,
          code,
          stoppedAt,
          stages,
          startedAt,
          monotonic,
          values,
        ),
      );
    const prepare = dependencies.prepare ?? prepareMainnetOperatorTest;
    let prepared: Awaited<ReturnType<typeof prepareMainnetOperatorTest>>;
    try {
      prepared = await prepare(
        {
          symbol: input.symbol,
          allocation: input.allocation,
          grossNotionalCap: input.grossNotionalCap,
          maxDeviationBps: input.maxDeviationBps,
          tradeCommandReceipt: saved.value,
        },
        {
          credentialProvider: {
            load: async (environment) => {
              if (environment !== "mainnet")
                throw new Error("environment mismatch");
              return credentials;
            },
          },
        },
      );
    } catch {
      prepared = fail(
        domainError("INVALID_EVIDENCE", "operator preparation failed", {
          reasonCode: "PREPARATION_FAILED_CLOSED",
        }),
      );
    }
    stages.prepare = stageMetrics(prepared, 0);
    if (!prepared.ok) {
      const localNow = localTimestamp(clock);
      let outcomeRecorded = false;
      if (localNow.ok) {
        const outcome = journal.appendOperatorMainnetTradeCommandOutcome({
          commandId,
          outcomeId: randomUUID(),
          stage: "precheck",
          code: reasonCode(prepared),
          diagnosticDetails: safeDiagnostics(prepared),
          occurredAt: localNow.value,
        });
        outcomeRecorded = outcome.ok;
      }
      return stopAfterReceipt(reasonCode(prepared), "preparation", {
        receiptHash: saved.value.contentHash,
        outcomeRecorded,
        diagnosticDetails: safeDiagnostics(prepared),
      });
    }

    const plan = rehydrateOperatorMainnetTradeCommandPlan(prepared.value.plan);
    const create = plan.ok
      ? createOperatorMainnetCreateRequest(
          plan.value as unknown as OperatorMainnetTestPlan,
        )
      : plan;
    if (!plan.ok || !create.ok) {
      const code = !plan.ok
        ? "DIRECT_COMMAND_PLAN_INVALID"
        : reasonCode(create);
      const localNow = localTimestamp(clock);
      let outcomeRecorded = false;
      if (localNow.ok) {
        const outcome = journal.appendOperatorMainnetTradeCommandOutcome({
          commandId,
          outcomeId: randomUUID(),
          stage: "plan-derivation",
          code,
          occurredAt: localNow.value,
        });
        outcomeRecorded = outcome.ok;
      }
      return stopAfterReceipt(code, "preparation", {
        receiptHash: saved.value.contentHash,
        outcomeRecorded,
        diagnosticDetails: safeDiagnostics(!plan.ok ? plan : create),
      });
    }
    const boundAt = localTimestamp(clock);
    if (!boundAt.ok) {
      return stopAfterReceipt("LOCAL_TIME_INVALID", "binding", {
        receiptHash: saved.value.contentHash,
        planHash: plan.value.contentHash,
      });
    }
    const binding = createOperatorMainnetTradeCommandBinding({
      receipt: saved.value,
      plan: plan.value,
      createPayloadHash: create.value.payloadHash,
      boundAt: boundAt.value,
    });
    if (!binding.ok) {
      const code = reasonCode(binding);
      const outcome = journal.appendOperatorMainnetTradeCommandOutcome({
        commandId,
        outcomeId: randomUUID(),
        stage: "binding",
        code,
        occurredAt: boundAt.value,
      });
      return stopAfterReceipt(code, "binding", {
        receiptHash: saved.value.contentHash,
        planHash: plan.value.contentHash,
        outcomeRecorded: outcome.ok,
      });
    }
    const storedBinding = journal.bindOperatorMainnetTradeCommand({
      binding: binding.value,
      boundAt: boundAt.value,
    });
    if (!storedBinding.ok) {
      const code = reasonCode(storedBinding);
      const outcome = journal.appendOperatorMainnetTradeCommandOutcome({
        commandId,
        outcomeId: randomUUID(),
        stage: "binding",
        code,
        occurredAt: boundAt.value,
      });
      return stopAfterReceipt(code, "binding", {
        receiptHash: saved.value.contentHash,
        planHash: plan.value.contentHash,
        outcomeRecorded: outcome.ok,
      });
    }

    const boundPlanDetails = {
      receiptHash: saved.value.contentHash,
      planHash: plan.value.contentHash,
      payloadHash: create.value.payloadHash as PlanHash,
      sourceId: binding.value.sourceId,
      clientOrderId: binding.value.clientOrderId,
      limitPrice: plan.value.entry.limitPrice.toString(),
      quantity: plan.value.entry.quantity.toString(),
      takeProfitTrigger: plan.value.entry.takeProfit.triggerPrice.toString(),
    };
    const commandInput: MainnetOperatorTestCompositionInput = {
      authorization: {
        kind: "trade-command",
        receipt: saved.value,
        binding: storedBinding.value,
      },
      plan: plan.value,
      runId: `operator-trade-${commandId}`,
    };
    let executed: Result<MainnetOperatorTestOutcome>;
    try {
      executed = await (
        dependencies.execute ?? runMainnetOperatorTestComposition
      )(commandInput);
    } catch {
      executed = fail(
        domainError(
          "INVALID_CAPABILITY",
          "operator execution result is unknown",
          {
            reasonCode: "EXECUTION_RESULT_UNKNOWN",
          },
        ),
      );
    }
    stages.execute = stageMetrics(executed, undefined);

    const source = journal.readOperatorMainnetTestSource(
      binding.value.sourceId,
    );
    if (!source.ok) {
      const executionValues = executed.ok ? { execution: executed.value } : {};
      return stopAfterReceipt(
        "SOURCE_STATE_UNAVAILABLE_AFTER_EXECUTE",
        "admission",
        {
          ...boundPlanDetails,
          reasonCode: "SOURCE_STATE_UNAVAILABLE_AFTER_EXECUTE",
          kind: "unknown",
          ...(!executed.ok
            ? { executionStatusFailureCode: reasonCode(executed) }
            : {}),
          ...executionValues,
        },
      );
    }
    if (!source.value) {
      const code = executed.ok
        ? (executed.value.reasonCode ?? "EXECUTION_RETURNED_WITHOUT_INTENT")
        : reasonCode(executed);
      const localNow = localTimestamp(clock);
      let outcomeRecorded = false;
      if (localNow.ok) {
        const outcome = journal.appendOperatorMainnetTradeCommandOutcome({
          commandId,
          outcomeId: randomUUID(),
          stage: "admission",
          code,
          diagnosticDetails: safeDiagnostics(executed),
          occurredAt: localNow.value,
        });
        outcomeRecorded = outcome.ok;
      }
      return stopAfterReceipt(code, "admission", {
        ...boundPlanDetails,
        outcomeRecorded,
        ...(!executed.ok
          ? { diagnosticDetails: safeDiagnostics(executed) }
          : {}),
        ...(executed.ok ? { execution: executed.value } : {}),
      });
    }

    let immediateStatus: Result<MainnetOperatorTestStatusResult> | undefined;
    try {
      const readStatus =
        dependencies.status ??
        (async (statusInput) =>
          (await runMainnetOperatorTestStatusComposition(
            statusInput,
          )) as Result<MainnetOperatorTestStatusResult>);
      immediateStatus = await readStatus({ sourceId: binding.value.sourceId });
    } catch {
      immediateStatus = fail(
        domainError(
          "UNRESOLVED_RECONCILIATION",
          "immediate status is unknown",
          {
            reasonCode: "IMMEDIATE_STATUS_UNKNOWN",
          },
        ),
      );
    }
    stages.status = stageMetrics(immediateStatus, 0);
    const execution = executed.ok ? executed.value : undefined;
    const kind =
      execution?.kind === "attempted" || execution?.kind === "recovery"
        ? execution.kind
        : "unknown";
    let elapsedMs: number | undefined;
    try {
      const duration = monotonic() - startedAt;
      if (Number.isFinite(duration) && duration >= 0) elapsedMs = duration;
    } catch {
      // Diagnostic timing is optional.
    }
    return ok({
      kind,
      commandId,
      receiptSaved: true,
      ...boundPlanDetails,
      preparationQuoteAgeMs:
        timestampToEpochMs(plan.value.preparedAt) -
        timestampToEpochMs(plan.value.quote.observedAt),
      ...(execution?.admissionQuoteAgeAtReadMs === undefined
        ? {}
        : { admissionQuoteAgeAtReadMs: execution.admissionQuoteAgeAtReadMs }),
      ...(execution === undefined ? {} : { execution }),
      ...(executed.ok
        ? {}
        : { executionStatusFailureCode: reasonCode(executed) }),
      ...(immediateStatus?.ok
        ? { immediateStatus: immediateStatus.value }
        : immediateStatus
          ? { immediateStatusFailureCode: reasonCode(immediateStatus) }
          : {}),
      stages,
      exchangeReads: totalReads(stages),
      exchangeWrites: totalWrites(stages),
      ...(elapsedMs === undefined ? {} : { elapsedMs }),
    });
  } finally {
    persistence.value.close();
  }
}

/** Resolve local command evidence first; only a committed source invokes GET-only Bybit status. */
export async function readMainnetOperatorTradeCommandStatus(
  commandIdInput: unknown,
  dependencies: MainnetOperatorTradeStatusDependencies = {},
): Promise<Result<MainnetOperatorTradeCommandStatus>> {
  const commandId = requireIdentifier(commandIdInput, "commandId");
  if (!commandId.ok) return commandId;
  const resolved = (
    dependencies.resolveCommand ?? resolveOperatorMainnetTradeCommand
  )(commandId.value);
  if (!resolved.ok) return resolved;
  if (!resolved.value)
    return ok({
      kind: "not-found",
      commandId: commandId.value,
      exchangeReads: 0,
    });
  const snapshot = resolved.value.snapshot;
  const lastOutcome = snapshot.outcomes.at(-1);
  if (snapshot.consumption && !snapshot.source)
    return ok({
      kind: "intent-present",
      commandId: commandId.value,
      receiptHash: snapshot.receipt.contentHash,
      ...(snapshot.binding ? { planHash: snapshot.binding.planHash } : {}),
      sourceId: snapshot.consumption.sourceId,
      ...(snapshot.binding
        ? { clientOrderId: snapshot.binding.clientOrderId }
        : {}),
      reasonCode: "CONSUMED_COMMAND_SOURCE_UNAVAILABLE",
      exchangeReads: 0,
    });
  if (!snapshot.source) {
    return ok({
      kind: lastOutcome
        ? "pre-intent-refused"
        : snapshot.binding
          ? "interrupted-before-intent"
          : "interrupted-before-binding",
      commandId: commandId.value,
      receiptHash: snapshot.receipt.contentHash,
      ...(snapshot.binding ? { planHash: snapshot.binding.planHash } : {}),
      ...(snapshot.binding ? { sourceId: snapshot.binding.sourceId } : {}),
      ...(snapshot.binding
        ? { clientOrderId: snapshot.binding.clientOrderId }
        : {}),
      ...(lastOutcome
        ? {
            reasonCode: lastOutcome.code,
            diagnosticDetails: lastOutcome.diagnosticDetails,
          }
        : {}),
      exchangeReads: 0,
    });
  }
  let status: Result<MainnetOperatorTestStatusResult>;
  try {
    const readStatus =
      dependencies.status ??
      (async (statusInput) =>
        (await runMainnetOperatorTestStatusComposition(
          statusInput,
        )) as Result<MainnetOperatorTestStatusResult>);
    status = await readStatus({ sourceId: snapshot.source.source.sourceId });
  } catch {
    status = fail(
      domainError("UNRESOLVED_RECONCILIATION", "operator status is unknown", {
        reasonCode: "STATUS_COLLECTION_FAILED",
      }),
    );
  }
  return status.ok
    ? ok({
        kind: "intent-present",
        commandId: commandId.value,
        receiptHash: snapshot.receipt.contentHash,
        ...(snapshot.binding ? { planHash: snapshot.binding.planHash } : {}),
        sourceId: snapshot.source.source.sourceId,
        clientOrderId: snapshot.source.source.clientOrderId,
        sourceStatus: status.value,
        exchangeReads: status.value.exchangeReads,
      })
    : ok({
        kind: "intent-present",
        commandId: commandId.value,
        receiptHash: snapshot.receipt.contentHash,
        ...(snapshot.binding ? { planHash: snapshot.binding.planHash } : {}),
        sourceId: snapshot.source.source.sourceId,
        clientOrderId: snapshot.source.source.clientOrderId,
        statusFailureCode: reasonCode(status),
        exchangeReads:
          typeof status.error.details?.exchangeReads === "number"
            ? status.error.details.exchangeReads
            : undefined,
      });
}
