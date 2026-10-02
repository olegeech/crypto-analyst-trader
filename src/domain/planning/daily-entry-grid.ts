import { hashCanonical } from "../identity/canonical-serialization.js";
import { type DecimalValue, RoundingMode } from "../shared/decimal.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { domainError } from "../shared/errors.js";
import { fail, ok, type Result } from "../shared/result.js";
import { requireHash } from "../shared/validation.js";
import type { DailyRecommendation } from "./decision-policy.js";
import type { DailyPlanningInputs } from "./daily-planning-inputs.js";
import { normalizeOrderIntent } from "./normalize-order-intent.js";
import type { OrderIntent } from "./order-intent.js";
import { planningConstant } from "./planning-validation.js";

export interface DailyCandidateLeg {
  readonly legId: string;
  readonly index: number;
  readonly allocation: DecimalValue;
  readonly timeInForce: "GTC";
  readonly intent: OrderIntent;
}
function invalid(reason = "INVALID_GRID"): Result<never> {
  return fail(domainError("CONSTRAINT_VIOLATION", reason));
}
/** Pure static normalization, not capacity/risk clearance or maker/acceptance proof. */
export function compileDailyEntryGrid(
  input: DailyPlanningInputs,
  recommendation: DailyRecommendation,
  seed: string,
): Result<readonly DailyCandidateLeg[]> {
  if (recommendation !== "ADD_LONG" || !requireHash(seed, "seed").ok)
    return invalid();
  const constraints = input.constraints;
  const { minPrice, maxPrice, maxLimitQuantity } = constraints;
  if (!minPrice || !maxPrice || !maxLimitQuantity)
    return invalid("MISSING_STATIC_BOUNDS");
  if (!input.atr.isPositive() || !input.allocation.isPositive())
    return invalid();
  const belowAsk = input.ticker.ask.subtract(constraints.priceTickSize);
  const rawAnchor =
    input.ticker.bid.compare(belowAsk) <= 0 ? input.ticker.bid : belowAsk;
  const anchor = rawAnchor.floorToStep(constraints.priceTickSize);
  if (!anchor.ok || !anchor.value.isPositive()) return invalid();
  const prices = new Set<string>();
  const legs: DailyCandidateLeg[] = [];
  let total = planningConstant("0");
  for (const [index, level] of input.planningPolicy.levels.entries()) {
    const entry = anchor.value
      .subtract(input.atr.multiply(level.atrOffset))
      .floorToStep(constraints.priceTickSize);
    if (
      !entry.ok ||
      !entry.value.isPositive() ||
      entry.value.compare(minPrice) < 0 ||
      entry.value.compare(maxPrice) > 0 ||
      entry.value.compare(input.ticker.bid) > 0 ||
      entry.value.compare(input.ticker.ask) >= 0 ||
      prices.has(entry.value.toString())
    )
      return invalid();
    prices.add(entry.value.toString());
    const budget = input.allocation.multiply(level.allocationWeight);
    // Integer step count avoids double rounding or upward allocation creep.
    const steps = budget.divide(
      entry.value.multiply(constraints.quantityStep),
      0,
      RoundingMode.DOWN,
    );
    if (!steps.ok) return invalid();
    const quantity = steps.value.multiply(constraints.quantityStep);
    if (!quantity.isPositive() || quantity.compare(maxLimitQuantity) > 0)
      return invalid();
    const tp = entry.value
      .add(input.atr.multiply(level.takeProfitAtrDistance))
      .ceilToStep(constraints.priceTickSize);
    if (
      !tp.ok ||
      tp.value.compare(entry.value) <= 0 ||
      tp.value.compare(minPrice) < 0 ||
      tp.value.compare(maxPrice) > 0
    )
      return invalid("PROTECTION_REQUIRED");
    const legHash = hashCanonical({
      schemaVersion: "daily-leg-id/v1",
      seed,
      index,
    });
    const intentHash = hashCanonical({
      schemaVersion: "daily-intent-id/v1",
      seed,
      index,
    });
    if (!legHash.ok || !intentHash.ok) return invalid();
    const intent = normalizeOrderIntent(
      {
        intentId: `daily-intent:${intentHash.value}`,
        instrument: input.symbol,
        orderType: "limit",
        side: "buy",
        positionEffect: "open",
        price: entry.value.toString(),
        quantity: quantity.toString(),
        protection: { takeProfit: tp.value.toString() },
        rounding: { price: "floor", quantity: "floor" },
      },
      constraints,
    );
    if (!intent.ok) return invalid();
    if (
      !intent.value.protection?.takeProfit ||
      intent.value.protection.takeProfit.compare(tp.value) !== 0 ||
      intent.value.protection.stopLoss !== undefined ||
      intent.value.notional.compare(budget) > 0
    )
      return invalid();
    total = total.add(intent.value.notional);
    legs.push({
      legId: `daily-leg:${legHash.value}`,
      index,
      allocation: budget,
      timeInForce: "GTC",
      intent: intent.value,
    });
  }
  if (legs.length === 0 || total.compare(input.allocation) > 0)
    return invalid();
  return ok(deepFreeze(legs));
}
