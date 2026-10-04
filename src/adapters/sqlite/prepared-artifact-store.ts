import {
  encodeCanonicalArtifact,
  rehydrateArtifact,
} from "../../domain/identity/canonical-artifact.js";
import { hashCanonical } from "../../domain/identity/canonical-serialization.js";
import {
  rehydratePreparedDailyPlan,
  type PreparedDailyPlan,
} from "../../domain/review/prepared-daily-plan.js";
import {
  rehydratePreparedPlanApproval,
  type PreparedPlanApproval,
} from "../../domain/review/prepared-plan-approval.js";
import { domainError } from "../../domain/shared/errors.js";
import { fail, ok, type Result } from "../../domain/shared/result.js";
import { requireHash } from "../../domain/shared/validation.js";
import type { PreparedArtifactStore } from "../../ports/prepared-artifact-store.js";
import type { PersistenceScope } from "../../ports/persistence.js";
import {
  openSqliteConnection,
  type SqliteConnectionOptions,
} from "./connection.js";
import { createSqliteExecutionStore } from "./execution-store.js";

function invalid(): Result<never> {
  return fail(
    domainError(
      "PERSISTENCE_INTEGRITY",
      "prepared artifact scope or association is invalid",
    ),
  );
}
function scopeOf(p: PreparedDailyPlan): PersistenceScope {
  return {
    exchange: "bybit",
    environment: p.inputIdentity.environment,
    accountId: p.inputIdentity.accountIdentityHash,
    category: "linear",
    positionMode: "one-way",
  };
}
const preparedId = (hash: string) => `prepared:${hash}`;
const approvalId = (hash: string) => `prepared-consent:${hash}`;

/** Reuses canonical artifacts and environment DB, exposing no execution methods. */
export function openSqlitePreparedArtifactStore(
  options: SqliteConnectionOptions,
): Result<PreparedArtifactStore> {
  const opened = openSqliteConnection(options);
  if (!opened.ok) return opened;
  const connection = opened.value;
  // Content-addressed lookup establishes the previously stored hashed scope.
  // No Keychain accountId, mutable latest alias, or exchange re-authentication.
  function locate(id: string): Result<PersistenceScope | undefined> {
    try {
      const row = connection.db
        .prepare(
          "SELECT exchange, environment, account_id, category, position_mode FROM artifacts WHERE artifact_id = ? AND environment = ?",
        )
        .get(id, connection.environment);
      if (!row) return ok(undefined);
      if (
        row.exchange !== "bybit" ||
        row.environment !== connection.environment ||
        row.category !== "linear" ||
        row.position_mode !== "one-way" ||
        !requireHash(row.account_id, "account scope").ok
      )
        return invalid();
      return ok({
        exchange: "bybit",
        environment: connection.environment,
        accountId: row.account_id as string,
        category: "linear",
        positionMode: "one-way",
      });
    } catch {
      return invalid();
    }
  }
  function loadPrepared(hash: string): Result<PreparedDailyPlan | undefined> {
    if (!requireHash(hash, "preparedHash").ok) return invalid();
    const scope = locate(preparedId(hash));
    if (!scope.ok) return scope;
    if (scope.value === undefined) return ok(undefined);
    const generic = createSqliteExecutionStore(connection, scope.value);
    if (!generic.ok) return generic;
    const stored = generic.value.readArtifact(preparedId(hash));
    if (!stored.ok) return stored;
    if (!stored.value || stored.value.artifactKind !== "prepared-daily-plan")
      return invalid();
    const p = rehydrateArtifact("prepared-daily-plan", stored.value.envelope);
    if (
      !p.ok ||
      p.value.contentHash !== hash ||
      p.value.inputIdentity.environment !== scope.value.environment ||
      p.value.inputIdentity.accountIdentityHash !== scope.value.accountId
    )
      return invalid();
    return p;
  }
  function savePrepared(input: PreparedDailyPlan): Result<void> {
    const p = rehydratePreparedDailyPlan(input);
    if (!p.ok || p.value.inputIdentity.environment !== connection.environment)
      return invalid();
    const envelope = encodeCanonicalArtifact("prepared-daily-plan", p.value);
    const generic = createSqliteExecutionStore(connection, scopeOf(p.value));
    if (!envelope.ok) return envelope;
    if (!generic.ok) return generic;
    return generic.value.writeArtifact({
      artifactId: preparedId(p.value.contentHash),
      artifactKind: "prepared-daily-plan",
      envelope: envelope.value,
      materialHash: p.value.contentHash,
    });
  }
  function boundApproval(input: unknown): Result<PreparedPlanApproval> {
    const a = rehydratePreparedPlanApproval(input);
    if (!a.ok) return a;
    const p = loadPrepared(a.value.preparedHash);
    if (!p.ok || !p.value) return invalid();
    const fullHash = hashCanonical(p.value);
    return fullHash.ok && fullHash.value === a.value.preparedArtifactHash
      ? a
      : invalid();
  }
  return ok(
    Object.freeze({
      savePrepared,
      loadPrepared,
      saveApproval(input: PreparedPlanApproval): Result<void> {
        const a = boundApproval(input);
        if (!a.ok) return a;
        const envelope = encodeCanonicalArtifact(
          "prepared-plan-approval",
          a.value,
        );
        const generic = createSqliteExecutionStore(
          connection,
          scopeOf(a.value.replayInputs.prepared),
        );
        if (!envelope.ok) return envelope;
        if (!generic.ok) return generic;
        return generic.value.writeArtifact({
          artifactId: approvalId(a.value.contentHash),
          artifactKind: "prepared-plan-approval",
          envelope: envelope.value,
          materialHash: a.value.contentHash,
        });
      },
      loadApproval(hash: string): Result<PreparedPlanApproval | undefined> {
        if (!requireHash(hash, "approvalHash").ok) return invalid();
        const scope = locate(approvalId(hash));
        if (!scope.ok) return scope;
        if (!scope.value) return ok(undefined);
        const generic = createSqliteExecutionStore(connection, scope.value);
        if (!generic.ok) return generic;
        const stored = generic.value.readArtifact(approvalId(hash));
        if (!stored.ok) return stored;
        if (
          !stored.value ||
          stored.value.artifactKind !== "prepared-plan-approval"
        )
          return invalid();
        const decoded = rehydrateArtifact(
          "prepared-plan-approval",
          stored.value.envelope,
        );
        if (
          !decoded.ok ||
          decoded.value.contentHash !== hash ||
          decoded.value.replayInputs.prepared.inputIdentity
            .accountIdentityHash !== scope.value.accountId ||
          decoded.value.replayInputs.prepared.inputIdentity.environment !==
            scope.value.environment
        )
          return invalid();
        return boundApproval(decoded.value);
      },
      close: () => connection.close(),
    }),
  );
}
