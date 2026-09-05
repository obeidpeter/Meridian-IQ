# Issue 202: HTTP Scheduled Work

Status: implemented and locally verified. See the pull request for current PostgreSQL-backed CI and publication status. No production configuration, credentials, or data were changed.

## Cause

The external sweep route deliberately has no request-wide transaction. Its HTTP database marker remains active between the worker's short preparation and finalization transactions. Rail breaker reads and four reminder candidate reads used `getDb()` without an explicit context. These calls worked on the background timer's transitional non-HTTP fallback but failed closed under HTTP. Reminder preference reads had the same defect after a candidate was found.

The scheduler counted/logged individual failures but discarded their outcomes before answering the HTTP caller. A failed claim also looked like an empty queue. The E2E journey ignored sweep responses and exceeded the default sweep rate limit during its one-second polling loop.

## Changes

- Rail breaker reads use a short database context, preserving an existing caller context when present. Initialization and breaker writes retain their independent autocommit behavior. No rail network call is wrapped in a database transaction.
- Invoice, obligation, filing and WHT reminder candidate reads and shared preference reads use short explicit contexts. Claim-before-send ordering, engagement/consent/preferences gates and notification idempotency are unchanged.
- Sweep failure counts and drain/reconciliation failures reach the external trigger. Claim errors roll back and fail the guarded pass rather than masquerading as an empty queue.
- A full successful pass returns HTTP 200 with `status: ok`. Partial failures return HTTP 503 with `status: partial_failure`, aggregate failure counts and `Retry-After: 60`. Skipped/owned passes return HTTP 202 with `status: busy` and `Retry-After: 5` without clearing failure evidence. Responses contain no tenant identifiers or raw errors.
- Timed-out work retains its local/distributed ownership until actual settlement. Healthy passes wait for lock release before reporting success.
- The external pinger retries busy/failed passes, honors Retry-After, re-signs requests and reports completion only after a full successful pass. Long retry delays defer to the next scheduled run.
- Integration probes assert creation/validation/submission responses, share a six-second sweep cadence, respect rate limits and reject failed scheduler responses. Delivery remains required within bounded polling; timeout diagnostics allowlist invoice state, response statuses and attempt counts. The temporary webhook is disabled even on probe failure.

## Verification

The focused local tests cover explicit scopes, release-before-network behavior, first-use breaker initialization, rollback on read failure, all four reminder candidate reads, preference reads, HTTP boundary preservation, partial failure, timeout ownership, busy heartbeats, authorization, rate limiting, claim/reconciliation failure, recovery, and scheduler/polling retry semantics. Type checking and linting are also required.

Local evidence: 50 API/request-policy/worker regressions and 21 scheduler/journey-helper regressions passed. API type checking, the production API build, scoped lint, architecture, secret scanning, and documentation checks passed. The API build required an unsandboxed retry because the Windows bundler could not traverse dependency paths in the filesystem sandbox; no build script or dependency versions were changed.

`artifacts/api-server/src/scheduled-work.integration.test.ts` adds database-backed coverage of the real app route with worker timers disabled, all registered sweeps, signed pointer-only webhook delivery, one rail submission, all four reminder ledgers, sent notifications, duplicate prevention and operational heartbeat persistence. The same fixture flow is exercised through the background entry point.

Run these against an isolated, migrated PostgreSQL/pgvector test database, never a production connection:

```sh
pnpm --filter @workspace/api-server test
pnpm --filter @workspace/scripts e2e
```

The focused pure regressions are included in `@workspace/api-server test:pure`; the scheduler and journey helper tests are picked up by the existing CI script-test globs. The full CI run must pass before merging or closing issue 202. Local PostgreSQL lifetime/deadline tests could not execute because no test database service is installed.
