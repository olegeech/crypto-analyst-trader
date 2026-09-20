import { domainError } from "../shared/errors.js";
import { DecimalValue } from "../shared/decimal.js";
import {
  parseEvidenceList,
  type EvidenceRef,
} from "../evidence/evidence-ref.js";
import { parseUtcTimestamp, type UtcTimestamp } from "../shared/time.js";
import { fail, ok, type Result } from "../shared/result.js";
import {
  isRecord,
  requireIdentifier,
  requireSafeText,
  type UnknownRecord,
} from "../shared/validation.js";
import {
  createInstrumentConstraints,
  type InstrumentConstraints,
} from "./instrument-constraints.js";
import { markAccountSnapshot, markMarketSnapshot } from "./snapshot-proof.js";

export type PositionSide = "long" | "short" | "flat";

export interface SnapshotScope {
  readonly exchange: string;
  readonly environment: string;
  readonly category: string;
  readonly positionMode: "one-way" | "hedge";
}

export interface PositionSnapshot {
  readonly instrument: string;
  readonly side: PositionSide;
  readonly quantity: DecimalValue;
  readonly entryPrice?: DecimalValue;
}

export interface OwnedOrderSnapshot {
  readonly clientOrderId: string;
  readonly instrument: string;
  readonly side: "buy" | "sell";
  readonly quantity: DecimalValue;
}

export interface MarketSnapshot {
  readonly snapshotId: string;
  readonly instrument: string;
  readonly scope: SnapshotScope;
  readonly asOf: UtcTimestamp;
  readonly bid: DecimalValue;
  readonly ask: DecimalValue;
  readonly last: DecimalValue;
  readonly constraints: InstrumentConstraints;
  readonly evidence: readonly EvidenceRef[];
}

export interface AccountSnapshot {
  readonly snapshotId: string;
  readonly accountScope: string;
  readonly scope: SnapshotScope;
  readonly asOf: UtcTimestamp;
  readonly availableBalance: DecimalValue;
  readonly positions: readonly PositionSnapshot[];
  readonly ownedOrders: readonly OwnedOrderSnapshot[];
  readonly evidence: readonly EvidenceRef[];
}

function parseNonNegativeDecimal(
  value: unknown,
  field: string,
): Result<DecimalValue> {
  const result = DecimalValue.fromString(value);
  if (!result.ok) return result;
  if (result.value.isNegative()) {
    return fail(
      domainError("INVALID_VALUE", `${field} must not be negative`, { field }),
    );
  }
  return result;
}

function parsePositiveDecimal(
  value: unknown,
  field: string,
): Result<DecimalValue> {
  const result = DecimalValue.fromString(value);
  if (!result.ok) return result;
  if (!result.value.isPositive()) {
    return fail(
      domainError("INVALID_VALUE", `${field} must be positive`, { field }),
    );
  }
  return result;
}

function parseSnapshotScope(input: unknown): Result<SnapshotScope> {
  if (!isRecord(input)) {
    return fail(
      domainError("INVALID_VALUE", "snapshot scope must be an object"),
    );
  }
  const exchange = requireIdentifier(input.exchange, "scope.exchange");
  const environment = requireIdentifier(input.environment, "scope.environment");
  const category = requireIdentifier(input.category, "scope.category");
  const positionMode = input.positionMode;
  if (
    !exchange.ok ||
    !environment.ok ||
    !category.ok ||
    (positionMode !== "one-way" && positionMode !== "hedge")
  ) {
    return fail(domainError("INVALID_VALUE", "snapshot scope is invalid"));
  }
  return ok(
    Object.freeze({
      exchange: exchange.value,
      environment: environment.value,
      category: category.value,
      positionMode,
    }),
  );
}

function parsePosition(input: unknown): Result<PositionSnapshot> {
  if (!isRecord(input))
    return fail(domainError("INVALID_VALUE", "position must be an object"));
  const instrument = requireIdentifier(input.instrument, "instrument");
  const quantity = parseNonNegativeDecimal(input.quantity, "quantity");
  if (!instrument.ok || !quantity.ok) {
    return fail(
      domainError("INVALID_VALUE", "position contains an invalid field"),
    );
  }
  if (
    input.side !== "long" &&
    input.side !== "short" &&
    input.side !== "flat"
  ) {
    return fail(domainError("INVALID_VALUE", "position side is invalid"));
  }
  const entryPrice =
    input.entryPrice === undefined
      ? ok<DecimalValue | undefined>(undefined)
      : parsePositiveDecimal(input.entryPrice, "entryPrice");
  if (!entryPrice.ok) return entryPrice;
  const position: {
    instrument: string;
    side: PositionSide;
    quantity: DecimalValue;
    entryPrice?: DecimalValue;
  } = {
    instrument: instrument.value,
    side: input.side,
    quantity: quantity.value,
  };
  if (entryPrice.value !== undefined) position.entryPrice = entryPrice.value;
  return ok(Object.freeze(position));
}

function parseOwnedOrder(input: unknown): Result<OwnedOrderSnapshot> {
  if (!isRecord(input))
    return fail(domainError("INVALID_VALUE", "owned order must be an object"));
  const clientOrderId = requireIdentifier(input.clientOrderId, "clientOrderId");
  const instrument = requireIdentifier(input.instrument, "instrument");
  const quantity = parsePositiveDecimal(input.quantity, "quantity");
  if (!clientOrderId.ok || !instrument.ok || !quantity.ok) {
    return fail(
      domainError("INVALID_VALUE", "owned order contains an invalid field"),
    );
  }
  if (input.side !== "buy" && input.side !== "sell") {
    return fail(domainError("INVALID_VALUE", "owned order side is invalid"));
  }
  return ok(
    Object.freeze({
      clientOrderId: clientOrderId.value,
      instrument: instrument.value,
      side: input.side,
      quantity: quantity.value,
    }),
  );
}

function commonSnapshotFields(input: UnknownRecord): Result<{
  snapshotId: string;
  instrument: string;
  asOf: UtcTimestamp;
  evidence: readonly EvidenceRef[];
}> {
  const snapshotId = requireIdentifier(input.snapshotId, "snapshotId");
  const instrument = requireIdentifier(input.instrument, "instrument");
  const asOf = parseUtcTimestamp(input.asOf);
  const evidence = parseEvidenceList(input.evidence);
  if (!snapshotId.ok || !instrument.ok || !asOf.ok || !evidence.ok) {
    return fail(
      domainError("INVALID_VALUE", "snapshot identity or evidence is invalid"),
    );
  }
  if (
    evidence.value.some(
      (item) => Date.parse(item.asOf) > Date.parse(asOf.value),
    )
  ) {
    return fail(
      domainError(
        "INVALID_VALUE",
        "snapshot evidence cannot be newer than the snapshot",
      ),
    );
  }
  return ok({
    snapshotId: snapshotId.value,
    instrument: instrument.value,
    asOf: asOf.value,
    evidence: evidence.value,
  });
}

export function createMarketSnapshot(input: unknown): Result<MarketSnapshot> {
  if (!isRecord(input))
    return fail(
      domainError("INVALID_VALUE", "market snapshot must be an object"),
    );
  const common = commonSnapshotFields(input);
  const bid = parsePositiveDecimal(input.bid, "bid");
  const ask = parsePositiveDecimal(input.ask, "ask");
  const last = parsePositiveDecimal(input.last, "last");
  const constraints = createInstrumentConstraints(input.constraints);
  const scope = parseSnapshotScope(input.scope);
  if (!common.ok) return common;
  if (!bid.ok) return bid;
  if (!ask.ok) return ask;
  if (!last.ok) return last;
  if (!constraints.ok) return constraints;
  if (!scope.ok) return scope;
  if (
    common.value.instrument !== constraints.value.instrument ||
    bid.value.compare(ask.value) > 0
  ) {
    return fail(
      domainError(
        "INVALID_VALUE",
        "market snapshot violates market invariants",
      ),
    );
  }
  return ok(
    markMarketSnapshot(
      Object.freeze({
        ...common.value,
        scope: scope.value,
        bid: bid.value,
        ask: ask.value,
        last: last.value,
        constraints: constraints.value,
      }),
    ),
  );
}

export function createAccountSnapshot(input: unknown): Result<AccountSnapshot> {
  if (!isRecord(input))
    return fail(
      domainError("INVALID_VALUE", "account snapshot must be an object"),
    );
  const snapshotId = requireIdentifier(input.snapshotId, "snapshotId");
  const accountScope = requireSafeText(input.accountScope, "accountScope");
  const scope = parseSnapshotScope(input.scope);
  const asOf = parseUtcTimestamp(input.asOf);
  const availableBalance = parseNonNegativeDecimal(
    input.availableBalance,
    "availableBalance",
  );
  if (!Array.isArray(input.positions) || !Array.isArray(input.ownedOrders)) {
    return fail(
      domainError(
        "INVALID_VALUE",
        "account positions and orders must be arrays",
      ),
    );
  }
  const positions: PositionSnapshot[] = [];
  for (const position of input.positions) {
    const parsed = parsePosition(position);
    if (!parsed.ok) return parsed;
    positions.push(parsed.value);
  }
  const ownedOrders: OwnedOrderSnapshot[] = [];
  for (const order of input.ownedOrders) {
    const parsed = parseOwnedOrder(order);
    if (!parsed.ok) return parsed;
    ownedOrders.push(parsed.value);
  }
  const evidence = parseEvidenceList(input.evidence);
  if (
    !snapshotId.ok ||
    !accountScope.ok ||
    !scope.ok ||
    !asOf.ok ||
    !availableBalance.ok ||
    !evidence.ok
  ) {
    return fail(
      domainError(
        "INVALID_VALUE",
        "account snapshot contains an invalid field",
      ),
    );
  }
  if (
    evidence.value.some(
      (item) => Date.parse(item.asOf) > Date.parse(asOf.value),
    )
  ) {
    return fail(
      domainError(
        "INVALID_VALUE",
        "snapshot evidence cannot be newer than the snapshot",
      ),
    );
  }
  return ok(
    markAccountSnapshot(
      Object.freeze({
        snapshotId: snapshotId.value,
        accountScope: accountScope.value,
        scope: scope.value,
        asOf: asOf.value,
        availableBalance: availableBalance.value,
        positions: Object.freeze(positions),
        ownedOrders: Object.freeze(ownedOrders),
        evidence: evidence.value,
      }),
    ),
  );
}
