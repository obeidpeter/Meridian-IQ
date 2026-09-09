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

`pnpm run check` includes the complexity ratchet (R122): every function whose
cyclomatic complexity exceeds the threshold in `complexity-baseline.json`
(20) must appear in that baseline at or under its recorded value, keyed by
file and by ESLint's label for the function rather than by line. A new
hotspot or a function that has grown fails `pnpm run complexity:check`; a
function that has come down is reported as an entry that can tighten, and
`pnpm run complexity:write` records the measured values as the new baseline,
so the ratchet moves down by hand and never up by accident. Accepting a
deliberate new hotspot is the same `write`, reviewed in the diff of the
baseline. `pnpm run complexity:report` is the unchanged advisory listing of
everything over 10.

Database-backed server and migration validation:

```bash
pnpm --filter @workspace/api-server run test
pnpm --filter @workspace/db run test
```

CI runs the api-server suite as `test:coverage` instead: the same tests under
Node's built-in V8 coverage (tsx's inline source maps carry it back to the
`.ts` sources), writing `artifacts/api-server/coverage/lcov.info` and
`summary.json`, then checking the per-area floors in
`artifacts/api-server/coverage-floors.json` (R118). The areas are auth,
tenancy, money, the Clerk gateway and the pipeline, each a list of path globs
with integer line and branch floors. A run below a floor fails; a run that
clears a floor by five points or more says so, and `test:coverage:write`
records the measured percentages (rounded down, less a two-point tolerance
for run-to-run variance) as the new floors, so the ratchet moves up by hand
and never down by accident. `test:coverage:check`
re-checks an existing lcov without re-running the suite.

The web packages run the same way (R121): `test:coverage` in `lib/web-ui`,
`artifacts/console` and `artifacts/sme-compliance` runs the Vitest suite
under its V8 provider, and the floors file's `runner.kind` (`vitest` there,
`node-test` for the api-server) tells the shared script how to start the
suite; everything from the lcov onward is one code path. The web-ui areas
are its workspace, operation-recovery and hook modules; the console's are
`src/lib` and `src/components`; the SME app adds its dashboard modules. CI
runs the three coverage forms and retains the lcov and summary files as the
`web-coverage` artifact. The buyer portal, landing and mobile suites still
run plain; their floors are the stage after this one.

Use only a disposable database: the main-app HTTP integration and E2E failure
fixtures require `E2E_DATABASE_DISPOSABLE=1`. The route fixtures give each test
file its own loopback source address on Linux, where the whole 127/8 block
routes to `lo`, so the persistent per-IP throttles stay enabled; on macOS and
Windows every fixture shares `127.0.0.1`, the two tests that need a private
per-IP counter skip themselves, and `LOGIN_IP_ATTEMPT_MAX` can be raised if
the login throttle trips across files. The credit suite uses the same
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
