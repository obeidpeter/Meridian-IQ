---
name: Drizzle push vs SQL migration runner
description: Why drizzle push must be told to ignore the SQL migration runner's tracking table.
---
This project applies raw SQL migrations at boot via its own runner, which tracks applied migrations in `_schema_migrations`. Drizzle Kit does not know about that table.

**Rule:** `lib/db/drizzle.config.ts` sets `tablesFilter: ["*", "!_schema_migrations"]`.
**Why:** without the exclusion, `drizzle push` sees `_schema_migrations` as not-in-schema and proposes dropping it — a destructive prompt that would wipe migration history.
**How to apply:** keep any runner-owned bookkeeping tables out of drizzle's view via tablesFilter; never let push manage them.
