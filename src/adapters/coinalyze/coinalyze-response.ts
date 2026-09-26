export interface CoinalyzeMarket {
  readonly symbol: string;
  readonly exchange: string;
  readonly symbolOnExchange: string;
  readonly baseAsset: string;
  readonly quoteAsset: string;
  readonly isPerpetual: boolean;
  readonly marginType: string;
  readonly expireAt: number;
  readonly notionalDenominatedIn: string;
}

export interface CoinalyzeLiquidationObservation {
  readonly timestamp: string;
  readonly longUsd: string;
  readonly shortUsd: string;
}

export interface CoinalyzeMarketHistory {
  readonly symbol: string;
  readonly observations: readonly CoinalyzeLiquidationObservation[];
}

export function isCoinalyzeRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function quoteNumberTokens(json: string): string {
  let transformed = "";
  let index = 0;
  while (index < json.length) {
    const current = json[index];
    if (current === '"') {
      const start = index;
      index += 1;
      while (index < json.length) {
        if (json[index] === "\\") {
          index += 2;
          continue;
        }
        if (json[index] === '"') {
          index += 1;
          break;
        }
        index += 1;
      }
      transformed += json.slice(start, index);
      continue;
    }

    if (current === "-" || (current !== undefined && /[0-9]/u.test(current))) {
      const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(
        json.slice(index),
      );
      if (match?.[0]) {
        transformed += JSON.stringify(match[0]);
        index += match[0].length;
        continue;
      }
    }

    transformed += current ?? "";
    index += 1;
  }
  return transformed;
}

export function parseCoinalyzeJson(body: string): unknown {
  return JSON.parse(quoteNumberTokens(body)) as unknown;
}
