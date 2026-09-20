const producedExecutionAttempts = new WeakSet<object>();

export function markExecutionAttempt<T extends object>(attempt: T): T {
  producedExecutionAttempts.add(attempt);
  return attempt;
}

export function isProducedExecutionAttempt(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    producedExecutionAttempts.has(value)
  );
}
