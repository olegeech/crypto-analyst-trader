const producedExchangeOrders = new WeakSet<object>();

export function markExchangeOrder<T extends object>(order: T): T {
  producedExchangeOrders.add(order);
  return order;
}

export function isProducedExchangeOrder(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    producedExchangeOrders.has(value)
  );
}
