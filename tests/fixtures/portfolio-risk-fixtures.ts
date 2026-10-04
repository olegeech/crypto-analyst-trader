export function portfolioRiskPolicyInput(
  overrides: Record<string, unknown> = {},
) {
  return {
    schemaVersion: "portfolio-risk-policy/v1",
    policyVersion: "m1-v1",
    maxAccountEvidenceAgeMs: 60_000,
    marginReserveRatio: "0.1",
    maxDerivativesLeverage: "1",
    entryFeeRate: "0.0002",
    exitFeeRate: "0.00055",
    slippageBufferRate: "0.0005",
    minimumNetEdgeRate: "0.001",
    ...overrides,
  };
}
