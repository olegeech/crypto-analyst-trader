import assert from "node:assert/strict";
import test from "node:test";

import {
  accountEvidenceContentHash,
  createAccountEvidenceBundle,
} from "../src/domain/account/account-evidence-bundle.js";
import {
  createPortfolioRiskEvidenceSet,
  createPortfolioRiskEvidence,
  portfolioRiskEvidenceContentHash,
  validatePortfolioRiskLeverageEvidence,
} from "../src/domain/risk/portfolio-risk-evidence.js";
import { createPortfolioRiskPolicy } from "../src/domain/risk/portfolio-risk-policy.js";
import { fixture, position, withCounts } from "./account-evidence-fixture.js";
import { portfolioRiskPolicyInput } from "./fixtures/portfolio-risk-fixtures.js";

const evaluationTime = "2026-10-02T12:00:02.000Z";

function validAccount() {
  const account = createAccountEvidenceBundle(fixture());
  assert.equal(account.ok, true);
  if (!account.ok) throw new Error("account fixture must be valid");
  return account.value;
}

function evidenceInput(
  account = validAccount(),
  overrides: Record<string, unknown> = {},
) {
  const accountHash = accountEvidenceContentHash(account);
  assert.equal(accountHash.ok, true);
  if (!accountHash.ok) throw new Error("account hash must be valid");
  return {
    schemaVersion: "portfolio-risk-evidence/v1",
    kind: "target-leverage",
    environment: account.accountBinding.environment,
    accountIdentityHash: account.accountBinding.accountIdentityHash,
    accountEvidenceHash: accountHash.value,
    symbol: "BTCUSDT",
    observedAt: evaluationTime,
    rows: [
      {
        positionIdx: 0,
        side: "None",
        size: "0",
        leverage: "1",
        isReduceOnly: false,
      },
    ],
    ...overrides,
  };
}

function validate(
  evidence: unknown,
  account = validAccount(),
  expectedSymbol = "BTCUSDT",
  at = evaluationTime,
) {
  const policy = createPortfolioRiskPolicy(portfolioRiskPolicyInput());
  assert.equal(policy.ok, true);
  if (!policy.ok) throw new Error("policy fixture must be valid");
  return validatePortfolioRiskLeverageEvidence(evidence, account, {
    expectedSymbol,
    evaluationTime: at,
    policy: policy.value,
  });
}

test("flat same-account leverage evidence validates and canonical-round-trips", () => {
  const account = validAccount();
  const evidence = createPortfolioRiskEvidence(evidenceInput(account));
  assert.equal(evidence.ok, true);
  if (!evidence.ok) return;

  assert.equal(evidence.value.rows.length, 1);
  assert.equal(evidence.value.rows[0]?.leverage?.toString(), "1");
  const admitted = validate(evidence.value, account);
  assert.equal(admitted.ok, true);
  if (admitted.ok) assert.equal(admitted.value.leverage.toString(), "1");

  const encoded = JSON.parse(JSON.stringify(evidence.value)) as unknown;
  assert.deepEqual(createPortfolioRiskEvidence(encoded), evidence);

  const tampered = JSON.parse(JSON.stringify(evidence.value)) as {
    rows: { leverage: string | null }[];
  };
  tampered.rows[0]!.leverage = "2";
  assert.equal(createPortfolioRiskEvidence(tampered).ok, false);
});

test("supplemental evidence binds exact account, bundle, environment, and symbol", () => {
  const account = validAccount();
  const good = evidenceInput(account);
  const wrongHash = evidenceInput(account, {
    accountEvidenceHash: `sha256:${"b".repeat(64)}`,
  });
  const wrongIdentity = evidenceInput(account, {
    accountIdentityHash: `sha256:${"c".repeat(64)}`,
  });
  const wrongEnvironment = evidenceInput(account, { environment: "mainnet" });
  const wrongSymbol = evidenceInput(account, { symbol: "ETHUSDT" });

  for (const input of [wrongHash, wrongIdentity, wrongEnvironment])
    assert.equal(validate(input, account).ok, false);
  assert.equal(validate(good, account, "ETHUSDT").ok, false);
  assert.equal(validate(wrongSymbol, account).ok, false);
});

test("future and stale account or supplemental observations are rejected", () => {
  const account = validAccount();
  const future = evidenceInput(account, {
    observedAt: "2026-10-02T12:00:03.000Z",
  });
  assert.equal(validate(future, account).ok, false);
  const staleObservation = evidenceInput(account, {
    observedAt: "2026-10-02T11:00:00.000Z",
  });
  assert.equal(validate(staleObservation, account).ok, false);

  const exactlyFresh = "2026-10-02T12:01:02.000Z";
  assert.equal(
    validate(
      evidenceInput(account, { observedAt: evaluationTime }),
      account,
      "BTCUSDT",
      exactlyFresh,
    ).ok,
    true,
  );
  assert.equal(
    validate(
      evidenceInput(account, { observedAt: evaluationTime }),
      account,
      "BTCUSDT",
      "2026-10-02T12:01:02.001Z",
    ).ok,
    false,
  );
});

test("independently fresh supplemental leverage cannot predate account collection end", () => {
  const source = fixture();
  const created = createAccountEvidenceBundle({
    ...source,
    endedAt: "2026-10-02T12:00:30.000Z",
    collectionEndedAt: "2026-10-02T12:00:30.000Z",
    budget: { ...source.budget, monotonicDurationMs: 30_000 },
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const at = "2026-10-02T12:00:40.000Z";
  const rejected = validate(
    evidenceInput(created.value, { observedAt: "2026-10-02T12:00:29.000Z" }),
    created.value,
    "BTCUSDT",
    at,
  );
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.error.code, "INCOMPATIBLE_EVIDENCE");

  for (const observedAt of [
    "2026-10-02T12:00:30.000Z",
    "2026-10-02T12:00:31.000Z",
  ])
    assert.equal(
      validate(
        evidenceInput(created.value, { observedAt }),
        created.value,
        "BTCUSDT",
        at,
      ).ok,
      true,
    );
});

test("missing, duplicate, and non-flat supplemental position rows reject", () => {
  const account = validAccount();
  for (const rows of [
    [],
    [
      { positionIdx: 0, side: "None", size: "0", leverage: "1" },
      { positionIdx: 0, side: "Sell", size: "1", leverage: "2" },
    ],
    [{ positionIdx: 0, side: "Buy", size: "1", leverage: "1" }],
    [{ positionIdx: 1, side: "None", size: "0", leverage: "1" }],
  ]) {
    const parsed = createPortfolioRiskEvidence(
      evidenceInput(account, { rows }),
    );
    if (parsed.ok) assert.equal(validate(parsed.value, account).ok, false);
    else assert.equal(parsed.ok, false);
  }
});

test("supplemental observation cannot replace known or changed pass-B target state", () => {
  const knownPosition = position();
  const knownPass = fixture();
  const knownPayload = withCounts({
    ...knownPass,
    criticalPasses: {
      A: { ...knownPass.criticalPasses.A!, positions: [knownPosition] },
      B: { ...knownPass.criticalPasses.B!, positions: [knownPosition] },
    },
    budget: { ...knownPass.budget, retainedRows: 20 },
  });
  const knownAccount = createAccountEvidenceBundle(knownPayload);
  assert.equal(knownAccount.ok, true);
  if (!knownAccount.ok) return;
  assert.equal(
    validate(
      evidenceInput(knownAccount.value, {
        rows: [
          {
            positionIdx: 0,
            side: "None",
            size: "0",
            leverage: "2",
            isReduceOnly: false,
          },
        ],
      }),
      knownAccount.value,
    ).ok,
    false,
  );

  const changedPosition = {
    ...position(),
    side: "Buy",
    size: { state: "known" as const, value: "1", unit: "contracts" as const },
    positionValue: {
      state: "known" as const,
      value: "100",
      unit: "USD" as const,
    },
  };
  const changedPass = fixture();
  const changedPayload = withCounts({
    ...changedPass,
    criticalPasses: {
      A: { ...changedPass.criticalPasses.A!, positions: [changedPosition] },
      B: { ...changedPass.criticalPasses.B!, positions: [changedPosition] },
    },
    budget: { ...changedPass.budget, retainedRows: 20 },
  });
  const changedAccount = createAccountEvidenceBundle(changedPayload);
  assert.equal(changedAccount.ok, true);
  if (!changedAccount.ok) return;
  assert.equal(
    validate(evidenceInput(changedAccount.value), changedAccount.value).ok,
    false,
  );
});

test("supplemental leverage cannot repair an incomplete non-one-way account", () => {
  const source = fixture();
  const hedge = {
    ...source,
    collectionStatus: "incomplete",
    criticalPasses: {
      A: {
        ...source.criticalPasses.A!,
        modeProbes: [{ symbol: "BTCUSDT", positionIndices: [1] }],
      },
      B: {
        ...source.criticalPasses.B!,
        modeProbes: [{ symbol: "BTCUSDT", positionIndices: [1] }],
      },
    },
  };
  const account = createAccountEvidenceBundle(hedge);
  assert.equal(account.ok, true);
  if (!account.ok) return;
  assert.equal(validate(evidenceInput(account.value), account.value).ok, false);
});

test("evidence sets sort deterministically and reject duplicate account-symbol identity", () => {
  const account = validAccount();
  const btc = evidenceInput(account);
  const eth = evidenceInput(account, { symbol: "ETHUSDT" });
  const sorted = createPortfolioRiskEvidenceSet([eth, btc]);
  assert.equal(sorted.ok, true);
  if (sorted.ok)
    assert.deepEqual(
      sorted.value.map((item) => item.symbol),
      ["BTCUSDT", "ETHUSDT"],
    );
  assert.equal(createPortfolioRiskEvidenceSet([btc, btc]).ok, false);
});

test("every supplemental fact change changes its canonical identity", () => {
  const first = createPortfolioRiskEvidence(evidenceInput(validAccount()));
  const second = createPortfolioRiskEvidence(
    evidenceInput(validAccount(), {
      rows: [
        {
          positionIdx: 0,
          side: "None",
          size: "0",
          leverage: "2",
          isReduceOnly: false,
        },
      ],
    }),
  );
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;

  const firstHash = portfolioRiskEvidenceContentHash(first.value);
  const secondHash = portfolioRiskEvidenceContentHash(second.value);
  assert.equal(firstHash.ok, true);
  assert.equal(secondHash.ok, true);
  if (firstHash.ok && secondHash.ok)
    assert.notEqual(firstHash.value, secondHash.value);
});
