# ADR-0006: Managed Entries Require Take-Profit, Stop-Loss Optional

Status: Accepted

Date: 2026-09-21

Supersedes the managed-entry protection rule in ADR-0003. ADR-0003 remains
historical for its daily-only execution and reconciliation decisions.

## Context

The original MVP rule required every managed entry to carry both a take-profit
and a catastrophic stop-loss. The product owner chose a TP-minimum policy for
the current execution boundary: averaging strategies may deliberately remain
open without an automatic stop-loss, while leverage and future grid/exposure
limits remain separate strategy decisions. A generic adapter must not invent a
stop policy or turn a transport-verification order into a managed entry.

## Decision

`requiresProtection: true` continues to identify a managed entry in the
existing canonical artifact. An open managed intent must include at least one
positive, exchange-native take-profit in the same create request. A stop-loss
may be included when the explicitly approved strategy policy supplies one, but
it is optional and is never injected by the generic planner or adapter.

Close and reduce-only cleanup intents remain exempt from entry protection and
must not carry attached exits. The bounded Demo fill verification uses an
explicitly unmanaged intent and does not prove the managed protection
lifecycle.

## Consequences

- TP-only managed entries are valid; TP+SL entries remain valid.
- Missing protection, empty protection and stop-only managed entries block with
  `PROTECTION_REQUIRED`.
- The adapter preserves the exact supplied TP/SL values and does not synthesize
  either value.
- The future market-adaptive averaging grid, 1x exposure policy, and broader
  account-level limits remain separate work and are not implied by this ADR.
