export interface SecretIdentity {
  readonly provider: string;
  readonly credential: string;
}

export type SecretUnavailableReason =
  | "missing"
  | "inaccessible"
  | "unsupported-platform"
  | "invalid-identity"
  | "invalid-secret"
  | "timeout"
  | "command-failed";

export type SecretReadResult =
  | Readonly<{ kind: "available"; secret: string }>
  | Readonly<{ kind: "unavailable"; reason: SecretUnavailableReason }>;

export interface SecretProvider {
  read(identity: SecretIdentity): Promise<SecretReadResult>;
}
