import assert from "node:assert/strict";
import test from "node:test";

import { authorizationTimeForCreate } from "../src/application/mainnet-operator-test-composition.js";
import type { UtcTimestamp } from "../src/domain/shared/time.js";

test("transport expiry uses local time for direct commands and provider time for legacy approval", () => {
  const localAfterExpiry = "2026-10-31T10:15:00.001Z" as UtcTimestamp;
  const providerBeforeExpiry = "2026-10-31T10:14:59.900Z" as UtcTimestamp;

  assert.equal(
    authorizationTimeForCreate(
      "trade-command",
      localAfterExpiry,
      providerBeforeExpiry,
    ),
    localAfterExpiry,
  );
  assert.equal(
    authorizationTimeForCreate(
      "approval",
      localAfterExpiry,
      providerBeforeExpiry,
    ),
    providerBeforeExpiry,
  );
  assert.equal(
    authorizationTimeForCreate(
      "trade-command",
      undefined,
      providerBeforeExpiry,
    ),
    undefined,
  );
});
