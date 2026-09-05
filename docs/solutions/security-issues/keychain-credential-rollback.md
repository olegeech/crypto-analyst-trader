---
title: "Preserve credential integrity during Keychain updates"
date: 2026-09-05
category: security-issues
module: "macOS Keychain credential provider"
problem_type: security_issue
component: authentication
symptoms:
  - "A failed multi-record write could remove previously working credentials."
  - "A cleanup failure could replace the original write error with a misleading access error."
  - "Concurrent Keychain reads could trigger multiple access dialogs."
root_cause: data_integrity
resolution_type: code_fix
severity: high
related_components:
  - "credential CLI"
  - "repository safety CI"
tags:
  - macos-keychain
  - credential-rollback
  - partial-write
  - secret-handling
  - security
---

# Preserve credential integrity during Keychain updates

## Problem

The credential provider stores an authenticated Bybit environment as three
separate macOS Keychain records: API key, API secret, and account/subaccount
ID. Updating those records with `-U` is not atomic. If a later write failed,
the old implementation attempted cleanup and could both destroy a previously
working set and hide the original write failure.

## Symptoms

- A setup failure could leave the operator with no usable credentials even
  though a complete set existed before the update.
- If cleanup failed too, the operator could receive an access-related message
  instead of learning that storage failed.
- Three reads launched together could produce several simultaneous Keychain
  permission prompts.

## What Didn't Work

- Calling the public removal operation directly from the write-failure path
  treated every partial update as if there were no prior credentials. It also
  allowed a cleanup exception to replace the primary storage error. This was
  reproduced with a runner where the second write and cleanup both failed
  (session history).
- Classifying failures by matching English text in `stderr` was not stable
  across localized system messages. A localized “item not found” message with
  an unrelated exit status was incorrectly eligible for the missing-record
  path.
- Parallelizing all reads optimized latency at the cost of multiple possible
  Keychain dialogs and less predictable operator interaction.

## Solution

The provider now treats setup as a best-effort transaction over the complete
credential set:

1. Before writing, it reads the selected environment sequentially. A complete
   previous set is retained for restoration; an incomplete or absent set is
   treated as disposable setup state (`src/adapters/macos-keychain.ts:202`).
2. New records are written sequentially through stdin, keeping secrets out of
   argv (`src/adapters/macos-keychain.ts:185`).
3. On failure, the original write error is created first. A complete previous
   set is restored record by record; otherwise all selected records are
   deletion-attempted. Cleanup continues across all records so one failed
   cleanup does not prevent the others from running (`src/adapters/macos-keychain.ts:230`).
4. If restoration or cleanup is incomplete, the provider preserves the safe
   write-failure message and adds an explicit “Rollback incomplete” action to
   rerun setup (`src/adapters/macos-keychain.ts:296`). Raw command output is
   never included.
5. Loads are sequential and use stable `security` exit codes: 44 means a
   missing record and 36 means Keychain interaction is unavailable
   (`src/adapters/macos-keychain.ts:66`). The project-owned service namespace
   keeps testnet and mainnet records separate (`src/ports/credential-provider.ts:24`).
6. The CLI hides the account/subaccount ID as well as the key and secret, and
   the operator documentation records the first-access **Always Allow** flow
   without enabling `-A` (`scripts/credentials.ts:104`, `docs/credentials.md:34`).

## Why This Works

The Keychain command does not provide a multi-record commit. Snapshotting a
complete prior set gives the provider a known restore target before the first
`-U` overwrite. If no complete target exists, deleting every selected record
is the least ambiguous outcome for a new setup. Both paths are bounded and
redacted.

Most importantly, rollback is subordinate to the primary operation: rollback
is attempted and its incompleteness is reported, but it cannot replace the
fact that the requested write failed. The caller therefore receives an
actionable result in both the ordinary failure and degraded-rollback cases.

Stable exit-code handling avoids making localized human text part of the
provider contract. Serial reads preserve a single predictable permission
conversation, while the documented first approval allows later reads to be
silent without weakening access control.

## Prevention

- Test a later write failure with cleanup failure and assert that the result
  remains `write-failed`, says rollback is incomplete, and contains neither
  command stderr nor credential values (`tests/macos-keychain.test.ts:231`).
- Test that a complete old set is restored after a partial update
  (`tests/macos-keychain.test.ts:266`).
- Test that load calls never overlap and that localized stderr cannot override
  exit-code classification (`tests/macos-keychain.test.ts:118`).
- Keep all credential setup/removal commands out of default CI through the
  negative workflow contract (`tests/ci-contract.test.ts:77`).
- Keep service naming environment-specific and project-owned rather than
  embedding a personal account handle (`src/ports/credential-provider.ts:27`).
- Treat “no mixed usable set” as a verified outcome only when rollback reports
  complete; an incomplete rollback must remain visible and require setup to be
  rerun.

## Related Issues

- [Issue #49](https://github.com/olegeech/crypto-analyst-trader/issues/49) —
  original Keychain credential story.
- [PR #53](https://github.com/olegeech/crypto-analyst-trader/pull/53) —
  original implementation; this learning captures its post-merge review
  follow-up.
- [PR #54](https://github.com/olegeech/crypto-analyst-trader/pull/54) —
  follow-up hardening changes.
