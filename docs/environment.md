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

`SWEEP_URL`, `SWEEP_TIMEOUT_MS`, `SWEEP_RATE_LIMIT_PER_MIN`,
`OUTBOX_LEASE_MS`, `OUTBOX_MAX_BACKOFF_MS`, `OUTBOX_RETRY_HORIZON_MS`,
`SCHEDULED_WORK_MAX_AGE_MS`, `BACKUP_MAX_AGE_MS`,
`RESTORE_DRILL_MAX_AGE_MS`, `OUTBOX_RELEASE_MAX_AGE_SECONDS`,
`MESSAGES_RETENTION_DAYS`, `ADVISORY_INBOX_VERIFIED_AT`,
`ADVISORY_INBOX_MAX_AGE_MS`, `USABILITY_VALIDATED_AT`,
`USABILITY_MAX_AGE_MS`, `USABILITY_EVIDENCE_REF`.

Timestamp evidence uses ISO 8601. Future, malformed, missing, or stale
evidence warns in non-production and blocks where production policy requires.

## Backup and Release Tooling

`BACKUP_DIR`, `BACKUP_KEEP`, `DRILL_DATABASE_URL`, `DRILL_ADMIN_URL`,
`RELEASE_BACKUP`, `RELEASE_PUSH_FORCE`.

`DRILL_DATABASE_URL` must identify a disposable database. Keep backups outside
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

## Adding a Variable

1. Give it one owner and a safe unset/default behavior.
2. Validate type, bounds, and allowed values at the trust boundary.
3. Document whether it is secret and whether production requires it.
4. Add it here and to `.env.example` only when local setup needs it.
5. Add startup/readiness tests for security-critical configuration.
