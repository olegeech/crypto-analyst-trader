import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  decodeCanonicalArtifact,
  rehydrateArtifact,
  type ArtifactKind,
  type CanonicalArtifactEnvelope,
} from "../../domain/identity/canonical-artifact.js";
import { isDecimalValue } from "../../domain/shared/decimal.js";
import { domainError } from "../../domain/shared/errors.js";
import { fail, ok, type Result } from "../../domain/shared/result.js";
import {
  parseUtcTimestamp,
  type UtcTimestamp,
} from "../../domain/shared/time.js";
import {
  requireFiniteInteger,
  requireHash,
  requireIdentifier,
  requireSafeText,
} from "../../domain/shared/validation.js";
import type { SqliteConnection } from "./connection.js";
import {
  assertCurrentAuthorityWithinTransaction,
  raiseHaltWithinTransaction,
  type SqliteExecutionStore,
} from "./execution-store.js";
import {
  commitTransaction,
  runInTransaction,
  sqliteError,
  type CommittedTransaction,
} from "./transaction.js";
import type {
  CheckpointState,
  CheckpointUpdateRequest,
  IngestionFact,
  PersistenceEnvironment,
  PersistenceFactKind,
  PersistenceScope,
} from "../../ports/persistence.js";
import type { PlanHash } from "../../domain/identity/canonical-serialization.js";

const SCOPE_WHERE =
  "exchange = ? AND environment = ? AND account_id = ? AND category = ? AND position_mode = ?";
const FACT_KINDS = new Set<PersistenceFactKind>([
  "fill",
  "fee",
  "funding",
  "ledger-entry",
  "exchange-observation",
  "reconciliation",
  "audit",
]);

type SqliteRow = Record<string, unknown>;
type FactResult = "inserted" | "duplicate";
type TransactionFactResult =
  Result<FactResult> | CommittedTransaction<FactResult>;

function persistenceFailure(message: string): Result<never> {
  return fail(domainError("PERSISTENCE_INTEGRITY", message));
}

function scopeValues(scope: PersistenceScope): readonly string[] {
  return [
    scope.exchange,
    scope.environment,
    scope.accountId,
    scope.category,
    scope.positionMode,
  ];
}

function scopesEqual(left: PersistenceScope, right: PersistenceScope): boolean {
  return (
    left.exchange === right.exchange &&
    left.environment === right.environment &&
    left.accountId === right.accountId &&
    left.category === right.category &&
    left.positionMode === right.positionMode
  );
}

function isEnvironment(value: unknown): value is PersistenceEnvironment {
  return value === "demo" || value === "testnet" || value === "mainnet";
}

function deterministicId(prefix: string, value: string): string {
  return `${prefix}-${createHash("sha256").update(value, "utf8").digest("hex").slice(0, 40)}`;
}

function expectedArtifactKind(
  factKind: PersistenceFactKind,
): ArtifactKind | undefined {
  switch (factKind) {
    case "fill":
      return "fill";
    case "fee":
      return "fee";
    case "funding":
      return "funding";
    case "ledger-entry":
      return "ledger-entry";
    case "exchange-observation":
      return "exchange-order";
    case "reconciliation":
      return "reconciliation-result";
    case "audit":
      return undefined;
  }
}

function validateScope(
  scope: PersistenceScope,
  connection: SqliteConnection,
  execution: SqliteExecutionStore,
): Result<PersistenceScope> {
  if (
    !isEnvironment(scope.environment) ||
    scope.environment !== connection.environment ||
    !scopesEqual(scope, execution.scope)
  ) {
    return fail(
      domainError(
        "PERSISTENCE_ENVIRONMENT",
        "accounting scope does not match the journal",
      ),
    );
  }
  const exchange = requireIdentifier(scope.exchange, "scope.exchange");
  const accountId = requireSafeText(scope.accountId, "scope.accountId");
  const category = requireIdentifier(scope.category, "scope.category");
  if (
    !exchange.ok ||
    !accountId.ok ||
    !category.ok ||
    (scope.positionMode !== "one-way" && scope.positionMode !== "hedge")
  ) {
    return fail(
      domainError("PERSISTENCE_ENVIRONMENT", "accounting scope is invalid"),
    );
  }
  return ok(scope);
}

function storedString(row: SqliteRow, field: string): Result<string> {
  return typeof row[field] === "string"
    ? ok(row[field] as string)
    : persistenceFailure(`persisted SQLite field ${field} is invalid`);
}

function storedTimestamp(row: SqliteRow, field: string): Result<UtcTimestamp> {
  const value = storedString(row, field);
  if (!value.ok) return value;
  const parsed = parseUtcTimestamp(value.value);
  return parsed.ok
    ? parsed
    : persistenceFailure(`persisted SQLite timestamp ${field} is invalid`);
}

function storedOptionalString(
  row: SqliteRow,
  field: string,
): Result<string | undefined> {
  const value = row[field];
  if (value === null || value === undefined) return ok(undefined);
  return typeof value === "string"
    ? ok(value)
    : persistenceFailure(`persisted SQLite optional field ${field} is invalid`);
}

function envelopeFromRow(row: SqliteRow): Result<CanonicalArtifactEnvelope> {
  const artifactKind = storedString(row, "artifact_kind");
  const schemaVersion = storedString(row, "schema_version");
  const canonicalJson = storedString(row, "canonical_json");
  const canonicalHash = storedString(row, "canonical_hash");
  if (
    !artifactKind.ok ||
    !schemaVersion.ok ||
    !canonicalJson.ok ||
    !canonicalHash.ok
  ) {
    return persistenceFailure(
      "persisted accounting artifact envelope is invalid",
    );
  }
  const validHash = requireHash(canonicalHash.value, "canonicalHash");
  if (!validHash.ok)
    return persistenceFailure("persisted accounting artifact hash is invalid");
  return ok({
    artifactKind: artifactKind.value as ArtifactKind,
    schemaVersion: schemaVersion.value as "artifact/v1",
    canonicalJson: canonicalJson.value,
    canonicalHash: validHash.value,
  });
}

function decimalText(value: unknown): string | undefined {
  return isDecimalValue(value) ? value.toString() : undefined;
}

function accountingColumns(
  factKind: PersistenceFactKind,
  decoded: unknown,
): {
  readonly quantity?: string;
  readonly price?: string;
  readonly amount?: string;
  readonly fee?: string;
  readonly fundingAmount?: string;
  readonly balanceBefore?: string;
  readonly balanceAfter?: string;
} {
  if (
    typeof decoded !== "object" ||
    decoded === null ||
    Array.isArray(decoded)
  ) {
    return {};
  }
  const record = decoded as Record<string, unknown>;
  switch (factKind) {
    case "fill": {
      const quantity = decimalText(record.quantity);
      const price = decimalText(record.price);
      return {
        ...(quantity === undefined ? {} : { quantity }),
        ...(price === undefined ? {} : { price }),
      };
    }
    case "fee": {
      const amount = decimalText(record.amount);
      return amount === undefined ? {} : { amount, fee: amount };
    }
    case "funding": {
      const amount = decimalText(record.amount);
      return amount === undefined ? {} : { amount, fundingAmount: amount };
    }
    case "ledger-entry": {
      const amount = decimalText(record.amount);
      return amount === undefined ? {} : { amount };
    }
    default: {
      const balanceBefore = decimalText(record.balanceBefore);
      const balanceAfter = decimalText(record.balanceAfter);
      return {
        ...(balanceBefore === undefined ? {} : { balanceBefore }),
        ...(balanceAfter === undefined ? {} : { balanceAfter }),
      };
    }
  }
}

function insertArtifact(
  database: DatabaseSync,
  artifact: IngestionFact["artifact"],
  observedAt: UtcTimestamp,
): Result<void> {
  const existing = database
    .prepare(
      "SELECT artifact_kind, schema_version, canonical_json, canonical_hash, material_hash FROM artifacts WHERE artifact_id = ?",
    )
    .get(artifact.artifactId) as SqliteRow | undefined;
  if (existing !== undefined) {
    const same =
      existing.artifact_kind === artifact.envelope.artifactKind &&
      existing.schema_version === artifact.envelope.schemaVersion &&
      existing.canonical_json === artifact.envelope.canonicalJson &&
      existing.canonical_hash === artifact.envelope.canonicalHash &&
      (existing.material_hash ?? undefined) === artifact.materialHash;
    return same
      ? ok(undefined)
      : persistenceFailure(
          "accounting artifact identity is bound to different bytes",
        );
  }
  database
    .prepare(
      `INSERT INTO artifacts
       (artifact_id, artifact_kind, schema_version, canonical_json, canonical_hash, material_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      artifact.artifactId,
      artifact.envelope.artifactKind,
      artifact.envelope.schemaVersion,
      artifact.envelope.canonicalJson,
      artifact.envelope.canonicalHash,
      artifact.materialHash ?? null,
      observedAt,
    );
  return ok(undefined);
}

interface ValidatedFact {
  readonly fact: IngestionFact;
  readonly eventIdentity: string;
  readonly observedAt: UtcTimestamp;
  readonly canonicalHash: string;
  readonly observationRevision?: string;
  readonly linkedFactId?: string;
  readonly adjustmentReason?: string;
  readonly decoded: unknown;
}

function validateFact(
  fact: IngestionFact,
  scope: PersistenceScope,
): Result<ValidatedFact> {
  if (!scopesEqual(fact.scope, scope) || !FACT_KINDS.has(fact.factKind)) {
    return fail(
      domainError(
        "PERSISTENCE_ENVIRONMENT",
        "accounting fact scope or kind is invalid",
      ),
    );
  }
  const eventIdentity = requireSafeText(fact.eventIdentity, "eventIdentity");
  const observedAt = parseUtcTimestamp(fact.observedAt);
  const canonicalHash = requireHash(fact.canonicalHash, "canonicalHash");
  const artifactId = requireIdentifier(fact.artifact.artifactId, "artifactId");
  const envelopeHash = requireHash(
    fact.artifact.envelope.canonicalHash,
    "canonicalHash",
  );
  const materialHash =
    fact.artifact.materialHash === undefined
      ? ok<PlanHash | undefined>(undefined)
      : requireHash(fact.artifact.materialHash, "materialHash");
  const observationRevision =
    fact.observationRevision === undefined
      ? ok<string | undefined>(undefined)
      : requireSafeText(fact.observationRevision, "observationRevision");
  const linkedFactId =
    fact.linkedFactId === undefined
      ? ok<string | undefined>(undefined)
      : requireIdentifier(fact.linkedFactId, "linkedFactId");
  const adjustmentReason =
    fact.adjustmentReason === undefined
      ? ok<string | undefined>(undefined)
      : requireSafeText(fact.adjustmentReason, "adjustmentReason");
  if (
    !eventIdentity.ok ||
    !observedAt.ok ||
    !canonicalHash.ok ||
    !artifactId.ok ||
    !envelopeHash.ok ||
    !materialHash.ok ||
    !observationRevision.ok ||
    !linkedFactId.ok ||
    !adjustmentReason.ok ||
    canonicalHash.value !== envelopeHash.value
  ) {
    return persistenceFailure(
      "accounting fact identity or artifact is invalid",
    );
  }
  const expectedKind = expectedArtifactKind(fact.factKind);
  if (
    expectedKind !== undefined &&
    fact.artifact.artifactKind !== expectedKind
  ) {
    return persistenceFailure(
      "accounting fact kind does not match its artifact",
    );
  }
  const decoded = decodeCanonicalArtifact(
    fact.artifact.envelope,
    fact.artifact.artifactKind,
  );
  if (!decoded.ok)
    return persistenceFailure(
      "accounting artifact failed canonical validation",
    );
  const rehydrated = rehydrateArtifact(
    fact.artifact.artifactKind,
    fact.artifact.envelope,
  );
  if (!rehydrated.ok)
    return persistenceFailure("accounting artifact failed domain rehydration");
  return ok({
    fact,
    eventIdentity: eventIdentity.value,
    observedAt: observedAt.value,
    canonicalHash: canonicalHash.value,
    ...(observationRevision.value === undefined
      ? {}
      : { observationRevision: observationRevision.value }),
    ...(linkedFactId.value === undefined
      ? {}
      : { linkedFactId: linkedFactId.value }),
    ...(adjustmentReason.value === undefined
      ? {}
      : { adjustmentReason: adjustmentReason.value }),
    decoded: decoded.value,
  });
}

function factId(scope: PersistenceScope, fact: ValidatedFact): string {
  return deterministicId(
    "fact",
    `${scopeValues(scope).join("\u0000")}:${fact.fact.factKind}:${fact.eventIdentity}`,
  );
}

function insertConflict(
  database: DatabaseSync,
  scope: PersistenceScope,
  fact: ValidatedFact,
  existingHash: string,
): Result<void> {
  const conflictId = deterministicId(
    "accounting-conflict",
    `${scopeValues(scope).join("\u0000")}:${fact.fact.factKind}:${fact.eventIdentity}:${existingHash}:${fact.canonicalHash}`,
  );
  const exists = database
    .prepare(
      "SELECT conflict_id FROM accounting_conflicts WHERE conflict_id = ?",
    )
    .get(conflictId) as SqliteRow | undefined;
  if (exists === undefined) {
    database
      .prepare(
        `INSERT INTO accounting_conflicts
         (conflict_id, exchange, environment, account_id, category, position_mode, fact_kind, event_identity, existing_hash, incoming_hash, reason, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        conflictId,
        ...scopeValues(scope),
        fact.fact.factKind,
        fact.eventIdentity,
        existingHash,
        fact.canonicalHash,
        "same event identity has different canonical hash",
        fact.observedAt,
      );
  }
  return ok(undefined);
}

function insertFactWithinTransaction(
  database: DatabaseSync,
  scope: PersistenceScope,
  fact: ValidatedFact,
): TransactionFactResult {
  const existing = database
    .prepare(
      `SELECT fact_id, canonical_hash FROM accounting_facts
       WHERE ${SCOPE_WHERE} AND fact_kind = ? AND event_identity = ?`,
    )
    .get(...scopeValues(scope), fact.fact.factKind, fact.eventIdentity) as
    SqliteRow | undefined;
  if (existing !== undefined) {
    if (existing.canonical_hash === fact.canonicalHash) return ok("duplicate");
    const existingHash = existing.canonical_hash;
    if (typeof existingHash !== "string")
      return persistenceFailure("persisted accounting hash is invalid");
    const conflict = insertConflict(database, scope, fact, existingHash);
    if (!conflict.ok) return conflict;
    const halted = raiseHaltWithinTransaction(
      database,
      scope,
      "accounting fact hash conflict requires reconciliation",
      fact.observedAt,
    );
    if (!halted.ok) return halted;
    return commitTransaction(
      fail<FactResult>(
        domainError(
          "PERSISTENCE_CONFLICT",
          "accounting event identity is already bound to different bytes",
        ),
      ),
    );
  }

  const artifactStored = insertArtifact(
    database,
    fact.fact.artifact,
    fact.observedAt,
  );
  if (!artifactStored.ok) return artifactStored;
  const columns = accountingColumns(fact.fact.factKind, fact.decoded);
  database
    .prepare(
      `INSERT INTO accounting_facts
       (fact_id, fact_kind, exchange, environment, account_id, category, position_mode, event_identity, observed_at, observation_revision, reference_id, linked_fact_id, adjustment_reason, quantity, price, amount, fee, funding_amount, balance_before, balance_after, canonical_json, canonical_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      factId(scope, fact),
      fact.fact.factKind,
      ...scopeValues(scope),
      fact.eventIdentity,
      fact.observedAt,
      fact.observationRevision ?? null,
      fact.fact.artifact.artifactId,
      fact.linkedFactId ?? null,
      fact.adjustmentReason ?? null,
      columns.quantity ?? null,
      columns.price ?? null,
      columns.amount ?? null,
      columns.fee ?? null,
      columns.fundingAmount ?? null,
      columns.balanceBefore ?? null,
      columns.balanceAfter ?? null,
      fact.fact.artifact.envelope.canonicalJson,
      fact.canonicalHash,
      fact.observedAt,
    );
  return ok("inserted");
}

interface ValidatedCheckpoint {
  readonly stream: string;
  readonly scope: PersistenceScope;
  readonly cursor?: string;
  readonly observedThrough?: UtcTimestamp;
  readonly overlapFrom?: UtcTimestamp;
  readonly updatedAt: UtcTimestamp;
  readonly expectedRevision: number;
}

function validateCheckpoint(
  request: CheckpointUpdateRequest,
  scope: PersistenceScope,
): Result<ValidatedCheckpoint> {
  if (!scopesEqual(request.checkpoint.scope, scope)) {
    return fail(
      domainError(
        "PERSISTENCE_ENVIRONMENT",
        "checkpoint scope does not match the journal",
      ),
    );
  }
  const stream = requireSafeText(request.checkpoint.stream, "stream");
  const cursor =
    request.checkpoint.cursor === undefined
      ? ok<string | undefined>(undefined)
      : requireSafeText(request.checkpoint.cursor, "cursor");
  const observedThrough =
    request.checkpoint.observedThrough === undefined
      ? ok<UtcTimestamp | undefined>(undefined)
      : parseUtcTimestamp(request.checkpoint.observedThrough);
  const overlapFrom =
    request.checkpoint.overlapFrom === undefined
      ? ok<UtcTimestamp | undefined>(undefined)
      : parseUtcTimestamp(request.checkpoint.overlapFrom);
  const updatedAt = parseUtcTimestamp(request.checkpoint.updatedAt);
  const expectedRevision = requireFiniteInteger(
    request.expectedRevision,
    "expectedRevision",
  );
  if (
    !stream.ok ||
    !cursor.ok ||
    !observedThrough.ok ||
    !overlapFrom.ok ||
    !updatedAt.ok ||
    !expectedRevision.ok
  ) {
    return fail(
      domainError("PERSISTENCE_INTEGRITY", "checkpoint input is invalid"),
    );
  }
  return ok({
    stream: stream.value,
    scope,
    ...(cursor.value === undefined ? {} : { cursor: cursor.value }),
    ...(observedThrough.value === undefined
      ? {}
      : { observedThrough: observedThrough.value }),
    ...(overlapFrom.value === undefined
      ? {}
      : { overlapFrom: overlapFrom.value }),
    updatedAt: updatedAt.value,
    expectedRevision: expectedRevision.value,
  });
}

function checkpointFromRow(
  row: SqliteRow,
  scope: PersistenceScope,
): Result<CheckpointState> {
  const stream = storedString(row, "stream");
  const cursor = storedOptionalString(row, "cursor");
  const observedThrough =
    row.observed_through === null || row.observed_through === undefined
      ? ok<UtcTimestamp | undefined>(undefined)
      : storedTimestamp(row, "observed_through");
  const overlapFrom =
    row.overlap_from === null || row.overlap_from === undefined
      ? ok<UtcTimestamp | undefined>(undefined)
      : storedTimestamp(row, "overlap_from");
  const updatedAt = storedTimestamp(row, "updated_at");
  if (
    !stream.ok ||
    !cursor.ok ||
    !observedThrough.ok ||
    !overlapFrom.ok ||
    !updatedAt.ok ||
    typeof row.revision !== "number" ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 0
  ) {
    return persistenceFailure("persisted SQLite checkpoint is invalid");
  }
  return ok({
    stream: stream.value,
    scope,
    ...(cursor.value === undefined ? {} : { cursor: cursor.value }),
    ...(observedThrough.value === undefined
      ? {}
      : { observedThrough: observedThrough.value }),
    ...(overlapFrom.value === undefined
      ? {}
      : { overlapFrom: overlapFrom.value }),
    updatedAt: updatedAt.value,
    revision: row.revision,
  });
}

function updateCheckpointWithinTransaction(
  database: DatabaseSync,
  scope: PersistenceScope,
  request: ValidatedCheckpoint,
  authority: CheckpointUpdateRequest["authority"],
): Result<CheckpointState> {
  const currentAuthority = assertCurrentAuthorityWithinTransaction(
    database,
    scope,
    authority,
    request.updatedAt,
  );
  if (!currentAuthority.ok) return currentAuthority;
  const existing = database
    .prepare(
      `SELECT stream, cursor, observed_through, overlap_from, updated_at, revision
       FROM checkpoints WHERE ${SCOPE_WHERE} AND stream = ?`,
    )
    .get(...scopeValues(scope), request.stream) as SqliteRow | undefined;
  let currentRevision = 0;
  if (existing !== undefined) {
    const parsed = checkpointFromRow(existing, scope);
    if (!parsed.ok) return parsed;
    currentRevision = parsed.value.revision;
    if (currentRevision !== request.expectedRevision) {
      return fail(
        domainError("PERSISTENCE_CONFLICT", "checkpoint revision is stale"),
      );
    }
    if (
      parsed.value.observedThrough !== undefined &&
      request.observedThrough !== undefined &&
      Date.parse(request.observedThrough) <
        Date.parse(parsed.value.observedThrough)
    ) {
      return fail(
        domainError(
          "PERSISTENCE_CONFLICT",
          "checkpoint observed-through boundary regressed",
        ),
      );
    }
    if (Date.parse(request.updatedAt) < Date.parse(parsed.value.updatedAt)) {
      return fail(
        domainError(
          "PERSISTENCE_CONFLICT",
          "checkpoint update timestamp regressed",
        ),
      );
    }
  } else if (request.expectedRevision !== 0) {
    return fail(
      domainError("PERSISTENCE_CONFLICT", "checkpoint revision is stale"),
    );
  }
  const revision = currentRevision + 1;
  database
    .prepare(
      `INSERT INTO checkpoints
       (stream, exchange, environment, account_id, category, position_mode, cursor, observed_through, overlap_from, updated_at, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (stream, exchange, environment, account_id, category, position_mode)
       DO UPDATE SET cursor = excluded.cursor, observed_through = excluded.observed_through,
         overlap_from = excluded.overlap_from, updated_at = excluded.updated_at, revision = excluded.revision`,
    )
    .run(
      request.stream,
      ...scopeValues(scope),
      request.cursor ?? null,
      request.observedThrough ?? null,
      request.overlapFrom ?? null,
      request.updatedAt,
      revision,
    );
  return ok({
    stream: request.stream,
    scope,
    ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
    ...(request.observedThrough === undefined
      ? {}
      : { observedThrough: request.observedThrough }),
    ...(request.overlapFrom === undefined
      ? {}
      : { overlapFrom: request.overlapFrom }),
    updatedAt: request.updatedAt,
    revision,
  });
}

function factFromRow(
  row: SqliteRow,
  scope: PersistenceScope,
): Result<IngestionFact> {
  const factKind = storedString(row, "fact_kind");
  const eventIdentity = storedString(row, "event_identity");
  const observedAt = storedTimestamp(row, "observed_at");
  const canonicalHash = storedString(row, "canonical_hash");
  const factCanonicalHash = storedString(row, "fact_canonical_hash");
  const factId = storedString(row, "fact_id");
  const referenceId = storedString(row, "reference_id");
  const artifact = envelopeFromRow(row);
  const observationRevision = storedOptionalString(row, "observation_revision");
  const linkedFactId = storedOptionalString(row, "linked_fact_id");
  const adjustmentReason = storedOptionalString(row, "adjustment_reason");
  const materialHash = storedOptionalString(row, "material_hash");
  if (
    !factKind.ok ||
    !FACT_KINDS.has(factKind.value as PersistenceFactKind) ||
    !eventIdentity.ok ||
    !observedAt.ok ||
    !canonicalHash.ok ||
    !factCanonicalHash.ok ||
    !factId.ok ||
    !referenceId.ok ||
    !artifact.ok ||
    !observationRevision.ok ||
    !linkedFactId.ok ||
    !adjustmentReason.ok ||
    !materialHash.ok
  ) {
    return persistenceFailure("persisted accounting fact is invalid");
  }
  const parsedFactHash = requireHash(factCanonicalHash.value, "canonicalHash");
  const parsedArtifactHash = requireHash(canonicalHash.value, "canonicalHash");
  const parsedMaterialHash =
    materialHash.value === undefined
      ? ok<PlanHash | undefined>(undefined)
      : requireHash(materialHash.value, "materialHash");
  if (!parsedFactHash.ok || !parsedArtifactHash.ok || !parsedMaterialHash.ok) {
    return persistenceFailure("persisted accounting hash is invalid");
  }
  if (
    artifact.value.canonicalHash !== parsedArtifactHash.value ||
    parsedArtifactHash.value !== parsedFactHash.value
  ) {
    return persistenceFailure(
      "persisted accounting artifact hash does not match the fact",
    );
  }
  const rehydrated = rehydrateArtifact(
    artifact.value.artifactKind,
    artifact.value,
  );
  if (!rehydrated.ok) {
    return persistenceFailure(
      "persisted accounting artifact failed domain rehydration",
    );
  }
  return ok({
    factKind: factKind.value as PersistenceFactKind,
    eventIdentity: eventIdentity.value,
    scope,
    observedAt: observedAt.value,
    canonicalHash: parsedFactHash.value,
    artifact: {
      artifactId: referenceId.value,
      artifactKind: artifact.value.artifactKind,
      envelope: artifact.value,
      ...(parsedMaterialHash.value === undefined
        ? {}
        : { materialHash: parsedMaterialHash.value as PlanHash }),
    },
    ...(observationRevision.value === undefined
      ? {}
      : { observationRevision: observationRevision.value }),
    ...(linkedFactId.value === undefined
      ? {}
      : { linkedFactId: linkedFactId.value }),
    ...(adjustmentReason.value === undefined
      ? {}
      : { adjustmentReason: adjustmentReason.value }),
  });
}

export class SqliteAccountingStore {
  public readonly scope: PersistenceScope;
  private readonly database: DatabaseSync;

  public constructor(connection: SqliteConnection, scope: PersistenceScope) {
    this.database = connection.db;
    this.scope = scope;
  }

  private validateFact(fact: IngestionFact): Result<ValidatedFact> {
    return validateFact(fact, this.scope);
  }

  public ingestFact(fact: IngestionFact): Result<FactResult> {
    const validated = this.validateFact(fact);
    if (!validated.ok) return validated;
    return runInTransaction(
      this.database,
      (database) =>
        insertFactWithinTransaction(database, this.scope, validated.value),
      "PERSISTENCE_CONFLICT",
    );
  }

  public ingestFactAndAdvanceCheckpoint(
    fact: IngestionFact,
    request: CheckpointUpdateRequest,
  ): Result<FactResult> {
    const validated = this.validateFact(fact);
    const checkpoint = validateCheckpoint(request, this.scope);
    if (!validated.ok) return validated;
    if (!checkpoint.ok) return checkpoint;
    return runInTransaction(
      this.database,
      (database) => {
        const inserted = insertFactWithinTransaction(
          database,
          this.scope,
          validated.value,
        );
        if ("commit" in inserted) return inserted;
        if (!inserted.ok) return inserted;
        const advanced = updateCheckpointWithinTransaction(
          database,
          this.scope,
          checkpoint.value,
          request.authority,
        );
        if (!advanced.ok) return advanced;
        return inserted;
      },
      "PERSISTENCE_CONFLICT",
    );
  }

  public readFact(
    factKind: PersistenceFactKind,
    eventIdentity: string,
  ): Result<IngestionFact | undefined> {
    const identity = requireSafeText(eventIdentity, "eventIdentity");
    if (!identity.ok || !FACT_KINDS.has(factKind)) {
      return persistenceFailure("accounting fact identity is invalid");
    }
    try {
      const row = this.database
        .prepare(
          `SELECT f.fact_id, f.fact_kind, f.event_identity, f.observed_at, f.observation_revision,
             f.reference_id, f.linked_fact_id, f.adjustment_reason,
             f.canonical_hash AS fact_canonical_hash,
             a.artifact_kind, a.schema_version, a.canonical_json, a.canonical_hash AS artifact_canonical_hash,
             a.material_hash
           FROM accounting_facts f
           INNER JOIN artifacts a ON a.artifact_id = f.reference_id
           WHERE ${SCOPE_WHERE} AND f.fact_kind = ? AND f.event_identity = ?`,
        )
        .get(...scopeValues(this.scope), factKind, identity.value) as
        SqliteRow | undefined;
      if (row === undefined) return ok(undefined);
      const normalized = {
        ...row,
        canonical_hash: row.artifact_canonical_hash,
      };
      return factFromRow(normalized, this.scope);
    } catch (error) {
      return fail(sqliteError(error, "PERSISTENCE_INTEGRITY"));
    }
  }

  public readCheckpoint(stream: string): Result<CheckpointState | undefined> {
    const parsedStream = requireSafeText(stream, "stream");
    if (!parsedStream.ok) return parsedStream;
    try {
      const row = this.database
        .prepare(
          `SELECT stream, cursor, observed_through, overlap_from, updated_at, revision
           FROM checkpoints WHERE ${SCOPE_WHERE} AND stream = ?`,
        )
        .get(...scopeValues(this.scope), parsedStream.value) as
        SqliteRow | undefined;
      return row === undefined
        ? ok(undefined)
        : checkpointFromRow(row, this.scope);
    } catch (error) {
      return fail(sqliteError(error, "PERSISTENCE_INTEGRITY"));
    }
  }

  public updateCheckpoint(
    request: CheckpointUpdateRequest,
  ): Result<CheckpointState> {
    const validated = validateCheckpoint(request, this.scope);
    if (!validated.ok) return validated;
    return runInTransaction(
      this.database,
      (database) =>
        updateCheckpointWithinTransaction(
          database,
          this.scope,
          validated.value,
          request.authority,
        ),
      "PERSISTENCE_CONFLICT",
    );
  }
}

export function createSqliteAccountingStore(
  connection: SqliteConnection,
  scope: PersistenceScope,
  execution: SqliteExecutionStore,
): Result<SqliteAccountingStore> {
  const validated = validateScope(scope, connection, execution);
  return validated.ok
    ? ok(new SqliteAccountingStore(connection, validated.value))
    : validated;
}
