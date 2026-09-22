import type { BybitPublicResponse } from "./public-response.js";

export type PublicPaginationFailureKind =
  "repeated-cursor" | "page-budget-exhausted" | "row-budget-exhausted";

export class BybitPublicPaginationError extends Error {
  readonly kind: PublicPaginationFailureKind;

  constructor(kind: PublicPaginationFailureKind, message: string) {
    super(message);
    this.name = "BybitPublicPaginationError";
    this.kind = kind;
  }
}

export interface PublicPaginationBudget {
  readonly maxPages: number;
  readonly maxRows: number;
}

export interface PublicPage<T> {
  readonly rows: readonly T[];
  readonly nextCursor?: string;
}

export const DEFAULT_PUBLIC_PAGE_BUDGET: PublicPaginationBudget = Object.freeze(
  {
    maxPages: 20,
    maxRows: 5_000,
  },
);

export function assertPublicPaginationBudget(
  budget: PublicPaginationBudget,
): PublicPaginationBudget {
  if (
    !Number.isSafeInteger(budget.maxPages) ||
    budget.maxPages < 1 ||
    budget.maxPages > 100 ||
    !Number.isSafeInteger(budget.maxRows) ||
    budget.maxRows < 1 ||
    budget.maxRows > 100_000
  ) {
    throw new TypeError("public pagination budget is outside its safe bounds");
  }
  return Object.freeze({ ...budget });
}

export function nextCursorFromResponse(
  response: BybitPublicResponse,
  label: string,
): string | undefined {
  const value = response.result.nextPageCursor;
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || /[\u0000-\u001f\u007f\r\n]/u.test(value)) {
    throw new BybitPublicPaginationError(
      "repeated-cursor",
      `Bybit ${label} response has an invalid page cursor.`,
    );
  }
  return value;
}

export async function readCursorPages<T>({
  read,
  budget = DEFAULT_PUBLIC_PAGE_BUDGET,
  label,
}: {
  readonly read: (cursor?: string) => Promise<PublicPage<T>>;
  readonly budget?: PublicPaginationBudget;
  readonly label: string;
}): Promise<readonly T[]> {
  const checked = assertPublicPaginationBudget(budget);
  const rows: T[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < checked.maxPages; page += 1) {
    const current = await read(cursor);
    if (rows.length + current.rows.length > checked.maxRows) {
      throw new BybitPublicPaginationError(
        "row-budget-exhausted",
        `Bybit ${label} row budget was exhausted.`,
      );
    }
    rows.push(...current.rows);
    if (current.nextCursor === undefined) return Object.freeze(rows);
    if (seenCursors.has(current.nextCursor)) {
      throw new BybitPublicPaginationError(
        "repeated-cursor",
        `Bybit ${label} pagination repeated a cursor.`,
      );
    }
    seenCursors.add(current.nextCursor);
    cursor = current.nextCursor;
  }
  throw new BybitPublicPaginationError(
    "page-budget-exhausted",
    `Bybit ${label} page budget was exhausted.`,
  );
}
