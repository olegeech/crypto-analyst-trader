import Big from "big.js";

import { domainError } from "./errors.js";
import { fail, ok, type Result } from "./result.js";

const DecimalConstructor = Big();
DecimalConstructor.strict = true;
DecimalConstructor.DP = 1000;
DecimalConstructor.RM = DecimalConstructor.roundHalfUp;
DecimalConstructor.NE = -1_000_000;
DecimalConstructor.PE = 1_000_000;
const ZERO = new DecimalConstructor("0");

const DECIMAL_STRING_PATTERN = /^-?\d+(?:\.\d+)?$/u;

export enum RoundingMode {
  DOWN = "down",
  UP = "up",
  HALF_UP = "half-up",
  HALF_EVEN = "half-even",
}

function libraryRoundingMode(mode: RoundingMode): Big.RoundingMode {
  switch (mode) {
    case RoundingMode.DOWN:
      return DecimalConstructor.roundDown;
    case RoundingMode.UP:
      return DecimalConstructor.roundUp;
    case RoundingMode.HALF_EVEN:
      return DecimalConstructor.roundHalfEven;
    case RoundingMode.HALF_UP:
      return DecimalConstructor.roundHalfUp;
  }
}

function canonicalString(value: Big.Big): string {
  const fixed = value.toFixed();
  const negative = fixed.startsWith("-");
  const unsigned = negative ? fixed.slice(1) : fixed;
  const [integerPart = "0", fractionPart = ""] = unsigned.split(".");
  const normalizedInteger = integerPart.replace(/^0+(?=\d)/u, "") || "0";
  const normalizedFraction = fractionPart.replace(/0+$/u, "");
  const result = normalizedFraction
    ? `${normalizedInteger}.${normalizedFraction}`
    : normalizedInteger;
  return negative && result !== "0" ? `-${result}` : result;
}

function invalidDecimal(message: string, field = "value"): Result<never> {
  return fail(domainError("INVALID_DECIMAL", message, { field }));
}

export class DecimalValue {
  #numeric: Big.Big;

  private constructor(numeric: Big.Big) {
    this.#numeric = numeric;
    Object.freeze(this);
  }

  public static fromString(value: unknown): Result<DecimalValue> {
    if (typeof value !== "string" || !DECIMAL_STRING_PATTERN.test(value)) {
      return invalidDecimal("decimal values must be plain decimal strings");
    }
    try {
      return ok(new DecimalValue(new DecimalConstructor(value)));
    } catch {
      return invalidDecimal("decimal value could not be constructed");
    }
  }

  public toString(): string {
    return canonicalString(this.#numeric);
  }

  public toJSON(): string {
    return this.toString();
  }

  public add(other: DecimalValue): DecimalValue {
    return new DecimalValue(this.#numeric.add(other.#numeric));
  }

  public subtract(other: DecimalValue): DecimalValue {
    return new DecimalValue(this.#numeric.minus(other.#numeric));
  }

  public multiply(other: DecimalValue): DecimalValue {
    return new DecimalValue(this.#numeric.times(other.#numeric));
  }

  public divide(
    other: DecimalValue,
    decimalPlaces: number,
    mode: RoundingMode,
  ): Result<DecimalValue> {
    if (other.isZero()) {
      return fail(domainError("DIVISION_BY_ZERO", "cannot divide by zero"));
    }
    if (!Number.isSafeInteger(decimalPlaces) || decimalPlaces < 0) {
      return invalidDecimal(
        "decimal places must be a non-negative safe integer",
      );
    }
    const previousRoundingMode = DecimalConstructor.RM;
    DecimalConstructor.RM = libraryRoundingMode(mode);
    try {
      return ok(
        new DecimalValue(
          this.#numeric
            .div(other.#numeric)
            .round(decimalPlaces, libraryRoundingMode(mode)),
        ),
      );
    } catch {
      return invalidDecimal("division could not be represented");
    } finally {
      DecimalConstructor.RM = previousRoundingMode;
    }
  }

  public compare(other: DecimalValue): -1 | 0 | 1 {
    return this.#numeric.cmp(other.#numeric);
  }

  public isZero(): boolean {
    return this.#numeric.eq(ZERO);
  }

  public isPositive(): boolean {
    return this.#numeric.gt(ZERO);
  }

  public isNegative(): boolean {
    return this.#numeric.lt(ZERO);
  }

  public roundToScale(scale: number, mode: RoundingMode): DecimalValue {
    return new DecimalValue(
      this.#numeric.round(scale, libraryRoundingMode(mode)),
    );
  }

  public floorToStep(step: DecimalValue): Result<DecimalValue> {
    return roundToStep(this, step, RoundingMode.DOWN);
  }

  public ceilToStep(step: DecimalValue): Result<DecimalValue> {
    return roundToStep(this, step, RoundingMode.UP);
  }
}

function roundToStep(
  value: DecimalValue,
  step: DecimalValue,
  mode: RoundingMode.DOWN | RoundingMode.UP,
): Result<DecimalValue> {
  if (!step.isPositive()) {
    return invalidDecimal("step must be positive", "step");
  }
  const quotientResult = value.divide(step, 1000, RoundingMode.DOWN);
  if (!quotientResult.ok) return quotientResult;
  const effectiveMode = value.isNegative()
    ? mode === RoundingMode.DOWN
      ? RoundingMode.UP
      : RoundingMode.DOWN
    : mode;
  const rounded = quotientResult.value.roundToScale(0, effectiveMode);
  return ok(rounded.multiply(step));
}

export function parseDecimal(value: unknown): Result<DecimalValue> {
  return DecimalValue.fromString(value);
}

export function floorToStep(
  value: DecimalValue,
  step: DecimalValue,
): Result<DecimalValue> {
  return value.floorToStep(step);
}

export function ceilToStep(
  value: DecimalValue,
  step: DecimalValue,
): Result<DecimalValue> {
  return value.ceilToStep(step);
}

export function isDecimalValue(value: unknown): value is DecimalValue {
  return value instanceof DecimalValue;
}
