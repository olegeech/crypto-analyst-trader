import process from "node:process";

import { testnetConfig } from "../testnet-smoke.js";

export const DEFAULT_PROBE_SYMBOL = "DOGEUSDT";

export interface ProbeConfig {
  readonly environment: "testnet";
  readonly baseUrl: URL;
  readonly symbol: string;
}

/**
 * Probe-only configuration. The Testnet origin and environment check are
 * intentionally delegated to the existing smoke-test lock so the diagnostic
 * path cannot drift into a second environment policy.
 */
export function resolveProbeConfig(
  environment: Record<string, string | undefined> = process.env,
): ProbeConfig {
  const baseUrl = testnetConfig(environment);
  const symbol = environment.BYBIT_PROBE_SYMBOL ?? DEFAULT_PROBE_SYMBOL;
  if (!/^[A-Z0-9]+$/.test(symbol)) {
    throw new Error(
      "BYBIT_PROBE_SYMBOL must contain only uppercase letters and digits",
    );
  }

  return { environment: "testnet", baseUrl, symbol };
}
