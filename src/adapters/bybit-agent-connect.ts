import { createHash, randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import {
  AgentConnectError,
  type AgentConnectAccount,
  type AgentConnectCallback,
  type AgentConnectClient,
  type AgentConnectSession,
  type AgentConnectSessionOptions,
  type AgentConnectTransport,
} from "../ports/agent-connect.js";
import type {
  CredentialEnvironment,
  ExchangeCredentials,
} from "../ports/credential-provider.js";

const OAUTH_CLIENT_ID = "ai-agent";
const OAUTH_SCOPE = "ai-account";
const OAUTH_PATH = "/oauth/v1/public/access_token";
const AI_ACCOUNTS_PATH = "/oauth/v1/resource/restrict/ai_accounts";
const DEFAULT_START_PORT = 9876;
const DEFAULT_PORT_RANGE = 10;
const DEFAULT_CALLBACK_TIMEOUT_MS = 300_000;
const MAX_CALLBACK_TIMEOUT_MS = 300_000;
const REQUEST_TIMEOUT_MS = 30_000;

export const agentConnectEndpoints = {
  mainnet: {
    authorizationUrl: "https://www.bybit.com/oauth",
    apiBaseUrl: "https://api2.bybit.com",
  },
  testnet: {
    authorizationUrl: "https://testnet.bybit.com/oauth",
    apiBaseUrl: "https://api2-testnet.bybit.com",
  },
} as const satisfies Record<
  CredentialEnvironment,
  { authorizationUrl: string; apiBaseUrl: string }
>;

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function safeSingleLineString(value: unknown, field: string): string {
  const normalized =
    typeof value === "string"
      ? value.trim()
      : typeof value === "number" && Number.isFinite(value)
        ? String(value)
        : "";
  if (!normalized || /[\u0000-\u001f\u007f\r\n]/.test(normalized)) {
    throw new AgentConnectError(
      "invalid-response",
      `Bybit OAuth response has an invalid ${field}.`,
    );
  }
  return normalized;
}

function responseResult(response: unknown): unknown {
  const object = asObject(response);
  return object && object.result !== undefined ? object.result : response;
}

function responseCode(response: unknown): unknown {
  const object = asObject(response);
  if (!object) return undefined;
  if (Object.hasOwn(object, "retCode")) return object.retCode;
  if (Object.hasOwn(object, "ret_code")) return object.ret_code;
  return undefined;
}

function isSuccessCode(code: unknown): boolean {
  return code === undefined || code === 0 || code === "0";
}

function assertApiSuccess(response: unknown, operation: string): void {
  const code = responseCode(response);
  if (
    code !== undefined &&
    typeof code !== "number" &&
    typeof code !== "string"
  ) {
    throw new AgentConnectError(
      "invalid-response",
      `Bybit ${operation} returned an invalid response code.`,
    );
  }
  if (!isSuccessCode(code)) {
    throw new AgentConnectError("api-failed", `Bybit ${operation} failed.`);
  }
}

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      throw new AgentConnectError(
        "api-failed",
        `Bybit OAuth request failed (HTTP ${response.status}).`,
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new AgentConnectError(
        "invalid-response",
        "Bybit OAuth returned an invalid response.",
      );
    }
    return payload;
  } catch (error) {
    if (error instanceof AgentConnectError) {
      throw error;
    }
    throw new AgentConnectError(
      "transport-failed",
      "Bybit OAuth request could not be completed.",
    );
  } finally {
    clearTimeout(timeout);
  }
}

export const defaultAgentConnectTransport: AgentConnectTransport = {
  async postForm(url, body) {
    return fetchJson(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  },
  async get(url, accessToken) {
    return fetchJson(url, {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}` },
    });
  },
};

function createVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function createState(): string {
  return randomBytes(32).toString("base64url");
}

function codeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function buildAuthorizationUrl(
  environment: CredentialEnvironment,
  port: number,
  state: string,
  verifier: string,
): string {
  const url = new URL(agentConnectEndpoints[environment].authorizationUrl);
  url.searchParams.set("client_id", OAUTH_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", OAUTH_SCOPE);
  url.searchParams.set("state", state);
  url.searchParams.set("redirect_uri", `http://127.0.0.1:${port}/callback`);
  url.searchParams.set("code_challenge", codeChallenge(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onListening = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error & { code?: string }) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      server.off("listening", onListening);
      server.off("error", onError);
    };
    server.once("listening", onListening);
    server.once("error", onError);
    server.listen(port, "127.0.0.1");
  });
}

function closeServer(server: Server | undefined): void {
  if (server?.listening) {
    server.close();
  }
}

function callbackResponse(
  response: ServerResponse,
  status: number,
  message: string,
): void {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  response.end(message);
}

export async function startAgentConnectSession(
  environment: CredentialEnvironment,
  options: AgentConnectSessionOptions = {},
): Promise<AgentConnectSession> {
  const startPort = options.startPort ?? DEFAULT_START_PORT;
  const maxPort = options.maxPort ?? startPort + DEFAULT_PORT_RANGE;
  const timeoutMs = Math.min(
    Math.max(options.timeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS, 1),
    MAX_CALLBACK_TIMEOUT_MS,
  );
  if (
    !Number.isInteger(startPort) ||
    !Number.isInteger(maxPort) ||
    startPort < 0 ||
    maxPort < startPort
  ) {
    throw new AgentConnectError(
      "port-unavailable",
      "Bybit OAuth callback port range is invalid.",
    );
  }

  const state = createState();
  const verifier = createVerifier();
  let activeServer: Server | undefined;
  let settled = false;
  let resolveCallback: (callback: AgentConnectCallback) => void = () =>
    undefined;
  let rejectCallback: (error: AgentConnectError) => void = () => undefined;
  const callback = new Promise<AgentConnectCallback>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  const fail = (error: AgentConnectError): void => {
    if (settled) return;
    settled = true;
    if (timeout) clearTimeout(timeout);
    closeServer(activeServer);
    rejectCallback(error);
  };
  const succeed = (code: string, response: ServerResponse): void => {
    if (settled) {
      callbackResponse(response, 409, "Authorization already processed.");
      return;
    }
    settled = true;
    if (timeout) clearTimeout(timeout);
    callbackResponse(
      response,
      200,
      "Authorization successful. You can close this page.",
    );
    resolveCallback({ code, codeVerifier: verifier });
    setImmediate(() => closeServer(activeServer));
  };
  const handleRequest = (
    request: IncomingMessage,
    response: ServerResponse,
  ): void => {
    if (settled) {
      callbackResponse(response, 409, "Authorization already processed.");
      return;
    }
    let url: URL;
    try {
      url = new URL(request.url ?? "", "http://127.0.0.1");
    } catch {
      callbackResponse(response, 400, "Authorization failed.");
      fail(
        new AgentConnectError(
          "callback-invalid",
          "OAuth callback was malformed.",
        ),
      );
      return;
    }
    if (url.pathname !== "/callback") {
      callbackResponse(response, 404, "Not found.");
      return;
    }
    const returnedState = url.searchParams.get("state");
    const returnedError = url.searchParams.get("error");
    const returnedCode = url.searchParams.get("code");
    if (returnedState !== state || returnedError !== null || !returnedCode) {
      callbackResponse(response, 400, "Authorization failed.");
      fail(
        new AgentConnectError(
          "callback-invalid",
          "OAuth callback validation failed.",
        ),
      );
      return;
    }
    try {
      const code = safeSingleLineString(returnedCode, "authorization code");
      succeed(code, response);
    } catch (error) {
      callbackResponse(response, 400, "Authorization failed.");
      fail(
        error instanceof AgentConnectError
          ? error
          : new AgentConnectError(
              "callback-invalid",
              "OAuth callback validation failed.",
            ),
      );
    }
  };

  let selectedPort: number | undefined;
  for (let port = startPort; port <= maxPort; port += 1) {
    const server = createServer(handleRequest);
    try {
      await listen(server, port);
      activeServer = server;
      const address = server.address();
      selectedPort =
        typeof address === "object" && address !== null
          ? address.port
          : undefined;
      if (!selectedPort) {
        closeServer(server);
        throw new AgentConnectError(
          "port-unavailable",
          "Bybit OAuth callback port could not be determined.",
        );
      }
      break;
    } catch (error) {
      closeServer(server);
      if (
        error instanceof Error &&
        "code" in error &&
        (error as Error & { code?: string }).code === "EADDRINUSE"
      ) {
        continue;
      }
      if (error instanceof AgentConnectError) throw error;
      throw new AgentConnectError(
        "port-unavailable",
        "Bybit OAuth callback server could not start.",
      );
    }
  }

  if (selectedPort === undefined || activeServer === undefined) {
    throw new AgentConnectError(
      "port-unavailable",
      "No available loopback port was found for Bybit OAuth.",
    );
  }

  const timeout = setTimeout(() => {
    fail(
      new AgentConnectError("timeout", "Bybit OAuth authorization timed out."),
    );
  }, timeoutMs);

  return {
    authorizationUrl: buildAuthorizationUrl(
      environment,
      selectedPort,
      state,
      verifier,
    ),
    port: selectedPort,
    waitForCallback: () => callback,
    close: () => {
      if (!settled) {
        fail(
          new AgentConnectError(
            "callback-invalid",
            "OAuth callback session closed.",
          ),
        );
      } else {
        closeServer(activeServer);
      }
    },
  };
}

function accountList(response: unknown): unknown[] {
  const result = responseResult(response);
  if (Array.isArray(result)) return result;
  const object = asObject(result);
  if (object && Array.isArray(object.accounts)) return object.accounts;
  throw new AgentConnectError(
    "invalid-response",
    "Bybit OAuth returned an invalid AI Subaccount list.",
  );
}

function normalizeAccount(value: unknown): AgentConnectAccount {
  const object = asObject(value);
  if (!object) {
    throw new AgentConnectError(
      "invalid-response",
      "Bybit OAuth returned an invalid AI Subaccount.",
    );
  }
  const accountId = safeSingleLineString(object.sub_member_id, "sub_member_id");
  const displayName =
    typeof object.nickname === "string" && object.nickname.trim()
      ? object.nickname.trim()
      : "AI Subaccount";
  if (/[\u0000-\u001f\u007f\r\n]/.test(displayName)) {
    throw new AgentConnectError(
      "invalid-response",
      "Bybit OAuth returned an invalid AI Subaccount name.",
    );
  }
  return { accountId, displayName };
}

function selectedAccount(response: unknown): JsonObject {
  const result = responseResult(response);
  const value = Array.isArray(result) ? result[0] : result;
  const object = asObject(value);
  if (!object) {
    throw new AgentConnectError(
      "invalid-response",
      "Bybit OAuth returned an invalid AI Subaccount credential response.",
    );
  }
  return object;
}

export function createBybitAgentConnectClient({
  transport = defaultAgentConnectTransport,
}: {
  transport?: AgentConnectTransport;
} = {}): AgentConnectClient {
  return {
    createSession(environment, options) {
      return startAgentConnectSession(environment, options);
    },
    async exchangeCode(environment, callback) {
      const response = await transport.postForm(
        `${agentConnectEndpoints[environment].apiBaseUrl}${OAUTH_PATH}`,
        new URLSearchParams({
          client_id: OAUTH_CLIENT_ID,
          code: callback.code,
          code_verifier: callback.codeVerifier,
        }),
      );
      assertApiSuccess(response, "token exchange");
      const object = asObject(responseResult(response));
      if (!object) {
        throw new AgentConnectError(
          "invalid-response",
          "Bybit OAuth returned an invalid token response.",
        );
      }
      return safeSingleLineString(object.access_token, "access token");
    },
    async listAccounts(environment, accessToken) {
      const response = await transport.get(
        `${agentConnectEndpoints[environment].apiBaseUrl}${AI_ACCOUNTS_PATH}`,
        accessToken,
      );
      assertApiSuccess(response, "AI Subaccount lookup");
      return accountList(response).map(normalizeAccount);
    },
    async fetchAccountCredentials(environment, accessToken, selection) {
      const url = new URL(
        `${agentConnectEndpoints[environment].apiBaseUrl}${AI_ACCOUNTS_PATH}`,
      );
      if (selection.kind === "existing") {
        url.searchParams.set("sub_member_id", selection.accountId);
      } else {
        url.searchParams.set("is_create", "true");
      }
      const response = await transport.get(url.toString(), accessToken);
      assertApiSuccess(response, "AI Subaccount credential lookup");
      const account = selectedAccount(response);
      const accountId = safeSingleLineString(
        account.sub_member_id,
        "sub_member_id",
      );
      if (selection.kind === "existing" && accountId !== selection.accountId) {
        throw new AgentConnectError(
          "invalid-response",
          "Bybit OAuth returned credentials for a different AI Subaccount.",
        );
      }
      if (
        selection.kind === "create" &&
        selection.existingAccountIds.includes(accountId)
      ) {
        throw new AgentConnectError(
          "invalid-response",
          "Bybit OAuth returned an existing AI Subaccount for a create request.",
        );
      }
      return {
        apiKey: safeSingleLineString(account.api_key, "api_key"),
        apiSecret: safeSingleLineString(account.api_secret, "api_secret"),
        accountId,
      } satisfies ExchangeCredentials;
    },
  };
}

export { AgentConnectError } from "../ports/agent-connect.js";
