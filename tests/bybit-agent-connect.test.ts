import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createServer as createNetServer,
  type Server as NetServer,
} from "node:net";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import test from "node:test";

import {
  agentConnectEndpoints,
  buildAuthorizationUrl,
  createBybitAgentConnectClient,
  defaultAgentConnectTransport,
  startAgentConnectSession,
} from "../src/adapters/bybit-agent-connect.js";
import {
  AgentConnectError,
  type AgentConnectRequestEvent,
  type AgentConnectTransport,
} from "../src/ports/agent-connect.js";

function listen(server: NetServer, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    const onListening = () => {
      cleanup();
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        reject(new Error("test server address unavailable"));
        return;
      }
      resolve(address.port);
    };
    const onError = (error: Error) => {
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

test("authorization URL binds the environment, loopback port, PKCE, and state", () => {
  const verifier = "verifier-value";
  const url = new URL(
    buildAuthorizationUrl("mainnet", 9876, "state-value", verifier),
  );

  assert.equal(
    url.origin,
    new URL(agentConnectEndpoints.mainnet.authorizationUrl).origin,
  );
  assert.equal(
    url.pathname,
    new URL(agentConnectEndpoints.mainnet.authorizationUrl).pathname,
  );
  assert.equal(url.searchParams.get("client_id"), "ai-agent");
  assert.equal(url.searchParams.get("scope"), "ai-account");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("state"), "state-value");
  assert.equal(
    url.searchParams.get("redirect_uri"),
    "http://127.0.0.1:9876/callback",
  );
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(
    url.searchParams.get("code_challenge"),
    createHash("sha256").update(verifier).digest("base64url"),
  );
});

test("callback session uses the actual fallback port and accepts one valid callback", async () => {
  const occupied = createNetServer();
  const occupiedPort = await listen(occupied);
  const session = await startAgentConnectSession("testnet", {
    startPort: occupiedPort,
    maxPort: occupiedPort + 1,
    timeoutMs: 1_000,
  });
  try {
    assert.notEqual(session.port, occupiedPort);
    const authorization = new URL(session.authorizationUrl);
    assert.equal(
      authorization.searchParams.get("redirect_uri"),
      `http://127.0.0.1:${session.port}/callback`,
    );

    const callbackPromise = session.waitForCallback();
    const callbackUrl = new URL(
      authorization.searchParams.get("redirect_uri") ?? "",
    );
    callbackUrl.searchParams.set("code", "auth-code");
    callbackUrl.searchParams.set(
      "state",
      authorization.searchParams.get("state") ?? "",
    );
    const response = await fetch(callbackUrl);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Return to the terminal/);
    const callback = await callbackPromise;
    assert.equal(callback.code, "auth-code");
    assert.match(callback.codeVerifier, /^[A-Za-z0-9_-]{43}$/);
  } finally {
    session.close();
    occupied.close();
  }
});

test("wrong-state callback fails closed", async () => {
  const session = await startAgentConnectSession("testnet", {
    startPort: 0,
    maxPort: 0,
    timeoutMs: 1_000,
  });
  try {
    const callbackUrl = new URL(session.authorizationUrl);
    callbackUrl.pathname = "/callback";
    callbackUrl.searchParams.set("code", "auth-code");
    callbackUrl.searchParams.set("state", "wrong-state");
    const callbackExpectation = assert.rejects(
      session.waitForCallback(),
      (error: unknown) => {
        assert.ok(error instanceof AgentConnectError);
        assert.equal((error as AgentConnectError).code, "callback-invalid");
        return true;
      },
    );
    const response = await fetch(
      `http://127.0.0.1:${session.port}${callbackUrl.pathname}${callbackUrl.search}`,
    );
    assert.equal(response.status, 400);
    await callbackExpectation;
  } finally {
    session.close();
  }
});

test("callback timeout is bounded and typed", async () => {
  const session = await startAgentConnectSession("mainnet", {
    startPort: 0,
    maxPort: 0,
    timeoutMs: 10,
  });
  try {
    await assert.rejects(session.waitForCallback(), (error: unknown) => {
      assert.ok(error instanceof AgentConnectError);
      assert.equal((error as AgentConnectError).code, "timeout");
      assert.match((error as Error).message, /timed out/);
      return true;
    });
  } finally {
    session.close();
  }
});

interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function rawRequest(
  port: number,
  {
    method = "GET",
    path,
    headers = {},
    body,
  }: {
    method?: string;
    path: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: "127.0.0.1", port, method, path, headers },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          text += chunk;
        });
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: text,
          }),
        );
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

async function authorizedBrowserSession(
  selectionTimeoutMs?: number,
  onRequest?: (event: AgentConnectRequestEvent) => void,
) {
  const session = await startAgentConnectSession("testnet", {
    startPort: 0,
    maxPort: 0,
    timeoutMs: 1_000,
    browserSelection: true,
    ...(selectionTimeoutMs === undefined ? {} : { selectionTimeoutMs }),
    ...(onRequest === undefined ? {} : { onRequest }),
  });
  const state =
    new URL(session.authorizationUrl).searchParams.get("state") ?? "";
  const callbackPromise = session.waitForCallback();
  const callback = await rawRequest(session.port, {
    path: `/callback?${new URLSearchParams({ code: "auth-code", state })}`,
  });
  await callbackPromise;
  const location = callback.headers.location ?? "";
  const secret =
    new URL(location, "http://127.0.0.1").searchParams.get("s") ?? "";
  return { session, callback, location, secret };
}

function postSelection(
  port: number,
  fields: Record<string, string>,
  headers: Record<string, string> = { origin: `http://127.0.0.1:${port}` },
): Promise<RawResponse> {
  return rawRequest(port, {
    method: "POST",
    path: "/select",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body: new URLSearchParams(fields).toString(),
  });
}

test("callback server reports each request as sanitized metadata without query values", async () => {
  const reported: AgentConnectRequestEvent[] = [];
  const session = await startAgentConnectSession("testnet", {
    startPort: 0,
    maxPort: 0,
    timeoutMs: 1_000,
    onRequest: (event) => reported.push(event),
  });
  try {
    const state =
      new URL(session.authorizationUrl).searchParams.get("state") ?? "";
    const callbackPromise = session.waitForCallback();
    await rawRequest(session.port, {
      method: "OPTIONS",
      path: "/probe?private=value",
      headers: { "access-control-request-private-network": "true" },
    });
    await rawRequest(session.port, {
      path: `/callback?${new URLSearchParams({ code: "private-auth-code", state })}`,
      headers: {
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document",
        origin: "https://testnet.bybit.com/oauth?private=value",
      },
    });
    await callbackPromise;

    assert.deepEqual(reported, [
      {
        method: "OPTIONS",
        path: "/probe",
        fetchSite: null,
        fetchMode: null,
        fetchDest: null,
        origin: null,
        privateNetworkPreflight: true,
        callback: null,
        outcome: "not-found",
      },
      {
        method: "GET",
        path: "/callback",
        fetchSite: "cross-site",
        fetchMode: "navigate",
        fetchDest: "document",
        origin: "https://testnet.bybit.com",
        privateNetworkPreflight: false,
        callback: {
          stateMatches: true,
          codePresent: true,
          errorPresent: false,
        },
        outcome: "accepted",
      },
    ]);
    assert.doesNotMatch(
      JSON.stringify(reported),
      new RegExp(`private-auth-code|private=value|${state}`),
    );
  } finally {
    session.close();
  }
});

test("callback timeout states whether any request reached the loopback server", async () => {
  const silent = await startAgentConnectSession("testnet", {
    startPort: 0,
    maxPort: 0,
    timeoutMs: 50,
  });
  try {
    await assert.rejects(silent.waitForCallback(), (error: unknown) => {
      assert.ok(error instanceof AgentConnectError);
      assert.equal(error.code, "timeout");
      assert.match(
        error.message,
        new RegExp(
          `no request reached the callback server on 127\\.0\\.0\\.1:${silent.port}`,
        ),
      );
      return true;
    });
  } finally {
    silent.close();
  }

  const probed = await startAgentConnectSession("testnet", {
    startPort: 0,
    maxPort: 0,
    timeoutMs: 300,
  });
  const probedCallback = assert.rejects(
    probed.waitForCallback(),
    (error: unknown) => {
      assert.ok(error instanceof AgentConnectError);
      assert.equal(error.code, "timeout");
      assert.match(error.message, /1 request\(s\) reached/);
      assert.match(error.message, /none was a valid OAuth callback/);
      return true;
    },
  );
  try {
    await rawRequest(probed.port, { path: "/favicon.ico" });
    await probedCallback;
  } finally {
    probed.close();
  }
});

test("browser selection continues the authorized session only after an explicit choice", async () => {
  const reported: AgentConnectRequestEvent[] = [];
  const { session, callback, location, secret } =
    await authorizedBrowserSession(undefined, (event) => reported.push(event));
  try {
    assert.equal(callback.status, 303);
    assert.equal(
      session.selectionUrl,
      `http://127.0.0.1:${session.port}${location}`,
    );
    assert.match(location, /^\/select\?s=[A-Za-z0-9_-]{43}$/);

    const loading = await rawRequest(session.port, { path: location });
    assert.equal(loading.status, 200);
    assert.match(loading.body, /http-equiv="refresh"/);

    const choice = session.chooseInBrowser([
      { id: "1", label: "<b>Trading</b> (•••3456)" },
      { id: "2", label: "Create a new AI Subaccount" },
    ]);
    const form = await rawRequest(session.port, { path: location });
    assert.equal(form.status, 200);
    assert.match(form.body, /&#60;b&#62;Trading&#60;\/b&#62;/);
    assert.doesNotMatch(form.body, /<b>|checked/);
    assert.equal(
      form.headers["content-security-policy"],
      "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    assert.equal(form.headers["cache-control"], "no-store");
    assert.equal(form.headers["x-frame-options"], "DENY");

    const submitted = await postSelection(session.port, {
      s: secret,
      action: "choose",
      choice: "2",
    });
    assert.equal(submitted.status, 200);
    assert.match(submitted.body, /Selection received/);
    assert.equal(await choice, "2");
    assert.deepEqual(
      reported.map(({ path }) => path),
      ["/callback"],
    );
  } finally {
    session.close();
  }
});

test("browser selection rejects cross-origin, unauthenticated, rebinding, and unlisted submissions", async () => {
  const { session, location, secret } = await authorizedBrowserSession();
  try {
    const choice = session.chooseInBrowser([{ id: "1", label: "Trading" }]);
    let choiceSettled = false;
    void choice.then(
      () => {
        choiceSettled = true;
      },
      () => {
        choiceSettled = true;
      },
    );
    const origin = `http://127.0.0.1:${session.port}`;
    const valid = { s: secret, action: "choose", choice: "1" };

    assert.equal(
      (
        await postSelection(session.port, valid, {
          origin: "http://evil.example",
        })
      ).status,
      403,
    );
    assert.equal((await postSelection(session.port, valid, {})).status, 403);
    assert.equal(
      (await postSelection(session.port, { ...valid, s: "wrong" })).status,
      403,
    );
    assert.equal(
      (
        await postSelection(session.port, valid, {
          origin,
          host: "rebind.example",
        })
      ).status,
      404,
    );
    assert.equal(
      (await rawRequest(session.port, { path: "/select?s=wrong" })).status,
      404,
    );
    assert.equal(
      (
        await rawRequest(session.port, {
          path: location,
          headers: { host: "rebind.example" },
        })
      ).status,
      404,
    );
    const unlisted = await postSelection(session.port, {
      ...valid,
      choice: "2",
    });
    assert.equal(unlisted.status, 400);
    assert.match(unlisted.body, /Choose one of the listed options/);
    assert.equal(choiceSettled, false);

    const cancelled = await postSelection(session.port, {
      s: secret,
      action: "cancel",
    });
    assert.match(cancelled.body, /Selection cancelled/);
    await assert.rejects(choice, (error: unknown) => {
      assert.ok(error instanceof AgentConnectError);
      assert.equal(error.code, "selection-cancelled");
      assert.match(error.message, /no account was selected or created/);
      assert.match(error.message, /credentials:connect:testnet/);
      return true;
    });
  } finally {
    session.close();
  }
});

test("browser selection wait is bounded and typed", async () => {
  const { session } = await authorizedBrowserSession(10);
  try {
    await assert.rejects(
      session.chooseInBrowser([{ id: "1", label: "Trading" }]),
      (error: unknown) => {
        assert.ok(error instanceof AgentConnectError);
        assert.equal(error.code, "selection-timeout");
        assert.match(error.message, /timed out/);
        return true;
      },
    );
  } finally {
    session.close();
  }
});

test("closing the session cancels a pending browser selection", async () => {
  const { session } = await authorizedBrowserSession();
  const choice = session.chooseInBrowser([{ id: "1", label: "Trading" }]);
  session.close();

  await assert.rejects(choice, (error: unknown) => {
    assert.ok(error instanceof AgentConnectError);
    assert.equal(error.code, "selection-cancelled");
    return true;
  });
});

test("browser selection is unavailable unless enabled and never precedes authorization", async () => {
  const session = await startAgentConnectSession("testnet", {
    startPort: 0,
    maxPort: 0,
    timeoutMs: 1_000,
  });
  const callback = session.waitForCallback().catch(() => undefined);
  try {
    assert.equal(session.selectionUrl, undefined);
    assert.equal(
      (await rawRequest(session.port, { path: "/select?s=anything" })).status,
      404,
    );
    await assert.rejects(
      session.chooseInBrowser([{ id: "1", label: "Trading" }]),
      (error: unknown) => {
        assert.ok(error instanceof AgentConnectError);
        assert.equal(error.code, "selection-unavailable");
        return true;
      },
    );
  } finally {
    session.close();
    await callback;
  }
});

test("OAuth client exchanges only the code verifier contract and never persists token data", async () => {
  const calls: Array<{
    kind: "post" | "get";
    url: string;
    body?: string;
    token?: string;
  }> = [];
  const transport: AgentConnectTransport = {
    async postForm(url, body) {
      calls.push({ kind: "post", url, body: body.toString() });
      return { retCode: 0, result: { access_token: "access-token" } };
    },
    async get(url, accessToken) {
      calls.push({ kind: "get", url, token: accessToken });
      return {
        retCode: 0,
        result: {
          accounts: [{ sub_member_id: 123, nickname: "Trading" }],
        },
      };
    },
  };
  const client = createBybitAgentConnectClient({ transport });

  const accessToken = await client.exchangeCode("testnet", {
    code: "one-time-code",
    codeVerifier: "verifier",
  });
  const accounts = await client.listAccounts("testnet", accessToken);

  assert.equal(accessToken, "access-token");
  assert.deepEqual(accounts, [{ accountId: "123", displayName: "Trading" }]);
  assert.equal(calls[0]?.kind, "post");
  assert.match(calls[0]?.url ?? "", /api2-testnet\.bybit\.com/);
  assert.match(calls[0]?.body ?? "", /client_id=ai-agent/);
  assert.match(calls[0]?.body ?? "", /code=one-time-code/);
  assert.match(calls[0]?.body ?? "", /code_verifier=verifier/);
  assert.equal(calls[0]?.body?.includes("refresh"), false);
  assert.equal(calls[1]?.token, "access-token");
});

test("selected and create account requests are explicit and normalize credentials", async () => {
  const urls: string[] = [];
  const transport: AgentConnectTransport = {
    async postForm() {
      return { retCode: 0, result: { access_token: "token" } };
    },
    async get(url) {
      urls.push(url);
      return {
        retCode: 0,
        result: {
          api_key: "api-key",
          api_secret: "api-secret",
          sub_member_id: 456,
        },
      };
    },
  };
  const client = createBybitAgentConnectClient({ transport });

  assert.deepEqual(
    await client.fetchAccountCredentials("mainnet", "token", {
      kind: "existing",
      accountId: "456",
    }),
    { apiKey: "api-key", apiSecret: "api-secret", accountId: "456" },
  );
  assert.deepEqual(
    await client.fetchAccountCredentials("mainnet", "token", {
      kind: "create",
      existingAccountIds: ["123"],
    }),
    { apiKey: "api-key", apiSecret: "api-secret", accountId: "456" },
  );
  assert.equal(new URL(urls[0] ?? "").searchParams.get("sub_member_id"), "456");
  assert.equal(new URL(urls[1] ?? "").searchParams.get("is_create"), "true");
});

test("create account credentials must not resolve to a listed account", async () => {
  const client = createBybitAgentConnectClient({
    transport: {
      async postForm() {
        return {};
      },
      async get() {
        return {
          retCode: 0,
          result: {
            api_key: "api-key",
            api_secret: "api-secret",
            sub_member_id: "existing-account",
          },
        };
      },
    },
  });

  await assert.rejects(
    client.fetchAccountCredentials("testnet", "token", {
      kind: "create",
      existingAccountIds: ["existing-account"],
    }),
    (error: unknown) => {
      assert.ok(error instanceof AgentConnectError);
      assert.equal((error as AgentConnectError).code, "invalid-response");
      assert.match((error as Error).message, /existing AI Subaccount/);
      return true;
    },
  );
});

test("HTTP errors are classified before parsing an invalid body", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("not-json", { status: 502 })) as typeof fetch;
  try {
    await assert.rejects(
      defaultAgentConnectTransport.get(
        "https://api2-testnet.bybit.com/oauth/v1/resource/restrict/ai_accounts",
        "token",
      ),
      (error: unknown) => {
        assert.ok(error instanceof AgentConnectError);
        assert.equal((error as AgentConnectError).code, "api-failed");
        assert.match((error as Error).message, /HTTP 502/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OAuth API and response failures are safe and typed", async () => {
  const transport: AgentConnectTransport = {
    async postForm() {
      return {
        retCode: 10001,
        retMsg: "raw token or server detail",
      };
    },
    async get() {
      return { ret_code: 20039, ret_msg: "private response detail" };
    },
  };
  const client = createBybitAgentConnectClient({ transport });

  await assert.rejects(
    client.exchangeCode("mainnet", {
      code: "code",
      codeVerifier: "verifier",
    }),
    (error: unknown) => {
      assert.ok(error instanceof AgentConnectError);
      assert.equal((error as AgentConnectError).code, "api-failed");
      assert.equal(
        (error as Error).message,
        "Bybit authorization failed. Run the Agent Connect flow again.",
      );
      assert.doesNotMatch((error as Error).message, /raw token|server detail/);
      return true;
    },
  );
  await assert.rejects(
    client.listAccounts("mainnet", "token"),
    (error: unknown) => {
      assert.ok(error instanceof AgentConnectError);
      assert.equal((error as AgentConnectError).code, "api-failed");
      assert.equal(
        (error as Error).message,
        "Please bind 2FA before proceeding.",
      );
      assert.doesNotMatch((error as Error).message, /private response detail/);
      return true;
    },
  );
});

test("API error messages do not expose untrusted response codes", async () => {
  const client = createBybitAgentConnectClient({
    transport: {
      async postForm() {
        return { retCode: "token-like-private-value" };
      },
      async get() {
        return {};
      },
    },
  });

  await assert.rejects(
    client.exchangeCode("mainnet", {
      code: "code",
      codeVerifier: "verifier",
    }),
    (error: unknown) => {
      assert.ok(error instanceof AgentConnectError);
      assert.equal((error as AgentConnectError).code, "api-failed");
      assert.match((error as Error).message, /token exchange failed/);
      assert.doesNotMatch((error as Error).message, /token-like-private-value/);
      return true;
    },
  );
});

test("malformed response codes fail closed", async () => {
  const client = createBybitAgentConnectClient({
    transport: {
      async postForm() {
        return {
          retCode: { unexpected: true },
          result: { access_token: "token" },
        };
      },
      async get() {
        return {};
      },
    },
  });

  await assert.rejects(
    client.exchangeCode("testnet", {
      code: "code",
      codeVerifier: "verifier",
    }),
    (error: unknown) => {
      assert.ok(error instanceof AgentConnectError);
      assert.equal((error as AgentConnectError).code, "invalid-response");
      assert.match((error as Error).message, /invalid response code/);
      return true;
    },
  );
});

test("invalid account credential response fails before it can reach Keychain", async () => {
  const transport: AgentConnectTransport = {
    async postForm() {
      return {};
    },
    async get() {
      return { result: { api_key: "only-key" } };
    },
  };
  const client = createBybitAgentConnectClient({ transport });

  await assert.rejects(
    client.fetchAccountCredentials("testnet", "token", {
      kind: "existing",
      accountId: "123",
    }),
    (error: unknown) => {
      assert.ok(error instanceof AgentConnectError);
      assert.equal((error as AgentConnectError).code, "invalid-response");
      assert.doesNotMatch((error as Error).message, /only-key/);
      return true;
    },
  );
});

test("selected account credential response must match the requested account", async () => {
  const client = createBybitAgentConnectClient({
    transport: {
      async postForm() {
        return {};
      },
      async get() {
        return {
          retCode: 0,
          result: {
            api_key: "api-key",
            api_secret: "api-secret",
            sub_member_id: "different-account",
          },
        };
      },
    },
  });

  await assert.rejects(
    client.fetchAccountCredentials("testnet", "token", {
      kind: "existing",
      accountId: "selected-account",
    }),
    (error: unknown) => {
      assert.ok(error instanceof AgentConnectError);
      assert.equal((error as AgentConnectError).code, "invalid-response");
      assert.match((error as Error).message, /different AI Subaccount/);
      return true;
    },
  );
});
