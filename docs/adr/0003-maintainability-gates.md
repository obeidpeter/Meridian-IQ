# ADR 0003: Maintainability Gates

- Status: Accepted
- Date: 2026-09-04

## Context

The monorepo had six relative-import cycles, no executable layer rule, no
tracked-secret check, and only ad hoc size/complexity measurements. A global
format gate would touch nearly two thousand legacy files and obscure behavior
changes.

## Decision

CI runs zero-cycle and high-risk dependency-boundary checks plus a conservative
tracked-secret scan. Reporting commands expose source size, exact duplication,
and complexity. Existing formatting debt is documented and new work follows
local style; global formatting is deferred to isolated mechanical changes.

## Consequences

Structural regressions fail before tests. Secret scanning is deliberately
high-confidence and complements, rather than replaces, repository-host scanning
and credential rotation. Complexity and duplication initially report debt
without blocking delivery; ratcheted thresholds can follow once ownership and
baselines are stable.
