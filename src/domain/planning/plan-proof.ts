const producedExecutionPlans = new WeakSet<object>();

export function markExecutionPlan<T extends object>(plan: T): T {
  producedExecutionPlans.add(plan);
  return plan;
}

export function isProducedExecutionPlan(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    producedExecutionPlans.has(value)
  );
}
