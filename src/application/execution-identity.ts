import { hashCanonical } from "../domain/identity/plan-hash.js";
import { domainError } from "../domain/shared/errors.js";
import { fail, ok, type Result } from "../domain/shared/result.js";
import { requireHash, requireIdentifier } from "../domain/shared/validation.js";

export const DEMO_CLIENT_ORDER_ID_LENGTH = 36;

/** Derive the exchange client identity only after the immutable plan hash exists. */
export function deriveDemoClientOrderId(
  planHash: string,
  intentId: string,
): Result<string> {
  const parsedHash = requireHash(planHash, "planHash");
  const parsedIntent = requireIdentifier(intentId, "intentId");
  if (!parsedHash.ok || !parsedIntent.ok) {
    return fail(
      domainError(
        "INVALID_ARGUMENT",
        "plan hash and intent identity are required for client-order identity",
      ),
    );
  }
  const digest = hashCanonical({
    identityVersion: "demo-client-order/v1",
    planHash: parsedHash.value,
    intentId: parsedIntent.value,
  });
  if (!digest.ok) return digest;
  const value = `demo-${digest.value.slice(7, 38)}`;
  if (value.length !== DEMO_CLIENT_ORDER_ID_LENGTH) {
    return fail(
      domainError(
        "INVALID_IDENTIFIER",
        "derived Demo client order ID is invalid",
      ),
    );
  }
  return ok(value);
}

export const deriveClientOrderId = deriveDemoClientOrderId;
