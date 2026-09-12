/**
 * Deliberately small, probe-local decimal arithmetic. This is not the
 * production numeric contract for #8: values stay as integer coefficients
 * and decimal scales so the diagnostic never needs binary floating point.
 */
export interface Decimal {
  readonly coefficient: bigint;
  readonly scale: number;
}

export type StepRounding = "floor" | "ceil";

function power10(scale: number): bigint {
  if (!Number.isInteger(scale) || scale < 0 || scale > 1_000) {
    throw new Error("decimal scale is out of range");
  }
  return 10n ** BigInt(scale);
}

function normalized(coefficient: bigint, scale: number): Decimal {
  if (coefficient === 0n) return { coefficient: 0n, scale: 0 };
  let nextCoefficient = coefficient;
  let nextScale = scale;
  while (nextScale > 0 && nextCoefficient % 10n === 0n) {
    nextCoefficient /= 10n;
    nextScale -= 1;
  }
  return { coefficient: nextCoefficient, scale: nextScale };
}

export function parseDecimal(value: unknown): Decimal {
  if (typeof value !== "string") {
    throw new Error("value must be a decimal string");
  }
  const match = /^(?<sign>-?)(?<whole>\d+)(?:\.(?<fraction>\d+))?$/.exec(value);
  if (!match?.groups) {
    throw new Error("value must be a decimal string without exponent or trailing characters");
  }
  const fraction = match.groups.fraction ?? "";
  const digits = `${match.groups.whole}${fraction}`;
  const unsigned = BigInt(digits);
  return normalized(match.groups.sign === "-" ? -unsigned : unsigned, fraction.length);
}

export function decimal(coefficient: bigint, scale: number): Decimal {
  return normalized(coefficient, scale);
}

export function toDecimalString(value: Decimal): string {
  const coefficient = value.coefficient;
  if (coefficient === 0n) return "0";
  const negative = coefficient < 0n;
  const digits = (negative ? -coefficient : coefficient).toString();
  const scale = value.scale;
  const padded = digits.length <= scale ? digits.padStart(scale + 1, "0") : digits;
  const splitAt = padded.length - scale;
  const text = scale === 0 ? padded : `${padded.slice(0, splitAt)}.${padded.slice(splitAt)}`;
  return negative ? `-${text}` : text;
}

function aligned(left: Decimal, right: Decimal): [bigint, bigint, number] {
  const scale = Math.max(left.scale, right.scale);
  return [
    left.coefficient * power10(scale - left.scale),
    right.coefficient * power10(scale - right.scale),
    scale,
  ];
}

export function compareDecimals(left: Decimal, right: Decimal): -1 | 0 | 1 {
  const [leftCoefficient, rightCoefficient] = aligned(left, right);
  return leftCoefficient < rightCoefficient
    ? -1
    : leftCoefficient > rightCoefficient
      ? 1
      : 0;
}

export function addDecimals(left: Decimal, right: Decimal): Decimal {
  const [leftCoefficient, rightCoefficient, scale] = aligned(left, right);
  return normalized(leftCoefficient + rightCoefficient, scale);
}

export function subtractDecimals(left: Decimal, right: Decimal): Decimal {
  const [leftCoefficient, rightCoefficient, scale] = aligned(left, right);
  return normalized(leftCoefficient - rightCoefficient, scale);
}

export function multiplyDecimals(left: Decimal, right: Decimal): Decimal {
  return normalized(left.coefficient * right.coefficient, left.scale + right.scale);
}

function integerQuotient(
  numerator: bigint,
  denominator: bigint,
  rounding: StepRounding,
): bigint {
  if (denominator <= 0n) throw new Error("decimal denominator must be positive");
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder === 0n) return quotient;
  if (rounding === "floor") return numerator < 0n ? quotient - 1n : quotient;
  return numerator < 0n ? quotient : quotient + 1n;
}

export function multiplyByRational(
  value: Decimal,
  numerator: bigint,
  denominator: bigint,
  rounding: StepRounding = "floor",
): Decimal {
  if (denominator <= 0n || numerator < 0n) {
    throw new Error("decimal rational factor must be non-negative with a positive denominator");
  }
  let reducedDenominator = denominator;
  let extraScale = 0;
  while (reducedDenominator % 10n === 0n) {
    reducedDenominator /= 10n;
    extraScale += 1;
  }
  if (reducedDenominator === 1n) {
    return normalized(value.coefficient * numerator, value.scale + extraScale);
  }
  const coefficient = integerQuotient(value.coefficient * numerator, denominator, rounding);
  return normalized(coefficient, value.scale);
}

export function ceilRatioToStep(
  numerator: Decimal,
  denominator: Decimal,
  step: Decimal,
): Decimal {
  if (
    numerator.coefficient < 0n ||
    denominator.coefficient <= 0n ||
    step.coefficient <= 0n
  ) {
    throw new Error("decimal ratio inputs must be non-negative with positive denominator and step");
  }
  const unitsNumerator =
    numerator.coefficient * power10(denominator.scale) * power10(step.scale);
  const unitsDenominator =
    denominator.coefficient * power10(numerator.scale) * step.coefficient;
  const units = integerQuotient(unitsNumerator, unitsDenominator, "ceil");
  return multiplyDecimals(step, decimal(units, 0));
}

function stepUnits(value: Decimal, step: Decimal, rounding: StepRounding): bigint {
  if (step.coefficient <= 0n) throw new Error("decimal step must be positive");
  const numerator = value.coefficient * power10(step.scale);
  const denominator = step.coefficient * power10(value.scale);
  return integerQuotient(numerator, denominator, rounding);
}

export function roundToStep(
  value: Decimal,
  step: Decimal,
  rounding: StepRounding,
): Decimal {
  return multiplyDecimals(step, decimal(stepUnits(value, step, rounding), 0));
}

export function ceilToStep(value: Decimal, step: Decimal): Decimal {
  return roundToStep(value, step, "ceil");
}

export function floorToStep(value: Decimal, step: Decimal): Decimal {
  return roundToStep(value, step, "floor");
}

export function decimalIsPositive(value: Decimal): boolean {
  return value.coefficient > 0n;
}

export function decimalIsZero(value: Decimal): boolean {
  return value.coefficient === 0n;
}

export function negateDecimal(value: Decimal): Decimal {
  return { coefficient: -value.coefficient, scale: value.scale };
}

export function absDecimal(value: Decimal): Decimal {
  return value.coefficient < 0n ? negateDecimal(value) : value;
}
