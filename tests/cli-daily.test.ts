import assert from "node:assert/strict";
import { test } from "node:test";
import {
  runDailyCommand,
  parseDailyArguments,
  renderPreparedReview,
} from "../src/cli/daily-command.js";
import { preparedPlanFixture } from "./fixtures/prepared-plan-fixtures.js";
import { ok } from "../src/domain/shared/result.js";
import { fail } from "../src/domain/shared/result.js";
import { domainError } from "../src/domain/shared/errors.js";
import { fixedClock } from "../src/domain/shared/time.js";
import type { PreparedPlanApproval } from "../src/domain/review/prepared-plan-approval.js";

test("closed CLI surface rejects authority overrides before any dependencies", async () => {
  for (const flag of [
    "--actor",
    "--yes",
    "--composition",
    "--policy",
    "--daily-plan",
    "--evaluation-time",
  ]) {
    assert.equal(
      parseDailyArguments([
        "prepare",
        "--environment",
        "mainnet",
        "--symbol",
        "BTCUSDT",
        "--allocation",
        "100",
        flag,
        "x",
      ]).ok,
      false,
    );
  }
  let used = false;
  const code = await runDailyCommand(
    [
      "prepare",
      "--environment",
      "mainnet",
      "--symbol",
      "BTCUSDT",
      "--allocation",
      "0",
    ],
    {
      prepare: async () => {
        used = true;
        throw new Error("should not run");
      },
      openStore: () => {
        used = true;
        throw new Error("should not run");
      },
      actor: () => {
        used = true;
        throw new Error("should not run");
      },
      clock: {
        now: () => {
          used = true;
          throw new Error("should not run");
        },
      },
      interactive: false,
      prompt: async () => {
        used = true;
        throw new Error("should not run");
      },
      write: () => {},
    },
  );
  assert.equal(code, 2);
  assert.equal(used, false);
});

test("offline review/approval renders informational absence, binds derived actor and rejects redirected consent", async () => {
  const prepared = preparedPlanFixture("review");
  const clock = fixedClock("2026-09-24T14:00:10Z");
  assert.ok(clock.ok);
  const saved: PreparedPlanApproval[] = [];
  let privateCalls = 0;
  let prompts = 0;
  const output: string[] = [];
  const dependencies = {
    prepare: async () => {
      privateCalls++;
      throw new Error("offline");
    },
    openStore: () =>
      ok({
        savePrepared: () => ok(undefined),
        loadPrepared: () => ok(prepared),
        saveApproval: (a: PreparedPlanApproval) => {
          saved.push(a);
          return ok(undefined);
        },
        loadApproval: () => ok(undefined),
        close: () => {},
      }),
    actor: () => ok("local-operator:trusted"),
    clock: clock.value,
    interactive: false,
    prompt: async () => {
      prompts++;
      return "yes";
    },
    write: (s: string) => {
      output.push(s);
    },
  };
  const args = [
    "--environment",
    prepared.inputIdentity.environment,
    "--prepared-hash",
    prepared.contentHash,
  ];
  assert.equal(await runDailyCommand(["review", ...args], dependencies), 0);
  assert.equal(
    await runDailyCommand(
      ["approve", ...args, "--note", "reviewed"],
      dependencies,
    ),
    3,
  );
  assert.equal(prompts, 0);
  assert.equal(saved.length, 0);
  assert.equal(
    await runDailyCommand(["approve", ...args, "--note", "reviewed"], {
      ...dependencies,
      interactive: true,
    }),
    0,
  );
  assert.equal(saved[0]?.actor, "local-operator:trusted");
  assert.equal(saved[0]?.executionAuthority, "none");
  assert.equal(privateCalls, 0);
  assert.equal(
    await runDailyCommand(["approve", ...args, "--note", "reviewed"], {
      ...dependencies,
      interactive: true,
      actor: () => fail(domainError("INVALID_VALUE", "unavailable")),
    }),
    4,
  );
  assert.equal(
    await runDailyCommand(["approve", ...args, "--note", "reviewed"], {
      ...dependencies,
      interactive: true,
      prompt: async () => "no",
    }),
    3,
  );
  assert.equal(
    await runDailyCommand(["approve", ...args], {
      ...dependencies,
      interactive: true,
      prompt: async () => {
        throw new Error("EOF");
      },
    }),
    3,
  );
  assert.equal(
    await runDailyCommand(["approve", ...args], {
      ...dependencies,
      interactive: true,
      prompt: async () => " ",
    }),
    5,
  );
  assert.equal(
    await runDailyCommand(
      [
        "review",
        "--environment",
        "mainnet",
        "--prepared-hash",
        prepared.contentHash,
      ],
      dependencies,
    ),
    prepared.inputIdentity.environment === "mainnet" ? 0 : 4,
  );
  assert.equal(saved.length, 1);
  assert.ok(output.join("\n").includes("PROVISIONAL_POLICY"));
  const rendered = renderPreparedReview(prepared);
  for (const name of [
    "market-regime",
    "early-warning-risk",
    "liquidity-stress",
    "trap",
  ])
    assert.ok(rendered.includes(name));
  assert.ok(rendered.includes("not-configured"));
  assert.ok(rendered.includes("Historical"));
  assert.ok(!rendered.includes("synthetic-secret"));
});
