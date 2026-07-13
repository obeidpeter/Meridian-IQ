#!/bin/bash
set -e
# Install merged dependencies. Prefer the lockfile, but fall back to a full
# resolve if a task branch changed package.json without an up-to-date lockfile
# (otherwise --frozen-lockfile fails and new packages are never installed).
pnpm install --frozen-lockfile || pnpm install
# Schema push AND guardrail migrations (role grants / RLS) — both are required
# before the API and its DB-backed tests can run.
# push-force: stdin is closed during post-merge, so a plain push that prompts
# (e.g. for a potentially destructive change) gets EOF and fails, leaving new
# columns unapplied AND skipping the workflow restarts that rebuild api-server.
pnpm --filter db push-force
pnpm --filter db migrate
