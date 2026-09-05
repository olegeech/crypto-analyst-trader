---
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
date: 2026-09-05
plan_type: feat
deepened: 2026-09-05
---

# feat: Load Bybit credentials from macOS Keychain

## Goal Capsule

**Objective:** Local authenticated Bybit commands can be configured and run without plaintext credential files or recurring shell-history secrets, while Testnet and mainnet credentials remain unambiguously separated.

**Means:** Add a small credential-provider port, a macOS Keychain generic-password adapter, and explicit setup/remove CLI commands that future authenticated probes can consume.

**Authority hierarchy:** Issue #49 defines product scope and acceptance criteria; `docs/architecture/invariants.md` and `SECURITY.md` are mandatory safety constraints; the TypeScript provider boundary owns validated credential access; the macOS adapter owns `security` process details; the CLI owns prompts and command selection.

**Stop conditions:** Missing, inaccessible, malformed, or environment-mismatched credentials fail closed before authenticated exchange access. Mainnet storage does not grant execution authority. No credential value, signature, signed header, or raw authenticated response may enter output or persistence.

**Execution profile:** Implement as one focused PR against issue #49. Keep the provider usable by #7 without implementing #7's exchange probe in this change.

---

## Product Contract

### Summary

Issue #49 establishes the local credential contract before authenticated Testnet exchange work becomes routine. Operators get a recommended interactive setup path and a documented manual Keychain Access fallback; authenticated commands receive only the explicitly selected environment's credentials at runtime.

### Problem Frame

The repository currently has only a public read-only Testnet smoke path and no credential-access boundary. Adding credentials directly to future scripts would encourage `.env` files, shell-history exposure, and accidental Testnet/mainnet mixing. The missing contract blocks the authenticated capability spike in #7.

### Requirements

- **R1 — Deterministic entries:** Testnet and mainnet each use stable, distinct macOS Keychain generic-password service and account identifiers for API key, API secret, and account/subaccount identifier.
- **R2 — Setup:** `credentials:setup:testnet` and `credentials:setup:mainnet` interactively collect the three values and update only the selected environment's Keychain entries without writing plaintext files or placing secret values in process arguments or shell history.
- **R3 — Runtime loading:** An authenticated command explicitly selects `testnet` or `mainnet` and receives that environment's three credentials silently from the provider. Missing or inaccessible entries fail with an actionable error naming the matching setup command.
- **R4 — Isolation:** Lookup and removal never fall back between environments. A Testnet request cannot consume mainnet entries, and a mainnet request cannot consume Testnet entries.
- **R5 — Removal:** `credentials:remove:testnet` and `credentials:remove:mainnet` remove only the selected environment's entries and are safe to repeat when an entry is already absent.
- **R6 — Redaction and CI safety:** Credential values remain in process memory only as needed; setup output, errors, logs, persisted artifacts, and default CI never expose API secrets, signatures, signed headers, or raw authentication responses. `.env.example` remains placeholder-only and no plaintext credential file is required.
- **R7 — Future probe seam:** #7 can use the provider with an explicit Testnet selection without `.env`, manual credential injection on every run, or changes to the default credential-free CI path. This story does not implement the #7 exchange probe.

### Key Decisions

- **PD1 — CLI setup is the default UX:** Provide interactive setup plus manual Keychain Access instructions; no automatic credential creation from another command. Governs R2, R5.
- **PD2 — Silent reads after setup:** Normal authenticated commands read existing entries without a prompt on every invocation; setup remains the only routine interactive flow. Governs R3.
- **PD3 — Explicit environment identity:** Testnet and mainnet names are part of every provider operation, with no implicit fallback. Governs R1, R3, R4, R5.
- **PD4 — Three separate values:** Store API key, API secret, and account/subaccount identifier as separate generic-password items rather than a serialized credential bundle. This limits lookup scope and makes manual setup/removal precise. Governs R1, R2, R5.
- **PD5 — Minimal provider boundary:** Introduce a provider abstraction only at the credential access seam so #7 and later authenticated commands do not depend on `/usr/bin/security`. Governs R3, R7.
- **PD6 — macOS-only concrete provider:** macOS Keychain is the only required implementation now; non-macOS execution fails with a clear unsupported-provider error rather than falling back to environment variables. Governs R3, R6, R7.

### Actors

- Product owner/operator: configures or removes local credentials and chooses the environment for an authenticated command.
- Credential CLI: validates command selection and prompts without printing secret values.
- Authenticated command such as #7: requests credentials through the provider with an explicit environment.
- macOS Keychain: stores and returns generic-password data through the system `security` command.
- CI/default release path: remains unable to require or reach credentialed exchange behavior.

### Acceptance Examples

- **AE1 — Separate setup:** When Testnet setup completes, the three Testnet entries exist under the Testnet service identity; the corresponding mainnet entries are neither created nor changed.
- **AE2 — Missing entry:** When a selected environment has no API secret, loading fails before an exchange request and reports the selected setup command without exposing any credential value.
- **AE3 — No cross-environment fallback:** When only mainnet entries exist, a Testnet load fails as missing Testnet credentials instead of returning mainnet values.
- **AE4 — Targeted removal:** When both environments exist, removing Testnet deletes exactly its three entries and a subsequent mainnet load still returns the mainnet values.
- **AE5 — Credential-free verification:** A fresh clone can run the default release suite without macOS Keychain entries, interactive prompts, or exchange credentials.
- **AE6 — Future consumer:** An authenticated Testnet consumer can request a provider-backed credential set with explicit Testnet identity; no `.env` read is needed.

### Scope Boundaries

In scope are the credential contract, deterministic naming, macOS Keychain adapter, setup/remove commands, manual setup documentation, provider tests, and the future-consumer seam required by #7.

### Deferred to Follow-Up Work

- Implement the authenticated Bybit capability probe in #7.
- Add a production exchange adapter or signed request implementation.
- Add credential rotation scheduling, status/diagnostic commands, cloud secret managers, or cross-platform vault implementations.
- Decide whether a future packaged application needs data-protection-keychain entitlements or user-presence access controls; the current CLI uses the user's normal macOS Keychain context.

### Sources

- GitHub issue [#49 — Load exchange credentials from macOS Keychain for local runs](https://github.com/olegeech/crypto-analyst-trader/issues/49)
- GitHub issue [#7 — Validate Bybit daily-order capabilities on Testnet](https://github.com/olegeech/crypto-analyst-trader/issues/7)
- `docs/architecture/invariants.md`, especially invariants 14–16 and 17
- `SECURITY.md`
- [Apple Keychain Services](https://developer.apple.com/documentation/security/keychain-services) and [generic password item identity](https://developer.apple.com/documentation/security/ksecclassgenericpassword)
- [Apple TN3137: On Mac keychain APIs and implementations](https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains)
- `security(1)` local macOS manual: `add-generic-password`, `find-generic-password`, `delete-generic-password`; the manual recommends prompting for password data rather than passing it as an argument
- [Node.js `child_process.execFile`](https://nodejs.org/api/child_process.html#child_processexecfilefile-args-options-callback), which runs a file directly without a shell by default

---

## Planning Contract

### Key Technical Decisions

- **KTD1 — Generic password records with deterministic composite identity:** Use the generic-password class with service `com.olegeech.crypto-analyst-trader.bybit.testnet` or `com.olegeech.crypto-analyst-trader.bybit.mainnet`, and field-specific accounts `api-key`, `api-secret`, and `account-id`. Apple documents service and account as the identity dimensions for these items, which gives exact lookup and deletion without scanning unrelated entries.
- **KTD2 — Direct process boundary:** Invoke `/usr/bin/security` through a direct child-process API with argument arrays and no shell. Pass secret input through the child process's stdin/prompt path, never as an argument; capture secret output only for immediate return and never log it.
- **KTD3 — Explicit environment at the port:** The public provider operation takes a validated environment enum rather than deriving environment from optional credentials or fallback variables. The service map is private to the adapter and has no cross-environment fallback branch.
- **KTD4 — Error normalization:** Map missing item, locked/unavailable Keychain, unsupported platform, malformed output, and command failure to safe typed errors. Public messages include the selected environment and setup command, but exclude child-process stderr and all returned data.
- **KTD5 — Injectable runner for deterministic tests:** The adapter accepts a narrow runner seam so tests can verify exact `security` arguments, stdin separation, output parsing, and failure mapping without touching the developer's real Keychain. The production runner remains the only place that spawns `/usr/bin/security`.
- **KTD6 — No credential integration into public smoke:** The existing read-only `scripts/testnet-smoke.ts` remains credential-free. #7's future authenticated probe will consume the provider seam explicitly; changing the public smoke command now would create accidental credential or network scope.
- **KTD7 — CLI lifecycle is deliberately small:** Support only `setup <environment>` and `remove <environment>` command families, exposed as the four issue-required npm scripts. Setup overwrites the selected entries idempotently; remove treats already-missing entries as success.
- **KTD8 — Partial setup fails closed:** Because separate Keychain items cannot be updated transactionally, validate all three inputs before the first write and, if a selected-environment write fails, do not report success and remove the selected set before returning the error. This prevents a later command from consuming a mixed old/new credential set; the operator can rerun setup with the complete set.

### High-Level Technical Design

The following flow is authoritative for component ownership and failure direction:

```mermaid
flowchart LR
  setup[Setup/remove CLI\nexplicit environment] --> service[Credential service\nvalidate fields and redact output]
  consumer[Future authenticated command\nexplicit environment] --> port[CredentialProvider port]
  service --> port
  port --> adapter[macOS Keychain adapter\nservice/account map]
  adapter --> runner[Direct security(1) runner\nargs + stdin, no shell]
  runner --> keychain[(User Keychain\ngeneric password items)]
  adapter -->|missing, locked, unsupported| fail[Typed actionable error\nno secret data]
  ci[Default CI/release] -. remains credential-free .-> port
```

The three stored fields share an environment-specific service but have distinct accounts. Every read or delete supplies both dimensions. Setup and remove are the only interactive command paths; runtime loading is silent and explicit. The adapter must fail before any future authenticated request when the selected set is incomplete.

### Assumptions

- The first supported runtime is a signed-in macOS user process with access to the user's default Keychain, matching Apple's CLI-tool user-context guidance.
- Bybit API keys, API secrets, and account/subaccount identifiers are accepted as non-empty single-line values. Control characters are rejected so prompt/pipe boundaries cannot alter the stored record.
- The default Keychain selected by `security` is sufficient for this CLI; custom keychain selection and application entitlements are deferred.
- Test fixtures use synthetic values and an injected runner. No test creates or reads a real user credential entry.

### Dependencies and Sequencing

The provider contract and naming map precede the adapter. The adapter precedes CLI wiring and the future-consumer seam. Documentation and contract tests are completed with the behavior so the setup procedure and safety boundary ship together.

### System-Wide Impact

The change creates a credential boundary used by future Bybit-authenticated commands and changes the documented local setup path. It must not alter the public read-only Testnet smoke, default CI, planner authority, approval gates, mainnet execution policy, or durable execution journal. The provider returns sensitive values only to its immediate caller; callers remain responsible for avoiding logs and persistence.

### Risks & Mitigations

- **Secret exposure through process arguments or shell expansion:** Keep values out of `security` arguments and shell commands; use direct child-process invocation and stdin/prompt input. Test recorded arguments for absence of synthetic secrets.
- **Cross-environment credential confusion:** Make environment selection mandatory and map each environment to a distinct service. Test missing Testnet with populated mainnet and targeted removal.
- **Keychain/CLI output leakage:** Never forward raw stderr or `find -w` output to logs. Normalize errors and test that synthetic secrets do not appear in public error/output strings.
- **macOS-only behavior breaking CI:** Guard the concrete adapter by platform and keep all CI tests on injected runners. Default release tests must not invoke the provider or require Keychain entries.
- **Interactive input behavior differing across terminals:** Keep prompt/input handling behind a testable CLI boundary and verify on macOS with synthetic entries during implementation; do not claim Linux CI proves interactive Keychain behavior.

### Deferred Implementation Questions

- Confirm whether the `security -w` prompt accepts piped stdin consistently in the supported macOS versions. If not, use the least-exposing direct process input mechanism available without putting secrets in argv or shell history.
- Confirm the exact non-zero statuses emitted for missing versus locked items and map them without exposing raw diagnostics. The public error contract remains stable regardless of those status values.

---

## Output Structure

```text
src/
  ports/credential-provider.ts
  adapters/macos-keychain.ts
scripts/
  credentials.ts
tests/
  credential-contract.test.ts
  macos-keychain.test.ts
  credentials-cli.test.ts
  credentials-integration-contract.test.ts
docs/
  credentials.md
```

The implementer may consolidate a test file when that preserves the unit's coverage, but the provider, adapter, CLI, and documentation boundaries remain distinct.

---

## Implementation Units

### U1. Define the credential port and environment identity

**Goal:** Establish the typed credential contract and deterministic Testnet/mainnet field identity that all callers use.

**Requirements:** R1, R3, R4, R7; PD3–PD5; KTD1 and KTD3.

**Dependencies:** None.

**Files:** `src/ports/credential-provider.ts`; `tests/credential-contract.test.ts`.

**Approach:**

- Define the explicit environment and credential value concepts without importing macOS or child-process details into the port.
- Represent the provider operations needed by setup, runtime load, and targeted removal.
- Keep the environment-to-field identity deterministic and test-visible through stable exported constants or a pure identity helper, while keeping secrets out of fixtures except synthetic values.

**Patterns to follow:** Exchange-neutral ports in `docs/architecture/system-design.md`; strict validated boundaries from invariant 17; exact string values used by `src/index.ts`.

**Test scenarios:**

- Testnet and mainnet are the only accepted environment values; an unknown value is rejected before provider access.
- The credential contract requires non-empty API key, API secret, and account/subaccount identifier values.
- The two environments produce distinct service identities and identical field identities within their own environment.
- A future consumer can request a provider contract with explicit Testnet identity without importing the concrete macOS adapter.

**Verification:** The port compiles under strict TypeScript and the contract tests prove explicit environment selection and distinct identities.

---

### U2. Implement the macOS Keychain adapter

**Goal:** Store, load, and remove selected-environment credentials through macOS Keychain generic-password records with safe process and error boundaries.

**Requirements:** R1, R3, R4, R5, R6; PD3–PD6; KTD1–KTD5 and KTD8.

**Dependencies:** U1.

**Files:** `src/adapters/macos-keychain.ts`; `tests/macos-keychain.test.ts`.

**Approach:**

- Reject unsupported platforms before spawning a process and expose a typed unsupported-provider failure.
- Use `/usr/bin/security` with direct argument arrays for add/update, find, and delete operations. Never pass secret values in argv or through a shell.
- Use the deterministic service/account map for every operation; do not query broadly or try the other environment after a miss.
- Normalize command failure and output parsing into actionable, redacted provider errors. Remove all three selected fields independently and treat an absent selected item as idempotent success.
- Keep the runner injectable so all unit tests use synthetic command results and never touch the real Keychain.

**Execution note:** Implement adapter tests before changing the production runner; then perform a macOS-only smoke with synthetic credentials and remove them immediately after verification.

**Patterns to follow:** `scripts/testnet-smoke.ts`'s explicit configuration validation and import-safe CLI entry; `docs/architecture/system-design.md`'s raw-adapter containment; Apple generic-password service/account identity.

**Test scenarios:**

- Setup for Testnet emits three add/update operations with the Testnet service and field-specific accounts, while no argument contains any synthetic secret.
- Setup for mainnet uses a different service from Testnet and never invokes a Testnet fallback.
- Loading a complete selected environment returns exactly the three values from the runner's secret-only output.
- Loading with a missing API key, secret, or account identifier fails before a caller can submit an exchange request and names the matching setup command.
- Loading when the runner reports a locked or inaccessible Keychain returns a redacted actionable error without forwarding raw stderr.
- Removing Testnet emits only Testnet delete selectors and succeeds when one or more selected records are already absent; mainnet selectors are untouched.
- Runner failures, malformed output, and non-macOS execution fail closed without exposing synthetic values.
- A failure while writing one of the three selected-environment records leaves no usable partial set and returns a redacted retryable error.

**Verification:** Strict typecheck, lint, and adapter contract tests pass; a macOS smoke confirms real Keychain add/find/delete with synthetic values and confirms no leftover entries.

---

### U3. Add setup/remove CLI commands and npm entry points

**Goal:** Give operators a minimal interactive setup/remove workflow with explicit environment selection and no plaintext credential file path.

**Requirements:** R2, R3, R4, R5, R6; PD1–PD4 and PD7; KTD2, KTD4, KTD7, KTD8.

**Dependencies:** U1, U2.

**Files:** `scripts/credentials.ts`; `package.json`; `tests/credentials-cli.test.ts`.

**Approach:**

- Accept only `setup` or `remove` plus `testnet` or `mainnet`; reject missing, extra, or unknown arguments before any Keychain operation.
- Setup validates all three values before the first write, prompts for API key, API secret, and account/subaccount identifier using hidden/single-line input handling appropriate for a macOS terminal, and passes values to the adapter through memory and the direct runner input path only.
- Print only environment and operation status. Public errors name the corrective setup command but never include values or raw child output.
- If a selected-environment write fails after setup begins, clear that selected set, report failure, and require the operator to rerun setup; do not leave a mixed credential set that a later command could use.
- Wire the four required npm scripts to the same CLI entry with explicit environment arguments; do not add a status or rotate command.

**Patterns to follow:** Import-safe `scripts/testnet-smoke.ts`; existing npm command naming; error-first CLI behavior and invariant 15's explicit mainnet configuration.

**Test scenarios:**

- `credentials:setup:testnet` stores all three synthetic values through the Testnet provider and emits no secret value.
- `credentials:setup:mainnet` uses only mainnet identity and does not read or modify Testnet entries.
- Each remove command targets only its selected environment and reports success when the selected entries are already absent.
- Invalid command or environment arguments exit non-zero before prompting or spawning the Keychain command.
- Prompt/provider failure produces a concise actionable message without secret input, child stderr, or raw response content.
- A partial write failure removes the selected environment's records and reports setup failure without exposing values; the other environment remains untouched.
- Importing the CLI module does not execute prompts or Keychain commands; execution occurs only through the script entry path.

**Verification:** The four npm entry points are present, CLI tests pass with injected prompts/provider, and no CLI test requires a real Keychain or network access.

---

### U4. Integrate the future-consumer seam and document operations

**Goal:** Make the provider discoverable for #7 and give operators accurate manual Keychain Access instructions and safety boundaries.

**Requirements:** R2, R3, R6, R7; PD1, PD2, PD5, PD6; KTD6.

**Dependencies:** U1, U2, U3.

**Files:** `docs/credentials.md`; `README.md`; `SECURITY.md`; `tests/credentials-integration-contract.test.ts`.

**Approach:**

- Document the four commands, the exact environment distinction, the three generic-password records per environment, and manual Keychain Access creation/removal using the same service/account identifiers.
- State that normal authenticated commands must select an environment explicitly and load through the provider; `.env` is not a required or fallback source for credentials.
- Link the credential guide from the repository's existing development/safety entry points without duplicating the issue body or creating a second backlog.
- Preserve the current public read-only Testnet smoke and default CI contract; add a contract test that credential setup is opt-in and the future-consumer seam is explicit.

**Patterns to follow:** `README.md`'s concise product boundary and safety links; `SECURITY.md`'s runtime containment language; `CONTRIBUTING.md`'s command-oriented contributor guidance.

**Test scenarios:**

- Documentation names the four setup/remove commands, both environments, all three stored fields, and the manual fallback without including real-looking secret values.
- Documentation states that missing credentials block the selected authenticated command and identify its setup command, with no cross-environment fallback.
- The existing read-only Testnet smoke remains usable without credential entries, and default CI contains no credentialed command or exchange write path.
- A future-consumer contract imports only the provider boundary and must pass explicit Testnet identity; it cannot silently read `.env` values.

**Verification:** Documentation links resolve within the repository, the credential integration contract passes, and existing credential-free smoke/CI contract tests remain green.

---

## Verification Contract

- `npm ci && npm run test:release` remains the blocking credential-free validation path.
- Unit and contract tests use injected Keychain runners and synthetic values only; they prove argument redaction, environment isolation, missing/locked/malformed failure, idempotent removal, CLI validation, and import safety.
- A macOS-only manual smoke creates synthetic Testnet and mainnet entries, loads each explicitly, verifies missing-entry and cross-environment behavior, removes each environment separately, and confirms no entries remain. This evidence belongs in the PR, never in committed artifacts.
- The existing public `npm run test:testnet` command remains read-only and opt-in. No credential setup, Keychain lookup, or authenticated exchange request is added to `npm run test:release` or default CI.
- Review checks must confirm no secret values, signatures, signed headers, raw auth responses, or plaintext credential files enter the diff, logs, documentation, or persisted test artifacts.

## Definition of Done

- [ ] R1–R7 are implemented or have explicit PR evidence explaining the non-applicable future-consumer boundary.
- [ ] Testnet/mainnet service and account identities are deterministic, distinct, and covered by tests.
- [ ] Setup, silent load, targeted remove, missing-entry, locked-Keychain, unsupported-platform, malformed-output, and cross-environment paths fail or succeed as specified.
- [ ] Secret values never appear in process arguments, shell history instructions, logs, error output, repository files, or test artifacts.
- [ ] The four npm commands and manual Keychain Access fallback are documented and usable on macOS.
- [ ] #7 can import the provider boundary for explicit Testnet credentials without `.env`; #7's exchange probe remains outside this PR.
- [ ] Default CI and release checks remain credential-free and cannot reach an exchange write endpoint.
- [ ] `npm ci && npm run test:release` passes and macOS synthetic Keychain smoke evidence is recorded in the PR.
- [ ] No abandoned implementation attempt, temporary credential file, or experimental provider remains in the diff.
