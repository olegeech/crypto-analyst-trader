const producedLifecycleStates = new WeakSet<object>();

export function markLifecycleState<T extends object>(state: T): T {
  producedLifecycleStates.add(state);
  return state;
}

export function isProducedLifecycleState(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    producedLifecycleStates.has(value)
  );
}
