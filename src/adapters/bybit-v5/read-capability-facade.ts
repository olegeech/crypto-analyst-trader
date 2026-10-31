import type { BybitInstrumentInfo } from "./read-mappers.js";
import { BybitReadMappingError, mapInstrumentInfo } from "./read-mappers.js";
import {
  ACCOUNT_READ_ORIGINS,
  type BybitAccountReadTransport,
} from "./account-read-transport.js";
import { requireIdentifier } from "../../domain/shared/validation.js";
import { RoundingMode } from "../../domain/shared/decimal.js";
import { DecimalValue } from "../../domain/shared/decimal.js";

const INSTRUMENTS_INFO_PATH = "/v5/market/instruments-info";

export class BybitMainnetReadCapabilityError extends Error {
  constructor(
    readonly code:
      | "ORIGIN_MISMATCH"
      | "INVALID_REQUEST"
      | "INVALID_RESPONSE"
      | "UNSUPPORTED_INSTRUMENT"
      | "UNSUPPORTED_LEVERAGE",
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

  async readInstrument(
    symbol: string,
    options: { readonly requireOneX?: boolean } = {},
  ): Promise<BybitInstrumentInfo> {
    if (!requireIdentifier(symbol, "symbol").ok) {
      throw new BybitMainnetReadCapabilityError("INVALID_REQUEST");
    }
    const envelope = await this.transport.get(INSTRUMENTS_INFO_PATH, {
      category: "linear",
      symbol,
    });
    try {
      if (options.requireOneX) {
        if (typeof envelope.result.category !== "string")
          throw new BybitMainnetReadCapabilityError("INVALID_RESPONSE");
        if (envelope.result.category !== "linear")
          throw new BybitMainnetReadCapabilityError("UNSUPPORTED_INSTRUMENT");
      }
      const instrument = mapInstrumentInfo(envelope, symbol, {
        requireOnlyRecord: options.requireOneX === true,
      });
      if (options.requireOneX) {
        const filter = instrument.leverageFilter;
        const one = DecimalValue.fromString("1");
        const aligned =
          filter &&
          one.ok &&
          one.value.compare(filter.min) >= 0 &&
          one.value.compare(filter.max) <= 0
            ? one.value
                .subtract(filter.min)
                .divide(filter.step, 48, RoundingMode.DOWN)
            : undefined;
        if (
          !filter ||
          !one.ok ||
          !aligned?.ok ||
          filter.min.compare(filter.max) > 0 ||
          !/^\d+$/u.test(aligned.value.toString()) ||
          filter.min
            .add(aligned.value.multiply(filter.step))
            .compare(one.value) !== 0
        )
          throw new BybitMainnetReadCapabilityError("UNSUPPORTED_LEVERAGE");
      }
      // Leverage is validated at this adapter boundary, but it is not part of
      // the account-readiness instrument contract consumed by legacy flows.
      return {
        symbol: instrument.symbol,
        status: instrument.status,
        contractType: instrument.contractType,
        quoteCoin: instrument.quoteCoin,
        settleCoin: instrument.settleCoin,
        constraints: instrument.constraints,
      };
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
