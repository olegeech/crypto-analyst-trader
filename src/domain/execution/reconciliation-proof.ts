const producedReconciliationResults = new WeakSet<object>();

export function markReconciliationResult<T extends object>(result: T): T {
  producedReconciliationResults.add(result);
  return result;
}

export function isProducedReconciliationResult(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    producedReconciliationResults.has(value)
  );
}
