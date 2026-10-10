export function liquidationObservationKey(
  providerSymbol: string,
  timestamp: string,
): string {
  return JSON.stringify([providerSymbol, timestamp]);
}
