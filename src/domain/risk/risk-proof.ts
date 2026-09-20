const producedRiskDecisions = new WeakSet<object>();

export function markRiskDecision<T extends object>(decision: T): T {
  producedRiskDecisions.add(decision);
  return decision;
}

export function isProducedRiskDecision(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    producedRiskDecisions.has(value)
  );
}
