---
name: RLS SET ROLE breaks in production
description: Why "permission denied to set role meridian_app" only happens in prod, and why the app must self-heal the role grant.
---

# RLS `SET ROLE` works in dev, 500s in production

The app enforces tenant RLS by running `SET LOCAL ROLE meridian_app` in every
request/worker transaction (the pool login is a BYPASSRLS owner, so without the
role switch policies never fire). For `SET ROLE` to succeed the login role must
either be a superuser **or** hold membership in the target role **with the
PostgreSQL 16 `SET` membership option**.

**The trap:** dev login is `postgres` (superuser) → `SET ROLE` to anything always
works, so a missing grant is invisible in dev. Production login is `neondb_owner`
(NOT superuser). Neon makes it a *member* of `meridian_app` but **without the
`SET` option** (`set_option=f`), so `SET ROLE meridian_app` is denied and every
request 500s with `permission denied to set role "meridian_app"`.

**Why publish/overwrite-data can't fix it:** role memberships are cluster-level.
They are carried by neither Publish's schema diff (it diffs tables/columns only)
nor the dev→prod data copy. Dev has no explicit membership row to copy (superuser
needs none). Prod `executeSql` is read-only, so no manual GRANT from the agent.

**Fix (self-heal at startup):** `neondb_owner` holds `admin_option` on
`meridian_app`, so the app grants itself the SET option at boot:
`GRANT meridian_app TO CURRENT_USER WITH SET TRUE`. See
`ensureAppRoleAssumable()` in `lib/db/src/client.ts`, called production-only from
api-server `main()` after `listen()`/signal handlers, before `startWorker()`.
Idempotent: it only writes when the check fails, and the grant is
cluster-persistent so later cold starts skip it.

**Why:** this is DB *role infrastructure* the app owns, not table schema Publish
owns — so the usual "re-publish instead of startup DDL" rule does not apply here
(re-publish provably cannot set a role's membership options).

**How to apply:** use `pg_has_role(current_user, 'meridian_app', 'SET')` — the
`'SET'` mode is the exact predicate for "can SET ROLE". Do NOT use `'USAGE'`
(that tests INHERIT semantics and gives wrong answers when inherit≠set). Never
rely on the login being a superuser for role switching; grant membership WITH SET
explicitly. After code changes here, re-publish so prod runs the grant, then
confirm the "Granted the login role the SET privilege" log line.
