import {
  hashCanonical,
  canonicalSerialize,
  type PlanHash,
} from "../identity/canonical-serialization.js";
import {
  rehydrateOperatorMainnetTestPlan,
  type OperatorMainnetTestPlan,
} from "./operator-mainnet-test-plan.js";
import { DecimalValue } from "../shared/decimal.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { domainError } from "../shared/errors.js";
import { fail, ok, type Result } from "../shared/result.js";
import {
  addMilliseconds,
  parseUtcTimestamp,
  timestampToEpochMs,
  type UtcTimestamp,
} from "../shared/time.js";
import {
  isRecord,
  requireFiniteInteger,
  requireHash,
  requireIdentifier,
  requireSafeText,
} from "../shared/validation.js";

export const OPERATOR_MAINNET_RECOVERY_ATTESTATION_SCHEMA_VERSION =
  "operator-mainnet-recovery-attestation/v1" as const;
export const OPERATOR_MAINNET_RECOVERY_GRANT_SCHEMA_VERSION =
  "operator-mainnet-recovery-grant/v1" as const;
export const OPERATOR_MAINNET_RECOVERY_MAX_AGE_MS = 300_000 as const;

export type OperatorRecoveryManualAction =
  "none" | "entry-remainder-cancelled" | "position-closed" | "other";

export type OperatorRecoveryAcceptedUncertainty =
  | "manual-ui-may-be-stale"
  | "provider-history-may-be-delayed"
  | "other-operator-accepted-risk";

export interface OperatorRecoveryUiOrder {
  readonly orderId: string;
  readonly clientOrderId?: string;
  readonly symbol: string;
  readonly side: "Buy" | "Sell";
  readonly orderType: "Market" | "Limit" | "Other";
  readonly quantity: string;
  readonly price?: string;
  readonly status: string;
}

export interface OperatorRecoveryUiFill {
  readonly executionId: string;
  readonly orderId: string;
  readonly clientOrderId?: string;
  readonly symbol: string;
  readonly side: "Buy" | "Sell";
  readonly quantity: string;
  readonly price: string;
  readonly executedAt: UtcTimestamp;
}

export interface OperatorRecoveryUiPosition {
  readonly symbol: string;
  readonly side: "Buy" | "Sell";
  readonly quantity: string;
}

export interface OperatorMainnetRecoveryAttestation {
  readonly schemaVersion: typeof OPERATOR_MAINNET_RECOVERY_ATTESTATION_SCHEMA_VERSION;
  readonly attestationId: string;
  readonly contentHash: PlanHash;
  readonly provenance: "MANUAL_ATTESTED_NOT_API_VERIFIED";
  readonly exchange: "bybit";
  readonly environment: "mainnet";
  /** Hashed local account identity; raw UID or API identity is never persisted. */
  readonly accountIdentityHash: PlanHash;
  readonly sourceId: string;
  readonly sourcePlanHash: PlanHash;
  readonly sourceIntentId: string;
  readonly sourceRevision: number;
  readonly actor: string;
  readonly observedAt: UtcTimestamp;
  readonly inspection: {
    readonly accountOpenOrdersInspected: true;
    readonly accountOpenOrders: readonly OperatorRecoveryUiOrder[];
    readonly accountPositionsInspected: true;
    readonly accountPositions: readonly OperatorRecoveryUiPosition[];
    readonly sourceOrderHistoryInspected: true;
    readonly sourceOrders: readonly OperatorRecoveryUiOrder[];
    readonly sourceFillsInspected: true;
    readonly sourceFills: readonly OperatorRecoveryUiFill[];
    readonly sourcePositionInspected: true;
    readonly sourcePosition: OperatorRecoveryUiPosition | null;
    readonly sourceTakeProfitInspected: true;
    readonly sourceTakeProfitOrders: readonly OperatorRecoveryUiOrder[];
  };
  readonly manualActions: readonly OperatorRecoveryManualAction[];
  readonly acceptedUncertainty: readonly OperatorRecoveryAcceptedUncertainty[];
}

export interface OperatorMainnetRecoveryHaltOrigin {
  readonly eventId: string;
  readonly revision: number;
  readonly originHash: PlanHash;
}

export type OperatorMainnetRecoveryResolution =
  | {
      readonly kind: "api-resolved";
      readonly evidenceHash: PlanHash;
      readonly observedAt: UtcTimestamp;
    }
  | {
      readonly kind: "manual-attested";
      readonly attestationId: string;
      readonly attestationHash: PlanHash;
      readonly observedAt: UtcTimestamp;
    };

export interface OperatorMainnetRecoveryGrant {
  readonly schemaVersion: typeof OPERATOR_MAINNET_RECOVERY_GRANT_SCHEMA_VERSION;
  readonly grantId: string;
  readonly contentHash: PlanHash;
  readonly resolution: OperatorMainnetRecoveryResolution;
  readonly exchange: "bybit";
  readonly environment: "mainnet";
  readonly accountIdentityHash: PlanHash;
  readonly sourceId: string;
  readonly sourcePlanHash: PlanHash;
  readonly sourceIntentId: string;
  readonly sourceRevision: number;
  /** Revision after this recovery transaction, including its own clearance. */
  readonly haltRevision: number;
  /** Present only when this recovery explicitly clears an active HALT. */
  readonly haltOrigin: OperatorMainnetRecoveryHaltOrigin | null;
  readonly planHash: PlanHash;
  readonly planExpiresAt: UtcTimestamp;
  readonly actor: string;
  readonly consent: true;
  readonly issuedAt: UtcTimestamp;
  readonly expiresAt: UtcTimestamp;
}

const ATTESTATION_BODY_FIELDS = [
  "provenance",
  "exchange",
  "environment",
  "accountIdentityHash",
  "sourceId",
  "sourcePlanHash",
  "sourceIntentId",
  "sourceRevision",
  "actor",
  "observedAt",
  "inspection",
  "manualActions",
  "acceptedUncertainty",
] as const;
const ATTESTATION_FIELDS = [
  "schemaVersion",
  "attestationId",
  "contentHash",
  ...ATTESTATION_BODY_FIELDS,
] as const;
const GRANT_BODY_FIELDS = [
  "resolution",
  "exchange",
  "environment",
  "accountIdentityHash",
  "sourceId",
  "sourcePlanHash",
  "sourceIntentId",
  "sourceRevision",
  "haltRevision",
  "planHash",
  "planExpiresAt",
  "actor",
  "consent",
  "issuedAt",
  "expiresAt",
] as const;
const GRANT_FIELDS = [
  "schemaVersion",
  "grantId",
  "contentHash",
  ...GRANT_BODY_FIELDS,
  "haltOrigin",
] as const;

function exactRecord(
  value: unknown,
  fields: readonly string[],
): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null) &&
    Reflect.ownKeys(value).length === fields.length &&
    fields.every(
      (field) =>
        Object.hasOwn(value, field) &&
        Object.hasOwn(Object.getOwnPropertyDescriptor(value, field)!, "value"),
    )
  );
}

function invalidAttestation(
  message = "operator recovery attestation is invalid",
) {
  return fail(domainError("INVALID_EVIDENCE", message));
}

function invalidGrant(message = "operator recovery grant is invalid") {
  return fail(domainError("INVALID_APPROVAL", message));
}

function arrayOf<T>(
  value: unknown,
  field: string,
  parse: (item: unknown) => Result<T>,
  maximum = 500,
): Result<readonly T[]> {
  if (!Array.isArray(value) || value.length > maximum)
    return fail(
      domainError("INVALID_EVIDENCE", `${field} must be a bounded list`),
    );
  const output: T[] = [];
  for (const item of value) {
    const parsed = parse(item);
    if (!parsed.ok) return parsed;
    output.push(parsed.value);
  }
  return ok(Object.freeze(output));
}

function boundedDecimal(value: unknown, field: string): Result<string> {
  if (typeof value !== "string" || value.length > 128)
    return fail(
      domainError("INVALID_DECIMAL", `${field} must be a bounded decimal`),
    );
  const parsed = DecimalValue.fromString(value);
  if (!parsed.ok || !parsed.value.isPositive())
    return fail(domainError("INVALID_DECIMAL", `${field} must be positive`));
  return ok(parsed.value.toString());
}

function parseUiOrder(value: unknown): Result<OperatorRecoveryUiOrder> {
  if (
    !isRecord(value) ||
    !["orderId", "symbol", "side", "orderType", "quantity", "status"].every(
      (key) => Object.hasOwn(value, key),
    ) ||
    Object.keys(value).some(
      (key) =>
        ![
          "orderId",
          "clientOrderId",
          "symbol",
          "side",
          "orderType",
          "quantity",
          "price",
          "status",
        ].includes(key),
    )
  )
    return invalidAttestation("manual order observation has an invalid shape");
  const orderId = requireIdentifier(value.orderId, "orderId");
  const clientOrderId =
    value.clientOrderId === undefined
      ? ok<string | undefined>(undefined)
      : requireIdentifier(value.clientOrderId, "clientOrderId");
  const symbol = requireIdentifier(value.symbol, "symbol");
  const quantity = boundedDecimal(value.quantity, "quantity");
  const status = requireSafeText(value.status, "status");
  if (
    !orderId.ok ||
    !clientOrderId.ok ||
    !symbol.ok ||
    !quantity.ok ||
    !status.ok ||
    (value.side !== "Buy" && value.side !== "Sell") ||
    !["Market", "Limit", "Other"].includes(value.orderType as string)
  )
    return invalidAttestation("manual order observation is malformed");
  const price =
    value.price === undefined
      ? ok<string | undefined>(undefined)
      : boundedDecimal(value.price, "price");
  if (!price.ok) return price;
  return ok({
    orderId: orderId.value,
    ...(clientOrderId.value === undefined
      ? {}
      : { clientOrderId: clientOrderId.value }),
    symbol: symbol.value,
    side: value.side,
    orderType: value.orderType as OperatorRecoveryUiOrder["orderType"],
    quantity: quantity.value,
    ...(price.value === undefined ? {} : { price: price.value }),
    status: status.value,
  });
}

function parseUiPosition(value: unknown): Result<OperatorRecoveryUiPosition> {
  if (!exactRecord(value, ["symbol", "side", "quantity"]))
    return invalidAttestation(
      "manual position observation has an invalid shape",
    );
  const symbol = requireIdentifier(value.symbol, "symbol");
  const quantity = boundedDecimal(value.quantity, "quantity");
  if (
    !symbol.ok ||
    !quantity.ok ||
    (value.side !== "Buy" && value.side !== "Sell")
  )
    return invalidAttestation("manual position observation is malformed");
  return ok({
    symbol: symbol.value,
    side: value.side,
    quantity: quantity.value,
  });
}

function parseUiFill(value: unknown): Result<OperatorRecoveryUiFill> {
  if (
    !isRecord(value) ||
    ![
      "executionId",
      "orderId",
      "symbol",
      "side",
      "quantity",
      "price",
      "executedAt",
    ].every((key) => Object.hasOwn(value, key)) ||
    Object.keys(value).some(
      (key) =>
        ![
          "executionId",
          "orderId",
          "clientOrderId",
          "symbol",
          "side",
          "quantity",
          "price",
          "executedAt",
        ].includes(key),
    )
  )
    return invalidAttestation("manual fill observation has an invalid shape");
  const executionId = requireIdentifier(value.executionId, "executionId");
  const orderId = requireIdentifier(value.orderId, "orderId");
  const clientOrderId =
    value.clientOrderId === undefined
      ? ok<string | undefined>(undefined)
      : requireIdentifier(value.clientOrderId, "clientOrderId");
  const symbol = requireIdentifier(value.symbol, "symbol");
  const quantity = boundedDecimal(value.quantity, "quantity");
  const price = boundedDecimal(value.price, "price");
  const executedAt = parseUtcTimestamp(value.executedAt);
  if (
    !executionId.ok ||
    !orderId.ok ||
    !clientOrderId.ok ||
    !symbol.ok ||
    !quantity.ok ||
    !price.ok ||
    !executedAt.ok ||
    (value.side !== "Buy" && value.side !== "Sell")
  )
    return invalidAttestation("manual fill observation is malformed");
  return ok({
    executionId: executionId.value,
    orderId: orderId.value,
    ...(clientOrderId.value === undefined
      ? {}
      : { clientOrderId: clientOrderId.value }),
    symbol: symbol.value,
    side: value.side,
    quantity: quantity.value,
    price: price.value,
    executedAt: executedAt.value,
  });
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function canonicalizeAttestation(
  input: unknown,
): Result<OperatorMainnetRecoveryAttestation> {
  if (
    !exactRecord(input, ATTESTATION_BODY_FIELDS) ||
    input.provenance !== "MANUAL_ATTESTED_NOT_API_VERIFIED" ||
    input.exchange !== "bybit" ||
    input.environment !== "mainnet" ||
    !exactRecord(input.inspection, [
      "accountOpenOrdersInspected",
      "accountOpenOrders",
      "accountPositionsInspected",
      "accountPositions",
      "sourceOrderHistoryInspected",
      "sourceOrders",
      "sourceFillsInspected",
      "sourceFills",
      "sourcePositionInspected",
      "sourcePosition",
      "sourceTakeProfitInspected",
      "sourceTakeProfitOrders",
    ]) ||
    input.inspection.accountOpenOrdersInspected !== true ||
    input.inspection.accountPositionsInspected !== true ||
    input.inspection.sourceOrderHistoryInspected !== true ||
    input.inspection.sourceFillsInspected !== true ||
    input.inspection.sourcePositionInspected !== true ||
    input.inspection.sourceTakeProfitInspected !== true
  )
    return invalidAttestation(
      "manual recovery requires explicit account-wide orders, positions and source inspection",
    );
  const accountIdentityHash = requireHash(
    input.accountIdentityHash,
    "accountIdentityHash",
  );
  const sourceId = requireIdentifier(input.sourceId, "sourceId");
  const sourcePlanHash = requireHash(input.sourcePlanHash, "sourcePlanHash");
  const sourceIntentId = requireIdentifier(
    input.sourceIntentId,
    "sourceIntentId",
  );
  const sourceRevision = requireFiniteInteger(
    input.sourceRevision,
    "sourceRevision",
  );
  const actor = requireIdentifier(input.actor, "actor");
  const observedAt = parseUtcTimestamp(input.observedAt);
  const accountOpenOrders = arrayOf(
    input.inspection.accountOpenOrders,
    "accountOpenOrders",
    parseUiOrder,
  );
  const accountPositions = arrayOf(
    input.inspection.accountPositions,
    "accountPositions",
    parseUiPosition,
  );
  const sourceOrders = arrayOf(
    input.inspection.sourceOrders,
    "sourceOrders",
    parseUiOrder,
  );
  const sourceFills = arrayOf(
    input.inspection.sourceFills,
    "sourceFills",
    parseUiFill,
  );
  const sourcePosition =
    input.inspection.sourcePosition === null
      ? ok<OperatorRecoveryUiPosition | null>(null)
      : parseUiPosition(input.inspection.sourcePosition);
  const sourceTakeProfitOrders = arrayOf(
    input.inspection.sourceTakeProfitOrders,
    "sourceTakeProfitOrders",
    parseUiOrder,
  );
  const manualActions = arrayOf(
    input.manualActions,
    "manualActions",
    (value) =>
      value === "none" ||
      value === "entry-remainder-cancelled" ||
      value === "position-closed" ||
      value === "other"
        ? ok(value as OperatorRecoveryManualAction)
        : invalidAttestation("manual action is not supported"),
    10,
  );
  const acceptedUncertainty = arrayOf(
    input.acceptedUncertainty,
    "acceptedUncertainty",
    (value) =>
      value === "manual-ui-may-be-stale" ||
      value === "provider-history-may-be-delayed" ||
      value === "other-operator-accepted-risk"
        ? ok(value as OperatorRecoveryAcceptedUncertainty)
        : invalidAttestation("accepted uncertainty code is not supported"),
    10,
  );
  if (
    !accountIdentityHash.ok ||
    !sourceId.ok ||
    !sourcePlanHash.ok ||
    !sourceIntentId.ok ||
    !sourceRevision.ok ||
    !actor.ok ||
    !observedAt.ok ||
    !accountOpenOrders.ok ||
    !accountPositions.ok ||
    !sourceOrders.ok ||
    !sourceFills.ok ||
    !sourcePosition.ok ||
    !sourceTakeProfitOrders.ok ||
    !manualActions.ok ||
    !acceptedUncertainty.ok ||
    acceptedUncertainty.value.length === 0 ||
    manualActions.value.length === 0 ||
    !unique(accountOpenOrders.value.map((item) => item.orderId)) ||
    !unique(accountPositions.value.map((item) => item.symbol)) ||
    !unique(sourceOrders.value.map((item) => item.orderId)) ||
    !unique(sourceFills.value.map((item) => item.executionId)) ||
    !unique(sourceTakeProfitOrders.value.map((item) => item.orderId))
  )
    return invalidAttestation(
      "manual recovery facts are incomplete or conflicting",
    );
  const body = {
    provenance: "MANUAL_ATTESTED_NOT_API_VERIFIED" as const,
    exchange: "bybit" as const,
    environment: "mainnet" as const,
    accountIdentityHash: accountIdentityHash.value as PlanHash,
    sourceId: sourceId.value,
    sourcePlanHash: sourcePlanHash.value as PlanHash,
    sourceIntentId: sourceIntentId.value,
    sourceRevision: sourceRevision.value,
    actor: actor.value,
    observedAt: observedAt.value,
    inspection: {
      accountOpenOrdersInspected: true as const,
      accountOpenOrders: accountOpenOrders.value,
      accountPositionsInspected: true as const,
      accountPositions: accountPositions.value,
      sourceOrderHistoryInspected: true as const,
      sourceOrders: sourceOrders.value,
      sourceFillsInspected: true as const,
      sourceFills: sourceFills.value,
      sourcePositionInspected: true as const,
      sourcePosition: sourcePosition.value,
      sourceTakeProfitInspected: true as const,
      sourceTakeProfitOrders: sourceTakeProfitOrders.value,
    },
    manualActions: manualActions.value,
    acceptedUncertainty: acceptedUncertainty.value,
  };
  const identityHash = hashCanonical(body);
  if (!identityHash.ok) return invalidAttestation();
  const identified = {
    schemaVersion: OPERATOR_MAINNET_RECOVERY_ATTESTATION_SCHEMA_VERSION,
    attestationId: `operator-mainnet-recovery-attestation:${identityHash.value.slice(7, 47)}`,
    ...body,
  };
  const contentHash = hashCanonical(identified);
  if (!contentHash.ok) return invalidAttestation();
  return ok(
    deepFreeze({
      ...identified,
      contentHash: contentHash.value,
    }) as OperatorMainnetRecoveryAttestation,
  );
}

export function createOperatorMainnetRecoveryAttestation(
  input: unknown,
): Result<OperatorMainnetRecoveryAttestation> {
  return canonicalizeAttestation(input);
}

export function rehydrateOperatorMainnetRecoveryAttestation(
  input: unknown,
): Result<OperatorMainnetRecoveryAttestation> {
  if (!exactRecord(input, ATTESTATION_FIELDS)) return invalidAttestation();
  const replayed = canonicalizeAttestation(
    Object.fromEntries(
      ATTESTATION_BODY_FIELDS.map((field) => [field, input[field]]),
    ),
  );
  const contentHash = requireHash(input.contentHash, "contentHash");
  if (
    !replayed.ok ||
    !contentHash.ok ||
    input.schemaVersion !==
      OPERATOR_MAINNET_RECOVERY_ATTESTATION_SCHEMA_VERSION ||
    input.attestationId !== replayed.value.attestationId ||
    contentHash.value !== replayed.value.contentHash
  )
    return invalidAttestation(
      "manual recovery attestation failed canonical replay",
    );
  const actual = canonicalSerialize(input);
  const expected = canonicalSerialize(replayed.value);
  return actual.ok && expected.ok && actual.value === expected.value
    ? replayed
    : invalidAttestation(
        "manual recovery attestation differs from canonical replay",
      );
}

export function validateOperatorMainnetRecoveryAttestationBinding(
  input: unknown,
  binding: {
    readonly accountIdentityHash: unknown;
    readonly sourceId: unknown;
    readonly sourcePlanHash: unknown;
    readonly sourceIntentId: unknown;
    readonly sourceRevision: unknown;
    readonly entryClientOrderId: unknown;
  },
): Result<OperatorMainnetRecoveryAttestation> {
  const attestation = rehydrateOperatorMainnetRecoveryAttestation(input);
  const accountIdentityHash = requireHash(
    binding.accountIdentityHash,
    "accountIdentityHash",
  );
  const sourceId = requireIdentifier(binding.sourceId, "sourceId");
  const sourcePlanHash = requireHash(binding.sourcePlanHash, "sourcePlanHash");
  const sourceIntentId = requireIdentifier(
    binding.sourceIntentId,
    "sourceIntentId",
  );
  const sourceRevision = requireFiniteInteger(
    binding.sourceRevision,
    "sourceRevision",
  );
  const entryClientOrderId = requireIdentifier(
    binding.entryClientOrderId,
    "entryClientOrderId",
  );
  if (
    !attestation.ok ||
    !accountIdentityHash.ok ||
    !sourceId.ok ||
    !sourcePlanHash.ok ||
    !sourceIntentId.ok ||
    !sourceRevision.ok ||
    !entryClientOrderId.ok ||
    attestation.value.accountIdentityHash !== accountIdentityHash.value ||
    attestation.value.sourceId !== sourceId.value ||
    attestation.value.sourcePlanHash !== sourcePlanHash.value ||
    attestation.value.sourceIntentId !== sourceIntentId.value ||
    attestation.value.sourceRevision !== sourceRevision.value ||
    !attestation.value.inspection.sourceOrders.some(
      (order) => order.clientOrderId === entryClientOrderId.value,
    )
  )
    return invalidAttestation(
      "manual recovery evidence does not identify the current account, source and owned entry order",
    );
  return attestation;
}

function parseResolution(
  value: unknown,
): Result<OperatorMainnetRecoveryResolution> {
  if (!isRecord(value)) return invalidGrant("recovery resolution is malformed");
  if (
    value.kind === "api-resolved" &&
    exactRecord(value, ["kind", "evidenceHash", "observedAt"])
  ) {
    const evidenceHash = requireHash(value.evidenceHash, "evidenceHash");
    const observedAt = parseUtcTimestamp(value.observedAt);
    return evidenceHash.ok && observedAt.ok
      ? ok({
          kind: "api-resolved",
          evidenceHash: evidenceHash.value as PlanHash,
          observedAt: observedAt.value,
        })
      : invalidGrant("API recovery proof is malformed");
  }
  if (
    value.kind === "manual-attested" &&
    exactRecord(value, [
      "kind",
      "attestationId",
      "attestationHash",
      "observedAt",
    ])
  ) {
    const attestationId = requireIdentifier(
      value.attestationId,
      "attestationId",
    );
    const attestationHash = requireHash(
      value.attestationHash,
      "attestationHash",
    );
    const observedAt = parseUtcTimestamp(value.observedAt);
    return attestationId.ok && attestationHash.ok && observedAt.ok
      ? ok({
          kind: "manual-attested",
          attestationId: attestationId.value,
          attestationHash: attestationHash.value as PlanHash,
          observedAt: observedAt.value,
        })
      : invalidGrant("manual recovery proof is malformed");
  }
  return invalidGrant("recovery resolution kind is not supported");
}

function parseHaltOrigin(
  value: unknown,
): Result<OperatorMainnetRecoveryHaltOrigin | undefined> {
  if (value === undefined || value === null) return ok(undefined);
  if (!exactRecord(value, ["eventId", "revision", "originHash"]))
    return invalidGrant("HALT origin binding is malformed");
  const eventId = requireIdentifier(value.eventId, "eventId");
  const revision = requireFiniteInteger(value.revision, "revision", 1);
  const originHash = requireHash(value.originHash, "originHash");
  if (!eventId.ok || !revision.ok || !originHash.ok)
    return invalidGrant("HALT origin binding is invalid");
  return ok({
    eventId: eventId.value,
    revision: revision.value,
    originHash: originHash.value as PlanHash,
  });
}

function grantBody(
  input: Record<string, unknown>,
): Result<
  Omit<
    OperatorMainnetRecoveryGrant,
    "schemaVersion" | "grantId" | "contentHash"
  >
> {
  const resolution = parseResolution(input.resolution);
  const accountIdentityHash = requireHash(
    input.accountIdentityHash,
    "accountIdentityHash",
  );
  const sourceId = requireIdentifier(input.sourceId, "sourceId");
  const sourcePlanHash = requireHash(input.sourcePlanHash, "sourcePlanHash");
  const sourceIntentId = requireIdentifier(
    input.sourceIntentId,
    "sourceIntentId",
  );
  const sourceRevision = requireFiniteInteger(
    input.sourceRevision,
    "sourceRevision",
  );
  const haltRevision = requireFiniteInteger(input.haltRevision, "haltRevision");
  const haltOrigin = parseHaltOrigin(input.haltOrigin);
  const planHash = requireHash(input.planHash, "planHash");
  const planExpiresAt = parseUtcTimestamp(input.planExpiresAt);
  const actor = requireIdentifier(input.actor, "actor");
  const issuedAt = parseUtcTimestamp(input.issuedAt);
  const expiresAt = parseUtcTimestamp(input.expiresAt);
  if (
    !resolution.ok ||
    !accountIdentityHash.ok ||
    !sourceId.ok ||
    !sourcePlanHash.ok ||
    !sourceIntentId.ok ||
    !sourceRevision.ok ||
    !haltRevision.ok ||
    !haltOrigin.ok ||
    !planHash.ok ||
    !planExpiresAt.ok ||
    !actor.ok ||
    !issuedAt.ok ||
    !expiresAt.ok ||
    input.exchange !== "bybit" ||
    input.environment !== "mainnet" ||
    input.consent !== true ||
    sourcePlanHash.value === planHash.value ||
    expiresAt.value <= issuedAt.value ||
    expiresAt.value > planExpiresAt.value ||
    (haltOrigin.value !== undefined &&
      haltOrigin.value.revision + 1 !== haltRevision.value)
  )
    return invalidGrant("recovery grant fields or plan binding are invalid");
  const observedAt = resolution.value.observedAt;
  const maxExpiresAt = addMilliseconds(
    observedAt,
    OPERATOR_MAINNET_RECOVERY_MAX_AGE_MS,
  );
  if (
    !maxExpiresAt.ok ||
    timestampToEpochMs(issuedAt.value) < timestampToEpochMs(observedAt) ||
    timestampToEpochMs(issuedAt.value) - timestampToEpochMs(observedAt) >
      OPERATOR_MAINNET_RECOVERY_MAX_AGE_MS ||
    timestampToEpochMs(expiresAt.value) > timestampToEpochMs(maxExpiresAt.value)
  )
    return invalidGrant(
      "recovery proof or grant exceeds the five-minute window",
    );
  return ok({
    resolution: resolution.value,
    exchange: "bybit",
    environment: "mainnet",
    accountIdentityHash: accountIdentityHash.value as PlanHash,
    sourceId: sourceId.value,
    sourcePlanHash: sourcePlanHash.value as PlanHash,
    sourceIntentId: sourceIntentId.value,
    sourceRevision: sourceRevision.value,
    haltRevision: haltRevision.value,
    haltOrigin: haltOrigin.value ?? null,
    planHash: planHash.value as PlanHash,
    planExpiresAt: planExpiresAt.value,
    actor: actor.value,
    consent: true,
    issuedAt: issuedAt.value,
    expiresAt: expiresAt.value,
  });
}

export function createOperatorMainnetRecoveryGrant(
  input: unknown,
): Result<OperatorMainnetRecoveryGrant> {
  if (!isRecord(input) || !Object.hasOwn(input, "plan"))
    return invalidGrant("a validated saved plan is required for recovery");
  const plan = rehydrateOperatorMainnetTestPlan(input.plan);
  const body = grantBody(input);
  if (
    !plan.ok ||
    !body.ok ||
    plan.value.contentHash !== body.value.planHash ||
    plan.value.accountIdentityHash !== body.value.accountIdentityHash ||
    timestampToEpochMs(body.value.planExpiresAt) !==
      timestampToEpochMs(plan.value.preparedAt) + plan.value.approvalTtlMs
  )
    return invalidGrant("recovery grant does not match the saved exact plan");
  const identityHash = hashCanonical(body.value);
  if (!identityHash.ok) return invalidGrant();
  const identified = {
    schemaVersion: OPERATOR_MAINNET_RECOVERY_GRANT_SCHEMA_VERSION,
    grantId: `operator-mainnet-recovery-grant:${identityHash.value.slice(7, 47)}`,
    ...body.value,
  };
  const contentHash = hashCanonical(identified);
  if (!contentHash.ok) return invalidGrant();
  return ok(deepFreeze({ ...identified, contentHash: contentHash.value }));
}

export function rehydrateOperatorMainnetRecoveryGrant(
  input: unknown,
): Result<OperatorMainnetRecoveryGrant> {
  if (
    !isRecord(input) ||
    Reflect.ownKeys(input).length !== GRANT_FIELDS.length ||
    !GRANT_FIELDS.every((field) => Object.hasOwn(input, field))
  )
    return invalidGrant();
  const bodyInput = Object.fromEntries(
    GRANT_BODY_FIELDS.map((field) => [field, input[field]]),
  );
  bodyInput.haltOrigin = input.haltOrigin;
  const body = grantBody(bodyInput);
  const contentHash = requireHash(input.contentHash, "contentHash");
  if (!body.ok || !contentHash.ok)
    return invalidGrant("recovery grant failed canonical replay");
  const identityHash = hashCanonical(body.value);
  if (!identityHash.ok)
    return invalidGrant("recovery grant failed canonical replay");
  const identified = {
    schemaVersion: OPERATOR_MAINNET_RECOVERY_GRANT_SCHEMA_VERSION,
    grantId: `operator-mainnet-recovery-grant:${identityHash.value.slice(7, 47)}`,
    ...body.value,
  };
  const actualHash = hashCanonical(identified);
  if (
    !actualHash.ok ||
    input.schemaVersion !== OPERATOR_MAINNET_RECOVERY_GRANT_SCHEMA_VERSION ||
    input.grantId !== identified.grantId ||
    contentHash.value !== actualHash.value
  )
    return invalidGrant("recovery grant failed canonical replay");
  const actual = canonicalSerialize(input);
  const expected = canonicalSerialize({
    ...identified,
    contentHash: actualHash.value,
  });
  return actual.ok && expected.ok && actual.value === expected.value
    ? ok(
        deepFreeze({
          ...identified,
          contentHash: actualHash.value,
        }) as OperatorMainnetRecoveryGrant,
      )
    : invalidGrant("recovery grant differs from canonical replay");
}

export function validateOperatorMainnetRecoveryGrantForPlan(
  input: unknown,
  planInput: unknown,
  nowInput: unknown,
): Result<OperatorMainnetRecoveryGrant> {
  const grant = rehydrateOperatorMainnetRecoveryGrant(input);
  const plan = rehydrateOperatorMainnetTestPlan(planInput);
  const now = parseUtcTimestamp(nowInput);
  if (
    !grant.ok ||
    !plan.ok ||
    !now.ok ||
    grant.value.planHash !== plan.value.contentHash ||
    grant.value.accountIdentityHash !== plan.value.accountIdentityHash ||
    timestampToEpochMs(grant.value.planExpiresAt) !==
      timestampToEpochMs(plan.value.preparedAt) + plan.value.approvalTtlMs ||
    timestampToEpochMs(now.value) < timestampToEpochMs(grant.value.issuedAt) ||
    timestampToEpochMs(now.value) >= timestampToEpochMs(grant.value.expiresAt)
  )
    return fail(
      domainError(
        "PLAN_EXPIRED",
        "operator recovery grant is missing, stale or bound to another plan",
      ),
    );
  return grant;
}

export function recoveryGrantPlanExpiry(
  plan: OperatorMainnetTestPlan,
): Result<UtcTimestamp> {
  return addMilliseconds(plan.preparedAt, plan.approvalTtlMs);
}

export function recoveryAttestationContentHash(
  input: unknown,
): Result<PlanHash> {
  const attestation = rehydrateOperatorMainnetRecoveryAttestation(input);
  return attestation.ok ? ok(attestation.value.contentHash) : attestation;
}
