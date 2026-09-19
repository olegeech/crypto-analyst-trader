export type CredentialEnvironment = "testnet" | "mainnet" | "demo";

export interface ExchangeCredentials {
  apiKey: string;
  apiSecret: string;
  accountId: string;
}

export interface CredentialProvider {
  load(environment: CredentialEnvironment): Promise<ExchangeCredentials>;
  save(
    environment: CredentialEnvironment,
    credentials: ExchangeCredentials,
  ): Promise<void>;
  remove(environment: CredentialEnvironment): Promise<void>;
}

export interface CredentialPreflight {
  preflight(environment: CredentialEnvironment): Promise<void>;
}

export type CredentialProviderWithPreflight = CredentialProvider &
  CredentialPreflight;

export const credentialAccounts = {
  apiKey: "api-key",
  apiSecret: "api-secret",
  accountId: "account-id",
} as const;

export const credentialPreflightAccount = "connect-preflight";

export function credentialServiceName(
  environment: CredentialEnvironment,
): string {
  return `com.crypto-analyst-trader.bybit.${environment}`;
}

export function credentialPreflightServiceName(
  environment: CredentialEnvironment,
): string {
  return `${credentialServiceName(environment)}.preflight`;
}

export function setupCommand(environment: CredentialEnvironment): string {
  return `npm run credentials:setup:${environment}`;
}

export function connectCommand(environment: CredentialEnvironment): string {
  return `npm run credentials:connect:${environment}`;
}

export class CredentialProviderError extends Error {
  readonly code:
    | "missing"
    | "inaccessible"
    | "unsupported"
    | "invalid"
    | "command-failed"
    | "write-failed"
    | "remove-failed"
    | "preflight-failed";

  constructor(code: CredentialProviderError["code"], message: string) {
    super(message);
    this.name = "CredentialProviderError";
    this.code = code;
  }
}
