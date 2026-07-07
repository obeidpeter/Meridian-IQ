# Memory Index

- [Stamp verification integrity](stamp-verification.md) — a CSID is valid only if it matches a persisted stamp_records row, never by format/length.
- [Dev principal shim](dev-principal-shim.md) — x-mock-* header auth must be non-prod only and never default to a privileged role.
- [api-server test/build setup](api-server-testing.md) — Node's built-in test runner runs .ts directly; builds go through esbuild, tsc is noEmit-only.
- [MeridianIQ platform invariants](meridianiq-platform.md) — party tenant boundary is engagements; dark flags must 404 before RBAC; UBL unitCode is an attribute.
- [Request transaction boundary](request-tx-boundary.md) — one tx per request with RLS GUCs; commit BEFORE any byte flushes, reject streaming, timeout-rollback.
- [Drizzle push + SQL migrations coexistence](drizzle-migrations.md) — SQL migration runner owns _schema_migrations; drizzle push must exclude it via tablesFilter.
