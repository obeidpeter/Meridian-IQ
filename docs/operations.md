# Operations and Rollback

## Environments

Development, staging, and production must use separate databases, secrets,
provider credentials, web origins, and backup destinations. Staging is the
promotion gate; it is not a production alias.

## Release Sequence

1. Record the candidate Git SHA and expected contract version.
2. Confirm CI, dependency audit, migration rollback, restore drill, E2E, and a
   qualified application fallback under the compatibility rules below.
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
   target and `RELEASE_ROLLBACK_REVISION`. Apply any separately reviewed
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
   Git, sets `BUILD_REVISION` and `EXPECTED_BUILD_REVISION` to the verified full
   SHA, then imports the unchanged `artifacts/api-server/dist/index.mjs`.
   Mobile uses `start mobile` to verify the same seven-app inventory, validate
   its signed target configuration and load the packaged original CommonJS
   server. Both server startup commands force production mode. A runtime
   `BASE_PATH` mismatch refuses instead of altering the tested mobile paths.
5. After Publish, run the existing `ops:postdeploy` against the actual origin
   and every API replica. Confirm source/contract, readiness, public bytes and
   target catalog parity; retain the native build/start logs and CI run identity.
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
`scripts/src/ops/{replit-promote,build-manifest,mobile-artifact,release,security-catalog,common}.mjs`.
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
also survive packaging; the adapter does not install them. Parent/operator owns
secure artifact transfer, provider configuration, production approval and real
recovery evidence. No production Publish was performed by this implementation.

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
after a verified corrective release. The current release gate does not accept
that alternative. Documenting it is not approval or a bypass; a separately
reviewed policy/gate change would be required before using it for release.

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
