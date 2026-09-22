import assert from "node:assert/strict";
import test from "node:test";

import {
  capabilityStatus,
  createAdapterCapabilityObservation,
  createCapabilityObservation,
  requireCapability,
  requireTrustedCapability,
} from "../src/domain/capabilities/capability.js";
import { createEvidenceRef } from "../src/domain/evidence/evidence-ref.js";

const evidence = createEvidenceRef({
  kind: "capability-probe",
  schemaVersion: "capability-probe/v1",
  producer: "bybit-demo-probe",
  sourceId: "run-1",
  asOf: "2026-09-19T10:00:00Z",
  validForMs: 3_600_000,
  contentHash: `sha256:${"b".repeat(64)}`,
});
const demoScope = {
  exchange: "bybit",
  environment: "demo",
  category: "linear",
  positionMode: "one-way" as const,
};
const demoRequirement = {
  capability: "attached-protection",
  scope: demoScope,
};

test("capabilities preserve tri-state observations and evidence identity", () => {
  assert.equal(evidence.ok, true);
  if (!evidence.ok) return;
  const observation = createCapabilityObservation({
    capability: "attached-protection",
    status: "unknown",
    observedAt: "2026-09-19T10:00:00Z",
    source: "bybit-demo",
    evidence: evidence.value,
    scope: demoScope,
  });
  assert.equal(observation.ok, true);
  if (!observation.ok) return;
  assert.equal(observation.value.status, "unknown");
  assert.equal(
    observation.value.evidence.contentHash,
    evidence.value.contentHash,
  );

  const gate = requireCapability(observation.value, demoRequirement);
  assert.equal(gate.ok, false);
  if (!gate.ok) assert.equal(gate.error.code, "CAPABILITY_UNKNOWN");
});

test("supported and unsupported capabilities have distinct gate outcomes", () => {
  assert.equal(evidence.ok, true);
  if (!evidence.ok) return;
  for (const [status, expected] of [
    ["supported", true],
    ["unsupported", false],
  ] as const) {
    const observation = createCapabilityObservation({
      capability: "attached-protection",
      status,
      observedAt: "2026-09-19T10:00:00Z",
      source: "fixture",
      evidence: evidence.value,
      scope: demoScope,
    });
    assert.equal(observation.ok, true);
    if (!observation.ok) continue;
    const gate = requireCapability(observation.value, demoRequirement);
    assert.equal(gate.ok, expected);
    if (!expected && !gate.ok)
      assert.equal(gate.error.code, "CAPABILITY_UNSUPPORTED");
  }
});

test("a Demo observation cannot authorize the same capability in Testnet", () => {
  assert.equal(evidence.ok, true);
  if (!evidence.ok) return;
  const observation = createCapabilityObservation({
    capability: "attached-protection",
    status: "supported",
    observedAt: "2026-09-19T10:00:00Z",
    source: "bybit-demo",
    evidence: evidence.value,
    scope: demoScope,
  });
  assert.equal(observation.ok, true);
  if (!observation.ok) return;
  const testnetRequirement = {
    capability: "attached-protection",
    scope: { ...demoScope, environment: "testnet" },
  };
  const gate = requireCapability(observation.value, testnetRequirement);
  assert.equal(gate.ok, false);
  if (!gate.ok) assert.equal(gate.error.code, "CAPABILITY_UNKNOWN");
});

test("capability status fails closed for conflicting observations", () => {
  assert.equal(evidence.ok, true);
  if (!evidence.ok) return;
  const observations = ["supported", "unsupported"].map((status, index) => {
    const result = createCapabilityObservation({
      capability: "attached-protection",
      status,
      observedAt: `2026-09-19T10:00:0${index}Z`,
      source: "fixture",
      evidence: evidence.value,
      scope: demoScope,
    });
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("capability fixture");
    return result.value;
  });
  assert.equal(capabilityStatus(observations, demoRequirement), "unsupported");
});

test("non-probe evidence cannot be promoted to capability evidence", () => {
  const observation = createCapabilityObservation({
    capability: "attached-protection",
    status: "supported",
    observedAt: "2026-09-19T10:00:00Z",
    source: "fixture",
    evidence: {
      kind: "market-snapshot",
      schemaVersion: "market-snapshot/v1",
      producer: "fixture",
      sourceId: "run-1",
      asOf: "2026-09-19T10:00:00Z",
      validForMs: 3_600_000,
      contentHash: `sha256:${"c".repeat(64)}`,
    },
    scope: demoScope,
  });
  assert.equal(observation.ok, false);
  if (!observation.ok)
    assert.equal(observation.error.code, "INVALID_CAPABILITY");
});

test("only adapter-produced capability evidence satisfies the trusted gate", () => {
  assert.equal(evidence.ok, true);
  if (!evidence.ok) return;

  const adapterObservation = createAdapterCapabilityObservation({
    capability: "attached-protection",
    status: "supported",
    observedAt: "2026-09-19T10:00:00Z",
    source: "bybit-demo-adapter",
    evidence: evidence.value,
    scope: demoScope,
  });
  assert.equal(adapterObservation.ok, true);
  if (!adapterObservation.ok) return;
  assert.equal(
    requireTrustedCapability(adapterObservation.value, demoRequirement).ok,
    true,
  );

  const copied = { ...adapterObservation.value };
  const copiedGate = requireTrustedCapability(copied, demoRequirement);
  assert.equal(copiedGate.ok, false);
  if (!copiedGate.ok) assert.equal(copiedGate.error.code, "CAPABILITY_UNKNOWN");
});
