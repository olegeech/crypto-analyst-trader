import {
  canonicalSerialize,
  hashCanonical,
  type PlanHash,
} from "../identity/canonical-serialization.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { domainError } from "../shared/errors.js";
import { fail, ok, type Result } from "../shared/result.js";
import {
  parseUtcTimestamp,
  timestampToEpochMs,
  type UtcTimestamp,
} from "../shared/time.js";
import { isRecord, requireHash } from "../shared/validation.js";
import {
  createOperatorMainnetTestPlan,
  deriveOperatorMainnetTestSourceId,
  OPERATOR_MAINNET_TRADE_COMMAND_PLAN_SCHEMA_VERSION,
  OPERATOR_MAINNET_TRADE_COMMAND_POLICY_VERSION,
  rehydrateOperatorMainnetTestPlan,
  type OperatorMainnetTestPlan,
} from "./operator-mainnet-test-plan.js";
import {
  rehydrateOperatorMainnetTradeCommandReceipt,
  type OperatorMainnetTradeCommandReceipt,
} from "./operator-mainnet-trade-command-receipt.js";

export {
  createOperatorMainnetTradeCommandReceipt,
  rehydrateOperatorMainnetTradeCommandReceipt,
} from "./operator-mainnet-trade-command-receipt.js";
export type { OperatorMainnetTradeCommandReceipt } from "./operator-mainnet-trade-command-receipt.js";

export const OPERATOR_MAINNET_TRADE_COMMAND_BINDING_SCHEMA_VERSION =
  "operator-mainnet-trade-command-binding/v1" as const;

const PLAN_INPUT_FIELDS = [
  "receipt",
  "quote",
  "warningCodes",
  "constraints",
  "preparedAt",
] as const;
const BINDING_FIELDS = [
  "schemaVersion",
  "commandId",
  "receiptHash",
  "planHash",
  "planArtifactHash",
  "sourceId",
  "clientOrderId",
  "createPayloadHash",
  "acceptedAt",
  "expiresAt",
  "boundAt",
  "executionAuthority",
  "replayInputs",
  "contentHash",
] as const;

export interface OperatorMainnetTradeCommandPlan extends Omit<
  OperatorMainnetTestPlan,
  "tradeCommandReceipt"
> {
  readonly schemaVersion: typeof OPERATOR_MAINNET_TRADE_COMMAND_PLAN_SCHEMA_VERSION;
  readonly policyVersion: typeof OPERATOR_MAINNET_TRADE_COMMAND_POLICY_VERSION;
  readonly commandId: string;
  readonly commandReceiptHash: PlanHash;
  readonly commandAcceptedAt: UtcTimestamp;
  readonly commandExpiresAt: UtcTimestamp;
  readonly tradeCommandReceipt: OperatorMainnetTradeCommandReceipt;
}

export interface OperatorMainnetTradeCommandBinding {
  readonly schemaVersion: typeof OPERATOR_MAINNET_TRADE_COMMAND_BINDING_SCHEMA_VERSION;
  readonly commandId: string;
  readonly receiptHash: PlanHash;
  readonly planHash: PlanHash;
  readonly planArtifactHash: PlanHash;
  readonly sourceId: string;
  readonly clientOrderId: string;
  readonly createPayloadHash: PlanHash;
  readonly acceptedAt: UtcTimestamp;
  readonly expiresAt: UtcTimestamp;
  readonly boundAt: UtcTimestamp;
  /** Evidence only. This value is never a transport capability. */
  readonly executionAuthority: "none";
  readonly replayInputs: {
    readonly receipt: OperatorMainnetTradeCommandReceipt;
    readonly plan: OperatorMainnetTradeCommandPlan;
  };
  readonly contentHash: PlanHash;
}

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

function invalidBinding(message = "operator trade-command binding is invalid") {
  return fail(domainError("INVALID_VALUE", message));
}

export function createOperatorMainnetTradeCommandPlan(
  input: unknown,
): Result<OperatorMainnetTradeCommandPlan> {
  if (!exactRecord(input, PLAN_INPUT_FIELDS))
    return fail(
      domainError("INVALID_PLAN", "direct-command plan input is invalid"),
    );
  const receipt = rehydrateOperatorMainnetTradeCommandReceipt(input.receipt);
  const preparedAt = parseUtcTimestamp(input.preparedAt);
  if (!receipt.ok || !preparedAt.ok)
    return fail(
      domainError(
        "INVALID_PLAN",
        "a valid receipt and preparation time are required",
      ),
    );
  const base = createOperatorMainnetTestPlan({
    accountIdentityHash: receipt.value.accountIdentityHash,
    symbol: receipt.value.symbol,
    nonce: receipt.value.commandId,
    allocation: receipt.value.allocation,
    grossNotionalCap: receipt.value.grossNotionalCap,
    maxDeviationBps: receipt.value.maxDeviationBps,
    quote: input.quote,
    warningCodes: input.warningCodes,
    constraints: input.constraints,
    preparedAt: preparedAt.value,
  });
  if (!base.ok) return base as Result<OperatorMainnetTradeCommandPlan>;
  const {
    contentHash: _baseHash,
    schemaVersion: _baseSchemaVersion,
    policyVersion: _basePolicyVersion,
    ...basePayload
  } = base.value;
  void _baseHash;
  void _baseSchemaVersion;
  void _basePolicyVersion;
  const payload = {
    ...basePayload,
    schemaVersion: OPERATOR_MAINNET_TRADE_COMMAND_PLAN_SCHEMA_VERSION,
    policyVersion: OPERATOR_MAINNET_TRADE_COMMAND_POLICY_VERSION,
    commandId: receipt.value.commandId,
    commandReceiptHash: receipt.value.contentHash,
    commandAcceptedAt: receipt.value.acceptedAt,
    commandExpiresAt: receipt.value.expiresAt,
    tradeCommandReceipt: receipt.value,
  };
  const contentHash = hashCanonical(payload);
  if (!contentHash.ok) return contentHash;
  const plan = rehydrateOperatorMainnetTestPlan({
    ...payload,
    contentHash: contentHash.value,
  });
  return plan.ok
    ? ok(plan.value as unknown as OperatorMainnetTradeCommandPlan)
    : (plan as Result<OperatorMainnetTradeCommandPlan>);
}

export function rehydrateOperatorMainnetTradeCommandPlan(
  input: unknown,
): Result<OperatorMainnetTradeCommandPlan> {
  const plan = rehydrateOperatorMainnetTestPlan(input);
  return plan.ok &&
    plan.value.schemaVersion ===
      OPERATOR_MAINNET_TRADE_COMMAND_PLAN_SCHEMA_VERSION
    ? ok(plan.value as unknown as OperatorMainnetTradeCommandPlan)
    : fail(
        domainError(
          "INVALID_PLAN",
          "a valid v3 direct-command plan is required",
        ),
      );
}

function canonicalizeBinding(
  input: unknown,
): Result<OperatorMainnetTradeCommandBinding> {
  const inputFields = [
    "receipt",
    "plan",
    "createPayloadHash",
    "boundAt",
  ] as const;
  if (!exactRecord(input, inputFields)) return invalidBinding();
  const receipt = rehydrateOperatorMainnetTradeCommandReceipt(input.receipt);
  const plan = rehydrateOperatorMainnetTradeCommandPlan(input.plan);
  const createPayloadHash = requireHash(
    input.createPayloadHash,
    "createPayloadHash",
  );
  const boundAt = parseUtcTimestamp(input.boundAt);
  if (!receipt.ok || !plan.ok || !createPayloadHash.ok || !boundAt.ok)
    return invalidBinding(
      "binding requires a valid receipt, v3 plan, payload hash and time",
    );
  if (
    receipt.value.contentHash !== plan.value.commandReceiptHash ||
    receipt.value.commandId !== plan.value.commandId ||
    timestampToEpochMs(boundAt.value) <
      timestampToEpochMs(receipt.value.acceptedAt) ||
    timestampToEpochMs(boundAt.value) >=
      timestampToEpochMs(receipt.value.expiresAt)
  )
    return invalidBinding(
      "binding does not match its receipt or validity window",
    );
  const planHash = plan.value.contentHash;
  const planArtifactHash = hashCanonical(plan.value);
  const sourceId = deriveOperatorMainnetTestSourceId(planHash);
  if (!planArtifactHash.ok || !sourceId.ok)
    return invalidBinding("plan identity could not be derived");
  const payload = {
    schemaVersion: OPERATOR_MAINNET_TRADE_COMMAND_BINDING_SCHEMA_VERSION,
    commandId: receipt.value.commandId,
    receiptHash: receipt.value.contentHash,
    planHash,
    planArtifactHash: planArtifactHash.value,
    sourceId: sourceId.value,
    clientOrderId: plan.value.clientOrderId,
    createPayloadHash: createPayloadHash.value as PlanHash,
    acceptedAt: receipt.value.acceptedAt,
    expiresAt: receipt.value.expiresAt,
    boundAt: boundAt.value,
    executionAuthority: "none" as const,
    replayInputs: { receipt: receipt.value, plan: plan.value },
  };
  const contentHash = hashCanonical(payload);
  return contentHash.ok
    ? ok(deepFreeze({ ...payload, contentHash: contentHash.value }))
    : contentHash;
}

export function createOperatorMainnetTradeCommandBinding(
  input: unknown,
): Result<OperatorMainnetTradeCommandBinding> {
  return canonicalizeBinding(input);
}

export function rehydrateOperatorMainnetTradeCommandBinding(
  input: unknown,
): Result<OperatorMainnetTradeCommandBinding> {
  if (
    !exactRecord(input, BINDING_FIELDS) ||
    !exactRecord(input.replayInputs, ["receipt", "plan"])
  )
    return invalidBinding();
  const replayed = canonicalizeBinding({
    receipt: input.replayInputs.receipt,
    plan: input.replayInputs.plan,
    createPayloadHash: input.createPayloadHash,
    boundAt: input.boundAt,
  });
  const contentHash = requireHash(input.contentHash, "contentHash");
  if (
    !replayed.ok ||
    !contentHash.ok ||
    replayed.value.contentHash !== contentHash.value
  )
    return invalidBinding("binding identity differs from deterministic replay");
  const actualCanonical = canonicalSerialize(input);
  const expectedCanonical = canonicalSerialize(replayed.value);
  return actualCanonical.ok &&
    expectedCanonical.ok &&
    actualCanonical.value === expectedCanonical.value
    ? replayed
    : invalidBinding("binding differs from deterministic replay");
}

/** Validate one prospective submission; artifact lookup/replay remains valid after expiry. */
export function validateOperatorMainnetTradeCommandBinding(
  receiptInput: unknown,
  bindingInput: unknown,
  nowInput: unknown,
  expectedCreatePayloadHash?: unknown,
): Result<OperatorMainnetTradeCommandBinding> {
  const receipt = rehydrateOperatorMainnetTradeCommandReceipt(receiptInput);
  const binding = rehydrateOperatorMainnetTradeCommandBinding(bindingInput);
  const now = parseUtcTimestamp(nowInput);
  const expectedPayloadHash =
    expectedCreatePayloadHash === undefined
      ? undefined
      : requireHash(expectedCreatePayloadHash, "expectedCreatePayloadHash");
  if (
    !receipt.ok ||
    !binding.ok ||
    !now.ok ||
    (expectedPayloadHash !== undefined && !expectedPayloadHash.ok)
  )
    return invalidBinding("current receipt, binding and time are required");
  if (
    receipt.value.contentHash !== binding.value.receiptHash ||
    receipt.value.commandId !== binding.value.commandId ||
    (expectedPayloadHash !== undefined &&
      expectedPayloadHash.ok &&
      expectedPayloadHash.value !== binding.value.createPayloadHash)
  )
    return invalidBinding(
      "binding does not match the current receipt or CREATE payload",
    );
  if (
    timestampToEpochMs(now.value) < timestampToEpochMs(binding.value.boundAt) ||
    timestampToEpochMs(now.value) <
      timestampToEpochMs(receipt.value.acceptedAt) ||
    timestampToEpochMs(now.value) >= timestampToEpochMs(receipt.value.expiresAt)
  )
    return fail(
      domainError(
        "PLAN_EXPIRED",
        "direct-command binding is outside its submission window",
      ),
    );
  return binding;
}
