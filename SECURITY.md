# Security

## Exchange credentials

- Use a dedicated subaccount for production canaries.
- Grant trading and read permissions only; withdrawal permission is forbidden.
- Use an IP allowlist where the account and deployment support it.
- Keep Testnet, Demo and mainnet keys separate; Demo keys belong to the Bybit
  Demo Trading environment and are never reused as Testnet or mainnet keys.
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

## Bybit probe manual recovery

When a Testnet capability probe records `UNRESOLVED`, do not delete its intent
or change the original verdict. Run the Testnet-only, read-only recovery
command for the saved run:

`npm run probe:bybit:recover -- --environment testnet <saved-run-id>`

The Testnet alias remains available:

`npm run probe:bybit:testnet:recover -- <saved-run-id>`

The command displays the saved run, account hash, symbol and client order ID,
then revalidates realtime and history orders, executions, open orders and
position through read-only Testnet endpoints. When those checks prove clean, it stores
`RECOVERED_CLEAN` with a timestamp, sanitized evidence and the `SECURITY.md`
reference; the original `UNRESOLVED` result remains unverified. Any owned
order or exposure is routed through the normal exact-plan, durable-intent and
reconciliation path automatically. If ownership or clean state remains
ambiguous, the command stops and directs the operator to the exchange UI
fallback for the concrete unresolved decision instead of declaring the run
clean.

Demo runs do not use this recovery command. The next Demo probe invocation
automatically retries reconciliation in the Demo environment; if it still
cannot prove clean state, stop and use the exchange UI fallback. Never move a
Demo run into the Testnet recovery flow or retry an ambiguous write blindly.
