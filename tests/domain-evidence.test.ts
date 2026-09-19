import assert from "node:assert/strict";
import test from "node:test";

import {
  createEvidenceRef,
  isEvidenceFresh,
  requireCompatibleEvidence,
} from "../src/domain/evidence/evidence-ref.js";
import { fixedClock } from "../src/domain/shared/time.js";

const hash = `sha256:${"a".repeat(64)}`;

test("evidence references validate source identity, schema and content hash", () => {
  const evidence = createEvidenceRef({
    kind: "market-snapshot",
    schemaVersion: "market-snapshot/v1",
    producer: "bybit-demo-probe",
    sourceId: "run-1",
    asOf: "2026-09-19T10:00:00Z",
    validForMs: 1_000,
    contentHash: hash,
  });
  assert.equal(evidence.ok, true);
  if (!evidence.ok) return;
  assert.equal(evidence.value.asOf, "2026-09-19T10:00:00.000Z");

  const clock = fixedClock("2026-09-19T10:00:00.999Z");
  assert.equal(clock.ok, true);
  if (!clock.ok) return;
  assert.equal(isEvidenceFresh(evidence.value, clock.value), true);

  const staleClock = fixedClock("2026-09-19T10:00:01Z");
  assert.equal(staleClock.ok, true);
  if (!staleClock.ok) return;
  assert.equal(isEvidenceFresh(evidence.value, staleClock.value), false);
});

test("malformed evidence is rejected before planning", () => {
  const result = createEvidenceRef({
    kind: "market-snapshot",
    schemaVersion: "market-snapshot/v1",
    producer: "bybit-demo-probe",
    sourceId: "run-1",
    asOf: "not-a-timestamp",
    validForMs: 1_000,
    contentHash: hash,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "INVALID_EVIDENCE");
});

test("future-dated evidence is not fresh", () => {
  const evidence = createEvidenceRef({
    kind: "market-snapshot",
    schemaVersion: "market-snapshot/v1",
    producer: "fixture",
    sourceId: "future-run",
    asOf: "2026-09-19T10:00:01Z",
    validForMs: 60_000,
    contentHash: hash,
  });
  const clock = fixedClock("2026-09-19T10:00:00Z");
  assert.equal(evidence.ok, true);
  assert.equal(clock.ok, true);
  if (!evidence.ok || !clock.ok) return;
  assert.equal(isEvidenceFresh(evidence.value, clock.value), false);
});

test("evidence compatibility is explicit and fails closed", () => {
  const evidence = createEvidenceRef({
    kind: "capability-probe",
    schemaVersion: "capability-probe/v1",
    producer: "bybit-demo-probe",
    sourceId: "run-1",
    asOf: "2026-09-19T10:00:00Z",
    validForMs: 1_000,
    contentHash: hash,
  });
  assert.equal(evidence.ok, true);
  if (!evidence.ok) return;
  const mismatch = requireCompatibleEvidence(evidence.value, {
    kind: "capability-probe",
    producer: "different-producer",
  });
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) assert.equal(mismatch.error.code, "INCOMPATIBLE_EVIDENCE");
});
