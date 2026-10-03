import {
  ACCOUNT_EVIDENCE_SCHEMA_VERSION,
  createAccountEvidenceBundle,
  createAccountEvidenceCollectionResult,
  createAccountCriticalPass,
  type AccountBinding,
  type AccountCredentialPosture,
  type AccountCriticalPass,
  type AccountEndpointObservation,
  type AccountEvidenceBundle,
  type AccountEvidenceCollectionResult,
  type AccountEvidenceEnvironment,
  type AccountEvidencePayload,
  type AccountEvidenceCoverageEntry,
} from "../domain/account/account-evidence-bundle.js";
import {
  ACCOUNT_EVIDENCE_COLLECTION_POLICY as policy,
  ACCOUNT_EVIDENCE_POLICY_VERSION,
  accountEvidencePolicyHash,
  accountEvidencePartitionKey,
  deriveExpectedAccountEvidencePartitions,
  type AccountEvidenceDiscovery,
  type AccountEvidencePartition,
} from "../domain/account/account-evidence-policy.js";
import type {
  AccountEvidenceDiagnostic,
  AccountEvidenceFailureCode,
} from "../domain/account/account-evidence-diagnostics.js";
import {
  deriveAccountEvidenceCollectionStatus,
  countAccountEvidenceRows,
} from "../domain/account/account-evidence-consistency.js";
import { canonicalSerialize } from "../domain/identity/canonical-serialization.js";
import { isRecord, requireIdentifier } from "../domain/shared/validation.js";
import {
  timestampFromEpochMs,
  type UtcTimestamp,
} from "../domain/shared/time.js";
import type {
  CredentialProvider,
  ExchangeCredentials,
} from "../ports/credential-provider.js";
import type {
  AccountEvidenceReadPort,
  AccountPartitionRead,
  AccountReadEnvelope,
  AccountReadWindow,
} from "../ports/account-evidence.js";
import {
  BybitAccountReadTransport,
  BybitAccountReadError,
  ACCOUNT_READ_ORIGINS,
  type AccountReadBudget,
} from "../adapters/bybit-v5/account-read-transport.js";
import {
  BybitAccountReadClient,
  accountReadFailureCode,
} from "../adapters/bybit-v5/account-read-client.js";
import { mapAccountReadIdentity } from "../adapters/bybit-v5/account-key-mapper.js";
import {
  mapAccountInfo,
  mapAccountWallet,
  mapAccountCollateral,
  mapAccountPositions,
  mapAccountOrders,
  mapAccountExecutions,
  mapAccountTiers,
} from "../adapters/bybit-v5/account-read-mappers.js";

export interface AccountEvidenceCollectionOptions {
  readonly environment: AccountEvidenceEnvironment;
  readonly runId: string;
  readonly configuredM1Symbols: readonly string[];
  readonly credentialLoader: Pick<CredentialProvider, "load">;
  readonly utcClock?: () => number;
  readonly monotonicClock?: () => number;
  readonly createReadPort?: (options: {
    environment: AccountEvidenceEnvironment;
    credentials: ExchangeCredentials;
    budget: AccountReadBudget;
    utcClock: () => number;
    monotonicClock: () => number;
  }) => AccountEvidenceReadPort;
}
function timestamp(value: number): UtcTimestamp {
  const parsed = timestampFromEpochMs(value);
  if (!parsed.ok) throw new BybitAccountReadError("INVALID_RESPONSE");
  return parsed.value;
}
function identifier(value: unknown): string {
  const parsed = requireIdentifier(value, "identifier");
  if (!parsed.ok) throw new BybitAccountReadError("INVALID_RESPONSE");
  return parsed.value;
}
function rows(
  response: AccountReadEnvelope,
): readonly Record<string, unknown>[] {
  const list = response.result.list;
  if (!Array.isArray(list) || list.some((row) => !isRecord(row)))
    throw new BybitAccountReadError("INVALID_RESPONSE");
  return list;
}
const unavailable = {
  state: "unavailable",
  reason: "collection-failed",
} as const;
function emptyPass(): {
  account: AccountCriticalPass["account"];
  totals: AccountCriticalPass["totals"];
  assets: AccountCriticalPass["assets"];
  collateral: AccountCriticalPass["collateral"];
  positions: AccountCriticalPass["positions"];
  orders: AccountCriticalPass["orders"];
  modeProbes: AccountCriticalPass["modeProbes"];
  observations: AccountCriticalPass["observations"];
} {
  const usd = { ...unavailable, unit: "USD" as const },
    rate = { ...unavailable, unit: "rate" as const };
  return {
    account: {
      utaStatus: unavailable,
      marginMode: unavailable,
      spotHedging: unavailable,
    },
    totals: {
      totalEquity: usd,
      totalWalletBalance: usd,
      totalMarginBalance: usd,
      totalPerpUPL: usd,
      totalAvailableBalance: usd,
      totalInitialMargin: usd,
      totalMaintenanceMargin: usd,
      accountIMRate: rate,
      accountMMRate: rate,
      equityBasis: "unestablished",
    },
    assets: [],
    collateral: [],
    positions: [],
    orders: [],
    modeProbes: [],
    observations: [],
  };
}
/** Identity is established before any other private account read. This boundary never writes or persists. */
export async function collectAccountEvidence(
  options: AccountEvidenceCollectionOptions,
): Promise<AccountEvidenceCollectionResult> {
  if (
    !Object.hasOwn(ACCOUNT_READ_ORIGINS, options.environment) ||
    !requireIdentifier(options.runId, "runId").ok ||
    !Array.isArray(options.configuredM1Symbols) ||
    options.configuredM1Symbols.length === 0 ||
    options.configuredM1Symbols.length > 100 ||
    options.configuredM1Symbols.some(
      (symbol) => !requireIdentifier(symbol, "symbol").ok,
    )
  )
    throw new BybitAccountReadError("INVALID_RESPONSE");
  const wall = options.utcClock ?? Date.now,
    mono = options.monotonicClock ?? (() => performance.now()),
    startedAt = timestamp(wall());
  let binding: AccountBinding | undefined,
    posture: AccountCredentialPosture | undefined;
  let initial: UtcTimestamp | null = null,
    cutoff: UtcTimestamp | null = null,
    closing: UtcTimestamp | null = null;
  let monotonicStart = 0,
    lastMonotonic = 0;
  const diagnostics: AccountEvidenceDiagnostic[] = [],
    coverage = new Map<string, AccountEvidenceCoverageEntry>(),
    observations = new Map<string, AccountEndpointObservation>();
  const critical: {
    A: AccountCriticalPass | null;
    B: AccountCriticalPass | null;
  } = { A: null, B: null };
  const auxiliary: {
    tiers: AccountEvidencePayload["auxiliary"]["tiers"];
    orders: AccountEvidencePayload["auxiliary"]["orders"];
    executions: AccountEvidencePayload["auxiliary"]["executions"];
  } = { tiers: [], orders: [], executions: [] };
  let discovery: AccountEvidenceDiscovery | null = null;
  let budget: AccountReadBudget = {
    deadline: 0,
    attempts: 0,
    maxAttempts: policy.maxHttpAttempts,
    maxResponseBytes: policy.maxResponseBytes,
    maxObservedResponseBytes: 0,
  };
  const diagnose = (
    code: AccountEvidenceFailureCode,
    scope: AccountEvidenceDiagnostic["scope"] = "collection",
  ) => {
    if (!diagnostics.some((d) => d.code === code && d.scope === scope))
      diagnostics.push({ code, severity: "error", scope });
  };
  const check = () => {
    const now = mono();
    if (!Number.isFinite(now) || now < lastMonotonic || now >= budget.deadline)
      throw new BybitAccountReadError("COLLECTION_DEADLINE_EXCEEDED");
    lastMonotonic = now;
    return now;
  };
  async function bounded<T>(action: () => Promise<T>): Promise<T> {
    const remaining = budget.deadline - check();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        action(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(new BybitAccountReadError("COLLECTION_DEADLINE_EXCEEDED")),
            Math.ceil(remaining),
          );
        }),
      ]);
      check();
      return result;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  function record(read: AccountPartitionRead): void {
    const key = accountEvidencePartitionKey(read.coverage.partition),
      previous = coverage.get(key);
    coverage.set(
      key,
      previous
        ? {
            ...read.coverage,
            pages: previous.pages + read.coverage.pages,
            rows: previous.rows + read.coverage.rows,
            startedAt: previous.startedAt,
            status:
              previous.status === "traversed"
                ? read.coverage.status
                : previous.status,
            reasonCodes: [
              ...new Set([
                ...previous.reasonCodes,
                ...read.coverage.reasonCodes,
              ]),
            ],
          }
        : read.coverage,
    );
    for (const reason of read.coverage.reasonCodes)
      diagnose(reason, "coverage");
    if (read.observation) {
      const old = observations.get(key);
      observations.set(
        key,
        old
          ? {
              ...read.observation,
              startedAt: old.startedAt,
              nativeRowTimes: [
                ...new Set([
                  ...old.nativeRowTimes,
                  ...read.observation.nativeRowTimes,
                ]),
              ].sort(),
            }
          : read.observation,
      );
    }
  }
  function invalidate(
    partition: AccountEvidencePartition,
    error: unknown,
  ): void {
    const code =
      error instanceof BybitAccountReadError ? error.code : "INVALID_RESPONSE";
    diagnose(code, "coverage");
    const key = accountEvidencePartitionKey(partition),
      old = coverage.get(key);
    if (old)
      coverage.set(key, {
        ...old,
        status: "failed",
        reasonCodes: [...new Set([...old.reasonCodes, code])],
      });
  }
  const partition = (
    endpoint: AccountEvidencePartition["endpoint"],
  ): AccountEvidencePartition => ({
    endpoint,
    pass: "auxiliary",
    category: null,
    settleCoin: null,
    baseCoin: null,
    symbol: null,
  });
  let readPort: AccountEvidenceReadPort;
  async function read(
    p: AccountEvidencePartition,
    window?: AccountReadWindow,
  ): Promise<AccountPartitionRead> {
    const value = await bounded(() => readPort.readPartition(p, window));
    record(value);
    return value;
  }
  function stopAfterTerminalBudget(value: AccountPartitionRead): void {
    for (const code of value.coverage.reasonCodes)
      if (
        [
          "COLLECTION_DEADLINE_EXCEEDED",
          "ATTEMPT_BUDGET_EXCEEDED",
          "ROW_BUDGET_EXCEEDED",
        ].includes(code)
      )
        throw new BybitAccountReadError(code);
  }
  async function discover(): Promise<{
    settlements: string[];
    bases: string[];
  }> {
    const settlements = new Set<string>(policy.initialSettlementCoins),
      bases = new Set<string>();
    for (const endpoint of [
      "settlement-discovery",
      "option-base-discovery",
    ] as const) {
      const p = partition(endpoint),
        result = await read(p);
      try {
        const identities = new Map<string, string>();
        for (const response of result.responses)
          for (const row of rows(response)) {
            if (endpoint === "settlement-discovery") {
              const symbol = identifier(row.symbol),
                coin = identifier(row.settleCoin),
                previous = identities.get(symbol);
              if (previous && previous !== coin)
                throw new BybitAccountReadError("CONTRADICTORY_OBSERVATION");
              identities.set(symbol, coin);
              settlements.add(coin);
            } else {
              const base = identifier(row.baseCoin);
              if (![0, 1, "0", "1"].includes(row.hasSymbol as never))
                throw new BybitAccountReadError("INVALID_RESPONSE");
              bases.add(base);
            }
          }
      } catch (error) {
        invalidate(p, error);
      }
      stopAfterTerminalBudget(result);
    }
    return { settlements: [...settlements].sort(), bases: [...bases].sort() };
  }
  function unique<T>(values: readonly T[], key: (value: T) => string): T[] {
    const map = new Map<string, { value: T; serialized: string }>();
    for (const value of values) {
      const serialized = canonicalSerialize(value);
      if (!serialized.ok) throw new BybitAccountReadError("INVALID_RESPONSE");
      const identity = key(value),
        old = map.get(identity);
      if (old && old.serialized !== serialized.value)
        throw new BybitAccountReadError("CONTRADICTORY_OBSERVATION");
      map.set(identity, { value, serialized: serialized.value });
    }
    return [...map.values()].map((v) => v.value);
  }
  async function criticalPass(pass: "A" | "B"): Promise<AccountCriticalPass> {
    const output = emptyPass();
    if (!discovery) throw new BybitAccountReadError("INVALID_RESPONSE");
    try {
      for (const p of deriveExpectedAccountEvidencePartitions(
        options.configuredM1Symbols,
        discovery,
      ).filter((p) => p.pass === pass)) {
        const result = await read(p);
        try {
          for (const response of result.responses) {
            switch (p.endpoint) {
              case "account-info":
                output.account = mapAccountInfo(response);
                break;
              case "wallet": {
                const wallet = mapAccountWallet(response);
                output.assets = wallet.assets;
                output.totals = wallet.totals;
                break;
              }
              case "collateral":
                output.collateral = mapAccountCollateral(response);
                break;
              case "positions":
                output.positions = unique(
                  [
                    ...output.positions,
                    ...mapAccountPositions(response, p.category!),
                  ],
                  (v) => JSON.stringify([v.category, v.symbol, v.positionIdx]),
                );
                break;
              case "open-orders":
                output.orders = unique(
                  [
                    ...output.orders,
                    ...mapAccountOrders(response, p.category!),
                  ],
                  (v) => JSON.stringify([v.category, v.orderId]),
                );
                break;
              case "mode-probe": {
                const positions = mapAccountPositions(response, "linear");
                if (positions.some((position) => position.symbol !== p.symbol))
                  throw new BybitAccountReadError("INVALID_RESPONSE");
                const old = output.modeProbes.find(
                  (probe) => probe.symbol === p.symbol,
                );
                output.modeProbes = [
                  ...output.modeProbes.filter(
                    (probe) => probe.symbol !== p.symbol,
                  ),
                  {
                    symbol: p.symbol!,
                    positionIndices: [
                      ...new Set([
                        ...(old?.positionIndices ?? []),
                        ...positions.map((position) => position.positionIdx),
                      ]),
                    ],
                  },
                ];
                break;
              }
            }
          }
        } catch (error) {
          invalidate(p, error);
        }
        stopAfterTerminalBudget(result);
      }
    } finally {
      output.observations = [...observations.values()].filter(
        (observation) => observation.partition.pass === pass,
      );
      const value = createAccountCriticalPass(output);
      if (!value.ok) throw new BybitAccountReadError("INVALID_RESPONSE");
      critical[pass] = value.value;
    }
    return critical[pass]!;
  }
  async function exposureBases(
    orders: AccountEvidencePayload["auxiliary"]["orders"],
    positions: AccountCriticalPass["positions"],
  ): Promise<string[]> {
    const symbols = [
        ...new Set(
          [...orders, ...positions]
            .filter((row) => row.category === "option")
            .map((row) => row.symbol),
        ),
      ].sort(),
      bases = new Set<string>();
    for (const symbol of symbols) {
      try {
        const response = await bounded(() =>
            readPort.readOptionInstrument(symbol),
          ),
          matches = rows(response).filter((row) => row.symbol === symbol);
        if (matches.length !== 1)
          throw new BybitAccountReadError("COVERAGE_INCOMPLETE");
        bases.add(identifier(matches[0]!.baseCoin));
      } catch (error) {
        diagnose(accountReadFailureCode(error), "coverage");
        if (discovery) discovery = { ...discovery, uncoveredScopes: true };
      }
    }
    return [...bases].sort();
  }
  try {
    let credentials: ExchangeCredentials;
    try {
      const loaded = await options.credentialLoader.load(options.environment);
      credentials = Object.freeze({
        apiKey: loaded.apiKey,
        apiSecret: loaded.apiSecret,
        accountId: loaded.accountId,
      });
      if (
        !credentials.apiKey ||
        !credentials.apiSecret ||
        !credentials.accountId
      )
        throw new Error();
    } catch {
      throw new BybitAccountReadError("CREDENTIALS_UNAVAILABLE");
    }
    monotonicStart = mono();
    lastMonotonic = monotonicStart;
    budget = {
      ...budget,
      deadline: monotonicStart + policy.maxCollectionDurationMs,
    };
    readPort = options.createReadPort
      ? options.createReadPort({
          environment: options.environment,
          credentials,
          budget,
          utcClock: wall,
          monotonicClock: mono,
        })
      : new BybitAccountReadClient({
          transport: new BybitAccountReadTransport({
            environment: options.environment,
            credentials,
            budget,
            clock: wall,
            monotonicClock: mono,
          }),
          utcClock: wall,
        });
    const identity = await bounded(() => readPort.readIdentity());
    const mapped = mapAccountReadIdentity(
      identity,
      credentials.accountId,
      options.environment,
      timestamp(wall()),
    );
    binding = mapped.accountBinding;
    posture = mapped.credentialPosture;
    initial = timestamp(await bounded(() => readPort.readExchangeTime()));
    const first = await discover();
    discovery = {
      settlementCoins: first.settlements,
      optionBaseCoins: first.bases,
      exposureOptionBaseCoins: [],
      passBSettlementCoins: first.settlements,
      passBOptionBaseCoins: first.bases,
      uncoveredScopes: false,
      upgradeOverlap: false,
      separateInverseWallet: false,
    };
    critical.A = await criticalPass("A");
    if (
      critical.A.account.utaStatus.state === "known" &&
      [3, 4].includes(critical.A.account.utaStatus.value)
    )
      discovery = { ...discovery, separateInverseWallet: true };
    cutoff = timestamp(await bounded(() => readPort.readExchangeTime()));
    const window = {
      from: Date.parse(cutoff) - policy.historyWindowMs,
      to: Date.parse(cutoff),
    };
    for (const p of deriveExpectedAccountEvidencePartitions(
      options.configuredM1Symbols,
      discovery,
    ).filter((p) => p.endpoint === "tiers" || p.endpoint === "order-history")) {
      const result = await read(p, window);
      try {
        for (const response of result.responses)
          if (p.endpoint === "tiers")
            auxiliary.tiers = unique(
              [...auxiliary.tiers, ...mapAccountTiers(response)],
              (v) =>
                JSON.stringify([
                  v.coin,
                  v.minQty.state === "known"
                    ? v.minQty.value.toString()
                    : v.minQty.state,
                ]),
            );
          else
            auxiliary.orders = unique(
              [...auxiliary.orders, ...mapAccountOrders(response, p.category!)],
              (v) => JSON.stringify([v.category, v.orderId]),
            );
      } catch (error) {
        invalidate(p, error);
      }
      stopAfterTerminalBudget(result);
    }
    const exposed = await exposureBases(
      [...auxiliary.orders, ...critical.A.orders],
      critical.A.positions,
    );
    discovery = { ...discovery, exposureOptionBaseCoins: exposed };
    for (const p of deriveExpectedAccountEvidencePartitions(
      options.configuredM1Symbols,
      discovery,
    ).filter(
      (p) =>
        p.endpoint === "instrument-metadata" || p.endpoint === "executions",
    )) {
      const result = await read(p, window);
      try {
        for (const response of result.responses)
          if (p.endpoint === "executions")
            auxiliary.executions = unique(
              [
                ...auxiliary.executions,
                ...mapAccountExecutions(response, p.category!),
              ],
              (v) => JSON.stringify([v.category, v.execId]),
            );
          else
            for (const row of rows(response))
              if (identifier(row.baseCoin) !== p.baseCoin)
                throw new BybitAccountReadError("INVALID_RESPONSE");
      } catch (error) {
        invalidate(p, error);
      }
      stopAfterTerminalBudget(result);
    }
    critical.B = await criticalPass("B");
    const second = await discover();
    const secondExposed = await exposureBases(
      critical.B.orders,
      critical.B.positions,
    );
    discovery = {
      ...discovery,
      passBSettlementCoins: second.settlements,
      passBOptionBaseCoins: [
        ...new Set([...second.bases, ...secondExposed]),
      ].sort(),
    };
    closing = timestamp(await bounded(() => readPort.readExchangeTime()));
  } catch (error) {
    diagnose(
      accountReadFailureCode(error),
      binding ? "collection" : "identity",
    );
  }
  const endedAt = timestamp(
    Math.max(
      wall(),
      Date.parse(startedAt),
      binding ? Date.parse(binding.authenticatedAt) : 0,
    ),
  );
  if (!binding || !posture) {
    const result = createAccountEvidenceCollectionResult({
      kind: "pre-auth-failure",
      environment: options.environment,
      runId: options.runId,
      policyVersion: ACCOUNT_EVIDENCE_POLICY_VERSION,
      startedAt,
      endedAt,
      reasonCodes: diagnostics.map((d) => d.code),
    });
    if (!result.ok) throw new BybitAccountReadError("INVALID_RESPONSE");
    return result.value;
  }
  const expected = discovery
    ? deriveExpectedAccountEvidencePartitions(
        options.configuredM1Symbols,
        discovery,
      )
    : [];
  for (const p of expected) {
    const key = accountEvidencePartitionKey(p);
    if (!coverage.has(key))
      coverage.set(key, {
        partition: p,
        status: "failed",
        pages: 0,
        rows: 0,
        startedAt: null,
        endedAt: null,
        reasonCodes: ["COVERAGE_INCOMPLETE"],
      });
  }
  const policyHash = accountEvidencePolicyHash();
  if (!policyHash.ok) throw new BybitAccountReadError("INVALID_RESPONSE");
  const retainedRows = countAccountEvidenceRows({
    criticalPasses: critical,
    auxiliary: { ...auxiliary, observations: [] },
  });
  const payload: AccountEvidencePayload = {
    schemaVersion: ACCOUNT_EVIDENCE_SCHEMA_VERSION,
    producer: "bybit-account-read:v1",
    runId: options.runId,
    accountBinding: binding,
    credentialPosture: posture,
    policyVersion: ACCOUNT_EVIDENCE_POLICY_VERSION,
    policyHash: policyHash.value,
    startedAt,
    endedAt,
    collectionStartedAt: initial,
    collectionEndedAt: closing,
    bundleCutoff: cutoff,
    historyWindow: cutoff
      ? {
          startedAt: timestamp(Date.parse(cutoff) - policy.historyWindowMs),
          endedAt: cutoff,
          selectionClock: "provider-native",
        }
      : null,
    collectionStatus: "incomplete",
    configuredM1Symbols: options.configuredM1Symbols,
    discovery,
    criticalPasses: critical,
    auxiliary: {
      ...auxiliary,
      observations: [...observations.values()].filter(
        (observation) => observation.partition.pass === "auxiliary",
      ),
    },
    expectedPartitions: expected,
    coverage: [...coverage.values()],
    budget: {
      monotonicDurationMs: Math.max(0, Math.ceil(mono() - monotonicStart)),
      httpAttempts: budget.attempts,
      retainedRows,
      maxObservedResponseBytes: budget.maxObservedResponseBytes,
    },
    diagnostics,
    evidence: [],
  };
  const result = createAccountEvidenceBundle({
    ...payload,
    collectionStatus: deriveAccountEvidenceCollectionStatus(payload),
  });
  if (!result.ok) throw new BybitAccountReadError("INVALID_RESPONSE");
  return Object.freeze({
    kind: "account-evidence",
    bundle: result.value satisfies AccountEvidenceBundle,
  });
}
