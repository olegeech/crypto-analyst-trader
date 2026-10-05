import { userInfo } from "node:os";
import { hashCanonical } from "../domain/identity/canonical-serialization.js";
import { domainError } from "../domain/shared/errors.js";
import { fail, ok, type Result } from "../domain/shared/result.js";

/** OS-derived local operator identity, never an artifact/CLI self-claim. */
export function localOperatorIdentity(): Result<string> {
  try {
    const user = userInfo();
    if (!user.username || !Number.isSafeInteger(user.uid) || user.uid < 0)
      throw new Error("unavailable");
    const hash = hashCanonical({ uid: user.uid, username: user.username });
    if (!hash.ok) return hash;
    return ok(`local-operator:${hash.value}`);
  } catch {
    return fail(domainError("INVALID_VALUE", "Operator identity unavailable"));
  }
}
