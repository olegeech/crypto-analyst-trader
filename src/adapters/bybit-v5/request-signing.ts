import { createHmac } from "node:crypto";

/** Sign exactly the transmitted query/body bytes; this module has no HTTP authority. */
export function buildSignaturePayload(
  timestamp: string,
  apiKey: string,
  recvWindow: string,
  queryStringOrRawBody: string,
): string {
  return `${timestamp}${apiKey}${recvWindow}${queryStringOrRawBody}`;
}

export function hmacSha256(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}
