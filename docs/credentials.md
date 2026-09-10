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

If Bybit requires two-factor authentication, the command stops with a fixed
instruction to bind 2FA before proceeding; bind it and run the connect command
again.

After authorization, the command lists AI Subaccounts and waits for an
explicit selection. It never selects or creates an account automatically. If
you choose create, Bybit performs the account provisioning inside its
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
npm run credentials:setup:mainnet
```

Each command asks for the API key, API secret and account/subaccount ID. All
three inputs are hidden because the account identifier is sensitive operational
metadata. Setup is repeatable and updates only the selected environment's
records.

Testnet and mainnet use separate Keychain services and never fall back to one
another. Storing mainnet credentials does not enable mainnet execution; the
execution and approval gates remain separate.

## Removal

Remove only the selected environment's records:

```bash
npm run credentials:remove:testnet
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

| Field                 | Testnet service                           | Mainnet service                           | Account      |
| --------------------- | ----------------------------------------- | ----------------------------------------- | ------------ |
| API key               | `com.crypto-analyst-trader.bybit.testnet` | `com.crypto-analyst-trader.bybit.mainnet` | `api-key`    |
| API secret            | same service                              | same service                              | `api-secret` |
| Account/subaccount ID | same service                              | same service                              | `account-id` |

The CLI uses the macOS `security` tool's generic-password records with the
service and account as the identity. Do not paste credentials into issue
comments, logs, shell commands, tracked files or screenshots. The upcoming
authenticated Bybit probe will use the typed provider boundary from the local
runtime and will not add an `.env` fallback.
