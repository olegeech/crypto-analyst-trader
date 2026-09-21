import assert from "node:assert/strict";
import test from "node:test";

import { normalizeBybitFailure } from "../src/adapters/bybit-v5/error-mapping.js";
import { BybitOrderMappingError } from "../src/adapters/bybit-v5/order-mappers.js";
import { BybitReadMappingError } from "../src/adapters/bybit-v5/read-mappers.js";
import { BybitDemoTransportError } from "../src/adapters/bybit-v5/transport.js";

const context = {
  operation: "create" as const,
  clientOrderId: "owned-client",
};

test("transport failures become safe normalized categories with retry posture", () => {
  const ambiguous = normalizeBybitFailure(
    new BybitDemoTransportError("ambiguous-server", "ignored raw response", {
      retCode: 10016,
    }),
    context,
  );
  assert.deepEqual(ambiguous, {
    kind: "ambiguous",
    message:
      "Bybit Demo returned an ambiguous server outcome; reconcile the original identity before retrying.",
    retry: "reconcile",
    operation: "create",
    clientOrderId: "owned-client",
    exchangeCode: 10016,
  });

  const permission = normalizeBybitFailure(
    new BybitDemoTransportError("permission-denied", "secret", {
      retCode: 10005,
    }),
    context,
  );
  assert.equal(permission.kind, "permission");
  assert.equal(permission.retry, "never");
  assert.doesNotMatch(permission.message, /secret/iu);
});

test("mapping and unknown failures fail closed without leaking arbitrary messages", () => {
  const responseFailure = normalizeBybitFailure(
    new BybitReadMappingError("invalid-response", "raw private payload"),
    { operation: "read" },
  );
  assert.equal(responseFailure.kind, "invalid-response");
  assert.doesNotMatch(responseFailure.message, /raw private payload/iu);

  const requestFailure = normalizeBybitFailure(
    new BybitOrderMappingError("invalid-request", "signed header secret"),
    context,
  );
  assert.equal(requestFailure.kind, "configuration");
  assert.equal(requestFailure.retry, "never");
  assert.doesNotMatch(requestFailure.message, /signed header secret/iu);

  const unknown = normalizeBybitFailure(
    new Error("api-secret=sentinel"),
    context,
  );
  assert.equal(unknown.kind, "transport");
  assert.equal(unknown.retry, "reconcile");
  assert.doesNotMatch(unknown.message, /sentinel/iu);
});
