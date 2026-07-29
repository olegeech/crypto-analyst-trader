# ADR-0002: Direct Bybit V5 Exchange Adapter

Status: Accepted

Date: 2026-07-29

## Context

Critical order behavior includes exchange-specific batch results, attached
exits, client order identifiers, rate limits and reconciliation semantics.

## Decision

Implement a narrow typed Bybit V5 REST adapter behind exchange-neutral ports.
The write path uses only the endpoints required by approved daily execution.
Public or research libraries may not become authoritative for exchange-write
semantics.

## Invariants

- the domain sees normalized capabilities and outcomes;
- raw exchange response objects remain inside the adapter;
- Testnet is the default;
- missing mandatory capability blocks execution;
- signed request and response logging is sanitized.

## Consequences

The initial adapter is explicit and testable. A future exchange implements the
port and contract suite without weakening existing safety guarantees.

## Rejected alternatives

- spreading raw HTTP calls through application services;
- designing for the lowest common denominator of many exchanges before the
  first adapter is reliable.
