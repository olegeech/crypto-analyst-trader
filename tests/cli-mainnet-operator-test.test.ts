import assert from "node:assert/strict";
import test from "node:test";

import {
  runMainnetOperatorTestCli,
  type MainnetOperatorTestCliDependencies,
} from "../src/cli/mainnet-operator-test.js";
import {
  createOperatorMainnetQuote,
  createOperatorMainnetTestPlan,
  deriveOperatorMainnetTestSourceId,
  type OperatorMainnetTestPlan,
} from "../src/domain/execution/operator-mainnet-test-plan.js";
import { createInstrumentConstraints } from "../src/domain/market/instrument-constraints.js";
import { domainError } from "../src/domain/shared/errors.js";
import { fail, ok, type Result } from "../src/domain/shared/result.js";
import type { PersistenceScope } from "../src/ports/persistence.js";

const NOW = "2026-10-23T12:00:00.000Z";
const ACCOUNT = `sha256:${"a".repeat(64)}`;
const scope: PersistenceScope = {
  exchange: "bybit",
  environment: "mainnet",
  accountId: ACCOUNT,
  category: "linear",
  positionMode: "one-way",
};

function unwrap<T>(result: Result<T>): T {
  if (!result.ok)
    throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function planFixture(): OperatorMainnetTestPlan {
  const quote = unwrap(
    createOperatorMainnetQuote({
      exchange: "bybit",
      environment: "mainnet",
      category: "linear",
      origin: "https://api.bybit.com",
      symbol: "BTCUSDT",
      observedAt: "2026-10-23T11:59:59.500Z",
      collectionStartedAt: "2026-10-23T11:59:59.400Z",
      collectionCompletedAt: "2026-10-23T11:59:59.600Z",
      bid: "100",
      ask: "100.1",
      last: "100",
    }),
  );
  const constraints = unwrap(
    createInstrumentConstraints({
      instrument: "BTCUSDT",
      version: "bybit-linear-instrument/v1",
      priceTickSize: "0.1",
      quantityStep: "0.001",
      minQuantity: "0.001",
      minNotional: "5",
      minPrice: "0.1",
      maxPrice: "1000000",
      maxLimitQuantity: "100000",
    }),
  );
  return unwrap(
    createOperatorMainnetTestPlan({
      accountIdentityHash: ACCOUNT,
      symbol: "BTCUSDT",
      nonce: "operator-cli-test",
      allocation: "10",
      grossNotionalCap: "8",
      maxDeviationBps: "10",
      quote,
      warningCodes: [],
      constraints,
      preparedAt: NOW,
    }),
  );
}

const plan = planFixture();
const sourceId = unwrap(deriveOperatorMainnetTestSourceId(plan.contentHash));

function streams(isTTY: boolean) {
  const chunks: string[] = [];
  const input = { isTTY } as unknown as NodeJS.ReadableStream & {
    readonly isTTY: boolean;
  };
  const output = {
    isTTY,
    write(chunk: string | Uint8Array) {
      chunks.push(String(chunk));
      return true;
    },
  } as unknown as NodeJS.WritableStream & { readonly isTTY: boolean };
  return { input, output, text: () => chunks.join("") };
}

function resolvedPlan() {
  return ok({ scope, plan });
}

test("prepare persists and displays the frozen plan without exchange writes", async () => {
  const terminal = streams(false);
  let prepared = 0;
  const code = await runMainnetOperatorTestCli(
    [
      "prepare",
      "--symbol",
      "BTCUSDT",
      "--allocation",
      "10",
      "--gross-cap",
      "8",
      "--max-deviation-bps",
      "10",
    ],
    {
      ...terminal,
      prepare: async () => {
        prepared += 1;
        return ok(plan);
      },
    },
  );

  assert.equal(code, 0);
  assert.equal(prepared, 1);
  assert.match(terminal.text(), /PLAN_HASH=sha256:/u);
  assert.match(terminal.text(), /GROSS_CAP_SCOPE=entry gross notional only/u);
  assert.match(
    terminal.text(),
    /APPROVAL_VALID_FOR_MS=900000 after exact consent/u,
  );
  assert.doesNotMatch(terminal.text(), /APPROVAL_EXPIRES=/u);
  assert.match(terminal.text(), /EXCHANGE_WRITES=0/u);
});

test("invalid input and blocked preparation use distinct documented exit codes", async (t) => {
  await t.test("invalid input", async () => {
    const terminal = streams(false);
    const code = await runMainnetOperatorTestCli(["execute"], terminal);
    assert.equal(code, 2);
    assert.match(terminal.text(), /Usage:/u);
    assert.match(terminal.text(), /INVALID_REQUEST/u);
  });

  await t.test("blocked preparation", async () => {
    const terminal = streams(false);
    const code = await runMainnetOperatorTestCli(
      [
        "prepare",
        "--symbol",
        "BTCUSDT",
        "--allocation",
        "10",
        "--gross-cap",
        "8",
        "--max-deviation-bps",
        "10",
      ],
      {
        ...terminal,
        prepare: async () =>
          fail(
            domainError("INVALID_EVIDENCE", "blocked", {
              reasonCode: "READINESS_BLOCKED",
            }),
          ),
      },
    );
    assert.equal(code, 4);
    assert.match(terminal.text(), /READINESS_BLOCKED/u);
    assert.match(terminal.text(), /EXCHANGE_WRITES=0/u);
  });
});

test("non-TTY execute exits before plan lookup or any approval/write composition", async () => {
  const terminal = streams(false);
  let planLookups = 0;
  let durableLookups = 0;
  let writes = 0;
  const code = await runMainnetOperatorTestCli(
    ["execute", "--plan-hash", plan.contentHash],
    {
      ...terminal,
      resolvePlan: () => {
        planLookups += 1;
        return resolvedPlan();
      },
      hasDurableIntent: () => {
        durableLookups += 1;
        return ok(false);
      },
      execute: async () => {
        writes += 1;
        return ok(undefined);
      },
    },
  );

  assert.equal(code, 3);
  assert.equal(planLookups, 0);
  assert.equal(durableLookups, 0);
  assert.equal(writes, 0);
  assert.match(terminal.text(), /NON_INTERACTIVE_WRITE_SESSION/u);
  assert.match(terminal.text(), /EXCHANGE_WRITES=0/u);
});

test("exact lowercase yes approves one frozen plan; other answers do not call execute", async (t) => {
  await t.test("yes", async () => {
    const terminal = streams(true);
    let writes = 0;
    let approvalHash: unknown;
    let approvedPlanHash: unknown;
    const code = await runMainnetOperatorTestCli(
      ["execute", "--plan-hash", plan.contentHash],
      {
        ...terminal,
        resolvePlan: () => resolvedPlan(),
        hasDurableIntent: () => ok(false),
        prompt: async () => "yes",
        clock: () => Date.parse(NOW),
        actor: () => "operator-test",
        execute: async (input) => {
          writes += 1;
          approvalHash = input.approvalHash;
          approvedPlanHash =
            typeof input.approval === "object" && input.approval !== null
              ? (input.approval as { readonly planHash?: unknown }).planHash
              : undefined;
          return ok({
            kind: "attempted",
            sourceId,
            clientOrderId: plan.clientOrderId,
            attemptOutcome: "accepted",
          });
        },
      },
    );

    assert.equal(code, 5);
    assert.equal(writes, 1);
    assert.equal(approvedPlanHash, plan.contentHash);
    assert.equal(typeof approvalHash, "string");
    assert.match(terminal.text(), /ENTRY=Buy Limit\/GTC/u);
    assert.match(terminal.text(), /EXACT_APPROVAL=type lowercase yes/u);
    assert.match(terminal.text(), /ATTEMPT_OUTCOME=accepted/u);
    assert.match(terminal.text(), /EXCHANGE_WRITES=1/u);
    assert.match(terminal.text(), /NEXT_ACTION=run mainnet:test status/u);
  });

  await t.test("capitalized Yes", async () => {
    const terminal = streams(true);
    let writes = 0;
    const code = await runMainnetOperatorTestCli(
      ["execute", "--plan-hash", plan.contentHash],
      {
        ...terminal,
        resolvePlan: () => resolvedPlan(),
        hasDurableIntent: () => ok(false),
        prompt: async () => "Yes",
        execute: async () => {
          writes += 1;
          return ok(undefined);
        },
      },
    );

    assert.equal(code, 3);
    assert.equal(writes, 0);
    assert.match(terminal.text(), /CONSENT_NOT_EXACT_YES/u);
    assert.match(terminal.text(), /EXCHANGE_WRITES=0/u);
  });
});

test("durable intent routes execute to read-only status and never resends", async () => {
  const terminal = streams(true);
  let writes = 0;
  let statusCalls = 0;
  let prompts = 0;
  const code = await runMainnetOperatorTestCli(
    ["execute", "--plan-hash", plan.contentHash],
    {
      ...terminal,
      resolvePlan: () => resolvedPlan(),
      hasDurableIntent: () => ok(true),
      prompt: async () => {
        prompts += 1;
        return "yes";
      },
      execute: async () => {
        writes += 1;
        return ok(undefined);
      },
      status: async () => {
        statusCalls += 1;
        return fail(
          domainError("UNRESOLVED_RECONCILIATION", "test status", {
            reasonCode: "READ_FAILED",
          }),
        );
      },
    },
  );

  assert.equal(code, 5);
  assert.equal(prompts, 0);
  assert.equal(writes, 0);
  assert.equal(statusCalls, 1);
  assert.match(terminal.text(), /DURABLE_INTENT_ALREADY_EXISTS/u);
  assert.match(terminal.text(), /LIFECYCLE_OUTCOME=UNKNOWN/u);
  assert.match(terminal.text(), /EXCHANGE_WRITES=0/u);
});

test("status records manual-action declarations and sanitizes terminal fields", async () => {
  const terminal = streams(true);
  let capturedAction: string | undefined;
  const fakeStatus: NonNullable<
    MainnetOperatorTestCliDependencies["status"]
  > = async (request) => {
    capturedAction = request.manualAction;
    return {
      ok: true,
      value: {
        sourceId: "source\nINJECTED",
        lifecycleOutcome: "PARTIAL_EVIDENCE",
        cleanupStatus: "pending",
        exchangeReads: 4,
        journaled: true,
        latestSnapshot: {
          source: { clientOrderId: "order\rINJECTED" },
          attempt: { outcome: "accepted", exchangeOrderId: "exchange-order" },
        },
        halt: { active: false, revision: 0 },
        reasons: ["PROOF\nINJECTED"],
      },
    } as unknown as Awaited<
      ReturnType<NonNullable<MainnetOperatorTestCliDependencies["status"]>>
    >;
  };
  const code = await runMainnetOperatorTestCli(
    ["status", "--source-id", sourceId],
    {
      ...terminal,
      prompt: async () => "close",
      actor: () => "operator-test",
      status: fakeStatus,
    },
  );

  assert.equal(code, 5);
  assert.equal(capturedAction, "position-closed");
  assert.match(terminal.text(), /MANUAL_ACTION=position-closed/u);
  assert.match(terminal.text(), /SOURCE_ID=sourceINJECTED/u);
  assert.match(terminal.text(), /CLIENT_ORDER_ID=orderINJECTED/u);
  assert.match(terminal.text(), /REASONS=PROOFINJECTED/u);
  assert.match(terminal.text(), /EXCHANGE_WRITES=0/u);
  assert.equal(terminal.text().includes("\nINJECTED\n"), false);
});
