import process from "node:process";
import { pathToFileURL } from "node:url";

import { resolveProbeConfig } from "./bybit-probe/config.js";

export const PROBE_EXIT_CODES = {
  CONFIRMED_CLEAN: 0,
  REFUSED: 2,
  PRECONDITION_FAILED: 3,
  CONTRADICTION: 4,
  UNRESOLVED: 5,
} as const;

export type ProbeVerdict = keyof typeof PROBE_EXIT_CODES;

export interface ProbeRunResult {
  readonly verdict: ProbeVerdict;
  readonly message: string;
}

/** The full orchestrator is wired in after the safety modules are built. */
export async function runCapabilityProbe(): Promise<ProbeRunResult> {
  const config = resolveProbeConfig();
  return {
    verdict: "PRECONDITION_FAILED",
    message: `Bybit Testnet capability probe is not ready to run for ${config.symbol}.`,
  };
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  try {
    const result = await runCapabilityProbe();
    console.log(`${result.verdict}: ${result.message}`);
    process.exitCode = PROBE_EXIT_CODES[result.verdict];
  } catch (error) {
    console.error(
      `Bybit Testnet capability probe failed: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
    process.exitCode = PROBE_EXIT_CODES.PRECONDITION_FAILED;
  }
}
