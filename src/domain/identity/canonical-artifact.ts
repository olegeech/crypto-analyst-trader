import { createHash } from "node:crypto";

import { canonicalSerialize } from "./canonical-serialization.js";

import {
  createCapabilityObservation,
  parseCapabilityScope,
  type CapabilityRequirement,
  type CapabilityObservation,
} from "../capabilities/capability.js";
import {
  createEvidenceRef,
  type EvidenceRef,
} from "../evidence/evidence-ref.js";
import { createApproval, type Approval } from "../execution/approval.js";
import {
  createExchangeOrder,
  type ExchangeOrderObservation,
} from "../execution/exchange-order.js";
import {
  createExecutionAttempt,
  type ExecutionAttempt,
} from "../execution/execution-attempt.js";
import {
  rehydrateLifecycleState,
  type LifecycleState,
} from "../execution/lifecycle.js";
import {
  rehydrateReconciliationResult,
  type ReconciliationResult,
} from "../execution/reconciliation.js";
import { createFee, type Fee } from "../accounting/fee.js";
import { createFill, type Fill } from "../accounting/fill.js";
import { createFunding, type Funding } from "../accounting/funding.js";
import {
  createLedgerEntry,
  type LedgerEntry,
} from "../accounting/ledger-entry.js";
import {
  createAccountSnapshot,
  createMarketSnapshot,
  type AccountSnapshot,
  type MarketSnapshot,
} from "../market/snapshots.js";
import {
  createInstrumentConstraints,
  type InstrumentConstraints,
} from "../market/instrument-constraints.js";
import {
  createStrategyConfig,
  type StrategyConfig,
} from "../market/strategy-config.js";
import {
  createExecutionPlan,
  type ExecutionPlan,
} from "../planning/execution-plan.js";
import {
  createOrderIntent,
  type OrderIntent,
  type ValidatedOrderIntentInput,
} from "../planning/order-intent.js";
import {
  rehydrateRiskDecision,
  type RiskDecision,
} from "../risk/risk-decision.js";
import { DecimalValue, isDecimalValue } from "../shared/decimal.js";
import { domainError } from "../shared/errors.js";
import { fail, ok, type Result } from "../shared/result.js";
import {
  isRecord,
  requireHash,
  requireIdentifier,
} from "../shared/validation.js";
import type { ClearanceEvidence } from "../execution/clearance-evidence.js";
import { createClearanceEvidence } from "../execution/clearance-evidence.js";

export const ARTIFACT_SCHEMA_VERSION = "artifact/v1" as const;

export type ArtifactKind =
  | "evidence-ref"
  | "instrument-constraints"
  | "strategy-config"
  | "capability-observation"
  | "market-snapshot"
  | "account-snapshot"
  | "order-intent"
  | "risk-decision"
  | "execution-plan"
  | "approval"
  | "lifecycle-state"
  | "execution-attempt"
  | "exchange-order"
  | "reconciliation-result"
  | "fill"
  | "fee"
  | "funding"
  | "ledger-entry"
  | "clearance-evidence";

export interface CanonicalArtifactEnvelope {
  readonly artifactKind: ArtifactKind;
  readonly schemaVersion: typeof ARTIFACT_SCHEMA_VERSION;
  readonly canonicalJson: string;
  readonly canonicalHash: string;
}

export type RehydratedArtifact =
  | EvidenceRef
  | InstrumentConstraints
  | StrategyConfig
  | CapabilityObservation
  | MarketSnapshot
  | AccountSnapshot
  | OrderIntent
  | RiskDecision
  | ExecutionPlan
  | Approval
  | LifecycleState
  | ExecutionAttempt
  | ExchangeOrderObservation
  | ReconciliationResult
  | Fill
  | Fee
  | Funding
  | LedgerEntry
  | ClearanceEvidence;

type Schema =
  | { readonly kind: "leaf" }
  | { readonly kind: "array"; readonly item?: Schema }
  | {
      readonly kind: "object";
      readonly keys: ReadonlySet<string>;
      readonly required: ReadonlySet<string>;
      readonly children: ReadonlyMap<string, Schema>;
      readonly open?: boolean;
    };

function array(item?: Schema): Schema {
  return item === undefined ? { kind: "array" } : { kind: "array", item };
}

function object(
  keys: readonly string[],
  children: Readonly<Record<string, Schema>> = {},
  required: readonly string[] = keys,
  open = false,
): Schema {
  return {
    kind: "object",
    keys: new Set(keys),
    required: new Set(required),
    children: new Map(Object.entries(children)),
    ...(open ? { open: true } : {}),
  };
}

const evidenceSchema = object([
  "kind",
  "schemaVersion",
  "producer",
  "sourceId",
  "asOf",
  "validForMs",
  "contentHash",
]);

const scopeSchema = object([
  "exchange",
  "environment",
  "category",
  "positionMode",
]);

const constraintsSchema = object(
  [
    "instrument",
    "version",
    "priceTickSize",
    "quantityStep",
    "minQuantity",
    "minNotional",
  ],
  {},
  ["instrument", "version", "priceTickSize", "quantityStep", "minQuantity"],
);

const strategySchema = object([
  "strategyId",
  "version",
  "cadence",
  "maxOrderNotional",
  "requiresProtection",
]);

const positionSchema = object(
  ["instrument", "side", "quantity", "entryPrice"],
  {},
  ["instrument", "side", "quantity"],
);

const ownedOrderSchema = object([
  "clientOrderId",
  "instrument",
  "side",
  "quantity",
]);

const marketSnapshotSchema = object(
  [
    "snapshotId",
    "instrument",
    "scope",
    "asOf",
    "bid",
    "ask",
    "last",
    "constraints",
    "evidence",
  ],
  {
    scope: scopeSchema,
    constraints: constraintsSchema,
    evidence: array(evidenceSchema),
  },
);

const accountSnapshotSchema = object(
  [
    "snapshotId",
    "accountScope",
    "scope",
    "asOf",
    "availableBalance",
    "positions",
    "ownedOrders",
    "evidence",
  ],
  {
    scope: scopeSchema,
    positions: array(positionSchema),
    ownedOrders: array(ownedOrderSchema),
    evidence: array(evidenceSchema),
  },
);

const capabilityRequirementSchema = object(["capability", "scope"], {
  scope: scopeSchema,
});

const capabilitySchema = object(
  ["capability", "status", "observedAt", "source", "evidence", "scope"],
  {
    evidence: evidenceSchema,
    scope: scopeSchema,
  },
);

const normalizationSchema = object(["price", "quantity", "constraintVersion"]);

const protectionSchema = object(["stopLoss", "takeProfit"], {}, []);

const orderIntentSchema = object(
  [
    "intentId",
    "instrument",
    "orderType",
    "side",
    "positionEffect",
    "price",
    "quantity",
    "notional",
    "normalization",
    "protection",
  ],
  { normalization: normalizationSchema, protection: protectionSchema },
  [
    "intentId",
    "instrument",
    "orderType",
    "side",
    "positionEffect",
    "price",
    "quantity",
    "notional",
    "normalization",
  ],
);

const riskDecisionSchema = object(
  [
    "decisionId",
    "inputHash",
    "intentIds",
    "status",
    "reasonCodes",
    "asOf",
    "evidence",
    "requiredCapabilities",
  ],
  {
    evidence: array(evidenceSchema),
    requiredCapabilities: array(capabilityRequirementSchema),
  },
);

const materialSchema = object(
  [
    "strategy",
    "marketSnapshot",
    "accountSnapshot",
    "evidence",
    "desiredCurrentDiff",
    "orderIntents",
    "requiredCapabilities",
    "executionScope",
    "riskDecision",
  ],
  {
    strategy: strategySchema,
    marketSnapshot: marketSnapshotSchema,
    accountSnapshot: accountSnapshotSchema,
    evidence: array(evidenceSchema),
    desiredCurrentDiff: object([], {}, [], true),
    orderIntents: array(orderIntentSchema),
    requiredCapabilities: array(capabilityRequirementSchema),
    executionScope: scopeSchema,
    riskDecision: riskDecisionSchema,
  },
);

const presentationSchema = object(["generatedAt", "comment"], {}, [
  "generatedAt",
]);

const approvalSchema = object(
  ["approvalId", "planHash", "actor", "approvedAt", "expiresAt", "note"],
  {},
  ["approvalId", "planHash", "actor", "approvedAt", "expiresAt"],
);

const lifecycleSchema = object(
  ["state", "planHash", "intentIds", "evidence", "approval"],
  { evidence: array(evidenceSchema), approval: approvalSchema },
  ["state", "planHash", "intentIds", "evidence"],
);

const attemptSchema = object(
  [
    "attemptId",
    "planHash",
    "intentId",
    "clientOrderId",
    "submittedAt",
    "acknowledgement",
    "terminalStatus",
    "exchangeOrderId",
  ],
  {},
  [
    "attemptId",
    "planHash",
    "intentId",
    "clientOrderId",
    "submittedAt",
    "acknowledgement",
    "terminalStatus",
  ],
);

const exchangeOrderSchema = object(
  [
    "exchangeOrderId",
    "clientOrderId",
    "instrument",
    "side",
    "requestedQuantity",
    "filledQuantity",
    "status",
    "observedAt",
    "source",
    "parentOrderLinkId",
    "averagePrice",
  ],
  {},
  [
    "exchangeOrderId",
    "clientOrderId",
    "instrument",
    "side",
    "requestedQuantity",
    "filledQuantity",
    "status",
    "observedAt",
    "source",
  ],
);

const reconciliationSchema = object(
  [
    "attemptId",
    "intentId",
    "planHash",
    "clientOrderId",
    "status",
    "observedAt",
    "exchangeOrderId",
  ],
  {},
  [
    "attemptId",
    "intentId",
    "planHash",
    "clientOrderId",
    "status",
    "observedAt",
  ],
);

const fillSchema = object([
  "fillId",
  "attemptId",
  "exchangeOrderId",
  "instrument",
  "side",
  "quantity",
  "price",
  "executedAt",
  "source",
]);

const feeSchema = object([
  "feeId",
  "amount",
  "currency",
  "kind",
  "chargedAt",
  "source",
]);

const fundingSchema = object([
  "fundingId",
  "amount",
  "currency",
  "occurredAt",
  "source",
]);

const ledgerEntrySchema = object([
  "entryId",
  "kind",
  "amount",
  "currency",
  "occurredAt",
  "source",
  "referenceId",
]);

const clearanceEvidenceSchema = object([
  "evidenceVersion",
  "actor",
  "source",
  "timestamp",
  "reason",
  "affectedLineageRevision",
  "affectedReconciliationRevision",
]);

const schemas: ReadonlyMap<ArtifactKind, Schema> = new Map([
  ["evidence-ref", evidenceSchema],
  ["instrument-constraints", constraintsSchema],
  ["strategy-config", strategySchema],
  ["capability-observation", capabilitySchema],
  ["market-snapshot", marketSnapshotSchema],
  ["account-snapshot", accountSnapshotSchema],
  ["order-intent", orderIntentSchema],
  ["risk-decision", riskDecisionSchema],
  [
    "execution-plan",
    object(
      ["planId", "identityVersion", "materialHash", "material", "presentation"],
      { material: materialSchema, presentation: presentationSchema },
      ["planId", "identityVersion", "materialHash", "material"],
    ),
  ],
  ["approval", approvalSchema],
  ["lifecycle-state", lifecycleSchema],
  ["execution-attempt", attemptSchema],
  ["exchange-order", exchangeOrderSchema],
  ["reconciliation-result", reconciliationSchema],
  ["fill", fillSchema],
  ["fee", feeSchema],
  ["funding", fundingSchema],
  ["ledger-entry", ledgerEntrySchema],
  ["clearance-evidence", clearanceEvidenceSchema],
]);

function artifactFailure(message: string): Result<never> {
  return fail(domainError("INVALID_VALUE", message));
}

function unsupportedArtifact(message: string): Result<never> {
  return fail(domainError("UNSUPPORTED_CONTRACT", message));
}

function hashCanonicalText(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function validateShape(
  value: unknown,
  schema: Schema,
  path: string,
): Result<void> {
  if (isDecimalValue(value)) {
    return schema.kind === "leaf"
      ? ok(undefined)
      : artifactFailure(`${path} must be an object or array`);
  }
  if (schema.kind === "leaf") {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isSafeInteger(value))
    ) {
      return ok(undefined);
    }
    return artifactFailure(`${path} is not a canonical scalar`);
  }
  if (schema.kind === "array") {
    if (!Array.isArray(value))
      return artifactFailure(`${path} must be an array`);
    if (schema.item === undefined) return ok(undefined);
    for (const [index, item] of value.entries()) {
      const result = validateShape(item, schema.item, `${path}[${index}]`);
      if (!result.ok) return result;
    }
    return ok(undefined);
  }
  if (!isRecord(value)) return artifactFailure(`${path} must be an object`);
  for (const key of schema.required) {
    if (!Object.hasOwn(value, key)) {
      return artifactFailure(`${path}.${key} is required`);
    }
  }
  if (!schema.open) {
    for (const key of Object.keys(value)) {
      if (!schema.keys.has(key)) {
        return artifactFailure(`${path}.${key} is not allowed`);
      }
    }
  }
  for (const [key, childSchema] of schema.children) {
    if (!Object.hasOwn(value, key)) continue;
    const result = validateShape(value[key], childSchema, `${path}.${key}`);
    if (!result.ok) return result;
  }
  return ok(undefined);
}

function decodeValue(value: unknown, path: string): Result<unknown> {
  if (Array.isArray(value)) {
    const decoded: unknown[] = [];
    for (const [index, item] of value.entries()) {
      const result = decodeValue(item, `${path}[${index}]`);
      if (!result.ok) return result;
      decoded.push(result.value);
    }
    return ok(decoded);
  }
  if (!isRecord(value)) return ok(value);
  const keys = Object.keys(value);
  if (keys.includes("$decimal")) {
    if (keys.length !== 1 || typeof value.$decimal !== "string") {
      return artifactFailure(`${path} contains an invalid decimal tag`);
    }
    const decimal = DecimalValue.fromString(value.$decimal);
    if (!decimal.ok) return decimal;
    return ok(decimal.value);
  }
  const decoded: Record<string, unknown> = {};
  for (const key of keys) {
    const result = decodeValue(value[key], `${path}.${key}`);
    if (!result.ok) return result;
    decoded[key] = result.value;
  }
  return ok(decoded);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (
    typeof value !== "object" ||
    value === null ||
    isDecimalValue(value) ||
    seen.has(value)
  ) {
    return value;
  }
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

export function encodeCanonicalArtifact(
  artifactKind: ArtifactKind,
  value: unknown,
): Result<CanonicalArtifactEnvelope> {
  const schema = schemas.get(artifactKind);
  if (schema === undefined)
    return unsupportedArtifact("artifact kind is unsupported");
  const shape = validateShape(value, schema, artifactKind);
  if (!shape.ok) return shape;
  const canonical = canonicalSerialize(value);
  if (!canonical.ok) return canonical;
  return ok(
    Object.freeze({
      artifactKind,
      schemaVersion: ARTIFACT_SCHEMA_VERSION,
      canonicalJson: canonical.value,
      canonicalHash: hashCanonicalText(canonical.value),
    }),
  );
}

export function decodeCanonicalArtifact(
  input: unknown,
  expectedKind?: ArtifactKind,
): Result<unknown> {
  if (!isRecord(input))
    return artifactFailure("artifact envelope must be an object");
  const envelopeKeys = Object.keys(input);
  const allowedKeys = new Set([
    "artifactKind",
    "schemaVersion",
    "canonicalJson",
    "canonicalHash",
  ]);
  if (
    envelopeKeys.some((key) => !allowedKeys.has(key)) ||
    envelopeKeys.length !== allowedKeys.size
  ) {
    return artifactFailure(
      "artifact envelope contains unknown or missing fields",
    );
  }
  if (
    typeof input.artifactKind !== "string" ||
    !schemas.has(input.artifactKind as ArtifactKind)
  ) {
    return unsupportedArtifact("artifact kind is unsupported");
  }
  const artifactKind = input.artifactKind as ArtifactKind;
  if (expectedKind !== undefined && artifactKind !== expectedKind) {
    return artifactFailure(
      "artifact kind does not match the requested decoder",
    );
  }
  if (input.schemaVersion !== ARTIFACT_SCHEMA_VERSION) {
    return unsupportedArtifact("artifact schema version is unsupported");
  }
  if (typeof input.canonicalJson !== "string") {
    return artifactFailure("artifact canonical JSON must be text");
  }
  const parsedHash = requireHash(input.canonicalHash, "canonicalHash");
  if (!parsedHash.ok) return parsedHash;
  if (parsedHash.value !== hashCanonicalText(input.canonicalJson)) {
    return artifactFailure("artifact hash does not match canonical bytes");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.canonicalJson) as unknown;
  } catch {
    return artifactFailure("artifact canonical JSON is malformed");
  }
  const decoded = decodeValue(parsed, artifactKind);
  if (!decoded.ok) return decoded;
  const schema = schemas.get(artifactKind);
  if (schema === undefined)
    return unsupportedArtifact("artifact kind is unsupported");
  const shape = validateShape(decoded.value, schema, artifactKind);
  if (!shape.ok) return shape;
  const canonical = canonicalSerialize(decoded.value);
  if (!canonical.ok || canonical.value !== input.canonicalJson) {
    return artifactFailure("artifact JSON is not canonical");
  }
  return ok(deepFreeze(decoded.value));
}

function toConstructorInput(value: unknown): unknown {
  if (isDecimalValue(value)) return value.toString();
  if (Array.isArray(value)) return value.map(toConstructorInput);
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      result[key] = toConstructorInput(child);
    }
    return result;
  }
  return value;
}

function asRecord(
  value: unknown,
  kind: ArtifactKind,
): Result<Record<string, unknown>> {
  return isRecord(value)
    ? ok(value)
    : artifactFailure(`${kind} payload must be an object`);
}

function rehydrateExecutionPlan(value: unknown): Result<ExecutionPlan> {
  const record = asRecord(value, "execution-plan");
  if (!record.ok) return record;
  const material = asRecord(record.value.material, "execution-plan");
  if (!material.ok) return material;
  if (typeof record.value.identityVersion !== "string") {
    return artifactFailure("execution-plan identity version must be text");
  }
  const strategy = createStrategyConfig(
    toConstructorInput(material.value.strategy),
  );
  const marketSnapshot = createMarketSnapshot(
    toConstructorInput(material.value.marketSnapshot),
  );
  const accountSnapshot = createAccountSnapshot(
    toConstructorInput(material.value.accountSnapshot),
  );
  if (!strategy.ok) return strategy;
  if (!marketSnapshot.ok) return marketSnapshot;
  if (!accountSnapshot.ok) return accountSnapshot;
  if (!Array.isArray(material.value.evidence)) {
    return artifactFailure("execution-plan evidence must be an array");
  }
  const evidence: EvidenceRef[] = [];
  for (const item of material.value.evidence) {
    const parsed = createEvidenceRef(toConstructorInput(item));
    if (!parsed.ok) return parsed;
    evidence.push(parsed.value);
  }
  if (!Array.isArray(material.value.orderIntents)) {
    return artifactFailure("execution-plan intents must be an array");
  }
  const orderIntents: OrderIntent[] = [];
  for (const item of material.value.orderIntents) {
    const parsed = createOrderIntent(item as ValidatedOrderIntentInput);
    if (!parsed.ok) return parsed;
    orderIntents.push(parsed.value);
  }
  const riskDecision = rehydrateRiskDecision(material.value.riskDecision);
  if (!riskDecision.ok) return riskDecision;
  const executionScope = parseCapabilityScope(material.value.executionScope);
  const rawRequiredCapabilities = material.value.requiredCapabilities;
  if (!executionScope.ok || !Array.isArray(rawRequiredCapabilities)) {
    return artifactFailure("execution-plan capability scope is invalid");
  }
  const requiredCapabilities: CapabilityRequirement[] = [];
  for (const item of rawRequiredCapabilities) {
    if (!isRecord(item)) {
      return artifactFailure(
        "execution-plan capability requirement is invalid",
      );
    }
    const capability = requireIdentifier(item.capability, "capability");
    const scope = parseCapabilityScope(item.scope);
    if (!capability.ok || !scope.ok) {
      return artifactFailure(
        "execution-plan capability requirement is invalid",
      );
    }
    requiredCapabilities.push({
      capability: capability.value,
      scope: scope.value,
    });
  }
  const desiredCurrentDiff = material.value.desiredCurrentDiff;
  if (!isRecord(desiredCurrentDiff)) {
    return artifactFailure("execution-plan desired diff is invalid");
  }
  const plan = createExecutionPlan({
    identityVersion: record.value.identityVersion,
    material: {
      strategy: strategy.value,
      marketSnapshot: marketSnapshot.value,
      accountSnapshot: accountSnapshot.value,
      evidence: Object.freeze(evidence),
      desiredCurrentDiff,
      orderIntents: Object.freeze(orderIntents),
      requiredCapabilities: Object.freeze(requiredCapabilities),
      executionScope: executionScope.value,
      riskDecision: riskDecision.value,
    },
    ...(record.value.presentation === undefined
      ? {}
      : {
          presentation: toConstructorInput(record.value.presentation) as {
            generatedAt: unknown;
            comment?: unknown;
          },
        }),
  });
  if (!plan.ok) return plan;
  if (
    record.value.planId !== plan.value.planId ||
    record.value.materialHash !== plan.value.materialHash
  ) {
    return fail(
      domainError(
        "PLAN_HASH_MISMATCH",
        "rehydrated execution plan identity does not match its artifact",
      ),
    );
  }
  return plan;
}

export function rehydrateArtifact(
  artifactKind: "execution-plan",
  envelope: unknown,
): Result<ExecutionPlan>;
export function rehydrateArtifact(
  artifactKind: "approval",
  envelope: unknown,
): Result<Approval>;
export function rehydrateArtifact(
  artifactKind: "exchange-order",
  envelope: unknown,
): Result<ExchangeOrderObservation>;
export function rehydrateArtifact(
  artifactKind: ArtifactKind,
  envelope: unknown,
): Result<RehydratedArtifact>;
export function rehydrateArtifact(
  artifactKind: ArtifactKind,
  envelope: unknown,
): Result<RehydratedArtifact> {
  const decoded = decodeCanonicalArtifact(envelope, artifactKind);
  if (!decoded.ok) return decoded;
  switch (artifactKind) {
    case "evidence-ref":
      return createEvidenceRef(toConstructorInput(decoded.value));
    case "instrument-constraints":
      return createInstrumentConstraints(toConstructorInput(decoded.value));
    case "strategy-config":
      return createStrategyConfig(toConstructorInput(decoded.value));
    case "capability-observation":
      return createCapabilityObservation(toConstructorInput(decoded.value));
    case "market-snapshot":
      return createMarketSnapshot(toConstructorInput(decoded.value));
    case "account-snapshot":
      return createAccountSnapshot(toConstructorInput(decoded.value));
    case "order-intent":
      return createOrderIntent(decoded.value as ValidatedOrderIntentInput);
    case "risk-decision":
      return rehydrateRiskDecision(decoded.value);
    case "execution-plan":
      return rehydrateExecutionPlan(decoded.value);
    case "approval":
      return createApproval(toConstructorInput(decoded.value));
    case "lifecycle-state":
      return rehydrateLifecycleState(toConstructorInput(decoded.value));
    case "execution-attempt":
      return createExecutionAttempt(toConstructorInput(decoded.value));
    case "exchange-order":
      return createExchangeOrder(toConstructorInput(decoded.value));
    case "reconciliation-result":
      return rehydrateReconciliationResult(toConstructorInput(decoded.value));
    case "fill":
      return createFill(toConstructorInput(decoded.value));
    case "fee":
      return createFee(toConstructorInput(decoded.value));
    case "funding":
      return createFunding(toConstructorInput(decoded.value));
    case "ledger-entry":
      return createLedgerEntry(toConstructorInput(decoded.value));
    case "clearance-evidence":
      return createClearanceEvidence(toConstructorInput(decoded.value));
  }
}
