# Local Bybit credentials

Authenticated local commands load Bybit credentials from the macOS Keychain.
The repository does not provide a plaintext-file fallback, and the default CI
path remains credential-free.

## Recommended setup

Run the environment-specific command in an interactive macOS Terminal:

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
