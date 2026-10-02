import { dailyEvidenceFixture } from "./daily-planning-evidence-fixtures.js";

/** Non-calibrated test configuration; never a runtime policy fallback. */
function policies() {
  return {
    decisionPolicy: {
      schemaVersion: "decision-policy/v1",
      policyVersion: "fixture-v1",
      symbolApplicability: ["BTCUSDT"],
      selectors: [
        {
          id: "return",
          source: "native",
          requestId: "return",
          kind: "close-return",
          field: "percent",
          symbol: "BTCUSDT",
          required: true,
        },
      ],
      groups: [
        {
          id: "trend",
          weight: "1",
          rules: [
            {
              id: "add",
              target: "ADD_LONG",
              support: "90",
              conditions: [
                { selectorId: "return", comparison: "gte", threshold: "0" },
              ],
            },
          ],
        },
      ],
      addLong: { supportThreshold: "80", minAgreeingGroups: 1 },
      reduceLong: { supportThreshold: "80", minAgreeingGroups: 1 },
      reductionFraction: "0.25",
    },
    planningPolicy: {
      schemaVersion: "planning-policy/v1",
      policyVersion: "fixture-v1",
      atrSelector: {
        source: "native",
        requestId: "atr",
        kind: "atr",
        field: "atr",
        symbol: "BTCUSDT",
        required: true,
      },
      anchor: "bid-capped-below-ask/v1",
      entryRounding: "floor",
      quantityRounding: "floor",
      takeProfitRounding: "ceil",
      timeInForce: "GTC",
      levels: [
        { atrOffset: "0", allocationWeight: "1", takeProfitAtrDistance: "1" },
      ],
    },
  };
}
export function dailyInputFixture(bounds = true) {
  const f = dailyEvidenceFixture(bounds);
  return { ...f, ...policies(), symbol: "BTCUSDT", allocation: "100" };
}

/** Same test policy with an optional decision operand for unavailable-branch tests. */
export function dailyDecisionInputFixture() {
  const raw = dailyInputFixture();
  return {
    ...raw,
    decisionPolicy: {
      ...raw.decisionPolicy,
      selectors: raw.decisionPolicy.selectors.map((selector) => ({
        ...selector,
        required: false,
      })),
    },
  };
}
