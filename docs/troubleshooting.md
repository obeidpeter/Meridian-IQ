# Troubleshooting

## `pnpm` or `node` Is Not Found

Use Node 22/24 and pnpm 10/11. In Codex desktop, load the bundled workspace
dependencies before running commands. Do not substitute npm or yarn; the
preinstall guard removes foreign lockfiles.

## Build Requests `PORT` or `BASE_PATH`

Current app configs have checked-in defaults. Pull current `main` and run
`pnpm run build`. Deployment workflows can still override both variables.

## Database Tests Return Permission Errors

The table schema exists but guardrails may not. Run both:

```bash
pnpm --filter @workspace/db run push
pnpm --filter @workspace/db run migrate
```

Confirm `DATABASE_URL` points to a disposable PostgreSQL 16 database with
pgvector and that the test role can create the required roles/extensions.

## App Shows a Stale-Build Banner

Compare `/api/healthz` contract/build data with the deployed web bundle. A
merge alone does not restart an existing process. Rebuild and restart the
staging workflow, then verify `EXPECTED_BUILD_REVISION` matches the running
SHA. Do not suppress the banner.

## Replit Preview Does Not Reflect a Merge

Confirm the Repl is tracking `main`, pull/sync it, then restart the Project
workflow. Validate the development preview before using Republish. Production
publishing is a separate, explicit action.

## API Is Healthy but Not Ready

Read `/api/readyz` and the release-readiness detail. Common causes are pending
migrations, a bootstrap failure, missing signing keys, stale operational
heartbeats, or a required live integration that is not configured.

## Clerk Features Are Unavailable

Check the `clerk_ai` feature flag, provider key/base URL, model tier mapping,
firm budget, consent, and gateway ledger. A missing provider configuration is
expected to fail closed. Do not bypass the gateway or disable schema checks.

## Architecture Check Fails

Read the reported cycle or boundary. Move shared types/pure helpers into a
neutral lower-level module. Do not suppress a cycle by changing only the
import syntax. Tests may import route harnesses; production domain modules may
not import routes.

## Secret Scan Fails

Remove the credential from the working tree, rotate/revoke it, and purge it
from Git history before pushing. Replacing it with a placeholder is not enough
after a real secret has been committed.

## Large Bundle Warning

Console and SME bundles still exceed Vite's advisory threshold. Treat the
warning as tracked debt, not a failed build. Prefer route-level lazy imports
and measured chunking; verify deep links, loading states, and error boundaries
after each split.
