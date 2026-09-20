const producedCapabilityObservations = new WeakSet<object>();

export function markCapabilityObservation<T extends object>(observation: T): T {
  producedCapabilityObservations.add(observation);
  return observation;
}

export function isProducedCapabilityObservation(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    producedCapabilityObservations.has(value)
  );
}
