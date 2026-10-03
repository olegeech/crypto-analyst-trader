import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  accountEvidenceContentHash,
  createAccountEvidenceBundle,
} from "../src/domain/account/account-evidence-bundle.js";
import {
  canonicalSerialize,
  createEvidenceRef,
  encodeCanonicalArtifact,
  decodeCanonicalArtifact,
  rehydrateArtifact,
  isDecimalValue,
  isEvidenceFresh,
  fixedClock,
} from "../src/domain/index.js";
import {
  execution,
  fixture,
  order,
  position,
  withCounts,
} from "./account-evidence-fixture.js";

function bundle(status: "complete" | "incomplete" | "failed" = "complete") {
  const input = fixture();
  const parsed = createAccountEvidenceBundle(
    status === "complete"
      ? input
      : {
          ...input,
          collectionStatus: status,
          criticalPasses: { A: null, B: null },
          discovery: null,
        },
  );
  assert.ok(parsed.ok);
  return parsed.value;
}
function envelope(value: unknown) {
  const serialized = canonicalSerialize(value);
  assert.ok(serialized.ok);
  const canonicalJson = serialized.value;
  return {
    artifactKind: "account-evidence-bundle",
    schemaVersion: "artifact/v1",
    canonicalJson,
    canonicalHash: `sha256:${createHash("sha256").update(canonicalJson).digest("hex")}`,
  };
}
for (const status of ["complete", "incomplete", "failed"] as const) {
  test(`canonical account ${status} round trip preserves historical identity`, () => {
    const original = bundle(status);
    const encoded = encodeCanonicalArtifact(
      "account-evidence-bundle",
      original,
    );
    assert.ok(encoded.ok);
    const restored = rehydrateArtifact(
      "account-evidence-bundle",
      encoded.value,
    );
    assert.ok(restored.ok);
    assert.deepEqual(restored.value, original);
    assert.deepEqual(
      accountEvidenceContentHash(restored.value),
      accountEvidenceContentHash(original),
    );
    assert.deepEqual(
      encodeCanonicalArtifact("account-evidence-bundle", restored.value),
      encoded,
    );
    const total = restored.value.criticalPasses.A?.totals.totalEquity;
    if (total?.state === "known") assert.ok(isDecimalValue(total.value));
    assert.ok(Object.isFrozen(restored.value.accountBinding));
  });
}
test("account evidence refs preserve cutoff and expire without renewed authority", () => {
  const value = bundle();
  const hash = accountEvidenceContentHash(value);
  assert.ok(hash.ok);
  const ref = createEvidenceRef({
    kind: "account-evidence-bundle",
    schemaVersion: value.schemaVersion,
    producer: value.producer,
    sourceId: value.runId,
    asOf: value.bundleCutoff,
    validForMs: 1000,
    contentHash: hash.value,
  });
  assert.ok(ref.ok);
  const clock = fixedClock("2026-10-03T12:00:00.000Z");
  assert.ok(clock.ok);
  assert.equal(isEvidenceFresh(ref.value, clock.value), false);
  const withRef = createAccountEvidenceBundle({
    ...value,
    evidence: [ref.value],
  });
  assert.ok(withRef.ok);
  const encoded = encodeCanonicalArtifact(
    "account-evidence-bundle",
    withRef.value,
  );
  assert.ok(encoded.ok);
  const restored = rehydrateArtifact("account-evidence-bundle", encoded.value);
  assert.ok(restored.ok);
  const historicalRef = createEvidenceRef(restored.value.evidence[0]);
  assert.ok(historicalRef.ok);
  assert.equal(isEvidenceFresh(historicalRef.value, clock.value), false);
  for (const field of [
    "producer",
    "sourceId",
    "asOf",
    "contentHash",
  ] as const) {
    const forged: Record<string, unknown> = {
      ...withRef.value,
      evidence: [
        {
          ...ref.value,
          [field]:
            field === "contentHash"
              ? `sha256:${"b".repeat(64)}`
              : field === "asOf"
                ? "2026-10-02T12:00:00.000Z"
                : "forged",
        },
      ],
    };
    assert.equal(
      encodeCanonicalArtifact("account-evidence-bundle", forged).ok,
      false,
    );
    assert.equal(
      rehydrateArtifact("account-evidence-bundle", envelope(forged)).ok,
      false,
    );
  }
});
test("registry rejects false completeness, tampered consistency and nested extra fields", () => {
  const value = bundle();
  const cases = [
    { ...bundle("failed"), collectionStatus: "complete" },
    { ...value, consistency: { ...value.consistency, atomicSnapshot: true } },
    {
      ...value,
      accountBinding: { ...value.accountBinding, secret: "unexpected" },
    },
    {
      ...value,
      criticalPasses: {
        ...value.criticalPasses,
        A: {
          ...value.criticalPasses.A,
          assets: [
            {
              ...value.criticalPasses.A!.assets[0],
              walletBalance: {
                state: "known",
                value: "50",
                unit: "coin",
                secret: "unexpected",
              },
            },
          ],
        },
      },
    },
    { ...value, policyHash: `sha256:${"b".repeat(64)}` },
    { ...value, schemaVersion: "account-evidence-bundle/v2" },
    { ...value, accountBinding: null },
    {
      ...value,
      accountBinding: { ...value.accountBinding, identityVerified: false },
    },
    {
      ...value,
      accountBinding: { ...value.accountBinding, environment: "mainnet" },
    },
    { kind: "pre-auth-failure", environment: "demo" },
  ];
  for (const invalid of cases) {
    assert.equal(
      encodeCanonicalArtifact("account-evidence-bundle", invalid).ok,
      false,
    );
    assert.equal(decodeCanonicalArtifact(envelope(invalid)).ok, false);
    assert.equal(
      rehydrateArtifact("account-evidence-bundle", envelope(invalid)).ok,
      false,
    );
  }
  const encoded = encodeCanonicalArtifact("account-evidence-bundle", value);
  assert.ok(encoded.ok);
  assert.equal(
    decodeCanonicalArtifact({
      ...encoded.value,
      canonicalJson: encoded.value.canonicalJson.replace("run-16", "run-17"),
    }).ok,
    false,
  );
  assert.equal(
    decodeCanonicalArtifact({
      ...encoded.value,
      artifactKind: "pre-auth-failure",
    }).ok,
    false,
  );
});

test("account canonical identity normalizes collections and restores nested decimal facts", () => {
  const input = fixture();
  for (const pass of [input.criticalPasses.A, input.criticalPasses.B]) {
    Object.assign(pass, { positions: [position()], orders: [order()] });
    pass.account.marginMode.value = "FUTURE_MARGIN";
  }
  input.auxiliary.executions = [execution()];
  // Unsupported margin mode retains these facts as incomplete evidence.
  input.collectionStatus = "incomplete";
  input.budget.retainedRows += 5;
  const original = createAccountEvidenceBundle(withCounts(input));
  assert.ok(original.ok);
  const reordered = structuredClone(input);
  reordered.coverage.reverse();
  reordered.expectedPartitions.reverse();
  reordered.criticalPasses.A.assets.reverse();
  const equivalent = createAccountEvidenceBundle(reordered);
  assert.ok(equivalent.ok);
  const encoded = encodeCanonicalArtifact(
    "account-evidence-bundle",
    original.value,
  );
  assert.ok(encoded.ok);
  assert.deepEqual(
    encodeCanonicalArtifact("account-evidence-bundle", equivalent.value),
    encoded,
  );
  const restored = rehydrateArtifact("account-evidence-bundle", encoded.value);
  assert.ok(restored.ok);
  const pass = restored.value.criticalPasses.A!;
  for (const fact of [
    pass.positions[0]!.size,
    pass.orders[0]!.price,
    restored.value.auxiliary.executions[0]!.fee,
  ]) {
    assert.equal(fact.state, "known");
    if (fact.state === "known") assert.ok(isDecimalValue(fact.value));
  }
  assert.deepEqual(restored.value, original.value);
});
