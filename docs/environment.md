# Environment Reference

Environment variables are deployment configuration, not feature entitlement.
Secrets must come from the local untracked `.env` file or the deployment
secret store. An unset integration credential keeps that integration dark or
fail closed unless a section below says otherwise.

## Core Runtime

| Variable              | Purpose                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------- |
| `NODE_ENV`            | `development`, `test`, or `production`; production enables strict startup and readiness behavior. |
| `DATABASE_URL`        | PostgreSQL 16 connection string. Required by the API, migrations, and DB tests.                   |
| `PORT`                | Process/dev-server port. Web apps have checked-in local defaults.                                 |
| `PUBLIC_APP_URL`      | Canonical public origin used for links and redirects.                                             |
| `BASE_PATH`           | Web bundle mount path; must start and end with `/`.                                               |
| `API_URL`             | E2E/mobile API origin override.                                                                   |
| `LOG_LEVEL`           | Structured server log level.                                                                      |
| `PGPOOL_MAX`          | Maximum application database pool size.                                                           |
| `SHUTDOWN_TIMEOUT_MS` | Graceful shutdown budget.                                                                         |

## Build and Hosting Identity

`BUILD_REVISION`, `EXPECTED_BUILD_REVISION`, `COMMIT_SHA`, `GITHUB_SHA`,
`REPLIT_GIT_SHA`, `REPLIT_DEPLOYMENT_ID`, `REPL_ID`, `REPLIT_DEV_DOMAIN`,
`REPLIT_DOMAINS`, `REPLIT_INTERNAL_APP_DOMAIN`, `EXPO_PUBLIC_REPL_ID`,
`EXPO_PUBLIC_DOMAIN`, `REPLIT_EXPO_DEV_DOMAIN`, `FRAME_ANCESTORS`, `OUT_DIR`.

The expected and actual revisions drive release-readiness and stale-build
detection. `FRAME_ANCESTORS` is a CSP source list, not a URL. Keep production
origins explicit.

## Authentication and Security

| Variable                      | Purpose and handling                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------- |
| `SESSION_SIGNING_KEYS`        | Rotatable `id:secret` cookie-signing ring. Preferred in production.                                     |
| `SESSION_SECRET`              | Single signing secret fallback. Production requires a signing configuration.                            |
| `CLERK_SECRET_KEY`            | External Clerk authentication secret where configured; secret-store only.                               |
| `CLERK_AUTHORIZED_PARTIES`    | Authorized Clerk middleware parties/origins.                                                            |
| `ENABLE_DEV_AUTH`             | Enables development-only authentication. Never set in production.                                       |
| `DEMO_PASSWORD`               | Local seeded-account password. Never reuse a real password.                                             |
| `SEED_DEMO`                   | Creates local/demo fixtures. Keep off for production data.                                              |
| `TOTP_REQUIRED_ROLES`         | Comma-separated roles requiring TOTP; production baseline includes operator, firm admin, and bank user. |
| `PASSWORD_KDF_CONCURRENCY`    | Concurrent password-hash limit.                                                                         |
| `PASSWORD_KDF_MAX_QUEUE`      | Bounded waiting queue for password hashing.                                                             |
| `LOGIN_IP_ATTEMPT_MAX`        | Aggregate login attempts per IP/window.                                                                 |
| `RATE_LIMIT_GENERAL_PER_MIN`  | Authenticated general request limit; `0` disables and is not recommended.                               |
| `RATE_LIMIT_MODEL_PER_MIN`    | Model-capacity route limit; `0` disables and is not recommended.                                        |
| `OP_SIGNATURE_WINDOW_SECONDS` | Accepted HMAC request timestamp window.                                                                 |
| `OP_LEGACY_TOKENS`            | Temporary legacy plain-token compatibility. Must remain off in production.                              |

Machine credential rings and compatibility test names:

`METRICS_TOKEN`, `SWEEP_TOKEN`, `SWEEP_KEYS`, `SWEEP_KEY_ID`,
`SWEEP_KEY_SECRET`, `TEST_OP_TOKEN`, `SIGNED_TEST_KEYS`, `SIGNED_TEST_TOKEN`,
`RING_TEST_KEYS`, `RING_TEST_TOKEN`.

The `*_TEST_*` variables are test-only. Never configure them as production
credentials.

## Clerk AI

| Variable                          | Purpose                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------ |
| `AI_INTEGRATIONS_OPENAI_API_KEY`  | Model-provider key, loaded only by Clerk provider wiring.                      |
| `AI_INTEGRATIONS_OPENAI_BASE_URL` | Approved provider endpoint override. Validate SSRF and data-residency posture. |
| `CLERK_MODEL`                     | Default registered model.                                                      |
| `CLERK_MODEL_TIERS`               | Purpose/tier model mapping.                                                    |
| `CLERK_EMBEDDING_MODEL`           | Retrieval embedding model.                                                     |
| `CLERK_FIRM_MONTHLY_TOKENS`       | Default monthly firm token budget.                                             |
| `CLERK_COST_PER_1M_INPUT_USD`     | Input-token cost used for spend reporting.                                     |
| `CLERK_COST_PER_1M_OUTPUT_USD`    | Output-token cost used for spend reporting.                                    |
| `CLERK_CONTENT_RETENTION_DAYS`    | Content retention horizon.                                                     |
| `CLERK_STUCK_PENDING_MINUTES`     | Pending-case watchdog threshold.                                               |
| `CLERK_WATCHDOG_WINDOW_MINUTES`   | Watchdog observation window.                                                   |
| `CLERK_WATCHDOG_MIN_SAMPLE`       | Minimum sample before tripping.                                                |
| `CLERK_WATCHDOG_TRIP_RATE`        | Invalid/error-rate trip threshold.                                             |

Quality and regression alerts:

`QUALITY_ALERT_DROP_POINTS`, `QUALITY_ALERT_MIN_FIELDS`,
`RESISTANCE_ALERT_DROP`, `RESISTANCE_ALERT_MIN_FIXTURES`,
`RETRIEVAL_ALERT_DROP`, `RETRIEVAL_ALERT_MIN_RUNS`,
`PHRASING_ALERT_DROP`, `PHRASING_ALERT_MIN_RUNS`,
`AGREEMENT_ALERT_DROP_POINTS`, `AGREEMENT_ALERT_MIN_DECISIONS`,
`SPEND_ALERT_MIN_TOKENS`, `SPEND_ALERT_MULTIPLIER`.

## Background Work, Readiness, and Retention

`SWEEP_URL`, `SWEEP_TIMEOUT_MS`, `SWEEP_SETTLE_CEILING_MS`,
`SWEEP_RATE_LIMIT_PER_MIN`, `OUTBOX_LEASE_MS`, `OUTBOX_MAX_BACKOFF_MS`, `OUTBOX_RETRY_HORIZON_MS`,
`SCHEDULED_WORK_MAX_AGE_MS`, `BACKUP_MAX_AGE_MS`,
`RESTORE_DRILL_MAX_AGE_MS`, `OUTBOX_RELEASE_MAX_AGE_SECONDS`,
`MESSAGES_RETENTION_DAYS`, `ADVISORY_INBOX_VERIFIED_AT`,
`ADVISORY_INBOX_MAX_AGE_MS`, `USABILITY_VALIDATED_AT`,
`USABILITY_MAX_AGE_MS`, `USABILITY_EVIDENCE_REF`.

Timestamp evidence uses ISO 8601. Future, malformed, missing, or stale
evidence warns in non-production and blocks where production policy requires.

`SWEEP_SETTLE_CEILING_MS` (unset = twice the timed-out sweep's own timeout,
minimum 1000) bounds how long a sweep pass keeps its in-process guard and
distributed lock waiting for a timed-out sweep to settle. Past the ceiling the
pass records `meridian_sweep_errors_total{sweep="pass",kind="abandoned"}`,
raises one `ops.sweep.pass_abandoned` health alert per stuck sweep and releases
ownership so later passes can run; the abandoned work is still awaited at
shutdown, and a later pass skips a sweep that is still in flight.

## Backup and Release Tooling

`BACKUP_DIR`, `BACKUP_KEEP`, `BACKUP_RUNTIME_ROLE`, `BACKUP_MANIFEST`, `BACKUP_MANIFEST_SHA256`,
`DRILL_DATABASE_URL`, `DRILL_ADMIN_URL`, `DRILL_DATABASE_DISPOSABLE`, `DRILL_CONFIRM_TARGET`,
`RELEASE_BACKUP`, `RELEASE_PUSH_FORCE`.

`DRILL_DATABASE_URL` must identify a fresh disposable `meridian_drill_<unique>`
database, acknowledged by `DRILL_DATABASE_DISPOSABLE=1` and an exact
`DRILL_CONFIRM_TARGET` match. Existing databases are never dropped or reused.
`DRILL_ADMIN_URL`, when set, must use the same host/port and a maintenance database.
`BACKUP_DIR` is required, absolute and private. `BACKUP_MANIFEST_SHA256` must come
from the trusted backup producer independently, not from an untrusted sidecar.
`BACKUP_MANIFEST` identifies that retained archive's snapshot-consistent manifest.
The manifest must be format 2. `BACKUP_RUNTIME_ROLE` explicitly names the intended
non-superuser application login, whose recursive membership/SET ROLE capability
is captured and verified on the isolated target. It is not an inspection credential.
Format 2 also binds database owner/ACL/settings and exact extension/locale versions;
the target must match rather than applying compatibility overrides.
File and directory fsync support is mandatory; a sync error refuses publication.
The destination parent directory must already exist. PostgreSQL URL passwords
are removed from child argv and passed through child `PGPASSWORD`; password or
service query overrides are refused, and no password file is created. TLS
parameters and percent-encoded Unix-socket hosts remain intact.
Keep backups outside
the checkout and runtime directory. Force-push controls should remain unset.

## Authority Rails

`RAIL_PRIMARY_URL`, `RAIL_PRIMARY_TOKEN`, `RAIL_SECONDARY_URL`,
`RAIL_SECONDARY_TOKEN`, `RAIL_ENVIRONMENT`, `RAIL_TIMEOUT_MS`,
`RAIL_OPEN_COOLDOWN_MS`, `RAIL_ACCREDITATION_CONFIRMED`,
`REQUIRE_LIVE_RAILS`, `FAKE_RAIL_TOKEN`.

Live mode requires HTTP transport configuration for both rails and explicit
accreditation evidence. `FAKE_RAIL_TOKEN` is test-only.

## Messaging and Inbound Webhooks

`INBOUND_EMAIL_TOKEN`, `INBOUND_WHATSAPP_TOKEN`, `MESSAGING_WEBHOOK_URL`,
`MESSAGING_WEBHOOK_TOKEN`, `WEBHOOK_SECRET`.

Unset inbound tokens disable their public machine routes. Rotate shared
secrets after suspected disclosure and verify signature/replay behavior.

## ERP and Bank Feeds

`ERP_CONNECTOR_URL`, `ERP_CONNECTOR_TOKEN`, `BANK_FEED_URL`,
`BANK_FEED_TOKEN`.

Provider URLs must be controlled deployment configuration. Do not accept them
from request payloads. Tokens must never enter logs or browser bundles.

## Payments and Collections

`PAYMENT_PROVIDER_URL`, `PAYMENT_PROVIDER_TOKEN`, `PAYMENT_WEBHOOK_TOKEN`,
`INVOICE_PAYMENT_PROVIDER_URL`, `INVOICE_PAYMENT_PROVIDER_TOKEN`,
`INVOICE_PAYMENT_WEBHOOK_TOKEN`, `COLLECTION_PROVIDER_URL`,
`COLLECTION_PROVIDER_TOKEN`, `COLLECTION_WEBHOOK_TOKEN`,
`INVOICE_ROOM_ENCRYPTION_KEY`.

Provider-backed creation reserves idempotency before network I/O. Webhook
credentials are distinct from browser credentials. Invoice Room activation
also requires `PUBLIC_APP_URL`.

## Credit Governance

`CREDIT_BANK_MOU_REFERENCE`, `CREDIT_COLLECTION_FEED_AGREEMENT_REF`,
`CREDIT_COHORT_MIN_SIZE`.

These record evidence; they do not independently enable R3. Feature flags and
all governance checks must pass before bank Data Room activation. R4 financing
remains outside the active scope.

## Load, E2E, and UX Tests

`E2E_API_PORT`, `E2E_WEB_PORT`, `E2E_RAIL_PORT`, `E2E_HOOK_PORT`,
`UX_API_PORT`, `UX_WEB_PORT`, `PLAYWRIGHT_EXECUTABLE_PATH`,
`LOAD_SMOKE_CONCURRENCY`, `LOAD_SMOKE_REQUESTS_PER_ROUTE`,
`LOAD_SMOKE_P95_MS`.

These are test-process controls. CI owns stable values; local overrides should
use isolated ports and databases.

`LANDING_A11Y_BASE_URL` optionally points the public-page accessibility suite at
an existing loopback preview. Without it, the suite serves the built artifacts on
an isolated local port and closes that server afterward. The suite mocks only
public read-only session/readiness requests; this is not production verification.

## Release and Test Controls

Release verification uses `RELEASE_MANIFEST` (local CI manifest path),
`RELEASE_MANIFEST_SHA256` (checksum obtained from the trusted CI artifact record),
`RELEASE_ROLLBACK_REVISION` (full SHA of a reviewed compatible rollback build),
and `RELEASE_BASE_URL` (deployment origin for read-only postdeploy checks).
`RELEASE_TRAFFIC_DRAINED=1` is an operator assertion, not a traffic-control
mechanism: it is required for maintenance-forward/RUN and for the separate
explicit `--offline-bootstrap` path (which maintenance-forward refuses).
All web instances, workers, scheduled tasks and external writers must already
be stopped. `RELEASE_PUSH_FORCE` is retired and refused. `RELEASE_BACKUP` no
longer bypasses backup requirements; durable backup/restore evidence is mandatory.

Native Replit production descriptors read `release/build-manifest.json` from the
checkout and require `RELEASE_MANIFEST_SHA256` during every build verification
and API startup. Provide the checksum independently through trusted Publish
configuration; it is not a download credential and must not be client-bundled.
The API build additionally requires the existing production `DATABASE_URL` and
the selected recovery-mode configuration for mandatory read-only preflight. The
startup adapter sets `BUILD_REVISION` and `EXPECTED_BUILD_REVISION` from the
checksum-verified manifest before loading the API, overriding a stale value or
Replit deployment UUID. No new secret or download mechanism is introduced.

`RELEASE_RECOVERY_MODE` defaults to `rollback`, which requires the qualified
rollback SHA. Its explicit alternative is `maintenance-forward`, requiring
`RELEASE_RECOVERY_PLAN` and independently trusted `RELEASE_RECOVERY_PLAN_SHA256`
plus actual external drain evidence. Preparation approval is not a populated plan.

`RELEASE_PROFILE` selects the release path (R105): `pilot` (the default) starts
the verified CI artifact as RUN after the API build has synced the schema
(plain `push`, then the guardrail migrations; a destructive diff fails the
build), needs no recovery plan, permit or held evidence, and reads the manifest
checksum from CI's `release/build-manifest.json.sha256` sidecar when
`RELEASE_MANIFEST_SHA256` is unset; `RELEASE_RUNTIME_STATE=HOLD` is then a plain
maintenance switch. `governed` keeps everything below.

Under `governed`, `RELEASE_RUNTIME_STATE` defaults to `HOLD`. API HOLD and RUN require
`RELEASE_BASE_URL` matching the CI mobile domain and the mandatory
`RELEASE_TARGET_REPL_ID` matching the CI mobile Repl ID exactly,
and independently trusted `RELEASE_MANIFEST_SHA256`,
`RELEASE_RECOVERY_PLAN_SHA256` and `RELEASE_BACKUP_SHA256`. HOLD does not import
the API, connect to the database or check plan TTL at runtime.

`RELEASE_TARGET_REPL_ID` is a nonsecret, operator-configured stable app target.
Both it and `manifest.mobile.replId` must be lowercase UUIDs in canonical
8-4-4-4-12 form; missing or malformed values fail closed. Provide the same target
in Publish build/runtime configuration and the external postdeploy environment.
There is no fallback to `REPL_ID`, `EXPO_PUBLIC_REPL_ID` or the manifest itself.
Before setting it, independently verify and record the control-plane association
between the source app, selected production deployment and `RELEASE_BASE_URL`.
Matching configuration values are not provider attestation or proof of that
association. Do not copy a value merely to satisfy the check.

Provider `REPL_ID` is left unchanged and is not an authorization binding. It is
recorded separately as sanitized build/start diagnostics, not in maintenance
health or held/activation target identity. An external postdeploy process need
not have `REPL_ID`. Do not override provider identity or change authentication
or database credentials to configure the release target.

RUN additionally requires maintenance-forward, `RELEASE_TRAFFIC_DRAINED=1`,
`RELEASE_ACTIVATION_PERMIT`, `RELEASE_ACTIVATION_PERMIT_SHA256`,
`RELEASE_ACTIVATION_ID` (canonical UUID) and `RELEASE_HELD_EVIDENCE_SHA256`.
RUN promotion requires `RELEASE_HELD_EVIDENCE`; runtime only needs the verified
permit and digest bindings, not the plan/held-evidence files. Every Publish
checks approval TTL; later cold starts retain admission for the same bound
release. Repeat use of the active permit is one logical activation, not
single-use consumption. External ingress/schedules remain held until real API
readiness and operator signoff. Local evidence may only use fixed
`release/recovery-plan.json`, `release/held-evidence.json` and
`release/activation-permit.json`, or paths outside the checkout. These are not
client assets. See [HOLD/RUN operations](operations.md#hold-and-run).

The mobile release package reads the public production `EXPO_PUBLIC_DOMAIN`
and `EXPO_PUBLIC_REPL_ID` from `artifacts/mobile/eas.json`; it does not inherit
development host/Repl overrides. Its manifest also binds `/mobile/`, and mobile
startup rejects a different `BASE_PATH`. These public values are build inputs,
not secrets. Verify the actual expo-domain host/path in Replit before publishing.
`CI` set to `1` selects noninteractive native release export and refuses reuse of a
running Metro instance whose build configuration cannot be established. It is
not an authentication control or a substitute for trusted GitHub provenance.

`E2E_DATABASE_DISPOSABLE` must be `1` to acknowledge that `DATABASE_URL` is a
migrated scratch database. It is required for the main-app integration tests
and browser suite, including SQL failure injection. `E2E_RELIABILITY_ONLY`
selects one exported reliability journey by name for independent reproduction;
leave it unset in CI. `E2E_RELIABILITY_REVERSE` set to `1` reverses only the new isolated
journeys, not the legacy suite's documented shared-seed order.
`ENABLE_DEV_AUTH=true` is explicitly set by the main-app integration fixture
before importing the app. Browser journeys use real seeded login sessions.

`GITHUB_ACTIONS`, `GITHUB_SHA`, `GITHUB_RUN_ID`, `GITHUB_RUN_ATTEMPT` and
`GITHUB_REPOSITORY` are CI-provided provenance, not secrets. `GITHUB_OUTPUT` is
the CI-managed step-output file; the backup producer appends its trusted manifest
path/checksum there for the next restore step, never to tracked source. Manifest stamping
refuses non-CI execution. CI sets `BUILD_REVISION` to the full source SHA.
Do not manufacture CI variables to bless an untested local artifact.

`CATALOGUE_OUT_DIR` optionally selects the local state-catalogue build/report
directory (default `tmp/state-catalogue-r198`). It is not a secret or a production
setting. The harness rebuilds its `site` subdirectory; choose a dedicated scratch
path, never a directory holding source or customer data.

## Adding a Variable

1. Give it one owner and a safe unset/default behavior.
2. Validate type, bounds, and allowed values at the trust boundary.
3. Document whether it is secret and whether production requires it.
4. Add it here and to `.env.example` only when local setup needs it.
5. Add startup/readiness tests for security-critical configuration.
