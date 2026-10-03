import assert from "node:assert/strict";
import test from "node:test";
import { createAccountEvidenceBundle } from "../src/domain/account/account-evidence-bundle.js";
import { proveAccountPositionMode } from "../src/domain/account/account-evidence-consistency.js";
import {
  accountEvidencePartitionKey,
  deriveExpectedAccountEvidencePartitions,
} from "../src/domain/account/account-evidence-policy.js";
import {
  decimal,
  execution,
  fixture,
  known,
  position,
  order,
  withCounts,
} from "./account-evidence-fixture.js";

function reasons(input: unknown) {
  const result = createAccountEvidenceBundle(input);
  assert.ok(result.ok);
  if (!result.ok) throw new Error("invalid test fixture");
  assert.equal(result.value.consistency.complete, false);
  return result.value.consistency.reasonCodes;
}
test("failed account-info does not fabricate a retained-row contradiction", () => {
  const source = fixture();
  const result = reasons({
    ...source,
    collectionStatus: "incomplete",
    coverage: source.coverage.map((entry) =>
      entry.partition.endpoint === "account-info"
        ? {
            ...entry,
            rows: 0,
            pages: 0,
            status: "failed",
            reasonCodes: ["INVALID_RESPONSE"],
          }
        : entry,
    ),
  });
  assert.ok(result.includes("COVERAGE_INCOMPLETE"));
  assert.equal(result.includes("CONTRADICTORY_OBSERVATION"), false);
  const successful = reasons({
    ...source,
    collectionStatus: "incomplete",
    coverage: source.coverage.map((entry) =>
      entry.partition.endpoint === "account-info"
        ? { ...entry, rows: 0 }
        : entry,
    ),
  });
  assert.ok(successful.includes("CONTRADICTORY_OBSERVATION"));
});

test("account-info without exact time is complete only within the existing provider pass bracket", () => {
  const source = fixture();
  const passes = Object.fromEntries(
    Object.entries(source.criticalPasses).map(([label, pass]) => [
      label,
      {
        ...pass,
        observations: pass.observations.map((obs) =>
          obs.partition.endpoint === "account-info"
            ? {
                ...obs,
                exchangeResponseTime: null,
                timeProvenance: "collection-bracket",
              }
            : obs,
        ),
      },
    ]),
  );
  const valid = createAccountEvidenceBundle({
    ...source,
    criticalPasses: passes,
  });
  assert.ok(valid.ok);
  assert.equal(valid.value.collectionStatus, "complete");
  for (const field of [
    "collectionStartedAt",
    "bundleCutoff",
    "collectionEndedAt",
  ] as const) {
    assert.equal(
      createAccountEvidenceBundle({
        ...source,
        criticalPasses: passes,
        [field]: null,
      }).ok,
      false,
    );
  }
  const unsupported = Object.fromEntries(
    Object.entries(source.criticalPasses).map(([label, pass]) => [
      label,
      {
        ...pass,
        observations: pass.observations.map((obs) =>
          obs.partition.endpoint === "wallet"
            ? {
                ...obs,
                exchangeResponseTime: null,
                timeProvenance: "collection-bracket",
              }
            : obs,
        ),
      },
    ]),
  );
  assert.equal(
    createAccountEvidenceBundle({ ...source, criticalPasses: unsupported }).ok,
    false,
  );
  for (const [exchangeResponseTime, timeProvenance] of [
    [null, "response-envelope"],
    [source.collectionStartedAt, "collection-bracket"],
  ] as const) {
    const contradictory = Object.fromEntries(
      Object.entries(source.criticalPasses).map(([label, pass]) => [
        label,
        {
          ...pass,
          observations: pass.observations.map((obs) =>
            obs.partition.endpoint === "account-info"
              ? { ...obs, exchangeResponseTime, timeProvenance }
              : obs,
          ),
        },
      ]),
    );
    assert.equal(
      createAccountEvidenceBundle({ ...source, criticalPasses: contradictory })
        .ok,
      false,
    );
  }
});

test("coverage derives initial settlements, discoveries, exposure bases and symbols independently of requests", () => {
  const input = fixture();
  const expected = deriveExpectedAccountEvidencePartitions(["BTCUSDT"], {
    ...input.discovery,
    settlementCoins: ["DAI"],
    exposureOptionBaseCoins: ["BTC"],
  });
  for (const coin of ["USDT", "USDC", "DAI"])
    assert.ok(
      expected.some(
        (p) =>
          p.endpoint === "positions" && p.settleCoin === coin && p.pass === "A",
      ),
    );
  assert.ok(
    expected.some((p) => p.endpoint === "executions" && p.baseCoin === "BTC"),
  );
  assert.ok(
    expected.some((p) => p.endpoint === "executions" && p.baseCoin === "ETH"),
  );
  assert.ok(
    expected.some(
      (p) => p.endpoint === "instrument-metadata" && p.baseCoin === "BTC",
    ),
  );
  const omitted = input.expectedPartitions.find(
    (p) => p.endpoint === "positions" && p.settleCoin === "USDC",
  )!;
  const key = accountEvidencePartitionKey(omitted);
  input.expectedPartitions = input.expectedPartitions.filter(
    (p) => accountEvidencePartitionKey(p) !== key,
  );
  input.coverage = input.coverage.filter(
    (p) => accountEvidencePartitionKey(p.partition) !== key,
  );
  input.criticalPasses.A.observations =
    input.criticalPasses.A.observations.filter(
      (p) => accountEvidencePartitionKey(p.partition) !== key,
    );
  assert.ok(
    reasons({ ...input, collectionStatus: "incomplete" }).includes(
      "COVERAGE_INCOMPLETE",
    ),
  );
  assert.equal(createAccountEvidenceBundle(input).ok, false);
});

test("new pass-B scopes and failed/unterminated traversal cannot claim completeness", () => {
  const input = fixture();
  input.discovery.passBSettlementCoins.push("DAI");
  assert.ok(
    reasons({ ...input, collectionStatus: "incomplete" }).includes(
      "CRITICAL_STATE_CHANGED",
    ),
  );
  for (const entry of [{ status: "failed" }, { pages: 0 }, { endedAt: null }]) {
    const base = fixture();
    assert.ok(
      reasons({
        ...base,
        collectionStatus: "incomplete",
        coverage: [
          { ...base.coverage[0], ...entry },
          ...base.coverage.slice(1),
        ],
      }).includes("COVERAGE_INCOMPLETE"),
    );
  }
});

test("valuation-only and metadata-time changes retain both passes without material drift", () => {
  const input = fixture();
  input.criticalPasses.B.assets[0]!.usdValue = decimal("51");
  input.criticalPasses.B.assets[0]!.equity = decimal("51", "coin");
  const p = position();
  const payload = {
    ...input,
    criticalPasses: {
      A: { ...input.criticalPasses.A, positions: [p] },
      B: {
        ...input.criticalPasses.B,
        positions: [
          {
            ...p,
            markPrice: decimal("101", "price"),
            updatedAt: known("2026-10-02T12:00:02.000Z"),
          },
        ],
      },
    },
    budget: { ...input.budget, retainedRows: 20 },
  };
  const result = createAccountEvidenceBundle(withCounts(payload));
  assert.ok(result.ok);
  if (result.ok)
    assert.equal(result.value.consistency.structuralComparison, "unchanged");
});

test("quantity, lock, liability and collateral switch changes are material", () => {
  for (const field of [
    "walletBalance",
    "locked",
    "borrowAmount",
    "spotBorrow",
    "accruedInterest",
  ] as const) {
    const input = fixture();
    input.criticalPasses.B.assets[0]![field] = decimal("1", "coin");
    assert.ok(
      reasons({ ...input, collectionStatus: "incomplete" }).includes(
        "CRITICAL_STATE_CHANGED",
      ),
    );
  }
  const input = fixture();
  input.criticalPasses.B.assets[0]!.collateralSwitch = known(false);
  assert.ok(
    reasons({ ...input, collectionStatus: "incomplete" }).includes(
      "CRITICAL_STATE_CHANGED",
    ),
  );
  const p = position(),
    o = order();
  assert.ok(
    reasons({
      ...fixture(),
      collectionStatus: "incomplete",
      criticalPasses: {
        A: { ...fixture().criticalPasses.A, positions: [p], orders: [o] },
        B: {
          ...fixture().criticalPasses.B,
          positions: [{ ...p, size: decimal("1", "contracts") }],
          orders: [{ ...o, status: "Cancelled" }],
        },
      },
      budget: { ...fixture().budget, retainedRows: 20 },
    }).includes("CRITICAL_STATE_CHANGED"),
  );
});

test("stable wallet/collateral contradictions are incomplete within each pass", () => {
  const input = fixture();
  for (const pass of [input.criticalPasses.A, input.criticalPasses.B])
    pass.collateral[0]!.collateralSwitch = known(false);
  const result = reasons({ ...input, collectionStatus: "incomplete" });
  assert.ok(result.includes("CONTRADICTORY_OBSERVATION"));
  assert.ok(!result.includes("CRITICAL_STATE_CHANGED"));
});

test("positive symbol mode proof: flat index zero, hedge, absent, contradictory and unknown indices", () => {
  for (const [indices, expected] of [
    [[0], "one-way"],
    [[1, 2], "hedge"],
    [[], "unknown"],
    [[0, 1], "unknown"],
    [[7], "unknown"],
  ] as const)
    assert.equal(
      proveAccountPositionMode({ symbol: "BTCUSDT", positionIndices: indices }),
      expected,
    );
  for (const indices of [[], [1, 2], [0, 1], [7]]) {
    const input = fixture();
    input.criticalPasses.A.modeProbes[0]!.positionIndices = indices;
    input.criticalPasses.B.modeProbes[0]!.positionIndices = indices;
    assert.ok(
      reasons({ ...input, collectionStatus: "incomplete" }).some(
        (code) => code === "MODE_UNKNOWN" || code === "MODE_UNSUPPORTED",
      ),
    );
  }
});

test("tiers validate nonnegative ordered ranges, unbounded final range and ratio limits", () => {
  const input = fixture(),
    tier = input.auxiliary.tiers[0]!;
  assert.equal(
    createAccountEvidenceBundle({
      ...input,
      collectionStatus: "incomplete",
      auxiliary: {
        ...input.auxiliary,
        tiers: [
          { ...tier, minQty: decimal("-1", "coin") },
          input.auxiliary.tiers[1],
        ],
      },
    }).ok,
    false,
  );
  for (const invalid of [
    { maxQty: decimal("0", "coin") },
    { collateralRatio: decimal("1.0000001", "rate") },
    { collateralRatio: decimal("-0.1", "rate") },
  ])
    assert.ok(
      reasons({
        ...input,
        collectionStatus: "incomplete",
        auxiliary: {
          ...input.auxiliary,
          tiers: [{ ...tier, ...invalid }, input.auxiliary.tiers[1]],
        },
      }).includes("TIER_INVALID"),
    );
  const ranges = [
    { ...tier, maxQty: decimal("10", "coin") },
    {
      ...tier,
      minQty: decimal("10", "coin"),
      collateralRatio: decimal("0.5", "rate"),
    },
    input.auxiliary.tiers[1],
  ];
  assert.ok(
    createAccountEvidenceBundle(
      withCounts({
        ...input,
        auxiliary: { ...input.auxiliary, tiers: ranges },
        budget: { ...input.budget, retainedRows: 20 },
      }),
    ).ok,
  );
  assert.ok(
    reasons({
      ...input,
      collectionStatus: "incomplete",
      auxiliary: {
        ...input.auxiliary,
        tiers: [
          { ...tier, maxQty: decimal("11", "coin") },
          ranges[1],
          ranges[2],
        ],
      },
      budget: { ...input.budget, retainedRows: 20 },
    }).includes("TIER_INVALID"),
  );
  assert.ok(
    reasons({
      ...input,
      collectionStatus: "incomplete",
      auxiliary: {
        ...input.auxiliary,
        tiers: [tier, { ...tier, minQty: decimal("10", "coin") }, ranges[2]],
      },
      budget: { ...input.budget, retainedRows: 20 },
    }).includes("TIER_INVALID"),
  );
});

test("USD reconciliation uses exact absolute tolerance equality on either side", () => {
  for (const value of ["100.000001", "99.999999"]) {
    const input = fixture();
    input.criticalPasses.A.totals.totalMarginBalance = decimal(value);
    assert.ok(createAccountEvidenceBundle(input).ok);
  }
  for (const value of ["100.000001000000000001", "99.999998999999999999"]) {
    const input = fixture();
    input.criticalPasses.A.totals.totalMarginBalance = decimal(value);
    assert.ok(
      reasons({ ...input, collectionStatus: "incomplete" }).includes(
        "RECONCILIATION_MISMATCH",
      ),
    );
  }
});

test("missing mandatory terms stay unavailable; conditional equity requires established basis", () => {
  const input = fixture();
  const unavailable = {
    state: "unavailable",
    reason: "not-returned",
    unit: "USD",
  };
  const partial = {
    ...input,
    collectionStatus: "incomplete",
    criticalPasses: {
      ...input.criticalPasses,
      A: {
        ...input.criticalPasses.A,
        totals: {
          ...input.criticalPasses.A.totals,
          totalWalletBalance: unavailable,
        },
      },
    },
  };
  assert.ok(reasons(partial).includes("COVERAGE_INCOMPLETE"));
  input.criticalPasses.A.totals.totalEquity = decimal("900");
  assert.ok(createAccountEvidenceBundle(input).ok);
  input.criticalPasses.A.totals.equityBasis = "usd-equity";
  assert.ok(
    reasons({ ...input, collectionStatus: "incomplete" }).includes(
      "RECONCILIATION_MISMATCH",
    ),
  );
});

test("history excludes out-of-window executions but accepts a parent older than the hour or absent", () => {
  const input = fixture();
  input.budget.retainedRows = 20;
  input.auxiliary.executions = [execution()];
  assert.ok(createAccountEvidenceBundle(withCounts(input)).ok);
  assert.ok(
    createAccountEvidenceBundle(
      withCounts({
        ...input,
        auxiliary: {
          ...input.auxiliary,
          orders: [{ ...order(), cumExecQty: decimal("1", "contracts") }],
        },
      }),
    ).ok,
  );
  input.auxiliary.executions = [
    execution("exec-1", "2026-10-02T11:00:00.000Z"),
  ];
  assert.ok(
    reasons({ ...input, collectionStatus: "incomplete" }).includes(
      "COVERAGE_INCOMPLETE",
    ),
  );
});

test("deadline and resource exhaustion are explicit fail-closed reasons", () => {
  for (const [field, value, code] of [
    ["monotonicDurationMs", 30001, "COLLECTION_DEADLINE_EXCEEDED"],
    ["httpAttempts", 81, "ATTEMPT_BUDGET_EXCEEDED"],
    ["retainedRows", 10001, "ROW_BUDGET_EXCEEDED"],
    ["maxObservedResponseBytes", 1048577, "RESPONSE_BYTE_LIMIT_EXCEEDED"],
  ] as const) {
    const input = fixture();
    assert.ok(
      reasons({
        ...input,
        collectionStatus: "incomplete",
        budget: { ...input.budget, [field]: value },
      }).includes(code),
    );
  }
});

test("manifest raw row counts cannot underreport normalized wallet, collateral, mode or tier facts", () => {
  for (const endpoint of [
    "wallet",
    "collateral",
    "mode-probe",
    "tiers",
  ] as const) {
    const input = fixture();
    input.coverage.find(
      (entry) => entry.partition.endpoint === endpoint,
    )!.rows = 0;
    assert.equal(createAccountEvidenceBundle(input).ok, false);
  }
});

test("missing restrictions stay unknown without invalidating available v1 structure", () => {
  const input = fixture();
  const unavailable = { state: "unavailable", reason: "not-returned" };
  const partial = {
    ...input,
    collectionStatus: "complete",
    criticalPasses: {
      A: {
        ...input.criticalPasses.A,
        assets: input.criticalPasses.A.assets.map((asset) => ({
          ...asset,
          restricted: unavailable,
        })),
      },
      B: {
        ...input.criticalPasses.B,
        assets: input.criticalPasses.B.assets.map((asset) => ({
          ...asset,
          restricted: unavailable,
        })),
      },
    },
  };
  const result = createAccountEvidenceBundle(partial);
  assert.ok(result.ok);
  if (result.ok) {
    assert.deepEqual(
      result.value.criticalPasses.A?.assets[0]?.restricted,
      unavailable,
    );
    assert.equal(result.value.consistency.structuralComparison, "unchanged");
  }
  assert.equal(
    createAccountEvidenceBundle({ ...partial, collectionStatus: "complete" })
      .ok,
    true,
  );
});

test("collateral switch N/A requires proven ineligibility; known restriction changes stay material", () => {
  const source = fixture();
  for (const eligible of [true, false]) {
    const criticalPasses = Object.fromEntries(
      Object.entries(source.criticalPasses).map(([label, pass]) => [
        label,
        {
          ...pass,
          assets: pass.assets.map((asset) => ({
            ...asset,
            collateralEligible: known(eligible),
            collateralSwitch: { state: "not-applicable" },
          })),
          collateral: pass.collateral.map((asset) => ({
            ...asset,
            collateralEligible: known(eligible),
            collateralSwitch: { state: "not-applicable" },
          })),
        },
      ]),
    );
    assert.equal(
      createAccountEvidenceBundle({ ...source, criticalPasses }).ok,
      !eligible,
    );
  }
  const changed = fixture();
  changed.criticalPasses.B.assets[0]!.restricted = known("restricted");
  changed.criticalPasses.B.collateral[0]!.restricted = known("restricted");
  assert.ok(
    reasons({ ...changed, collectionStatus: "incomplete" }).includes(
      "CRITICAL_STATE_CHANGED",
    ),
  );
});
