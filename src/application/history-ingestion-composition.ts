import { createMacOSKeychainProvider } from "../adapters/macos-keychain.js";
import {
  BybitAccountReadTransport,
  type AccountReadBudget,
} from "../adapters/bybit-v5/account-read-transport.js";
import { mapAccountReadIdentity } from "../adapters/bybit-v5/account-key-mapper.js";
import { BybitHistoryReadClient } from "../adapters/bybit-v5/history-read-client.js";
import { createSqliteHistoryStore } from "../adapters/sqlite/history-store.js";
import {
  openSqliteConnection,
  type SqliteConnection,
} from "../adapters/sqlite/connection.js";
import { createSqliteOperatorMainnetTestStore } from "../adapters/sqlite/operator-mainnet-test-store.js";
import { createSqlitePreparedLegStore } from "../adapters/sqlite/prepared-leg-store.js";
import { domainError } from "../domain/shared/errors.js";
import { fail, ok, type Result } from "../domain/shared/result.js";
import { timestampFromEpochMs } from "../domain/shared/time.js";
import type {
  CredentialEnvironment,
  CredentialProvider,
} from "../ports/credential-provider.js";
import type { HistoryStoreScope } from "../ports/history-store.js";
import type { OperatorMainnetTestSnapshot } from "../ports/operator-mainnet-test-persistence.js";
import type {
  PreparedLegRunSnapshot,
  PersistenceScope,
} from "../ports/persistence.js";
import {
  runHistoryIngestion,
  validateHistoryIngestionInput,
  validateHistorySyncBudget,
  createHistorySyncDiagnostic,
  historySyncDiagnosticDetails,
  safeHistorySyncReasonCode,
  type HistoryIngestionInput,
  type HistorySyncReport,
} from "./history-ingestion.js";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_LINEAGE_SOURCES = 10_000;

export interface LiveHistorySyncInput {
  readonly environment: CredentialEnvironment;
  readonly databasePath: string;
  readonly selection: HistoryIngestionInput["selection"];
  readonly budget?: HistoryIngestionInput["budget"];
}

export interface LiveHistorySyncDependencies {
  readonly credentialProvider?: Pick<CredentialProvider, "load">;
  readonly request?: typeof fetch;
  readonly utcClock?: () => number;
  readonly monotonicClock?: () => number;
  readonly openConnection?: typeof openSqliteConnection;
}

function failure(
  error: unknown,
  message: string,
  stage: string,
  attemptedAction: string,
  environment?: string,
  exchangeReads = 0,
) {
  const diagnostic = createHistorySyncDiagnostic(
    error,
    stage,
    attemptedAction,
    environment,
  );
  return fail(
    domainError(
      "INVALID_VALUE",
      `${diagnostic.reasonCode}: ${message}`,
      historySyncDiagnosticDetails(diagnostic, exchangeReads),
    ),
  );
}

function localFailure(code: string, message: string) {
  return fail(
    domainError(
      "INVALID_VALUE",
      `${safeHistorySyncReasonCode(code)}: ${message}`,
    ),
  );
}

export function loadHistoryAttributionLineageSnapshots(
  connection: SqliteConnection,
  accountId: string,
): Result<{
  readonly operatorSources: readonly OperatorMainnetTestSnapshot[];
  readonly preparedSources: readonly PreparedLegRunSnapshot[];
}> {
  if (connection.environment !== "mainnet")
    return ok({ operatorSources: [], preparedSources: [] });
  const scope: PersistenceScope = {
    exchange: "bybit",
    environment: "mainnet",
    accountId,
    category: "linear",
    positionMode: "one-way",
  };
  try {
    const operatorStore = createSqliteOperatorMainnetTestStore(
      connection,
      scope,
    );
    if (!operatorStore.ok) return operatorStore;
    const preparedStore = createSqlitePreparedLegStore(connection, scope);
    if (!preparedStore.ok) return preparedStore;
    const operatorRows = connection.db
      .prepare(
        `SELECT source_id FROM operator_mainnet_test_sources
         WHERE exchange = ? AND environment = ? AND account_id = ?
           AND category = ? AND position_mode = ? ORDER BY created_at, source_id
         LIMIT ?`,
      )
      .all(
        "bybit",
        "mainnet",
        accountId,
        "linear",
        "one-way",
        MAX_LINEAGE_SOURCES + 1,
      ) as readonly { source_id?: unknown }[];
    const preparedRows = connection.db
      .prepare(
        `SELECT source_id FROM prepared_leg_sources
         WHERE exchange = ? AND environment = ? AND account_id = ?
           AND category = ? AND position_mode = ? ORDER BY created_at, source_id
         LIMIT ?`,
      )
      .all(
        "bybit",
        "mainnet",
        accountId,
        "linear",
        "one-way",
        MAX_LINEAGE_SOURCES + 1,
      ) as readonly { source_id?: unknown }[];
    if (
      operatorRows.length > MAX_LINEAGE_SOURCES ||
      preparedRows.length > MAX_LINEAGE_SOURCES
    )
      return localFailure(
        "LINEAGE_SOURCE_LIMIT_EXCEEDED",
        "local ownership evidence exceeds the bounded lookup limit",
      );
    const operatorSources: OperatorMainnetTestSnapshot[] = [];
    for (const row of operatorRows) {
      if (typeof row.source_id !== "string")
        return localFailure(
          "LOCAL_LINEAGE_INVALID",
          "a scoped operator source ID is invalid",
        );
      const snapshot = operatorStore.value.readOperatorMainnetTestSource(
        row.source_id,
      );
      if (!snapshot.ok) return snapshot;
      if (snapshot.value) operatorSources.push(snapshot.value);
    }
    const preparedSources: PreparedLegRunSnapshot[] = [];
    for (const row of preparedRows) {
      if (typeof row.source_id !== "string")
        return localFailure(
          "LOCAL_LINEAGE_INVALID",
          "a scoped prepared source ID is invalid",
        );
      const snapshot = preparedStore.value.readPreparedLegSource(row.source_id);
      if (!snapshot.ok) return snapshot;
      if (snapshot.value) preparedSources.push(snapshot.value);
    }
    return ok({ operatorSources, preparedSources });
  } catch {
    return localFailure(
      "LOCAL_LINEAGE_READ_FAILED",
      "scoped local ownership evidence could not be read",
    );
  }
}

export async function runLiveHistorySync(
  input: LiveHistorySyncInput,
  dependencies: LiveHistorySyncDependencies = {},
): Promise<Result<HistorySyncReport>> {
  if (
    !input ||
    !["demo", "testnet", "mainnet"].includes(input.environment) ||
    typeof input.databasePath !== "string" ||
    !input.databasePath.startsWith("/")
  )
    return failure(
      "INVALID_LIVE_CONFIGURATION",
      "environment and an absolute SQLite path are required",
      "request-validation",
      "validate the explicit environment and local database path",
    );
  const monotonic = dependencies.monotonicClock ?? (() => performance.now());
  const wall = dependencies.utcClock ?? Date.now;
  const validatedBudget = validateHistorySyncBudget(input.budget);
  if (!validatedBudget.ok)
    return failure(
      "INVALID_BUDGET",
      "GET, page, row and duration budgets exceed the live hard limits",
      "request-validation",
      "validate the bounded history request",
      input.environment,
    );
  const budgetInput = validatedBudget.value;
  const started = monotonic();
  if (!Number.isFinite(started))
    return failure(
      "CLOCK_INVALID",
      "monotonic clock is unavailable",
      "request-validation",
      "validate the local monotonic clock",
      input.environment,
    );
  const budget: AccountReadBudget = {
    deadline: started + budgetInput.maxDurationMs,
    attempts: 0,
    maxAttempts: budgetInput.maxGetAttempts,
    maxResponseBytes: MAX_RESPONSE_BYTES,
    maxObservedResponseBytes: 0,
  };
  let connection: SqliteConnection | undefined;
  let stage = "credential-load";
  let attemptedAction = `load ${input.environment} Bybit credentials`;
  try {
    const provider =
      dependencies.credentialProvider ?? createMacOSKeychainProvider();
    const credentials = await provider.load(input.environment);
    const bootstrap = new BybitAccountReadTransport({
      environment: input.environment,
      credentials,
      budget,
      ...(dependencies.request === undefined
        ? {}
        : { request: dependencies.request }),
      clock: wall,
      monotonicClock: monotonic,
    });
    stage = "server-time-read";
    attemptedAction = "read Bybit server time for signed requests";
    const before = wall();
    const firstServerTime = await bootstrap.readExchangeTime();
    const after = wall();
    const clockOffsetMs = firstServerTime - Math.round((before + after) / 2);
    if (!Number.isSafeInteger(clockOffsetMs))
      return failure(
        "TIME_OFFSET_UNUSABLE",
        "Bybit server time cannot safely sign authenticated reads",
        stage,
        attemptedAction,
        input.environment,
        budget.attempts,
      );
    const transport = new BybitAccountReadTransport({
      environment: input.environment,
      credentials,
      budget,
      ...(dependencies.request === undefined
        ? {}
        : { request: dependencies.request }),
      clock: wall,
      monotonicClock: monotonic,
      clockOffsetMs,
    });
    stage = "account-identity-read";
    attemptedAction =
      "verify the selected Bybit API key identity and permissions";
    const identityResponse = await transport.get("/v5/user/query-api");
    stage = "history-boundary-read";
    attemptedAction = "freeze the Bybit server-time boundary for this sync";
    const frozenUpperBoundMs = await transport.readExchangeTime();
    if (!Number.isSafeInteger(frozenUpperBoundMs) || frozenUpperBoundMs <= 0)
      return failure(
        "SERVER_TIME_INVALID",
        "Bybit history upper bound is invalid",
        stage,
        attemptedAction,
        input.environment,
        budget.attempts,
      );
    const identityAt = timestampFromEpochMs(frozenUpperBoundMs);
    if (!identityAt.ok)
      return failure(
        "SERVER_TIME_INVALID",
        "Bybit identity evidence has invalid server time",
        stage,
        attemptedAction,
        input.environment,
        budget.attempts,
      );
    stage = "account-identity-validation";
    attemptedAction = "validate Bybit account identity and read permissions";
    const identity = mapAccountReadIdentity(
      identityResponse,
      credentials.accountId,
      input.environment,
      identityAt.value,
    );
    const scope: HistoryStoreScope = {
      exchange: "bybit",
      environment: input.environment,
      accountId: identity.accountBinding.accountIdentityHash,
    };
    const ingestionInput: HistoryIngestionInput = {
      scope,
      selection: input.selection,
      frozenUpperBoundMs,
      budget: budgetInput,
    };
    const validInput = validateHistoryIngestionInput(ingestionInput);
    if (!validInput.ok)
      return failure(
        validInput.error.code,
        "history range or sync parameters are invalid",
        "request-validation",
        "validate the selected history range before opening the local database",
        input.environment,
        budget.attempts,
      );

    stage = "local-database-open";
    attemptedAction = "open the explicitly selected local SQLite database";
    const opened = (dependencies.openConnection ?? openSqliteConnection)({
      environment: input.environment,
      databasePath: input.databasePath,
      clock: {
        now: () => {
          const timestamp = timestampFromEpochMs(wall());
          if (!timestamp.ok) throw new Error("local clock unavailable");
          return timestamp.value;
        },
      },
    });
    if (!opened.ok)
      return failure(
        opened.error.code,
        "the explicitly selected local database could not be opened",
        stage,
        attemptedAction,
        input.environment,
        budget.attempts,
      );
    connection = opened.value;
    const store = createSqliteHistoryStore(connection);
    stage = "local-lineage-read";
    attemptedAction = "read account-scoped operator and prepared-run lineage";
    const lineage = loadHistoryAttributionLineageSnapshots(
      connection,
      scope.accountId,
    );
    if (!lineage.ok)
      return failure(
        lineage.error,
        "scoped local ownership evidence could not be read",
        stage,
        attemptedAction,
        input.environment,
        budget.attempts,
      );
    stage = "history-ingestion";
    attemptedAction = "read and persist bounded Bybit history pages";
    const result = await runHistoryIngestion(
      {
        ...ingestionInput,
        operatorSources: lineage.value.operatorSources,
        preparedSources: lineage.value.preparedSources,
      },
      {
        reader: new BybitHistoryReadClient({
          transport,
          utcClock: wall,
        }),
        store,
        monotonicClock: monotonic,
        getAttemptCount: () => budget.attempts,
      },
    );
    return result.ok
      ? ok({
          ...result.value,
          getAttempts: budget.attempts,
          elapsedMs: Math.trunc(monotonic() - started),
        })
      : failure(
          result.error,
          "history ingestion stopped before a trustworthy report was created",
          stage,
          attemptedAction,
          input.environment,
          budget.attempts,
        );
  } catch (error) {
    return failure(
      error,
      "read-only history synchronization could not complete",
      stage,
      attemptedAction,
      input.environment,
      budget.attempts,
    );
  } finally {
    connection?.close();
  }
}
