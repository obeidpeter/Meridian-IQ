# Reliability R198: Workers, Database and Clerk

Scope: F06, F08, F11-F15. No schema export index, migration registry, generated API,
OpenAPI, lockfile, scripts or CI files are owned by this change.

## Integration Requirements

- Register `migration0053` from `lib/db/src/migrations/0053_clerk_reservations.ts`.
  It creates the table and index itself, grants access and installs FORCE RLS with
  a bypass-only policy. It supports migrations-only production releases; no push
  is required. Export `clerkReservationsTable` from the schema index for schema
  tooling. The runtime uses explicit SQL and does not depend on that export.
  The Drizzle definition enables RLS and declares the same named
  `meridian_bypass_only` policy. Migration 0053 explicitly revokes DELETE after
  migration 0001's broad grants, preserving uncertain spend and settled evidence.
  Registration, exports and recovery router mounting have been reported complete
  by the parent; they remain parent-owned integration changes.
- The parent-owned API shutdown `closePool` callback in `src/index.ts` now uses
  `closeDatabasePools()`. Both application and dedicated worker-lock pools close,
  after `stopWorker()` and bounded `awaitWorkerIdle()`.
- Mount the default router from `src/routes/clerk-reservations.ts` alongside the
  existing operator routes (under the usual authenticated `/api` middleware).
  It exposes GET `/operator/clerk-reservations` and POST
  `/operator/clerk-reservations/:id/reconcile`, with service-level operator checks.
  `docs/clerk-reservations-r198-openapi.yaml` supplies the paths/components for the
  parent-owned OpenAPI merge and code generation.
- Explicitly set `ENABLE_DEV_AUTH=true` only in isolated test/development processes
  that intentionally use `x-mock-*` headers. In particular, review API subprocess
  environments in `scripts/src/e2e/run.mjs`, `scripts/src/e2e/ux-snapshot.mjs`, and
  CI API-server test/build runners. `NODE_ENV=development` or `test` alone no longer
  enables impersonation. Production, preview, staging, unset and misspelled modes
  never enable it, even with the flag. Do not enable it for public previews.
- Run the DB-backed tests listed below against the disposable migrated database.
  Migration rollback is a compatible no-op: table, rows, grants and policies stay
  intact. Old code ignores the additive table but still counts its ledger charges.

## Webhook Recovery

Delivery keys `(webhook_id, event_key)` are the durable progress ledger. Each source
selects the oldest missing eligible keys, ordered by `(created_at, source id, webhook
id)`, without OFFSET. An anti-join skips already-enqueued keys and the existing
unique index fences concurrent insertion. There is no age cutoff and no advancing
timestamp/sequence watermark to skip an older transaction that commits late.

Each pass inserts at most 250 lifecycle and 250 audit deliveries (the testable
argument is validated within 1-1000). Registration cutoff, active subscription
checks, firm boundaries, pointer-only payloads, claimed retries, dead-letter status
and retry counters are unchanged. Historical events older than registration never
become eligible. Re-enabling a subscription can catch up its post-registration
backlog; disabling it prevents dispatch. Delivery-key rows must not be purged while
their source events remain replayable, or fanout would enqueue those keys again.

`meridian_webhook_fanout_oldest_age_seconds{source}` measures the oldest candidate
in the latest bounded batch. It is not a full backlog count. Larger retained ledgers
may require source-specific covering indexes after EXPLAIN/measurement; server
statement deadlines bound scans, and an error rolls back rather than losing work.

## Sweep Ownership

A timeout still ends the orchestration wait and allows later siblings in that pass
to run. It also aborts the sweep's optional `AbortSignal` (registration must opt in
with `acceptsSignal: true`; legacy optional dependency arguments stay untouched). It does not claim to cancel
arbitrary promises. The underlying task remains in the per-name in-flight map and
shutdown set until actual success or failure, including a late rejection.

The scheduled pass retains its local guard and PostgreSQL session advisory lock
until all owned tasks settle. Consequently, one non-cooperative hung sweep prevents
a new compliance pass even after the caller has received the timeout report. Drain
and reconciliation have independent ownership and continue. This conservative
tradeoff avoids unowned overlapping side effects without adding generic leases.

Sweep/reconcile lock sessions use a separate pool (default 2, maximum 4), not HTTP
pool capacity. A lost lock connection stops further worker scheduling and aborts
cooperative sweeps. Already-issued provider effects still need their existing
idempotency keys: a lost PostgreSQL session is not a fencing token for a remote
service. Stronger cross-service fencing needs handler-specific contracts and is
not claimed here. Shutdown timeout still bounds process exit for non-cooperative
work, while `awaitWorkerIdle()` accurately reports it as outstanding.

## Database Bounds

| Environment                      | Default |                            Allowed |
| -------------------------------- | ------: | ---------------------------------: |
| `PGPOOL_MAX`                     |      20 |                              4-100 |
| `PG_WORKER_LOCK_POOL_MAX`        |       2 |                                2-4 |
| `PG_CONNECT_TIMEOUT_MS`          |    5000 |                          100-10000 |
| `PG_STATEMENT_TIMEOUT_MS`        |   15000 |                         100-120000 |
| `PG_LOCK_TIMEOUT_MS`             |    2000 | 50-30000, below statement deadline |
| `PG_IDLE_TRANSACTION_TIMEOUT_MS` |   30000 |                        1000-120000 |

Budget total database connections per API process as `PGPOOL_MAX +
PG_WORKER_LOCK_POOL_MAX`, plus migration/admin headroom, multiplied by replicas.
These deadlines are PostgreSQL session settings, not a client-only Promise race.
A blocked query is cancelled by the server before rollback reuses the connection.
Connection URL/PGOPTIONS deadline overrides are rejected so they cannot silently
disable validated bounds. Long administrative statements must use a separate
reviewed migration connection/configuration, not raise runtime limits blindly.
References: [node-postgres client settings](https://node-postgres.com/apis/client),
[PostgreSQL timeouts](https://www.postgresql.org/docs/current/runtime-config-client.html).

Pool metrics include active/idle/total/max connections, queue depth, oldest pending
acquisition age, acquisition time/count/failures, and idle errors, labeled only by
`application` or `worker`. Idle errors are handled without logging URLs, SQL or
server-provided detail. The oldest acquisition age includes connection creation.
Readiness uses the same bounded connection and server query deadlines.

## Clerk Reservations

At most one local admission per firm and `min(4, floor(PGPOOL_MAX/4))` globally may
proceed (minimum 1). Excess callers receive `CLERK_BUSY` before acquiring a budget
connection; there is no unbounded lock queue. A short independent transaction uses
`pg_try_advisory_xact_lock` for firm serialization, checks actual spend and durable
unsettled reservations, then inserts a reservation. It releases the session before
completion, embedding or transcription provider work begins.

The existing one-provider-call-per-firm budget discipline is retained across
instances. Provider usage estimates are admission estimates, not a claim that token
usage can be predicted exactly; actual reported usage remains authoritative and
can exceed the estimate for a single call, as before. A later admission reads that
actual charge. Settlement appends the inference ledger and marks the reservation
settled in one independent transaction, surviving ambient request rollback.
Repeated settlement is single-use. A failed append cannot clear its reservation.

Reservation `expires_at` is an operational stale-work deadline (5 minutes), not an
automatic refund. After a crash or lost settlement, the reservation remains
unsettled and that firm's further AI calls fail closed, including across a UTC
month boundary. No connection stays checked out; other firms and ordinary requests
can proceed. Operators can list stale reservations, confirm provider execution has
stopped, and reconcile with a reason through the authenticated recovery route.
Reconciliation charges at least the reserved amount (optionally more), appends an
operator-attributed audit event and marks settlement atomically. Duplicate requests
return the same ledger ID. It rejects active/local in-flight work and cannot refund
uncertain spend. Late provider settlement uses a separate provider-call ID and
charges only usage above the prior conservative charge in the same UTC month,
once; prior-month charges cannot offset this month's actual usage. A lower actual
usage does not silently refund the operator's conservative charge.
Do not delete unresolved reservations or refund solely because a timer
expired: a provider may have spent tokens even if its response was lost. Automatic
provider reconciliation requires provider-specific request IDs and is not invented
by this change. `CLERK_BUSY` with reason `unsettled` is counted for alerting.

The gateway intentionally does not use ambient `withTransaction()` for spend
settlement. A failed user transaction must not erase already-spent provider tokens.
Manual workflows are unaffected by a Clerk admission refusal.

## Audit Decision

Keep the single global hash chain and transaction-scoped advisory lock. Releasing
a savepoint cannot release an outer transaction's chain lock. No measured load
evidence currently justifies tenant partitions or a separate sequencer, and simply
unlocking before commit can fork evidence. The new histogram measures lock
acquisition wait; failures are counted and propagate, without inserting evidence.
The server lock deadline bounds waiters and idle-transaction deadlines bound idle
holders, but the histogram is not the outer transaction's total hold duration.

Measure `meridian_audit_lock_wait_seconds`, lock failures, pool queue/oldest-wait,
and `pg_stat_activity`/`pg_locks` during a representative long import plus another
firm's short audited write. Keep remote I/O outside audited transactions and place
audited transaction commits promptly. If contention persists, separately design
partitioned chains with verifiable global checkpoints; do not mutate this chain.

## F15 HTTP Boundary

`app.ts` installs an independent HTTP AsyncLocalStorage marker immediately after
pino, before authentication. It clears any inherited database scope, retains the
correlation context, and never clears the HTTP marker on response completion:
detached descendants remain fail-closed. `getDb()` throws when that marker exists
without a live explicit database context. Route exemptions only skip the long
request transaction; they do not grant a raw database fallback.

Only credential, session-epoch and membership lookups use
`getSystemDb("authentication")`. Principal resolution closes that raw-access phase
before both normal and error dispatch. An existing context is returned unchanged,
not elevated. `withTransaction(fn)` retains the parent's ambient savepoint behavior
and tracks parent lifetimes: both fresh lookups and cached query execution in a
suspended child fail after any ancestor ends. New explicit contexts reject stale
parents too.
Database-only shared stages preserve existing caller atomicity with
`withDatabaseContext`; missing scopes must specify firm/bypass explicitly.

Exempt-path audit:

| Paths                                                               | Database boundary                                                                                                 |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| healthz, metrics                                                    | No database reads; readiness uses its explicit bounded SELECT 1 probe                                             |
| password reset; public advisory/access/usability                    | Existing short password-reset scopes and independent throttles; relay I/O outside scopes                          |
| connection tests                                                    | Configuration/probe only; shared feature gates now own short scopes                                               |
| Clerk capture/batch/ask/drafts/retry/narration                      | Firm-pinned stages; explicit operator retry read; batch claim/fence writes and shared gates scoped                |
| Clerk eval/canary/intent/phrasing/retrieval                         | Corpus/result database stages scoped separately from provider I/O                                                 |
| statements                                                          | Explicit firm-scoped access/consent prechecks; existing atomic ingest scope retained                              |
| inbound email/WhatsApp                                              | Existing queue scopes; allowance reads and audit appends now explicitly scoped                                    |
| billing/collections/invoice-room provider and public session routes | Existing reservation/finalization and token-derived scopes retained                                               |
| bulk approve/submit, action execute, plan runs                      | Existing per-item caller scopes retained                                                                          |
| internal sweep                                                      | HTTP marker retained; gauge/watchdog/retention/batch reads and notification database stages now explicitly scoped |

The global audit chain is unchanged. An append without an ambient context opens
its own short explicit bypass transaction; an append inside a business transaction
still participates in that transaction and does not release the chain lock early.
Cross-origin callers on already-allowed origins can read X-Operation-Id,
Idempotency-Replayed and X-Request-Id; origin restrictions are unchanged.

Outside HTTP, the raw `getDb()` fallback remains transitional for boot, worker and
fixture callers. This is not a claim that all raw `db`/`pool` imports have been
eliminated: independent spend accounting, throttling, readiness and orchestration
lock sessions remain explicit specialized uses. Follow-up: enforce an import
allowlist, separate migration/runtime credentials and retire boot privilege repair.
Agent5/parent should run end-to-end HTTP tests against the migrated disposable DB.

### Execution and Connection Lifetimes

The installed Drizzle 0.45.2 node-postgres driver was inspected: raw, select,
relational and prepared query execution ultimately dispatch through the captured
`client.query`. `ScopedTransaction` supplies a narrow query-only client facade
that synchronously checks its lifetime and every ancestor before dispatch. This
protects cached handles and prebuilt queries without proxying builders or Promises.
Both direct `.transaction()` and ambient `withTransaction()` create child
lifetimes; completing a child revokes its handles even while its parent stays live.

The root context privately owns the physical client. It revokes application
dispatch before COMMIT/ROLLBACK and returns the client only after terminal cleanup
finishes. Failed BEGIN/rollback and connection errors destroy rather than recycle
the client. Nested RELEASE/ROLLBACK TO uses the parent's guarded session; if any
ancestor has ended, no savepoint cleanup reaches the physical connection. Root
transaction cleanup already resolves those savepoints.

Already-dispatched SQL is not claimed to be instantly cancelled: node-postgres
queues terminal cleanup behind it, so it can finish while the original context
still owns the connection, bounded by the configured server deadlines. No new
application SQL from the expired context can dispatch during cleanup or touch a
returned/reused connection. These guarantees apply to managed context handles,
not the explicitly documented specialized raw imports above.

Transport tests exercise real Drizzle builders/sessions, cached and prepared
queries, normal completion, timeout, nested success/failure, expired middle
ancestors, connection reuse, queued in-flight SQL and failed cleanup. The separate
`context-lifecycle.integration.test.ts` requires PostgreSQL, asserts that the next
transaction reuses the same backend PID, and verifies that stale queries and late
savepoint cleanup neither replace its tenant GUC nor abort its transaction. It is
included by the existing DB package test glob and has no environment-based skip.

### Sibling Savepoints

A parent permits only one active child transaction. Admission is reserved
synchronously before SAVEPOINT dispatch and remains held until RELEASE or
ROLLBACK TO completes, including failed savepoint creation and error cleanup.
A concurrent sibling rejects before its callback or any SQL executes; there is
no unbounded queue or re-entrant serialization deadlock. True nesting through
the child handle, or through its ambient `withTransaction` context, remains valid.
Distinct savepoint names alone would not fix this: rolling back an earlier
savepoint also rolls back later writes on the same PostgreSQL transaction stack.

Caller audit found invoice create/update/approval routes await one operation;
import, recurring invoices, connector imports and Clerk plan drafting use awaited
loops or independent per-item contexts, not sibling `Promise.all` transactions.
The inspected `Promise.all` read-model callers do not open child transactions.
Buyer bulk confirmation and its notification callback previously opened a direct
savepoint while leaving downstream `getDb()` bound to the parent. They now use
`withTransaction`, so downstream audit savepoints are genuine descendants instead
of colliding siblings. Other direct callbacks (audit, claim approval and invoice
draft persistence) use their passed transaction handles and do not call nested
ambient transaction services.

Runtime transport tests cover immediate overlap, blocked SAVEPOINT, suspended
callback, blocked success/failure cleanup, failed opening, mixed direct/ambient
entry points and valid deeper nesting. The PostgreSQL regression additionally
checks table contents: rejected siblings never write, a failed child rolls back
only its own writes, and a later sequential child's writes survive. These tests
do not claim that arbitrary writes on a cached parent handle during an active
child are isolated: callers must await that child before doing sibling work.

### Integration Compatibility Review

Import ordering/isolation tests previously mocked the raw database's transaction
method. Managed roots now acquire `pool.connect()`, so those mocks were stale.
They now mock only client query transport and retain assertions for one buyer
lock, lock-before-read order, tenant/actor SQL predicates, rejected snapshot
isolation, and zero data queries for invalid/dry-run batches. API test client
types are derived from the exported pool; no undeclared `pg` dependency is added.

`request-context.integration.test.ts` runs the actual app middleware against a
fake transport, forbidding all raw/worker queries. It checks buffered response
commit, exempt missing-context rejection, authentication phase closure, client
disconnect, the actual request timeout callback with a mock clock, cached handle
rejection and late nested cleanup against the next borrower's connection. The
lighter `appFor` harness remains intentionally a route-only harness, not evidence
that HTTP tenant middleware ran.

`release-reliability.integration.test.ts` uses the main app and explicitly enables
isolated test authentication before importing it. Teardown now closes both pools.
Its concurrent HTTP commands have independent request contexts, not sibling
savepoints. CI provides `DATABASE_URL` and `E2E_DATABASE_DISPOSABLE=1`, runs API and
DB test globs, then the migration-only upgrade rehearsal. The latter recreates
50-54 inside a transaction that rolls back and compares financial rows and
canonical security catalogs. The separate DB rollback ladder also exercises
migration53's retained-table rollback behavior.
No execution against PostgreSQL was possible locally; this is readiness review,
not a claim that the database-backed release/upgrade tests have passed.

## Owned File Inventory

Exact files changed by this agent, relative to the worktree. Parent-owned schema
exports, migration registration, generated contracts, CI and installs are excluded.

```text
artifacts/api-server/src/app.ts
artifacts/api-server/src/lib/metrics.ts
artifacts/api-server/src/middleware/principal.ts
artifacts/api-server/src/middleware/principal.test.ts
artifacts/api-server/src/modules/audit/audit.ts
artifacts/api-server/src/modules/audit/audit-contention.test.ts
artifacts/api-server/src/modules/auth/session.ts
artifacts/api-server/src/modules/buyer/service.ts
artifacts/api-server/src/modules/clerk/advisory-brief.ts
artifacts/api-server/src/modules/clerk/batch-async.ts
artifacts/api-server/src/modules/clerk/budget.ts
artifacts/api-server/src/modules/clerk/budget-admission.test.ts
artifacts/api-server/src/modules/clerk/budget-recovery.ts
artifacts/api-server/src/modules/clerk/budget-recovery.test.ts
artifacts/api-server/src/modules/clerk/budget.test.ts
artifacts/api-server/src/modules/clerk/cases/lifecycle.ts
artifacts/api-server/src/modules/clerk/claims.ts
artifacts/api-server/src/modules/clerk/client-statement.ts
artifacts/api-server/src/modules/clerk/digest.ts
artifacts/api-server/src/modules/clerk/eval.ts
artifacts/api-server/src/modules/clerk/gateway.ts
artifacts/api-server/src/modules/clerk/intent-eval.ts
artifacts/api-server/src/modules/clerk/memory.ts
artifacts/api-server/src/modules/clerk/monthly-rail.ts
artifacts/api-server/src/modules/clerk/narration-match.ts
artifacts/api-server/src/modules/clerk/phrasing-eval.ts
artifacts/api-server/src/modules/clerk/prompt-canary.ts
artifacts/api-server/src/modules/clerk/provider.ts
artifacts/api-server/src/modules/clerk/retention.ts
artifacts/api-server/src/modules/clerk/scope.ts
artifacts/api-server/src/modules/clerk/watchdog.ts
artifacts/api-server/src/modules/flags/flags.ts
artifacts/api-server/src/modules/inbound/shared.ts
artifacts/api-server/src/modules/integrations/api-keys.ts
artifacts/api-server/src/modules/integrations/webhooks.ts
artifacts/api-server/src/modules/integrations/webhooks.test.ts
artifacts/api-server/src/modules/invoice/confirmations.ts
artifacts/api-server/src/modules/invoice/import.test.ts
artifacts/api-server/src/modules/messaging/fan-out.ts
artifacts/api-server/src/modules/messaging/messaging.ts
artifacts/api-server/src/modules/pipeline/pipeline.ts
artifacts/api-server/src/modules/pipeline/sweeps.test.ts
artifacts/api-server/src/modules/pipeline/sweep-ownership.test.ts
artifacts/api-server/src/modules/push/push.ts
artifacts/api-server/src/routes/clerk-reservations.ts
artifacts/api-server/src/routes/statements.ts
artifacts/api-server/src/release-reliability.integration.test.ts
artifacts/api-server/src/request-context.integration.test.ts
docs/clerk-reservations-r198-openapi.yaml
docs/reliability-r198-workers.md
docs/USER_MANUAL.md
lib/db/src/client.ts
lib/db/src/client.test.ts
lib/db/src/connection-config.ts
lib/db/src/connection-config.test.ts
lib/db/src/connection-deadlines.test.ts
lib/db/src/context.ts
lib/db/src/context.test.ts
lib/db/src/context-lifecycle.integration.test.ts
lib/db/src/scoped-transaction.ts
lib/db/src/migrations/0053_clerk_reservations.ts
lib/db/src/schema/clerk-reservations.ts
lib/db/src/schema/clerk-reservations.test.ts
```

## Verification Commands

Run from the worktree using installed executables, without starting an install:

```powershell
node node_modules/tsx/dist/cli.mjs --test lib/db/src/connection-config.test.ts lib/db/src/client.test.ts artifacts/api-server/src/middleware/principal.test.ts artifacts/api-server/src/modules/pipeline/sweeps.test.ts artifacts/api-server/src/modules/clerk/budget-admission.test.ts
node node_modules/tsx/dist/cli.mjs --test lib/db/src/context.test.ts lib/db/src/schema/clerk-reservations.test.ts artifacts/api-server/src/routes/clerk-route-posture.test.ts
node node_modules/typescript/bin/tsc -p lib/db/tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p artifacts/api-server/tsconfig.json --noEmit
node node_modules/tsx/dist/cli.mjs --test artifacts/api-server/src/request-context.integration.test.ts
node node_modules/tsx/dist/cli.mjs --test --test-name-pattern="bulk all-invalid|per-row and bulk imports lock|snapshot isolation is rejected|dry runs do not open" artifacts/api-server/src/modules/invoice/import.test.ts
```

Local results: 49 focused tests passed (zero skipped), including cached/prebuilt
query and suspended nested cleanup regressions. Standard DB and API package
typechecks and targeted ESLint for the lifecycle implementation/tests passed.
Owned-file `git diff --check` passed across all 63 listed files.
No DATABASE_URL is present
in this agent's shell, so real PostgreSQL deadline/lock/backlog/recovery/audit tests
are implemented but require parent execution. Do not treat those as runtime proof.

With the disposable migrated `DATABASE_URL`, run serially:

```powershell
node node_modules/tsx/dist/cli.mjs --test --test-concurrency=1 --test-force-exit lib/db/src/context-lifecycle.integration.test.ts lib/db/src/connection-deadlines.test.ts artifacts/api-server/src/modules/integrations/webhooks.test.ts artifacts/api-server/src/modules/pipeline/sweep-ownership.test.ts artifacts/api-server/src/modules/pipeline/pipeline.test.ts artifacts/api-server/src/modules/clerk/budget.test.ts artifacts/api-server/src/modules/clerk/budget-recovery.test.ts artifacts/api-server/src/modules/clerk/clerk-hardening.test.ts artifacts/api-server/src/modules/audit/audit-contention.test.ts artifacts/api-server/src/modules/audit/audit.test.ts
```
