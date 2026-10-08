import assert from "node:assert/strict";
import test from "node:test";
import {
  accountEvidenceContentHash,
  createAccountEvidenceBundle,
  createAccountEvidenceCollectionResult,
  type AccountEvidenceCollectionResult,
} from "../src/domain/account/account-evidence-bundle.js";
import type { AccountEvidenceFailureCode } from "../src/domain/account/account-evidence-diagnostics.js";
import { createInstrumentConstraints } from "../src/domain/market/instrument-constraints.js";
import type { BybitInstrumentInfo } from "../src/adapters/bybit-v5/read-mappers.js";
import {
  deriveMainnetExecutionReadiness,
  type MainnetExecutionReadinessInput,
} from "../src/application/mainnet-execution-readiness.js";
import { fixture } from "./account-evidence-fixture.js";

const evaluatedAt = "2026-10-02T12:00:02.000Z";
const symbol = "BTCUSDT";

function validInstrument(
  targetSymbol = symbol,
  overrides: Record<string, unknown> = {},
) {
  const constraints = createInstrumentConstraints({
    instrument: targetSymbol,
    version: "bybit-linear-instrument/v1",
    priceTickSize: "0.1",
    quantityStep: "0.001",
    minQuantity: "0.001",
    minNotional: "5",
  });
  assert.equal(constraints.ok, true);
  if (!constraints.ok) throw new Error("instrument fixture is invalid");
  return {
    symbol: targetSymbol,
    status: "Trading",
    contractType: "LinearPerpetual",
    quoteCoin: "USDT",
    settleCoin: "USDT",
    constraints: constraints.value,
    ...overrides,
  } as BybitInstrumentInfo;
}

function accountResult(
  options: {
    readonly environment?: "demo" | "mainnet";
    readonly incompletePartition?: (
      partition: Record<string, unknown>,
    ) => boolean;
    readonly incompleteReasonCode?: AccountEvidenceFailureCode;
    readonly collectionStatus?: "complete" | "incomplete";
    readonly mutate?: (payload: Record<string, unknown>) => void;
  } = {},
): AccountEvidenceCollectionResult {
  const payload = fixture() as unknown as Record<string, unknown>;
  const environment = options.environment ?? "mainnet";
  payload.accountBinding = {
    ...(payload.accountBinding as Record<string, unknown>),
    environment,
    origin:
      environment === "mainnet"
        ? "https://api.bybit.com"
        : "https://api-demo.bybit.com",
  };
  payload.credentialPosture = {
    readOnly: false,
    permissions: {
      contractOrder: true,
      contractPosition: true,
      spotTrade: false,
      walletTransfer: false,
      withdraw: false,
    },
    ipBound: true,
    expiresAt: null,
    warnings: [],
  };
  if (options.incompletePartition) {
    const coverage = payload.coverage as Record<string, unknown>[];
    const failed = coverage.find((entry) =>
      options.incompletePartition!(entry.partition as Record<string, unknown>),
    );
    assert.ok(failed, "fixture must contain the requested coverage partition");
    const reasonCode = options.incompleteReasonCode ?? "TRANSPORT_FAILED";
    failed.status = "failed";
    failed.reasonCodes = [reasonCode];
    payload.collectionStatus = "incomplete";
    payload.diagnostics = [
      { code: reasonCode, severity: "error", scope: "coverage" },
    ];
  }
  options.mutate?.(payload);
  if (options.collectionStatus !== undefined)
    payload.collectionStatus = options.collectionStatus;
  const bundle = createAccountEvidenceBundle(payload);
  assert.equal(bundle.ok, true, "account fixture must remain canonical");
  if (!bundle.ok) throw new Error("account fixture is not canonical");
  const result = createAccountEvidenceCollectionResult({
    kind: "account-evidence",
    bundle: bundle.value,
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("account collection result is invalid");
  return result.value;
}

function readiness(overrides: Partial<MainnetExecutionReadinessInput> = {}) {
  return deriveMainnetExecutionReadiness({
    accountResult: accountResult(),
    symbol,
    instrument: validInstrument(),
    evaluatedAt,
    ...overrides,
  });
}

function mutateAccount(
  mutate: (payload: Record<string, unknown>) => void,
  collectionStatus: "complete" | "incomplete" = "complete",
): AccountEvidenceCollectionResult {
  return accountResult({ mutate, collectionStatus });
}

test("valid Mainnet facts and exact target reads produce READY, SUPPORTED not LIVE_PROVEN", () => {
  const result = readiness();
  assert.equal(result.verdict, "READY");
  assert.deepEqual(result.reasonCodes, []);
  assert.equal(result.capabilityProfile.status, "SUPPORTED");
  assert.equal(result.capabilityProfile.liveProof, "not-established");
  assert.equal(result.accountEvidenceAgeMs, 0);
  assert.ok(result.internalBinding?.accountIdentityHash.startsWith("sha256:"));
  assert.ok(result.internalBinding?.accountEvidenceHash.startsWith("sha256:"));
});

test("only attributable unrelated auxiliary gaps remain READY and visible", () => {
  const result = deriveMainnetExecutionReadiness({
    accountResult: accountResult({
      incompletePartition: (partition) =>
        partition.pass === "auxiliary" &&
        partition.endpoint === "order-history" &&
        partition.category === "spot",
    }),
    symbol,
    instrument: validInstrument(),
    evaluatedAt,
  });
  assert.equal(result.verdict, "READY");
  assert.deepEqual(result.warningCodes, [
    "UNRELATED_ACCOUNT_COVERAGE_INCOMPLETE",
  ]);
  assert.equal(result.unrelatedCoverageGapCount, 1);
});

test("required selected execution partitions and unknown coverage attribution BLOCK", () => {
  const required = deriveMainnetExecutionReadiness({
    accountResult: accountResult({
      incompletePartition: (partition) =>
        partition.pass === "A" &&
        partition.endpoint === "positions" &&
        partition.category === "linear" &&
        partition.settleCoin === "USDT",
    }),
    symbol,
    instrument: validInstrument(),
    evaluatedAt,
  });
  assert.equal(required.verdict, "BLOCKED");
  assert.ok(required.reasonCodes.includes("REQUIRED_PARTITION_INCOMPLETE"));

  const unknown = deriveMainnetExecutionReadiness({
    accountResult: accountResult({
      incompletePartition: (partition) =>
        partition.pass === "auxiliary" && partition.endpoint === "tiers",
    }),
    symbol,
    instrument: validInstrument(),
    evaluatedAt,
  });
  assert.equal(unknown.verdict, "BLOCKED");
  assert.ok(unknown.reasonCodes.includes("COVERAGE_ATTRIBUTION_UNKNOWN"));
});

test("post-auth provider diagnostics remain visible on blocked readiness", () => {
  const result = deriveMainnetExecutionReadiness({
    accountResult: accountResult({
      incompletePartition: (partition) =>
        partition.pass === "A" &&
        partition.endpoint === "positions" &&
        partition.category === "linear" &&
        partition.settleCoin === "USDT",
      incompleteReasonCode: "RATE_LIMITED",
    }),
    symbol,
    instrument: validInstrument(),
    evaluatedAt,
  });

  assert.equal(result.verdict, "BLOCKED");
  assert.ok(result.reasonCodes.includes("REQUIRED_PARTITION_INCOMPLETE"));
  assert.deepEqual(result.providerReasonCodes, ["RATE_LIMITED"]);
});

test("failed and pre-auth collection results never claim readiness or account provenance", () => {
  const preAuth = createAccountEvidenceCollectionResult({
    kind: "pre-auth-failure",
    environment: "mainnet",
    runId: "pre-auth-run",
    policyVersion: "account-evidence-collection-policy/v1",
    reasonCodes: ["AUTHENTICATION_FAILED"],
    startedAt: "2026-10-02T12:00:00.000Z",
    endedAt: evaluatedAt,
  });
  assert.equal(preAuth.ok, true);
  if (!preAuth.ok) return;
  const blocked = deriveMainnetExecutionReadiness({
    accountResult: preAuth.value,
    symbol,
    instrument: validInstrument(),
    evaluatedAt,
  });
  assert.equal(blocked.verdict, "BLOCKED");
  assert.deepEqual(blocked.reasonCodes, ["PRE_AUTH_FAILURE"]);
  assert.deepEqual(blocked.providerReasonCodes, ["AUTHENTICATION_FAILED"]);
  assert.equal("internalBinding" in blocked, false);

  const failedPayload = fixture() as unknown as Record<string, unknown>;
  failedPayload.accountBinding = {
    ...(failedPayload.accountBinding as Record<string, unknown>),
    environment: "mainnet",
    origin: "https://api.bybit.com",
  };
  failedPayload.criticalPasses = { A: null, B: null };
  failedPayload.collectionStatus = "failed";
  failedPayload.diagnostics = [
    { code: "COVERAGE_INCOMPLETE", severity: "error", scope: "collection" },
  ];
  const failedBundle = createAccountEvidenceBundle(failedPayload);
  assert.equal(failedBundle.ok, true);
  if (!failedBundle.ok) return;
  const failedResult = createAccountEvidenceCollectionResult({
    kind: "account-evidence",
    bundle: failedBundle.value,
  });
  assert.equal(failedResult.ok, true);
  if (!failedResult.ok) return;
  const failed = deriveMainnetExecutionReadiness({
    accountResult: failedResult.value,
    symbol,
    instrument: validInstrument(),
    evaluatedAt,
  });
  assert.equal(failed.verdict, "BLOCKED");
  assert.ok(failed.reasonCodes.includes("ACCOUNT_EVIDENCE_FAILED"));
});

test("account freshness is measured at verdict time with an inclusive 60-second boundary", () => {
  const atBoundary = deriveMainnetExecutionReadiness({
    accountResult: accountResult(),
    symbol,
    instrument: validInstrument(),
    evaluatedAt: "2026-10-02T12:01:02.000Z",
  });
  assert.equal(atBoundary.verdict, "READY");
  assert.equal(atBoundary.accountEvidenceAgeMs, 60_000);

  const stale = deriveMainnetExecutionReadiness({
    accountResult: accountResult(),
    symbol,
    instrument: validInstrument(),
    evaluatedAt: "2026-10-02T12:01:02.001Z",
  });
  assert.equal(stale.verdict, "BLOCKED");
  assert.ok(stale.reasonCodes.includes("ACCOUNT_EVIDENCE_STALE"));
});

test("known expiry at verdict time blocks; unknown expiry does not mean unlimited validity", () => {
  const expiresNow = deriveMainnetExecutionReadiness({
    accountResult: mutateAccount((payload) => {
      payload.credentialPosture = {
        ...(payload.credentialPosture as Record<string, unknown>),
        expiresAt: evaluatedAt,
      };
    }),
    symbol,
    instrument: validInstrument(),
    evaluatedAt,
  });
  assert.equal(expiresNow.verdict, "BLOCKED");
  assert.ok(expiresNow.reasonCodes.includes("KEY_EXPIRED"));

  const unknownExpiry = readiness();
  assert.equal(unknownExpiry.verdict, "READY");
});

test("credential, account mode, target mode and instrument gates fail closed", () => {
  const cases: Array<{
    readonly name: string;
    readonly accountResult: AccountEvidenceCollectionResult;
    readonly targetSymbol?: string;
    readonly instrument?: BybitInstrumentInfo | null;
    readonly expected: string;
  }> = [
    {
      name: "read-only key",
      accountResult: mutateAccount((payload) => {
        payload.credentialPosture = {
          ...(payload.credentialPosture as Record<string, unknown>),
          readOnly: true,
        };
      }),
      expected: "READ_ONLY_KEY",
    },
    {
      name: "missing order permission",
      accountResult: mutateAccount((payload) => {
        payload.credentialPosture = {
          ...(payload.credentialPosture as Record<string, unknown>),
          permissions: {
            ...((payload.credentialPosture as Record<string, unknown>)
              .permissions as Record<string, unknown>),
            contractOrder: false,
          },
        };
      }),
      expected: "CONTRACT_ORDER_PERMISSION_MISSING",
    },
    {
      name: "missing position permission",
      accountResult: mutateAccount((payload) => {
        payload.credentialPosture = {
          ...(payload.credentialPosture as Record<string, unknown>),
          permissions: {
            ...((payload.credentialPosture as Record<string, unknown>)
              .permissions as Record<string, unknown>),
            contractPosition: false,
          },
        };
      }),
      expected: "CONTRACT_POSITION_PERMISSION_MISSING",
    },
    {
      name: "transfer write authority",
      accountResult: mutateAccount((payload) => {
        payload.credentialPosture = {
          ...(payload.credentialPosture as Record<string, unknown>),
          permissions: {
            ...((payload.credentialPosture as Record<string, unknown>)
              .permissions as Record<string, unknown>),
            walletTransfer: true,
          },
        };
      }),
      expected: "TRANSFER_WRITE_AUTHORITY",
    },
    {
      name: "unsupported margin mode",
      accountResult: mutateAccount((payload) => {
        const passes = payload.criticalPasses as Record<
          string,
          Record<string, unknown>
        >;
        for (const label of ["A", "B"]) {
          const pass = passes[label]!;
          pass.account = {
            ...(pass.account as Record<string, unknown>),
            marginMode: { state: "known", value: "ISOLATED_MARGIN" },
          };
        }
      }, "incomplete"),
      expected: "ACCOUNT_MODE_UNSUPPORTED",
    },
    {
      name: "spot hedging enabled",
      accountResult: mutateAccount((payload) => {
        const passes = payload.criticalPasses as Record<
          string,
          Record<string, unknown>
        >;
        for (const label of ["A", "B"]) {
          const pass = passes[label]!;
          pass.account = {
            ...(pass.account as Record<string, unknown>),
            spotHedging: { state: "known", value: true },
          };
        }
      }),
      expected: "SPOT_HEDGING_ENABLED",
    },
    {
      name: "hedge target mode",
      accountResult: mutateAccount((payload) => {
        const passes = payload.criticalPasses as Record<
          string,
          Record<string, unknown>
        >;
        for (const label of ["A", "B"]) {
          const pass = passes[label]!;
          pass.modeProbes = [{ symbol, positionIndices: [1, 2] }];
        }
      }, "incomplete"),
      expected: "TARGET_HEDGE_MODE_UNSUPPORTED",
    },
    {
      name: "unconfigured target symbol",
      accountResult: accountResult(),
      targetSymbol: "ETHUSDT",
      instrument: validInstrument("ETHUSDT"),
      expected: "TARGET_SYMBOL_UNCONFIGURED",
    },
    {
      name: "missing instrument evidence",
      accountResult: accountResult(),
      instrument: null,
      expected: "INSTRUMENT_UNAVAILABLE",
    },
    {
      name: "non-trading instrument",
      accountResult: accountResult(),
      instrument: validInstrument(symbol, { status: "PreLaunch" }),
      expected: "INSTRUMENT_UNSUPPORTED",
    },
    {
      name: "symbol mismatch",
      accountResult: accountResult(),
      instrument: validInstrument(symbol, { symbol: "ETHUSDT" }),
      expected: "INSTRUMENT_SYMBOL_MISMATCH",
    },
  ];

  for (const item of cases) {
    const result = deriveMainnetExecutionReadiness({
      accountResult: item.accountResult,
      symbol: item.targetSymbol ?? symbol,
      instrument:
        item.instrument === undefined ? validInstrument() : item.instrument,
      evaluatedAt,
    });
    assert.equal(result.verdict, "BLOCKED", item.name);
    assert.ok(result.reasonCodes.includes(item.expected as never), item.name);
  }
});

test("wrong environment and identity/hash override attempts cannot be accepted", () => {
  const wrongEnvironment = deriveMainnetExecutionReadiness({
    accountResult: accountResult({ environment: "demo" }),
    symbol,
    instrument: validInstrument(),
    evaluatedAt,
  });
  assert.equal(wrongEnvironment.verdict, "BLOCKED");
  assert.ok(
    wrongEnvironment.reasonCodes.includes("ACCOUNT_ENVIRONMENT_MISMATCH"),
  );

  const source = accountResult();
  const forged = deriveMainnetExecutionReadiness({
    accountResult: source,
    symbol,
    instrument: validInstrument(),
    evaluatedAt,
    verdict: "READY",
    accountEvidenceHash:
      "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
  } as never);
  assert.equal(forged.verdict, "BLOCKED");
  assert.ok(forged.reasonCodes.includes("INVALID_REQUEST"));

  const accepted = source;
  if (accepted.kind !== "account-evidence") return;
  const actualHash = accountEvidenceContentHash(accepted.bundle);
  assert.equal(actualHash.ok, true);
  if (!actualHash.ok) return;
  assert.equal(
    accepted.bundle.accountBinding.accountIdentityHash.startsWith("sha256:"),
    true,
  );
});

test("unbound IP is a warning, not a readiness blocker", () => {
  const result = deriveMainnetExecutionReadiness({
    accountResult: mutateAccount((payload) => {
      payload.credentialPosture = {
        ...(payload.credentialPosture as Record<string, unknown>),
        ipBound: false,
        warnings: ["API_KEY_IP_UNBOUND"],
      };
    }),
    symbol,
    instrument: validInstrument(),
    evaluatedAt,
  });
  assert.equal(result.verdict, "READY");
  assert.deepEqual(result.warningCodes, ["API_KEY_IP_UNBOUND"]);
});
