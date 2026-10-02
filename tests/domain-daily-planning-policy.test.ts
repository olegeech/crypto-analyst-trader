import assert from "node:assert/strict";
import test from "node:test";
import {
  createDecisionPolicy,
  decisionPolicyHash,
} from "../src/domain/planning/decision-policy.js";
import {
  createPlanningPolicy,
  planningPolicyHash,
} from "../src/domain/planning/planning-policy.js";
import { createBlockedDailyPlanningResult } from "../src/domain/planning/daily-planning-result.js";
import { parseDecimal } from "../src/domain/shared/decimal.js";

// Explicit, non-calibrated fixtures; never a runtime trading preset.
function decision() {
  return {
    schemaVersion: "decision-policy/v1",
    policyVersion: "test-v1",
    symbolApplicability: ["BTCUSDT"],
    selectors: [
      {
        id: "return",
        source: "native",
        requestId: "btc-return",
        kind: "close-return",
        field: "percent",
        symbol: "BTCUSDT",
        required: true,
      },
    ],
    groups: ["a", "b"].map((id) => ({
      id,
      weight: "0.5",
      rules: [
        {
          id: `${id}-add`,
          target: "ADD_LONG",
          support: "80",
          conditions: [
            { selectorId: "return", comparison: "gt", threshold: "0" },
          ],
        },
        {
          id: `${id}-hold`,
          target: "HOLD_LONG",
          support: "60",
          conditions: [
            { selectorId: "return", comparison: "lte", threshold: "0" },
          ],
        },
      ],
    })),
    addLong: { supportThreshold: "70", minAgreeingGroups: 2 },
    reduceLong: { supportThreshold: "70", minAgreeingGroups: 2 },
    reductionFraction: "0.25",
  };
}
function planning() {
  return {
    schemaVersion: "planning-policy/v1",
    policyVersion: "test-v1",
    atrSelector: {
      source: "native",
      requestId: "btc-atr",
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
      { atrOffset: "0", allocationWeight: "0.4", takeProfitAtrDistance: "1" },
      { atrOffset: "1", allocationWeight: "0.6", takeProfitAtrDistance: "2" },
    ],
  };
}
test("explicit policies parse, deeply freeze and JSON roundtrip Decimal values", () => {
  const d = createDecisionPolicy(decision());
  const p = createPlanningPolicy(planning());
  assert.ok(d.ok);
  assert.ok(p.ok);
  assert.equal(d.value.groups[0]!.weight.toString(), "0.5");
  assert.equal(p.value.levels[1]!.allocationWeight.toString(), "0.6");
  assert.ok(Object.isFrozen(d.value.groups[0]!.rules[0]!.conditions));
  assert.ok(Object.isFrozen(p.value.levels[0]));
  assert.deepEqual(
    createDecisionPolicy(JSON.parse(JSON.stringify(d.value))),
    d,
  );
  assert.deepEqual(
    createPlanningPolicy(JSON.parse(JSON.stringify(p.value))),
    p,
  );
  assert.deepEqual(createDecisionPolicy(d.value), d);
});
test("unordered policy permutations and equivalent decimals preserve identity", () => {
  const a = decision();
  const b = decision();
  b.groups.reverse();
  b.groups.forEach((g) => g.rules.reverse());
  b.groups[0]!.weight = "0.500";
  assert.deepEqual(decisionPolicyHash(a), decisionPolicyHash(b));
  b.groups[0]!.rules[0]!.support = "59";
  assert.notDeepEqual(decisionPolicyHash(a), decisionPolicyHash(b));
  const p = planning();
  const q = planning();
  q.levels[1]!.takeProfitAtrDistance = "3";
  assert.notDeepEqual(planningPolicyHash(p), planningPolicyHash(q));
});
test("decision grammar rejects malformed policies", () => {
  const mutations: ((p: ReturnType<typeof decision>) => void)[] = [
    (p) => {
      p.schemaVersion = "decision-policy/v2";
    },
    (p) => {
      Object.assign(p, { code: "execute()" });
    },
    (p) => {
      p.groups[1]!.id = "a";
    },
    (p) => {
      p.groups[1]!.rules[0]!.id = "a-add";
    },
    (p) => {
      p.selectors.push({ ...p.selectors[0]! });
    },
    (p) => {
      p.groups[0]!.weight = "0.4";
    },
    (p) => {
      p.groups[0]!.weight = "0";
    },
    (p) => {
      p.groups[0]!.rules[0]!.support = "101";
    },
    (p) => {
      p.groups[0]!.rules[0]!.target = "ADD_SHORT";
    },
    (p) => {
      p.groups[0]!.rules[0]!.conditions[0]!.comparison = "exec";
    },
    (p) => {
      p.groups[0]!.rules[0]!.conditions[0]!.selectorId = "missing";
    },
    (p) => {
      p.addLong.supportThreshold = "0";
    },
    (p) => {
      p.reduceLong.minAgreeingGroups = 3;
    },
    (p) => {
      p.addLong.minAgreeingGroups = 1.5;
    },
    (p) => {
      p.reductionFraction = "0";
    },
    (p) => {
      p.reductionFraction = "1.1";
    },
    (p) => {
      p.groups[0]!.rules = [];
    },
    (p) => {
      p.groups[0]!.rules[0]!.conditions = [];
    },
    (p) => {
      p.selectors[0]!.field = "atr";
    },
    (p) => {
      p.selectors[0]!.symbol = "ETHUSDT";
    },
    (p) => {
      Object.assign(p.groups[0]!.rules[0]!.conditions[0]!, { threshold: 1 });
    },
    (p) => {
      p.groups = Array.from({ length: 33 }, (_, i) => ({
        ...p.groups[0]!,
        id: `g${i}`,
      }));
    },
  ];
  for (const mutate of mutations) {
    const input = decision();
    mutate(input);
    assert.equal(createDecisionPolicy(input).ok, false, JSON.stringify(input));
  }
});
test("selector vocabulary is closed and external applicability/direction explicit", () => {
  const base = decision();
  const selectors = [
    {
      id: "return",
      source: "ticker",
      symbol: "BTCUSDT",
      field: "fundingRate",
      required: false,
    },
    {
      id: "return",
      source: "native",
      requestId: "liq",
      kind: "liquidation-window",
      asset: "BTC",
      field: "imbalance",
      required: false,
    },
    {
      id: "return",
      source: "external",
      family: "early-warning-risk",
      field: "score",
      direction: "higher-is-warning",
      applicability: { scope: "global", symbols: ["BTCUSDT"] },
      required: false,
    },
    {
      id: "return",
      source: "external",
      family: "trap",
      field: "reversal",
      applicability: { scope: "symbol", symbol: "BTCUSDT" },
      required: false,
    },
  ];
  for (const selector of selectors)
    assert.ok(createDecisionPolicy({ ...base, selectors: [selector] }).ok);
  for (const selector of [
    { ...selectors[0], field: "arbitrary.path" },
    { ...selectors[2], direction: "higher-is-healthier" },
    { ...selectors[2], applicability: undefined },
    { ...selectors[3], field: "score" },
    { ...selectors[1], asset: "ETH" },
  ])
    assert.equal(
      createDecisionPolicy({ ...base, selectors: [selector] }).ok,
      false,
    );
});
test("planning grammar rejects unsafe levels, missing ATR and SL/TIF overrides", () => {
  const mutations: ((p: ReturnType<typeof planning>) => void)[] = [
    (p) => {
      p.levels.reverse();
    },
    (p) => {
      p.levels[1]!.atrOffset = "0";
    },
    (p) => {
      p.levels[0]!.atrOffset = "-1";
    },
    (p) => {
      p.levels[0]!.takeProfitAtrDistance = "0";
    },
    (p) => {
      p.levels[0]!.allocationWeight = "0";
    },
    (p) => {
      p.levels[0]!.allocationWeight = "0.3";
    },
    (p) => {
      Object.assign(p, { stopLoss: "10" });
    },
    (p) => {
      Object.assign(p.levels[0]!, { stopLoss: "10" });
    },
    (p) => {
      p.timeInForce = "IOC";
    },
    (p) => {
      p.atrSelector.required = false;
    },
    (p) => {
      p.atrSelector.field = "normalizedPercent";
    },
    (p) => {
      p.entryRounding = "ceil";
    },
    (p) => {
      p.levels = [];
    },
    (p) => {
      p.levels = Array.from({ length: 65 }, (_, i) => ({
        atrOffset: String(i),
        allocationWeight: "1",
        takeProfitAtrDistance: "1",
      }));
    },
  ];
  for (const mutate of mutations) {
    const input = planning();
    mutate(input);
    assert.equal(createPlanningPolicy(input).ok, false);
  }
});
test("blocked preparations cannot carry decisions, intents or authority", () => {
  const input = {
    status: "blocked",
    reasons: [
      {
        code: "MISSING_EVIDENCE_CONFIDENCE",
        message: "quality assessment has no confidence",
      },
    ],
    diagnosticIdentities: {},
  };
  const result = createBlockedDailyPlanningResult(input);
  assert.ok(result.ok);
  assert.ok(Object.isFrozen(result.value.reasons));
  for (const field of [
    "decision",
    "plan",
    "orderIntents",
    "approval",
    "accountSnapshot",
  ])
    assert.equal(
      createBlockedDailyPlanningResult({ ...input, [field]: {} }).ok,
      false,
    );
  assert.equal(
    createBlockedDailyPlanningResult({ ...input, reasons: [] }).ok,
    false,
  );
  assert.equal(
    createBlockedDailyPlanningResult({
      ...input,
      reasons: [{ code: "BOGUS", message: "bad" }],
    }).ok,
    false,
  );
});

test("selector and AND condition permutations preserve canonical identity", () => {
  const a = decision();
  a.selectors.push({
    ...a.selectors[0]!,
    id: "other",
    requestId: "another-return",
  });
  a.groups[0]!.rules[0]!.conditions.push({
    selectorId: "other",
    comparison: "lt",
    threshold: "10",
  });
  const b = structuredClone(a);
  b.selectors.reverse();
  b.groups[0]!.rules[0]!.conditions.reverse();
  const left = decisionPolicyHash(a);
  assert.ok(left.ok);
  assert.deepEqual(left, decisionPolicyHash(b));
  b.groups[0]!.rules[0]!.conditions.push({
    ...b.groups[0]!.rules[0]!.conditions[0]!,
  });
  assert.deepEqual(left, decisionPolicyHash(b));
});

test("domain Decimals, signed comparisons and exact boundary values are accepted", () => {
  const a = decision();
  a.reductionFraction = "1";
  a.groups[0]!.rules[0]!.support = "0";
  a.addLong.supportThreshold = "100";
  a.groups[0]!.rules[0]!.conditions[0]!.threshold = "-0.001";
  assert.ok(createDecisionPolicy(a).ok);
  const half = parseDecimal("0.5");
  assert.ok(half.ok);
  assert.ok(
    createDecisionPolicy({
      ...a,
      groups: a.groups.map((g) => ({ ...g, weight: half.value })),
    }).ok,
  );
  assert.equal(
    createDecisionPolicy({
      ...a,
      reductionFraction: "0." + "0".repeat(128) + "1",
    }).ok,
    false,
  );
});

test("every native numeric field is accepted only for its declared kind and context", () => {
  const fields = {
    "close-return": ["percent"],
    "maximum-drawdown": ["percent"],
    atr: ["atr", "normalizedPercent"],
    "realized-volatility": ["percent"],
    "volatility-comparison": ["recentPercent", "referencePercent", "ratio"],
    "funding-change": ["change"],
    "open-interest-absolute-change": ["change"],
    "open-interest-relative-change": ["percent"],
    "liquidation-window": ["longUsd", "shortUsd", "totalUsd", "imbalance"],
  };
  for (const [kind, names] of Object.entries(fields))
    for (const field of names) {
      const selector = {
        id: "return",
        source: "native",
        requestId: "request",
        kind,
        field,
        required: false,
        ...(kind === "liquidation-window"
          ? { asset: "BTC" }
          : { symbol: "BTCUSDT" }),
      };
      assert.ok(
        createDecisionPolicy({ ...decision(), selectors: [selector] }).ok,
      );
      assert.equal(
        createDecisionPolicy({
          ...decision(),
          selectors: [{ ...selector, field: "relation" }],
        }).ok,
        false,
      );
    }
});

test("nested unknown fields, accessors, sparse lists and oversized AND lists fail closed", () => {
  const a = decision();
  assert.equal(
    createDecisionPolicy({
      ...a,
      groups: [{ ...a.groups[0], weight: "1", extra: true }],
    }).ok,
    false,
  );
  assert.equal(
    createDecisionPolicy({ ...a, addLong: { ...a.addLong, weight: "1" } }).ok,
    false,
  );
  let invoked = false;
  const getter = { ...a };
  Object.defineProperty(getter, "groups", {
    get() {
      invoked = true;
      return a.groups;
    },
  });
  assert.equal(createDecisionPolicy(getter).ok, false);
  assert.equal(invoked, false);
  a.groups[0]!.rules[0]!.conditions = Array.from({ length: 17 }, () => ({
    selectorId: "return",
    comparison: "lt",
    threshold: "1",
  }));
  assert.equal(createDecisionPolicy(a).ok, false);
  const sparse = decision();
  sparse.selectors.length = 2;
  assert.equal(createDecisionPolicy(sparse).ok, false);
  const blocked = {
    status: "blocked",
    reasons: [{ code: "INVALID_POLICY", message: "bad" }],
    diagnosticIdentities: { marketHash: "bad" },
  };
  assert.equal(createBlockedDailyPlanningResult(blocked).ok, false);
});

test("policies support the entire configured M1 symbol and asset universe", () => {
  const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "DOGEUSDT"];
  for (const symbol of symbols) {
    assert.ok(
      createDecisionPolicy({
        ...decision(),
        symbolApplicability: [symbol],
        selectors: [{ ...decision().selectors[0], symbol }],
      }).ok,
    );
    assert.ok(
      createDecisionPolicy({
        ...decision(),
        symbolApplicability: [symbol],
        selectors: [
          {
            id: "return",
            source: "native",
            requestId: "liq",
            kind: "liquidation-window",
            field: "totalUsd",
            asset: symbol.slice(0, -4),
            required: false,
          },
        ],
      }).ok,
    );
    assert.ok(
      createPlanningPolicy({
        ...planning(),
        atrSelector: { ...planning().atrSelector, symbol },
      }).ok,
    );
  }
  const policy = {
    ...decision(),
    symbolApplicability: symbols,
    selectors: [
      {
        id: "return",
        source: "external",
        family: "liquidity-stress",
        field: "score",
        direction: "higher-is-stress",
        applicability: { scope: "global", symbols },
        required: false,
      },
    ],
  };
  assert.ok(createDecisionPolicy(policy).ok);
  assert.deepEqual(
    decisionPolicyHash(policy),
    decisionPolicyHash({
      ...policy,
      symbolApplicability: [...symbols].reverse(),
      selectors: [
        {
          ...policy.selectors[0],
          applicability: { scope: "global", symbols: [...symbols].reverse() },
        },
      ],
    }),
  );
  assert.equal(
    createDecisionPolicy({ ...decision(), symbolApplicability: ["XRPUSDT"] })
      .ok,
    false,
  );
});
