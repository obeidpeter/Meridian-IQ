# ADR 0001: Central Request Policy

- Status: Accepted
- Date: 2026-09-04

## Context

Transaction exemptions lived in `app.ts` while model-capacity classifications
lived in `rate-limit.ts`. Both lists represented the same request boundary and
had drifted previously. Security depended on comments and source-text tests.

## Decision

`middleware/request-policy.ts` owns bypass roles, no-context paths/routes, and
model-rate-limited routes. It exposes pure matchers consumed by app middleware
and direct unit tests. Existing lockstep posture tests remain as independent
checks for every explicit exception.

## Consequences

Policy review has one source of truth and exact method/path semantics are
testable without booting Express. New no-context entries still require proof
that the handler re-establishes atomicity and tenant posture in short scopes.
The list remains security-sensitive and must not become a generic escape hatch.
