---
name: CI DB-backed tests need schema + guardrail migrations first
description: Why api-server tests fail in GitHub CI with "permission denied" and how the quality-gate must be ordered.
---

# CI order for DB-backed tests

**Rule:** In the CI quality-gate, `db push` AND `db migrate` (guardrail migrations) must both run **before** the api-server unit tests.

**Why:** The api-server suite includes route tests that execute inside the RLS
contexts, which `SET LOCAL ROLE meridian_app`. That role's table grants and the
RLS policies come from the versioned guardrail migrations — not from
`drizzle-kit push`. On a fresh CI Postgres with only a schema push, those tests
fail with `permission denied for table ...` (locally they pass because the dev
DB already has the migrations applied). Note: Postgres roles are cluster-wide —
a fresh *database* in an existing cluster still has the role but no grants.

**How to apply:** Keep the "Prepare database (schema + guardrail migrations)"
step before "api-server unit tests" in `.github/workflows/ci.yml`. Any new
DB-backed test suite has the same requirement.

# Test process hang (fixed)

`node --test` / `tsx --test` never exits once a suite opens a pg Pool that is
not closed — locally it looks like a stall after all tests pass; in CI it hangs
the step until the job timeout. Fixed by adding `--test-force-exit` to the
api-server test script (exit code still reflects failures). If a future suite
opens long-lived handles, prefer the same flag over per-suite pool teardown.
