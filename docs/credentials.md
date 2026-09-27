# Local Bybit credentials

Authenticated local commands load Bybit credentials from the macOS Keychain.
The repository does not provide a plaintext-file fallback, and the default CI
path remains credential-free.

## Bybit Agent Connect (preferred)

Use Agent Connect as the preferred quick start when Bybit should authorize an
isolated AI Subaccount without manual API-key creation:

```bash
npm run credentials:connect:testnet
npm run credentials:connect:mainnet
```

Choose the environment in the command before starting. The command first
performs a reversible non-secret Keychain preflight, then prints a Bybit OAuth
link with a loopback callback. Open the link and authorize the requested
`ai-account` scope. The callback is accepted once and expires after a bounded
wait.

Bybit Demo Trading does not support this Agent Connect flow. There is
intentionally no `credentials:connect:demo` command; use the isolated manual
Demo setup below instead.

If Bybit requires two-factor authentication, the command stops with a fixed
instruction to bind 2FA before proceeding; bind it and run the connect command
again.

After authorization, the command lists AI Subaccounts and waits for an
explicit selection. It never selects or creates an account automatically, even
when only one option exists. Before the Keychain preflight, the command states
which selection channel it will use:

- In an interactive terminal, enter the option number at the terminal prompt.
- Without interactive terminal input, for example from an agent shell with
  piped stdin, the command prints a link to a local page on the same
  `127.0.0.1` callback port once the options are loaded; open it in the
  browser used for authorization. When the callback arrives as a visible
  navigation, the authorization tab is also redirected there. The page lists
  the options with masked account IDs; choose one there or cancel. The page accepts only same-origin submissions
  carrying a one-time session secret, is never cached, and exists only while
  the command runs.

Selection waits at most five minutes. A timeout, a cancellation (**Cancel** on
the page, or Ctrl-C/Ctrl-D at the terminal prompt) or unavailable input ends the
command before any account credentials are requested, reports that no account
was selected or created, and leaves existing Keychain records unchanged.

If the Bybit page shows an authorization code instead of finishing, the command
accepts that code while it is still waiting for the callback, within the same
deadline. Paste it at the terminal prompt or, without terminal input, into the
local page whose link the command prints right after the authorization URL.
Bybit exchanges the code only together with this session's PKCE verifier, so a
code from any other authorization request is rejected. Ctrl-C or Ctrl-D at the
code prompt cancels the authorization.

While waiting, the command prints one `Loopback request:` line for every
request that reaches the callback server: method, path without query, the
browser's `Sec-Fetch-*` values, the request origin, whether it is a
private-network preflight, and whether the callback state matched and a code
was present. It never prints the code, the state or other query values. If
authorization times out, the message says whether any request reached the
callback server at all. Include these lines when reporting a callback that did
not arrive.

If you choose create, Bybit performs the account provisioning inside its
authorized Agent Connect flow. The prompt follows Bybit's documented maximum
of five AI Subaccounts; at that limit it offers selection only. The endpoint
and parameter contract follows Bybit's [Agent Connect OAuth module](https://raw.githubusercontent.com/bybit-exchange/skills/main/modules/oauth.md).

The command keeps OAuth codes and tokens in memory only. It imports only the
API key, API secret and `sub_member_id` into the selected environment's
existing Keychain records. The `sub_member_id` is the existing `account-id`
value; no fourth credential record or second credential store is created. If
credentials expire, run the connect command again instead of persisting a
refresh token.

Agent Connect does not grant project write authority. Withdrawals and managed
transfers are not requested by this onboarding path. Configure an IP allowlist
on Bybit when supported before the separate #31 mainnet canary decision.

The connect commands are intentionally excluded from default CI and release
execution. Release tests use injected OAuth, callback and Keychain fixtures;
they never contact Bybit or modify a real Keychain.

## Manual API credential fallback

If Agent Connect is unavailable or you need to enter existing API credentials,
use this manual fallback in an interactive macOS Terminal:

```bash
npm run credentials:setup:testnet
npm run credentials:setup:demo
npm run credentials:setup:mainnet
```

Each command asks for the API key, API secret and account/subaccount ID. For
Demo, create the key after switching the main Bybit account to Demo Trading;
the Demo UID is used only for ownership hashing. All three inputs are hidden
because the account identifier is sensitive operational metadata. Setup is
repeatable and updates only the selected environment's records.

Testnet, Demo and mainnet use separate Keychain services and never fall back to
one another. Storing Demo or mainnet credentials does not enable exchange
execution; the environment, execution and approval gates remain separate.

Each underlying Keychain command has a bounded timeout. If a permission dialog
or locked Keychain blocks the command, setup fails closed instead of waiting
indefinitely; unlock or approve access and run the same setup or connect
command again.

Keychain commands run without the controlling terminal, so values always travel
over a private pipe and the terminal stays available for this CLI's own
prompts. A terminal prompt such as `password data for new item:` therefore
never belongs to a normal run; report it as a defect instead of typing a value.
Terminal interrupts end any in-flight Keychain command together with the CLI.

## Removal

Remove only the selected environment's records:

```bash
npm run credentials:remove:testnet
npm run credentials:remove:demo
npm run credentials:remove:mainnet
```

The first access from the CLI can show a macOS Keychain permission prompt. Use
the prompt's **Always Allow** choice for the CLI if you want later authenticated
reads to remain silent. Do not use the `-A` option to bypass access control;
the provider intentionally leaves it disabled. If Keychain access is
unavailable, unlock the login Keychain and retry. If a credential is missing,
the authenticated command reports the matching setup command; it does not
create credentials automatically.

## Manual Keychain Access fallback

When the CLI is unavailable, open **Keychain Access**, choose the login
keychain, and create three **generic password** items
for the selected service:

| Field                 | Testnet service                           | Demo service                           | Mainnet service                           | Account      |
| --------------------- | ----------------------------------------- | -------------------------------------- | ----------------------------------------- | ------------ |
| API key               | `com.crypto-analyst-trader.bybit.testnet` | `com.crypto-analyst-trader.bybit.demo` | `com.crypto-analyst-trader.bybit.mainnet` | `api-key`    |
| API secret            | same service                              | same service                           | same service                              | `api-secret` |
| Account/subaccount ID | same service                              | same service                           | same service                              | `account-id` |

The CLI uses the macOS `security` tool's generic-password records with the
service and account as the identity. Do not paste credentials into issue
comments, logs, shell commands, tracked files or screenshots. The upcoming
authenticated Bybit probe will use the typed provider boundary from the local
runtime and will not add an `.env` fallback.

## Coinalyze liquidation data key (#45)

The Coinalyze adapter uses a provider-neutral, read-only Keychain lookup. The
application sends the key only in the `api_key` HTTP header to the pinned
Coinalyze API origin and uses public GET endpoints; it never reuses or reads
Bybit credentials. The adapter does not persist the key.

To configure the key, open **Keychain Access** and create one **generic
password** item in the login keychain:

| Field    | Value                                          |
| -------- | ---------------------------------------------- |
| Service  | `com.crypto-analyst-trader.provider.coinalyze` |
| Account  | `api-key`                                      |
| Password | Coinalyze API key                              |

Do not place the key in a shell command, environment file, issue/PR comment,
log, screenshot, or repository file. The explicit smoke command is documented
in the operator runbook; it is opt-in and is not part of default tests, release
checks, or CI. Revoke or rotate the key in Coinalyze and replace the Keychain
item when needed. The adapter follows Coinalyze's documented
[`api_key` header and public endpoints](https://api.coinalyze.net/v1/doc/).
