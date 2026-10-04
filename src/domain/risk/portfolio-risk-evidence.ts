import {
  accountEvidenceContentHash,
  createAccountEvidenceBundle,
  type AccountEvidenceEnvironment,
  type AccountPositionEvidence,
} from "../account/account-evidence-bundle.js";
import { hashCanonical } from "../identity/canonical-serialization.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { DecimalValue, isDecimalValue } from "../shared/decimal.js";
import { domainError } from "../shared/errors.js";
import { fail, ok, type Result } from "../shared/result.js";
import {
  parseUtcTimestamp,
  timestampToEpochMs,
  type UtcTimestamp,
} from "../shared/time.js";
import {
  isRecord,
  requireHash,
  requireIdentifier,
} from "../shared/validation.js";
import {
  createPortfolioRiskPolicy,
  type PortfolioRiskPolicy,
} from "./portfolio-risk-policy.js";

export const PORTFOLIO_RISK_EVIDENCE_SCHEMA_VERSION =
  "portfolio-risk-evidence/v1" as const;

export interface PortfolioRiskLeverageRow {
  readonly positionIdx: number;
  readonly side: "Buy" | "Sell" | "None";
  readonly size: DecimalValue;
  /** Null records a valid provider row that omitted leverage. */
  readonly leverage: DecimalValue | null;
}

export interface PortfolioRiskEvidence {
  readonly schemaVersion: typeof PORTFOLIO_RISK_EVIDENCE_SCHEMA_VERSION;
  readonly kind: "target-leverage";
  readonly environment: AccountEvidenceEnvironment;
  readonly accountIdentityHash: string;
  readonly accountEvidenceHash: string;
  readonly symbol: string;
  readonly observedAt: UtcTimestamp;
  readonly rows: readonly PortfolioRiskLeverageRow[];
  readonly contentHash: string;
}

export interface ValidatedPortfolioRiskLeverageEvidence {
  readonly evidence: PortfolioRiskEvidence;
  readonly leverage: DecimalValue;
}

const evidenceKeys = [
  "schemaVersion",
  "kind",
  "environment",
  "accountIdentityHash",
  "accountEvidenceHash",
  "symbol",
  "observedAt",
  "rows",
  "contentHash",
] as const;
const payloadKeys = evidenceKeys.filter((key) => key !== "contentHash");
const environments = ["demo", "testnet", "mainnet"] as const;
const sides = ["Buy", "Sell", "None"] as const;
const MAX_ROWS = 10;
const MAX_DECIMAL_LENGTH = 128;

function invalid(
  message = "portfolio risk evidence is invalid",
): Result<never> {
  return fail(domainError("INVALID_EVIDENCE", message));
}

function conflict(
  message = "supplemental leverage conflicts with account evidence",
): Result<never> {
  return fail(domainError("INCOMPATIBLE_EVIDENCE", message));
}

function hasPlainDataProperties(value: object): boolean {
  return (
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) =>
      Object.hasOwn(descriptor, "value"),
    )
  );
}

function decimal(value: unknown, positive = false): Result<DecimalValue> {
  if (
    !isDecimalValue(value) &&
    (typeof value !== "string" || value.length > MAX_DECIMAL_LENGTH)
  )
    return invalid();
  const parsed = isDecimalValue(value)
    ? ok(value)
    : DecimalValue.fromString(value);
  if (
    !parsed.ok ||
    parsed.value.isNegative() ||
    (positive && !parsed.value.isPositive())
  )
    return invalid();
  return parsed;
}

function parseRow(value: unknown): Result<PortfolioRiskLeverageRow> {
  if (
    !isRecord(value) ||
    !hasPlainDataProperties(value) ||
    Reflect.ownKeys(value).length !== 4 ||
    Reflect.ownKeys(value).some(
      (key) =>
        typeof key !== "string" ||
        !["positionIdx", "side", "size", "leverage"].includes(key),
    )
  )
    return invalid();
  const { positionIdx, side } = value;
  if (
    typeof positionIdx !== "number" ||
    !Number.isSafeInteger(positionIdx) ||
    ![0, 1, 2].includes(positionIdx) ||
    typeof side !== "string" ||
    !sides.includes(side as (typeof sides)[number])
  )
    return invalid();
  const size = decimal(value.size);
  const leverage =
    value.leverage === null ? ok(null) : decimal(value.leverage, true);
  if (!size.ok || !leverage.ok) return invalid();
  return ok({
    positionIdx,
    side: side as PortfolioRiskLeverageRow["side"],
    size: size.value,
    leverage: leverage.value,
  });
}

function parseRows(
  value: unknown,
): Result<readonly PortfolioRiskLeverageRow[]> {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_ROWS ||
    Reflect.ownKeys(value).length !== value.length + 1 ||
    Object.values(Object.getOwnPropertyDescriptors(value)).some(
      (descriptor) => !Object.hasOwn(descriptor, "value"),
    )
  )
    return invalid("supplemental position rows are missing or invalid");
  const rows: PortfolioRiskLeverageRow[] = [];
  const indices = new Set<number>();
  for (const raw of value) {
    const row = parseRow(raw);
    if (!row.ok || indices.has(row.value.positionIdx))
      return invalid("supplemental position rows are duplicate or invalid");
    indices.add(row.value.positionIdx);
    rows.push(row.value);
  }
  rows.sort((left, right) => left.positionIdx - right.positionIdx);
  return ok(deepFreeze(rows));
}

function parsePayload(
  input: unknown,
): Result<Omit<PortfolioRiskEvidence, "contentHash">> {
  if (
    !isRecord(input) ||
    !hasPlainDataProperties(input) ||
    Reflect.ownKeys(input).length !== payloadKeys.length ||
    Reflect.ownKeys(input).some(
      (key) => typeof key !== "string" || !payloadKeys.includes(key as never),
    )
  )
    return invalid();
  const environment = input.environment;
  const accountIdentityHash = requireHash(
    input.accountIdentityHash,
    "accountIdentityHash",
  );
  const accountEvidenceHash = requireHash(
    input.accountEvidenceHash,
    "accountEvidenceHash",
  );
  const symbol = requireIdentifier(input.symbol, "symbol");
  const observedAt = parseUtcTimestamp(input.observedAt);
  const rows = parseRows(input.rows);
  if (
    input.schemaVersion !== PORTFOLIO_RISK_EVIDENCE_SCHEMA_VERSION ||
    input.kind !== "target-leverage" ||
    typeof environment !== "string" ||
    !environments.includes(environment as (typeof environments)[number]) ||
    !accountIdentityHash.ok ||
    !accountEvidenceHash.ok ||
    !symbol.ok ||
    !observedAt.ok ||
    !rows.ok
  )
    return invalid();
  return ok({
    schemaVersion: PORTFOLIO_RISK_EVIDENCE_SCHEMA_VERSION,
    kind: "target-leverage",
    environment: environment as AccountEvidenceEnvironment,
    accountIdentityHash: accountIdentityHash.value,
    accountEvidenceHash: accountEvidenceHash.value,
    symbol: symbol.value,
    observedAt: observedAt.value,
    rows: rows.value,
  });
}

export function portfolioRiskEvidenceContentHash(
  evidence: PortfolioRiskEvidence,
): Result<string> {
  const { contentHash: _contentHash, ...payload } = evidence;
  void _contentHash;
  return hashCanonical(payload);
}

/** Creates or rehydrates closed-schema evidence, verifying a supplied hash. */
export function createPortfolioRiskEvidence(
  input: unknown,
): Result<PortfolioRiskEvidence> {
  if (
    !isRecord(input) ||
    !hasPlainDataProperties(input) ||
    (Reflect.ownKeys(input).length !== payloadKeys.length &&
      Reflect.ownKeys(input).length !== evidenceKeys.length) ||
    Reflect.ownKeys(input).some(
      (key) => typeof key !== "string" || !evidenceKeys.includes(key as never),
    )
  )
    return invalid();
  const payload = parsePayload(
    Object.fromEntries(payloadKeys.map((key) => [key, input[key]])),
  );
  if (!payload.ok) return payload;
  const hash = hashCanonical(payload.value);
  if (!hash.ok) return invalid();
  if (Object.hasOwn(input, "contentHash")) {
    const suppliedHash = requireHash(input.contentHash, "contentHash");
    if (!suppliedHash.ok) return invalid();
    if (suppliedHash.value !== hash.value)
      return fail(
        domainError(
          "PLAN_HASH_MISMATCH",
          "portfolio risk evidence hash does not match its payload",
        ),
      );
  }
  return ok(deepFreeze({ ...payload.value, contentHash: hash.value }));
}

/** Canonical list identity rejects duplicate account/environment/symbol entries. */
export function createPortfolioRiskEvidenceSet(
  input: unknown,
): Result<readonly PortfolioRiskEvidence[]> {
  if (
    !Array.isArray(input) ||
    input.length > 100 ||
    Reflect.ownKeys(input).length !== input.length + 1 ||
    Object.values(Object.getOwnPropertyDescriptors(input)).some(
      (descriptor) => !Object.hasOwn(descriptor, "value"),
    )
  )
    return invalid();
  const evidence: PortfolioRiskEvidence[] = [];
  const identities = new Set<string>();
  for (const raw of input) {
    const parsed = createPortfolioRiskEvidence(raw);
    if (!parsed.ok) return parsed;
    const identity = [
      parsed.value.environment,
      parsed.value.accountIdentityHash,
      parsed.value.symbol,
    ].join("\u0000");
    if (identities.has(identity))
      return invalid("duplicate supplemental account/symbol evidence");
    identities.add(identity);
    evidence.push(parsed.value);
  }
  evidence.sort((left, right) =>
    `${left.environment}\u0000${left.accountIdentityHash}\u0000${left.symbol}`.localeCompare(
      `${right.environment}\u0000${right.accountIdentityHash}\u0000${right.symbol}`,
    ),
  );
  return ok(deepFreeze(evidence));
}

function knownDecimal(
  fact: AccountPositionEvidence["size"],
): DecimalValue | null {
  return fact.state === "known" ? fact.value : null;
}

export function validatePortfolioRiskLeverageEvidence(
  evidenceInput: unknown,
  accountInput: unknown,
  options: {
    readonly expectedSymbol: string;
    readonly evaluationTime: string;
    readonly policy: PortfolioRiskPolicy;
  },
): Result<ValidatedPortfolioRiskLeverageEvidence> {
  if (
    !isRecord(options) ||
    !hasPlainDataProperties(options) ||
    Reflect.ownKeys(options).length !== 3 ||
    Reflect.ownKeys(options).some(
      (key) =>
        typeof key !== "string" ||
        !["expectedSymbol", "evaluationTime", "policy"].includes(key),
    )
  )
    return invalid("supplemental leverage admission options are invalid");
  const evidence = createPortfolioRiskEvidence(evidenceInput);
  const account = createAccountEvidenceBundle(accountInput);
  const policy = createPortfolioRiskPolicy(options.policy);
  const evaluationTime = parseUtcTimestamp(options.evaluationTime);
  const expectedSymbol = requireIdentifier(options.expectedSymbol, "symbol");
  if (
    !evidence.ok ||
    !account.ok ||
    !policy.ok ||
    !evaluationTime.ok ||
    !expectedSymbol.ok
  )
    return invalid("supplemental leverage admission input is invalid");

  const bundle = account.value;
  const currentTimeMs = timestampToEpochMs(evaluationTime.value);
  const accountEndedAt = bundle.collectionEndedAt;
  if (
    bundle.collectionStatus !== "complete" ||
    !bundle.consistency.complete ||
    bundle.criticalPasses.B === null ||
    bundle.bundleCutoff === null ||
    accountEndedAt === null ||
    bundle.consistency.marginCompatibility !== "regular-margin" ||
    bundle.criticalPasses.B.account.marginMode.state !== "known" ||
    bundle.criticalPasses.B.account.marginMode.value !== "REGULAR_MARGIN"
  )
    return conflict("account evidence is not complete risk-eligible evidence");

  const accountHash = accountEvidenceContentHash(bundle);
  if (
    !accountHash.ok ||
    evidence.value.accountEvidenceHash !== accountHash.value ||
    evidence.value.accountIdentityHash !==
      bundle.accountBinding.accountIdentityHash ||
    evidence.value.environment !== bundle.accountBinding.environment ||
    evidence.value.symbol !== expectedSymbol.value ||
    !bundle.configuredM1Symbols.includes(expectedSymbol.value)
  )
    return conflict(
      "supplemental evidence identity does not match account scope",
    );

  const accountAgeMs = currentTimeMs - timestampToEpochMs(accountEndedAt);
  const observationTimeMs = timestampToEpochMs(evidence.value.observedAt);
  const observationAgeMs = currentTimeMs - observationTimeMs;
  if (
    accountAgeMs < 0 ||
    accountAgeMs > policy.value.maxAccountEvidenceAgeMs ||
    observationAgeMs < 0 ||
    observationAgeMs > policy.value.maxAccountEvidenceAgeMs
  )
    return fail(
      domainError(
        "STALE_EVIDENCE",
        "supplemental leverage observation is future or outside the freshness window",
      ),
    );

  const mode = bundle.consistency.positionModes.find(
    (item) => item.symbol === expectedSymbol.value,
  );
  if (mode?.mode !== "one-way")
    return conflict("target position mode is not proven one-way");

  const symbolPositions = bundle.criticalPasses.B.positions.filter(
    (position) => position.symbol === expectedSymbol.value,
  );
  if (symbolPositions.some((position) => position.category !== "linear"))
    return conflict(
      "target symbol has unsupported derivative category evidence",
    );
  if (symbolPositions.length > 1)
    return conflict("pass-B target position rows are contradictory");
  const existing = symbolPositions[0];
  if (existing) {
    const size = knownDecimal(existing.size);
    if (
      existing.positionIdx !== 0 ||
      existing.side !== "None" ||
      size === null ||
      existing.size.unit !== "contracts" ||
      !size.isZero()
    )
      return conflict("pass-B target is not proven flat and one-way");
    if (existing.leverage.state === "known")
      return conflict(
        "supplemental evidence cannot override known pass-B leverage",
      );
  }

  if (evidence.value.rows.length !== 1)
    return conflict(
      "supplemental evidence must contain one target position row",
    );
  const row = evidence.value.rows[0];
  if (
    !row ||
    row.positionIdx !== 0 ||
    row.side !== "None" ||
    !row.size.isZero() ||
    row.leverage === null ||
    !row.leverage.isPositive()
  )
    return conflict(
      "supplemental observation does not prove a flat target leverage",
    );
  if (
    existing &&
    (existing.positionIdx !== row.positionIdx ||
      existing.side !== row.side ||
      existing.size.state !== "known" ||
      existing.size.value.compare(row.size) !== 0)
  )
    return conflict("supplemental target state changed from pass B");

  return ok({ evidence: evidence.value, leverage: row.leverage });
}
