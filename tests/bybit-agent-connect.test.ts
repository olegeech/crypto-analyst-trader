import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createServer as createNetServer,
  type Server as NetServer,
} from "node:net";
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
