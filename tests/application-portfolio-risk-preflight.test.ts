import assert from "node:assert/strict";
import test from "node:test";

import { createPortfolioRiskPreflightBoundary } from "../src/application/portfolio-risk-preflight.js";
import { createDataQualityBoundary } from "../src/application/data-quality-assessment.js";
import type { DataQualityBoundary } from "../src/application/data-quality-assessment.js";
import type { PortfolioRiskEvidenceReadPort } from "../src/ports/portfolio-risk-evidence.js";
import { mapAccountPositions } from "../src/adapters/bybit-v5/account-read-mappers.js";
import { hashCanonical } from "../src/domain/identity/canonical-serialization.js";
import type { AccountEvidenceEnvironment } from "../src/domain/account/account-evidence-bundle.js";
import { createDailyDecisionPlan } from "../src/domain/planning/daily-decision-plan.js";
import { BybitAccountReadError } from "../src/adapters/bybit-v5/account-read-transport.js";
import {
  parseUtcTimestamp,
  type UtcTimestamp,
} from "../src/domain/shared/time.js";
import {
  portfolioRiskPolicyInput,
  portfolioRiskPosition,
  portfolioRiskAccountInput,
} from "./fixtures/portfolio-risk-fixtures.js";
import { portfolioRiskPlanningFixture } from "./fixtures/portfolio-risk-planning-fixtures.js";
import {
  decimal as accountDecimal,
  withCounts,
} from "./account-evidence-fixture.js";
import {
  analyticsFixture,
  externalEvidenceFixture,
} from "./fixtures/data-quality-fixtures.js";
import { dailyQualityProfileFixture } from "./fixtures/daily-planning-evidence-fixtures.js";

const credentials = {
  apiKey: "synthetic-key",
  apiSecret: "synthetic-secret",
  accountId: "123",
};
function utc(value: string): UtcTimestamp {
  const parsed = parseUtcTimestamp(value);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("invalid timestamp fixture");
  return parsed.value;
}
function requireQualityBoundary(
  result: ReturnType<typeof createDataQualityBoundary>,
): DataQualityBoundary {
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("invalid quality boundary fixture");
  return result.value;
}
const providerTime = utc("2026-10-02T12:00:03.000Z");
const byEnvironment: Record<AccountEvidenceEnvironment, string> = {
  demo: "https://api-demo.bybit.com",
  testnet: "https://api-testnet.bybit.com",
  mainnet: "https://api.bybit.com",
};

function queryIdentityHash(environment: AccountEvidenceEnvironment) {
  const result = hashCanonical({
    exchange: "bybit",
    environment,
    userID: "123",
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("fixture identity hash failed");
  return result.value;
}

function accountFixture(
  options: {
    readonly environment?: AccountEvidenceEnvironment;
    readonly leverage?: string | null;
    readonly noTargetPosition?: boolean;
  } = {},
) {
  const environment = options.environment ?? "demo";
  const leverage =
    options.leverage === null
      ? {
          state: "unavailable" as const,
          reason: "not-returned" as const,
          unit: "rate" as const,
        }
      : accountDecimal(options.leverage ?? "1", "rate");
  const basePosition = portfolioRiskPosition();
  const position = { ...basePosition, leverage } as typeof basePosition;
  const raw = portfolioRiskAccountInput({
    positions: options.noTargetPosition ? [] : [position],
  });
  const funded = {
    ...raw,
    criticalPasses: {
      A: {
        ...raw.criticalPasses.A!,
        totals: {
          ...raw.criticalPasses.A!.totals,
          totalAvailableBalance: accountDecimal("1000", "USD"),
        },
      },
      B: {
        ...raw.criticalPasses.B!,
        totals: {
          ...raw.criticalPasses.B!.totals,
          totalAvailableBalance: accountDecimal("1000", "USD"),
        },
      },
    },
  };
  return withCounts({
    ...funded,
    accountBinding: {
      ...raw.accountBinding,
      environment,
      origin: byEnvironment[environment],
      accountIdentityHash: queryIdentityHash(environment),
    },
  });
}

function providerIdentity(userID: string | number = 123) {
  return {
    time: Date.parse(providerTime),
    result: {
      userID,
      readOnly: 1,
      permissions: { ContractTrade: [], Spot: [], Wallet: [] },
      ips: [],
      expiredAt: "",
    },
  };
}

function targetRows(
  options: {
    readonly side?: string;
    readonly size?: string;
    readonly leverage?: string;
  } = {},
) {
  return mapAccountPositions(
    {
      time: Date.parse(providerTime),
      result: {
        category: "linear",
        list: [
          {
            symbol: "BTCUSDT",
            positionIdx: 0,
            side: options.side ?? "",
            size: options.size ?? "0",
            leverage: options.leverage ?? "1",
            seq: "-1",
          },
        ],
        nextPageCursor: "",
      },
    },
    "linear",
  );
}

function setup(
  options: {
    readonly account?: unknown;
    readonly identity?: () => Promise<unknown>;
    readonly positions?: () => Promise<{
      readonly rows: ReturnType<typeof targetRows>;
      readonly observedAt: UtcTimestamp;
    }>;
    readonly exchangeTime?: () => Promise<UtcTimestamp>;
    readonly readerEnvironment?: AccountEvidenceEnvironment;
    readonly readerOrigin?: string;
    readonly recommendation?: "ADD_LONG" | "REDUCE_LONG" | "HOLD_LONG";
    readonly dailyPlan?: unknown;
    readonly qualityProfile?: unknown;
    readonly qualityBoundary?: DataQualityBoundary;
  } = {},
) {
  const fixture = portfolioRiskPlanningFixture({
    ...(options.recommendation
      ? { recommendation: options.recommendation }
      : {}),
    fundingRate: "0",
  });
  const events: string[] = [];
  let credentialLoads = 0;
  let readerCreations = 0;
  const boundary = createPortfolioRiskPreflightBoundary({
    policy: portfolioRiskPolicyInput(),
    qualityProfile: options.qualityProfile ?? fixture.qualityProfile,
    qualityBoundary:
      options.qualityBoundary ??
      requireQualityBoundary(
        createDataQualityBoundary({
          qualityProfile: fixture.qualityProfile,
          issuer: "portfolio-risk-fixture",
        }),
      ),
    credentialLoader: {
      load: async (environment) => {
        credentialLoads++;
        events.push(`credentials:${environment}`);
        return credentials;
      },
    },
    createReader: ({ environment }) => {
      readerCreations++;
      const readPort: PortfolioRiskEvidenceReadPort = {
        environment: options.readerEnvironment ?? environment,
        origin: options.readerOrigin ?? byEnvironment[environment],
        readIdentity: async () => {
          events.push("identity");
          return (
            options.identity ?? (async () => providerIdentity())
          )() as never;
        },
        readTargetPositions: async (symbol) => {
          events.push(`positions:${symbol}`);
          return (
            options.positions ??
            (async () => ({ rows: targetRows(), observedAt: providerTime }))
          )();
        },
        readExchangeTime: async () => {
          events.push("exchange-time");
          return (options.exchangeTime ?? (async () => providerTime))();
        },
        requestCount: () =>
          events.filter(
            (event) =>
              ["identity", "exchange-time"].includes(event) ||
              event.startsWith("positions:"),
          ).length,
      };
      return readPort;
    },
    monotonicClock: () => 10,
  });
  assert.equal(boundary.ok, true);
  if (!boundary.ok) throw new Error("risk boundary fixture is invalid");
  return {
    boundary: boundary.value,
    events,
    get credentialLoads() {
      return credentialLoads;
    },
    get readerCreations() {
      return readerCreations;
    },
    input: {
      dailyPlan: options.dailyPlan ?? fixture.dailyPlan,
      account: options.account ?? accountFixture(),
    },
  };
}

test("a mismatched configured quality profile fails before credentials or reads", async () => {
  const fixture = portfolioRiskPlanningFixture({ fundingRate: "0" });
  const events: string[] = [];
  const created = createPortfolioRiskPreflightBoundary({
    policy: portfolioRiskPolicyInput(),
    qualityProfile: {
      ...fixture.qualityProfile,
      profileVersion: "different-profile",
    },
    qualityBoundary: requireQualityBoundary(
      createDataQualityBoundary({
        qualityProfile: fixture.qualityProfile,
        issuer: "portfolio-risk-fixture",
      }),
    ),
    credentialLoader: {
      load: async () => {
        events.push("credentials");
        return credentials;
      },
    },
    createReader: () => {
      events.push("reader");
      throw new Error("must not create a provider reader");
    },
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const result = await created.value.prepare({
    dailyPlan: fixture.dailyPlan,
    account: accountFixture(),
  });
  assert.equal(result.kind, "admission-failure");
  if (result.kind === "admission-failure")
    assert.equal(result.code, "QUALITY_PROFILE_MISMATCH");
  assert.deepEqual(events, []);
});

test("serialized external issuer claims require current application-controlled admission", async () => {
  const baseline = portfolioRiskPlanningFixture({ fundingRate: "0" });
  const family = "market-regime-score" as const;
  const external = externalEvidenceFixture(family, baseline.market);
  const qualityProfileInput = {
    ...dailyQualityProfileFixture(),
    roles: [
      ...dailyQualityProfileFixture().roles,
      { id: `external:${family}`, required: true, maxAgeMs: 60_000 },
    ],
    trust: [
      {
        issuer: "fixture-trusted-issuer",
        family,
        producer: external.provenance.producer,
        schemaVersion: external.schemaVersion,
        modelVersion: external.modelVersion,
      },
    ],
  };
  const trustedBoundary = requireQualityBoundary(
    createDataQualityBoundary({
      qualityProfile: qualityProfileInput,
      issuer: "fixture-trusted-issuer",
      ingestExternal: () => external,
    }),
  );
  const analytics = analyticsFixture(baseline.market, {
    profile: {
      schemaVersion: "analytics-profile/v1",
      features: [
        {
          id: "atr",
          kind: "atr",
          symbol: "BTCUSDT",
          interval: "1h",
          period: 1,
          required: true,
        },
        {
          id: "return",
          kind: "close-return",
          symbol: "BTCUSDT",
          interval: "1h",
          periods: 1,
          required: true,
        },
      ],
      externalEvidence: [{ family, required: true }],
    },
    externalEvidence: { [family]: external },
  });
  const assessment = trustedBoundary.assess({
    sources: [
      { role: "market", value: baseline.market },
      { role: "analytics", value: analytics },
    ],
    bundleCutoff: baseline.market.bundleCutoff,
    evaluationTime: baseline.market.bundleCutoff,
  });
  assert.equal(assessment.ok, true);
  if (!assessment.ok) return;
  assert.equal(assessment.value.qualityGate, "OK");
  const dailyPlan = createDailyDecisionPlan({
    ...baseline.dailyPlan.inputs,
    analytics,
    assessment: assessment.value,
  });
  assert.equal(dailyPlan.ok, true);
  if (!dailyPlan.ok) return;

  const acceptedSetup = setup({
    dailyPlan: dailyPlan.value,
    qualityProfile: qualityProfileInput,
    qualityBoundary: trustedBoundary,
  });
  const accepted = await acceptedSetup.boundary.prepare(acceptedSetup.input);
  assert.equal(accepted.kind, "evaluated", JSON.stringify(accepted));

  const untrustedBoundary = requireQualityBoundary(
    createDataQualityBoundary({
      qualityProfile: qualityProfileInput,
      issuer: "fixture-untrusted-issuer",
    }),
  );
  const untrustedSetup = setup({
    dailyPlan: dailyPlan.value,
    qualityProfile: qualityProfileInput,
    qualityBoundary: untrustedBoundary,
  });
  const rejected = await untrustedSetup.boundary.prepare(untrustedSetup.input);
  assert.equal(rejected.kind, "admission-failure");
  if (rejected.kind === "admission-failure")
    assert.equal(rejected.code, "QUALITY_ASSESSMENT_MISMATCH");
  assert.equal(untrustedSetup.credentialLoads, 0);
  assert.deepEqual(untrustedSetup.events, []);
});

test("known pass-B leverage still authenticates account identity before evaluation", async () => {
  const setupResult = setup();
  const result = await setupResult.boundary.prepare(setupResult.input);
  assert.equal(result.kind, "evaluated", JSON.stringify(result));
  if (result.kind !== "evaluated") return;
  assert.equal(result.preflight.evaluationTime, providerTime);
  assert.equal(result.supplementalEvidenceStatus, "not-needed");
  assert.deepEqual(setupResult.events, [
    "credentials:demo",
    "identity",
    "exchange-time",
  ]);
  assert.equal(setupResult.credentialLoads, 1);
  assert.equal(setupResult.readerCreations, 1);
});

test("missing leverage on an absent flat target authenticates the same account before one symbol read", async () => {
  const setupResult = setup({
    account: accountFixture({ noTargetPosition: true }),
  });
  const result = await setupResult.boundary.prepare(setupResult.input);
  assert.equal(result.kind, "evaluated", JSON.stringify(result));
  if (result.kind !== "evaluated") return;
  assert.deepEqual(setupResult.events, [
    "credentials:demo",
    "identity",
    "positions:BTCUSDT",
    "exchange-time",
  ]);
  assert.equal(result.supplementalEvidenceStatus, "collected");
  assert.equal(result.preflight.replayInputs.supplementalEvidence.length, 1);
  assert.ok(!result.preflight.reasonCodes.includes("LEVERAGE_UNKNOWN"));
  assert.ok(
    result.preflight.capacity.leverage.checks.some(
      (check) =>
        check.symbol === "BTCUSDT" &&
        check.source === "supplemental" &&
        check.status === "pass",
    ),
  );
});

test("an empty supplemental response never fabricates a flat position or leverage", async () => {
  const setupResult = setup({
    account: accountFixture({ noTargetPosition: true }),
    positions: async () => ({ rows: [], observedAt: providerTime }),
  });
  const result = await setupResult.boundary.prepare(setupResult.input);
  assert.equal(result.kind, "evaluated", JSON.stringify(result));
  if (result.kind !== "evaluated") return;
  assert.equal(result.supplementalEvidenceStatus, "unavailable");
  assert.equal(result.preflight.replayInputs.supplementalEvidence.length, 0);
  assert.ok(result.preflight.reasonCodes.includes("LEVERAGE_UNKNOWN"));
  assert.equal(
    result.preflight.capacity.leverage.checks.find(
      (check) => check.symbol === "BTCUSDT",
    )?.source,
    "unavailable",
  );
});

test("a rejected supplemental target-position read is recorded and fails closed", async () => {
  const setupResult = setup({
    account: accountFixture({ noTargetPosition: true }),
    positions: async () => {
      throw new BybitAccountReadError("RATE_LIMITED");
    },
  });
  const result = await setupResult.boundary.prepare(setupResult.input);
  assert.equal(result.kind, "evaluated", JSON.stringify(result));
  if (result.kind !== "evaluated") return;
  assert.equal(result.supplementalEvidenceStatus, "failed");
  assert.equal(result.supplementalFailureCode, "RATE_LIMITED");
  assert.equal(result.preflight.verdict, "BLOCK");
  assert.ok(result.preflight.reasonCodes.includes("LEVERAGE_UNKNOWN"));
  assert.equal(result.preflight.actionProposal, null);
  assert.equal(
    result.preflight.materialization.reduction.status,
    "not-evaluated",
  );
});

test("wrong authenticated UID prevents any evaluation even when pass-B leverage is known", async () => {
  const setupResult = setup({ identity: async () => providerIdentity(456) });
  const result = await setupResult.boundary.prepare(setupResult.input);
  assert.equal(result.kind, "provider-failure", JSON.stringify(result));
  if (result.kind !== "provider-failure") return;
  assert.deepEqual(setupResult.events, ["credentials:demo", "identity"]);
  assert.equal(result.code, "ACCOUNT_IDENTITY_MISMATCH");
  assert.doesNotMatch(JSON.stringify(result), /synthetic-secret|456/u);
});

test("supplemental observations cannot conceal changed target facts", async () => {
  const setupResult = setup({
    account: accountFixture({ noTargetPosition: true }),
    positions: async () => ({
      rows: targetRows({ side: "Buy", size: "1" }),
      observedAt: providerTime,
    }),
  });
  const result = await setupResult.boundary.prepare(setupResult.input);
  assert.equal(result.kind, "evaluated", JSON.stringify(result));
  if (result.kind !== "evaluated") return;
  assert.equal(result.preflight.verdict, "BLOCK");
  assert.ok(
    result.preflight.reasonCodes.includes("SUPPLEMENTAL_EVIDENCE_CONFLICT"),
  );
});

test("final provider time after collection crossing 60 seconds blocks; caller time is rejected", async () => {
  const setupResult = setup({
    exchangeTime: async () => utc("2026-10-02T12:01:02.001Z"),
  });
  const backdated = await setupResult.boundary.prepare({
    ...setupResult.input,
    evaluationTime: providerTime,
  });
  assert.equal(backdated.kind, "admission-failure");
  if (backdated.kind === "admission-failure")
    assert.equal(backdated.code, "INVALID_INPUT");
  assert.deepEqual(setupResult.events, []);

  const freshSetup = setup({
    exchangeTime: async () => utc("2026-10-02T12:01:02.001Z"),
  });
  const result = await freshSetup.boundary.prepare(freshSetup.input);
  assert.equal(result.kind, "evaluated");
  if (result.kind !== "evaluated") return;
  assert.equal(
    result.preflight.evaluationTime,
    utc("2026-10-02T12:01:02.001Z"),
  );
  assert.equal(result.preflight.verdict, "BLOCK");
  assert.ok(result.preflight.reasonCodes.includes("ACCOUNT_EVIDENCE_STALE"));
});

test("a successful supplemental read cannot keep an expired account bundle usable", async () => {
  const setupResult = setup({
    account: accountFixture({ noTargetPosition: true }),
    exchangeTime: async () => utc("2026-10-02T12:01:02.001Z"),
  });
  const result = await setupResult.boundary.prepare(setupResult.input);
  assert.equal(result.kind, "evaluated", JSON.stringify(result));
  if (result.kind !== "evaluated") return;
  assert.deepEqual(setupResult.events, [
    "credentials:demo",
    "identity",
    "positions:BTCUSDT",
    "exchange-time",
  ]);
  assert.equal(result.supplementalEvidenceStatus, "collected");
  assert.equal(result.preflight.verdict, "BLOCK");
  assert.ok(result.preflight.reasonCodes.includes("ACCOUNT_EVIDENCE_STALE"));
});

test("HOLD and REDUCE never request supplemental leverage", async () => {
  for (const recommendation of ["HOLD_LONG", "REDUCE_LONG"] as const) {
    const setupResult = setup({
      recommendation,
      account: accountFixture({ noTargetPosition: true }),
    });
    const result = await setupResult.boundary.prepare(setupResult.input);
    assert.equal(result.kind, "evaluated", JSON.stringify(result));
    assert.deepEqual(setupResult.events, [
      "credentials:demo",
      "identity",
      "exchange-time",
    ]);
    if (result.kind === "evaluated")
      assert.equal(result.supplementalEvidenceStatus, "not-needed");
  }
});

test("reader environment/origin mismatch fails closed before private reads", async () => {
  const setupResult = setup({
    account: accountFixture({ environment: "mainnet", noTargetPosition: true }),
    readerEnvironment: "demo",
    readerOrigin: byEnvironment.demo,
  });
  const result = await setupResult.boundary.prepare(setupResult.input);
  assert.equal(result.kind, "provider-failure");
  if (result.kind === "provider-failure")
    assert.equal(result.code, "ORIGIN_MISMATCH");
  assert.deepEqual(setupResult.events, ["credentials:mainnet"]);
});
