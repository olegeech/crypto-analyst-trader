# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Credentials and Keychain

### Credential Environment

A named Bybit credential namespace for one execution context, kept separate from other environments so one set cannot silently be used in another.

### Credential Set

The complete API key, API secret, and account/subaccount identity required together for an authenticated Bybit call.

### Keychain Rollback

A best-effort restoration or cleanup process after a multi-record credential update fails. It restores a complete prior Credential Set when one exists; otherwise it removes the incomplete new set. An incomplete rollback is an explicit operational state that requires setup again.

### Keychain Access Approval

The macOS permission decision that allows the local credential tool to read or update protected records. An operator may grant a remembered approval for later silent reads; bypassing access control is not part of the project’s credential model.
