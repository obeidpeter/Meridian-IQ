---
name: DB schema sync — drizzle push vs hand-written migrations
description: How MeridianIQ tables actually get created (drizzle push, not the SQL migrations), why api-server boot can fail post-merge, and drizzle-kit push gotchas.
---

# DB schema sync: drizzle push vs SQL migrations

Two separate mechanisms manage the schema, and confusing them causes boot failures:

- **Table creation = `drizzle-kit push`** (`pnpm --filter db push`), run by
  `scripts/post-merge.sh` after a task merge. This is what creates/alters every
  table from the Drizzle schema (`lib/db/src/schema`).
- **Hand-written SQL migrations** (`lib/db/src/migrations/000x_*.ts`, applied at
  api-server boot via `applyMigrations`) only add *guardrails* — RLS policies,
  append-only triggers, retention functions. They `ALTER TABLE <t> ENABLE ROW
  LEVEL SECURITY` on tables they assume already exist.

**Root cause of repeated post-merge failures (fixed July 2026):**
`scripts/post-merge.sh` used plain `pnpm --filter db push`; post-merge runs
with stdin closed, so any confirmation prompt got EOF → script failed → the
workflow reconciliation (which restarts and thus rebuilds api-server) never
ran. Script now uses `push-force`. If a merge crash pattern recurs (404 on new
routes / missing response fields / `column does not exist`), check the
post-merge run actually succeeded before manual fixing.

**Failure mode:** if the post-merge push doesn't run/complete, the new tables
don't exist, and api-server boot dies in `applyMigrations` with
`relation "<table>" does not exist` (e.g. a migration enabling RLS on R2 tables
like `bank_statements`). Fix: `pnpm install` then get `pnpm --filter db push`
to complete, then restart api-server. A missing `node_modules` (e.g. `vite:
not found` on a web artifact) is the same root cause: post-merge `pnpm install`
didn't finish.

**Quieter failure mode (missing COLUMNS, not tables):** if the merge only adds
columns, boot succeeds (guardrail migrations don't touch them) and everything
looks healthy until one endpoint 500s with `column "<x>" does not exist`.
Same fix: `pnpm --filter db push`, then restart api-server.

**Stale api-server build after ANY merge:** the api-server workflow builds once
at startup (`pnpm build && start`), unlike the Vite artifacts which HMR. After
a task merge the running dist predates the merged code — symptoms are 404s on
new routes or responses missing new fields (which can crash frontends that
trust the generated types, e.g. `.length` on undefined). Always restart the
api-server workflow after a merge touches it.

## drizzle-kit push gotchas (v0.31.x)
- Adding a UNIQUE constraint to a **non-empty** table triggers an interactive
  "Do you want to truncate <table>?" prompt (Select, default index 0 = "No, add
  without truncating"). `--force` does NOT skip this prompt; it still needs a
  TTY and errors non-interactively. Drive it with a Python `pty` and send `\r`
  to accept the default (safe once duplicates are removed).
- **`nullsNotDistinct()` unique constraints are re-proposed on every push** —
  this version can't introspect `NULLS NOT DISTINCT`, so it always thinks the
  constraint is missing and wants to "add" it. Push is therefore NOT idempotent
  for such constraints; on a non-empty table that means the truncate prompt
  recurs. Not fixable by naming.
- Constraint names are capped at 63 chars by Postgres. An auto-generated unique
  name built from many columns can exceed that and be silently truncated, so the
  schema's expected name never matches the stored name → perpetual rename diffs.
  Give wide unique constraints an explicit short `unique("name")`.
  - Fixed for `clerk_client_statements` (July 2026, 0.23.0 round): now
    `unique("clerk_client_statements_firm_client_month_unique")`. The first
    push after this change does one drop+add cycle (prompts "truncate?" on a
    non-empty table — answer the default "No, add without truncating"; safe,
    the table has no duplicate keys); pushes after that are idempotent.

## memberships duplicate accumulation
`memberships` accumulated duplicate rows because the old unique index used the
default NULLS DISTINCT (NULL firm/party columns never conflicted, so repeated
`seedPlatform` inserts with bare `onConflictDoNothing()` kept adding rows). The
tightened 5-col `nullsNotDistinct` index fixes this going forward.

## memberships_binding_unique is owned by the boot migration, NOT push
The 5-col `nullsNotDistinct` unique index is **not** in the Drizzle schema. It is
created idempotently in migration 0002 (`CREATE UNIQUE INDEX IF NOT EXISTS ...
NULLS NOT DISTINCT`, right after the memberships dedupe). This was moved out of
the schema because push (0.31.x) can't represent NULLS NOT DISTINCT and hung the
non-TTY post-merge push with a "truncate?" prompt.
- **Churn is expected and harmless:** with the index absent from schema, each
  `drizzle push` DROPS the standalone unique index (no prompt, exits 0), and the
  next api-server boot recreates it via `applyMigrations` (which runs every 0002
  up on boot, idempotently). So between push and boot the uniqueness guard is
  briefly gone — fine because the app isn't serving writes in that window.
- The dedupe DELETE runs in the same 0002 up immediately before the CREATE, so
  recreation never fails on leftover duplicates.
- Do NOT drop the index in 0002 `down`: on a legacy DB the object is a
  constraint-backed index (`DROP INDEX` would error "constraint requires it"),
  and rollback intentionally only reverses guardrails, not schema objects.
- Bare `onConflictDoNothing()` (no named target) in seed.ts infers the arbiter
  from any unique index, so a standalone unique index works the same as the old
  table constraint — no `ON CONFLICT ON CONSTRAINT <name>` dependency exists.
