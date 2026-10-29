import { verifyHistoryAccountingAnchorMac } from "../application/history-accounting-anchor-authentication.js";

/**
 * Runtime-only capability shared by authenticated capture and the SQLite
 * writer. It is intentionally not serialized: JSON fields and self-consistent
 * hashes cannot assert that the Bybit GET capture boundary was used.
 */
const authenticatedWalletCaptures = new WeakMap<object, string>();

/** Mark only a capture whose detached Keychain-backed MAC has been verified. */
export function authenticateWalletAnchorCapture<T extends object>(
  value: T,
  captureMac: string,
  authenticationKey: Uint8Array,
): T {
  if (
    !verifyHistoryAccountingAnchorMac(
      value as never,
      captureMac,
      authenticationKey,
    )
  )
    return value;
  authenticatedWalletCaptures.set(value, captureMac);
  return value;
}

export function isAuthenticatedWalletAnchorCapture(value: unknown): boolean {
  return walletAnchorCaptureMac(value) !== undefined;
}

export function walletAnchorCaptureMac(value: unknown): string | undefined {
  return value !== null && typeof value === "object"
    ? authenticatedWalletCaptures.get(value)
    : undefined;
}
