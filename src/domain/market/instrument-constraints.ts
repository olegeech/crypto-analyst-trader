import { domainError } from "../shared/errors.js";
import { DecimalValue } from "../shared/decimal.js";
import { fail, ok, type Result } from "../shared/result.js";
import {
  isRecord,
  requireIdentifier,
  requireSafeText,
} from "../shared/validation.js";

export interface InstrumentConstraints {
  readonly instrument: string;
  readonly version: string;
  readonly priceTickSize: DecimalValue;
  readonly quantityStep: DecimalValue;
  readonly minQuantity: DecimalValue;
  readonly minNotional?: DecimalValue;
}

function parsePositiveDecimal(
  value: unknown,
  field: string,
): Result<DecimalValue> {
  const parsed = DecimalValue.fromString(value);
  if (!parsed.ok) return parsed;
  if (!parsed.value.isPositive()) {
    return fail(
      domainError("INVALID_CONSTRAINT", `${field} must be positive`, { field }),
    );
  }
  return parsed;
}

export function createInstrumentConstraints(
  input: unknown,
): Result<InstrumentConstraints> {
  if (!isRecord(input)) {
    return fail(
      domainError("INVALID_CONSTRAINT", "constraints must be an object"),
    );
  }
  const instrument = requireIdentifier(input.instrument, "instrument");
  const version =
    input.version === undefined
      ? ok("instrument-constraints/v1")
      : requireSafeText(input.version, "version");
  const priceTickSize = parsePositiveDecimal(
    input.priceTickSize,
    "priceTickSize",
  );
  const quantityStep = parsePositiveDecimal(input.quantityStep, "quantityStep");
  const minQuantity = parsePositiveDecimal(input.minQuantity, "minQuantity");
  const minNotional =
    input.minNotional === undefined
      ? ok<DecimalValue | undefined>(undefined)
      : parsePositiveDecimal(input.minNotional, "minNotional");
  if (
    !instrument.ok ||
    !version.ok ||
    !priceTickSize.ok ||
    !quantityStep.ok ||
    !minQuantity.ok ||
    !minNotional.ok
  ) {
    return fail(
      domainError(
        "INVALID_CONSTRAINT",
        "instrument constraints contain an invalid field",
      ),
    );
  }
  const result: {
    instrument: string;
    version: string;
    priceTickSize: DecimalValue;
    quantityStep: DecimalValue;
    minQuantity: DecimalValue;
    minNotional?: DecimalValue;
  } = {
    instrument: instrument.value,
    version: version.value,
    priceTickSize: priceTickSize.value,
    quantityStep: quantityStep.value,
    minQuantity: minQuantity.value,
  };
  if (minNotional.value !== undefined) result.minNotional = minNotional.value;
  return ok(Object.freeze(result));
}
