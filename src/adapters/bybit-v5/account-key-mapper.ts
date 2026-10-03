import { hashCanonical } from "../../domain/identity/canonical-serialization.js";
import {
  createAccountBinding,
  createAccountCredentialPosture,
  type AccountBinding,
  type AccountCredentialPosture,
  type AccountEvidenceEnvironment,
} from "../../domain/account/account-evidence-bundle.js";
import {
  parseUtcTimestamp,
  type UtcTimestamp,
} from "../../domain/shared/time.js";
import { isRecord } from "../../domain/shared/validation.js";
import {
  ACCOUNT_READ_ORIGINS,
  BybitAccountReadError,
  type AccountReadResponse,
} from "./account-read-transport.js";

function invalid(): never {
  throw new BybitAccountReadError("INVALID_RESPONSE");
}
function uid(value: unknown): string | undefined {
  if (typeof value === "number")
    return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
  return typeof value === "string" && /^[1-9]\d{0,31}$/u.test(value)
    ? value
    : undefined;
}
function stringList(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length > 256 ||
    value.some(
      (v) =>
        typeof v !== "string" ||
        v.length > 256 ||
        /[\u0000-\u001f\u007f]/u.test(v),
    )
  )
    invalid();
  return value;
}
function expiry(value: unknown): UtcTimestamp | null {
  if (value === undefined || value === "" || value === 0 || value === "0")
    return null;
  if (typeof value !== "string") invalid();
  const parsed = parseUtcTimestamp(value);
  if (!parsed.ok) invalid();
  return Date.parse(parsed.value) === 0 ? null : parsed.value;
}

/** Called only on the successful authenticated query-api response; never emits raw UID/key/IPs. */
export function mapAccountReadIdentity(
  response: AccountReadResponse,
  expectedAccountId: string,
  environment: AccountEvidenceEnvironment,
  authenticatedAt: unknown,
): Readonly<{
  accountBinding: AccountBinding;
  credentialPosture: AccountCredentialPosture;
}> {
  if (
    !Object.hasOwn(ACCOUNT_READ_ORIGINS, environment) ||
    !uid(expectedAccountId)
  )
    invalid();
  const item = response.result;
  if (!isRecord(item)) invalid();
  const narrow = uid(item.userID),
    wide =
      item.userIDInt64 === undefined || item.userIDInt64 === "0"
        ? undefined
        : uid(item.userIDInt64);
  if (item.userIDInt64 !== undefined && item.userIDInt64 !== "0" && !wide)
    invalid();
  if (narrow && wide && narrow !== wide) invalid();
  const actual = wide ?? narrow;
  if (!actual) invalid();
  if (actual !== expectedAccountId)
    throw new BybitAccountReadError("ACCOUNT_IDENTITY_MISMATCH");
  const readOnly =
    item.readOnly === 1 || item.readOnly === "1"
      ? true
      : item.readOnly === 0 || item.readOnly === "0"
        ? false
        : invalid();
  if (!isRecord(item.permissions)) invalid();
  const contract = stringList(item.permissions.ContractTrade),
    wallet = stringList(item.permissions.Wallet),
    spot = stringList(item.permissions.Spot);
  if (wallet.some((permission) => permission.toLowerCase() === "withdraw"))
    throw new BybitAccountReadError("WITHDRAWAL_PERMISSION_FORBIDDEN");
  const ips = stringList(item.ips);
  const ipBound =
    ips.length > 0 &&
    !ips.some((ip) => ["*", "0.0.0.0/0", "::/0"].includes(ip));
  const posture = createAccountCredentialPosture({
    readOnly,
    permissions: {
      contractOrder: contract.includes("Order"),
      contractPosition: contract.includes("Position"),
      spotTrade: spot.includes("SpotTrade"),
      walletTransfer: wallet.some((p) =>
        [
          "AccountTransfer",
          "SubMemberTransfer",
          "SubMemberTransferList",
        ].includes(p),
      ),
      withdraw: false,
    },
    ipBound,
    expiresAt: expiry(item.expiredAt),
    warnings: ipBound ? [] : ["API_KEY_IP_UNBOUND"],
  });
  if (!posture.ok) invalid();
  const identity = hashCanonical({
    exchange: "bybit",
    environment,
    userID: actual,
  });
  if (!identity.ok) invalid();
  const binding = createAccountBinding({
    exchange: "bybit",
    environment,
    origin: ACCOUNT_READ_ORIGINS[environment],
    accountIdentityHash: identity.value,
    authenticatedAt,
    identityVerified: true,
  });
  if (!binding.ok) invalid();
  return Object.freeze({
    accountBinding: binding.value,
    credentialPosture: posture.value,
  });
}
