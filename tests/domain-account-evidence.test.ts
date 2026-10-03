import assert from "node:assert/strict";
import test from "node:test";
import {
  accountEvidenceContentHash,
  createAccountEvidenceBundle,
  createAccountEvidenceCollectionResult,
  createAccountExecutionEvidence,
  createAccountOrderEvidence,
  createAccountPositionEvidence,
} from "../src/domain/account/account-evidence-bundle.js";
import {
  execution,
  fixture,
  order,
  position,
  withCounts,
} from "./account-evidence-fixture.js";

test("execution identity ignores time and rejects conflicting duplicates", () => {
  const input = fixture();
  input.auxiliary.executions = [
    execution(),
    execution("exec-1", "2026-10-02T12:00:00.500Z"),
  ];
  input.budget.retainedRows = 20;
  assert.equal(createAccountEvidenceBundle(input).ok, false);
});

test("unknown native margin mode is retained and classified unsupported", () => {
  const input = fixture();
  input.collectionStatus = "incomplete";
  input.criticalPasses.A.account.marginMode = {
    state: "known",
    value: "FUTURE_MARGIN",
  };
  input.criticalPasses.B.account.marginMode = {
    state: "known",
    value: "FUTURE_MARGIN",
  };
  const result = createAccountEvidenceBundle(input);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(
    result.value.criticalPasses.A?.account.marginMode,
    input.criticalPasses.A.account.marginMode,
  );
  assert.equal(result.value.consistency.marginCompatibility, "unsupported");
  assert.ok(result.value.consistency.reasonCodes.includes("MODE_UNSUPPORTED"));
});

test("account evidence requires authenticated binding even for failed collection", () => {
  assert.equal(
    createAccountEvidenceBundle({ collectionStatus: "failed" }).ok,
    false,
  );
});

test("complete multi-asset evidence freezes deeply, detaches inputs and hashes canonically", () => {
  const input = fixture();
  const result = createAccountEvidenceBundle(input);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.value.consistency.complete, true);
  assert.equal(result.value.consistency.atomicSnapshot, false);
  assert.ok(
    Object.isFrozen(result.value.criticalPasses.A?.assets[0]?.walletBalance),
  );
  input.criticalPasses.A.assets[0]!.walletBalance.value = "999";
  const balance = result.value.criticalPasses.A!.assets[0]!.walletBalance;
  assert.equal(balance.state === "known" && balance.value.toString(), "50");
  const reordered = fixture();
  reordered.criticalPasses.A.assets.reverse();
  reordered.coverage.reverse();
  const equivalent = createAccountEvidenceBundle(reordered);
  assert.ok(equivalent.ok);
  if (!equivalent.ok) return;
  assert.deepEqual(
    accountEvidenceContentHash(result.value),
    accountEvidenceContentHash(equivalent.value),
  );
  const hydrated = createAccountEvidenceBundle(
    JSON.parse(JSON.stringify(result.value)),
  );
  assert.ok(hydrated.ok);
  if (hydrated.ok)
    assert.deepEqual(
      accountEvidenceContentHash(result.value),
      accountEvidenceContentHash(hydrated.value),
    );
});

test("failed authenticated evidence retains binding; absent, mismatched and forged binding reject", () => {
  const input = fixture();
  const failed = {
    ...input,
    collectionStatus: "failed",
    criticalPasses: { A: null, B: null },
    discovery: null,
  };
  assert.ok(createAccountEvidenceBundle(failed).ok);
  for (const binding of [
    undefined,
    null,
    { ...input.accountBinding, identityVerified: false },
    { ...input.accountBinding, origin: "https://api.bybit.com" },
    { ...input.accountBinding, accountIdentityHash: "uid-123" },
  ])
    assert.equal(
      createAccountEvidenceBundle({ ...failed, accountBinding: binding }).ok,
      false,
    );
});

test("pre-auth result is closed, unhashed, immutable and has distinct kind", () => {
  const input = fixture();
  const failure = {
    kind: "pre-auth-failure",
    environment: "demo",
    runId: input.runId,
    policyVersion: input.policyVersion,
    reasonCodes: ["AUTHENTICATION_FAILED"],
    startedAt: input.startedAt,
    endedAt: input.endedAt,
  };
  const result = createAccountEvidenceCollectionResult(failure);
  assert.ok(result.ok);
  if (result.ok) assert.ok(Object.isFrozen(result.value));
  for (const field of [
    "bundle",
    "bundleHash",
    "accountBinding",
    "status",
    "collectionStatus",
  ])
    assert.equal(
      createAccountEvidenceCollectionResult({ ...failure, [field]: undefined })
        .ok,
      false,
    );
  assert.equal(
    createAccountEvidenceCollectionResult({ ...failure, reasonCodes: [] }).ok,
    false,
  );
  assert.equal(
    createAccountEvidenceCollectionResult({
      ...failure,
      endedAt: "2026-10-01T00:00:00.000Z",
    }).ok,
    false,
  );
  const authenticated = createAccountEvidenceCollectionResult({
    kind: "account-evidence",
    bundle: input,
  });
  assert.ok(authenticated.ok);
  if (authenticated.ok) assert.ok(Object.isFrozen(authenticated.value));
});

test("exact decimals reject absent/numeric/scientific quantities and preserve zero fees and rebates", () => {
  for (const value of ["", null, undefined, 0, "1e-3", "NaN"])
    assert.equal(
      createAccountExecutionEvidence({
        ...execution(),
        fee: { state: "known", value, unit: "coin" },
      }).ok,
      false,
    );
  for (const value of ["0", "-0.000000000000000001"]) {
    const result = createAccountExecutionEvidence({
      ...execution(),
      fee: { state: "known", value, unit: "coin" },
    });
    assert.ok(result.ok);
    if (result.ok)
      assert.equal(
        result.value.fee.state === "known" && result.value.fee.value.toString(),
        value,
      );
  }
  assert.equal(
    createAccountExecutionEvidence({
      ...execution(),
      qty: { state: "known", value: "-1", unit: "contracts" },
    }).ok,
    false,
  );
});

test("identical executions deduplicate, categories remain distinct, and time only sorts", () => {
  const input = fixture();
  input.auxiliary.executions = [
    execution("z"),
    execution("a", "2026-10-02T11:59:00.000Z"),
    execution("z"),
    { ...execution("z"), category: "inverse" },
  ];
  input.budget.retainedRows = 20;
  const result = createAccountEvidenceBundle(withCounts(input));
  assert.ok(result.ok);
  if (result.ok)
    assert.deepEqual(
      result.value.auxiliary.executions.map((row) => [
        row.execId,
        row.category,
      ]),
      [
        ["a", "linear"],
        ["z", "inverse"],
        ["z", "linear"],
      ],
    );
});

test("unknown order, position and execution enums retain native facts and make evidence incomplete", () => {
  const nativeOrder = {
    ...order(),
    status: "FutureStatus",
    side: "FutureSide",
    orderType: "FutureType",
    category: "future",
  };
  const nativePosition = {
    ...position(),
    side: "FutureSide",
    positionIdx: 7,
    category: "future",
  };
  assert.ok(createAccountOrderEvidence(nativeOrder).ok);
  assert.ok(createAccountPositionEvidence(nativePosition).ok);
  const input = fixture();
  const payload = {
    ...input,
    collectionStatus: "incomplete",
    auxiliary: {
      ...input.auxiliary,
      orders: [nativeOrder],
      executions: [
        {
          ...execution(),
          execType: "FutureExecution",
          side: "FutureSide",
          category: "future",
        },
      ],
    },
    criticalPasses: {
      A: { ...input.criticalPasses.A, positions: [nativePosition] },
      B: { ...input.criticalPasses.B, positions: [nativePosition] },
    },
    budget: { ...input.budget, retainedRows: 20 },
  };
  const result = createAccountEvidenceBundle(payload);
  assert.ok(result.ok);
  if (result.ok) {
    assert.equal(result.value.auxiliary.orders[0]?.status, "FutureStatus");
    assert.equal(result.value.criticalPasses.A?.positions[0]?.positionIdx, 7);
    assert.ok(
      result.value.consistency.reasonCodes.includes("UNSUPPORTED_CAPABILITY"),
    );
  }
  assert.equal(
    createAccountEvidenceBundle({ ...payload, collectionStatus: "complete" })
      .ok,
    false,
  );
});

test("closed runtime schemas reject extras, unsafe counts, forged consistency and accessors without invocation", () => {
  const input = fixture();
  assert.equal(
    createAccountEvidenceBundle({ ...input, secret: "hidden" }).ok,
    false,
  );
  const hidden = { ...input };
  Object.defineProperty(hidden, "secret", {
    value: "hidden",
    enumerable: false,
  });
  assert.equal(createAccountEvidenceBundle(hidden).ok, false);
  assert.equal(
    createAccountEvidenceBundle({
      ...input,
      budget: { ...input.budget, httpAttempts: Number.MAX_SAFE_INTEGER + 1 },
    }).ok,
    false,
  );
  assert.equal(
    createAccountEvidenceBundle({ ...input, consistency: { complete: true } })
      .ok,
    false,
  );
  const accessor = { ...input };
  Object.defineProperty(accessor, "runId", {
    get() {
      throw new Error("getter invoked");
    },
    enumerable: true,
  });
  assert.equal(createAccountEvidenceBundle(accessor).ok, false);
  const factAccessor = { ...execution() };
  Object.defineProperty(factAccessor.fee, "state", {
    get() {
      throw new Error("getter invoked");
    },
    enumerable: true,
  });
  assert.equal(createAccountExecutionEvidence(factAccessor).ok, false);
  const diagnostic = {
    code: "INVALID_RESPONSE",
    severity: "error",
    scope: "collection",
  };
  Object.defineProperty(diagnostic, "code", {
    get() {
      throw new Error("getter invoked");
    },
    enumerable: true,
  });
  assert.equal(
    createAccountEvidenceBundle({ ...input, diagnostics: [diagnostic] }).ok,
    false,
  );
});

test("unknown optional order enum facts stay visible and prevent completeness", () => {
  for (const field of [
    "triggerBy",
    "tpslMode",
    "timeInForce",
    "orderFilter",
    "stopOrderType",
  ] as const) {
    const input = fixture();
    const result = createAccountEvidenceBundle({
      ...input,
      collectionStatus: "incomplete",
      auxiliary: {
        ...input.auxiliary,
        orders: [
          { ...order(), [field]: { state: "known", value: "FutureValue" } },
        ],
      },
      budget: { ...input.budget, retainedRows: 20 },
    });
    assert.ok(result.ok);
    if (result.ok)
      assert.ok(
        result.value.consistency.reasonCodes.includes("UNSUPPORTED_CAPABILITY"),
      );
  }
});

test("credential posture is required, closed, sanitized and read-only keys remain valid", () => {
  const input = fixture();
  const posture = {
    readOnly: true,
    permissions: {
      contractOrder: false,
      contractPosition: false,
      spotTrade: false,
      walletTransfer: false,
      withdraw: false,
    },
    ipBound: false,
    expiresAt: null,
    warnings: ["API_KEY_IP_UNBOUND"],
  };
  const result = createAccountEvidenceBundle({
    ...input,
    credentialPosture: posture,
  });
  assert.ok(result.ok);
  const { credentialPosture: _posture, ...missing } = input;
  assert.equal(_posture.readOnly, true);
  assert.equal(createAccountEvidenceBundle(missing).ok, false);
  for (const invalid of [
    null,
    { ...posture, permissions: { ...posture.permissions, withdraw: true } },
    {
      ...posture,
      permissions: { ...posture.permissions, contractOrder: null },
    },
    { ...posture, ipList: ["127.0.0.1"] },
    { ...posture, warnings: [] },
  ])
    assert.equal(
      createAccountEvidenceBundle({ ...input, credentialPosture: invalid }).ok,
      false,
    );
});

test("authentication proof time is local and separate from exchange observation horizon", () => {
  const input = fixture();
  input.startedAt = "2026-10-02T12:05:00.000Z";
  input.endedAt = "2026-10-02T12:05:02.000Z";
  input.accountBinding.authenticatedAt = input.startedAt;
  for (const observation of [
    ...input.criticalPasses.A.observations,
    ...input.criticalPasses.B.observations,
    ...input.auxiliary.observations,
  ]) {
    observation.startedAt = new Date(
      Date.parse(observation.startedAt) + 300000,
    ).toISOString();
    observation.endedAt = new Date(
      Date.parse(observation.endedAt) + 300000,
    ).toISOString();
    const entry = input.coverage.find(
      (entry) =>
        JSON.stringify(entry.partition) ===
        JSON.stringify(observation.partition),
    )!;
    entry.startedAt = observation.startedAt;
    entry.endedAt = observation.endedAt;
  }
  assert.ok(createAccountEvidenceBundle(input).ok);
});
