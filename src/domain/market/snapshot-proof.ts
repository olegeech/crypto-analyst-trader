const producedMarketSnapshots = new WeakSet<object>();
const producedAccountSnapshots = new WeakSet<object>();

export function markMarketSnapshot<T extends object>(snapshot: T): T {
  producedMarketSnapshots.add(snapshot);
  return snapshot;
}

export function markAccountSnapshot<T extends object>(snapshot: T): T {
  producedAccountSnapshots.add(snapshot);
  return snapshot;
}

export function isProducedMarketSnapshot(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    producedMarketSnapshots.has(value)
  );
}

export function isProducedAccountSnapshot(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    producedAccountSnapshots.has(value)
  );
}
