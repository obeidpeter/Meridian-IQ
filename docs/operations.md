# Operations and Rollback

## Environments

Development, staging, and production must use separate databases, secrets,
provider credentials, web origins, and backup destinations. Staging is the
promotion gate; it is not a production alias.

## Release Sequence

1. Record the candidate Git SHA and expected contract version.
2. Confirm CI, dependency audit, migration rollback, restore drill, and E2E.
3. Create a verified backup before any staging schema or data migration.
4. Deploy the candidate to staging with `EXPECTED_BUILD_REVISION` set.
5. Verify health, readiness, release-readiness checks, logs, and core journeys.
6. Observe error rate, latency, outbox age, dead letters, Clerk failures, and
   provider health through the agreed staging window.
7. Promote separately only after explicit production approval.

The release readiness endpoint must report no blocked checks. Warnings require
an owner, written acceptance, and a rollback trigger.

## Database Safety

- Migrations are additive and ordered. Never edit an applied migration.
- Schema and guardrail migrations are both required.
- Long-running work and external calls must not hold request transactions.
- Consequential operations reserve idempotency before provider side effects.
- Rollback tests and restore drills use disposable databases only.

## Backup and Restore

Create a logical backup with the repository operation script and store it
outside the checkout and deployment directory:

```bash
BACKUP_DIR=/secure/meridian-backups \
  pnpm --filter @workspace/scripts run ops:backup
```

Validate recoverability with:

```bash
DRILL_DATABASE_URL=postgresql://.../meridian_drill \
  pnpm --filter @workspace/scripts run ops:restore-drill
```

A backup is not accepted until the drill confirms migrations, sentinel row
counts, and RLS posture. Protect backup credentials and artifacts as
production data.

## Rollback

Application-only rollback:

1. Stop promotion and preserve logs/request IDs.
2. Redeploy the last known-good immutable revision.
3. Set `EXPECTED_BUILD_REVISION` to that SHA.
4. Recheck health/readiness and replay only idempotent work.

Database-impacting rollback:

1. Disable affected writes or feature flags.
2. Prefer a forward corrective migration.
3. Use a tested down migration only when data preservation is proven.
4. Restore from the pre-release backup only as an incident decision, with the
   accepted recovery-point loss recorded.

Never roll back append-only audit or inference ledgers by deleting evidence.

## Observability

Correlate every incident with build revision, contract version, request ID,
firm/party scope where permitted, operation type, and sanitized provider
outcome. Never log tokens, cookies, document bodies, raw model prompts,
personal data, or unrestricted provider payloads.

Minimum release signals are readiness, 5xx/429 rates, p95 latency, DB pool
pressure, oldest pending outbox age, dead-letter count, rail breaker state,
Clerk invalid/error rate, spend, and backup/restore heartbeats.
