# ADR-0001: Modular TypeScript Monolith

Status: Accepted

Date: 2026-07-29

## Context

The first product is a single-operator daily workflow. Distributed services
would add failure modes and operational cost before there is evidence they are
needed.

## Decision

Use Node.js 22, strict TypeScript and a modular monolith. Domain modules are pure
and depend on ports, never adapters. CLI commands are thin application entry
points.

## Invariants

- dependency direction is adapters -> application -> domain;
- exchange and storage response types do not leak into the domain;
- money and order values use exact decimal representations;
- every module can be tested without credentials.

## Consequences

Deployment, local development and transactional reasoning remain simple.
Module boundaries preserve a future extraction path if measured scale requires
it.

## Rejected alternatives

- microservices before the first production canary;
- a long-running web application as the primary execution surface.
