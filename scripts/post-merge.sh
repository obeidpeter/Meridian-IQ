#!/bin/bash
set -euo pipefail
# A stale lockfile is a release failure, never permission to resolve dependencies.
pnpm install --frozen-lockfile
# Reviewed additive SQL only. Never push inferred schema while traffic serves.
# A missing historical baseline fails closed; bootstrap it in planned maintenance
# with every writer drained, as documented in docs/runtime-evidence-r198.md.
pnpm --filter @workspace/db run migrate
