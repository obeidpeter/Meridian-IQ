---
name: Verifying prod guardrails
description: How to confirm boot-applied guardrail migrations actually ran in production when deployment logs are lossy
---

The deployment log stream can silently drop the api-server's pino boot lines ("Production guardrail migrations applied" / "Production guardrails verified") even when the apply ran — observed July 31 2026: DB proved migrations 3–31 applied at the exact boot second, yet no guardrail lines appeared anywhere in retained logs.

**Why:** deploy-log ingestion is lossy/rotates per instance; absence of a log line is NOT evidence the boot step failed.

**How to apply:** verify via the production DB (read-only), not logs:
- `SELECT version, applied_at FROM _schema_migrations ORDER BY version` — applied_at clustered at the boot timestamp proves the boot apply ran.
- Trigger presence: `SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE t.tgname='meridian_append_only' AND c.relname='<table>'`.
- RLS coverage sweep (same query as verifyProductionGuardrails); only `audit_events` is exempt.
