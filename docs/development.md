# Development

## Prerequisites

- Node.js 22 or 24
- pnpm 10 or 11
- PostgreSQL 16 plus pgvector
- Chromium only when running Playwright journeys

Install with the repository lockfile:

```bash
pnpm install --frozen-lockfile
cp .env.example .env
```

Use disposable databases for tests. Never point a local test command at a
production or shared staging database.

## Local Database

Set `DATABASE_URL`, then create tables and apply guardrail migrations:

```bash
pnpm --filter @workspace/db run push
pnpm --filter @workspace/db run migrate
```

`push` creates schema objects. `migrate` applies versioned RLS, trigger,
retention, and grant controls. Both are required.

## Build and Run

```bash
pnpm run build
pnpm --filter @workspace/api-server run dev
```

Each web app also runs independently using checked-in defaults:

```bash
pnpm --filter @workspace/landing run dev
pnpm --filter @workspace/console run dev
pnpm --filter @workspace/sme-compliance run dev
pnpm --filter @workspace/buyer-portal run dev
pnpm --filter @workspace/penalty-calculator run dev
```

Defaults are landing `3000`, console `3001`, SME `3002`, buyer `3003`, and
calculator `4200`. Replit workflows override `PORT` and `BASE_PATH`.

The mobile build depends on Expo deployment metadata and is intentionally not
part of the clean web/API build:

```bash
pnpm run build:mobile
```

CI additionally packages that native export, its server and reviewed production
configuration for immutable promotion with `node scripts/src/ops/mobile-artifact.mjs build`,
then checks the packaged server using the same script's `check` command. This
release package binds the production domain and is not a local development URL.

## Validation Levels

Fast, database-free validation:

```bash
pnpm run check
pnpm run build
```

Database-backed server and migration validation:

```bash
pnpm --filter @workspace/api-server run test
pnpm --filter @workspace/db run test
```

Use only a disposable database: the main-app HTTP integration and E2E failure
fixtures require `E2E_DATABASE_DISPOSABLE=1`. The credit suite uses the same
flag to retire (layer-3 revoke) any assessment population an earlier run left
behind — the bank Data Room aggregates the whole platform, so its k-anonymity
assertions start from an empty population — and fails fast on a reused
database without it (R108). The main-app test explicitly sets
`ENABLE_DEV_AUTH=true` before importing the server; production auth remains
unchanged. SQL trigger fault injection is always removed during teardown.

Disaster-recovery and browser validation:

```bash
DRILL_DATABASE_URL=postgresql://.../meridian_drill \
  pnpm --filter @workspace/scripts run ops:restore-drill
pnpm --filter @workspace/scripts run e2e
```

Database-free release, worker, CSRF and real axe-engine regressions:

```bash
pnpm --filter @workspace/scripts run test:reliability
pnpm --filter @workspace/scripts exec playwright install chromium
pnpm --filter @workspace/scripts run test:accessibility
```

The full suite is the merge authority. A local environment without PostgreSQL
can prove types, lint, deterministic units, architecture, secrets, and builds,
but cannot replace CI's tenant, migration, restore, or E2E checks.

## Contract Workflow

1. Edit `lib/api-spec/openapi.yaml` and bump `info.version`.
2. Run `pnpm --filter @workspace/api-spec run codegen`.
3. Review generated schema and client diffs.
4. Update route and app tests.
5. Confirm codegen produces no second diff.

## Debugging

Use structured logs and the request ID from response headers. Check
`/api/healthz` for build identity and `/api/readyz` for bootstrap state.
Operational endpoints require configured signed credentials in production.

See [Troubleshooting](troubleshooting.md) for common failures.
