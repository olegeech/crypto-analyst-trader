import type {
  CredentialEnvironment,
  ExchangeCredentials,
} from "./credential-provider.js";

export type AgentConnectSelection =
  | { kind: "existing"; accountId: string }
  | { kind: "create"; existingAccountIds: readonly string[] };

export interface AgentConnectAccount {
  accountId: string;
  displayName: string;
}

export interface AgentConnectCallback {
  code: string;
  codeVerifier: string;
  /** How the code arrived: the loopback callback or an operator paste. */
  source?: "loopback" | "pasted";
}

export interface AgentConnectChoice {
  id: string;
  label: string;
}

/**
 * Sanitized metadata about one request that reached the loopback callback
 * server. It never carries query values such as the code or state.
 */
export interface AgentConnectRequestEvent {
  method: string;
  path: string;
  fetchSite: string | null;
  fetchMode: string | null;
  fetchDest: string | null;
  origin: string | null;
  privateNetworkPreflight: boolean;
  callback: Readonly<{
    stateMatches: boolean;
    codePresent: boolean;
    errorPresent: boolean;
  }> | null;
  outcome: "accepted" | "rejected" | "already-processed" | "not-found";
}

export interface AgentConnectSession {
  authorizationUrl: string;
  port: number;
  /**
   * Local page, present when browser selection is enabled: it accepts a
   * pasted authorization code before the callback and shows the AI
   * Subaccount choices after it.
   */
  selectionUrl?: string;
  waitForCallback(): Promise<AgentConnectCallback>;
  /**
   * Completes the pending authorization with a code the operator pasted from
   * the Bybit page. Only this session's PKCE verifier can exchange it.
   */
  submitAuthorizationCode(code: string): "accepted" | "invalid" | "closed";
  /**
   * Shows the choices on the loopback page the authorization tab was
   * redirected to and waits for one explicit operator choice.
   */
  chooseInBrowser(choices: readonly AgentConnectChoice[]): Promise<string>;
  close(): void;
}

export interface AgentConnectSessionOptions {
  startPort?: number;
  maxPort?: number;
  timeoutMs?: number;
  browserSelection?: boolean;
  selectionTimeoutMs?: number;
  onRequest?: (event: AgentConnectRequestEvent) => void;
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
  | "invalid-response"
  | "authorization-cancelled"
  | "selection-unavailable"
  | "selection-cancelled"
  | "selection-timeout";

export class AgentConnectError extends Error {
  readonly code: AgentConnectErrorCode;

  constructor(code: AgentConnectErrorCode, message: string) {
    super(message);
    this.name = "AgentConnectError";
    this.code = code;
  }
}
