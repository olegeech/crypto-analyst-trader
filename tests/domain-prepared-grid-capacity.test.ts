import assert from "node:assert/strict";
import test from "node:test";

import {
  accountEvidenceContentHash,
  createAccountEvidenceBundle,
} from "../src/domain/account/account-evidence-bundle.js";
import { createPreparedGridCapacity } from "../src/domain/execution/prepared-grid-capacity.js";
import { createPreparedLegGridExecution } from "../src/domain/execution/prepared-leg-execution.js";
import { createExchangeOrder } from "../src/domain/execution/exchange-order.js";
import { DecimalValue } from "../src/domain/shared/decimal.js";
import {
  PREPARED_LEG_FOUR_LEVELS,
  preparedLegExecutionFixture,
} from "./fixtures/prepared-leg-execution-fixtures.js";
import { requireDailyFixture } from "./fixtures/daily-planning-evidence-fixtures.js";
import {
  decimal as accountDecimal,
  known as accountKnown,
  na as accountNotApplicable,
  order as accountOrder,
} from "./account-evidence-fixture.js";
import { portfolioRiskPosition } from "./fixtures/portfolio-risk-fixtures.js";

const evaluationTime = "2026-09-24T14:00:06.000Z";
const serverTime = "2026-09-24T14:00:05.000Z";

function decimal(value: string) {
  return requireDailyFixture(DecimalValue.fromString(value));
}

function setup(options: { readonly availableBalance?: string } = {}) {
  const source = preparedLegExecutionFixture({
    planningLevels: PREPARED_LEG_FOUR_LEVELS,
  });
  const admitted = createPreparedLegGridExecution({
    approval: source.approval,
    approvalHash: source.approval.contentHash,
    now: evaluationTime,
  });
  assert.equal(admitted.ok, true, admitted.ok ? "" : admitted.error.message);
  if (!admitted.ok) throw new Error("grid fixture must be admitted");
  const preflight = source.prepared.replayInputs.preflight;
  const rawAccount = preflight.replayInputs.account;
  const accountPayload = { ...rawAccount } as Record<string, unknown>;
  delete accountPayload.consistency;
  const passA = rawAccount.criticalPasses.A!;
  const passB = rawAccount.criticalPasses.B!;
  if (options.availableBalance !== undefined) {
    const available = accountDecimal(options.availableBalance, "USD");
    accountPayload.criticalPasses = {
      A: {
        ...passA,
        totals: { ...passA.totals, totalAvailableBalance: available },
      },
      B: {
        ...passB,
        totals: { ...passB.totals, totalAvailableBalance: available },
      },
    };
  }
  const account = requireDailyFixture(
    createAccountEvidenceBundle(accountPayload),
  );
  const accountHash = requireDailyFixture(accountEvidenceContentHash(account));
  const liveEvidence = {
    readiness: {
      verdict: "READY" as const,
      environment: "mainnet" as const,
      symbol: "BTCUSDT",
      evaluatedAt: serverTime,
      internalBinding: {
        accountIdentityHash: account.accountBinding.accountIdentityHash,
        accountEvidenceHash: accountHash,
      },
    },
    state: {
      serverTime,
      symbol: "BTCUSDT",
      position: {
        instrument: "BTCUSDT",
        side: "flat" as const,
        quantity: decimal("0"),
        leverage: decimal("1"),
      },
      leverage: {
        buy: decimal("1"),
        sell: decimal("1"),
        effective: decimal("1"),
      },
      market: {
        instrument: "BTCUSDT",
        scope: {
          exchange: "bybit" as const,
          environment: "mainnet" as const,
          category: "linear" as const,
          positionMode: "one-way" as const,
        },
      },
      openOrders: [] as unknown[],
    },
  };
  const input = {
    approval: source.approval,
    approvalHash: source.approval.contentHash,
    account,
    liveEvidence,
    nextLegIndex: 0,
    supplementalEvidence: [],
    evaluationTime,
  };
  return {
    source,
    admitted: admitted.value,
    account,
    accountHash,
    liveEvidence,
    input,
  };
}

function restOrder(
  execution: ReturnType<typeof setup>["admitted"]["legs"][number]["execution"],
  overrides: Record<string, unknown> = {},
) {
  return requireDailyFixture(
    createExchangeOrder({
      exchangeOrderId: `exchange-${execution.leg.index}`,
      clientOrderId: execution.clientOrderId,
      instrument: execution.leg.intent.instrument,
      category: "linear",
      side: "buy",
      requestedQuantity: execution.leg.intent.quantity.toString(),
      filledQuantity: "0",
      status: "open",
      orderType: "limit",
      price: execution.leg.intent.price.toString(),
      timeInForce: "GTC",
      takeProfit: execution.leg.intent.protection!.takeProfit!.toString(),
      stopLoss: null,
      reduceOnly: false,
      positionIdx: 0,
      observedAt: serverTime,
      source: "Bybit REST",
      ...overrides,
    }),
  );
}

function accountOrderFor(
  execution: ReturnType<typeof setup>["admitted"]["legs"][number]["execution"],
  exchangeOrderId = `exchange-${execution.leg.index}`,
) {
  return {
    ...accountOrder(),
    category: "linear",
    symbol: execution.leg.intent.instrument,
    orderId: exchangeOrderId,
    orderLinkId: execution.clientOrderId,
    status: "New",
    side: "Buy",
    orderType: "Limit",
    price: accountDecimal(execution.leg.intent.price.toString(), "price"),
    qty: accountDecimal(execution.leg.intent.quantity.toString(), "contracts"),
    cumExecQty: accountDecimal("0", "contracts"),
    leavesQty: accountDecimal(
      execution.leg.intent.quantity.toString(),
      "contracts",
    ),
    positionIdx: accountKnown(0),
    reduceOnly: accountKnown(false),
    takeProfit: accountDecimal(
      execution.leg.intent.protection!.takeProfit!.toString(),
      "price",
    ),
    stopLoss: { ...accountNotApplicable, unit: "price" as const },
    timeInForce: accountKnown("GTC"),
    orderFilter: accountKnown("Order"),
  };
}

function accountTakeProfitChildFor(
  execution: ReturnType<typeof setup>["admitted"]["legs"][number]["execution"],
  exchangeOrderId: string,
) {
  return {
    ...accountOrder(),
    category: "linear",
    symbol: execution.leg.intent.instrument,
    orderId: exchangeOrderId,
    orderLinkId: null,
    status: "Untriggered",
    side: "Sell",
    orderType: "Market",
    qty: accountDecimal(execution.leg.intent.quantity.toString(), "contracts"),
    cumExecQty: accountDecimal("0", "contracts"),
    leavesQty: accountDecimal(
      execution.leg.intent.quantity.toString(),
      "contracts",
    ),
    positionIdx: accountKnown(0),
    reduceOnly: accountKnown(true),
    triggerPrice: accountDecimal(
      execution.leg.intent.protection!.takeProfit!.toString(),
      "price",
    ),
    stopOrderType: accountKnown("TakeProfit"),
    tpslMode: accountKnown("Full"),
  };
}

function accountWithOrders(
  account: ReturnType<typeof setup>["account"],
  rows: readonly { readonly category: string }[],
) {
  const { consistency: _consistency, ...payload } = account;
  void _consistency;
  const passA = payload.criticalPasses.A!;
  const passB = payload.criticalPasses.B!;
  return requireDailyFixture(
    createAccountEvidenceBundle({
      ...payload,
      criticalPasses: {
        A: { ...passA, orders: [...rows] },
        B: { ...passB, orders: [...rows] },
      },
      coverage: payload.coverage.map((entry) => ({
        ...entry,
        ...(entry.partition.endpoint === "open-orders"
          ? {
              rows: rows.filter(
                (row) => row.category === entry.partition.category,
              ).length,
            }
          : {}),
      })),
      budget: {
        ...payload.budget,
        retainedRows: payload.budget.retainedRows + rows.length * 2,
      },
    }),
  );
}

function accountWithPosition(
  account: ReturnType<typeof setup>["account"],
  position: ReturnType<typeof portfolioRiskPosition>,
) {
  const { consistency: _consistency, ...payload } = account;
  void _consistency;
  const passA = payload.criticalPasses.A!;
  const passB = payload.criticalPasses.B!;
  return requireDailyFixture(
    createAccountEvidenceBundle({
      ...payload,
      criticalPasses: {
        A: { ...passA, positions: [position] },
        B: { ...passB, positions: [position] },
      },
      coverage: payload.coverage.map((entry) => ({
        ...entry,
        ...(entry.partition.endpoint === "positions" &&
        entry.partition.category === "linear"
          ? { rows: 1 }
          : {}),
      })),
      budget: {
        ...payload.budget,
        retainedRows: payload.budget.retainedRows + 2,
      },
    }),
  );
}

type TestFreshEvidence = {
  readiness: {
    verdict: "READY" | "BLOCKED";
    environment: "mainnet";
    symbol: string;
    evaluatedAt: string;
    internalBinding: {
      accountIdentityHash: string;
      accountEvidenceHash: string;
    };
  };
  state: {
    serverTime: string;
    symbol: string;
    position: {
      instrument: string;
      side: "flat" | "long" | "short";
      quantity: DecimalValue;
      leverage: DecimalValue;
    };
    leverage: {
      buy: DecimalValue;
      sell: DecimalValue;
      effective: DecimalValue;
    };
    market: {
      instrument: string;
      scope: {
        exchange: "bybit";
        environment: "mainnet";
        category: "linear";
        positionMode: "one-way";
      };
    };
    openOrders: unknown[];
  };
};

function boundEvidence(
  account: ReturnType<typeof setup>["account"],
  liveEvidence: TestFreshEvidence,
) {
  const hash = requireDailyFixture(accountEvidenceContentHash(account));
  return {
    ...liveEvidence,
    readiness: {
      ...liveEvidence.readiness,
      internalBinding: {
        accountIdentityHash:
          liveEvidence.readiness.internalBinding.accountIdentityHash,
        accountEvidenceHash: hash,
      },
    },
  };
}

test("a confirmed zero-fill prefix permits the exact next leg and projects each once", () => {
  const base = setup();
  const prefix = base.admitted.legs[0]!;
  const parent = restOrder(prefix.execution);
  const createChild = (overrides: Record<string, unknown> = {}) =>
    requireDailyFixture(
      createExchangeOrder({
        exchangeOrderId: "tp-child-0",
        clientOrderId: prefix.execution.clientOrderId,
        parentOrderLinkId: prefix.execution.clientOrderId,
        instrument: "BTCUSDT",
        category: "linear",
        side: "sell",
        requestedQuantity: prefix.execution.leg.intent.quantity.toString(),
        filledQuantity: "0",
        status: "open",
        orderType: "market",
        triggerPrice:
          prefix.execution.leg.intent.protection!.takeProfit!.toString(),
        reduceOnly: true,
        positionIdx: 0,
        observedAt: serverTime,
        source: "Bybit REST",
        protectionType: "take-profit",
        ...overrides,
      }),
    );
  const child = createChild();
  const account = accountWithOrders(base.account, [
    accountOrderFor(prefix.execution),
  ]);
  const liveEvidence = boundEvidence(account, {
    ...base.liveEvidence,
    state: { ...base.liveEvidence.state, openOrders: [parent] },
  });
  const result = createPreparedGridCapacity({
    ...base.input,
    account,
    liveEvidence,
    nextLegIndex: 1,
  });
  assert.equal(result.ok, true, result.ok ? "" : result.error.message);
  if (!result.ok) return;
  assert.equal(
    result.value.status,
    "pass",
    JSON.stringify({
      codes: result.value.reasonCodes,
      shared: result.value.projection.sharedAdmission,
      add: result.value.projection.addProjection.reasonCodes,
      leverage: result.value.leverage.reasonCodes,
    }),
  );
  assert.equal(result.value.capacity.withinApprovedAllocation, true);
  assert.equal(result.value.execution.leg.index, 1);
  assert.equal(
    result.value.projection.dailyPlanHash,
    base.source.prepared.replayInputs.preflight.replayInputs.dailyPlan
      .contentHash,
  );
  assert.equal(
    result.value.projection.addProjection.pendingDerivativesGrossUsd.state,
    "known",
  );
  assert.equal(
    result.value.projection.addProjection.plannedDerivativesGrossUsd.state,
    "known",
  );
  assert.equal(
    result.value.projection.addProjection.totalGrossExposureUsd.state,
    "known",
  );
  if (
    result.value.projection.addProjection.pendingDerivativesGrossUsd.state !==
      "known" ||
    result.value.projection.addProjection.plannedDerivativesGrossUsd.state !==
      "known" ||
    result.value.projection.addProjection.currentDerivativesGrossUsd.state !==
      "known" ||
    result.value.projection.addProjection.spotInventoryGrossUsd.state !==
      "known" ||
    result.value.projection.addProjection.totalGrossExposureUsd.state !==
      "known"
  )
    return;
  assert.equal(
    result.value.projection.addProjection.pendingDerivativesGrossUsd.value.toString(),
    prefix.execution.leg.intent.notional.toString(),
  );
  assert.equal(
    result.value.projection.addProjection.plannedDerivativesGrossUsd.value.toString(),
    result.value.execution.leg.intent.notional.toString(),
  );
  assert.equal(
    result.value.capacity.requestedIncrementalNotional.toString(),
    result.value.execution.leg.intent.notional.toString(),
  );
  assert.equal(
    result.value.projection.addProjection.totalGrossExposureUsd.value.toString(),
    result.value.projection.addProjection.currentDerivativesGrossUsd.value
      .add(
        result.value.projection.addProjection.pendingDerivativesGrossUsd.value,
      )
      .add(
        result.value.projection.addProjection.plannedDerivativesGrossUsd.value,
      )
      .add(result.value.projection.addProjection.spotInventoryGrossUsd.value)
      .toString(),
  );
  assert.equal(
    result.value.projection.addProjection.exposures.filter(
      (row) => row.source === "planned-order",
    ).length,
    1,
  );

  const inputWithCallerBudgetOverride = {
    ...base.input,
    approvedAllocation: decimal("999999"),
  };
  const callerBudgetOverride = createPreparedGridCapacity(
    inputWithCallerBudgetOverride,
  );
  assert.equal(callerBudgetOverride.ok, false);

  const accountWithProtection = accountWithOrders(base.account, [
    accountOrderFor(prefix.execution),
    accountTakeProfitChildFor(prefix.execution, "tp-child-0"),
  ]);
  const exactChildEvidence = boundEvidence(accountWithProtection, {
    ...base.liveEvidence,
    state: { ...base.liveEvidence.state, openOrders: [parent, child] },
  });
  const childAssessment = createPreparedGridCapacity({
    ...base.input,
    account: accountWithProtection,
    liveEvidence: exactChildEvidence,
    nextLegIndex: 1,
  });
  assert.equal(childAssessment.ok, true);
  if (childAssessment.ok) {
    assert.equal(childAssessment.value.status, "block");
    assert.ok(
      childAssessment.value.reasonCodes.includes("CURRENT_STATE_UNVALUABLE"),
    );
    assert.ok(
      !childAssessment.value.reasonCodes.includes(
        "ATTACHED_PROTECTION_CONTRADICTS_APPROVAL",
      ),
      childAssessment.value.reasonCodes.join(","),
    );
    assert.ok(
      !childAssessment.value.reasonCodes.includes(
        "PREFIX_RECONCILIATION_MISMATCH",
      ),
    );
  }

  const invalidChildCases = [
    { label: "wrong side", child: createChild({ side: "buy" }) },
    {
      label: "wrong quantity",
      child: createChild({ requestedQuantity: "999" }),
    },
    {
      label: "filled child",
      child: createChild({
        filledQuantity: prefix.execution.leg.intent.quantity
          .multiply(decimal("0.5"))
          .toString(),
      }),
    },
    {
      label: "wrong trigger",
      child: createChild({ triggerPrice: "999" }),
    },
    { label: "not reduce-only", child: createChild({ reduceOnly: false }) },
  ];
  for (const item of invalidChildCases) {
    const evidence = boundEvidence(account, {
      ...base.liveEvidence,
      state: { ...base.liveEvidence.state, openOrders: [parent, item.child] },
    });
    const blocked = createPreparedGridCapacity({
      ...base.input,
      account,
      liveEvidence: evidence,
      nextLegIndex: 1,
    });
    assert.equal(blocked.ok, true, item.label);
    if (blocked.ok) {
      assert.equal(blocked.value.status, "block", item.label);
      assert.ok(
        blocked.value.reasonCodes.includes(
          "ATTACHED_PROTECTION_CONTRADICTS_APPROVAL",
        ),
        item.label,
      );
    }
  }
});

test("prefix must be a bijective REST-proven zero-fill prefix with exact account rows", () => {
  const base = setup();
  const first = base.admitted.legs[0]!;
  const second = base.admitted.legs[1]!;
  const parent = restOrder(first.execution);
  const account = accountWithOrders(base.account, [
    accountOrderFor(first.execution),
  ]);
  const fresh = boundEvidence(account, {
    ...base.liveEvidence,
    state: { ...base.liveEvidence.state, openOrders: [parent] },
  });
  const valid = createPreparedGridCapacity({
    ...base.input,
    account,
    liveEvidence: fresh,
    nextLegIndex: 1,
  });
  assert.equal(valid.ok, true);
  if (!valid.ok) return;
  assert.equal(
    valid.value.status,
    "pass",
    JSON.stringify(valid.value.reasonCodes),
  );

  const cases = [
    { label: "missing prefix order", account, orders: [] as unknown[] },
    {
      label: "unowned target order",
      account,
      orders: [{ ...parent, clientOrderId: "manual-order" }],
    },
    {
      label: "filled prefix",
      account,
      orders: [
        restOrder(first.execution, {
          status: "filled",
          filledQuantity: first.execution.leg.intent.quantity.toString(),
        }),
      ],
    },
    {
      label: "partial fill is not a sequential prefix",
      account,
      orders: [
        restOrder(first.execution, {
          status: "partially-filled",
          filledQuantity: "0.01",
        }),
      ],
    },
    {
      label: "wrong attached TP",
      account,
      orders: [restOrder(first.execution, { takeProfit: "999" })],
    },
    { label: "duplicate REST parent", account, orders: [parent, parent] },
    {
      label: "future leg already active",
      account: accountWithOrders(base.account, [
        accountOrderFor(first.execution),
        accountOrderFor(second.execution),
      ]),
      orders: [parent, restOrder(second.execution)],
    },
    {
      label: "account and REST disagree",
      account: base.account,
      orders: [parent],
    },
    {
      label: "account and REST identities disagree",
      account: accountWithOrders(base.account, [
        accountOrderFor(first.execution, "other-exchange-id"),
      ]),
      orders: [parent],
    },
  ];
  for (const item of cases) {
    const bound = boundEvidence(item.account, {
      ...base.liveEvidence,
      state: { ...base.liveEvidence.state, openOrders: item.orders },
    });
    const assessed = createPreparedGridCapacity({
      ...base.input,
      account: item.account,
      liveEvidence: bound,
      nextLegIndex: 1,
    });
    assert.equal(assessed.ok, true, item.label);
    if (assessed.ok) assert.equal(assessed.value.status, "block", item.label);
  }
});

test("account identity, target flatness, readiness and provider-time freshness are mandatory", () => {
  const base = setup();
  const cases = [
    {
      label: "foreign account binding",
      liveEvidence: {
        ...base.liveEvidence,
        readiness: {
          ...base.liveEvidence.readiness,
          internalBinding: {
            ...base.liveEvidence.readiness.internalBinding,
            accountIdentityHash: `sha256:${"b".repeat(64)}`,
          },
        },
      },
      evaluationTime,
    },
    {
      label: "blocked readiness",
      liveEvidence: {
        ...base.liveEvidence,
        readiness: {
          ...base.liveEvidence.readiness,
          verdict: "BLOCKED" as const,
        },
      },
      evaluationTime,
    },
    {
      label: "target position became long",
      liveEvidence: {
        ...base.liveEvidence,
        state: {
          ...base.liveEvidence.state,
          position: {
            ...base.liveEvidence.state.position,
            side: "long" as const,
            quantity: decimal("0.01"),
          },
        },
      },
      evaluationTime,
    },
    {
      label: "readiness stale",
      liveEvidence: {
        ...base.liveEvidence,
        readiness: {
          ...base.liveEvidence.readiness,
          evaluatedAt: "2026-09-24T13:58:00.000Z",
        },
      },
      evaluationTime,
    },
    {
      label: "read-state stale",
      liveEvidence: {
        ...base.liveEvidence,
        state: {
          ...base.liveEvidence.state,
          serverTime: "2026-09-24T13:58:00.000Z",
        },
      },
      evaluationTime,
    },
    {
      label: "approval expired",
      liveEvidence: base.liveEvidence,
      evaluationTime: base.source.approval.expiresAt,
    },
  ];
  for (const item of cases) {
    const assessed = createPreparedGridCapacity({
      ...base.input,
      liveEvidence: boundEvidence(base.account, item.liveEvidence),
      evaluationTime: item.evaluationTime,
    });
    if (item.label === "approval expired") {
      assert.equal(assessed.ok, false, item.label);
    } else {
      assert.equal(assessed.ok, true, item.label);
      if (assessed.ok) assert.equal(assessed.value.status, "block", item.label);
    }
  }

  const changedAccount = accountWithPosition(
    base.account,
    portfolioRiskPosition({
      side: "Buy",
      size: accountDecimal("0.01", "contracts"),
      positionValue: accountDecimal("1", "USD"),
    }),
  );
  const contradictory = createPreparedGridCapacity({
    ...base.input,
    account: changedAccount,
    liveEvidence: boundEvidence(changedAccount, base.liveEvidence),
  });
  assert.equal(contradictory.ok, true);
  if (contradictory.ok) {
    assert.equal(contradictory.value.status, "block");
    assert.ok(
      contradictory.value.reasonCodes.includes("TARGET_POSITION_NOT_FLAT"),
    );
  }
});

test("account evidence freshness is inclusive at 60 seconds and blocks at 60,001 ms", () => {
  const base = setup();
  const atBoundary = "2026-09-24T14:01:02.000Z";
  const freshAtBoundary = {
    ...base.liveEvidence,
    readiness: { ...base.liveEvidence.readiness, evaluatedAt: atBoundary },
    state: { ...base.liveEvidence.state, serverTime: atBoundary },
  };
  const accepted = createPreparedGridCapacity({
    ...base.input,
    liveEvidence: freshAtBoundary,
    evaluationTime: atBoundary,
  });
  assert.equal(accepted.ok, true);
  if (accepted.ok) assert.equal(accepted.value.status, "pass");

  const oneMsLate = "2026-09-24T14:01:02.001Z";
  const stale = createPreparedGridCapacity({
    ...base.input,
    liveEvidence: {
      ...base.liveEvidence,
      readiness: { ...base.liveEvidence.readiness, evaluatedAt: oneMsLate },
      state: { ...base.liveEvidence.state, serverTime: oneMsLate },
    },
    evaluationTime: oneMsLate,
  });
  assert.equal(stale.ok, true);
  if (stale.ok) {
    assert.equal(stale.value.status, "block");
    assert.ok(stale.value.reasonCodes.includes("ACCOUNT_EVIDENCE_STALE"));
  }
});

test("unknown balance, >1x leverage, and capacity excess block without re-planning", () => {
  const base = setup({ availableBalance: "1000" });
  const accountUnknown = (() => {
    const { consistency: _consistency, ...payload } = base.account;
    void _consistency;
    return requireDailyFixture(
      createAccountEvidenceBundle({
        ...payload,
        collectionStatus: "incomplete",
        diagnostics: [
          ...payload.diagnostics,
          {
            code: "COVERAGE_INCOMPLETE",
            severity: "error",
            scope: "collection",
          },
        ],
        criticalPasses: {
          A: {
            ...payload.criticalPasses.A!,
            totals: {
              ...payload.criticalPasses.A!.totals,
              totalAvailableBalance: {
                state: "unavailable",
                reason: "not-returned",
                unit: "USD",
              },
            },
          },
          B: {
            ...payload.criticalPasses.B!,
            totals: {
              ...payload.criticalPasses.B!.totals,
              totalAvailableBalance: {
                state: "unavailable",
                reason: "not-returned",
                unit: "USD",
              },
            },
          },
        },
      }),
    );
  })();
  const unknownResult = createPreparedGridCapacity({
    ...base.input,
    account: accountUnknown,
    liveEvidence: boundEvidence(accountUnknown, base.liveEvidence),
  });
  assert.equal(unknownResult.ok, true);
  if (unknownResult.ok) assert.equal(unknownResult.value.status, "block");

  const twoXState = {
    ...base.liveEvidence,
    state: {
      ...base.liveEvidence.state,
      position: { ...base.liveEvidence.state.position, leverage: decimal("2") },
      leverage: {
        buy: decimal("2"),
        sell: decimal("2"),
        effective: decimal("2"),
      },
    },
  };
  const leverageResult = createPreparedGridCapacity({
    ...base.input,
    liveEvidence: twoXState,
  });
  assert.equal(leverageResult.ok, true);
  if (leverageResult.ok) assert.equal(leverageResult.value.status, "block");

  const nonOneXState = {
    ...base.liveEvidence,
    state: {
      ...base.liveEvidence.state,
      position: {
        ...base.liveEvidence.state.position,
        leverage: decimal("0.5"),
      },
      leverage: {
        buy: decimal("0.5"),
        sell: decimal("0.5"),
        effective: decimal("0.5"),
      },
    },
  };
  const nonOneX = createPreparedGridCapacity({
    ...base.input,
    liveEvidence: nonOneXState,
  });
  assert.equal(nonOneX.ok, true);
  if (nonOneX.ok) {
    assert.equal(nonOneX.value.status, "block");
    assert.ok(nonOneX.value.reasonCodes.includes("LEVERAGE_NOT_ONE_X"));
  }

  const lowBalance = setup({ availableBalance: "1" });
  const lowResult = createPreparedGridCapacity(lowBalance.input);
  assert.equal(lowResult.ok, true);
  if (lowResult.ok) {
    assert.equal(lowResult.value.status, "block");
    assert.ok(lowResult.value.reasonCodes.includes("CAPACITY_EXCEEDED"));
  }
});

test("an exact available-balance boundary passes and uses the immutable M1 reserve", () => {
  const source = preparedLegExecutionFixture({
    planningLevels: [
      { atrOffset: "0", allocationWeight: "1", takeProfitAtrDistance: "1" },
    ],
    allocation: "91.8",
  });
  const accountBundle =
    source.prepared.replayInputs.preflight.replayInputs.account;
  const accountPayload = { ...accountBundle } as Record<string, unknown>;
  delete accountPayload.consistency;
  const available = accountDecimal("102", "USD");
  accountPayload.criticalPasses = {
    A: {
      ...accountBundle.criticalPasses.A!,
      totals: {
        ...accountBundle.criticalPasses.A!.totals,
        totalAvailableBalance: available,
      },
    },
    B: {
      ...accountBundle.criticalPasses.B!,
      totals: {
        ...accountBundle.criticalPasses.B!.totals,
        totalAvailableBalance: available,
      },
    },
  };
  const account = requireDailyFixture(
    createAccountEvidenceBundle(accountPayload),
  );
  const accountHash = requireDailyFixture(accountEvidenceContentHash(account));
  const admitted = requireDailyFixture(
    createPreparedLegGridExecution({
      approval: source.approval,
      approvalHash: source.approval.contentHash,
      now: evaluationTime,
    }),
  );
  const result = createPreparedGridCapacity({
    approval: source.approval,
    approvalHash: source.approval.contentHash,
    account,
    liveEvidence: {
      readiness: {
        verdict: "READY",
        environment: "mainnet",
        symbol: "BTCUSDT",
        evaluatedAt: serverTime,
        internalBinding: {
          accountIdentityHash: account.accountBinding.accountIdentityHash,
          accountEvidenceHash: accountHash,
        },
      },
      state: {
        serverTime,
        symbol: "BTCUSDT",
        position: {
          instrument: "BTCUSDT",
          side: "flat",
          quantity: decimal("0"),
          leverage: decimal("1"),
        },
        leverage: {
          buy: decimal("1"),
          sell: decimal("1"),
          effective: decimal("1"),
        },
        market: {
          instrument: "BTCUSDT",
          scope: {
            exchange: "bybit",
            environment: "mainnet",
            category: "linear",
            positionMode: "one-way",
          },
        },
        openOrders: [],
      },
    },
    nextLegIndex: 0,
    supplementalEvidence: [],
    evaluationTime,
  });
  assert.equal(result.ok, true, result.ok ? "" : result.error.message);
  if (!result.ok) return;
  assert.equal(result.value.execution.leg.intent.notional.toString(), "91.8");
  assert.notEqual(result.value.capacity.incrementalCapacity, null);
  if (result.value.capacity.incrementalCapacity === null) return;
  assert.equal(result.value.capacity.incrementalCapacity.toString(), "91.8");
  assert.equal(result.value.capacity.withinCapacity, true);
  assert.equal(
    result.value.status,
    "pass",
    JSON.stringify({
      codes: result.value.reasonCodes,
      shared: result.value.projection.sharedAdmission,
      add: result.value.projection.addProjection.reasonCodes,
      leverage: result.value.leverage.reasonCodes,
    }),
  );
  assert.equal(admitted.legs.length, 1);
});
