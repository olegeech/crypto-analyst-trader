import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { createOperatorMainnetRecoveryAttestation } from "../src/domain/execution/operator-mainnet-recovery.js";
import { createInstrumentConstraints } from "../src/domain/market/instrument-constraints.js";
import { domainError } from "../src/domain/shared/errors.js";
import { fail, ok, type Result } from "../src/domain/shared/result.js";
import type { PersistenceScope } from "../src/ports/persistence.js";
import type { PlanHash } from "../src/domain/identity/canonical-serialization.js";

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

function planFixture(
  recoveryAttestationHash?: PlanHash,
): OperatorMainnetTestPlan {
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
      ...(recoveryAttestationHash === undefined
        ? {}
        : { recoveryAttestationHash }),
    }),
  );
}

function manualAttestation(observedAt = NOW) {
  return unwrap(
    createOperatorMainnetRecoveryAttestation({
      provenance: "MANUAL_ATTESTED_NOT_API_VERIFIED",
      exchange: "bybit",
      environment: "mainnet",
      accountIdentityHash: ACCOUNT,
      sourceId: "operator-mainnet-test:prior-source",
      sourcePlanHash: `sha256:${"b".repeat(64)}` as PlanHash,
      sourceIntentId: "prior-intent",
      sourceRevision: 1,
      actor: "operator-test",
      observedAt,
      inspection: {
        accountOpenOrdersInspected: true,
        accountOpenOrders: [],
        accountPositionsInspected: true,
        accountPositions: [],
        sourceOrderHistoryInspected: true,
        sourceOrders: [],
        sourceFillsInspected: true,
        sourceFills: [],
        sourcePositionInspected: true,
        sourcePosition: null,
        targetLeverage: "1",
        sourceTakeProfitInspected: true,
        sourceTakeProfitOrders: [],
      },
      manualActions: ["none"],
      acceptedUncertainty: ["manual-ui-may-be-stale"],
    }),
  );
}

const plan = planFixture();
const sourceId = unwrap(deriveOperatorMainnetTestSourceId(plan.contentHash));

function streams(isTTY: boolean, outputIsTTY = isTTY) {
  const chunks: string[] = [];
  const input = { isTTY } as unknown as NodeJS.ReadableStream & {
    readonly isTTY: boolean;
  };
  const output = {
    isTTY: outputIsTTY,
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
        return ok({ plan, exchangeReads: 6, exchangeWrites: 0 });
      },
    },
  );

  assert.equal(code, 0);
  assert.equal(prepared, 1);
  assert.match(terminal.text(), /PLAN_HASH=sha256:/u);
  assert.match(terminal.text(), /POLICY_VERSION=operator-mainnet-test\/v1/u);
  assert.match(terminal.text(), /POLICY_IDENTITY_HASH=sha256:/u);
  assert.match(terminal.text(), /PAYLOAD_HASH=sha256:/u);
  assert.match(terminal.text(), /APPROVAL_HASH=NOT_APPROVED/u);
  assert.match(terminal.text(), /GROSS_CAP_SCOPE=entry gross notional only/u);
  assert.match(
    terminal.text(),
    /APPROVAL_VALID_FOR_MS=900000 after exact consent/u,
  );
  assert.doesNotMatch(terminal.text(), /APPROVAL_EXPIRES=/u);
  assert.match(terminal.text(), /EXCHANGE_READS=6/u);
  assert.match(terminal.text(), /EXCHANGE_WRITES=0/u);
});

test("manual preparation requires an attended terminal and forwards the saved UI attestation to planning", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "operator-cli-recovery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const inspection = {
    observedAt: "2026-10-23T11:59:58.000Z",
    inspection: {
      accountOpenOrdersInspected: true,
      accountOpenOrders: [],
      accountPositionsInspected: true,
      accountPositions: [],
      sourceOrderHistoryInspected: true,
      sourceOrders: [],
      sourceFillsInspected: true,
      sourceFills: [],
      sourcePositionInspected: true,
      sourcePosition: null,
      targetLeverage: "1",
      sourceTakeProfitInspected: true,
      sourceTakeProfitOrders: [],
    },
    manualActions: ["none"],
    acceptedUncertainty: ["manual-ui-may-be-stale"],
  };
  const inspectionPath = join(root, "inspection.json");
  writeFileSync(inspectionPath, JSON.stringify(inspection), "utf8");
  const attestation = manualAttestation(inspection.observedAt);
  const manualPlan = planFixture(attestation.contentHash);
  const attended = streams(true);
  let preparationInput: unknown;
  let attestationInput: unknown;
  let recordedAtInput: unknown;
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
      "--recovery-source-id",
      sourceId,
      "--recovery-inspection-file",
      inspectionPath,
    ],
    {
      ...attended,
      actor: () => "operator-test",
      clock: () => Date.parse(NOW),
      prepareRecoveryAttestation: (input) => {
        attestationInput = input.inspection;
        recordedAtInput = input.recordedAt;
        return ok({ attestation, exchangeReads: 0, exchangeWrites: 0 });
      },
      prepare: async (input) => {
        preparationInput = input;
        return ok({ plan: manualPlan, exchangeReads: 4, exchangeWrites: 0 });
      },
    },
  );
  assert.equal(code, 0);
  assert.deepEqual(attestationInput, inspection);
  assert.equal(recordedAtInput, NOW);
  assert.equal(attestation.observedAt, inspection.observedAt);
  assert.equal(
    (preparationInput as { recoveryAttestationHash?: string })
      .recoveryAttestationHash,
    attestation.contentHash,
  );
  assert.equal(
    (preparationInput as { recoveryAttestation?: unknown }).recoveryAttestation,
    attestation,
  );
  assert.match(
    attended.text(),
    /RECOVERY_PROVENANCE=MANUAL_ATTESTED_NOT_API_VERIFIED/u,
  );
  assert.match(
    attended.text(),
    /PLAN_SCHEMA=operator-mainnet-execution-test\/v2/u,
  );
  assert.match(attended.text(), /EXCHANGE_WRITES=0/u);

  const unattended = streams(false);
  let attestationCalls = 0;
  const blocked = await runMainnetOperatorTestCli(
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
      "--recovery-source-id",
      sourceId,
      "--recovery-inspection-file",
      inspectionPath,
    ],
    {
      ...unattended,
      prepareRecoveryAttestation: () => {
        attestationCalls += 1;
        return ok({ attestation, exchangeReads: 0, exchangeWrites: 0 });
      },
    },
  );
  assert.equal(blocked, 3);
  assert.equal(attestationCalls, 0);
  assert.match(
    unattended.text(),
    /MANUAL_RECOVERY_REQUIRES_ATTENDED_TERMINAL/u,
  );
});

test("manual preparation forwards a stale declared UI observation instead of refreshing it at file-read time", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "operator-cli-recovery-stale-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const observationTime = "2026-10-23T11:54:59.999Z";
  const inspection = {
    observedAt: observationTime,
    inspection: {
      accountOpenOrdersInspected: true,
      accountOpenOrders: [],
      accountPositionsInspected: true,
      accountPositions: [],
      sourceOrderHistoryInspected: true,
      sourceOrders: [],
      sourceFillsInspected: true,
      sourceFills: [],
      sourcePositionInspected: true,
      sourcePosition: null,
      targetLeverage: "1",
      sourceTakeProfitInspected: true,
      sourceTakeProfitOrders: [],
    },
    manualActions: ["none"],
    acceptedUncertainty: ["manual-ui-may-be-stale"],
  };
  const inspectionPath = join(root, "inspection.json");
  writeFileSync(inspectionPath, JSON.stringify(inspection), "utf8");
  const terminal = streams(true);
  const attestation = manualAttestation(observationTime);
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
      "--recovery-source-id",
      sourceId,
      "--recovery-inspection-file",
      inspectionPath,
    ],
    {
      ...terminal,
      actor: () => "operator-test",
      clock: () => Date.parse(NOW),
      prepareRecoveryAttestation: (input) => {
        assert.equal(input.inspection.observedAt, observationTime);
        assert.equal(input.recordedAt, NOW);
        return ok({ attestation, exchangeReads: 0, exchangeWrites: 0 });
      },
      prepare: async (input) => {
        assert.equal(
          (input.recoveryAttestation as { observedAt: string }).observedAt,
          observationTime,
        );
        return fail(
          domainError("INVALID_EVIDENCE", "stale UI inspection", {
            reasonCode: "MANUAL_TARGET_EVIDENCE_STALE",
          }),
        );
      },
    },
  );
  assert.equal(code, 4);
  assert.match(terminal.text(), /MANUAL_TARGET_EVIDENCE_STALE/u);
});

test("recover requires exact lowercase consent and creates no exchange IO", async () => {
  const snapshot = {
    source: {
      sourceId,
      planHash: plan.contentHash,
      clientOrderId: plan.clientOrderId,
    },
    intent: { writeIntentId: "prior-intent" },
    reconciliations: [
      {
        reconciliationId: "cleanup-proof-01",
        canonicalHash: plan.contentHash,
        cleanupStatus: "verified-clean",
        observedAt: NOW,
      },
    ],
    halt: { active: true, revision: 1 },
  };
  let recoverCalls = 0;
  let seenResolution: unknown;
  const run = async (answer: string) => {
    const terminal = streams(true);
    const code = await runMainnetOperatorTestCli(
      [
        "recover",
        "--source-id",
        sourceId,
        "--plan-hash",
        plan.contentHash,
        "--resolution",
        "api",
      ],
      {
        ...terminal,
        clock: () => Date.parse(NOW),
        resolveSource: () => ok({ scope, snapshot: snapshot as never }),
        resolvePlan: () => resolvedPlan(),
        prompt: async () => answer,
        recover: (input) => {
          recoverCalls += 1;
          seenResolution = input.resolution;
          return ok({
            grant: {
              grantId: "recovery-grant-01",
              contentHash: plan.contentHash,
              haltOrigin: {
                eventId: "halt-event-01",
                revision: 1,
                originHash: plan.contentHash,
              },
            },
            exchangeReads: 0,
            exchangeWrites: 0,
          } as never);
        },
      },
    );
    return { code, terminal };
  };

  const declined = await run("YES");
  assert.equal(declined.code, 3);
  assert.match(declined.terminal.text(), /RECOVERY_CONSENT_NOT_EXACT_YES/u);
  assert.equal(recoverCalls, 0);

  const authorized = await run("yes");
  assert.equal(authorized.code, 0);
  assert.equal(recoverCalls, 1);
  assert.equal(seenResolution, "api-resolved");
  assert.match(authorized.terminal.text(), /VERDICT=RECOVERY_AUTHORIZED/u);
  assert.match(authorized.terminal.text(), /HALT_CLEARANCE=recorded/u);
  assert.match(authorized.terminal.text(), /EXCHANGE_READS=0/u);
  assert.match(authorized.terminal.text(), /EXCHANGE_WRITES=0/u);
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
              exchangeReads: 6,
              exchangeWrites: 0,
            }),
          ),
      },
    );
    assert.equal(code, 4);
    assert.match(terminal.text(), /READINESS_BLOCKED/u);
    assert.match(terminal.text(), /EXCHANGE_READS=6/u);
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
  assert.match(terminal.text(), /EXCHANGE_READS=0/u);
  assert.match(terminal.text(), /EXCHANGE_WRITES=0/u);
});

test("TTY input with redirected output declines before plan review or execution", async () => {
  const terminal = streams(true, false);
  let planLookups = 0;
  let prompts = 0;
  let writes = 0;
  const code = await runMainnetOperatorTestCli(
    ["execute", "--plan-hash", plan.contentHash],
    {
      ...terminal,
      resolvePlan: () => {
        planLookups += 1;
        return resolvedPlan();
      },
      hasDurableIntent: () => ok(false),
      prompt: async () => {
        prompts += 1;
        return "yes";
      },
      execute: async () => {
        writes += 1;
        return ok(undefined);
      },
    },
  );

  assert.equal(code, 3);
  assert.equal(planLookups, 0);
  assert.equal(prompts, 0);
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
            exchangeReads: 7,
            exchangeWrites: 1,
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
    assert.match(terminal.text(), /POLICY_IDENTITY_HASH=sha256:/u);
    assert.match(terminal.text(), /APPROVAL_HASH=sha256:/u);
    assert.match(terminal.text(), /EXCHANGE_READS=7/u);
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
    assert.match(terminal.text(), /APPROVAL_HASH=NOT_APPROVED/u);
    assert.match(terminal.text(), /EXCHANGE_READS=0/u);
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
            exchangeReads: 3,
            exchangeWrites: 0,
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
  assert.match(
    terminal.text(),
    new RegExp(`CLIENT_ORDER_ID=${plan.clientOrderId}`, "u"),
  );
  assert.match(
    terminal.text(),
    /inspect Bybit UI orders, fills and position using CLIENT_ORDER_ID/u,
  );
  assert.match(terminal.text(), /LIFECYCLE_OUTCOME=UNKNOWN/u);
  assert.match(terminal.text(), /EXCHANGE_READS=3/u);
  assert.match(terminal.text(), /EXCHANGE_WRITES=0/u);
});

test("failed execution reports per-invocation exchange counts from its error", async () => {
  const terminal = streams(true);
  const code = await runMainnetOperatorTestCli(
    ["execute", "--plan-hash", plan.contentHash],
    {
      ...terminal,
      resolvePlan: () => resolvedPlan(),
      hasDurableIntent: () => ok(false),
      prompt: async () => "yes",
      clock: () => Date.parse(NOW),
      actor: () => "operator-test",
      execute: async () =>
        fail(
          domainError("INVALID_CAPABILITY", "blocked after fresh reads", {
            reasonCode: "READINESS_BLOCKED",
            exchangeReads: 8,
            exchangeWrites: 0,
          }),
        ),
    },
  );

  assert.equal(code, 5);
  assert.match(terminal.text(), /READINESS_BLOCKED/u);
  assert.match(terminal.text(), /EXECUTION_STATE=EXECUTION_NOT_STARTED/u);
  assert.match(
    terminal.text(),
    /NEXT_ACTION=diagnose the blocked pre-intent stage from REASON_CODE/u,
  );
  assert.match(terminal.text(), /EXCHANGE_READS=8/u);
  assert.match(terminal.text(), /EXCHANGE_WRITES=0/u);
});

test("insufficient-funds admission prints only safe capacity details and next steps", async () => {
  const terminal = streams(true);
  const code = await runMainnetOperatorTestCli(
    ["execute", "--plan-hash", plan.contentHash],
    {
      ...terminal,
      resolvePlan: () => resolvedPlan(),
      hasDurableIntent: () => ok(false),
      prompt: async () => "yes",
      clock: () => Date.parse(NOW),
      actor: () => "operator-test",
      execute: async () =>
        fail(
          domainError("INVALID_EVIDENCE", "blocked by available balance", {
            reasonCode: "AVAILABLE_MARGIN_OR_FEE_RESERVE_INSUFFICIENT",
            exchangeReads: 7,
            exchangeWrites: 0,
            availableBalance: "1.25",
            orderNotional: "8",
            entryFeeReserve: "0.0044",
            exitFeeReserve: "0.0045",
            totalReserve: "0.0089",
            requiredAvailableBalance: "8.0089",
            shortfall: "6.7589",
            accountIdentityHash: "must-not-be-printed",
          }),
        ),
    },
  );

  assert.equal(code, 5);
  assert.match(
    terminal.text(),
    /DIAGNOSTIC=Insufficient funds — account-wide USD-equivalent available balance is too low/u,
  );
  assert.match(terminal.text(), /ORDER_NOTIONAL_USDT=8/u);
  assert.match(terminal.text(), /AVAILABLE_BALANCE_USD_EQUIVALENT=1\.25/u);
  assert.match(terminal.text(), /ENTRY_FEE_RESERVE_USDT=0\.0044/u);
  assert.match(terminal.text(), /EXIT_FEE_RESERVE_USDT=0\.0045/u);
  assert.match(terminal.text(), /TOTAL_FEE_RESERVE_USDT=0\.0089/u);
  assert.match(
    terminal.text(),
    /REQUIRED_AVAILABLE_BALANCE_USD_EQUIVALENT=8\.0089/u,
  );
  assert.match(terminal.text(), /SHORTFALL_USD_EQUIVALENT=6\.7589/u);
  assert.match(
    terminal.text(),
    /CAPACITY_EXPLANATION=.*account-wide USD-equivalent capacity.*USDT notional/u,
  );
  assert.match(
    terminal.text(),
    /REASON_CODE=AVAILABLE_MARGIN_OR_FEE_RESERVE_INSUFFICIENT/u,
  );
  assert.match(terminal.text(), /EXPLANATION=The approved order exceeds/u);
  assert.match(
    terminal.text(),
    /WHY=Bybit totalAvailableBalance was compared/u,
  );
  assert.match(terminal.text(), /EXECUTION_STATE=EXECUTION_NOT_STARTED/u);
  assert.match(terminal.text(), /EXCHANGE_READS=7/u);
  assert.match(terminal.text(), /EXCHANGE_WRITES=0/u);
  assert.match(
    terminal.text(),
    /NEXT_ACTION=add funds to the trading account or reduce the proposed order; prepare a new plan and obtain fresh exact-plan confirmation before another attempt/u,
  );
  assert.doesNotMatch(terminal.text(), /must-not-be-printed/u);
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
          plan: {
            schemaVersion: "operator-mainnet-execution-test/v1",
            policyVersion: "operator-mainnet-test/v1",
            contentHash: `sha256:${"a".repeat(64)}`,
          },
          source: {
            clientOrderId: "order\rINJECTED",
            planHash: `sha256:${"a".repeat(64)}`,
            approvalHash: `sha256:${"b".repeat(64)}`,
            payloadHash: `sha256:${"c".repeat(64)}`,
          },
          attempt: { outcome: "ambiguous" },
          reconciliations: [
            {
              canonicalJson: JSON.stringify({
                evidence: {
                  executedEntryQuantity: "0.08",
                  tpExitQuantity: "0.02",
                  parent: {
                    exchangeOrderId: "observed-parent-order",
                    remainingQuantity: "0",
                  },
                  tpChildren: [
                    {
                      exchangeOrderId: "observed-tp-order",
                      clientOrderId: "observed-tp-client",
                      status: "open",
                      requestedQuantity: "0.08",
                      filledQuantity: "0.02",
                      triggerPrice: "100.2",
                    },
                  ],
                  activeOwnedOrderIds: [
                    "observed-parent-order",
                    "observed-tp-order",
                  ],
                  position: { side: "long", quantity: "0.06" },
                },
              }),
            },
          ],
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
  assert.match(terminal.text(), /POLICY_VERSION=operator-mainnet-test\/v1/u);
  assert.match(terminal.text(), /PLAN_HASH=sha256:/u);
  assert.match(terminal.text(), /APPROVAL_HASH=sha256:/u);
  assert.match(terminal.text(), /PAYLOAD_HASH=sha256:/u);
  assert.match(terminal.text(), /EXCHANGE_ORDER_ID=observed-parent-order/u);
  assert.match(terminal.text(), /TP_CHILD_COUNT=1/u);
  assert.match(
    terminal.text(),
    /TP_CHILD_1_EXCHANGE_ORDER_ID=observed-tp-order/u,
  );
  assert.match(
    terminal.text(),
    /TP_CHILD_1_CLIENT_ORDER_ID=observed-tp-client/u,
  );
  assert.match(terminal.text(), /ACTIVE_OWNED_ORDER_COUNT=2/u);
  assert.match(terminal.text(), /ACTIVE_OWNED_ORDER_ID_2=observed-tp-order/u);
  assert.match(terminal.text(), /EXECUTED_ENTRY_QUANTITY=0.08/u);
  assert.match(terminal.text(), /TP_EXIT_QUANTITY=0.02/u);
  assert.match(terminal.text(), /ENTRY_REMAINDER_QUANTITY=0/u);
  assert.match(terminal.text(), /POSITION_QUANTITY=0.06/u);
  assert.match(terminal.text(), /UNCERTAINTY=PROOFINJECTED/u);
  assert.match(terminal.text(), /NEXT_ACTION=inspect the parent remainder/u);
  assert.match(terminal.text(), /EXCHANGE_READS=4/u);
  assert.match(terminal.text(), /EXCHANGE_WRITES=0/u);
  assert.equal(terminal.text().includes("\nINJECTED\n"), false);
});

test("incomplete venue bounds produce actionable allowlisted diagnostics without raw error text", async () => {
  const terminal = streams(false);
  const code = await runMainnetOperatorTestCli(
    [
      "prepare",
      "--symbol",
      "DOGEUSDT",
      "--allocation",
      "10",
      "--gross-cap",
      "10",
      "--max-deviation-bps",
      "10",
    ],
    {
      ...terminal,
      prepare: async () =>
        fail(
          domainError(
            "INVALID_PLAN",
            "PRIVATE_PROVIDER_SECRET\nINJECTED=unsafe",
            {
              reasonCode: "INSTRUMENT_CONSTRAINTS_INCOMPLETE_OR_MISMATCHED",
              exchangeReads: 68,
              exchangeWrites: 0,
            },
          ),
        ),
    },
  );
  assert.equal(code, 4);
  assert.match(
    terminal.text(),
    /REASON_DETAIL=.*minPrice, maxPrice, maxLimitQuantity/u,
  );
  assert.match(
    terminal.text(),
    /NEXT_ACTION=verify complete same-symbol instruments-info mapping/u,
  );
  assert.match(terminal.text(), /EXCHANGE_WRITES=0/u);
  assert.doesNotMatch(terminal.text(), /PRIVATE_PROVIDER_SECRET|INJECTED/u);
});

test("quote precision failures expose a safe reason without printing raw provider errors", async () => {
  for (const reasonCode of [
    "PROVIDER_TIME_PRECISION_INSUFFICIENT",
    "PROVIDER_TIME_INVALID_OR_INCONSISTENT",
    "PUBLIC_MARKET_PRECONDITION",
  ]) {
    const terminal = streams(false);
    const code = await runMainnetOperatorTestCli(
      [
        "prepare",
        "--symbol",
        "DOGEUSDT",
        "--allocation",
        "10",
        "--gross-cap",
        "10",
        "--max-deviation-bps",
        "10",
      ],
      {
        ...terminal,
        prepare: async () =>
          fail(
            domainError(
              "INVALID_EVIDENCE",
              "PRIVATE_RESPONSE_SECRET\nINJECTED=1",
              { reasonCode, exchangeReads: 67, exchangeWrites: 0 },
            ),
          ),
      },
    );
    assert.equal(code, 4);
    assert.match(terminal.text(), new RegExp(`REASON_CODE=${reasonCode}`, "u"));
    assert.match(terminal.text(), /REASON_DETAIL=/u);
    assert.match(terminal.text(), /EXCHANGE_WRITES=0/u);
    assert.doesNotMatch(terminal.text(), /PRIVATE_RESPONSE_SECRET|INJECTED/u);
  }
});

test("failed execution retains recovery instructions when intent or dispatch evidence is uncertain", async () => {
  for (const scenario of [
    "intent",
    "journal-failed",
    "writes-unknown",
    "writes-positive",
    "thrown",
  ] as const) {
    const terminal = streams(true);
    let reads = 0;
    const code = await runMainnetOperatorTestCli(
      ["execute", "--plan-hash", plan.contentHash],
      {
        ...terminal,
        resolvePlan: () => resolvedPlan(),
        hasDurableIntent: () => {
          if (++reads === 1) return ok(false);
          if (scenario === "journal-failed")
            return fail(domainError("PERSISTENCE_SCHEMA", "unavailable"));
          return ok(scenario === "intent");
        },
        prompt: async () => "yes",
        clock: () => Date.parse(NOW),
        actor: () => "operator-test",
        execute: async () => {
          if (scenario === "thrown") throw new Error("secret provider body");
          return fail(
            domainError("INVALID_CAPABILITY", "secret provider body", {
              reasonCode: "FEE_RATE_RESPONSE_INVALID",
              exchangeReads: 8,
              ...(scenario === "writes-unknown"
                ? {}
                : { exchangeWrites: scenario === "writes-positive" ? 1 : 0 }),
            }),
          );
        },
      },
    );
    assert.equal(code, 5);
    assert.match(terminal.text(), /(?:EXECUTION_STATE|VERDICT)=RECOVERY_ONLY/u);
    assert.match(terminal.text(), /NEXT_ACTION=run mainnet:test status/u);
    assert.doesNotMatch(
      terminal.text(),
      /EXECUTION_NOT_STARTED|secret provider/u,
    );
  }
});

test("unknown post-intent execution gives concrete manual Bybit guidance without an automatic resend", async () => {
  const terminal = streams(true);
  let calls = 0;
  const code = await runMainnetOperatorTestCli(
    ["execute", "--plan-hash", plan.contentHash],
    {
      ...terminal,
      resolvePlan: () => resolvedPlan(),
      hasDurableIntent: () => ok(false),
      prompt: async () => "yes",
      clock: () => Date.parse(NOW),
      actor: () => "operator-test",
      execute: async () => {
        calls += 1;
        return ok({
          kind: "recovery",
          sourceId,
          clientOrderId: plan.clientOrderId,
          attemptOutcome: "ambiguous",
          exchangeReads: 8,
          exchangeWrites: 1,
        });
      },
    },
  );
  assert.equal(code, 5);
  assert.equal(calls, 1);
  assert.match(terminal.text(), /EXECUTION_STATE=RECOVERY_ONLY/u);
  assert.match(
    terminal.text(),
    /inspect Bybit UI orders, fills and position using CLIENT_ORDER_ID/u,
  );
  assert.match(terminal.text(), /do not resend this source/u);
});

test("pre-intent critical state errors expose only safe groups and quote drift explains next action", async () => {
  for (const [reasonCode, groups, expected] of [
    [
      "QUOTE_OUTSIDE_APPROVED_RANGE",
      undefined,
      /fresh best bid is outside the approved range/u,
    ],
    [
      "CRITICAL_STATE_CHANGED",
      "assets,orders",
      /CRITICAL_CHANGED_GROUPS=assets,orders/u,
    ],
    [
      "CRITICAL_STATE_CHANGED",
      "secret-provider-value\nLEAK=1",
      /REASON_CODE=CRITICAL_STATE_CHANGED/u,
    ],
  ] as const) {
    const terminal = streams(true);
    const code = await runMainnetOperatorTestCli(
      ["execute", "--plan-hash", plan.contentHash],
      {
        ...terminal,
        resolvePlan: () => resolvedPlan(),
        hasDurableIntent: () => ok(false),
        prompt: async () => "yes",
        clock: () => Date.parse(NOW),
        actor: () => "operator-test",
        execute: async () =>
          fail(
            domainError("INVALID_EVIDENCE", "private provider message", {
              reasonCode,
              exchangeReads: 77,
              exchangeWrites: 0,
              ...(groups === undefined
                ? {}
                : { criticalChangedGroups: groups }),
            }),
          ),
      },
    );
    assert.equal(code, 5);
    assert.match(terminal.text(), expected);
    assert.match(terminal.text(), /EXECUTION_NOT_STARTED/u);
    assert.match(terminal.text(), /EXPLANATION=/u);
    assert.match(terminal.text(), /WHY=/u);
    assert.match(terminal.text(), /NEXT_ACTION=/u);
    if (reasonCode === "CRITICAL_STATE_CHANGED") {
      assert.match(
        terminal.text(),
        groups === "assets,orders"
          ? /WHY=The changed evidence group is assets,orders\./u
          : /WHY=The exact changed field was not localized/u,
      );
    }
    assert.doesNotMatch(
      terminal.text(),
      /secret-provider-value|LEAK|private provider message/u,
    );
  }
});

test("operator failure output shows allowlisted quote, freshness, permission and target-state details", async () => {
  const cases = [
    {
      reasonCode: "QUOTE_OUTSIDE_APPROVED_RANGE",
      details: {
        source: "quote",
        quoteBid: "101",
        approvedBidLower: "99",
        approvedBidUpper: "100",
        quoteObservedAt: NOW,
        allowedDeviationBps: "10",
        privatePayload: "must-not-be-printed",
      },
      expected: [
        /WHY=Fresh bid 101 is outside the approved range 99–100\./u,
        /QUOTE_BID=101/u,
        /ALLOWED_DEVIATION_BPS=10/u,
        new RegExp(`QUOTE_OBSERVED_AT=${NOW}`),
      ],
    },
    {
      reasonCode: "MAINNET_EVIDENCE_STALE",
      details: {
        source: "quote",
        ageMs: 5_200,
        limitMs: 5_000,
        quoteObservedAt: NOW,
        providerMessage: "must-not-be-printed",
      },
      expected: [
        /WHY=quote evidence is 5200 ms old; the allowed freshness limit is 5000 ms\./u,
        /EVIDENCE_AGE_MS=5200/u,
        /FRESHNESS_LIMIT_MS=5000/u,
      ],
    },
    {
      reasonCode: "CREDENTIAL_PERMISSION_BLOCKED",
      details: {
        source: "account",
        readOnly: false,
        contractOrder: true,
        contractPosition: false,
        walletTransfer: false,
        withdraw: false,
        apiKey: "must-not-be-printed",
      },
      expected: [
        /Collected permission flags: read-only=false, contract order=true, contract position=false/u,
        /CONTRACT_POSITION_PERMISSION=false/u,
      ],
    },
    {
      reasonCode: "TARGET_STATE_OR_CAPABILITY_BLOCKED",
      details: {
        source: "position",
        positionSide: "long",
        positionQuantity: "0.01",
        accountId: "must-not-be-printed",
      },
      expected: [
        /A long target position of 0\.01 was already present\./u,
        /POSITION_SIDE=long/u,
        /POSITION_QUANTITY=0\.01/u,
      ],
    },
  ] as const;

  for (const item of cases) {
    const terminal = streams(true);
    const code = await runMainnetOperatorTestCli(
      ["execute", "--plan-hash", plan.contentHash],
      {
        ...terminal,
        resolvePlan: () => resolvedPlan(),
        hasDurableIntent: () => ok(false),
        prompt: async () => "yes",
        clock: () => Date.parse(NOW),
        actor: () => "operator-test",
        execute: async () =>
          fail(
            domainError("INVALID_EVIDENCE", "private provider text", {
              reasonCode: item.reasonCode,
              exchangeReads: 7,
              exchangeWrites: 0,
              ...item.details,
            }),
          ),
      },
    );

    assert.equal(code, 5);
    for (const expected of item.expected)
      assert.match(terminal.text(), expected);
    assert.match(terminal.text(), /REASON_CODE=/u);
    assert.match(terminal.text(), /EXPLANATION=/u);
    assert.match(terminal.text(), /NEXT_ACTION=/u);
    assert.doesNotMatch(
      terminal.text(),
      /must-not-be-printed|private provider text/u,
    );
  }
});

test("execute GET breakdown survives a pre-intent failure and suppresses unsafe metric groups", async () => {
  for (const [metrics, expected] of [
    ['{"fees":1,"wallet":2}', /GET_COUNTS_EXECUTE=\{"fees":1,"wallet":2\}/u],
    ['{"private-account":1}', undefined],
  ] as const) {
    const terminal = streams(true);
    const code = await runMainnetOperatorTestCli(
      ["execute", "--plan-hash", plan.contentHash],
      {
        ...terminal,
        resolvePlan: () => resolvedPlan(),
        hasDurableIntent: () => ok(false),
        prompt: async () => "yes",
        clock: () => Date.parse(NOW),
        actor: () => "operator-test",
        execute: async () =>
          fail(
            domainError("INVALID_EVIDENCE", "blocked", {
              reasonCode: "FEE_RATE_EVIDENCE_INVALID",
              exchangeReads: 3,
              exchangeWrites: 0,
              exchangeGetCounts: metrics,
            }),
          ),
      },
    );
    assert.equal(code, 5);
    if (expected) assert.match(terminal.text(), expected);
    else
      assert.doesNotMatch(
        terminal.text(),
        /GET_COUNTS_EXECUTE|private-account/u,
      );
    assert.match(terminal.text(), /EXECUTION_NOT_STARTED/u);
  }
});

test("prepare prints fee-inclusive shortfall and safe fallback counts before any approval", async () => {
  for (const zero of [false, true]) {
    const terminal = streams(false);
    const code = await runMainnetOperatorTestCli(
      [
        "prepare",
        "--symbol",
        "DOGEUSDT",
        "--allocation",
        "10",
        "--gross-cap",
        "10",
        "--max-deviation-bps",
        "10",
      ],
      {
        ...terminal,
        prepare: async () =>
          fail(
            domainError("INVALID_EVIDENCE", "PRIVATE_SECRET", {
              reasonCode: "AVAILABLE_MARGIN_OR_FEE_RESERVE_INSUFFICIENT",
              availableBalance: zero ? "0" : "10",
              ...(zero
                ? {}
                : {
                    orderNotional: "10",
                    entryFeeReserve: "0.01",
                    exitFeeReserve: "0.01002",
                    totalReserve: "0.02002",
                    requiredAvailableBalance: "10.02002",
                    shortfall: "0.02002",
                  }),
              compactFallbackReason: "ACCOUNT_CAPACITY_INCOMPLETE",
              exchangeGetCounts: '{"fees":1,"wallet":2}',
              exchangeReads: 3,
              exchangeWrites: 0,
            }),
          ),
      },
    );
    assert.equal(code, 4);
    assert.match(
      terminal.text(),
      new RegExp(`AVAILABLE_BALANCE_USD_EQUIVALENT=${zero ? "0" : "10"}`),
    );
    assert.match(
      terminal.text(),
      /PREPARE_COMPACT_FALLBACK_REASON=ACCOUNT_CAPACITY_INCOMPLETE/u,
    );
    assert.match(terminal.text(), /GET_COUNTS_PREPARE=.*"fees":1/u);
    if (zero) {
      assert.match(
        terminal.text(),
        /Exact order and fee amounts were not calculated/u,
      );
      assert.doesNotMatch(terminal.text(), /SHORTFALL_USD_EQUIVALENT=/u);
    } else {
      assert.match(
        terminal.text(),
        /REQUIRED_AVAILABLE_BALANCE_USD_EQUIVALENT=10.02002/u,
      );
      assert.match(terminal.text(), /SHORTFALL_USD_EQUIVALENT=0.02002/u);
    }
    assert.doesNotMatch(terminal.text(), /PRIVATE_SECRET/u);
    assert.match(terminal.text(), /NEXT_ACTION=add funds/u);
  }
});
