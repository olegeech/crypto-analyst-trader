import {
  createEvidenceRef,
  isEvidenceFresh,
  type EvidenceRef,
} from "../evidence/evidence-ref.js";
import { domainError } from "../shared/errors.js";
import {
  parseUtcTimestamp,
  type Clock,
  type UtcTimestamp,
} from "../shared/time.js";
import { fail, ok, type Result } from "../shared/result.js";
import {
  isRecord,
  requireIdentifier,
  requireSafeText,
} from "../shared/validation.js";
import {
  isAdapterProducedCapabilityObservation,
  isProducedCapabilityObservation,
  markAdapterCapabilityObservation,
  markCapabilityObservation,
} from "./capability-proof.js";

export type CapabilityStatus = "supported" | "unsupported" | "unknown";

export interface CapabilityScope {
  readonly exchange: string;
  readonly environment: string;
  readonly category: string;
  readonly positionMode: "one-way" | "hedge";
}

export interface CapabilityRequirement {
  readonly capability: string;
  readonly scope: CapabilityScope;
}

export interface CapabilityObservation {
  readonly capability: string;
  readonly status: CapabilityStatus;
  readonly observedAt: UtcTimestamp;
  readonly source: string;
  readonly evidence: EvidenceRef;
  readonly scope: CapabilityScope;
}

export function parseCapabilityScope(input: unknown): Result<CapabilityScope> {
  if (!isRecord(input)) {
    return fail(
      domainError("INVALID_CAPABILITY", "capability scope must be an object"),
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
    return fail(
      domainError("INVALID_CAPABILITY", "capability scope is invalid"),
    );
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

function scopesEqual(left: CapabilityScope, right: CapabilityScope): boolean {
  return (
    left.exchange === right.exchange &&
    left.environment === right.environment &&
    left.category === right.category &&
    left.positionMode === right.positionMode
  );
}

export function createCapabilityObservation(
  input: unknown,
): Result<CapabilityObservation> {
  if (!isRecord(input))
    return fail(
      domainError("INVALID_CAPABILITY", "capability must be an object"),
    );
  const capability = requireIdentifier(input.capability, "capability");
  const source = requireSafeText(input.source, "source");
  const observedAt = parseUtcTimestamp(input.observedAt);
  const evidence = createEvidenceRef(input.evidence);
  const scope = parseCapabilityScope(input.scope);
  if (
    !capability.ok ||
    !source.ok ||
    !observedAt.ok ||
    !evidence.ok ||
    !scope.ok ||
    evidence.value.kind !== "capability-probe" ||
    (input.status !== "supported" &&
      input.status !== "unsupported" &&
      input.status !== "unknown")
  ) {
    return fail(
      domainError("INVALID_CAPABILITY", "capability observation is invalid"),
    );
  }
  return ok(
    markCapabilityObservation(
      Object.freeze({
        capability: capability.value,
        status: input.status,
        observedAt: observedAt.value,
        source: source.value,
        evidence: evidence.value,
        scope: scope.value,
      }),
    ),
  );
}

/**
 * Creates an observation at the adapter boundary. The returned object keeps
 * the normal domain proof and receives a second process-local marker that is
 * deliberately lost when the observation is copied or rehydrated.
 */
export function createAdapterCapabilityObservation(
  input: unknown,
): Result<CapabilityObservation> {
  const observation = createCapabilityObservation(input);
  if (!observation.ok) return observation;
  return ok(markAdapterCapabilityObservation(observation.value));
}

export function requireCapability(
  observation: CapabilityObservation,
  requirement: CapabilityRequirement,
): Result<CapabilityObservation> {
  if (!isProducedCapabilityObservation(observation)) {
    return fail(
      domainError(
        "CAPABILITY_UNKNOWN",
        "capability observation must be produced by the domain",
      ),
    );
  }
  if (
    observation.capability !== requirement.capability ||
    !scopesEqual(observation.scope, requirement.scope)
  ) {
    return fail(
      domainError(
        "CAPABILITY_UNKNOWN",
        "no observation proves the required capability scope",
        {
          capability: requirement.capability,
          environment: requirement.scope.environment,
        },
      ),
    );
  }
  if (observation.status === "unsupported") {
    return fail(
      domainError(
        "CAPABILITY_UNSUPPORTED",
        "required capability is unsupported",
        {
          capability: requirement.capability,
        },
      ),
    );
  }
  if (observation.status === "unknown") {
    return fail(
      domainError("CAPABILITY_UNKNOWN", "required capability is unproven", {
        capability: requirement.capability,
      }),
    );
  }
  return ok(observation);
}

export function requireTrustedCapability(
  observation: CapabilityObservation,
  requirement: CapabilityRequirement,
  clock?: Clock,
): Result<CapabilityObservation> {
  const gate = requireCapability(observation, requirement);
  if (!gate.ok) return gate;
  if (
    gate.value.status === "supported" &&
    !isAdapterProducedCapabilityObservation(gate.value)
  ) {
    return fail(
      domainError(
        "CAPABILITY_UNKNOWN",
        "supported capability evidence must be produced by the adapter",
        { capability: requirement.capability },
      ),
    );
  }
  if (clock !== undefined && !isEvidenceFresh(gate.value.evidence, clock)) {
    return fail(
      domainError("STALE_EVIDENCE", "capability evidence is stale", {
        capability: requirement.capability,
      }),
    );
  }
  return gate;
}

export function capabilityStatus(
  observations: readonly CapabilityObservation[],
  requirement: CapabilityRequirement,
): CapabilityStatus {
  const matching = observations.filter(
    (item) =>
      item.capability === requirement.capability &&
      scopesEqual(item.scope, requirement.scope),
  );
  if (matching.some((item) => item.status === "unsupported")) {
    return "unsupported";
  }
  if (matching.some((item) => item.status === "unknown")) {
    return "unknown";
  }
  return matching.some(
    (item) =>
      item.status === "supported" &&
      isAdapterProducedCapabilityObservation(item),
  )
    ? "supported"
    : "unknown";
}
