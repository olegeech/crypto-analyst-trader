import { createHmac, timingSafeEqual } from "node:crypto";

import { canonicalSerialize } from "../domain/identity/canonical-serialization.js";
import type { Result } from "../domain/shared/result.js";
import { fail, ok } from "../domain/shared/result.js";
import { domainError } from "../domain/shared/errors.js";
import type { HistoryAccountingWalletAnchor } from "../ports/history-accounting-anchor-store.js";

const MAC_PREFIX = "hmac-sha256:";

type UnsignedAnchor = Omit<
  HistoryAccountingWalletAnchor,
  "contentHash" | "recordedAt"
>;

function payload(anchor: UnsignedAnchor): unknown {
  return {
    schemaVersion: anchor.schemaVersion,
    anchorId: anchor.anchorId,
    kind: anchor.kind,
    scope: anchor.scope,
    accountBinding: anchor.accountBinding,
    credentialPosture: anchor.credentialPosture,
    capture: anchor.capture,
    totals: anchor.totals,
    assets: anchor.assets,
  };
}

function canonicalPayload(anchor: UnsignedAnchor): Result<string> {
  const serialized = canonicalSerialize(payload(anchor));
  if (!serialized.ok)
    return fail(
      domainError("INVALID_EVIDENCE", "wallet anchor capture is invalid"),
    );
  return serialized;
}

export function createHistoryAccountingAnchorMac(
  anchor: UnsignedAnchor,
  key: Uint8Array,
): Result<string> {
  if (!(key instanceof Uint8Array) || key.byteLength !== 32)
    return fail(
      domainError("INVALID_EVIDENCE", "anchor authenticator is unavailable"),
    );
  const serialized = canonicalPayload(anchor);
  if (!serialized.ok) return serialized;
  const digest = createHmac("sha256", key)
    .update(serialized.value, "utf8")
    .digest("hex");
  return ok(`${MAC_PREFIX}${digest}`);
}

export function verifyHistoryAccountingAnchorMac(
  anchor: UnsignedAnchor,
  mac: unknown,
  key: Uint8Array,
): boolean {
  if (
    !(key instanceof Uint8Array) ||
    key.byteLength !== 32 ||
    typeof mac !== "string" ||
    !new RegExp(`^${MAC_PREFIX}[a-f0-9]{64}$`, "u").test(mac)
  )
    return false;
  const expected = createHistoryAccountingAnchorMac(anchor, key);
  if (!expected.ok) return false;
  const suppliedBytes = Buffer.from(mac.slice(MAC_PREFIX.length), "hex");
  const expectedBytes = Buffer.from(
    expected.value.slice(MAC_PREFIX.length),
    "hex",
  );
  return (
    suppliedBytes.length === expectedBytes.length &&
    timingSafeEqual(suppliedBytes, expectedBytes)
  );
}
