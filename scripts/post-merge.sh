#!/bin/bash
set -e
# Install merged dependencies. Prefer the lockfile, but fall back to a full
# resolve if a task branch changed package.json without an up-to-date lockfile
# (otherwise --frozen-lockfile fails and new packages are never installed).
pnpm install --frozen-lockfile || pnpm install
# Schema push AND guardrail migrations (role grants / RLS) — both are required
# before the API and its DB-backed tests can run.
pnpm --filter db push
pnpm --filter db migrate
