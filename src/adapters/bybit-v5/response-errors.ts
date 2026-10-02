export type TransportFailureKind =
  | "clock-skew"
  | "signing-defect"
  | "invalid-credentials"
  | "expired-credentials"
  | "permission-denied"
  | "ip-restriction"
  | "rate-limited"
  | "ambiguous-server"
  | "ownership-conflict"
  | "validation-failed"
  | "exchange-failure"
  | "transport-failed"
  | "invalid-request"
  | "invalid-response";

export interface RetCodeClassification {
  readonly kind: TransportFailureKind;
  readonly retCode: number;
  readonly recommendReconnect: boolean;
  readonly message: string;
}

export function classifyRetCode(retCode: number): RetCodeClassification {
  switch (retCode) {
    case 10000:
    case 10016:
      return {
        kind: "ambiguous-server",
        retCode,
        recommendReconnect: false,
        message:
          "Bybit returned an ambiguous server outcome; reconcile exchange state before retrying.",
      };
    case 10002:
      return {
        kind: "clock-skew",
        retCode,
        recommendReconnect: false,
        message:
          "Bybit rejected the request because the signing clock is outside the allowed window.",
      };
    case 10004:
      return {
        kind: "signing-defect",
        retCode,
        recommendReconnect: false,
        message:
          "Bybit rejected the signature; inspect the signing implementation before retrying.",
      };
    case 10003:
      return {
        kind: "invalid-credentials",
        retCode,
        recommendReconnect: true,
        message: "Bybit rejected the Demo API credentials.",
      };
    case 33004:
      return {
        kind: "expired-credentials",
        retCode,
        recommendReconnect: true,
        message: "The Bybit Demo API key is expired.",
      };
    case 10005:
      return {
        kind: "permission-denied",
        retCode,
        recommendReconnect: true,
        message: "The Bybit Demo credential lacks the required permission.",
      };
    case 10010:
      return {
        kind: "ip-restriction",
        retCode,
        recommendReconnect: false,
        message:
          "Bybit rejected the request because the caller IP is not allowed.",
      };
    case 10006:
      return {
        kind: "rate-limited",
        retCode,
        recommendReconnect: false,
        message:
          "Bybit rate-limited the request; retry only within the read budget.",
      };
    case 110072:
      return {
        kind: "ownership-conflict",
        retCode,
        recommendReconnect: false,
        message:
          "Bybit reported that the supplied orderLinkId is already in use; reconcile that exact identity.",
      };
    case 110001:
    case 110008:
    case 110010:
      return {
        kind: "ownership-conflict",
        retCode,
        recommendReconnect: false,
        message: "Bybit reported an order ownership or lifecycle conflict.",
      };
    case 10001:
    case 110003:
    case 110007:
    case 110017:
    case 110023:
    case 110094:
    case 110100:
    case 181017:
      return {
        kind: "validation-failed",
        retCode,
        recommendReconnect: false,
        message:
          "Bybit rejected the request as invalid or unavailable for this scope.",
      };
    default:
      return {
        kind: "exchange-failure",
        retCode,
        recommendReconnect: false,
        message: `Bybit returned an unclassified failure code (${retCode}).`,
      };
  }
}
