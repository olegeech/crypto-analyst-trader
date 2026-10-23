import {
  responseList,
  type BybitResponse,
} from "../adapters/bybit-v5/transport.js";
import type { OperatorMainnetTestPlan } from "../domain/execution/operator-mainnet-test-plan.js";
import { DecimalValue } from "../domain/shared/decimal.js";
import { domainError } from "../domain/shared/errors.js";
import { fail } from "../domain/shared/result.js";
import { timestampFromEpochMs } from "../domain/shared/time.js";
import type { MainnetExchangeExecutionPort } from "../ports/exchange-execution.js";
import {
  createOperatorMainnetFeeRateEvidence,
  validateMainnetOperatorTestEvidence,
  type MainnetOperatorTestFreshEvidence,
} from "./mainnet-entry-evidence.js";

/** Only code-owned diagnostics cross the collection boundary; never provider messages. */
export class OperatorEvidenceReadError extends Error {
  constructor(readonly reasonCode: string) {
    super("operator admission evidence unavailable");
  }
}

export function extractOperatorFeeRate(
  response: BybitResponse,
  symbol: string,
) {
  const invalid = () =>
    fail(
      domainError("INVALID_EVIDENCE", "fee-rate response is invalid", {
        reasonCode: "FEE_RATE_RESPONSE_INVALID",
      }),
    );
  const rows = responseList(response);
  if (
    !rows ||
    rows.length !== 1 ||
    response.retCode !== 0 ||
    response.time === undefined ||
    !Number.isSafeInteger(response.time) ||
    response.time <= 0
  )
    return invalid();
  const row = rows[0];
  if (
    !row ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(row)) ||
    !Object.values(Object.getOwnPropertyDescriptors(row)).every((d) =>
      Object.hasOwn(d, "value"),
    ) ||
    row.symbol !== symbol ||
    typeof row.makerFeeRate !== "string" ||
    typeof row.takerFeeRate !== "string"
  )
    return invalid();
  // RPI orders are not used by this flow. Validate the optional rate, including
  // rebates. Bybit also returns an empty string when this optional rate is
  // unavailable; normal maker/taker rates still own the capital reserve.
  if (Object.hasOwn(row, "rpiMakerFeeRate") && row.rpiMakerFeeRate !== "") {
    const rpi = DecimalValue.fromString(row.rpiMakerFeeRate);
    const lower = DecimalValue.fromString("-1");
    const upper = DecimalValue.fromString("1");
    if (
      !rpi.ok ||
      !lower.ok ||
      !upper.ok ||
      rpi.value.compare(lower.value) <= 0 ||
      rpi.value.compare(upper.value) >= 0
    )
      return invalid();
  }
  const observedAt = timestampFromEpochMs(response.time);
  if (!observedAt.ok) return invalid();
  const result = createOperatorMainnetFeeRateEvidence({
    schemaVersion: "bybit-mainnet-operator-fee-rate/v1",
    symbol,
    makerFeeRate: row.makerFeeRate,
    takerFeeRate: row.takerFeeRate,
    observedAt: observedAt.value,
  });
  return result.ok ? result : invalid();
}

async function readStage<T>(code: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch {
    throw new OperatorEvidenceReadError(code);
  }
}

/** Shared by production admission and GET-only diagnostics; this module has no write authority. */
export async function collectOperatorAdmissionEvidence(
  plan: OperatorMainnetTestPlan,
  base: Pick<
    MainnetOperatorTestFreshEvidence,
    "account" | "readiness" | "instrument"
  >,
  reads: {
    readonly fee: () => Promise<BybitResponse>;
    readonly quote: () => Promise<MainnetOperatorTestFreshEvidence["quote"]>;
    readonly state: () => ReturnType<MainnetExchangeExecutionPort["readState"]>;
  },
) {
  const response = await readStage("FEE_RATE_READ_FAILED", reads.fee);
  const feeRate = extractOperatorFeeRate(response, plan.symbol);
  if (!feeRate.ok)
    throw new OperatorEvidenceReadError("FEE_RATE_RESPONSE_INVALID");
  const quote = await readStage("QUOTE_READ_FAILED", reads.quote);
  const state = await readStage("TARGET_STATE_READ_FAILED", reads.state);
  if (!state.ok)
    throw new OperatorEvidenceReadError("TARGET_STATE_READ_FAILED");
  const fresh: MainnetOperatorTestFreshEvidence = {
    ...base,
    quote,
    state: state.value,
    feeRate: feeRate.value,
  };
  const validated = validateMainnetOperatorTestEvidence(plan, fresh);
  if (!validated.ok) {
    const code = validated.error.details?.reasonCode;
    throw new OperatorEvidenceReadError(
      typeof code === "string" && /^[A-Z][A-Z0-9_]{0,99}$/u.test(code)
        ? code
        : "ADMISSION_EVIDENCE_INVALID",
    );
  }
  return { fresh, ages: validated.value };
}
