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

**Failure mode:** if the post-merge push doesn't run/complete, the new tables
don't exist, and api-server boot dies in `applyMigrations` with
`relation "<table>" does not exist` (e.g. a migration enabling RLS on R2 tables
like `bank_statements`). Fix: `pnpm install` then get `pnpm --filter db push`
to complete, then restart api-server. A missing `node_modules` (e.g. `vite:
not found` on a web artifact) is the same root cause: post-merge `pnpm install`
didn't finish.

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

## memberships duplicate accumulation
`memberships` accumulated duplicate rows because the old unique index used the
default NULLS DISTINCT (NULL firm/party columns never conflicted, so repeated
`seedPlatform` inserts with bare `onConflictDoNothing()` kept adding rows). The
tightened 5-col `nullsNotDistinct` index fixes this going forward. **Ordering
trap:** the dedupe that clears the way for the tightened index lives in a *boot*
SQL migration, but the tightened index is applied by *post-merge* push (earlier)
— so on a pre-existing dup'd DB, push fails until you dedupe first (keep the
earliest row per user_id/role/firm_id/client_party_id).
