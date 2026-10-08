import type { BybitInstrumentInfo } from "./read-mappers.js";
import { BybitReadMappingError, mapInstrumentInfo } from "./read-mappers.js";
import {
  ACCOUNT_READ_ORIGINS,
  type BybitAccountReadTransport,
} from "./account-read-transport.js";
import { requireIdentifier } from "../../domain/shared/validation.js";

const INSTRUMENTS_INFO_PATH = "/v5/market/instruments-info";

export class BybitMainnetReadCapabilityError extends Error {
  constructor(
    readonly code:
      | "ORIGIN_MISMATCH"
      | "INVALID_REQUEST"
      | "INVALID_RESPONSE"
      | "UNSUPPORTED_INSTRUMENT",
  ) {
    super(`Mainnet read capability failed: ${code}.`);
    this.name = "BybitMainnetReadCapabilityError";
  }
}

/**
 * Narrow GET-only view for proving one selected Mainnet linear instrument.
 * The injected #16 transport owns origin pinning, signing and read budgets.
 */
export class BybitMainnetReadCapabilityFacade {
  private readonly transport: BybitAccountReadTransport;

  constructor(transport: BybitAccountReadTransport) {
    if (
      transport.environment !== "mainnet" ||
      transport.origin !== ACCOUNT_READ_ORIGINS.mainnet
    ) {
      throw new BybitMainnetReadCapabilityError("ORIGIN_MISMATCH");
    }
    this.transport = transport;
  }

  async readInstrument(symbol: string): Promise<BybitInstrumentInfo> {
    if (!requireIdentifier(symbol, "symbol").ok) {
      throw new BybitMainnetReadCapabilityError("INVALID_REQUEST");
    }
    const envelope = await this.transport.get(INSTRUMENTS_INFO_PATH, {
      category: "linear",
      symbol,
    });
    try {
      return mapInstrumentInfo(envelope, symbol);
    } catch (error) {
      if (error instanceof BybitReadMappingError) {
        throw new BybitMainnetReadCapabilityError(
          error.kind === "precondition"
            ? "UNSUPPORTED_INSTRUMENT"
            : "INVALID_RESPONSE",
        );
      }
      throw error;
    }
  }
}
