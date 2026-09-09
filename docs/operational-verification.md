# Operational verification

Status: implementation and injected-fixture tests only. No production connection,
provider validation, production backup, restore drill, participant session,
notification, paid service or external schedule has been performed or activated
by this work. Production activation remains blocked on credentials and an
explicitly approved external runner and retention destination.

## Evidence boundaries

Platform operations reads the existing `operational_heartbeats` rows for
`scheduled_work`, `backup` and `restore_drill`. It does not create another ledger.
The existing response `detail` map carries evidence state, source, last-success
and last-failure timestamps, owner role and remediation; no OpenAPI change is
required. Owner roles are routing guidance, not claims that a named person has
accepted responsibility.

| Display             | Meaning                                                                                             |
| ------------------- | --------------------------------------------------------------------------------------------------- |
| Configured only     | Settings or credentials are present; no external request or provider transaction is proven.         |
| Evidence missing    | No success has been recorded.                                                                       |
| Evidence stale      | The success or backup snapshot exceeds its freshness window.                                        |
| Run failed          | An uncleared error or a failure at/after the last success is recorded.                              |
| Invalid evidence    | A timestamp is invalid or more than five minutes in the future.                                     |
| Unverified evidence | Recovery provenance or a required supporting report reference is absent/invalid.                    |
| Current evidence    | A current recorded success satisfies the structural checks, not an independent live audit.          |
| Attested            | An operator supplied a current evidence date; the service has not independently verified the event. |

Production missing/stale/failed/invalid/unverified checks block readiness;
non-production reports warnings. A newer success with no remaining error clears
an older failure. Raw errors, database identities, filenames and arbitrary
heartbeat metadata are not returned to the browser.

Backup provenance requires the existing producer's `evidenceVersion: 2`, archive,
snapshot and manifest SHA-256 digests, positive byte/TOC counts, and a snapshot
timestamp at/before completion. Both completion and snapshot freshness matter.
Restore proof requires the existing version-2 retained-archive digests, verified
security catalog and all-table counts, and a backup taken no more than 24 hours
before drill completion. This is a periodic drill check, not proof that today's
newer backup was restored. The unchanged governed release preflight is stricter:
it binds the drill to the current retained backup. Do not substitute this panel
or runner for `ops:release` or `ops:postdeploy`.

Default panel windows: scheduled work 10 minutes, backup 26 hours, restore drill
31 days. Existing `SCHEDULED_WORK_MAX_AGE_MS`, `BACKUP_MAX_AGE_MS` and
`RESTORE_DRILL_MAX_AGE_MS` override these. The backup/restore tools' own freshness
constraints remain unchanged, including the restore manifest's 24-hour limit.
Human usability dates also require `USABILITY_EVIDENCE_REF`; prepared protocols
and automated tests do not count as completed sessions.

Important limitations:

- A backup heartbeat proves local producer completion, **not private off-box
  retention**. The panel explicitly reports retention as not verified.
- Backup and restore now best-effort record failed actual runs in the existing
  ledger using only `backup_run_failed` or `restore_drill_run_failed`. Failure
  writes preserve the last-success timestamp and its metadata. A later successful
  publication clears the active error; the historical last-failure time remains.
  Backup failure reporting begins only after its exclusive file lock and snapshot
  preflight pass, immediately before dump execution. Restore reporting begins
  only after exclusive fresh database creation and its identity/creation-property
  checks pass, immediately before restore execution. Invalid configuration,
  preflight failures, occupied targets and concurrent lock refusals do not mutate
  the heartbeat. The existing newer-snapshot guard also protects backup evidence
  from an older failing invocation. No new lock service or evidence ledger is used.
- Failure reporting is bounded (five-second client deadline, three-second SQL
  deadline, one-second lock deadline) and cannot replace the original redacted
  operation error. A database outage, killed process or preflight refusal can
  still leave an earlier success visible; external job exit status and private
  logs remain required. Off-box upload failures occur outside these tools and
  also require runner-level failure handling. Do not synthesize success timestamps
  or edit the ledger to make it green.
- Heartbeat metadata is structural producer provenance, not a cryptographic
  attestation of runner identity, continued object availability or environment.
- Credentials and accreditation settings do not establish live-provider success.
  Provider validation still requires approval and real, privately retained evidence.

## Read-only external runner

Run from the reviewed checkout on an approved Node host with built-in `fetch`:

```sh
node scripts/src/ops/operational-check.mjs
```

Inject settings through the runner's private secret store, never arguments,
source files, public logs or shell tracing:

| Setting                                 | Requirement                                                                                                                                                |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPS_CHECK_BASE_URL`                    | Explicit approved HTTPS origin only, e.g. `https://approved.example`; no default production host, user info, path, query or fragment.                      |
| `EXPECTED_BUILD_REVISION`               | Independently pinned full 40-character Git SHA from the approved release manifest, not copied from the endpoint under test.                                |
| `METRICS_KEY_ID` + `METRICS_KEY_SECRET` | Preferred single approved metrics key; secret at least 32 characters.                                                                                      |
| `METRICS_KEYS`                          | Alternative existing `id:secret,...` ring. The full ring is validated and its first key signs requests.                                                    |
| `METRICS_TOKEN`                         | Compatibility alternative, signed with key ID `legacy`; a plain `x-op-token` is never sent.                                                                |
| `OPS_CHECK_METRICS_REQUIRED`            | Defaults to `true`. Explicit `false` permits a visibly skipped metrics check only when no key is configured. A configured failing key still fails the run. |
| `OPS_CHECK_TIMEOUT_MS`                  | Per-request deadline including body, default 10000 ms; integer 1-30000. No retries; at most four sequential requests.                                      |
| `OPS_CHECK_ALLOW_HTTP_LOOPBACK`         | `1` permits HTTP only for localhost/127.0.0.1/::1 fixtures. Never use to relax external HTTPS.                                                             |

The only request paths are `GET /api/readyz`, `GET /api/healthz` and
`GET /api/metrics`. Metrics verification first requires unsigned access to be
denied (401/403), then verifies a signed request returns the expected Prometheus
uptime series. HMAC uses the existing machine-request contract:
`timestamp.GET./api/metrics.sha256(emptyBody)`. The runner rejects redirects,
limits each response to 1 MiB, bounds body reads and never sends credentials to
readiness or health. It does not call providers, the sweep route, backup tools,
operator mutations, notification services or database endpoints. Server-side
access logging and signature verification remain ordinary request effects.

Standard output is one sanitized JSON report, version 1, with closed check keys,
status/error codes, required flags, owner/remediation and per-run success times.
Exit 0 means all required endpoint checks passed; exit 1 means missing required
configuration/evidence, failure or runner error. The report does not contain the
target URL, returned revision/body, metrics, key IDs, signatures, secrets or raw
exceptions. `scope: "endpoint_checks_only"` is deliberate: a passing report does
not verify backups, recovery, live providers, MFA login journeys or real users.
`lastSucceededAt` is from this invocation only and is null for a failure or skip;
it is not durable history and is never written into `operational_heartbeats`.
Retain sanitized reports privately under the approved operational retention policy.

Fixture-only verification, with no external target or database:

```sh
node --test scripts/src/ops/operational-check.test.mjs
node --test artifacts/api-server/src/modules/desk/release-readiness-checks.test.ts
pnpm --filter @workspace/console exec vitest run src/pages/platform-ops.test.ts
```

The direct TypeScript command requires Node's type-stripping support; on older
supported Node versions use the repository's `tsx --test` through api-server.

## Opt-in scheduling

Nothing here installs or enables a schedule. Before any activation, the
deployment owner must approve the target, credentials, execution identity,
network access, concurrency policy, cadence, timeout, retention and a named
person responsible for checking failures. Use an already approved private
external runner, not the serving instance's filesystem or an unapproved paid
service. Restrict metrics jobs to the HTTPS origin; do not give them database
or provider credentials.

Suggested review cadences (not activated): endpoint checks every five minutes,
backup daily, isolated restore drill monthly and before a governed release.
Scheduled work uses the existing `ops:sweep` tool under separate approval;
this read-only runner must never become the sweep scheduler.

Example **disabled-by-default design** for a private Linux runner; paths must be
reviewed and adapted. Provision neither these units nor an enable command from
this document without approval:

```ini
# valo-operational-check.service
[Unit]
Description=Valo read-only endpoint verification
[Service]
Type=oneshot
User=valo-ops
WorkingDirectory=/srv/valo-reviewed
EnvironmentFile=/etc/valo-ops/operational-check.env
ExecStart=/usr/bin/node scripts/src/ops/operational-check.mjs
TimeoutStartSec=130
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true

# valo-operational-check.timer (template only; not installed or enabled)
[Timer]
OnCalendar=*:0/5
Persistent=false
Unit=valo-operational-check.service
```

Keep the environment file root-owned with mode 0600 or inject secrets from the
approved store. Restrict journal/report access. The oneshot unit prevents an
overlapping activation of the same unit; use the scheduler's concurrency guard
for other runner types. Do not add notification hooks without explicit approval.

## Backup and restore activation runbook

These steps perform real database operations and are **not authorized by this
implementation task**. Database operations owns the first approved manual runs;
the security/data owner approves handling and retention before scheduling.

1. Choose a private runner with compatible `psql`, `pg_dump`, `pg_restore`, Node,
   sufficient encrypted disk and approved database access. Pin the reviewed code.
   Inject the required `DATABASE_URL` and `BACKUP_RUNTIME_ROLE` privately;
   the latter must name the intended application login, not the backup admin.
   Configure an absolute private `BACKUP_DIR` outside the checkout (0700 on
   POSIX, equivalent restrictive Windows ACLs). Review `BACKUP_KEEP` explicitly.
2. Invoke the existing `node scripts/src/ops/backup.mjs`. It uses a held snapshot,
   exclusively creates the dump, verifies its TOC, syncs files and publishes a
   version-2 manifest before recording success. Retain the producer's manifest
   SHA-256 in a separately access-controlled job record. A sidecar supplied
   alongside an archive is not an independently trusted digest. Preserve
   nonzero exit status and restricted diagnostic logs; do not continue a failed
   job as though the backup succeeded.
3. Copy the complete dump/manifest/checksum bundle to **private off-box storage**
   using the owner's approved transfer tool. Encrypt in transit and at rest;
   retain decryption keys independently, enforce least-privilege private access,
   and agree retention, immutability/versioning, deletion approval, capacity and
   residency before activation. Verify the destination bytes/checksums and retain
   a private transfer receipt. Local `BACKUP_KEEP` is not off-box retention.
   A failed upload or remote checksum check fails the overall backup job even
   when its local heartbeat succeeded. Do not prune an unreplicated bundle.
   The existing backup tool prunes locally on successful completion, before
   off-box transfer; set sufficient `BACKUP_KEEP` headroom and block subsequent
   backup jobs until any failed replication is resolved. The scheduler must
   check replication backlog before invoking the tool, not after local pruning.
4. Never upload production dumps, manifests, catalog snapshots or recovery
   logs to **public GitHub Actions artifacts**, releases, repository commits,
   caches or public object buckets. CI round trips must remain synthetic and
   disposable. Prefer a separately approved private runner/storage boundary for
   production; repo visibility is not a backup access-control policy.
5. Download an approved retained bundle from private off-box storage to a private
   runner directory and verify its independently retained manifest digest.
   `BACKUP_MANIFEST` must reference that manifest and `BACKUP_MANIFEST_SHA256`
   must come from the trusted producer record, not a freshly computed untrusted
   download. The existing tool accepts only a backup less than 24 hours old;
   plan the monthly drill immediately after a verified fresh backup/replication.
   An older-retention recovery test needs a separate reviewed procedure, not a
   bypass of the safe tool's freshness gate.
6. Provision a separately approved isolated scratch PostgreSQL endpoint. Set
   `DRILL_DATABASE_URL`, an appropriate maintenance `DRILL_ADMIN_URL`,
   `DRILL_DATABASE_DISPOSABLE=1`, and `DRILL_CONFIRM_TARGET` to the exact fresh
   `meridian_drill_<unique>` database name. Verify the endpoint is isolated,
   never the production/source cluster. Supply the required roles/extensions;
   block restored application workers and outbound provider/notification access.
   The tool enforces a fresh database name but does not require a separate host;
   isolation is the approving operator's responsibility.
7. Invoke `node scripts/src/ops/restore-drill.mjs`. It restores the retained
   archive, checks backup-time catalog/security, database properties, extensions,
   roles/runtime login and every table count, then records success in the
   existing source heartbeat. It necessarily uses the source `DATABASE_URL`
   for identity/evidence; this is not a read-only operation. Any failure must
   stop the job. The drill database is retained for inspection and never dropped
   by this tool; assign private cleanup after review, including partial failures.
8. Only after manual backup, replication and isolated restore evidence are
   accepted may the owner separately enable schedules. Wrap the **existing**
   commands in the approved scheduler with non-overlap and an overall deadline
   (for example 30 minutes for backup, 45 minutes for drill, reviewed against
   expected size). The tools bound dump/restore calls but not every `psql` call;
   configure connection timeouts and the external whole-job deadline. Treat
   timeouts as failures and inspect retained files/databases/locks before retry.

## Outstanding activation evidence

| Blocked item                            | Owner                                  | Required next evidence                                                                                                                                                                                    |
| --------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| External endpoint proof                 | Deployment owner / platform operations | Approved runner, target, independently pinned deployed revision and metrics signing credentials; a real sanitized run with exit status.                                                                   |
| Production backups                      | Database operations                    | Approved source access, private external runner, retention policy and a real safe-tool completion.                                                                                                        |
| Private off-box recoverability          | Database operations / security owner   | Approved encrypted destination, independent trusted digests, successful replication and isolated restore from downloaded bytes.                                                                           |
| Durable backup/drill failure visibility | Platform operations                    | Fixture-tested failure recording is implemented; approved job-status/log review remains required for unavailable source databases, process termination, preflight refusals and off-box transfer failures. |
| Live provider validation                | Provider integration owner             | Real provider credentials, approval, accreditation where required and private actual validation evidence; configured settings are insufficient.                                                           |
| Advisory inbox / moderated users        | Advisory operations / product research | Approved receive/reply test or actual participant sessions with dated private supporting reports.                                                                                                         |
| External schedules / notifications      | Deployment owner                       | Separate explicit activation and notification approval after manual proof; neither is enabled here.                                                                                                       |

See [Operations](operations.md), [Release readiness](release-readiness.md) and
[Workspace and provider readiness](workspace-and-provider-readiness.md) for the
unchanged deployment and provider contracts.
