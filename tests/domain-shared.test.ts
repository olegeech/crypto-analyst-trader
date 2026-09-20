import assert from "node:assert/strict";
import test from "node:test";

import { fail, ok } from "../src/domain/shared/result.js";
import {
  isRecord,
  requireIdentifier,
  requireSafeText,
} from "../src/domain/shared/validation.js";
import {
  fixedClock,
  isAtOrAfter,
  parseUtcTimestamp,
  timestampFromEpochMs,
} from "../src/domain/shared/time.js";

test("expected domain failures carry stable codes and structured details", () => {
  const result = fail({
    code: "INVALID_IDENTIFIER",
    message: "actor is invalid",
    details: { field: "actor" },
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "INVALID_IDENTIFIER");
    assert.deepEqual(result.error.details, { field: "actor" });
  }
  assert.deepEqual(ok("value"), { ok: true, value: "value" });
});

test("boundary validators reject unknown shapes and unsafe text", () => {
  assert.equal(isRecord(null), false);
  assert.equal(isRecord({}), true);
  assert.equal(requireIdentifier("actor-1", "actor").ok, true);
  const invalidIdentifier = requireIdentifier("", "actor");
  assert.equal(invalidIdentifier.ok, false);
  if (!invalidIdentifier.ok) {
    assert.equal(invalidIdentifier.error.code, "INVALID_IDENTIFIER");
  }
  assert.equal(requireSafeText("hello", "note").ok, true);
  const unsafe = requireSafeText("hello\u0000world", "note");
  assert.equal(unsafe.ok, false);
  if (!unsafe.ok) assert.equal(unsafe.error.code, "INVALID_TEXT");
});

test("UTC timestamps are canonical and freshness boundaries are exact", () => {
  const timestamp = parseUtcTimestamp("2026-09-19T10:00:00+00:00");
  assert.equal(timestamp.ok, true);
  if (!timestamp.ok) return;
  assert.equal(timestamp.value, "2026-09-19T10:00:00.000Z");
  const highPrecision = parseUtcTimestamp("2026-09-19T10:00:00.123456789Z");
  assert.equal(highPrecision.ok, true);
  if (highPrecision.ok)
    assert.equal(highPrecision.value, "2026-09-19T10:00:00.123Z");
  const boundary = parseUtcTimestamp("2026-09-19T10:00:00Z");
  assert.equal(boundary.ok, true);
  if (!boundary.ok) return;
  assert.equal(isAtOrAfter(timestamp.value, boundary.value), true);
  const clock = fixedClock("2026-09-19T10:00:01Z");
  assert.equal(clock.ok, true);
  if (!clock.ok) return;
  assert.equal(clock.value.now(), "2026-09-19T10:00:01.000Z");
});

test("timestamps reject normalized calendar values and out-of-range epochs", () => {
  assert.equal(parseUtcTimestamp("2026-02-30T00:00:00Z").ok, false);
  assert.equal(parseUtcTimestamp("2026-01-01T24:00:00Z").ok, false);
  assert.equal(timestampFromEpochMs(8_640_000_000_000_001).ok, false);
});
