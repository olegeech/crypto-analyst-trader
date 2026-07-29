# Security

## Exchange credentials

- Use a dedicated subaccount for production canaries.
- Grant trading and read permissions only; withdrawal permission is forbidden.
- Use an IP allowlist where the account and deployment support it.
- Keep Testnet and mainnet keys separate.
- Load secrets at runtime from environment or an approved secret manager.
- Never persist API secrets, signatures, signed headers or raw authentication
  responses.

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
