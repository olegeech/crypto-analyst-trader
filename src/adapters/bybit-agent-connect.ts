import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
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
  type AgentConnectChoice,
  type AgentConnectClient,
  type AgentConnectRequestEvent,
  type AgentConnectSession,
  type AgentConnectSessionOptions,
  type AgentConnectTransport,
} from "../ports/agent-connect.js";
import {
  connectCommand,
  type CredentialEnvironment,
  type ExchangeCredentials,
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
const TWO_FACTOR_REQUIRED_CODE = 20039;
const DEFAULT_SELECTION_TIMEOUT_MS = 300_000;
const MAX_SELECTION_TIMEOUT_MS = 300_000;
const MAX_SELECTION_FORM_BYTES = 4_096;
const SELECTION_REFRESH_SECONDS = 2;
const SELECTION_PATH = "/select";
const SELECTION_TITLE = "Choose a Bybit AI Subaccount";
const WAITING_TITLE = "Waiting for Bybit authorization";
const MAX_PASTED_CODE_LENGTH = 512;
const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "referrer-policy": "same-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const;

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

function isCode(code: unknown, expected: number): boolean {
  return code === expected || code === String(expected);
}

function apiFailureMessage(code: unknown, operation: string): string {
  if (isCode(code, TWO_FACTOR_REQUIRED_CODE)) {
    return "Please bind 2FA before proceeding.";
  }
  if (isCode(code, 401) || isCode(code, 10001)) {
    return "Bybit authorization failed. Run the Agent Connect flow again.";
  }
  return `Bybit ${operation} failed.`;
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
    throw new AgentConnectError(
      "api-failed",
      apiFailureMessage(code, operation),
    );
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

type BrowserSelectionState =
  | Readonly<{ kind: "unavailable" | "loading" }>
  | Readonly<{
      kind: "open";
      choices: readonly AgentConnectChoice[];
      resolve: (choiceId: string) => void;
      reject: (error: AgentConnectError) => void;
      timer: ReturnType<typeof setTimeout>;
    }>
  | Readonly<{ kind: "finished"; message: string }>;

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) => `&#${character.charCodeAt(0)};`,
  );
}

function htmlResponse(
  response: ServerResponse,
  status: number,
  title: string,
  body: string,
  refresh = false,
): void {
  response.writeHead(status, HTML_HEADERS);
  response.end(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
      (refresh
        ? `<meta http-equiv="refresh" content="${SELECTION_REFRESH_SECONDS}">`
        : "") +
      `<title>${escapeHtml(title)}</title></head>` +
      `<body><h1>${escapeHtml(title)}</h1>${body}</body></html>`,
  );
}

function selectionForm(
  choices: readonly AgentConnectChoice[],
  secret: string,
  error?: string,
): string {
  // No option is preselected: the operator must choose explicitly.
  const options = choices
    .map(
      (choice) =>
        `<p><label><input type="radio" name="choice" value="${escapeHtml(choice.id)}" required> ${escapeHtml(choice.label)}</label></p>`,
    )
    .join("");
  return (
    (error ? `<p role="alert">${escapeHtml(error)}</p>` : "") +
    `<form method="post" action="${SELECTION_PATH}">` +
    `<input type="hidden" name="s" value="${escapeHtml(secret)}">${options}` +
    `<p><button type="submit" name="action" value="choose">Continue</button> ` +
    `<button type="submit" name="action" value="cancel" formnovalidate>Cancel</button></p>` +
    `</form>`
  );
}

function codeForm(secret: string, error?: string): string {
  return (
    `<p>Finish authorization in the Bybit tab, then reload this page to see the AI Subaccount options.</p>` +
    `<p>If the Bybit page shows an authorization code instead, paste it here.</p>` +
    (error ? `<p role="alert">${escapeHtml(error)}</p>` : "") +
    `<form method="post" action="${SELECTION_PATH}">` +
    `<input type="hidden" name="s" value="${escapeHtml(secret)}">` +
    `<p><label>Authorization code <input type="text" name="code" required maxlength="${MAX_PASTED_CODE_LENGTH}" autocomplete="off" spellcheck="false"></label></p>` +
    `<p><button type="submit" name="action" value="code">Continue</button></p>` +
    `</form>`
  );
}

function pastedCode(value: string | null): string | null {
  const code = value?.trim() ?? "";
  return code.length > 0 &&
    code.length <= MAX_PASTED_CODE_LENGTH &&
    /^[\x21-\x7e]+$/.test(code)
    ? code
    : null;
}

function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    const contentType = request.headers["content-type"] ?? "";
    if (
      !contentType.toLowerCase().startsWith("application/x-www-form-urlencoded")
    ) {
      request.resume();
      reject(new Error("unsupported form encoding"));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_SELECTION_FORM_BYTES) chunks.push(chunk);
    });
    request.once("end", () => {
      if (size > MAX_SELECTION_FORM_BYTES) {
        reject(new Error("form too large"));
        return;
      }
      resolve(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
    });
    request.once("error", () => reject(new Error("form read failed")));
  });
}

function sameSecret(expected: string, actual: string | null): boolean {
  if (actual === null) return false;
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return (
    expectedBytes.length === actualBytes.length &&
    timingSafeEqual(expectedBytes, actualBytes)
  );
}

function diagnosticText(value: string, limit = 64): string {
  return value.replace(/[^\x20-\x7e]/g, "?").slice(0, limit);
}

function headerValue(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined ? null : diagnosticText(first, 256);
}

function originOf(value: string | null): string | null {
  if (value === null || value === "null") return value;
  try {
    return diagnosticText(new URL(value).origin);
  } catch {
    return "invalid";
  }
}

function requestEvent(
  request: IncomingMessage,
  path: string,
  outcome: AgentConnectRequestEvent["outcome"],
  callback: AgentConnectRequestEvent["callback"],
): AgentConnectRequestEvent {
  const sanitized = (name: string): string | null => {
    const value = headerValue(request, name);
    return value === null ? null : diagnosticText(value);
  };
  return {
    method: diagnosticText(request.method ?? "UNKNOWN", 16),
    path: diagnosticText(path),
    fetchSite: sanitized("sec-fetch-site"),
    fetchMode: sanitized("sec-fetch-mode"),
    fetchDest: sanitized("sec-fetch-dest"),
    origin: originOf(headerValue(request, "origin")),
    privateNetworkPreflight:
      headerValue(request, "access-control-request-private-network") === "true",
    callback,
    outcome,
  };
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

  const selectionTimeoutMs = Math.min(
    Math.max(options.selectionTimeoutMs ?? DEFAULT_SELECTION_TIMEOUT_MS, 1),
    MAX_SELECTION_TIMEOUT_MS,
  );
  const browserSelection = options.browserSelection === true;

  const state = createState();
  const verifier = createVerifier();
  const selectionSecret = randomBytes(32).toString("base64url");
  let selection: BrowserSelectionState = { kind: "unavailable" };
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
  // Completes the pending authorization with a code from the loopback
  // callback or pasted by the operator; PKCE binds either to this session.
  const settleCallback = (
    code: string,
    source: "loopback" | "pasted",
  ): void => {
    settled = true;
    if (timeout) clearTimeout(timeout);
    if (browserSelection) {
      // Keep the loopback server open for the selection page.
      selection = { kind: "loading" };
    } else {
      setImmediate(() => closeServer(activeServer));
    }
    resolveCallback({ code, codeVerifier: verifier, source });
  };
  const succeed = (code: string, response: ServerResponse): void => {
    if (settled) {
      callbackResponse(response, 409, "Authorization already processed.");
      return;
    }
    settleCallback(code, "loopback");
    if (browserSelection) {
      response.writeHead(303, {
        location: `${SELECTION_PATH}?s=${selectionSecret}`,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      });
      response.end();
    } else {
      callbackResponse(
        response,
        200,
        "Authorization successful. Return to the terminal to choose an AI Subaccount.",
      );
    }
  };

  const settleSelection = (
    message: string,
    outcome:
      Readonly<{ choiceId: string }> | Readonly<{ error: AgentConnectError }>,
  ): void => {
    if (selection.kind !== "open") return;
    const open = selection;
    clearTimeout(open.timer);
    selection = { kind: "finished", message };
    if ("choiceId" in outcome) {
      open.resolve(outcome.choiceId);
    } else {
      open.reject(outcome.error);
    }
  };
  const renderSelection = (response: ServerResponse): void => {
    if (selection.kind === "open") {
      htmlResponse(
        response,
        200,
        SELECTION_TITLE,
        selectionForm(selection.choices, selectionSecret),
      );
      return;
    }
    if (selection.kind === "finished") {
      htmlResponse(
        response,
        200,
        "Bybit Agent Connect",
        `<p>${escapeHtml(selection.message)}</p>`,
      );
      return;
    }
    if (selection.kind === "unavailable") {
      htmlResponse(response, 200, WAITING_TITLE, codeForm(selectionSecret));
      return;
    }
    htmlResponse(
      response,
      200,
      "Loading Bybit AI Subaccounts",
      "<p>Authorization received. Loading AI Subaccount options…</p>",
      true,
    );
  };
  const submitCode = (
    form: URLSearchParams,
    response: ServerResponse,
  ): void => {
    // A pasted code is accepted only while the authorization is pending.
    if (settled) {
      renderSelection(response);
      return;
    }
    const code = pastedCode(form.get("code"));
    if (code === null) {
      htmlResponse(
        response,
        400,
        WAITING_TITLE,
        codeForm(
          selectionSecret,
          "Paste the authorization code exactly as the Bybit page shows it.",
        ),
      );
      return;
    }
    settleCallback(code, "pasted");
    renderSelection(response);
  };
  const submitSelection = (
    form: URLSearchParams,
    response: ServerResponse,
  ): void => {
    if (form.get("action") === "code") {
      submitCode(form, response);
      return;
    }
    if (selection.kind !== "open") {
      renderSelection(response);
      return;
    }
    const open = selection;
    const action = form.get("action");
    if (action === "cancel") {
      settleSelection(
        "Selection cancelled. No AI Subaccount was selected or created; you can close this page.",
        {
          error: new AgentConnectError(
            "selection-cancelled",
            `AI Subaccount selection was cancelled; no account was selected or created. Run ${connectCommand(environment)} again.`,
          ),
        },
      );
      renderSelection(response);
      return;
    }
    const choiceId = form.get("choice");
    if (
      action !== "choose" ||
      choiceId === null ||
      !open.choices.some(({ id }) => id === choiceId)
    ) {
      htmlResponse(
        response,
        400,
        SELECTION_TITLE,
        selectionForm(
          open.choices,
          selectionSecret,
          "Choose one of the listed options.",
        ),
      );
      return;
    }
    settleSelection(
      "Selection received. Return to the terminal or agent to finish connecting; you can close this page.",
      { choiceId },
    );
    renderSelection(response);
  };
  const handleSelectionRequest = (
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): void => {
    // The page exists only with browser selection and only for this loopback
    // origin; any other Host header indicates DNS rebinding.
    if (
      !browserSelection ||
      request.headers.host !== `127.0.0.1:${selectedPort}`
    ) {
      callbackResponse(response, 404, "Not found.");
      return;
    }
    if (request.method === "GET") {
      if (!sameSecret(selectionSecret, url.searchParams.get("s"))) {
        callbackResponse(response, 404, "Not found.");
        return;
      }
      renderSelection(response);
      return;
    }
    if (request.method !== "POST") {
      callbackResponse(response, 405, "Method not allowed.");
      return;
    }
    readForm(request).then(
      (form) => {
        if (
          request.headers.origin !== `http://127.0.0.1:${selectedPort}` ||
          !sameSecret(selectionSecret, form.get("s"))
        ) {
          callbackResponse(response, 403, "Selection rejected.");
          return;
        }
        submitSelection(form, response);
      },
      () => callbackResponse(response, 400, "Selection rejected."),
    );
  };

  // Every request outside the selection page is reported as sanitized
  // metadata, so a missing or unusual callback delivery leaves evidence.
  let loopbackRequests = 0;
  const report = (
    request: IncomingMessage,
    path: string,
    outcome: AgentConnectRequestEvent["outcome"],
    callbackCheck: AgentConnectRequestEvent["callback"] = null,
  ): void => {
    loopbackRequests += 1;
    options.onRequest?.(requestEvent(request, path, outcome, callbackCheck));
  };

  const handleRequest = (
    request: IncomingMessage,
    response: ServerResponse,
  ): void => {
    let url: URL;
    try {
      url = new URL(request.url ?? "", "http://127.0.0.1");
    } catch {
      if (settled) {
        report(request, "(malformed)", "already-processed");
        callbackResponse(response, 409, "Authorization already processed.");
        return;
      }
      report(request, "(malformed)", "rejected");
      callbackResponse(response, 400, "Authorization failed.");
      fail(
        new AgentConnectError(
          "callback-invalid",
          "OAuth callback was malformed.",
        ),
      );
      return;
    }
    if (url.pathname === SELECTION_PATH) {
      handleSelectionRequest(request, response, url);
      return;
    }
    if (settled) {
      report(request, url.pathname, "already-processed");
      callbackResponse(response, 409, "Authorization already processed.");
      return;
    }
    if (url.pathname !== "/callback") {
      report(request, url.pathname, "not-found");
      callbackResponse(response, 404, "Not found.");
      return;
    }
    const returnedState = url.searchParams.get("state");
    const returnedError = url.searchParams.get("error");
    const returnedCode = url.searchParams.get("code");
    const callbackCheck = Object.freeze({
      stateMatches: returnedState === state,
      codePresent: Boolean(returnedCode),
      errorPresent: returnedError !== null,
    });
    if (
      !callbackCheck.stateMatches ||
      callbackCheck.errorPresent ||
      !returnedCode
    ) {
      report(request, url.pathname, "rejected", callbackCheck);
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
      report(request, url.pathname, "accepted", callbackCheck);
      succeed(code, response);
    } catch (error) {
      report(request, url.pathname, "rejected", callbackCheck);
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
      new AgentConnectError(
        "timeout",
        loopbackRequests === 0
          ? `Bybit OAuth authorization timed out; no request reached the callback server on 127.0.0.1:${selectedPort}.`
          : `Bybit OAuth authorization timed out; ${loopbackRequests} request(s) reached 127.0.0.1:${selectedPort}, but none was a valid OAuth callback.`,
      ),
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
    ...(browserSelection
      ? {
          selectionUrl: `http://127.0.0.1:${selectedPort}${SELECTION_PATH}?s=${selectionSecret}`,
        }
      : {}),
    waitForCallback: () => callback,
    submitAuthorizationCode: (value) => {
      if (settled) return "closed";
      const code = pastedCode(value);
      if (code === null) return "invalid";
      settleCallback(code, "pasted");
      return "accepted";
    },
    chooseInBrowser: (choices) => {
      if (selection.kind !== "loading") {
        return Promise.reject(
          new AgentConnectError(
            "selection-unavailable",
            browserSelection
              ? "Browser AI Subaccount selection is not available for this session."
              : "Browser AI Subaccount selection was not enabled for this session.",
          ),
        );
      }
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          settleSelection(
            "Selection timed out. No AI Subaccount was selected or created.",
            {
              error: new AgentConnectError(
                "selection-timeout",
                `AI Subaccount selection timed out; no account was selected or created. Run ${connectCommand(environment)} again.`,
              ),
            },
          );
        }, selectionTimeoutMs);
        selection = {
          kind: "open",
          choices: Object.freeze([...choices]),
          resolve,
          reject,
          timer,
        };
      });
    },
    close: () => {
      settleSelection(
        "This Agent Connect session has ended. Return to the terminal or agent.",
        {
          error: new AgentConnectError(
            "selection-cancelled",
            `Agent Connect session closed before an AI Subaccount was selected; no account was selected or created. Run ${connectCommand(environment)} again.`,
          ),
        },
      );
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
  const envelope = asObject(result);
  const records =
    envelope && "accounts" in envelope ? envelope.accounts : result;
  // A credential response must identify one account, never an arbitrary first
  // entry from an ambiguous list. Identity is checked by the caller below.
  const value = Array.isArray(records)
    ? records.length === 1
      ? records[0]
      : null
    : envelope && "accounts" in envelope
      ? null
      : records;
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
