import { DecimalValue, isDecimalValue } from "../domain/shared/decimal.js";
import { domainError } from "../domain/shared/errors.js";
import { fail, ok, type Result } from "../domain/shared/result.js";
import { isRecord, requireSafeText } from "../domain/shared/validation.js";

export type DemoEntrySide = "buy" | "sell";

export type DemoEntryTakeProfit =
  | Readonly<{ kind: "percent"; value: DecimalValue }>
  | Readonly<{ kind: "price"; value: DecimalValue }>;

export interface DemoEntryInput {
  readonly symbol: string;
  readonly side: DemoEntrySide;
  readonly notional: DecimalValue;
  readonly takeProfit: DemoEntryTakeProfit;
}

function invalid(message: string): Result<never> {
  return fail(domainError("INVALID_ARGUMENT", message));
}

function positiveDecimal(value: unknown, field: string): Result<DecimalValue> {
  const parsed = isDecimalValue(value)
    ? ok(value)
    : DecimalValue.fromString(value);
  if (!parsed.ok || !parsed.value.isPositive()) {
    return invalid(`${field} must be a positive decimal`);
  }
  return parsed;
}

function parseSymbol(value: unknown): Result<string> {
  const symbol = requireSafeText(value, "symbol");
  if (!symbol.ok || !/^[A-Z][A-Z0-9]{1,31}$/u.test(symbol.value)) {
    return invalid("symbol must be an uppercase Bybit instrument identifier");
  }
  return ok(symbol.value);
}

function parseObjectInput(
  input: Record<string, unknown>,
): Result<DemoEntryInput> {
  const symbol = parseSymbol(input.symbol);
  const notional = positiveDecimal(input.notional, "notional");
  if (!symbol.ok || !notional.ok) return invalid("Demo entry input is invalid");
  if (input.side !== "buy" && input.side !== "sell") {
    return invalid("side must be buy or sell");
  }
  const hasPercent = input.takeProfitPercent !== undefined;
  const hasPrice = input.takeProfitPrice !== undefined;
  if (hasPercent === hasPrice) {
    return invalid(
      "exactly one takeProfitPercent or takeProfitPrice is required",
    );
  }
  const rawTakeProfit = hasPercent
    ? positiveDecimal(input.takeProfitPercent, "takeProfitPercent")
    : positiveDecimal(input.takeProfitPrice, "takeProfitPrice");
  if (!rawTakeProfit.ok) return rawTakeProfit;
  return ok(
    Object.freeze({
      symbol: symbol.value,
      side: input.side,
      notional: notional.value,
      takeProfit: Object.freeze({
        kind: hasPercent ? ("percent" as const) : ("price" as const),
        value: rawTakeProfit.value,
      }),
    }),
  );
}

/**
 * Parse the small, explicit Demo command contract before credentials or a
 * network client are constructed.
 */
export function parseDemoEntryInput(
  argv: readonly string[],
): Result<DemoEntryInput> {
  const values: Record<string, unknown> = {};
  const flags = new Set<string>();
  const allowed = new Set([
    "--symbol",
    "--side",
    "--notional",
    "--take-profit-percent",
    "--take-profit-price",
  ]);
  const fields: Record<string, string> = {
    "--symbol": "symbol",
    "--side": "side",
    "--notional": "notional",
    "--take-profit-percent": "takeProfitPercent",
    "--take-profit-price": "takeProfitPrice",
  };
  for (let index = argv[0] === "--" ? 1 : 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === undefined || !allowed.has(flag)) {
      return invalid("unsupported or positional CLI argument");
    }
    if (flags.has(flag)) return invalid(`${flag} must not be repeated`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      return invalid(`${flag} requires one value`);
    }
    flags.add(flag);
    values[fields[flag] as string] = value;
    index += 1;
  }
  for (const required of ["--symbol", "--side", "--notional"] as const) {
    if (!flags.has(required)) return invalid(`${required} is required`);
  }
  return parseObjectInput(values);
}

export function createDemoEntryInput(input: unknown): Result<DemoEntryInput> {
  if (!isRecord(input)) return invalid("Demo entry input must be an object");
  if (isRecord(input.takeProfit)) {
    const symbol = parseSymbol(input.symbol);
    const notional = positiveDecimal(input.notional, "notional");
    const takeProfit = input.takeProfit;
    if (
      !symbol.ok ||
      !notional.ok ||
      (input.side !== "buy" && input.side !== "sell") ||
      (takeProfit.kind !== "percent" && takeProfit.kind !== "price") ||
      !isDecimalValue(takeProfit.value) ||
      !takeProfit.value.isPositive()
    ) {
      return invalid("Demo entry input is invalid");
    }
    return ok(
      Object.freeze({
        symbol: symbol.value,
        side: input.side,
        notional: notional.value,
        takeProfit: Object.freeze({
          kind: takeProfit.kind,
          value: takeProfit.value,
        }),
      }),
    );
  }
  return parseObjectInput(input);
}

export const parseDemoEntryArgs = parseDemoEntryInput;
