import type {
  CredentialEnvironment,
  ExchangeCredentials,
} from "./credential-provider.js";

export type AgentConnectSelection =
  { kind: "existing"; accountId: string } | { kind: "create" };

export interface AgentConnectAccount {
  accountId: string;
  displayName: string;
}

export interface AgentConnectCallback {
  code: string;
  codeVerifier: string;
}

export interface AgentConnectSession {
  authorizationUrl: string;
  port: number;
  waitForCallback(): Promise<AgentConnectCallback>;
  close(): void;
}

export interface AgentConnectSessionOptions {
  startPort?: number;
  maxPort?: number;
  timeoutMs?: number;
}

export interface AgentConnectTransport {
  postForm(url: string, body: URLSearchParams): Promise<unknown>;
  get(url: string, accessToken: string): Promise<unknown>;
}

export interface AgentConnectClient {
  createSession(
    environment: CredentialEnvironment,
    options?: AgentConnectSessionOptions,
  ): Promise<AgentConnectSession>;
  exchangeCode(
    environment: CredentialEnvironment,
    callback: AgentConnectCallback,
  ): Promise<string>;
  listAccounts(
    environment: CredentialEnvironment,
    accessToken: string,
  ): Promise<AgentConnectAccount[]>;
  fetchAccountCredentials(
    environment: CredentialEnvironment,
    accessToken: string,
    selection: AgentConnectSelection,
  ): Promise<ExchangeCredentials>;
}

export type AgentConnectErrorCode =
  | "port-unavailable"
  | "timeout"
  | "callback-invalid"
  | "transport-failed"
  | "api-failed"
  | "invalid-response";

export class AgentConnectError extends Error {
  readonly code: AgentConnectErrorCode;

  constructor(code: AgentConnectErrorCode, message: string) {
    super(message);
    this.name = "AgentConnectError";
    this.code = code;
  }
}
