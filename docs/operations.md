# Operations and Rollback

## Environments

Development, staging, and production must use separate databases, secrets,
provider credentials, web origins, and backup destinations. Staging is the
promotion gate; it is not a production alias.

## Release Sequence

1. Record the candidate Git SHA and expected contract version.
2. Confirm CI, dependency audit, migration rollback, restore drill and E2E, plus
   either a qualified application fallback or the separately approved
   maintenance-forward policy described below.
3. Create a verified backup before any staging schema or data migration.
4. Deploy the candidate to staging with `EXPECTED_BUILD_REVISION` set.
5. Verify health, readiness, release-readiness checks, logs, and core journeys.
6. Observe error rate, latency, outbox age, dead letters, Clerk failures, and
   provider health through the agreed staging window.
7. Promote separately only after explicit production approval.

Run `ops:release -- --yes` with the trusted CI manifest and checksum before
promotion, then `ops:postdeploy` against the destination. The release script is
a verifier, not a deployment command. It checks source/build identity, backup
and restore heartbeats, and the full tested database security catalog. It never
runs schema push in its production path. Schema differences fail closed until
reviewed versioned SQL has been applied under a separately approved plan.
See [runtime evidence and state contracts](runtime-evidence-r198.md).

The release readiness endpoint must report no blocked checks. Warnings require
an owner, written acceptance, and a rollback trigger.

## Native Replit Publish

The API, five web and mobile `artifact.toml` production build commands now invoke
`node scripts/src/ops/replit-promote.mjs build <app>`. They do not run `pnpm
build`, install dependencies, fetch artifacts or infer schema. Normal local
builds, CI builds and all development descriptor commands remain unchanged.
Mobile now participates in the seven-artifact contract; the temporary blanket
refusal is removed. CI invokes `node scripts/src/ops/mobile-artifact.mjs build`
and `check`. This uses the existing iOS/Android Metro export, packages its native
manifests/assets, unchanged server, template, app metadata and EAS configuration
under `artifacts/mobile/dist`, then probes the original packaged server over
loopback. It does not substitute an unrelated web-only `expo export`.
Local Expo development and ordinary package builds remain available.

Mobile identity is recorded in the checksum-protected manifest and
`artifacts/mobile/dist/deployment.json`: domain `meridian-iq.replit.app`,
base path `/mobile/`, Repl ID `d096574a-b3d8-4990-8bf5-4be1e6646e06`.
The production EAS environment is the reviewed configuration source. The current
build couples the API host and mobile bundle-asset host. The parent must verify
in the Replit UI that the expo-domain service actually exposes manifests/assets
at that host/path; the observed API URL alone is not proof. A different mobile
host requires an explicit reviewed build configuration, not runtime URL rewriting.

1. Require the approved successful CI run and its full source SHA. Securely
   transfer its `meridian-release-<SHA>` artifact into the matching clean Replit
   checkout, preserving `release/build-manifest.json` and all seven
   `artifacts/<app>/dist/**` trees. Do not rebuild, rename assets or merge old
   output into the candidate. The CI upload includes hidden files so its
   transport matches the complete manifest inventory.
2. Independently obtain the manifest checksum from the trusted CI run and set
   `RELEASE_MANIFEST_SHA256` in the Publish build and API runtime configuration.
   Do not trust a checksum downloaded alongside an untrusted manifest. The
   adapter always reads the root-relative `release/build-manifest.json`; it
   does not fetch URLs or accept a public/browser manifest path. Keep the
   manifest outside every static `publicDir`; do not use a `VITE_` variable.
3. Supply the API build's existing `DATABASE_URL` for the actual production
   target and the chosen recovery-mode configuration. Rollback mode requires a
   qualified `RELEASE_ROLLBACK_REVISION`; maintenance-forward requires the
   independently approved recovery plan. Apply any separately reviewed
   versioned migrations and establish genuine backup/restore evidence first.
   In particular, production must already have migrations 0050-0054 before
   this preflight can pass. The post-merge development migration is not evidence
   that production was upgraded; the parent/operator applies production changes
   only after backup approval.
   The API build runs the existing read-only release preflight automatically;
   missing recovery, role/RLS/trigger/catalog drift or missing configuration
   blocks Publish. Web build verification requires no database credentials.
4. Verify native Publish uses these descriptors without an override. Each of
   the seven commands requires the clean Git checkout and exact source/schema
   hashes plus the complete matching seven-app asset inventory. Dirty or missing
   source (including unexpected untracked files), missing siblings, a wrong
   manifest, extra assets or tampering refuses
   rather than rebuilding. The API run command invokes the same adapter with
   `start api-server`, rechecks the checksum and all packaged asset bytes without
   Git, and sets `BUILD_REVISION` and `EXPECTED_BUILD_REVISION` to the verified
   full SHA. It defaults to HOLD without importing the API; only an explicitly
   authorized RUN activation imports unchanged `artifacts/api-server/dist/index.mjs`.
   Mobile uses `start mobile` to verify the same seven-app inventory, validate
   its signed target configuration and load the packaged original CommonJS
   server. Both server startup commands force production mode. A runtime
   `BASE_PATH` mismatch refuses instead of altering the tested mobile paths.
5. After HOLD Publish, use the held-verification flow below; do not mistake its
   maintenance health response for API readiness. After authorized RUN Publish,
   run ordinary `ops:postdeploy` against the actual origin and every API replica.
   Confirm source/contract, readiness, public bytes and target catalog parity;
   retain the native build/start logs and CI run identity.
   Deployment UUIDs are not source revisions and are not accepted as evidence.

Replit describes publishing as a snapshot of the app, but snapshot contents must
be verified for this repository's application-router deployment. See the
[Replit publishing documentation](https://docs.replit.com/learn/projects-and-artifacts/replit-deployments).
Native Publish may add an empty "Published your App" commit. The Replit adapter
alone permits a different local HEAD when the checkout is clean and the complete
Git tree, tracked-source byte hash and schema byte hash equal the trusted CI
manifest. Assets and mobile configuration must still match exactly. It logs the
local HEAD and tested CI revision separately; it does not claim they are the
same commit. Both runtime revision variables remain the manifest's CI revision.
The generic `ops:release` verifier remains strict about exact source revision;
no environment flag enables this exception outside the native adapter.
In particular, `dist` is Git-ignored: confirm the secure staging upload survives
the native build snapshot, and that the final API/mobile runtimes contain all
seven dist trees, the manifest and
`scripts/src/ops/{replit-promote,build-manifest,mobile-artifact,release,security-catalog,common,recovery-plan,activation-permit,maintenance-server,postdeploy}.mjs`.
The build must retain matching `.git` metadata; runtime need not. Missing paths,
missing checksum propagation or Git stripping at build time deliberately fail
closed. There is no fallback to local compilation, a sidecar checksum or a
deployment UUID. Test these packaging assumptions on staging before production;
local fixture tests are not proof of Replit snapshot behavior.
On staging, deliberately fail the API preflight and mobile service and confirm
the whole Publish is rejected without promoting sibling web services. Do not
assume cross-service atomic promotion if the provider has not demonstrated it.

Keep provider-side dev-to-production data copying and inferred schema pushes
disabled; this adapter cannot control an independent Publish database-sync
stage. Verify that stage separately. Existing locked runtime dependencies must
also survive packaging; the adapter does not install them. In particular, retain
the locked `pdf-parse` dependency tree, including its PDF.js worker files and
platform-matching native canvas package. PDF parsing is intentionally external to
the API bundle so those package-relative resources resolve correctly. Run
`node --test scripts/src/e2e/pdf-runtime.test.mjs` against the staged API dist and
its installed dependencies before publishing. Parent/operator owns
secure artifact transfer, provider configuration, production approval and real
recovery evidence. No production Publish was performed by this implementation.

## HOLD and RUN

API startup defaults to `RELEASE_RUNTIME_STATE=HOLD`. Both states require
`RELEASE_BASE_URL` as the exact origin matching the CI manifest's mobile domain,
`REPL_ID` matching its Repl ID, and independently trusted
`RELEASE_MANIFEST_SHA256`, `RELEASE_RECOVERY_PLAN_SHA256` and
`RELEASE_BACKUP_SHA256`. Never derive these trust inputs from unreviewed staged
files. HOLD runtime performs no database connection, API import or plan-TTL
validation; it serves maintenance health and rejects business/readiness requests
with 503. It has no remote resume endpoint.

The maintenance-forward release validator is integrated, but operational use
still needs actual approvals and evidence under
[the reviewed plan contract](maintenance-release-r198.md). After a separately
approved external drain, retain the fresh pre-change backup/drill and apply
only reviewed versioned migrations. Publish the verified immutable candidate in
HOLD, then record held verification using a new output file:

```bash
node scripts/src/ops/postdeploy.mjs --held --evidence-out release/held-evidence.json
```

This verifies the HOLD wrapper, business/readiness 503 responses, public asset
bytes, CI identity, target security catalog and recovery plan. Its output has
`apiReadinessVerified: false`; it does not prove the API is running or authorize
startup. Obtain the output's checksum through the trusted verification record.

RUN additionally requires `RELEASE_RECOVERY_MODE=maintenance-forward`,
`RELEASE_TRAFFIC_DRAINED=1`, `RELEASE_ACTIVATION_PERMIT`, independently trusted
`RELEASE_ACTIVATION_PERMIT_SHA256`, `RELEASE_ACTIVATION_ID` (canonical UUID), and
`RELEASE_HELD_EVIDENCE_SHA256`. RUN promotion also requires the corresponding
`RELEASE_HELD_EVIDENCE` file and current approved recovery plan. The permit binds
the exact candidate, manifest, target, backup, plan and held evidence, and
explicitly authorizes startup writes. External ingress and schedules must stay
held until real post-RUN readiness and operator signoff.

Inside the checkout, only the fixed `release/recovery-plan.json`,
`release/held-evidence.json` and `release/activation-permit.json` evidence paths
are permitted; alternatively keep evidence outside the checkout. They are not
public assets. RUN runtime verifies the permit and digest bindings; plan and
held-evidence files need not be present there. Approval TTLs apply to each new
Publish, not later cold starts of the admitted release. Reusing the same active
permit is the same logical activation, not a single-use guarantee.

Ordinary postdeploy verifies RUN, the local permit, actual API readiness,
source/assets and database catalog. It cannot currently attest the activation
UUID remotely; retain the matching control-plane and startup records instead of
claiming remote activation-ID proof. The HOLD/RUN path still requires actual
host/staging verification; local fixture tests are not deployment approval.

## Database Safety

- Migrations are additive and ordered. Never edit an applied migration.
- Schema and guardrail migrations are both required.
- The post-merge hook is frozen-install plus reviewed versioned migrations only.
  Missing historical baseline tables require explicit offline maintenance;
  never repair that failure using an online schema push or non-frozen install.
- Never run schema push against serving traffic. `--offline-bootstrap` is an
  explicit maintenance-only escape hatch requiring `RELEASE_TRAFFIC_DRAINED=1`,
  existing recovery evidence and the trusted manifest. The operator must stop
  every API instance, worker, schedule and external writer beforehand. A crash
  or verification failure means traffic remains stopped; the script cannot
  establish or release maintenance mode and never claims that it has.
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
