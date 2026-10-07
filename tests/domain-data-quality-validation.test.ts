import assert from "node:assert/strict";
import test from "node:test";
import { liquidationHistoryWindow } from "../src/domain/liquidation/liquidation-evidence-windows.js";
import { classifyQualityEvidence } from "../src/domain/quality/quality-validation.js";
import { admitQualitySource } from "../src/domain/quality/quality-inputs.js";
import { assessDataQuality } from "../src/domain/quality/assess-data-quality.js";
import {
  createQualityProfile,
  hashQualityProfile,
} from "../src/domain/quality/quality-profile.js";
import { parseUtcTimestamp } from "../src/domain/shared/time.js";
import {
  marketFixture,
  liquidationFixture,
  liquidationFixtureRef,
  analyticsFixture,
  externalEvidenceFixture,
  fixtureCanonicalHash,
  DATA_QUALITY_FIXTURE_CUTOFF,
} from "./fixtures/data-quality-fixtures.js";

function time(value = DATA_QUALITY_FIXTURE_CUTOFF) {
  const result = parseUtcTimestamp(value);
  assert.ok(result.ok);
  return result.value;
}
function profile(required = false, maxAgeMs = 86_400_000) {
  const result = createQualityProfile({
    schemaVersion: "quality-profile/v1",
    profileVersion: "u3-test-v1",
    roles: [
      "market",
      "liquidation",
      "analytics",
      "analytics:btc-hourly-return",
      "external:market-regime-score",
    ].map((id) => ({ id, required, maxAgeMs })),
    metadataSkewMs: 1000,
    trust: [],
    penalties: [],
  });
  assert.ok(result.ok);
  return result.value;
}

function scopedProfile(
  scope = true,
  version = scope ? "provisional-m1-quality/v2" : "provisional-m1-quality/v1",
) {
  const result = createQualityProfile({
    schemaVersion: "quality-profile/v1",
    profileVersion: version,
    ...(scope
      ? { liquidationHistoryScope: "requested-feature-windows/v1" }
      : {}),
    roles: [
      { id: "market", required: false, maxAgeMs: 86_400_000 },
      { id: "liquidation", required: true, maxAgeMs: 86_400_000 },
      {
        id: "analytics:btc-liquidation-12h",
        required: true,
        maxAgeMs: 86_400_000,
      },
    ],
    metadataSkewMs: 1000,
    trust: [],
    penalties: [
      {
        reasonCode: "INCOMPLETE_EVIDENCE",
        confidenceImpactGroup: "market-incomplete",
        penalty: "0",
      },
    ],
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("quality profile fixture is invalid");
  return result.value;
}

function scopedEvidence(
  options: {
    readonly missingIndex?: number;
    readonly missingIndexes?: readonly number[];
    readonly diagnosticIndex?: number;
    readonly coverageProof?: "complete" | "incomplete";
    readonly emptyAsset?: "ETH" | "SOL" | "DOGE";
    readonly diagnostic?: "missing-bucket" | "history-incomplete";
  } = {},
) {
  const market = marketFixture();
  const base = liquidationFixture(market);
  const expected = liquidationHistoryWindow(
    Date.parse(market.bundleCutoff),
  ).epochs;
  const missingIndexes = new Set(
    options.missingIndexes ??
      (options.missingIndex === undefined ? [] : [options.missingIndex]),
  );
  const targets = base.targets.map((target) => ({
    asset: target.asset,
    constituents:
      target.asset === options.emptyAsset
        ? []
        : [
            {
              providerSymbol: `${target.asset}USDT_PERP.A`,
              exchange: "Bybit",
              symbolOnExchange: `${target.asset}USDT`,
              baseAsset: target.asset,
              quoteAsset: "USDT",
              isPerpetual: true as const,
              marginType: "linear",
              expireAt: 0,
              notionalDenominatedIn: "USD",
              observations: expected
                .filter(
                  (_, index) =>
                    target.asset !== "BTC" || !missingIndexes.has(index),
                )
                .map((epoch) => ({
                  timestamp: new Date(epoch).toISOString(),
                  longUsd: "1",
                  shortUsd: "2",
                })),
            },
          ],
  }));
  const diagnostic = options.diagnostic ?? "missing-bucket";
  const liquidation = liquidationFixture(market, {
    coverageProof: options.coverageProof ?? "complete",
    historyProof: "incomplete",
    status: "incomplete",
    targets,
    diagnostics:
      diagnostic === "missing-bucket" && missingIndexes.size > 0
        ? [
            {
              code: diagnostic,
              operation: "fetch-liquidation-history",
              asset: "BTC",
              providerSymbol: "BTCUSDT_PERP.A",
              bucketTimestamp: new Date(
                expected[options.diagnosticIndex ?? [...missingIndexes][0]!]!,
              ).toISOString(),
            },
          ]
        : [{ code: diagnostic, operation: "fetch-liquidation-history" }],
  });
  const analytics = analyticsFixture(market, {
    liquidation,
    featuresVersion: "analytics-features/v2",
    profile: {
      schemaVersion: "analytics-profile/v1",
      features: [
        {
          id: "btc-liquidation-12h",
          kind: "liquidation-window",
          asset: "BTC",
          windowHours: 12,
          required: true,
        },
      ],
      externalEvidence: [],
    },
  });
  const sources = [
    { role: "market" as const, value: market },
    {
      role: "liquidation" as const,
      value: liquidation,
      evidenceRef: liquidationFixtureRef(liquidation),
    },
    { role: "analytics" as const, value: analytics },
  ];
  return { market, liquidation, analytics, sources };
}

test("quality scope is explicit, hash-bound, and requires linked roles", () => {
  const scoped = scopedProfile();
  assert.equal(scoped.profileVersion, "provisional-m1-quality/v2");
  assert.equal(scoped.liquidationHistoryScope, "requested-feature-windows/v1");
  const legacy = scopedProfile(false);
  const sameVersionWithoutScope = scopedProfile(
    false,
    "provisional-m1-quality/v2",
  );
  assert.equal(Object.hasOwn(legacy, "liquidationHistoryScope"), false);
  const scopedHash = hashQualityProfile(scoped);
  const legacyHash = hashQualityProfile(legacy);
  const sameVersionHash = hashQualityProfile(sameVersionWithoutScope);
  assert.equal(scopedHash.ok, true);
  assert.equal(legacyHash.ok, true);
  assert.equal(sameVersionHash.ok, true);
  if (scopedHash.ok && sameVersionHash.ok)
    assert.notEqual(scopedHash.value, sameVersionHash.value);
  if (scopedHash.ok && legacyHash.ok)
    assert.notEqual(scopedHash.value, legacyHash.value);
  assert.equal(
    createQualityProfile({
      schemaVersion: "quality-profile/v1",
      profileVersion: "bad-scope",
      liquidationHistoryScope: "requested-feature-windows/v1",
      roles: [
        { id: "liquidation", required: false, maxAgeMs: 60_000 },
        {
          id: "analytics:btc-liquidation-12h",
          required: true,
          maxAgeMs: 60_000,
        },
      ],
      metadataSkewMs: 1000,
      trust: [],
      penalties: [],
    }).ok,
    false,
  );
});

test("scoped quality accepts multiple proven history gaps outside required window", () => {
  const evidence = scopedEvidence({ missingIndexes: [0, 1] });
  assert.equal(evidence.analytics.derivativeFeatures[0]?.status, "complete");
  const result = assessDataQuality({
    profile: scopedProfile(),
    sources: evidence.sources,
    bundleCutoff: evidence.market.bundleCutoff,
    evaluationTime: evidence.market.bundleCutoff,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.qualityGate, "OK");
  assert.equal(
    result.value.findings.some(
      (finding) =>
        finding.role === "liquidation" &&
        ["INCOMPLETE_LIQUIDATION_HISTORY", "GAPPED_WINDOW"].includes(
          finding.reasonCode,
        ),
    ),
    false,
  );
});

test("scoped quality blocks required-window gaps and structurally invalid responses", () => {
  const invalidResponse = scopedEvidence({ diagnostic: "history-incomplete" });
  const invalidWindow = invalidResponse.liquidation.targets
    .find((target) => target.asset === "BTC")
    ?.windows.find((item) => item.hours === 12);
  assert.equal(invalidWindow?.complete, true);
  assert.equal(
    invalidResponse.analytics.derivativeFeatures[0]?.status,
    "partial",
  );

  for (const evidence of [
    scopedEvidence({ missingIndex: 22 }),
    invalidResponse,
  ]) {
    const result = assessDataQuality({
      profile: scopedProfile(),
      sources: evidence.sources,
      bundleCutoff: evidence.market.bundleCutoff,
      evaluationTime: evidence.market.bundleCutoff,
    });
    assert.equal(result.ok, true);
    if (!result.ok) continue;
    assert.equal(result.value.qualityGate, "BLOCK");
    assert.ok(
      result.value.findings.some(
        (finding) =>
          finding.role === "liquidation" &&
          finding.reasonCode === "INCOMPLETE_LIQUIDATION_HISTORY" &&
          finding.blocking,
      ),
    );
  }
});

test("scoped quality keeps incomplete coverage, empty assets and invalid diagnostics blocking", () => {
  for (const evidence of [
    scopedEvidence({ missingIndex: 0, coverageProof: "incomplete" }),
    scopedEvidence({ missingIndex: 0, emptyAsset: "ETH" }),
    scopedEvidence({ missingIndexes: [0, 1], diagnosticIndex: 5 }),
  ]) {
    const result = assessDataQuality({
      profile: scopedProfile(),
      sources: evidence.sources,
      bundleCutoff: evidence.market.bundleCutoff,
      evaluationTime: evidence.market.bundleCutoff,
    });
    assert.equal(result.ok, true);
    if (!result.ok) continue;
    assert.equal(result.value.qualityGate, "BLOCK");
    assert.ok(result.value.findings.some((finding) => finding.blocking));
  }
});

test("legacy quality profile keeps strict global liquidation history semantics", () => {
  const evidence = scopedEvidence({ missingIndex: 0 });
  const legacyAnalytics = analyticsFixture(evidence.market, {
    liquidation: evidence.liquidation,
    profile: {
      schemaVersion: "analytics-profile/v1",
      features: [
        {
          id: "btc-liquidation-12h",
          kind: "liquidation-window",
          asset: "BTC",
          windowHours: 12,
          required: true,
        },
      ],
      externalEvidence: [],
    },
  });
  const records = [
    admitQualitySource({ role: "market", value: evidence.market }),
    admitQualitySource({
      role: "liquidation",
      value: evidence.liquidation,
      evidenceRef: liquidationFixtureRef(evidence.liquidation),
    }),
    admitQualitySource({ role: "analytics", value: legacyAnalytics }),
  ];
  const findings = classifyQualityEvidence(
    records,
    scopedProfile(false),
    time(),
    time(),
  );
  assert.equal(
    findings.some(
      (finding) =>
        finding.role === "liquidation" &&
        finding.reasonCode === "INCOMPLETE_LIQUIDATION_HISTORY" &&
        finding.blocking,
    ),
    true,
  );
  const scopedV1Findings = classifyQualityEvidence(
    records,
    scopedProfile(),
    time(),
    time(),
  );
  assert.ok(
    scopedV1Findings.some(
      (finding) =>
        finding.role === "liquidation" &&
        finding.reasonCode === "INCOMPLETE_LIQUIDATION_HISTORY" &&
        finding.blocking,
    ),
  );
});
test("optional market incompleteness is preserved without assigning confidence groups", () => {
  const record = admitQualitySource({ role: "market", value: marketFixture() });
  assert.deepEqual(
    classifyQualityEvidence([record], profile(), time(), time()),
    [{ role: "market", reasonCode: "INCOMPLETE_EVIDENCE", blocking: false }],
  );
});
test("admission integrity failures block optional evidence; absence belongs to host", () => {
  assert.deepEqual(classifyQualityEvidence([], profile(), time(), time()), []);
  assert.deepEqual(
    classifyQualityEvidence(
      [{ role: "market", failures: ["HASH_MISMATCH"] }],
      profile(),
      time(),
      time(),
    ),
    [{ role: "market", reasonCode: "HASH_MISMATCH", blocking: true }],
  );
});
test("expiry and profile age boundaries are inclusive", () => {
  const record = admitQualitySource({ role: "market", value: marketFixture() });
  for (const required of [false, true]) {
    assert.ok(
      classifyQualityEvidence(
        [record],
        profile(required, 1000),
        time(),
        time("2026-09-24T14:00:01.000Z"),
      ).some(
        (f) => f.reasonCode === "STALE_EVIDENCE" && f.blocking === required,
      ),
    );
  }
});
test("supplied liquidation lineage conflicts block even optional roles", () => {
  const market = marketFixture();
  const liquidation = liquidationFixture(marketFixture({ runId: "other-run" }));
  const records = [
    admitQualitySource({ role: "market", value: market }),
    admitQualitySource({
      role: "liquidation",
      value: liquidation,
      evidenceRef: liquidationFixtureRef(liquidation),
    }),
  ];
  assert.ok(
    classifyQualityEvidence(records, profile(), time(), time()).some(
      (f) => f.reasonCode === "LINEAGE_MISMATCH" && f.blocking,
    ),
  );
});
test("liquidation proofs remain separate and classification does not mutate rows", () => {
  const value = liquidationFixture();
  const before = JSON.stringify(value);
  const record = admitQualitySource({
    role: "liquidation",
    value,
    evidenceRef: liquidationFixtureRef(value),
  });
  const findings = classifyQualityEvidence([record], profile(), time(), time());
  for (const reason of [
    "INCOMPLETE_LIQUIDATION_COVERAGE",
    "INCOMPLETE_LIQUIDATION_HISTORY",
  ])
    assert.ok(findings.some((f) => f.reasonCode === reason && !f.blocking));
  assert.equal(JSON.stringify(value), before);
});
test("analytics uses existing market full-bundle and content links", () => {
  const original = marketFixture();
  const analytics = analyticsFixture(original);
  const changed = marketFixture({ runId: "changed-run" });
  const records = [
    admitQualitySource({ role: "market", value: changed }),
    admitQualitySource({ role: "analytics", value: analytics }),
  ];
  assert.ok(
    classifyQualityEvidence(records, profile(), time(), time()).some(
      (f) => f.role === "analytics" && f.reasonCode === "LINEAGE_MISMATCH",
    ),
  );
  assert.deepEqual(
    classifyQualityEvidence(records, profile(), time(), time()),
    classifyQualityEvidence([...records].reverse(), profile(), time(), time()),
  );
});

test("EvidenceRef expiry applies independently of profile age", () => {
  const value = liquidationFixture();
  const record = admitQualitySource({
    role: "liquidation",
    value,
    evidenceRef: liquidationFixtureRef(value, 1000),
  });
  assert.ok(
    !classifyQualityEvidence(
      [record],
      profile(),
      time(),
      time("2026-09-24T14:00:00.999Z"),
    ).some((f) => f.reasonCode === "STALE_EVIDENCE"),
  );
  assert.ok(
    classifyQualityEvidence(
      [record],
      profile(),
      time(),
      time("2026-09-24T14:00:01.000Z"),
    ).some((f) => f.reasonCode === "STALE_EVIDENCE"),
  );
});
test("future cutoff is invariant and metadata skew has an inclusive bound", () => {
  assert.deepEqual(
    classifyQualityEvidence(
      [],
      profile(),
      time(),
      time("2026-09-24T13:59:59.000Z"),
    ),
    [{ role: "assessment", reasonCode: "FUTURE_INFORMATION", blocking: true }],
  );
  const record = admitQualitySource({ role: "market", value: marketFixture() });
  assert.ok(
    classifyQualityEvidence(
      [record],
      profile(),
      time(),
      time("2026-09-24T13:59:59.000Z"),
    ).some((f) => f.reasonCode === "FUTURE_INFORMATION" && f.blocking),
  );
  for (const [offset, expected] of [
    [1000, false],
    [1001, true],
  ] as const) {
    const value = marketFixture({
      collectionEndedAt: time(
        new Date(Date.parse(time()) + offset).toISOString(),
      ),
    });
    const records = [admitQualitySource({ role: "market", value })];
    assert.equal(
      classifyQualityEvidence(records, profile(), time(), time()).some(
        (f) => f.reasonCode === "METADATA_CLOCK_SKEW",
      ),
      expected,
    );
  }
});
test("output-only policy accepts complete native analytics without supplied market", () => {
  const value = analyticsFixture();
  const onlyOutputs = {
    ...profile(),
    roles: [
      {
        id: "analytics:btc-hourly-return",
        required: false,
        maxAgeMs: 86_400_000,
      },
    ],
  };
  assert.deepEqual(
    classifyQualityEvidence(
      [admitQualitySource({ role: "analytics", value })],
      onlyOutputs,
      time(),
      time(),
    ),
    [],
  );
});
test("optional incompatible liquidation lineage does not manufacture aggregate invalidity", () => {
  const market = marketFixture();
  const liquidation = liquidationFixture(marketFixture({ runId: "other-run" }));
  const value = analyticsFixture(market, { liquidation });
  assert.equal(value.sufficiency.status, "complete");
  const findings = classifyQualityEvidence(
    [admitQualitySource({ role: "analytics", value })],
    profile(),
    time(),
    time(),
  );
  assert.ok(
    findings.some((f) => f.reasonCode === "LINEAGE_MISMATCH" && f.blocking),
  );
  assert.ok(!findings.some((f) => f.reasonCode === "INVALID_EVIDENCE"));
});
test("insufficient analytics maps unavailable outputs through quality requiredness", () => {
  const market = marketFixture();
  const value = analyticsFixture(market, {
    profile: {
      schemaVersion: "analytics-profile/v1",
      features: [
        {
          id: "btc-hourly-return",
          kind: "close-return",
          symbol: "BTCUSDT",
          interval: "1h",
          periods: 10,
          required: true,
        },
      ],
      externalEvidence: [],
    },
  });
  assert.equal(value.sufficiency.status, "insufficient");
  const record = admitQualitySource({ role: "analytics", value });
  for (const required of [false, true]) {
    const findings = classifyQualityEvidence(
      [record],
      profile(required),
      time(),
      time(),
    );
    assert.ok(
      findings.some(
        (f) =>
          f.role === "analytics:btc-hourly-return" &&
          f.reasonCode === "UNAVAILABLE_ANALYTICS" &&
          f.blocking === required,
      ),
    );
    assert.equal(
      findings.some(
        (f) =>
          f.role === "analytics" && f.reasonCode === "UNAVAILABLE_ANALYTICS",
      ),
      false,
    );
  }
});
test("macro-only external evidence permits absent or post-cutoff generation metadata", () => {
  const market = marketFixture();
  for (const generatedAt of [undefined, "2026-09-24T14:00:01.000Z"]) {
    const external = externalEvidenceFixture(
      "market-regime-score",
      market,
      generatedAt === undefined ? {} : { generatedAt },
    );
    const value = analyticsFixture(market, {
      profile: {
        schemaVersion: "analytics-profile/v1",
        features: [],
        externalEvidence: [{ family: "market-regime-score", required: true }],
      },
      externalEvidence: { "market-regime-score": external },
    });
    const records = [admitQualitySource({ role: "analytics", value })];
    assert.deepEqual(
      classifyQualityEvidence(
        records,
        profile(),
        time(),
        time("2026-09-24T14:00:02.000Z"),
      ),
      [],
    );
  }
});
test("external information gets no skew allowance and invalid generation blocks", () => {
  const market = marketFixture();
  const external = externalEvidenceFixture("market-regime-score", market);
  const base = analyticsFixture(market, {
    profile: {
      schemaVersion: "analytics-profile/v1",
      features: [],
      externalEvidence: [{ family: "market-regime-score", required: true }],
    },
    externalEvidence: { "market-regime-score": external },
  });
  for (const [patch, reason] of [
    [{ asOf: time("2026-09-24T14:00:00.001Z") }, "FUTURE_INFORMATION"],
    [
      { generatedAt: time("2026-09-24T13:59:59.999Z") },
      "INVALID_GENERATION_TIME",
    ],
    [
      { generatedAt: time("2026-09-24T14:00:02.001Z") },
      "INVALID_GENERATION_TIME",
    ],
  ] as const) {
    const value = { ...base, externalEvidence: [{ ...external, ...patch }] };
    assert.ok(
      classifyQualityEvidence(
        [{ role: "analytics", value, failures: [] }],
        profile(),
        time(),
        time("2026-09-24T14:00:02.000Z"),
      ).some(
        (f) =>
          f.role === "external:market-regime-score" &&
          f.reasonCode === reason &&
          f.blocking,
      ),
    );
  }
});
test("gaps and duplicate source diagnostics remain stable", () => {
  const market = marketFixture({
    diagnostics: [
      { code: "duplicate-observation", operation: "fetch", endpoint: "ohlcv" },
      { code: "duplicate-observation", operation: "fetch", endpoint: "ohlcv" },
      { code: "missing-required-data", operation: "fetch", endpoint: "ohlcv" },
    ],
  });
  const findings = classifyQualityEvidence(
    [admitQualitySource({ role: "market", value: market })],
    profile(),
    time(),
    time(),
  );
  assert.equal(
    findings.filter((f) => f.reasonCode === "DUPLICATE_OBSERVATION").length,
    1,
  );
  assert.ok(
    findings.some(
      (f) => f.reasonCode === "DUPLICATE_OBSERVATION" && f.blocking,
    ),
  );
  assert.ok(
    findings.some((f) => f.reasonCode === "GAPPED_WINDOW" && !f.blocking),
  );
});
test("classifier independently detects corrupted supplied hashes and aggregate state", () => {
  const market = marketFixture();
  const record = admitQualitySource({ role: "market", value: market });
  assert.ok(
    classifyQualityEvidence(
      [{ ...record, contentHash: fixtureCanonicalHash("wrong") }],
      profile(),
      time(),
      time(),
    ).some((f) => f.reasonCode === "HASH_MISMATCH" && f.blocking),
  );
  const analytics = analyticsFixture(market);
  const changed = {
    ...analytics,
    sufficiency: { ...analytics.sufficiency, status: "insufficient" as const },
  };
  const { contentHash: ignored, ...payload } = changed;
  assert.ok(ignored);
  const value = { ...payload, contentHash: fixtureCanonicalHash(payload) };
  const findings = classifyQualityEvidence(
    [{ role: "analytics", value, failures: [] }],
    profile(),
    time(),
    time(),
  );
  assert.ok(
    findings.some((f) => f.reasonCode === "INVALID_EVIDENCE" && f.blocking),
  );
});
