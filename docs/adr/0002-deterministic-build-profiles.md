# ADR 0002: Deterministic Build Profiles

- Status: Accepted
- Date: 2026-09-04

## Context

Every Vite config threw when `PORT` or `BASE_PATH` was absent. The documented
root build therefore failed in a clean checkout. Recursive build also included
an Expo deployment build that requires hosting metadata.

## Decision

Each web app declares its canonical base path and a unique local port in code.
Validated environment values may override them. The root build covers the API
and five web bundles; the environment-bound mobile artifact has an explicit
`build:mobile` command.

## Consequences

CI and local builds use the same defaults and can still reproduce deployment
routing through overrides. Invalid paths/ports fail early. Mobile release work
remains visible rather than silently skipped, but no longer breaks unrelated
web/API validation.
