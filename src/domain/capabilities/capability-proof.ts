const producedCapabilityObservations = new WeakSet<object>();
const adapterProducedCapabilityObservations = new WeakSet<object>();

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

/**
 * Marks a domain-produced observation as having crossed an adapter-owned
 * evidence boundary. The marker is intentionally process-local and is never
 * serialized or rehydrated from persistence.
 */
export function markAdapterCapabilityObservation<T extends object>(
  observation: T,
): T {
  if (producedCapabilityObservations.has(observation)) {
    adapterProducedCapabilityObservations.add(observation);
  }
  return observation;
}

export function isAdapterProducedCapabilityObservation(
  value: unknown,
): boolean {
  return (
    isProducedCapabilityObservation(value) &&
    typeof value === "object" &&
    value !== null &&
    adapterProducedCapabilityObservations.has(value)
  );
}

export const markAdapterOwnedCapabilityObservation =
  markAdapterCapabilityObservation;
export const isAdapterOwnedCapabilityObservation =
  isAdapterProducedCapabilityObservation;
