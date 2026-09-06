# Operations and Rollback

## Environments

Development, staging, and production must use separate databases, secrets,
provider credentials, web origins, and backup destinations. Staging is the
promotion gate; it is not a production alias.

## Release Path (pilot profile)

A merge to `main` is deployed by one Replit Publish. There is no rebuild, no
install and no manual evidence file in this profile (ADR 0004); what the
Publish trusts is the immutable artifact CI produced for that exact commit.

1. Wait for CI on `main` to be green. Its last steps stamp
   `release/build-manifest.json` (source tree and byte hashes, the seven-app
   asset inventory, the contract version, the CI run identity) and its
   `.sha256` sidecar, and upload them with all seven `artifacts/<app>/dist`
   trees as `meridian-release-<sha>`.
2. Stage that artifact into the clean Replit checkout of the same commit:
   `release/build-manifest.json`, `release/build-manifest.json.sha256` and the
   seven `dist` trees. Do not rebuild, rename or merge older output into it.
3. Publish. Every service's production build runs
   `node scripts/src/ops/replit-promote.mjs build <app>`, which refuses unless
   the checkout is clean, the local source tree, tracked-source hash and
   schema hash equal the manifest, and the packaged assets match the inventory
   byte for byte. The API build additionally syncs the target schema — plain
   `drizzle push` (a destructive diff prompts, gets end-of-file and fails the
   build) and then the guardrail migrations — using the deployment's
   `DATABASE_URL`. Web builds need no database.
4. The API runs `replit-promote.mjs start api-server`: it re-verifies the
   packaged bytes without Git, sets `BUILD_REVISION` and
   `EXPECTED_BUILD_REVISION` to the tested revision, and imports the unchanged
   `artifacts/api-server/dist/index.mjs`. Boot re-asserts the guardrail
   migrations under an advisory lock and holds readiness until they verify.
5. Verify: `/api/healthz` reports the manifest's revision and contract version
   (the web apps' stale-build banner clears), `/api/readyz` answers `ready`,
   and `DATABASE_URL=… RELEASE_BASE_URL=https://… pnpm --filter
   @workspace/scripts run ops:postdeploy` confirms source, contract, public
   asset bytes and database catalog parity after the fact.

`RELEASE_RUNTIME_STATE=HOLD` is the maintenance switch in this profile: the API
serves `/api/healthz` only and answers 503 to everything else without
connecting to the database. Set it, Publish, do the maintenance, unset it,
Publish again.

Rollback in this profile is a Publish of the previous green commit's artifact:
the same steps with the earlier staged manifest and `dist` trees. Additive
schema changes are forward-compatible; a change that removed or retyped a
column needs a forward corrective migration instead (see Rollback below).

## Governed profile (HOLD/RUN)

`RELEASE_PROFILE=governed` keeps the R198–R200 ceremony for when a live tenant
base justifies it: the API boots in HOLD by default; `ops:release -- --yes` is a
read-only preflight that requires the trusted manifest checksum, a rollback
revision or an approved maintenance-forward plan, fresh backup and restore-drill
evidence and semantic catalog parity; RUN needs `RELEASE_RECOVERY_MODE=
maintenance-forward`, `RELEASE_TRAFFIC_DRAINED=1`, an activation permit bound
to the candidate, manifest, target, backup, plan and held evidence, and the
held-verification output of `postdeploy --held`. The evidence contracts,
identity bindings (`RELEASE_BASE_URL`, `RELEASE_TARGET_REPL_ID`, the three
independently trusted checksums) and the staging drills are recorded in
[the R198 records](history/2026-09-r198/README.md); `docs/environment.md`
lists every variable. Nothing in that path was removed — it is selected by
configuration, and its tests still run in CI.

Governed rollback mode also requires a retained, candidate-bound approval record:

```json
{
  "format": 1,
  "mode": "rollback",
  "revision": "<full candidate SHA>",
  "rollbackRevision": "<full qualified fallback SHA>",
  "approved": true,
  "approvedBy": "<reviewer identity>",
  "approvedAt": "<UTC timestamp>",
  "expiresAt": "<later UTC timestamp>",
  "qualificationEvidence": "<retained staging/CI evidence reference>"
}
```

Set `RELEASE_ROLLBACK_APPROVAL` to the private immutable record and
`RELEASE_ROLLBACK_APPROVAL_SHA256` to its independently captured digest.
Promotion preflight and governed API startup hash the exact bytes and bind both
full revisions before accepting rollback mode. Unknown fields, self-fallback,
unapproved records, future approval, expiry, tampering, or either revision
mismatch fail closed. A maintenance-forward RUN still requires its separate
plan, held evidence, writer drain, and fresh activation permit; rollback
approval never grants maintenance-forward authorization.

## Database Safety

- Migrations are additive and ordered. Never edit an applied migration.
- Schema and guardrail migrations are both required.
- The post-merge hook is frozen-install plus reviewed versioned migrations only.
  Missing historical baseline tables require explicit offline maintenance;
  never repair that failure using an online schema push or non-frozen install.
- The pilot profile's API build runs a plain schema push before the new
  revision serves: additive changes land with the deploy, a destructive diff
  fails the build and needs a reviewed migration. The governed profile never
  pushes online: `--offline-bootstrap` is its explicit maintenance-only escape
  hatch requiring `RELEASE_TRAFFIC_DRAINED=1`, existing recovery evidence and
  the trusted manifest, with every API instance, worker, schedule and external
  writer stopped first. A crash or verification failure there means traffic
  remains stopped; the script cannot establish or release maintenance mode and
  never claims that it has.
- Long-running work and external calls must not hold request transactions.
- Consequential operations reserve idempotency before provider side effects.
- Rollback tests and restore drills use disposable databases only.

## Backup and Restore

These commands require separate operator approval; documenting them does not
authorize production reads, backup creation, maintenance or deployment. Use
Node plus `psql`, `pg_dump` and `pg_restore`; no npm database dependency is used.
Freeze migrations, extension changes, schema/ACL changes and role administration during backup.
Normal committed DML can continue: a held read-only REPEATABLE READ transaction
exports the snapshot used by both `pg_dump --snapshot` and the catalog, role
prerequisites and all public-table row counts. The source is not queried later
for replacement counts or a post-migration baseline. See PostgreSQL's
[snapshot synchronization](https://www.postgresql.org/docs/16/functions-admin.html#FUNCTIONS-SNAPSHOT-SYNCHRONIZATION)
and [pg_dump snapshot option](https://www.postgresql.org/docs/16/app-pgdump.html).

Create a retained logical backup in an absolute, private directory dedicated to
one source database/environment, outside the checkout and deployment directory.
Do not share a retention directory across sources. POSIX permissions must be
0700; protect the
Windows directory with equivalent ACLs. UUID-suffixed archives use exclusively
opened 0600 descriptors rather than truncating a timestamp-based path:

```bash
BACKUP_DIR=/secure/meridian-backups \
BACKUP_RUNTIME_ROLE="<verified-application-login>" \
  pnpm --filter @workspace/scripts run ops:backup
```

The destination's parent must already exist. Before publishing a heartbeat or
pruning, the producer fsyncs the archive, manifest and checksum files, then the
destination directory and its parent. Any sync failure refuses publication.
The filesystem must support directory fsync; the current Windows runtime refuses
this operation rather than claiming durable success. Use the approved compatible
host/filesystem. No environment flag bypasses durability checks.

The producer prints the manifest checksum and writes a format-2 manifest containing the
archive hash, backup-time security catalog, row counts and referenced role
attributes. Obtain `BACKUP_MANIFEST_SHA256` independently from the approved
producer log or authenticated CI step output. A checksum sidecar supplied with
an untrusted archive is not a trust source. The manifest must be at most 24 hours
old, not future-dated, and the archive must match its hash and size.
Format-1 manifests are refused; they lack the stronger recovery evidence.

After approval, validate that specific retained archive. Supply the existing
source connection only for identity validation and recording the successful
drill heartbeat; it is not dumped again. Choose a fresh target name and explicitly
confirm it (connection values below are placeholders, not credentials):

```bash
BACKUP_MANIFEST="/secure/meridian-backups/<archive>.dump.manifest.json" \
BACKUP_MANIFEST_SHA256="<independently-approved-manifest-sha256>" \
DRILL_DATABASE_DISPOSABLE=1 \
DRILL_CONFIRM_TARGET="meridian_drill_<unique>" \
DRILL_DATABASE_URL="postgresql://.../meridian_drill_<unique>" \
  pnpm --filter @workspace/scripts run ops:restore-drill
```

The drill never drops or reuses a database and never uses `pg_restore --clean`.
It rejects the source database name regardless of hostname aliases, requires
the admin host/port to exactly match the target, and verifies a newly created
database marker before restoring. An existing name refuses. The target remains
for inspection on both success and failure; cleanup is a separately approved
operator action (CI discards its entire disposable PostgreSQL service).

`pg_dump` does not include cluster roles. `BACKUP_RUNTIME_ROLE` must explicitly
identify the intended non-superuser application login; it is not inferred from
an inspection/admin connection. The snapshot records recursive incoming and
outgoing memberships, their grantors and ADMIN/INHERIT/SET options, plus all
required role attributes. Database ACL/settings roles are included as roots.
The login must have a SET-enabled path to the restricted `meridian_app` role;
its BYPASSRLS attribute is recorded, not silently removed or inferred safe.
The target cluster must already have these exact prerequisites. Missing,
extra or different membership/role prerequisites refuse
before database creation; the drill never creates roles or grants privileges.
Provision a reviewed isolated cluster separately, including needed extensions
and matching PostgreSQL major. No production credentials are copied to do so.

Installed extension names, versions and schemas are captured in the same
snapshot and hash. The target must offer each exact version as its default;
for example, vector 0.8.6 cannot stand in for 0.8.0. A different default refuses
even if the old version is available, because ordinary dump extension creation
uses the target default. Installed versions/schemas are compared again after
restore. Provision the correct extension package separately, never silently
upgrade or downgrade while restoring.

After restore, the drill rechecks role memberships and probes actual
`SET ROLE meridian_app` under the intended login via transaction-local
`SET SESSION AUTHORIZATION`. The isolated target connection must be an admin
permitted to impersonate that login, or that login itself. This does not copy
passwords or verify password/HBA authentication. See PostgreSQL's
[membership options](https://www.postgresql.org/docs/16/catalog-pg-auth-members.html)
and [session authorization](https://www.postgresql.org/docs/16/sql-set-session-authorization.html).

Restore runs from a private checksum-verified copy of the retained archive.
The same snapshot captures `databaseProperties`: database owner, explicit
semantic ACLs (including PUBLIC CONNECT/TEMP), database and role-in-database
settings, encoding, locale provider/collation/ctype, ICU options and both recorded
and actual collation versions. Those properties are part of the snapshot hash.
The target is created explicitly under its guarded scratch name with
`TEMPLATE template0` and the captured owner/encoding/locale, never
`pg_restore --create`. Creation properties are checked before data restore.
After restore, the helper applies only the scratch database's ACL/settings and
compares the complete database baseline before publishing evidence. It does not
alter global role settings or cluster configuration. Database ACL/settings role
dependencies must already exist and match the role prerequisites.

Collation/provider or extension-version differences between Neon and the isolated
container may block restoration even on the same PostgreSQL major. Obtain a
matching target; never forge or refresh a collation version to satisfy the check.

Success requires full semantic catalog parity (migration ledger, role posture,
RLS policies/grants, constraints, indexes, functions and triggers) and every
recorded public-table count against the backup-time baseline. A migration-49
backup is compared with its migration-49 baseline even after source upgrade;
release preflight separately checks the candidate's expected migration-54 catalog.

Backup heartbeat metadata has `evidenceVersion: 2`, `sha256`, `snapshotSha256`,
`manifestSha256`, `file`, `manifestFile`, `bytes`, `tocEntries` and `createdAt`.
The snapshot hash covers the exact JSON object
`{catalog,rowCounts,roles,roleRoots,memberships,runtimeLogin,extensions,databaseProperties}`.
Drill metadata has `evidenceVersion: 2`, matching `backupSha256`,
`snapshotSha256`, `backupManifestSha256`, `backupCreatedAt`, `targetDatabase`,
`durationSeconds`, `securityCatalogVerified: true` and
`allTableCountsVerified: true`. Completion timestamps remain database-recorded
`last_succeeded_at` values. No success heartbeat is written for failed verification.

CI passes the retained producer step's manifest path/hash directly to the drill,
keeps backup files under the private runner temporary directory, and tests a
concurrent post-snapshot insert plus a later schema change. Catalog subprocess
capture is bounded at 16 MiB. Retention checks regular files and rejects symlinked
bundles; incomplete captures and unrelated files are not pruned. An exclusive
same-directory operation lock is acquired before snapshot capture and held
through heartbeat publication and retention. A second invocation refuses before
capture; an abandoned lock requires operator investigation, not automatic removal.
This is not global serialization across backup directories. Across directories,
the source database atomically refuses a backup heartbeat whose snapshot
`createdAt` predates the already recorded backup. Rejection does not prune files
or publish CI outputs. A verified archive is retained on publication or retention
failure for operator inspection. Protect all artifacts as production data.

This is a logical application backup, not a cluster-global or PITR backup. It
does not export role passwords or provision target extensions/cluster settings.
PostgreSQL client arguments never contain URL passwords: the connection helper
moves them to child `PGPASSWORD`, rejects password/service query overrides,
preserves TLS/socket parameters, and redacts credential-bearing errors/causes.
No password file is written. Existing process environment credentials remain
sensitive and must be protected by the operator.
Source access includes read-only snapshot/catalog/count queries and one successful
`backup` or `restore_drill` operational-heartbeat write; it is not literally a
read-only operation end to end. No application data is modified by these commands.
The CI integration test intentionally creates/changes a fixture table and must
only run against its explicitly disposable test database, never production.

For R198, the user has authorized the parent to perform an initial production
backup, isolated restore and local download; credentials and host operations
remain with the parent. No maintenance drain has been performed or implied by
that approval. The initial drill can establish capability, but a maintenance
release plan requiring a post-drain pre-change snapshot still needs a fresh
backup and matching retained-archive drill after that separately approved drain.

## Rollback

In the pilot profile an application-only rollback is a Publish of the previous
green commit's artifact (Release Path above). The rest of this section is the
data-compatibility reasoning that decides whether that is enough.

For the contract 0.99.0 transition, baseline
`8347dd29f3d947634a62739088e67548a8d0a946` (0.98) is not write-compatible with
the new revision/idempotency guarantees. Its application does not enforce
invoice content revisions or create/import idempotency, bind approvals to the
reviewed revision, or account for outstanding Clerk reservations. Additive
database columns and tables do not supply those missing application checks.
Do not serve that build against upgraded production data as an ordinary rollback.

No qualified 0.99-compatible fallback has yet been established for R198.
Qualification requires a successful immutable CI artifact and staging tests
against post-upgrade data: stale edit/approval rejection, original-key replay
and changed-payload refusal, import checkpoints, draft tombstones, and unsettled
Clerk spend. Record the fallback's full manifest revision and evidence before
setting `RELEASE_ROLLBACK_REVISION`. The current gate checks SHA syntax, not this
compatibility evidence; an arbitrary, baseline or candidate SHA must not be used
merely to satisfy it.

Without a qualified fallback, the alternative is a separately reviewed,
externally enforced maintenance and forward-recovery policy: stop all APIs,
workers, schedules and other writers, retain database evidence, and resume only
after a verified corrective release. The release gate now supports that explicitly
selected maintenance-forward mode with an independently approved plan and
retained-backup binding. HOLD/RUN adds separately approved startup admission;
it is not an automatic resume or a rollback-compatibility exemption. Preparation
approval does not authorize drain, migrations, Publish or activation. Follow the
HOLD/RUN procedure and retain all existing freshness, security-catalog and
immutable-artifact gates.

Application-only rollback:

1. Stop promotion and affected writes; preserve logs/request IDs.
2. Redeploy only the qualified contract-compatible immutable artifact, including
   its matching API, web and mobile assets. Do not mix 0.98 and 0.99 writers.
3. Keep migrations 0050-0054 applied, with all constraints, grants, RLS policies
   and triggers intact. No ordinary down migration is part of this procedure.
4. Verify the runtime revision against the fallback manifest, recheck readiness,
   asset/security parity and recovery journeys, then reopen approved traffic.
   Replay work only with its original idempotency key and payload.

Database-impacting rollback:

1. Externally stop every affected writer, including workers and schedules.
2. Prefer a forward corrective migration.
3. Do not run 0050-0054 downs for ordinary recovery. The ladder proves specific
   data-preservation behavior, not old-application write compatibility; 0051 and
   0054 downs remove operation/import safeguards. Any exceptional database
   recovery requires its own reviewed and tested incident plan.
4. Restore from the pre-release backup only as an incident decision, with the
   accepted recovery-point loss and reconciliation of external side effects
   recorded. A historical restore is not a contract-compatible application rollback.

Never roll back append-only audit or inference ledgers by deleting evidence.

## Observability

Correlate every incident with build revision, contract version, request ID,
firm/party scope where permitted, operation type, and sanitized provider
outcome. Never log tokens, cookies, document bodies, raw model prompts,
personal data, or unrestricted provider payloads.

Minimum release signals are readiness, 5xx/429 rates, p95 latency, DB pool
pressure, oldest pending outbox age, dead-letter count, rail breaker state,
Clerk invalid/error rate, spend, and backup/restore heartbeats.
