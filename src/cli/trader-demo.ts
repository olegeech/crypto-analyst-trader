import { userInfo } from "node:os";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { createMacOSKeychainProvider } from "../adapters/macos-keychain.js";
import { BybitDemoExecutionAdapter } from "../adapters/bybit-v5/execution-adapter.js";
import { createBybitDemoTransport } from "../adapters/bybit-v5/transport.js";
import {
  openSqlitePersistence,
  type SqlitePersistence,
} from "../adapters/sqlite/sqlite-persistence.js";
import {
  createDemoEntryUseCase,
  type DemoEntryOutcome,
  type DemoEntryReview,
} from "../application/demo-entry-use-case.js";
import { parseDemoEntryInput } from "../application/demo-entry-input.js";
import {
  exitCodeForFailure,
  failureFromDomain,
  failureFromExchange,
  type DemoEntryFailure,
} from "../application/application-errors.js";
import { hashCanonical } from "../domain/identity/plan-hash.js";
import { systemClock, type Clock } from "../domain/shared/time.js";
import type { Result } from "../domain/shared/result.js";
import type {
  ExchangeExecutionFailure,
  ExchangeExecutionPort,
  ExchangeReadState,
} from "../ports/exchange-execution.js";
import type {
  CredentialProvider,
  ExchangeCredentials,
} from "../ports/credential-provider.js";
import type {
  PersistencePort,
  PersistenceScope,
} from "../ports/persistence.js";
import { promptVisible } from "./interactive-prompt.js";

export const TRADER_DEMO_USAGE =
  "Usage: npm run trader:demo -- --symbol DOGEUSDT --side buy|sell --notional 10 (--take-profit-percent 3 | --take-profit-price 0.103)";

const DEMO_SCOPE = Object.freeze({
  exchange: "bybit",
  environment: "demo" as const,
  category: "linear",
  positionMode: "one-way" as const,
});

const APPROVAL_TIMEOUT_MS = 120_000;

type InputStream = NodeJS.ReadableStream & { readonly isTTY?: boolean };
type OutputStream = NodeJS.WritableStream & { readonly isTTY?: boolean };

export interface TraderDemoPersistenceFactoryOptions {
  readonly scope: PersistenceScope;
  readonly clock: Clock;
}

export type TraderDemoPersistence = PersistencePort & {
  readonly close?: () => void;
};

export interface TraderDemoCliDependencies {
  readonly credentialProvider?: Pick<CredentialProvider, "load">;
  readonly createExchange?: (
    credentials: ExchangeCredentials,
    clock: Clock,
  ) => ExchangeExecutionPort;
  readonly openPersistence?: (
    options: TraderDemoPersistenceFactoryOptions,
  ) => Result<TraderDemoPersistence>;
  readonly prompt?: typeof promptVisible;
  readonly input?: InputStream;
  readonly output?: OutputStream;
  readonly clock?: Clock;
  readonly actor?: string;
}

interface CliFailure extends DemoEntryFailure {
  readonly exitCode: number;
  readonly verdict: "NOT_READY" | "DECLINED" | "HALTED" | "UNRESOLVED";
}

function sanitizeTerminalText(value: string): string {
  return value.replace(
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0080-\u009f\u2028\u2029]/gu,
    "",
  );
}

function writeLine(output: OutputStream, value: string): void {
  output.write(`${sanitizeTerminalText(value)}\n`);
}

function failure(
  reasonCode: string,
  message: string,
  nextAction: string,
  exitCode: number,
  verdict: CliFailure["verdict"] = "NOT_READY",
): CliFailure {
  return {
    reasonCode,
    message,
    nextAction,
    exitCode,
    verdict,
  };
}

function verdictForFailure(
  failureValue: DemoEntryFailure,
): CliFailure["verdict"] {
  if (
    failureValue.reasonCode === "HALT_ACTIVE" ||
    failureValue.reasonCode === "RUN_LEASE_HELD" ||
    failureValue.reasonCode === "RUN_LEASE_LOST"
  ) {
    return "HALTED";
  }
  if (
    failureValue.reasonCode === "UNRESOLVED_STATE" ||
    failureValue.reasonCode === "UNRESOLVED_RECONCILIATION"
  ) {
    return "UNRESOLVED";
  }
  return "NOT_READY";
}

function printFailure(output: OutputStream, value: CliFailure): number {
  writeLine(output, `VERDICT=${value.verdict}`);
  writeLine(output, `REASON_CODE=${value.reasonCode}`);
  writeLine(output, `MESSAGE=${value.message}`);
  writeLine(output, `NEXT_ACTION=${value.nextAction}`);
  return value.exitCode;
}

function printDomainFailure(
  output: OutputStream,
  error: Parameters<typeof failureFromDomain>[0],
  nextAction?: string,
): number {
  const mapped = failureFromDomain(error, nextAction);
  return printFailure(
    output,
    failure(
      mapped.reasonCode,
      mapped.message,
      mapped.nextAction,
      exitCodeForFailure(mapped),
      verdictForFailure(mapped),
    ),
  );
}

function printExchangeFailure(
  output: OutputStream,
  error: ExchangeExecutionFailure,
): number {
  const mapped = failureFromExchange(error);
  const exitCode =
    error.kind === "ambiguous" || error.kind === "ownership"
      ? 5
      : error.kind === "precondition"
        ? 4
        : error.kind === "authentication" ||
            error.kind === "permission" ||
            error.kind === "configuration" ||
            error.kind === "invalid-response" ||
            error.kind === "transport" ||
            error.kind === "rate-limited" ||
            error.kind === "clock-skew"
          ? 4
          : 1;
  return printFailure(
    output,
    failure(
      mapped.reasonCode,
      mapped.message,
      mapped.nextAction,
      exitCode,
      exitCode === 5 ? "UNRESOLVED" : "NOT_READY",
    ),
  );
}

function printUnexpected(output: OutputStream): number {
  return printFailure(
    output,
    failure(
      "INTERNAL_ERROR",
      "Demo operator flow failed before a safe result was produced.",
      "inspect the local sanitized failure and retry only after the cause is understood",
      1,
    ),
  );
}

function defaultActor(): string {
  try {
    const username = userInfo().username.replace(/[^A-Za-z0-9._:-]/gu, "-");
    const value = `os-${username}`.slice(0, 120);
    return value.length > 3 ? value : "demo-operator";
  } catch {
    return "demo-operator";
  }
}

function defaultCreateExchange(
  credentials: ExchangeCredentials,
  clock: Clock,
): ExchangeExecutionPort {
  const transport = createBybitDemoTransport({ credentials });
  return new BybitDemoExecutionAdapter({
    accountId: credentials.accountId,
    transport,
    clock,
  });
}

function defaultOpenPersistence(
  options: TraderDemoPersistenceFactoryOptions,
): Result<SqlitePersistence> {
  return openSqlitePersistence({
    environment: "demo",
    scope: options.scope,
    clock: options.clock,
  });
}

function accountIdentityHash(state: ExchangeReadState): Result<string> {
  return hashCanonical({
    accountId: state.accountMetadata.accountId,
    userId: state.accountMetadata.userId,
  });
}

function exactDemoScope(state: ExchangeReadState): Result<PersistenceScope> {
  const scope = state.account.scope;
  if (
    scope.exchange !== DEMO_SCOPE.exchange ||
    scope.environment !== DEMO_SCOPE.environment ||
    scope.category !== DEMO_SCOPE.category ||
    scope.positionMode !== DEMO_SCOPE.positionMode
  ) {
    return {
      ok: false,
      error: {
        code: "PERSISTENCE_ENVIRONMENT",
        message: "the operator command accepts only the fixed Bybit Demo scope",
      },
    };
  }
  return {
    ok: true,
    value: Object.freeze({
      ...DEMO_SCOPE,
      accountId: state.accountMetadata.accountId,
    }),
  };
}

function validateAuthenticatedPreflight(
  state: ExchangeReadState,
  credentials: ExchangeCredentials,
): Result<void> {
  if (
    state.accountMetadata.accountId !== credentials.accountId ||
    state.accountMetadata.userId !== credentials.accountId
  ) {
    return {
      ok: false,
      error: {
        code: "PERSISTENCE_ENVIRONMENT",
        message:
          "authenticated Demo user identity does not match the configured account identity",
      },
    };
  }
  const metadata = state.accountMetadata.apiKey;
  if (metadata.readOnly) {
    return {
      ok: false,
      error: {
        code: "CAPABILITY_UNSUPPORTED",
        message: "the Demo API key is read-only",
      },
    };
  }
  if (!metadata.contractTrade.order || !metadata.contractTrade.position) {
    return {
      ok: false,
      error: {
        code: "CAPABILITY_UNSUPPORTED",
        message: "the Demo API key lacks required ContractTrade permissions",
      },
    };
  }
  if (metadata.wallet.withdraw || metadata.wallet.transfer) {
    return {
      ok: false,
      error: {
        code: "CAPABILITY_UNSUPPORTED",
        message: "the Demo API key has a prohibited wallet permission",
      },
    };
  }
  return { ok: true, value: undefined };
}

function printPreflight(output: OutputStream, state: ExchangeReadState): void {
  const identity = accountIdentityHash(state);
  if (identity.ok) writeLine(output, `ACCOUNT_IDENTITY_HASH=${identity.value}`);
  writeLine(
    output,
    `API_KEY_IP_BINDING=${state.accountMetadata.apiKey.ipBinding}`,
  );
  for (const warning of state.accountMetadata.apiKey.warningCodes) {
    writeLine(output, `WARNING=${warning}`);
  }
  if (state.accountMetadata.apiKey.expiresAt !== undefined) {
    writeLine(
      output,
      `API_KEY_EXPIRES_AT=${state.accountMetadata.apiKey.expiresAt}`,
    );
  }
}

function printReview(output: OutputStream, review: DemoEntryReview): void {
  const takeProfit = review.plan.intent.protection?.takeProfit;
  writeLine(output, "DEMO_REVIEW");
  writeLine(output, `SYMBOL=${review.input.symbol}`);
  writeLine(output, `SIDE=${review.input.side}`);
  writeLine(output, `NOTIONAL=${review.input.notional.toString()}`);
  writeLine(output, `PRICE=${review.plan.intent.price.toString()}`);
  writeLine(output, `QUANTITY=${review.plan.intent.quantity.toString()}`);
  writeLine(
    output,
    `TAKE_PROFIT=${takeProfit === undefined ? "UNPROVEN" : takeProfit.toString()}`,
  );
  writeLine(output, `ORDER_TYPE=${review.plan.orderType}`);
  writeLine(output, `TIME_IN_FORCE=${review.plan.timeInForce}`);
  writeLine(
    output,
    `LEVERAGE_CURRENT=${review.plan.leverage.current.toString()}`,
  );
  writeLine(
    output,
    `LEVERAGE_TARGET=${review.plan.leverage.target.toString()}`,
  );
  writeLine(output, `LEVERAGE_DIFF=${review.plan.leverage.diff.toString()}`);
  writeLine(output, `PLAN_HASH=${review.plan.plan.materialHash}`);
  writeLine(output, `CLIENT_ORDER_ID=${review.plan.clientOrderId}`);
  writeLine(output, `APPROVAL_EXPIRES_AT=${review.approvalExpiresAt}`);
}

function printOutcome(output: OutputStream, outcome: DemoEntryOutcome): number {
  writeLine(output, `VERDICT=${outcome.verdict}`);
  writeLine(output, `REASON_CODE=${outcome.reasonCode}`);
  writeLine(output, `NEXT_ACTION=${outcome.nextAction}`);
  writeLine(output, `ACCOUNT_IDENTITY_HASH=${outcome.accountIdentityHash}`);
  writeLine(output, `PLAN_HASH=${outcome.planHash}`);
  writeLine(output, `CLIENT_ORDER_ID=${outcome.clientOrderId}`);
  if (outcome.exchangeOrderId !== undefined)
    writeLine(output, `EXCHANGE_ORDER_ID=${outcome.exchangeOrderId}`);
  if (outcome.reconciliationStatus !== undefined)
    writeLine(output, `RECONCILIATION_STATUS=${outcome.reconciliationStatus}`);
  return outcome.verdict === "CONFIRMED_FILLED" ||
    outcome.verdict === "CONFIRMED_OPEN"
    ? 0
    : outcome.verdict === "DECLINED"
      ? 3
      : outcome.verdict === "NOT_READY"
        ? 4
        : 5;
}

function promptWasApproved(answer: string): boolean | undefined {
  const normalized = answer.trim().toLowerCase();
  if (normalized === "yes" || normalized === "y") return true;
  if (normalized === "no" || normalized === "n") return false;
  return undefined;
}

function promptFailure(error: unknown): CliFailure {
  const reasonCode =
    error !== null &&
    typeof error === "object" &&
    "reason" in error &&
    (error.reason === "timeout" || error.reason === "cancelled")
      ? error.reason === "timeout"
        ? "APPROVAL_TIMEOUT"
        : "APPROVAL_CANCELLED"
      : "APPROVAL_INVALID";
  return failure(
    reasonCode,
    "the exact Demo review was not approved",
    "run the command again and answer yes once when the displayed plan is correct",
    3,
    "DECLINED",
  );
}

export async function runTraderDemoCli(
  argv: readonly string[],
  dependencies: TraderDemoCliDependencies = {},
): Promise<number> {
  const output = dependencies.output ?? process.stdout;
  const input = dependencies.input ?? process.stdin;
  const clock = dependencies.clock ?? systemClock;
  const parsed = parseDemoEntryInput(argv);
  if (!parsed.ok) {
    writeLine(output, TRADER_DEMO_USAGE);
    return printDomainFailure(
      output,
      parsed.error,
      "correct the explicit Demo command arguments",
    );
  }
  if (input.isTTY !== true || output.isTTY !== true) {
    return printFailure(
      output,
      failure(
        "NOT_TTY",
        "a write-capable Demo command requires both input and output TTYs",
        "run trader:demo from an interactive terminal",
        4,
      ),
    );
  }

  let credentials: ExchangeCredentials;
  try {
    const provider =
      dependencies.credentialProvider ?? createMacOSKeychainProvider();
    credentials = await provider.load("demo");
  } catch {
    return printFailure(
      output,
      failure(
        "CREDENTIALS_UNAVAILABLE",
        "dedicated Bybit Demo credentials could not be loaded",
        "configure or unlock the Demo Keychain credentials and retry",
        4,
      ),
    );
  }

  const createExchange = dependencies.createExchange ?? defaultCreateExchange;
  let exchange: ExchangeExecutionPort;
  try {
    exchange = createExchange(credentials, clock);
  } catch {
    return printFailure(
      output,
      failure(
        "EXCHANGE_CONFIGURATION",
        "the fixed Bybit Demo adapter could not be configured",
        "inspect the Demo credential configuration before retrying",
        4,
      ),
    );
  }

  let preflight: ExchangeReadState;
  try {
    const read = await exchange.readState({ instrument: parsed.value.symbol });
    if (!read.ok) return printExchangeFailure(output, read.error);
    const authenticated = validateAuthenticatedPreflight(
      read.value,
      credentials,
    );
    if (!authenticated.ok)
      return printDomainFailure(output, authenticated.error);
    const scope = exactDemoScope(read.value);
    if (!scope.ok) return printDomainFailure(output, scope.error);
    preflight = read.value;
  } catch {
    return printUnexpected(output);
  }
  printPreflight(output, preflight);

  const scope = exactDemoScope(preflight);
  if (!scope.ok) return printDomainFailure(output, scope.error);
  const openPersistence =
    dependencies.openPersistence ?? defaultOpenPersistence;
  let persistence: Result<TraderDemoPersistence>;
  try {
    persistence = openPersistence({ scope: scope.value, clock });
  } catch {
    return printUnexpected(output);
  }
  if (!persistence.ok) return printDomainFailure(output, persistence.error);

  try {
    const application = createDemoEntryUseCase({
      exchange,
      persistence: persistence.value,
      clock,
      approvalActor: dependencies.actor ?? defaultActor(),
    });
    const review = await application.prepare(parsed.value);
    if (!review.ok) return printDomainFailure(output, review.error);
    printReview(output, review.value);

    let approval: boolean;
    try {
      const answer = await (dependencies.prompt ?? promptVisible)(
        "Approve this exact Demo plan? (yes/no)",
        "Approval requires an interactive terminal.",
        {
          input,
          output,
          timeoutMs: APPROVAL_TIMEOUT_MS,
        },
      );
      const parsedApproval = promptWasApproved(answer);
      if (parsedApproval === undefined)
        return printFailure(output, promptFailure(undefined));
      approval = parsedApproval;
    } catch (error) {
      return printFailure(output, promptFailure(error));
    }

    const result = await application.execute(review.value, approval);
    if (!result.ok) return printDomainFailure(output, result.error);
    return printOutcome(output, result.value);
  } catch {
    return printUnexpected(output);
  } finally {
    try {
      persistence.value.close?.();
    } catch {
      // The operator already received the application outcome; close failures
      // must not turn a bounded exchange result into an unclassified throw.
    }
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = await runTraderDemoCli(process.argv.slice(2));
}
