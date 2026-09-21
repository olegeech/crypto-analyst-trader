# Architecture Decision Records

Use an ADR only for a decision that is expensive to reverse or affects several
modules. Accepted ADRs are not silently rewritten; supersede them with a new
record. The current normative safety set lives in
[System Invariants](../architecture/invariants.md).

Current decisions:

- [ADR-0001: Modular TypeScript monolith](0001-modular-typescript-monolith.md)
- [ADR-0002: Direct Bybit V5 exchange adapter](0002-direct-bybit-v5-adapter.md)
- [ADR-0003: Daily-only execution with attached exits](0003-daily-only-attached-exits.md)
  (historical protection rule superseded by ADR-0006)
- [ADR-0004: SQLite execution and accounting journal](0004-sqlite-journal.md)
- [ADR-0005: Deterministic values and evidence boundaries](0005-deterministic-values-and-evidence-boundaries.md)
- [ADR-0006: Managed entries require take-profit, stop-loss optional](0006-managed-entry-take-profit.md)
