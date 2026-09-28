import { DecimalValue, RoundingMode } from "../shared/decimal.js";

export const ANALYTICS_FEATURE_OUTPUT_SCALE = 18;
export const ANALYTICS_FEATURE_ROUNDING = RoundingMode.HALF_EVEN;

export function analyticsDecimalConstant(value: string): DecimalValue {
  const result = DecimalValue.fromString(value);
  if (!result.ok) {
    throw new Error(`invalid analytics decimal constant: ${value}`);
  }
  return result.value;
}
