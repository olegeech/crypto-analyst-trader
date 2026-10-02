import assert from "node:assert/strict";
import test from "node:test";
import { admitQualitySource } from "../src/domain/quality/quality-inputs.js";
import {
  createQualityProfile,
  hashQualityProfile,
} from "../src/domain/quality/quality-profile.js";

const policy = () => ({
  schemaVersion: "quality-profile/v1",
  profileVersion: "m1-v1",
  roles: [{ id: "market", required: true, maxAgeMs: 60_000 }],
  metadataSkewMs: 1_000,
  trust: [],
  penalties: [
    {
      reasonCode: "INCOMPLETE_EVIDENCE",
      confidenceImpactGroup: "market",
      penalty: "15",
    },
  ],
});

test("malformed source admission retains sanitized failure, not raw payload", () => {
  const record = admitQualitySource({
    role: "market",
    value: { secret: "must-not-be-recorded" },
  });
  assert.deepEqual(record.failures, ["INVALID_EVIDENCE"]);
  assert.equal(record.value, undefined);
  assert.ok(!JSON.stringify(record).includes("must-not-be-recorded"));
});

test("quality profile validates explicit policy and canonical identity", () => {
  const result = createQualityProfile(policy());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(Object.isFrozen(result.value));
  assert.equal(result.value.penalties[0]?.penalty.toString(), "15");
  const changed = createQualityProfile({ ...policy(), metadataSkewMs: 2_000 });
  assert.ok(changed.ok);
  assert.notDeepEqual(
    hashQualityProfile(result.value),
    hashQualityProfile(changed.value),
  );
});

test("quality profile rejects unsupported, incomplete and ambiguous policy", () => {
  for (const input of [
    { ...policy(), schemaVersion: "quality-profile/v2" },
    { ...policy(), roles: [] },
    { ...policy(), roles: [{ id: "market", maxAgeMs: 60_000 }] },
    { ...policy(), roles: [policy().roles[0], policy().roles[0]] },
    {
      ...policy(),
      penalties: [
        { reasonCode: "UNKNOWN", confidenceImpactGroup: "x", penalty: "15" },
      ],
    },
    {
      ...policy(),
      penalties: [
        {
          reasonCode: "HASH_MISMATCH",
          confidenceImpactGroup: "x",
          penalty: "15",
        },
      ],
    },
    {
      ...policy(),
      penalties: [
        {
          reasonCode: "INCOMPLETE_EVIDENCE",
          confidenceImpactGroup: "x",
          penalty: "101",
        },
      ],
    },
    { ...policy(), confidenceThreshold: 60 },
  ])
    assert.equal(createQualityProfile(input).ok, false);
});
