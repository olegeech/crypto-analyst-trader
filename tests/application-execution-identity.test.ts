import assert from "node:assert/strict";
import test from "node:test";

import { deriveDemoClientOrderId } from "../src/application/execution-identity.js";

const planHash = `sha256:${"a".repeat(64)}`;

test("client order identity is deterministic, bounded and plan-bound", () => {
  const first = deriveDemoClientOrderId(planHash, "entry-intent");
  const repeated = deriveDemoClientOrderId(planHash, "entry-intent");
  const changed = deriveDemoClientOrderId(
    `sha256:${"b".repeat(64)}`,
    "entry-intent",
  );
  assert.equal(first.ok, true);
  assert.equal(repeated.ok, true);
  assert.equal(changed.ok, true);
  if (first.ok && repeated.ok && changed.ok) {
    assert.equal(first.value, repeated.value);
    assert.equal(first.value.length, 36);
    assert.notEqual(first.value, changed.value);
    assert.match(first.value, /^demo-[a-f0-9]+$/u);
  }
});
