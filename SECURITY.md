# Security

## Exchange credentials

- Use a dedicated subaccount for production canaries.
- Grant trading and read permissions only; withdrawal permission is forbidden.
- Use an IP allowlist where the account and deployment support it.
- Keep Testnet and mainnet keys separate.
- Load secrets at runtime from environment or an approved secret manager such
  as the local macOS Keychain provider; authenticated local commands must not
  require plaintext values in shell history or repository files.
- Never persist API secrets, signatures, signed headers or raw authentication
  responses.

## Agent Connect onboarding

- Agent Connect uses an explicit environment, PKCE S256, an unpredictable
  state value, and a loopback callback bound only to `127.0.0.1`.
- The local flow requires a reversible non-secret Keychain preflight before
  OAuth and an explicit AI Subaccount selection or create choice.
- OAuth codes and tokens remain in memory for the onboarding operation only.
  The existing Keychain stores only the API key, API secret and account ID.
- The onboarding path requests no withdrawal or managed-transfer capability
  and never calls a trading, funding or transfer endpoint.
- Storing a mainnet credential before #31 is allowed for onboarding, but it
  does not enable project writes. The first mainnet write remains gated by #31
  and the canonical plan, risk, approval and reconciliation controls.
- If OAuth credentials expire, reconnect through Agent Connect. Do not persist
  refresh tokens in the repository or in a second local credential store.

## Reporting a vulnerability

Do not open a public issue containing credentials, account identifiers, private
trade data or exploit details. Contact the repository owner privately and
rotate any potentially exposed credential immediately.

## Runtime containment

A suspected execution or accounting incident requires:

1. persist `HALT`;
2. stop new entries;
3. reconcile account state through read endpoints;
4. cancel only known owned entry orders when required;
5. preserve protective exits;
6. use the exchange UI as the documented manual fallback.
