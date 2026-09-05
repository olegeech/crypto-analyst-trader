export type CredentialEnvironment = "testnet" | "mainnet";

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

export const credentialAccounts = {
  apiKey: "api-key",
  apiSecret: "api-secret",
  accountId: "account-id",
} as const;

export function credentialServiceName(
  environment: CredentialEnvironment,
): string {
  return `com.crypto-analyst-trader.bybit.${environment}`;
}

export function setupCommand(environment: CredentialEnvironment): string {
  return `npm run credentials:setup:${environment}`;
}

export class CredentialProviderError extends Error {
  readonly code:
    | "missing"
    | "inaccessible"
    | "unsupported"
    | "invalid"
    | "command-failed"
    | "write-failed"
    | "remove-failed";

  constructor(code: CredentialProviderError["code"], message: string) {
    super(message);
    this.name = "CredentialProviderError";
    this.code = code;
  }
}
