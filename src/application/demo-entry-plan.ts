import { DecimalValue, RoundingMode } from "../domain/shared/decimal.js";
import { domainError } from "../domain/shared/errors.js";
import { hashCanonical } from "../domain/identity/plan-hash.js";
import {
  createExecutionPlan,
  type ExecutionPlan,
} from "../domain/planning/execution-plan.js";
import { normalizeOrderIntent } from "../domain/planning/normalize-order-intent.js";
import type { OrderIntent } from "../domain/planning/order-intent.js";
import { evaluateRisk } from "../domain/risk/risk-decision.js";
import {
  createStrategyConfig,
  type StrategyConfig,
} from "../domain/market/strategy-config.js";
import {
  requireTrustedCapability,
  type CapabilityRequirement,
} from "../domain/capabilities/capability.js";
import type { Clock } from "../domain/shared/time.js";
import { systemClock } from "../domain/shared/time.js";
import type {
  ExchangeReadState,
  ExchangeTimeInForce,
} from "../ports/exchange-execution.js";
import {
  createDemoEntryInput,
  type DemoEntryInput,
} from "./demo-entry-input.js";
import { deriveDemoClientOrderId } from "./execution-identity.js";
import { fail, ok, type Result } from "../domain/shared/result.js";

export interface DemoEntryPlan {
  readonly plan: ExecutionPlan;
  readonly intent: OrderIntent;
  readonly clientOrderId: string;
  readonly orderType: "Limit";
  readonly timeInForce: "GTC";
  readonly leverage: {
    readonly current: DecimalValue;
    readonly target: DecimalValue;
    readonly diff: DecimalValue;
  };
}

const TARGET_LEVERAGE = DecimalValue.fromString("1");
const PERCENT_FACTOR = DecimalValue.fromString("0.01");

function invalid(message: string): Result<never> {
  return fail(domainError("CONSTRAINT_VIOLATION", message));
}

function sameScope(
  left: ExchangeReadState["account"]["scope"],
  right: ExchangeReadState["market"]["scope"],
): boolean {
  return (
    left.exchange === right.exchange &&
    left.environment === right.environment &&
    left.category === right.category &&
    left.positionMode === right.positionMode
  );
}

function intentIdentity(input: DemoEntryInput): Result<string> {
  const digest = hashCanonical({
    identityVersion: "demo-entry-intent/v1",
    symbol: input.symbol,
    side: input.side,
    notional: input.notional,
    takeProfit: input.takeProfit,
  });
  if (!digest.ok) return digest;
  return ok(`entry-${digest.value.slice(7, 23)}`);
}

function currentPositionIsFlat(
  state: ExchangeReadState,
  symbol: string,
): boolean {
  return state.account.positions
    .filter((position) => position.instrument === symbol)
    .every(
      (position) => position.side === "flat" || position.quantity.isZero(),
    );
}

function hasActiveOrder(state: ExchangeReadState, symbol: string): boolean {
  return state.openOrders.some(
    (order) =>
      order.instrument === symbol &&
      (order.status === "open" || order.status === "partially-filled"),
  );
}

function tpPrice(
  input: DemoEntryInput,
  entryPrice: DecimalValue,
): Result<DecimalValue> {
  if (input.takeProfit.kind === "price") return ok(input.takeProfit.value);
  if (!PERCENT_FACTOR.ok) return PERCENT_FACTOR;
  const factor = input.takeProfit.value.multiply(PERCENT_FACTOR.value);
  const one = DecimalValue.fromString("1");
  if (!one.ok) return one;
  const multiplier =
    input.side === "buy" ? one.value.add(factor) : one.value.subtract(factor);
  if (!multiplier.isPositive()) {
    return invalid("take-profit percentage produces a non-positive target");
  }
  return ok(entryPrice.multiply(multiplier));
}

function capabilityRequirements(
  state: ExchangeReadState,
  clock: Clock,
): Result<readonly CapabilityRequirement[]> {
  const capabilities = [
    "order-create",
    "attached-protection",
    "reconciliation-reads",
    "set-leverage",
  ] as const;
  const requirements: CapabilityRequirement[] = [];
  for (const capability of capabilities) {
    const scope = state.account.scope;
    const requirement = { capability, scope };
    const observation = state.capabilities.find(
      (candidate) =>
        candidate.capability === capability &&
        candidate.scope.exchange === scope.exchange &&
        candidate.scope.environment === scope.environment &&
        candidate.scope.category === scope.category &&
        candidate.scope.positionMode === scope.positionMode,
    );
    if (observation === undefined) {
      return fail(
        domainError(
          "CAPABILITY_UNKNOWN",
          `required capability ${capability} is missing`,
        ),
      );
    }
    const trusted = requireTrustedCapability(observation, requirement, clock);
    if (!trusted.ok) return trusted;
    requirements.push(requirement);
  }
  return ok(Object.freeze(requirements));
}

function strategy(notional: DecimalValue): Result<StrategyConfig> {
  return createStrategyConfig({
    strategyId: "demo-managed-entry",
    version: "demo-managed-entry.v1",
    cadence: "daily",
    maxOrderNotional: notional.toString(),
    requiresProtection: true,
  });
}

export function buildDemoEntryPlan(
  rawInput: DemoEntryInput | unknown,
  state: ExchangeReadState,
  clock: Clock = systemClock,
): Result<DemoEntryPlan> {
  const parsedInput = createDemoEntryInput(rawInput);
  if (!parsedInput.ok) return parsedInput;
  const input = parsedInput.value;
  if (state.accountReadiness.status !== "ready") {
    return invalid(state.accountReadiness.reason ?? "account is not ready");
  }
  if (
    state.market.instrument !== input.symbol ||
    !sameScope(state.account.scope, state.market.scope)
  ) {
    return invalid("fresh Demo state does not match the selected symbol/scope");
  }
  if (!currentPositionIsFlat(state, input.symbol)) {
    return invalid("selected symbol must be flat before a new managed entry");
  }
  if (hasActiveOrder(state, input.symbol)) {
    return invalid("selected symbol already has an active order");
  }
  if (!TARGET_LEVERAGE.ok) return TARGET_LEVERAGE;
  const leverage = state.leverage.effective;
  if (!leverage.isPositive()) return invalid("current leverage is invalid");
  const price = input.side === "buy" ? state.market.ask : state.market.bid;
  const quantity = input.notional.divide(price, 1000, RoundingMode.DOWN);
  if (!quantity.ok) return quantity;
  const tp = tpPrice(input, price);
  if (!tp.ok) return tp;
  const intentId = intentIdentity(input);
  if (!intentId.ok) return intentId;
  const normalized = normalizeOrderIntent(
    {
      intentId: intentId.value,
      instrument: input.symbol,
      orderType: "limit",
      side: input.side,
      positionEffect: "open",
      price: price.toString(),
      quantity: quantity.value.toString(),
      rounding: { price: "floor", quantity: "floor" },
      protection: { takeProfit: tp.value.toString() },
    },
    state.market.constraints,
  );
  if (!normalized.ok) return normalized;
  const normalizedNotional = normalized.value.price.multiply(
    normalized.value.quantity,
  );
  if (normalizedNotional.compare(input.notional) > 0) {
    return invalid("normalized quantity exceeds requested notional");
  }
  if (
    input.side === "buy"
      ? normalized.value.protection?.takeProfit?.compare(
          normalized.value.price,
        ) !== 1
      : normalized.value.protection?.takeProfit?.compare(
          normalized.value.price,
        ) !== -1
  ) {
    return invalid("take-profit must remain strictly on the profit side");
  }
  const capabilities = capabilityRequirements(state, clock);
  if (!capabilities.ok) return capabilities;
  const configuredStrategy = strategy(input.notional);
  if (!configuredStrategy.ok) return configuredStrategy;
  const desiredCurrentDiff = Object.freeze({
    baseline: Object.freeze({
      position: Object.freeze({
        instrument: input.symbol,
        side: "flat" as const,
        quantity: "0",
      }),
      activeOrderCount: 0,
    }),
    exposure: Object.freeze({
      instrument: input.symbol,
      side: input.side,
      requestedNotional: input.notional.toString(),
    }),
    currentLeverage: leverage.toString(),
    targetLeverage: TARGET_LEVERAGE.value.toString(),
    leverageDiff: leverage.subtract(TARGET_LEVERAGE.value).toString(),
    orderType: "Limit" as const,
    timeInForce: "GTC" as const,
  });
  const candidate = {
    strategy: configuredStrategy.value,
    marketSnapshot: state.market,
    accountSnapshot: state.account,
    evidence: Object.freeze([
      ...state.market.evidence,
      ...state.account.evidence,
      ...state.capabilities.map((capability) => capability.evidence),
    ]),
    desiredCurrentDiff,
    orderIntents: Object.freeze([normalized.value]),
    requiredCapabilities: capabilities.value,
    executionScope: state.account.scope,
  };
  const risk = evaluateRisk({
    decisionId: `risk-${intentId.value}`,
    candidate,
    capabilities: state.capabilities,
    clock,
  });
  if (!risk.ok) return risk;
  if (risk.value.status !== "pass") {
    return fail(
      domainError(
        "CONSTRAINT_VIOLATION",
        `Demo entry risk gate blocked: ${risk.value.reasonCodes.join(",")}`,
      ),
    );
  }
  const plan = createExecutionPlan({
    identityVersion: "demo-entry-plan/v1",
    material: { ...candidate, riskDecision: risk.value },
    presentation: { generatedAt: clock.now() },
  });
  if (!plan.ok) return plan;
  const clientOrderId = deriveDemoClientOrderId(
    plan.value.materialHash,
    normalized.value.intentId,
  );
  if (!clientOrderId.ok) return clientOrderId;
  return ok(
    Object.freeze({
      plan: plan.value,
      intent: normalized.value,
      clientOrderId: clientOrderId.value,
      orderType: "Limit" as const,
      timeInForce: "GTC" as const satisfies ExchangeTimeInForce,
      leverage: Object.freeze({
        current: leverage,
        target: TARGET_LEVERAGE.value,
        diff: leverage.subtract(TARGET_LEVERAGE.value),
      }),
    }),
  );
}

export const createDemoEntryPlan = buildDemoEntryPlan;
