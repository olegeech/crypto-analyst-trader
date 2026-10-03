import { canonicalSerialize } from "../identity/canonical-serialization.js";
import { DecimalValue } from "../shared/decimal.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import type { AccountEvidenceFailureCode } from "./account-evidence-diagnostics.js";
import {
  ACCOUNT_EVIDENCE_COLLECTION_POLICY as policy,
  accountEvidencePartitionKey,
  deriveExpectedAccountEvidencePartitions,
  type AccountEvidenceEndpoint,
  type AccountEvidencePartition,
  type AccountEvidenceCategory,
} from "./account-evidence-policy.js";
import type {
  AccountCollateralTierEvidence,
  AccountCriticalPass,
  AccountEvidenceDecimalFact,
  AccountEvidenceFact,
  AccountEvidencePayload,
  AccountPositionModeProbe,
} from "./account-evidence-bundle.js";

export interface AccountEvidenceConsistency {
  readonly model: "bounded-sandwich/v1";
  readonly atomicSnapshot: false;
  readonly eventVisibility: "provider-delayed-and-native-selection-clock";
  readonly retiredScopeVisibility: "provider-catalogue-limited";
  readonly complete: boolean;
  readonly structuralComparison: "unchanged" | "changed" | "unestablished";
  readonly marginCompatibility: "regular-margin" | "unsupported" | "unknown";
  readonly positionModes: readonly {
    readonly symbol: string;
    readonly mode: "one-way" | "hedge" | "unknown";
  }[];
  readonly reconciliation: readonly {
    readonly pass: "A" | "B";
    readonly margin: "passed" | "mismatch" | "unestablished";
    readonly equity: "passed" | "mismatch" | "unestablished";
  }[];
  readonly reasonCodes: readonly AccountEvidenceFailureCode[];
}
export function proveAccountPositionMode(
  probe: AccountPositionModeProbe | undefined,
): "one-way" | "hedge" | "unknown" {
  if (!probe || probe.positionIndices.length === 0) return "unknown";
  const indices = new Set(probe.positionIndices);
  if ([...indices].some((index) => index !== 0 && index !== 1 && index !== 2))
    return "unknown";
  if (indices.size === 1 && indices.has(0)) return "one-way";
  return indices.has(0) ? "unknown" : "hedge";
}
const equal = (left: unknown, right: unknown): boolean => {
  const a = canonicalSerialize(left),
    b = canonicalSerialize(right);
  return a.ok && b.ok && a.value === b.value;
};
function projection(pass: AccountCriticalPass): unknown {
  const project = (record: object, fields: readonly string[]) => {
    const result: Record<string, unknown> = {};
    for (const key of fields)
      result[key] = (record as Record<string, unknown>)[key];
    return result;
  };
  return {
    account: project(pass.account, policy.criticalStructuralFields.account),
    assets: pass.assets.map((value) =>
      project(value, policy.criticalStructuralFields.assets),
    ),
    collateral: pass.collateral.map((value) =>
      project(value, policy.criticalStructuralFields.collateral),
    ),
    positions: pass.positions.map((value) =>
      project(value, policy.criticalStructuralFields.positions),
    ),
    orders: pass.orders.map((value) =>
      project(value, policy.criticalStructuralFields.orders),
    ),
    modeProbes: pass.modeProbes,
  };
}
function known<T>(
  fact: AccountEvidenceFact<T>,
): fact is { readonly state: "known"; readonly value: T } {
  return fact.state === "known";
}
function structuralEstablished(pass: AccountCriticalPass): boolean {
  const groupFields = policy.criticalStructuralFields;
  for (const group of [
    "account",
    "assets",
    "collateral",
    "positions",
    "orders",
  ] as const) {
    const rows: readonly object[] =
      group === "account" ? [pass.account] : pass[group];
    for (const row of rows)
      for (const field of groupFields[group]) {
        const value = (row as Record<string, unknown>)[field];
        if (
          value &&
          typeof value === "object" &&
          "state" in value &&
          value.state === "unavailable"
        )
          return false;
      }
  }
  // These facts are mandatory in regular margin; N/A cannot manufacture their presence.
  if (
    !known(pass.account.marginMode) ||
    !known(pass.account.utaStatus) ||
    !known(pass.account.spotHedging)
  )
    return false;
  for (const asset of pass.assets)
    if (
      ![
        asset.walletBalance,
        asset.locked,
        asset.bonus,
        asset.borrowAmount,
        asset.spotBorrow,
        asset.accruedInterest,
        asset.collateralEligible,
        asset.collateralSwitch,
        asset.restricted,
      ].every((value) => value.state === "known")
    )
      return false;
  for (const position of pass.positions)
    if (!known(position.size) || !known(position.avgPrice)) return false;
  for (const order of pass.orders)
    if (
      ![order.price, order.qty, order.cumExecQty, order.leavesQty].every(known)
    )
      return false;
  return true;
}
export function compareAccountCriticalPasses(
  a: AccountCriticalPass | null,
  b: AccountCriticalPass | null,
): "unchanged" | "changed" | "unestablished" {
  if (!a || !b || !structuralEstablished(a) || !structuralEstablished(b))
    return "unestablished";
  return equal(projection(a), projection(b)) ? "unchanged" : "changed";
}
export function reconcileAccountUsd(
  actual: AccountEvidenceDecimalFact,
  terms: readonly AccountEvidenceDecimalFact[],
): "passed" | "mismatch" | "unestablished" {
  if (
    actual.unit !== "USD" ||
    !known(actual) ||
    terms.length === 0 ||
    terms.some((term) => term.unit !== "USD" || !known(term))
  )
    return "unestablished";
  const zero = DecimalValue.fromString("0"),
    tolerance = DecimalValue.fromString(
      policy.reconciliationUsdAbsoluteTolerance,
    );
  if (!zero.ok || !tolerance.ok) return "unestablished";
  let sum = zero.value;
  for (const term of terms) if (known(term)) sum = sum.add(term.value);
  const difference = actual.value.subtract(sum);
  const absolute = difference.isNegative()
    ? zero.value.subtract(difference)
    : difference;
  return absolute.compare(tolerance.value) <= 0 ? "passed" : "mismatch";
}
export function validateAccountCollateralTiers(
  tiers: readonly AccountCollateralTierEvidence[],
): boolean {
  const zero = DecimalValue.fromString("0"),
    one = DecimalValue.fromString("1");
  if (!zero.ok || !one.ok) return false;
  const groups = new Map<string, AccountCollateralTierEvidence[]>();
  for (const tier of tiers) {
    if (
      !known(tier.minQty) ||
      (tier.maxQty !== null && !known(tier.maxQty)) ||
      !known(tier.collateralRatio) ||
      tier.minQty.value.isNegative() ||
      tier.collateralRatio.value.compare(zero.value) < 0 ||
      tier.collateralRatio.value.compare(one.value) > 0 ||
      (tier.maxQty !== null &&
        known(tier.maxQty) &&
        tier.maxQty.value.compare(tier.minQty.value) <= 0)
    )
      return false;
    const rows = groups.get(tier.coin) ?? [];
    rows.push(tier);
    groups.set(tier.coin, rows);
  }
  for (const rows of groups.values()) {
    rows.sort((a, b) =>
      known(a.minQty) && known(b.minQty)
        ? a.minQty.value.compare(b.minQty.value)
        : 0,
    );
    for (let i = 1; i < rows.length; i++) {
      const previous = rows[i - 1],
        current = rows[i];
      if (
        !previous ||
        !current ||
        previous.maxQty === null ||
        !known(previous.maxQty) ||
        !known(current.minQty) ||
        previous.maxQty.value.compare(current.minQty.value) > 0
      )
        return false;
    }
  }
  return true;
}
function crossEndpointAgreement(pass: AccountCriticalPass): boolean {
  for (const asset of pass.assets) {
    const collateral = pass.collateral.find((row) => row.coin === asset.coin);
    if (!collateral) return false;
    for (const field of [
      "collateralEligible",
      "collateralSwitch",
      "restricted",
    ] as const) {
      const left = asset[field],
        right = collateral[field];
      if (known(left) && known(right) && left.value !== right.value)
        return false;
    }
  }
  return true;
}
export function evaluateAccountEvidenceConsistency(
  payload: AccountEvidencePayload,
): AccountEvidenceConsistency {
  const reasons = new Set<AccountEvidenceFailureCode>();
  const add = (code: AccountEvidenceFailureCode) => reasons.add(code);
  const { A, B } = payload.criticalPasses;
  // Native enum values remain facts; only supported values can establish completeness.
  const supported = (value: unknown, values: readonly unknown[]) =>
    values.includes(value);
  const supportedFact = <T>(
    fact: AccountEvidenceFact<T>,
    values: readonly unknown[],
  ) => !known(fact) || supported(fact.value, values);
  for (const pass of [A, B]) {
    if (!pass) continue;
    if (
      known(pass.account.utaStatus) &&
      !supported(pass.account.utaStatus.value, policy.nativeEnums.utaStatus)
    )
      add("UNSUPPORTED_CAPABILITY");
    if (
      known(pass.account.marginMode) &&
      pass.account.marginMode.value !== policy.supportedMarginMode
    )
      add("MODE_UNSUPPORTED");
    for (const probe of pass.modeProbes)
      if (
        probe.positionIndices.some(
          (index) => !supported(index, policy.nativeEnums.positionIdx),
        )
      )
        add("UNSUPPORTED_CAPABILITY");
    for (const position of pass.positions)
      if (
        !supported(position.category, ["linear", "inverse", "option"]) ||
        !supported(position.side, policy.nativeEnums.positionSide) ||
        !supported(position.positionIdx, policy.nativeEnums.positionIdx) ||
        !supportedFact(position.tradeMode, policy.nativeEnums.tradeMode)
      )
        add("UNSUPPORTED_CAPABILITY");
  }
  for (const order of [
    ...(A?.orders ?? []),
    ...(B?.orders ?? []),
    ...payload.auxiliary.orders,
  ]) {
    if (
      !supported(order.category, policy.categories) ||
      !supported(order.status, policy.nativeEnums.orderStatus) ||
      !supported(order.side, policy.nativeEnums.side) ||
      !supported(order.orderType, policy.nativeEnums.orderType) ||
      (known(order.positionIdx) &&
        !supported(order.positionIdx.value, policy.nativeEnums.positionIdx))
    )
      add("UNSUPPORTED_CAPABILITY");
    for (const field of [
      "triggerDirection",
      "triggerBy",
      "tpslMode",
      "timeInForce",
      "orderFilter",
      "stopOrderType",
    ] as const)
      if (
        !supportedFact<string | number>(order[field], policy.nativeEnums[field])
      )
        add("UNSUPPORTED_CAPABILITY");
  }
  for (const execution of payload.auxiliary.executions)
    if (
      !supported(execution.category, policy.categories) ||
      !supported(execution.side, policy.nativeEnums.side) ||
      !supported(execution.execType, policy.nativeEnums.execType)
    )
      add("UNSUPPORTED_CAPABILITY");
  const comparison = compareAccountCriticalPasses(A, B);
  if (comparison === "changed") add("CRITICAL_STATE_CHANGED");
  if (comparison === "unestablished") add("COVERAGE_INCOMPLETE");
  const margin = A?.account.marginMode;
  const marginCompatibility =
    !margin || !known(margin)
      ? "unknown"
      : margin.value === "REGULAR_MARGIN"
        ? "regular-margin"
        : "unsupported";
  if (marginCompatibility !== "regular-margin")
    add(
      marginCompatibility === "unknown" ? "MODE_UNKNOWN" : "MODE_UNSUPPORTED",
    );
  const positionModes = payload.configuredM1Symbols.map((symbol) => {
    const first = proveAccountPositionMode(
      A?.modeProbes.find((probe) => probe.symbol === symbol),
    );
    const second = proveAccountPositionMode(
      B?.modeProbes.find((probe) => probe.symbol === symbol),
    );
    let mode = first === second ? first : "unknown";
    for (const pass of [A, B])
      if (
        pass?.positions.some(
          (position) =>
            position.category === "linear" &&
            position.symbol === symbol &&
            ((mode === "one-way" && position.positionIdx !== 0) ||
              (mode === "hedge" && position.positionIdx === 0)),
        )
      )
        mode = "unknown";
    if (mode !== "one-way")
      add(mode === "hedge" ? "MODE_UNSUPPORTED" : "MODE_UNKNOWN");
    return { symbol, mode };
  });
  if (payload.configuredM1Symbols.length === 0) add("MODE_UNKNOWN");
  const reconciliation: AccountEvidenceConsistency["reconciliation"][number][] =
    [];
  for (const [label, pass] of [
    ["A", A],
    ["B", B],
  ] as const) {
    if (!pass) continue;
    if (!crossEndpointAgreement(pass)) add("CONTRADICTORY_OBSERVATION");
    const marginCheck =
      known(pass.account.marginMode) &&
      pass.account.marginMode.value === "REGULAR_MARGIN"
        ? reconcileAccountUsd(pass.totals.totalMarginBalance, [
            pass.totals.totalWalletBalance,
            pass.totals.totalPerpUPL,
          ])
        : "unestablished";
    const equityCheck =
      pass.totals.equityBasis === "usd-equity"
        ? reconcileAccountUsd(
            pass.totals.totalEquity,
            pass.assets.map((asset) => asset.usdEquity),
          )
        : "unestablished";
    if (marginCheck === "mismatch" || equityCheck === "mismatch")
      add("RECONCILIATION_MISMATCH");
    if (
      marginCheck === "unestablished" &&
      known(pass.account.marginMode) &&
      pass.account.marginMode.value === "REGULAR_MARGIN"
    )
      add("COVERAGE_INCOMPLETE");
    if (
      pass.totals.equityBasis === "usd-equity" &&
      equityCheck === "unestablished"
    )
      add("COVERAGE_INCOMPLETE");
    reconciliation.push({
      pass: label,
      margin: marginCheck,
      equity: equityCheck,
    });
  }
  if (!validateAccountCollateralTiers(payload.auxiliary.tiers))
    add("TIER_INVALID");
  for (const pass of [A, B])
    for (const asset of pass?.assets ?? [])
      if (
        known(asset.collateralEligible) &&
        asset.collateralEligible.value &&
        !payload.auxiliary.tiers.some((tier) => tier.coin === asset.coin)
      )
        add("COVERAGE_INCOMPLETE");
  const discovery = payload.discovery;
  if (!discovery) add("COVERAGE_INCOMPLETE");
  else {
    const expected = deriveExpectedAccountEvidencePartitions(
      payload.configuredM1Symbols,
      discovery,
    );
    const keys = (
      items: readonly {
        partition: Parameters<typeof accountEvidencePartitionKey>[0];
      }[],
    ) =>
      items.map((item) => accountEvidencePartitionKey(item.partition)).sort();
    const expectedKeys = expected.map(accountEvidencePartitionKey).sort();
    if (
      !equal(
        expectedKeys,
        payload.expectedPartitions.map(accountEvidencePartitionKey).sort(),
      ) ||
      !equal(expectedKeys, keys(payload.coverage))
    )
      add("COVERAGE_INCOMPLETE");
    const settlements = new Set([
      ...policy.initialSettlementCoins,
      ...discovery.settlementCoins,
    ]);
    const bases = new Set([
      ...discovery.optionBaseCoins,
      ...discovery.exposureOptionBaseCoins,
    ]);
    if (
      discovery.passBSettlementCoins.some((coin) => !settlements.has(coin)) ||
      discovery.passBOptionBaseCoins.some((coin) => !bases.has(coin))
    )
      add("CRITICAL_STATE_CHANGED");
    if (
      discovery.uncoveredScopes ||
      discovery.upgradeOverlap ||
      discovery.separateInverseWallet
    )
      add("COVERAGE_INCOMPLETE");
  }
  const observations = [
    ...(A?.observations ?? []),
    ...(B?.observations ?? []),
    ...payload.auxiliary.observations,
  ];
  for (const pass of ["A", "B", "auxiliary"] as const) {
    const group =
      pass === "A"
        ? (A?.observations ?? [])
        : pass === "B"
          ? (B?.observations ?? [])
          : payload.auxiliary.observations;
    if (group.some((obs) => obs.partition.pass !== pass))
      add("INVALID_RESPONSE");
  }
  const observationByPartition = new Map<
    string,
    (typeof observations)[number]
  >();
  for (const observation of observations) {
    const key = accountEvidencePartitionKey(observation.partition);
    if (!observationByPartition.has(key))
      observationByPartition.set(key, observation);
  }
  const coveredPartitions = new Set(
    payload.coverage.map((entry) =>
      accountEvidencePartitionKey(entry.partition),
    ),
  );
  for (const entry of payload.coverage) {
    if (
      entry.status !== "traversed" ||
      entry.reasonCodes.length > 0 ||
      entry.pages < 1 ||
      entry.startedAt === null ||
      entry.endedAt === null
    )
      add("COVERAGE_INCOMPLETE");
    if (entry.pages > policy.maxPagesPerPartition) add("PAGE_BUDGET_EXCEEDED");
    const obs = observationByPartition.get(
      accountEvidencePartitionKey(entry.partition),
    );
    if (
      !obs ||
      obs.startedAt !== entry.startedAt ||
      obs.endedAt !== entry.endedAt
    )
      add("COVERAGE_INCOMPLETE");
    if (
      entry.startedAt &&
      entry.endedAt &&
      Date.parse(entry.startedAt) > Date.parse(entry.endedAt)
    )
      add("INVALID_RESPONSE");
  }
  if (
    observations.some(
      (obs) =>
        !coveredPartitions.has(accountEvidencePartitionKey(obs.partition)),
    )
  )
    add("COVERAGE_INCOMPLETE");
  // Counts describe raw returned rows and may exceed deduplicated retained facts,
  // but cannot be smaller. Aggregate where retained facts lack settlement/base.
  const count = (
    endpoint: AccountEvidenceEndpoint,
    pass: AccountEvidencePartition["pass"],
    category?: AccountEvidenceCategory,
    symbol?: string,
  ) =>
    payload.coverage
      .filter(
        (entry) =>
          entry.partition.endpoint === endpoint &&
          entry.partition.pass === pass &&
          (category === undefined || entry.partition.category === category) &&
          (symbol === undefined || entry.partition.symbol === symbol),
      )
      .reduce((sum, entry) => sum + entry.rows, 0);
  const requireRows = (observed: number, retained: number) => {
    if (observed < retained) add("CONTRADICTORY_OBSERVATION");
  };
  for (const [label, pass] of [
    ["A", A],
    ["B", B],
  ] as const) {
    if (!pass) continue;
    requireRows(count("account-info", label), 1);
    requireRows(count("wallet", label), Math.max(1, pass.assets.length));
    requireRows(count("collateral", label), pass.collateral.length);
    for (const probe of pass.modeProbes)
      requireRows(
        count("mode-probe", label, "linear", probe.symbol),
        probe.positionIndices.length,
      );
    for (const category of policy.categories) {
      requireRows(
        count("positions", label, category),
        pass.positions.filter((row) => row.category === category).length,
      );
      requireRows(
        count("open-orders", label, category),
        pass.orders.filter((row) => row.category === category).length,
      );
    }
  }
  requireRows(count("tiers", "auxiliary"), payload.auxiliary.tiers.length);
  if (discovery) {
    requireRows(
      count("settlement-discovery", "auxiliary"),
      discovery.settlementCoins.length,
    );
    requireRows(
      count("option-base-discovery", "auxiliary"),
      discovery.optionBaseCoins.length,
    );
  }
  for (const category of policy.categories) {
    requireRows(
      count("order-history", "auxiliary", category),
      payload.auxiliary.orders.filter((row) => row.category === category)
        .length,
    );
    requireRows(
      count("executions", "auxiliary", category),
      payload.auxiliary.executions.filter((row) => row.category === category)
        .length,
    );
  }
  const start = payload.collectionStartedAt,
    end = payload.collectionEndedAt,
    cutoff = payload.bundleCutoff,
    window = payload.historyWindow;
  if (!start || !end || !cutoff || !window) add("COVERAGE_INCOMPLETE");
  else {
    if (
      Date.parse(start) > Date.parse(cutoff) ||
      Date.parse(cutoff) > Date.parse(end) ||
      window.endedAt !== cutoff ||
      Date.parse(cutoff) - Date.parse(window.startedAt) !==
        policy.historyWindowMs
    )
      add("INVALID_RESPONSE");
    if (
      observations.some(
        (obs) =>
          Date.parse(obs.exchangeResponseTime) < Date.parse(start) ||
          Date.parse(obs.exchangeResponseTime) > Date.parse(end) ||
          Date.parse(obs.startedAt) > Date.parse(obs.endedAt) ||
          Date.parse(obs.startedAt) < Date.parse(payload.startedAt) ||
          Date.parse(obs.endedAt) > Date.parse(payload.endedAt),
      )
    )
      add("INVALID_RESPONSE");
    if (
      A?.observations.some(
        (obs) => Date.parse(obs.exchangeResponseTime) > Date.parse(cutoff),
      ) ||
      B?.observations.some(
        (obs) => Date.parse(obs.exchangeResponseTime) < Date.parse(cutoff),
      )
    )
      add("INVALID_RESPONSE");
    if (
      payload.auxiliary.executions.some(
        (exec) =>
          Date.parse(exec.execTime) < Date.parse(window.startedAt) ||
          Date.parse(exec.execTime) > Date.parse(cutoff),
      )
    )
      add("COVERAGE_INCOMPLETE");
  }
  // A parent absent from bounded history is not itself a contradiction.
  const parents = new Map<string, (typeof payload.auxiliary.orders)[number]>();
  for (const order of payload.auxiliary.orders) {
    const key = JSON.stringify([order.category, order.orderId]);
    if (!parents.has(key)) parents.set(key, order);
  }
  for (const execution of payload.auxiliary.executions) {
    const parent = parents.get(
      JSON.stringify([execution.category, execution.orderId]),
    );
    if (
      parent &&
      (parent.symbol !== execution.symbol || parent.side !== execution.side)
    )
      add("CONTRADICTORY_OBSERVATION");
  }
  const budget = payload.budget;
  if (budget.monotonicDurationMs > policy.maxCollectionDurationMs)
    add("COLLECTION_DEADLINE_EXCEEDED");
  if (budget.httpAttempts > policy.maxHttpAttempts)
    add("ATTEMPT_BUDGET_EXCEEDED");
  if (budget.retainedRows > policy.maxRetainedRows) add("ROW_BUDGET_EXCEEDED");
  if (budget.maxObservedResponseBytes > policy.maxResponseBytes)
    add("RESPONSE_BYTE_LIMIT_EXCEEDED");
  if (
    budget.httpAttempts <
    payload.coverage.reduce((sum, entry) => sum + entry.pages, 0)
  )
    add("COVERAGE_INCOMPLETE");
  const rows =
    (A
      ? 2 +
        A.assets.length +
        A.collateral.length +
        A.positions.length +
        A.orders.length +
        A.modeProbes.length
      : 0) +
    (B
      ? 2 +
        B.assets.length +
        B.collateral.length +
        B.positions.length +
        B.orders.length +
        B.modeProbes.length
      : 0) +
    payload.auxiliary.tiers.length +
    payload.auxiliary.orders.length +
    payload.auxiliary.executions.length;
  if (budget.retainedRows < rows || rows > policy.maxRetainedRows)
    add("ROW_BUDGET_EXCEEDED");
  for (const diagnostic of payload.diagnostics)
    if (diagnostic.severity === "error") add(diagnostic.code);
  return deepFreeze({
    model: "bounded-sandwich/v1",
    atomicSnapshot: false,
    eventVisibility: "provider-delayed-and-native-selection-clock",
    retiredScopeVisibility: "provider-catalogue-limited",
    complete: reasons.size === 0,
    structuralComparison: comparison,
    marginCompatibility,
    positionModes,
    reconciliation,
    reasonCodes: [...reasons].sort(),
  });
}
