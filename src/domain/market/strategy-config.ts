import { domainError } from "../shared/errors.js";
import { DecimalValue } from "../shared/decimal.js";
import { fail, ok, type Result } from "../shared/result.js";
import { isRecord, requireIdentifier } from "../shared/validation.js";

export interface StrategyConfig {
  readonly strategyId: string;
  readonly version: string;
  readonly cadence: "daily";
  readonly maxOrderNotional: DecimalValue;
  readonly requiresProtection: boolean;
}

export function createStrategyConfig(input: unknown): Result<StrategyConfig> {
  if (!isRecord(input))
    return fail(
      domainError("INVALID_VALUE", "strategy config must be an object"),
    );
  const strategyId = requireIdentifier(input.strategyId, "strategyId");
  const version = requireIdentifier(input.version, "version");
  const maxOrderNotional = DecimalValue.fromString(input.maxOrderNotional);
  if (!maxOrderNotional.ok || !maxOrderNotional.value.isPositive()) {
    return fail(
      domainError("INVALID_VALUE", "maxOrderNotional must be positive"),
    );
  }
  if (
    input.cadence !== "daily" ||
    typeof input.requiresProtection !== "boolean"
  ) {
    return fail(
      domainError(
        "INVALID_VALUE",
        "strategy config is not a daily M0 contract",
      ),
    );
  }
  if (!strategyId.ok || !version.ok) {
    return fail(
      domainError("INVALID_VALUE", "strategy identifiers are invalid"),
    );
  }
  return ok(
    Object.freeze({
      strategyId: strategyId.value,
      version: version.value,
      cadence: "daily" as const,
      maxOrderNotional: maxOrderNotional.value,
      requiresProtection: input.requiresProtection,
    }),
  );
}
