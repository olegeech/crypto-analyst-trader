import assert from "node:assert/strict";
import test from "node:test";
import { admitQualitySource } from "../src/domain/quality/quality-inputs.js";
import {
  marketFixture,
  marketFixtureHashes,
  analyticsFixture,
  fixtureDecimal,
} from "./fixtures/data-quality-fixtures.js";
import { assessDataQuality } from "../src/domain/quality/assess-data-quality.js";
import {
  createQualityProfile,
  hashQualityProfile,
} from "../src/domain/quality/quality-profile.js";

const policy = () => ({
  schemaVersion: "quality-profile/v1",
  profileVersion: "m1-v1",
  roles: [{ id: "market", required: true, maxAgeMs: 60_000 }],
  metadataSkewMs: 1_000,
  trust: [],
  penalties: [
    {
      reasonCode: "INCOMPLETE_EVIDENCE",
      confidenceImpactGroup: "market",
      penalty: "15",
    },
  ],
});

test("malformed source admission retains sanitized failure, not raw payload", () => {
  const record = admitQualitySource({
    role: "market",
    value: { secret: "must-not-be-recorded" },
  });
  assert.deepEqual(record.failures, ["INVALID_EVIDENCE"]);
  assert.equal(record.value, undefined);
  assert.ok(!JSON.stringify(record).includes("must-not-be-recorded"));
});

test("existing projection/full hashes remain distinct and corruption is retained", () => {
  const market = marketFixture();
  const hashes = marketFixtureHashes(market);
  assert.notEqual(hashes.contentHash, hashes.bundleHash);
  assert.deepEqual(
    admitQualitySource({ role: "market", value: market }).failures,
    [],
  );
  const wrong = {
    ...market,
    evidence: [{ ...market.evidence[0], contentHash: hashes.bundleHash }],
  };
  assert.ok(
    admitQualitySource({ role: "market", value: wrong }).failures.includes(
      "HASH_MISMATCH",
    ),
  );
});

test("optional degradation is informative; wholly missing required evidence blocks", () => {
  const profile = createQualityProfile({
    ...policy(),
    roles: [{ id: "market", required: false, maxAgeMs: 60_000 }],
  });
  assert.ok(profile.ok);
  const market = marketFixture();
  const result = assessDataQuality({
    profile: profile.value,
    sources: [{ role: "market", value: market }],
    bundleCutoff: market.bundleCutoff,
    evaluationTime: market.bundleCutoff,
  });
  assert.ok(result.ok);
  assert.equal(result.value.qualityGate, "OK");
  assert.equal(result.value.evidenceConfidence?.toString(), "85");
  const required = createQualityProfile(policy());
  assert.ok(required.ok);
  const missing = assessDataQuality({
    profile: required.value,
    sources: [],
    bundleCutoff: market.bundleCutoff,
    evaluationTime: market.bundleCutoff,
  });
  assert.ok(missing.ok);
  assert.equal(missing.value.qualityGate, "BLOCK");
});

test("analytics uses output policy, not aggregate sufficiency as an unconditional gate", () => {
  const market = marketFixture();
  const analytics = analyticsFixture(market);
  const profile = createQualityProfile({
    ...policy(),
    roles: [
      { id: "analytics:btc-hourly-return", required: true, maxAgeMs: 60_000 },
    ],
  });
  assert.ok(profile.ok);
  const result = assessDataQuality({
    profile: profile.value,
    sources: [{ role: "analytics", value: analytics }],
    bundleCutoff: market.bundleCutoff,
    evaluationTime: market.bundleCutoff,
  });
  assert.ok(result.ok);
  assert.equal(result.value.qualityGate, "OK");
});

for (const kind of ["price", "derivative"] as const) {
  for (const required of [true, false]) {
    for (const aggregate of [false, true]) {
      for (const elapsedMs of [59_999, 60_000, 60_001]) {
        test(`${kind} output freshness: required=${required}, aggregate=${aggregate}, age=${elapsedMs}`, () => {
          const base = marketFixture();
          const market = marketFixture({
            symbols: base.symbols.map((symbol) => ({
              ...symbol,
              openInterest:
                symbol.symbol === "BTCUSDT"
                  ? [
                      {
                        interval: "1h",
                        observations: symbol.ohlcv[0]!.observations.map(
                          (row, index) => ({
                            timestamp: row.timestamp,
                            openInterest: fixtureDecimal(String(100 + index)),
                          }),
                        ),
                      },
                    ]
                  : [],
            })),
          });
          const requestId =
            kind === "price" ? "btc-hourly-return" : "btc-hourly-oi";
          const analytics =
            kind === "price"
              ? analyticsFixture(market)
              : analyticsFixture(market, {
                  profile: {
                    schemaVersion: "analytics-profile/v1",
                    features: [
                      {
                        id: requestId,
                        kind: "open-interest-absolute-change",
                        symbol: "BTCUSDT",
                        interval: "1h",
                        observationCount: 2,
                        required: true,
                      },
                    ],
                    externalEvidence: [],
                  },
                });
          const role = `analytics:${requestId}`;
          const profile = createQualityProfile({
            ...policy(),
            roles: [
              { id: role, required, maxAgeMs: 60_000 },
              ...(aggregate
                ? [{ id: "analytics", required: true, maxAgeMs: 120_000 }]
                : []),
            ],
            penalties: [
              {
                reasonCode: "STALE_EVIDENCE",
                confidenceImpactGroup: "freshness",
                penalty: "15",
              },
            ],
          });
          assert.ok(profile.ok);
          const result = assessDataQuality({
            profile: profile.value,
            sources: [{ role: "analytics", value: analytics }],
            bundleCutoff: market.bundleCutoff,
            evaluationTime: new Date(
              Date.parse(market.bundleCutoff) + elapsedMs,
            ).toISOString(),
          });
          assert.ok(result.ok);
          const stale = elapsedMs >= 60_000;
          assert.deepEqual(
            result.value.findings,
            stale
              ? [
                  {
                    role,
                    reasonCode: "STALE_EVIDENCE",
                    blocking: required,
                    ...(!required
                      ? { confidenceImpactGroup: "freshness" }
                      : {}),
                  },
                ]
              : [],
          );
          assert.equal(
            result.value.qualityGate,
            stale && required ? "BLOCK" : "OK",
          );
          assert.equal(
            result.value.evidenceConfidence?.toString(),
            stale && !required ? "85" : "100",
          );
          assert.equal(
            result.value.dispositions.find((d) => d.role === role)?.disposition,
            stale && required ? "rejected" : "accepted",
          );
        });
      }
    }
  }
}

test("optional degradation requires an explicit penalty without inventing one", () => {
  const market = marketFixture();
  for (const configured of [false, true]) {
    const profile = createQualityProfile({
      ...policy(),
      roles: [{ id: "market", required: false, maxAgeMs: 60_000 }],
      penalties: configured ? policy().penalties : [],
    });
    assert.ok(profile.ok);
    const result = assessDataQuality({
      profile: profile.value,
      sources: [{ role: "market", value: market }],
      bundleCutoff: market.bundleCutoff,
      evaluationTime: market.bundleCutoff,
    });
    assert.ok(result.ok);
    assert.equal(result.value.qualityGate, configured ? "OK" : "BLOCK");
    assert.equal(
      result.value.evidenceConfidence?.toString(),
      configured ? "85" : "100",
    );
    assert.deepEqual(
      result.value.appliedPenalties.map((p) => ({
        ...p,
        penalty: p.penalty.toString(),
      })),
      configured ? [{ confidenceImpactGroup: "market", penalty: "15" }] : [],
    );
    assert.deepEqual(result.value.findings, [
      {
        role: "market",
        reasonCode: "INCOMPLETE_EVIDENCE",
        blocking: false,
        ...(configured ? { confidenceImpactGroup: "market" } : {}),
      },
      ...(!configured
        ? [
            {
              role: "market",
              reasonCode: "INVALID_QUALITY_POLICY",
              blocking: true,
            },
          ]
        : []),
    ]);
  }
});

test("confidence reaches zero without becoming a gate; correlated findings use max penalty", () => {
  const market = marketFixture();
  const profile = createQualityProfile({
    ...policy(),
    roles: [
      { id: "market", required: false, maxAgeMs: 60_000 },
      { id: "optional", required: false, maxAgeMs: 60_000 },
    ],
    penalties: [
      {
        reasonCode: "INCOMPLETE_EVIDENCE",
        confidenceImpactGroup: "shared",
        penalty: "15",
      },
      {
        reasonCode: "MISSING_EVIDENCE",
        confidenceImpactGroup: "shared",
        penalty: "8",
      },
    ],
  });
  assert.ok(profile.ok);
  const input = {
    profile: profile.value,
    sources: [{ role: "market" as const, value: market }],
    bundleCutoff: market.bundleCutoff,
    evaluationTime: market.bundleCutoff,
  };
  const result = assessDataQuality(input);
  assert.ok(result.ok);
  assert.equal(result.value.qualityGate, "OK");
  assert.equal(result.value.evidenceConfidence?.toString(), "85");
  const zeroProfile = createQualityProfile({
    ...policy(),
    roles: [{ id: "market", required: false, maxAgeMs: 60_000 }],
    penalties: [
      {
        reasonCode: "INCOMPLETE_EVIDENCE",
        confidenceImpactGroup: "market",
        penalty: "100",
      },
    ],
  });
  assert.ok(zeroProfile.ok);
  const zero = assessDataQuality({ ...input, profile: zeroProfile.value });
  assert.ok(zero.ok);
  assert.equal(zero.value.qualityGate, "OK");
  assert.equal(zero.value.evidenceConfidence?.toString(), "0");
});

test("a malformed or duplicate source blocks independently of confidence", () => {
  const market = marketFixture();
  const profile = createQualityProfile({
    ...policy(),
    roles: [{ id: "market", required: false, maxAgeMs: 60_000 }],
  });
  assert.ok(profile.ok);
  const result = assessDataQuality({
    profile: profile.value,
    sources: [
      { role: "market", value: market },
      { role: "market", value: market },
    ],
    bundleCutoff: market.bundleCutoff,
    evaluationTime: market.bundleCutoff,
  });
  assert.ok(result.ok);
  assert.equal(result.value.qualityGate, "BLOCK");
  assert.ok(
    result.value.findings.some(
      (f) => f.reasonCode === "DUPLICATE_OBSERVATION" && f.blocking,
    ),
  );
});

test("quality profile validates explicit policy and canonical identity", () => {
  const result = createQualityProfile(policy());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(Object.isFrozen(result.value));
  assert.equal(result.value.penalties[0]?.penalty.toString(), "15");
  const changed = createQualityProfile({ ...policy(), metadataSkewMs: 2_000 });
  assert.ok(changed.ok);
  assert.notDeepEqual(
    hashQualityProfile(result.value),
    hashQualityProfile(changed.value),
  );
});

test("quality profile rejects unsupported, incomplete and ambiguous policy", () => {
  for (const input of [
    { ...policy(), schemaVersion: "quality-profile/v2" },
    { ...policy(), roles: [] },
    { ...policy(), roles: [{ id: "market", maxAgeMs: 60_000 }] },
    { ...policy(), roles: [policy().roles[0], policy().roles[0]] },
    {
      ...policy(),
      penalties: [
        { reasonCode: "UNKNOWN", confidenceImpactGroup: "x", penalty: "15" },
      ],
    },
    {
      ...policy(),
      penalties: [
        {
          reasonCode: "HASH_MISMATCH",
          confidenceImpactGroup: "x",
          penalty: "15",
        },
      ],
    },
    {
      ...policy(),
      penalties: [
        {
          reasonCode: "INCOMPLETE_EVIDENCE",
          confidenceImpactGroup: "x",
          penalty: "101",
        },
      ],
    },
    { ...policy(), confidenceThreshold: 60 },
  ])
    assert.equal(createQualityProfile(input).ok, false);
});
