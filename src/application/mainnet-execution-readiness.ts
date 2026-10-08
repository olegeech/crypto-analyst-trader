import {
  accountEvidenceContentHash,
  createAccountEvidenceCollectionResult,
  type AccountEvidenceBundle,
  type AccountEvidenceCollectionResult,
} from "../domain/account/account-evidence-bundle.js";
import {
  accountEvidencePartitionKey,
  type AccountEvidencePartition,
} from "../domain/account/account-evidence-policy.js";
import type { AccountEvidenceFailureCode } from "../domain/account/account-evidence-diagnostics.js";
import { createInstrumentConstraints } from "../domain/market/instrument-constraints.js";
import { isPlanningSymbol } from "../domain/planning/decision-policy.js";
import { isRecord, requireIdentifier } from "../domain/shared/validation.js";
import {
  parseUtcTimestamp,
  timestampToEpochMs,
  type UtcTimestamp,
} from "../domain/shared/time.js";
import type { BybitInstrumentInfo } from "../adapters/bybit-v5/read-mappers.js";
import { BYBIT_MAINNET_ORIGIN } from "../adapters/bybit-v5/origins.js";
import { BYBIT_MAINNET_CAPABILITY_PROFILE } from "../adapters/bybit-v5/capability-profile.js";
import {
  PROVISIONAL_M1_MAX_ACCOUNT_EVIDENCE_AGE_MS,
  PROVISIONAL_M1_POLICY_VERSION,
} from "./policies/provisional-m1.js";

const INVALID_TIMESTAMP = "1970-01-01T00:00:00.000Z" as UtcTimestamp;

export const MAINNET_EXECUTION_READINESS_VERSION =
  "mainnet-execution-readiness/v1" as const;

export const MAINNET_EXECUTION_READINESS_REASONS = Object.freeze([
  "INVALID_REQUEST",
  "PRE_AUTH_FAILURE",
  "ACCOUNT_EVIDENCE_INVALID",
  "ACCOUNT_EVIDENCE_FAILED",
  "ACCOUNT_ENVIRONMENT_MISMATCH",
  "ACCOUNT_ORIGIN_MISMATCH",
  "ACCOUNT_EVIDENCE_TIME_UNAVAILABLE",
  "ACCOUNT_EVIDENCE_STALE",
  "KEY_EXPIRED",
  "CRITICAL_STATE_CHANGED",
  "CRITICAL_STATE_UNPROVEN",
  "ACCOUNT_MODE_UNKNOWN",
  "ACCOUNT_MODE_UNSUPPORTED",
  "SPOT_HEDGING_ENABLED",
  "READ_ONLY_KEY",
  "CONTRACT_ORDER_PERMISSION_MISSING",
  "CONTRACT_POSITION_PERMISSION_MISSING",
  "WITHDRAW_PERMISSION_ENABLED",
  "TRANSFER_WRITE_AUTHORITY",
  "TARGET_SYMBOL_UNCONFIGURED",
  "TARGET_POSITION_MODE_UNKNOWN",
  "TARGET_HEDGE_MODE_UNSUPPORTED",
  "REQUIRED_PARTITION_MISSING",
  "REQUIRED_PARTITION_INCOMPLETE",
  "COVERAGE_ATTRIBUTION_UNKNOWN",
  "DISCOVERY_SCOPE_UNPROVEN",
  "ACCOUNT_EVIDENCE_INCOMPLETE_UNATTRIBUTED",
  "ACCOUNT_EVIDENCE_CONTRADICTORY",
  "ACCOUNT_EVIDENCE_RECONCILIATION_MISMATCH",
  "ACCOUNT_EVIDENCE_UNSUPPORTED_FACT",
  "ACCOUNT_EVIDENCE_PROVIDER_FACT_INVALID",
  "INSTRUMENT_UNAVAILABLE",
  "INSTRUMENT_SYMBOL_MISMATCH",
  "INSTRUMENT_UNSUPPORTED",
] as const);
export type MainnetExecutionReadinessReason =
  (typeof MAINNET_EXECUTION_READINESS_REASONS)[number];

export type MainnetExecutionReadinessWarning =
  "API_KEY_IP_UNBOUND" | "UNRELATED_ACCOUNT_COVERAGE_INCOMPLETE";

export interface MainnetExecutionReadiness {
  readonly schemaVersion: typeof MAINNET_EXECUTION_READINESS_VERSION;
  readonly verdict: "READY" | "BLOCKED";
  readonly evaluatedAt: UtcTimestamp;
  readonly environment: "mainnet";
  readonly symbol: string;
  readonly policyVersion: typeof PROVISIONAL_M1_POLICY_VERSION;
  readonly capabilityProfile: {
    readonly version: typeof BYBIT_MAINNET_CAPABILITY_PROFILE.version;
    readonly adapter: typeof BYBIT_MAINNET_CAPABILITY_PROFILE.adapter;
    readonly status: "SUPPORTED";
    readonly liveProof: "not-established";
  };
  /** Internal binding only; the operator renderer must never print these hashes. */
  readonly internalBinding?: {
    readonly accountIdentityHash: string;
    readonly accountEvidenceHash: string;
  };
  readonly accountEvidenceAgeMs?: number;
  readonly unrelatedCoverageGapCount: number;
  readonly reasonCodes: readonly MainnetExecutionReadinessReason[];
  readonly providerReasonCodes: readonly AccountEvidenceFailureCode[];
  readonly warningCodes: readonly MainnetExecutionReadinessWarning[];
}

export interface MainnetExecutionReadinessInput {
  readonly accountResult: AccountEvidenceCollectionResult;
  readonly symbol: string;
  readonly instrument: BybitInstrumentInfo | null;
  readonly evaluatedAt: UtcTimestamp;
}

const mainnetOrigin = BYBIT_MAINNET_ORIGIN;
const supportedUtaStatuses = new Set([5, 6]);
const requiredAccountEndpoints = new Set([
  "account-info",
  "wallet",
  "collateral",
]);

function closedPlainRecord(
  input: unknown,
  keys: readonly string[],
): input is Record<string, unknown> {
  if (
    !isRecord(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
    Reflect.ownKeys(input).length !== keys.length ||
    Reflect.ownKeys(input).some(
      (key) => typeof key !== "string" || !keys.includes(key),
    )
  )
    return false;
  return Object.values(Object.getOwnPropertyDescriptors(input)).every(
    (descriptor) => Object.hasOwn(descriptor, "value"),
  );
}

function isTerminalCoverage(
  entry: AccountEvidenceBundle["coverage"][number] | undefined,
): boolean {
  return (
    entry !== undefined &&
    entry.status === "traversed" &&
    entry.reasonCodes.length === 0 &&
    entry.pages >= 1 &&
    entry.startedAt !== null &&
    entry.endedAt !== null
  );
}

function requiresExecutionProof(
  partition: AccountEvidencePartition,
  symbol: string,
): boolean {
  if (
    (partition.pass === "A" || partition.pass === "B") &&
    requiredAccountEndpoints.has(partition.endpoint)
  )
    return true;
  if (
    (partition.pass === "A" || partition.pass === "B") &&
    partition.endpoint === "mode-probe" &&
    partition.symbol === symbol
  )
    return true;
  if (
    (partition.pass === "A" || partition.pass === "B") &&
    partition.category === "linear" &&
    (partition.endpoint === "positions" || partition.endpoint === "open-orders")
  )
    return true;
  return (
    partition.pass === "auxiliary" &&
    partition.category === "linear" &&
    (partition.endpoint === "order-history" ||
      partition.endpoint === "executions")
  );
}

function attributableUnrelatedGap(
  partition: AccountEvidencePartition,
  targetSymbol: string,
): boolean {
  if (
    partition.pass === "auxiliary" &&
    (partition.category === "spot" ||
      partition.category === "inverse" ||
      partition.category === "option")
  )
    return true;
  return (
    (partition.pass === "A" || partition.pass === "B") &&
    partition.endpoint === "mode-probe" &&
    partition.symbol !== null &&
    partition.symbol !== targetSymbol
  );
}

function pushMappedConsistencyReasons(
  reasons: Set<MainnetExecutionReadinessReason>,
  bundle: AccountEvidenceBundle,
): void {
  for (const code of bundle.consistency.reasonCodes) {
    switch (code) {
      case "CRITICAL_STATE_CHANGED":
        reasons.add("CRITICAL_STATE_CHANGED");
        break;
      case "CONTRADICTORY_OBSERVATION":
        reasons.add("ACCOUNT_EVIDENCE_CONTRADICTORY");
        break;
      case "RECONCILIATION_MISMATCH":
        reasons.add("ACCOUNT_EVIDENCE_RECONCILIATION_MISMATCH");
        break;
      case "UNSUPPORTED_CAPABILITY":
        reasons.add("ACCOUNT_EVIDENCE_UNSUPPORTED_FACT");
        break;
      case "TIER_INVALID":
        reasons.add("ACCOUNT_EVIDENCE_PROVIDER_FACT_INVALID");
        break;
      case "COVERAGE_INCOMPLETE":
      case "MODE_UNKNOWN":
      case "MODE_UNSUPPORTED":
        break;
    }
  }
}

function validateInstrument(
  instrument: BybitInstrumentInfo,
  symbol: string,
  reasons: Set<MainnetExecutionReadinessReason>,
): void {
  if (instrument.symbol !== symbol) {
    reasons.add("INSTRUMENT_SYMBOL_MISMATCH");
    return;
  }
  if (
    !isRecord(instrument.constraints) ||
    Object.values(
      Object.getOwnPropertyDescriptors(instrument.constraints),
    ).some((descriptor) => !Object.hasOwn(descriptor, "value"))
  ) {
    reasons.add("INSTRUMENT_UNAVAILABLE");
    return;
  }
  const constraints = createInstrumentConstraints(instrument.constraints);
  if (!constraints.ok || constraints.value.instrument !== symbol) {
    reasons.add("INSTRUMENT_UNAVAILABLE");
    return;
  }
  if (
    instrument.status !== "Trading" ||
    instrument.contractType !== "LinearPerpetual" ||
    instrument.quoteCoin !== "USDT" ||
    instrument.settleCoin !== "USDT"
  )
    reasons.add("INSTRUMENT_UNSUPPORTED");
}

function checkRequiredPartitions(
  bundle: AccountEvidenceBundle,
  symbol: string,
  reasons: Set<MainnetExecutionReadinessReason>,
): void {
  for (const partition of bundle.expectedPartitions) {
    if (!requiresExecutionProof(partition, symbol)) continue;
    const key = accountEvidencePartitionKey(partition);
    const entry = bundle.coverage.find(
      (coverage) => accountEvidencePartitionKey(coverage.partition) === key,
    );
    if (entry === undefined) {
      reasons.add("REQUIRED_PARTITION_MISSING");
    } else if (!isTerminalCoverage(entry)) {
      reasons.add("REQUIRED_PARTITION_INCOMPLETE");
    }
  }
}

function checkCoverageAttribution(
  bundle: AccountEvidenceBundle,
  symbol: string,
  reasons: Set<MainnetExecutionReadinessReason>,
  warnings: Set<MainnetExecutionReadinessWarning>,
): number {
  const gaps = bundle.coverage.filter((entry) => !isTerminalCoverage(entry));
  if (gaps.length === 0) {
    if (bundle.consistency.reasonCodes.includes("COVERAGE_INCOMPLETE"))
      reasons.add("ACCOUNT_EVIDENCE_INCOMPLETE_UNATTRIBUTED");
    return 0;
  }

  let unrelatedCount = 0;
  for (const entry of gaps) {
    if (requiresExecutionProof(entry.partition, symbol)) continue;
    if (!attributableUnrelatedGap(entry.partition, symbol)) {
      reasons.add("COVERAGE_ATTRIBUTION_UNKNOWN");
      continue;
    }
    unrelatedCount += 1;
  }

  if (unrelatedCount > 0) warnings.add("UNRELATED_ACCOUNT_COVERAGE_INCOMPLETE");
  if (
    bundle.consistency.reasonCodes.includes("COVERAGE_INCOMPLETE") &&
    unrelatedCount !== gaps.length
  )
    reasons.add("ACCOUNT_EVIDENCE_INCOMPLETE_UNATTRIBUTED");
  return unrelatedCount;
}

function checkDiscovery(
  bundle: AccountEvidenceBundle,
  reasons: Set<MainnetExecutionReadinessReason>,
): void {
  const discovery = bundle.discovery;
  if (
    discovery === null ||
    discovery.uncoveredScopes ||
    discovery.upgradeOverlap ||
    discovery.separateInverseWallet
  )
    reasons.add("DISCOVERY_SCOPE_UNPROVEN");
}

function checkCoverageDiagnostics(
  bundle: AccountEvidenceBundle,
  symbol: string,
  reasons: Set<MainnetExecutionReadinessReason>,
): void {
  const unrelatedGapCodes = new Set(
    bundle.coverage
      .filter(
        (entry) =>
          !isTerminalCoverage(entry) &&
          attributableUnrelatedGap(entry.partition, symbol) &&
          !requiresExecutionProof(entry.partition, symbol),
      )
      .flatMap((entry) => entry.reasonCodes),
  );
  for (const diagnostic of bundle.diagnostics) {
    if (diagnostic.severity !== "error") continue;
    if (diagnostic.scope !== "coverage") {
      reasons.add("ACCOUNT_EVIDENCE_INCOMPLETE_UNATTRIBUTED");
      continue;
    }
    if (!unrelatedGapCodes.has(diagnostic.code))
      reasons.add("ACCOUNT_EVIDENCE_INCOMPLETE_UNATTRIBUTED");
  }
  if (
    bundle.diagnostics.some(
      (diagnostic) =>
        diagnostic.scope === "coverage" &&
        !unrelatedGapCodes.has(diagnostic.code),
    )
  )
    reasons.add("ACCOUNT_EVIDENCE_INCOMPLETE_UNATTRIBUTED");
}

function checkAccountFacts(
  bundle: AccountEvidenceBundle,
  symbol: string,
  evaluatedAt: UtcTimestamp,
  reasons: Set<MainnetExecutionReadinessReason>,
  warnings: Set<MainnetExecutionReadinessWarning>,
): void {
  const { A, B } = bundle.criticalPasses;
  if (A === null || B === null) {
    reasons.add("CRITICAL_STATE_UNPROVEN");
    return;
  }

  if (bundle.consistency.structuralComparison === "changed")
    reasons.add("CRITICAL_STATE_CHANGED");
  else if (bundle.consistency.structuralComparison !== "unchanged")
    reasons.add("CRITICAL_STATE_UNPROVEN");

  for (const pass of [A, B]) {
    const margin = pass.account.marginMode;
    if (margin.state !== "known") reasons.add("ACCOUNT_MODE_UNKNOWN");
    else if (margin.value !== "REGULAR_MARGIN")
      reasons.add("ACCOUNT_MODE_UNSUPPORTED");

    const uta = pass.account.utaStatus;
    if (uta.state !== "known") reasons.add("ACCOUNT_MODE_UNKNOWN");
    else if (!supportedUtaStatuses.has(uta.value))
      reasons.add("ACCOUNT_MODE_UNSUPPORTED");

    const spotHedging = pass.account.spotHedging;
    if (spotHedging.state !== "known") reasons.add("ACCOUNT_MODE_UNKNOWN");
    else if (spotHedging.value) reasons.add("SPOT_HEDGING_ENABLED");

    const probe = pass.modeProbes.find((item) => item.symbol === symbol);
    if (!probe || probe.positionIndices.length === 0)
      reasons.add("TARGET_POSITION_MODE_UNKNOWN");
    else if (
      probe.positionIndices.length !== 1 ||
      probe.positionIndices[0] !== 0
    )
      reasons.add("TARGET_HEDGE_MODE_UNSUPPORTED");
  }

  const posture = bundle.credentialPosture;
  if (posture.readOnly) reasons.add("READ_ONLY_KEY");
  if (!posture.permissions.contractOrder)
    reasons.add("CONTRACT_ORDER_PERMISSION_MISSING");
  if (!posture.permissions.contractPosition)
    reasons.add("CONTRACT_POSITION_PERMISSION_MISSING");
  if (posture.permissions.withdraw) reasons.add("WITHDRAW_PERMISSION_ENABLED");
  if (posture.permissions.walletTransfer)
    reasons.add("TRANSFER_WRITE_AUTHORITY");
  if (!posture.ipBound) warnings.add("API_KEY_IP_UNBOUND");
  if (
    posture.expiresAt !== null &&
    timestampToEpochMs(posture.expiresAt) <= timestampToEpochMs(evaluatedAt)
  )
    reasons.add("KEY_EXPIRED");

  for (const reconciliation of bundle.consistency.reconciliation) {
    if (
      reconciliation.margin !== "passed" ||
      (bundle.criticalPasses[reconciliation.pass]?.totals.equityBasis ===
        "usd-equity" &&
        reconciliation.equity !== "passed")
    )
      reasons.add("CRITICAL_STATE_UNPROVEN");
  }

  const collateralEligibleCoins = new Set(
    [...A.assets, ...B.assets]
      .filter(
        (asset) =>
          asset.collateralEligible.state === "known" &&
          asset.collateralEligible.value,
      )
      .map((asset) => asset.coin),
  );
  const tierCoins = new Set(bundle.auxiliary.tiers.map((tier) => tier.coin));
  if ([...collateralEligibleCoins].some((coin) => !tierCoins.has(coin)))
    reasons.add("ACCOUNT_EVIDENCE_INCOMPLETE_UNATTRIBUTED");
}

function result(input: {
  readonly symbol: string;
  readonly evaluatedAt: UtcTimestamp;
  readonly reasons: ReadonlySet<MainnetExecutionReadinessReason>;
  readonly warnings: ReadonlySet<MainnetExecutionReadinessWarning>;
  readonly providerReasonCodes?: readonly AccountEvidenceFailureCode[];
  readonly internalBinding?: MainnetExecutionReadiness["internalBinding"];
  readonly accountEvidenceAgeMs?: number;
  readonly unrelatedCoverageGapCount?: number;
}): MainnetExecutionReadiness {
  const profile = {
    version: BYBIT_MAINNET_CAPABILITY_PROFILE.version,
    adapter: BYBIT_MAINNET_CAPABILITY_PROFILE.adapter,
    status: "SUPPORTED" as const,
    liveProof: "not-established" as const,
  };
  return Object.freeze({
    schemaVersion: MAINNET_EXECUTION_READINESS_VERSION,
    verdict: input.reasons.size === 0 ? "READY" : "BLOCKED",
    evaluatedAt: input.evaluatedAt,
    environment: "mainnet",
    symbol: input.symbol,
    policyVersion: PROVISIONAL_M1_POLICY_VERSION,
    capabilityProfile: Object.freeze(profile),
    ...(input.internalBinding === undefined
      ? {}
      : { internalBinding: Object.freeze(input.internalBinding) }),
    ...(input.accountEvidenceAgeMs === undefined
      ? {}
      : { accountEvidenceAgeMs: input.accountEvidenceAgeMs }),
    unrelatedCoverageGapCount: input.unrelatedCoverageGapCount ?? 0,
    reasonCodes: Object.freeze([...input.reasons].sort()),
    providerReasonCodes: Object.freeze(
      [...new Set(input.providerReasonCodes ?? [])].sort(),
    ),
    warningCodes: Object.freeze([...input.warnings].sort()),
  });
}

/** Derives an ephemeral Mainnet readiness verdict only from validated evidence. */
export function deriveMainnetExecutionReadiness(
  input: unknown,
): MainnetExecutionReadiness {
  const reasons = new Set<MainnetExecutionReadinessReason>();
  const warnings = new Set<MainnetExecutionReadinessWarning>();
  if (
    !closedPlainRecord(input, [
      "accountResult",
      "symbol",
      "instrument",
      "evaluatedAt",
    ])
  ) {
    return result({
      symbol: "unknown",
      evaluatedAt: INVALID_TIMESTAMP,
      reasons: new Set(["INVALID_REQUEST"]),
      warnings,
    });
  }

  const symbol = requireIdentifier(input.symbol, "symbol");
  const evaluatedAt = parseUtcTimestamp(input.evaluatedAt);
  if (!symbol.ok || !isPlanningSymbol(symbol.value) || !evaluatedAt.ok) {
    reasons.add("INVALID_REQUEST");
    return result({
      symbol: symbol.ok ? symbol.value : "unknown",
      evaluatedAt: evaluatedAt.ok ? evaluatedAt.value : INVALID_TIMESTAMP,
      reasons,
      warnings,
    });
  }

  const collection = createAccountEvidenceCollectionResult(input.accountResult);
  if (!collection.ok) {
    reasons.add("ACCOUNT_EVIDENCE_INVALID");
    return result({
      symbol: symbol.value,
      evaluatedAt: evaluatedAt.value,
      reasons,
      warnings,
    });
  }
  if (collection.value.kind === "pre-auth-failure") {
    reasons.add("PRE_AUTH_FAILURE");
    return result({
      symbol: symbol.value,
      evaluatedAt: evaluatedAt.value,
      reasons,
      warnings,
      providerReasonCodes: collection.value.reasonCodes,
    });
  }

  const bundle = collection.value.bundle;
  const bundleHash = accountEvidenceContentHash(bundle);
  if (!bundleHash.ok) {
    reasons.add("ACCOUNT_EVIDENCE_INVALID");
    return result({
      symbol: symbol.value,
      evaluatedAt: evaluatedAt.value,
      reasons,
      warnings,
    });
  }
  const internalBinding = {
    accountIdentityHash: bundle.accountBinding.accountIdentityHash,
    accountEvidenceHash: bundleHash.value,
  };
  if (bundle.accountBinding.exchange !== "bybit")
    reasons.add("ACCOUNT_EVIDENCE_INVALID");
  if (bundle.accountBinding.environment !== "mainnet")
    reasons.add("ACCOUNT_ENVIRONMENT_MISMATCH");
  if (bundle.accountBinding.origin !== mainnetOrigin)
    reasons.add("ACCOUNT_ORIGIN_MISMATCH");
  if (bundle.collectionStatus === "failed")
    reasons.add("ACCOUNT_EVIDENCE_FAILED");

  if (!bundle.configuredM1Symbols.includes(symbol.value))
    reasons.add("TARGET_SYMBOL_UNCONFIGURED");

  const collectionEndedAt = bundle.collectionEndedAt;
  let accountEvidenceAgeMs: number | undefined;
  if (collectionEndedAt === null) {
    reasons.add("ACCOUNT_EVIDENCE_TIME_UNAVAILABLE");
  } else {
    accountEvidenceAgeMs =
      timestampToEpochMs(evaluatedAt.value) -
      timestampToEpochMs(collectionEndedAt);
    if (
      accountEvidenceAgeMs < 0 ||
      accountEvidenceAgeMs > PROVISIONAL_M1_MAX_ACCOUNT_EVIDENCE_AGE_MS
    )
      reasons.add("ACCOUNT_EVIDENCE_STALE");
  }

  if (input.instrument === null) {
    reasons.add("INSTRUMENT_UNAVAILABLE");
  } else if (
    closedPlainRecord(input.instrument, [
      "symbol",
      "status",
      "contractType",
      "quoteCoin",
      "settleCoin",
      "constraints",
    ])
  ) {
    validateInstrument(
      input.instrument as unknown as BybitInstrumentInfo,
      symbol.value,
      reasons,
    );
  } else {
    reasons.add("INSTRUMENT_UNAVAILABLE");
  }

  checkRequiredPartitions(bundle, symbol.value, reasons);
  const unrelatedCoverageGapCount = checkCoverageAttribution(
    bundle,
    symbol.value,
    reasons,
    warnings,
  );
  checkCoverageDiagnostics(bundle, symbol.value, reasons);
  checkDiscovery(bundle, reasons);
  checkAccountFacts(bundle, symbol.value, evaluatedAt.value, reasons, warnings);
  pushMappedConsistencyReasons(reasons, bundle);

  return result({
    symbol: symbol.value,
    evaluatedAt: evaluatedAt.value,
    reasons,
    warnings,
    internalBinding,
    ...(accountEvidenceAgeMs === undefined ? {} : { accountEvidenceAgeMs }),
    unrelatedCoverageGapCount,
  });
}
