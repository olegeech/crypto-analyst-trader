import { createFee, type Fee } from "../domain/accounting/fee.js";
import { createFill, type Fill } from "../domain/accounting/fill.js";
import {
  createLedgerEntry,
  type LedgerEntry,
} from "../domain/accounting/ledger-entry.js";
import { encodeCanonicalArtifact } from "../domain/identity/canonical-artifact.js";
import { hashCanonical } from "../domain/identity/plan-hash.js";
import { DecimalValue, isDecimalValue } from "../domain/shared/decimal.js";
import { domainError } from "../domain/shared/errors.js";
import { fail, ok, type Result } from "../domain/shared/result.js";
import { parseUtcTimestamp, type UtcTimestamp } from "../domain/shared/time.js";
import {
  isRecord,
  requireIdentifier,
  requireSafeText,
} from "../domain/shared/validation.js";
import type { ExchangeFillObservation } from "../ports/exchange-execution.js";
import type {
  IngestionFact,
  PersistedArtifact,
  PersistencePort,
  PersistenceScope,
} from "../ports/persistence.js";

const MAX_IDENTITY_INPUT_LENGTH = 128;
const IDENTITY_DIGEST_LENGTH = 32;

export interface AccountingEventIdentityInputs {
  /** A stable source-side event key, such as the exchange execution ID. */
  readonly eventKey: string;
  /** Optional source revision; a correction is a new immutable event. */
  readonly revision?: string;
  /** Quote/settlement currency for the fill cash-flow ledger posting. */
  readonly ledgerCurrency: string;
}

export interface IngestedAccountingFact {
  readonly fact: IngestionFact;
  readonly status: "inserted" | "duplicate";
}

export interface AccountingIngestionResult {
  readonly fill: IngestedAccountingFact;
  readonly fee?: IngestedAccountingFact;
  readonly ledgerEntries: readonly IngestedAccountingFact[];
}

interface ValidatedInputs {
  readonly attemptId: string;
  readonly eventKey: string;
  readonly revision?: string;
  readonly ledgerCurrency: string;
  readonly observation: ExchangeFillObservation;
  readonly executedAt: UtcTimestamp;
}

interface FactIdentity {
  readonly eventIdentity: string;
  readonly artifactId: string;
}

interface BuiltFact<T> {
  readonly value: T;
  readonly fact: IngestionFact;
}

function invalid(message: string): Result<never> {
  return fail(domainError("INVALID_ARGUMENT", message));
}

function accountingFailure(message: string): Result<never> {
  return fail(domainError("INVALID_ACCOUNTING", message));
}

function sameScope(left: PersistenceScope, right: PersistenceScope): boolean {
  return (
    left.exchange === right.exchange &&
    left.environment === right.environment &&
    left.accountId === right.accountId &&
    left.category === right.category &&
    left.positionMode === right.positionMode
  );
}

function boundedText(value: unknown, field: string): Result<string> {
  const parsed = requireSafeText(value, field);
  if (!parsed.ok) return parsed;
  if (parsed.value.length > MAX_IDENTITY_INPUT_LENGTH) {
    return fail(
      domainError("INVALID_ARGUMENT", `${field} exceeds the bounded length`),
    );
  }
  return parsed;
}

function validateInputs(
  persistence: PersistencePort,
  scope: PersistenceScope,
  observation: ExchangeFillObservation,
  attemptId: string,
  identityInputs: AccountingEventIdentityInputs,
): Result<ValidatedInputs> {
  if (!sameScope(scope, persistence.scope)) {
    return fail(
      domainError(
        "PERSISTENCE_ENVIRONMENT",
        "accounting ingestion scope does not match the persistence scope",
      ),
    );
  }
  if (!isRecord(observation) || !isRecord(identityInputs)) {
    return invalid("accounting ingestion inputs must be objects");
  }
  const parsedAttemptId = requireIdentifier(attemptId, "attemptId");
  const executionId = requireIdentifier(observation.executionId, "executionId");
  const exchangeOrderId = requireIdentifier(
    observation.exchangeOrderId,
    "exchangeOrderId",
  );
  const clientOrderId = requireIdentifier(
    observation.clientOrderId,
    "clientOrderId",
  );
  const instrument = requireIdentifier(observation.instrument, "instrument");
  const source = boundedText(observation.source, "source");
  const executedAt = parseUtcTimestamp(observation.executedAt);
  const eventKey = boundedText(identityInputs.eventKey, "eventKey");
  const revision =
    identityInputs.revision === undefined
      ? ok<string | undefined>(undefined)
      : boundedText(identityInputs.revision, "revision");
  const ledgerCurrency = requireIdentifier(
    identityInputs.ledgerCurrency,
    "ledgerCurrency",
  );
  const validFeeCurrency =
    observation.feeCurrency === undefined
      ? ok<string | undefined>(undefined)
      : requireIdentifier(observation.feeCurrency, "feeCurrency");
  const validFee =
    observation.fee === undefined
      ? ok<DecimalValue | undefined>(undefined)
      : isDecimalValue(observation.fee) && !observation.fee.isNegative()
        ? ok(observation.fee)
        : accountingFailure("fee must be a non-negative decimal");

  if (
    !parsedAttemptId.ok ||
    !executionId.ok ||
    !exchangeOrderId.ok ||
    !clientOrderId.ok ||
    !instrument.ok ||
    !source.ok ||
    !executedAt.ok ||
    !eventKey.ok ||
    !revision.ok ||
    !ledgerCurrency.ok ||
    !validFeeCurrency.ok ||
    !validFee.ok ||
    (observation.side !== "buy" && observation.side !== "sell") ||
    !isDecimalValue(observation.quantity) ||
    !observation.quantity.isPositive() ||
    !isDecimalValue(observation.price) ||
    !observation.price.isPositive() ||
    (observation.fee !== undefined && observation.feeCurrency === undefined) ||
    (observation.fee === undefined && observation.feeCurrency !== undefined)
  ) {
    return accountingFailure(
      "exchange fill observation contains an invalid field",
    );
  }

  return ok({
    attemptId: parsedAttemptId.value,
    eventKey: eventKey.value,
    ...(revision.value === undefined ? {} : { revision: revision.value }),
    ledgerCurrency: ledgerCurrency.value,
    observation: Object.freeze({
      ...observation,
      executionId: executionId.value,
      exchangeOrderId: exchangeOrderId.value,
      clientOrderId: clientOrderId.value,
      instrument: instrument.value,
      source: source.value,
      executedAt: executedAt.value,
      ...(validFee.value === undefined ? {} : { fee: validFee.value }),
      ...(validFeeCurrency.value === undefined
        ? {}
        : { feeCurrency: validFeeCurrency.value }),
    }),
    executedAt: executedAt.value,
  });
}

function makeIdentity(
  kind: "fill" | "fee" | "ledger-entry",
  scope: PersistenceScope,
  inputs: ValidatedInputs,
): Result<FactIdentity> {
  const digest = hashCanonical({
    identityVersion: "accounting-event/v1",
    factKind: kind,
    scope,
    attemptId: inputs.attemptId,
    executionId: inputs.observation.executionId,
    eventKey: inputs.eventKey,
    ...(inputs.revision === undefined ? {} : { revision: inputs.revision }),
  });
  if (!digest.ok) return digest;
  const shortDigest = digest.value.slice(7, 7 + IDENTITY_DIGEST_LENGTH);
  const prefix = kind === "ledger-entry" ? "ledger" : kind;
  return ok({
    eventIdentity: `acct-${prefix}-${shortDigest}`,
    artifactId: `acct-${prefix}-artifact-${shortDigest}`,
  });
}

function signedFillAmount(
  observation: ExchangeFillObservation,
): Result<DecimalValue> {
  const notional = observation.price.multiply(observation.quantity);
  const negativeOne = DecimalValue.fromString("-1");
  if (!negativeOne.ok) return negativeOne;
  return ok(
    observation.side === "buy"
      ? notional.multiply(negativeOne.value)
      : notional,
  );
}

function toFact(
  factKind: "fill" | "fee" | "ledger-entry",
  identity: FactIdentity,
  scope: PersistenceScope,
  observedAt: ValidatedInputs["executedAt"],
  artifact: PersistedArtifact,
): IngestionFact {
  return Object.freeze({
    factKind,
    eventIdentity: identity.eventIdentity,
    scope,
    observedAt,
    canonicalHash: artifact.envelope.canonicalHash,
    artifact,
  });
}

function encodeFact<T>(
  factKind: "fill" | "fee" | "ledger-entry",
  value: T,
  identity: FactIdentity,
  scope: PersistenceScope,
  observedAt: ValidatedInputs["executedAt"],
): Result<BuiltFact<T>> {
  const envelope = encodeCanonicalArtifact(factKind, value);
  if (!envelope.ok) return envelope;
  const artifact: PersistedArtifact = Object.freeze({
    artifactId: identity.artifactId,
    artifactKind: factKind,
    envelope: envelope.value,
  });
  return ok({
    value,
    fact: toFact(factKind, identity, scope, observedAt, artifact),
  });
}

function ingest<T>(
  persistence: PersistencePort,
  built: BuiltFact<T>,
): Result<IngestedAccountingFact> {
  const result = persistence.ingestFact(built.fact);
  if (!result.ok) return result;
  return ok({ fact: built.fact, status: result.value });
}

/**
 * Convert one owned exchange execution observation into canonical accounting
 * facts. The persistence port remains the sole accounting store and decides
 * whether a replay is a duplicate or a conflicting immutable event.
 */
export function ingestExchangeFillObservation(
  persistence: PersistencePort,
  scope: PersistenceScope,
  observation: ExchangeFillObservation,
  attemptId: string,
  identityInputs: AccountingEventIdentityInputs,
): Result<AccountingIngestionResult> {
  const validated = validateInputs(
    persistence,
    scope,
    observation,
    attemptId,
    identityInputs,
  );
  if (!validated.ok) return validated;
  const inputs = validated.value;

  const fillIdentity = makeIdentity("fill", scope, inputs);
  if (!fillIdentity.ok) return fillIdentity;
  const fill = createFill({
    fillId: fillIdentity.value.artifactId,
    attemptId: inputs.attemptId,
    exchangeOrderId: inputs.observation.exchangeOrderId,
    instrument: inputs.observation.instrument,
    side: inputs.observation.side,
    quantity: inputs.observation.quantity.toString(),
    price: inputs.observation.price.toString(),
    executedAt: inputs.executedAt,
    source: inputs.observation.source,
  });
  if (!fill.ok) return fill;
  const fillFact = encodeFact(
    "fill",
    fill.value,
    fillIdentity.value,
    scope,
    inputs.executedAt,
  );
  if (!fillFact.ok) return fillFact;

  const ledgerAmount = signedFillAmount(inputs.observation);
  if (!ledgerAmount.ok) return ledgerAmount;
  const fillLedgerIdentity = makeIdentity("ledger-entry", scope, inputs);
  if (!fillLedgerIdentity.ok) return fillLedgerIdentity;
  const fillLedger = createLedgerEntry({
    entryId: fillLedgerIdentity.value.artifactId,
    kind: "fill",
    amount: ledgerAmount.value.toString(),
    currency: inputs.ledgerCurrency,
    occurredAt: inputs.executedAt,
    source: "accounting-fill",
    referenceId: fill.value.fillId,
  });
  if (!fillLedger.ok) return fillLedger;
  const fillLedgerFact = encodeFact(
    "ledger-entry",
    fillLedger.value,
    fillLedgerIdentity.value,
    scope,
    inputs.executedAt,
  );
  if (!fillLedgerFact.ok) return fillLedgerFact;

  let feeFact: BuiltFact<Fee> | undefined;
  let feeLedgerFact: BuiltFact<LedgerEntry> | undefined;
  if (inputs.observation.fee !== undefined) {
    if (inputs.observation.feeCurrency === undefined) {
      return accountingFailure(
        "fee currency is required when a fee is present",
      );
    }
    const feeIdentity = makeIdentity("fee", scope, inputs);
    if (!feeIdentity.ok) return feeIdentity;
    const fee = createFee({
      feeId: feeIdentity.value.artifactId,
      amount: inputs.observation.fee.toString(),
      currency: inputs.observation.feeCurrency,
      kind: "trading",
      chargedAt: inputs.executedAt,
      source: inputs.observation.source,
    });
    if (!fee.ok) return fee;
    const encodedFee = encodeFact(
      "fee",
      fee.value,
      feeIdentity.value,
      scope,
      inputs.executedAt,
    );
    if (!encodedFee.ok) return encodedFee;
    feeFact = encodedFee.value;

    const feeLedgerIdentity = makeIdentity("ledger-entry", scope, {
      ...inputs,
      eventKey: `${inputs.eventKey}:fee`,
    });
    if (!feeLedgerIdentity.ok) return feeLedgerIdentity;
    const negativeFee = DecimalValue.fromString("-1");
    if (!negativeFee.ok) return negativeFee;
    const feeLedger = createLedgerEntry({
      entryId: feeLedgerIdentity.value.artifactId,
      kind: "fee",
      amount: inputs.observation.fee.multiply(negativeFee.value).toString(),
      currency: inputs.observation.feeCurrency,
      occurredAt: inputs.executedAt,
      source: "accounting-fee",
      referenceId: fee.value.feeId,
    });
    if (!feeLedger.ok) return feeLedger;
    const encodedFeeLedger = encodeFact(
      "ledger-entry",
      feeLedger.value,
      feeLedgerIdentity.value,
      scope,
      inputs.executedAt,
    );
    if (!encodedFeeLedger.ok) return encodedFeeLedger;
    feeLedgerFact = encodedFeeLedger.value;
  }

  const persistedFill = ingest(persistence, fillFact.value);
  if (!persistedFill.ok) return persistedFill;
  const persistedLedger = ingest(persistence, fillLedgerFact.value);
  if (!persistedLedger.ok) return persistedLedger;

  let persistedFee: IngestedAccountingFact | undefined;
  if (feeFact !== undefined) {
    const ingestedFee = ingest(persistence, feeFact);
    if (!ingestedFee.ok) return ingestedFee;
    persistedFee = ingestedFee.value;
  }

  let persistedFeeLedger: IngestedAccountingFact | undefined;
  if (feeLedgerFact !== undefined) {
    const ingestedFeeLedger = ingest(persistence, feeLedgerFact);
    if (!ingestedFeeLedger.ok) return ingestedFeeLedger;
    persistedFeeLedger = ingestedFeeLedger.value;
  }

  return ok(
    Object.freeze({
      fill: persistedFill.value,
      ...(persistedFee === undefined ? {} : { fee: persistedFee }),
      ledgerEntries: Object.freeze([
        persistedLedger.value,
        ...(persistedFeeLedger === undefined ? [] : [persistedFeeLedger]),
      ]),
    }),
  );
}

export const ingestAccountingFill = ingestExchangeFillObservation;

export type { Fee, Fill, LedgerEntry };
