import { openSqliteConnection } from "./connection.js";
import { SqliteOperatorMainnetTestStore } from "./operator-mainnet-test-store.js";
import type { PersistenceScope } from "../../ports/persistence.js";
import type { OperatorMainnetTestSnapshot } from "../../ports/operator-mainnet-test-persistence.js";
import type { OperatorMainnetTestPlan } from "../../domain/execution/operator-mainnet-test-plan.js";
import type { PlanHash } from "../../domain/identity/canonical-serialization.js";
import type { Clock } from "../../domain/shared/time.js";
import { domainError } from "../../domain/shared/errors.js";
import { fail, ok, type Result } from "../../domain/shared/result.js";
import {
  requireHash,
  requireIdentifier,
} from "../../domain/shared/validation.js";

export interface OperatorMainnetTestLookupOptions {
  readonly rootDirectory?: string;
  readonly databasePath?: string;
  readonly clock?: Clock;
}

export interface ResolvedOperatorMainnetPlan {
  readonly scope: PersistenceScope;
  readonly plan: OperatorMainnetTestPlan;
}

export interface ResolvedOperatorMainnetSource {
  readonly scope: PersistenceScope;
  readonly snapshot: OperatorMainnetTestSnapshot;
}

function open(options: OperatorMainnetTestLookupOptions) {
  return openSqliteConnection({
    environment: "mainnet",
    ...(options.rootDirectory === undefined
      ? {}
      : { rootDirectory: options.rootDirectory }),
    ...(options.databasePath === undefined
      ? {}
      : { databasePath: options.databasePath }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
}

function scopeFor(accountId: string): PersistenceScope {
  return {
    exchange: "bybit",
    environment: "mainnet",
    accountId,
    category: "linear",
    positionMode: "one-way",
  };
}

/** Resolve a canonical plan artifact before opening its account-scoped facade. */
export function resolveOperatorMainnetPlan(
  planHashInput: unknown,
  options: OperatorMainnetTestLookupOptions = {},
): Result<ResolvedOperatorMainnetPlan | undefined> {
  const planHash = requireHash(planHashInput, "planHash");
  if (!planHash.ok) return planHash;
  const connection = open(options);
  if (!connection.ok) return connection;
  try {
    const artifactId = `operator-mainnet-test:${planHash.value}`;
    const row = connection.value.db
      .prepare(
        `SELECT account_id FROM artifacts
         WHERE artifact_id = ? AND exchange = 'bybit' AND environment = 'mainnet'
           AND category = 'linear' AND position_mode = 'one-way'`,
      )
      .get(artifactId) as { account_id?: unknown } | undefined;
    if (row === undefined) return ok(undefined);
    if (
      typeof row.account_id !== "string" ||
      !requireHash(row.account_id, "accountId").ok
    )
      return fail(
        domainError("PERSISTENCE_INTEGRITY", "prepared plan scope is invalid"),
      );
    const scope = scopeFor(row.account_id);
    const journal = new SqliteOperatorMainnetTestStore(connection.value, scope);
    const plan = journal.readPreparedPlan(planHash.value as PlanHash);
    if (!plan.ok) return plan;
    return plan.value ? ok({ scope, plan: plan.value }) : ok(undefined);
  } catch {
    return fail(
      domainError("PERSISTENCE_INTEGRITY", "prepared plan lookup failed"),
    );
  } finally {
    connection.value.close();
  }
}

/** Resolve a source's account scope without exposing any exchange capability. */
export function resolveOperatorMainnetSource(
  sourceIdInput: unknown,
  options: OperatorMainnetTestLookupOptions = {},
): Result<ResolvedOperatorMainnetSource | undefined> {
  const sourceId = requireIdentifier(sourceIdInput, "sourceId");
  if (!sourceId.ok) return sourceId;
  const connection = open(options);
  if (!connection.ok) return connection;
  try {
    const row = connection.value.db
      .prepare(
        `SELECT account_id FROM operator_mainnet_test_sources
         WHERE source_id = ? AND exchange = 'bybit' AND environment = 'mainnet'
           AND category = 'linear' AND position_mode = 'one-way'`,
      )
      .get(sourceId.value) as { account_id?: unknown } | undefined;
    if (row === undefined) return ok(undefined);
    if (
      typeof row.account_id !== "string" ||
      !requireHash(row.account_id, "accountId").ok
    )
      return fail(
        domainError(
          "PERSISTENCE_INTEGRITY",
          "operator source scope is invalid",
        ),
      );
    const scope = scopeFor(row.account_id);
    const journal = new SqliteOperatorMainnetTestStore(connection.value, scope);
    const snapshot = journal.readOperatorMainnetTestSource(sourceId.value);
    if (!snapshot.ok) return snapshot;
    return snapshot.value
      ? ok({ scope, snapshot: snapshot.value })
      : ok(undefined);
  } catch {
    return fail(
      domainError("PERSISTENCE_INTEGRITY", "operator source lookup failed"),
    );
  } finally {
    connection.value.close();
  }
}
