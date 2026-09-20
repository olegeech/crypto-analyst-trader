import type { DatabaseSync } from "node:sqlite";

import {
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
  haltRow,
  raiseHaltWithinTransaction,
} from "./sqlite-authority.js";
import {
  deterministicId,
  isEnvironment,
  persistenceFailure,
  scopesEqual,
  SCOPE_WHERE,
  scopeValues,
  storedOptionalString,
  storedString,
  storedTimestamp,
  type SqliteRow,
} from "./sqlite-helpers.js";
import {
  commitTransaction,
  isCommittedTransaction,
  runInTransaction,
  sqliteError,
  type CommittedTransaction,
} from "./transaction.js";
import type {
  CheckpointState,
  CheckpointUpdateRequest,
  IngestionFact,
  PersistenceFactKind,
  PersistenceScope,
} from "../../ports/persistence.js";
import type { PlanHash } from "../../domain/identity/canonical-serialization.js";

const FACT_KINDS = new Set<PersistenceFactKind>([
  "fill",
  "fee",
  "funding",
  "ledger-entry",
  "exchange-observation",
  "reconciliation",
  "audit",
]);

type FactResult = "inserted" | "duplicate";
type TransactionFactResult =
  Result<FactResult> | CommittedTransaction<FactResult>;

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
  expectedScope: PersistenceScope,
): Result<PersistenceScope> {
  if (
    !isEnvironment(scope.environment) ||
    scope.environment !== connection.environment ||
    !scopesEqual(scope, expectedScope)
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

function envelopeFromRow(
  row: SqliteRow,
  canonicalHashField = "canonical_hash",
): Result<CanonicalArtifactEnvelope> {
  const artifactKind = storedString(row, "artifact_kind");
  const schemaVersion = storedString(row, "schema_version");
  const canonicalJson = storedString(row, "canonical_json");
  const canonicalHash = storedString(row, canonicalHashField);
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
  scope: PersistenceScope,
  artifact: IngestionFact["artifact"],
  observedAt: UtcTimestamp,
): Result<void> {
  const existing = database
    .prepare(
      `SELECT exchange, environment, account_id, category, position_mode,
              artifact_kind, schema_version, canonical_json, canonical_hash, material_hash
       FROM artifacts WHERE artifact_id = ?`,
    )
    .get(artifact.artifactId) as SqliteRow | undefined;
  if (existing !== undefined) {
    const sameScope =
      existing.exchange === scope.exchange &&
      existing.environment === scope.environment &&
      existing.account_id === scope.accountId &&
      existing.category === scope.category &&
      existing.position_mode === scope.positionMode;
    if (!sameScope) {
      return persistenceFailure(
        "accounting artifact identity is bound to a different persistence scope",
      );
    }
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
       (artifact_id, exchange, environment, account_id, category, position_mode,
        artifact_kind, schema_version, canonical_json, canonical_hash, material_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      artifact.artifactId,
      ...scopeValues(scope),
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
    decoded: rehydrated.value,
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

function assertLinkedFactInScope(
  database: DatabaseSync,
  scope: PersistenceScope,
  linkedFactId: string,
): Result<void> {
  const linked = database
    .prepare(
      `SELECT fact_id FROM accounting_facts
       WHERE ${SCOPE_WHERE} AND fact_id = ?`,
    )
    .get(...scopeValues(scope), linkedFactId) as SqliteRow | undefined;
  return linked === undefined
    ? persistenceFailure(
        "linked accounting fact does not exist in the persistence scope",
      )
    : ok(undefined);
}

function insertFactWithinTransaction(
  database: DatabaseSync,
  scope: PersistenceScope,
  fact: ValidatedFact,
): TransactionFactResult {
  if (fact.linkedFactId !== undefined) {
    const linked = assertLinkedFactInScope(database, scope, fact.linkedFactId);
    if (!linked.ok) return linked;
  }
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
    scope,
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

function assertCheckpointMutationAllowedWithinTransaction(
  database: DatabaseSync,
  scope: PersistenceScope,
  authority: CheckpointUpdateRequest["authority"],
  now: UtcTimestamp,
): Result<void> {
  const currentAuthority = assertCurrentAuthorityWithinTransaction(
    database,
    scope,
    authority,
    now,
  );
  if (!currentAuthority.ok) return currentAuthority;
  if (currentAuthority.value.reconciliationRequired) {
    return fail(
      domainError(
        "UNRESOLVED_STATE",
        "checkpoint mutation requires reconciliation before lease use",
      ),
    );
  }
  const halt = haltRow(database, scope);
  if (!halt.ok) return halt;
  if (halt.value.active) {
    return fail(
      domainError("HALT_ACTIVE", "account HALT blocks checkpoint mutation"),
    );
  }
  return ok(undefined);
}

function updateCheckpointWithinTransaction(
  database: DatabaseSync,
  scope: PersistenceScope,
  request: ValidatedCheckpoint,
  authority: CheckpointUpdateRequest["authority"],
): Result<CheckpointState> {
  const mutationAllowed = assertCheckpointMutationAllowedWithinTransaction(
    database,
    scope,
    authority,
    request.updatedAt,
  );
  if (!mutationAllowed.ok) return mutationAllowed;
  const existing = database
    .prepare(
      `SELECT stream, cursor, observed_through, overlap_from, updated_at, revision
       FROM checkpoints WHERE ${SCOPE_WHERE} AND stream = ?`,
    )
    .get(...scopeValues(scope), request.stream) as SqliteRow | undefined;
  let currentRevision = 0;
  let currentCheckpoint: CheckpointState | undefined;
  if (existing !== undefined) {
    const parsed = checkpointFromRow(existing, scope);
    if (!parsed.ok) return parsed;
    currentCheckpoint = parsed.value;
    currentRevision = parsed.value.revision;
    if (currentRevision !== request.expectedRevision) {
      return fail(
        domainError("CHECKPOINT_STALE", "checkpoint revision is stale"),
      );
    }
    if (
      parsed.value.cursor === request.cursor &&
      parsed.value.observedThrough === request.observedThrough &&
      parsed.value.overlapFrom === request.overlapFrom &&
      parsed.value.updatedAt === request.updatedAt
    ) {
      return ok(parsed.value);
    }
    if (
      parsed.value.observedThrough !== undefined &&
      request.observedThrough !== undefined &&
      Date.parse(request.observedThrough) <
        Date.parse(parsed.value.observedThrough)
    ) {
      return fail(
        domainError(
          "CHECKPOINT_STALE",
          "checkpoint observed-through boundary regressed",
        ),
      );
    }
    if (Date.parse(request.updatedAt) < Date.parse(parsed.value.updatedAt)) {
      return fail(
        domainError(
          "CHECKPOINT_STALE",
          "checkpoint update timestamp regressed",
        ),
      );
    }
  } else if (request.expectedRevision !== 0) {
    return fail(
      domainError("CHECKPOINT_STALE", "checkpoint revision is stale"),
    );
  }
  const revision = currentRevision + 1;
  const cursor = request.cursor ?? currentCheckpoint?.cursor;
  const observedThrough =
    request.observedThrough ?? currentCheckpoint?.observedThrough;
  const overlapFrom = request.overlapFrom ?? currentCheckpoint?.overlapFrom;
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
      cursor ?? null,
      observedThrough ?? null,
      overlapFrom ?? null,
      request.updatedAt,
      revision,
    );
  return ok({
    stream: request.stream,
    scope,
    ...(cursor === undefined ? {} : { cursor }),
    ...(observedThrough === undefined ? {} : { observedThrough }),
    ...(overlapFrom === undefined ? {} : { overlapFrom }),
    updatedAt: request.updatedAt,
    revision,
  });
}

function factFromRow(
  row: SqliteRow,
  scope: PersistenceScope,
  database: DatabaseSync,
): Result<IngestionFact> {
  const factKind = storedString(row, "fact_kind");
  const eventIdentity = storedString(row, "event_identity");
  const observedAt = storedTimestamp(row, "observed_at");
  const factCanonicalHash = storedString(row, "fact_canonical_hash");
  const factId = storedString(row, "fact_id");
  const referenceId = storedString(row, "reference_id");
  const artifact = envelopeFromRow(row, "artifact_canonical_hash");
  const observationRevision = storedOptionalString(row, "observation_revision");
  const linkedFactId = storedOptionalString(row, "linked_fact_id");
  const adjustmentReason = storedOptionalString(row, "adjustment_reason");
  const materialHash = storedOptionalString(row, "material_hash");
  if (
    !factKind.ok ||
    !FACT_KINDS.has(factKind.value as PersistenceFactKind) ||
    !eventIdentity.ok ||
    !observedAt.ok ||
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
  const parsedMaterialHash =
    materialHash.value === undefined
      ? ok<PlanHash | undefined>(undefined)
      : requireHash(materialHash.value, "materialHash");
  if (!parsedFactHash.ok || !parsedMaterialHash.ok) {
    return persistenceFailure("persisted accounting hash is invalid");
  }
  if (artifact.value.canonicalHash !== parsedFactHash.value) {
    return persistenceFailure(
      "persisted accounting artifact hash does not match the fact",
    );
  }
  const expectedKind = expectedArtifactKind(
    factKind.value as PersistenceFactKind,
  );
  if (
    expectedKind !== undefined &&
    artifact.value.artifactKind !== expectedKind
  ) {
    return persistenceFailure(
      "persisted accounting fact kind does not match its artifact",
    );
  }
  if (linkedFactId.value !== undefined) {
    const linked = assertLinkedFactInScope(database, scope, linkedFactId.value);
    if (!linked.ok) return linked;
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
    factId: factId.value,
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
        const mutationAllowed =
          assertCheckpointMutationAllowedWithinTransaction(
            database,
            this.scope,
            request.authority,
            checkpoint.value.updatedAt,
          );
        if (!mutationAllowed.ok) return mutationAllowed;
        const inserted = insertFactWithinTransaction(
          database,
          this.scope,
          validated.value,
        );
        if (isCommittedTransaction(inserted)) return inserted;
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
           LEFT JOIN artifacts a ON a.artifact_id = f.reference_id
             AND a.exchange = f.exchange
             AND a.environment = f.environment
             AND a.account_id = f.account_id
             AND a.category = f.category
             AND a.position_mode = f.position_mode
           WHERE f.exchange = ? AND f.environment = ? AND f.account_id = ?
             AND f.category = ? AND f.position_mode = ?
             AND f.fact_kind = ? AND f.event_identity = ?`,
        )
        .get(...scopeValues(this.scope), factKind, identity.value) as
        SqliteRow | undefined;
      if (row === undefined) return ok(undefined);
      return factFromRow(row, this.scope, this.database);
    } catch (error) {
      return fail(sqliteError(error, "PERSISTENCE_INTEGRITY"));
    }
  }

  public readFacts(): Result<readonly IngestionFact[]> {
    try {
      const rows = this.database
        .prepare(
          `SELECT f.fact_id, f.fact_kind, f.event_identity, f.observed_at, f.observation_revision,
             f.reference_id, f.linked_fact_id, f.adjustment_reason,
             f.canonical_hash AS fact_canonical_hash,
             a.artifact_kind, a.schema_version, a.canonical_json, a.canonical_hash AS artifact_canonical_hash,
             a.material_hash
           FROM accounting_facts f
           LEFT JOIN artifacts a ON a.artifact_id = f.reference_id
             AND a.exchange = f.exchange
             AND a.environment = f.environment
             AND a.account_id = f.account_id
             AND a.category = f.category
             AND a.position_mode = f.position_mode
           WHERE f.exchange = ? AND f.environment = ? AND f.account_id = ?
             AND f.category = ? AND f.position_mode = ?
           ORDER BY f.observed_at, f.fact_id`,
        )
        .all(...scopeValues(this.scope)) as SqliteRow[];
      const facts: IngestionFact[] = [];
      for (const row of rows) {
        const fact = factFromRow(row, this.scope, this.database);
        if (!fact.ok) return fact;
        facts.push(fact.value);
      }
      return ok(facts);
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
  expectedScope: PersistenceScope,
): Result<SqliteAccountingStore> {
  const validated = validateScope(scope, connection, expectedScope);
  return validated.ok
    ? ok(new SqliteAccountingStore(connection, validated.value))
    : validated;
}
