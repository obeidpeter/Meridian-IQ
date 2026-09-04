# R198 reliability and usability implementation

Baseline: main at 8347dd29f (PR197). Application changes are on agent/reliability-r198.

## Progress

| Area | Review items | Status |
| --- | --- | --- |
| Invoice authorization, transactions, revisions, decimal validation | F02-F04, F09-F10 | Implemented; 12 math/date/cursor/export and 16 approval/conflict UI regressions pass; HTTP/DB validation pending |
| Offline/session boundaries, lazy routes, mobile revalidation | F01, F16, F20-F21 | Implemented; deferred create/import/draft work is generation-bound; final unit run passes |
| Durable idempotency and operation recovery | F05 | Create/import wrappers and recovery APIs integrated; PostgreSQL validation pending |
| Search, stable pagination, multiple drafts | F17-F19 | Implemented; SME draft/submission and mobile search/intent regressions pass |
| Workers, webhook recovery, database and Clerk admission | F06, F08, F11-F14 | Implemented; focused regressions pass; PostgreSQL validation pending |
| Explicit database trust boundaries | F15 | HTTP missing-context fallback and expired cached query dispatch closed; sibling savepoints reject overlap; 44 focused tests pass, PostgreSQL validation pending |
| Release verification, accessibility, failure-path tests | F07, F22-F24 | Implemented; local release and axe regressions pass; target evidence pending |
| Domain-focused decomposition and shared state consistency | F25-F26 | Included with changed flows |
| Build, integrated tests, PR and deployment | All | Local gates and final catalogue/budgets pass; PostgreSQL CI, PR and deployment pending |

Do not mark an area complete without recording its tests and any remaining operational verification.

## Integrated Verification

- API contract 0.99.0 defines revision-bound invoice updates/approval, durable operations, import manifests/chunks, server drafts, cursor filters and Clerk reservation reconciliation. Clients are generated from this contract.
- Parent-owned approval/conflict UI: 16 tests passed. Mobile decimal/date/payload suite: 10 tests passed using installed dependencies.
- Final API generation (contract 0.99.0), repository-wide typecheck, full ESLint, and tracked-secret scan passed. The final API production build and all five web route-budget builds passed.
- The final repository-wide unit rerun passed 1,450 tests: API errors 9, format 97, web config 6, shared UI 199, mobile 130, landing 30, console 430, SME 452, buyer 44, penalty calculator 12 and API pure contracts 41. One earlier concurrent run hit the existing five-second timeout in the first no-TIN invoice test; the complete rerun passed without increasing test timeouts or reducing coverage. The earlier import-resume timing failure was corrected with explicit response gates.
- Real iOS and Android exports passed after declaring the Babel preset used by the existing Expo configuration. The packaged mobile server passed HTTP checks of both manifests and referenced assets. Release/mobile regression suites passed 31 tests. These are native JavaScript export and serving checks, not physical-device certification.
- Final shared recovery catalogue: 88 specimens and 24 interaction checks at 320/768/1440 pixel widths, light/dark themes and 200% text enlargement. A manual review caught near-vertical recovery action labels that the original geometry check missed. Container-aware stacking fixes this; the new word-readability check has three self-tests, and the complete rendered rerun has zero axe, geometry or readability failures. This does not certify all pages, real browser zoom or screen-reader behavior.
- Measured static entry JavaScript and retained lazy routes have fixed reviewed CI ceilings. Architecture, documentation and tracked-secret checks remain enabled.
- Real PostgreSQL tenant/RLS, concurrent write, import failure, migration-only upgrade and restore tests must pass in CI. They have not been replaced by mock or skipped-test claims.

## Scope Decisions

The six unconditional product builds are integrated into existing workspaces. The optional multi-workspace switcher remains deferred: the current API lacks a safe authenticated membership-list and membership-ID selection contract. A firm-list dropdown would not prove user membership or distinguish multiple roles within one firm.

Invoice amount payloads preserve decimal strings and use explicit half-up rounding. Existing issued documents are not rewritten. Legacy approvals without a recorded revision are retained but revoked during migration because their reviewed content cannot be proven. New revision and financial line-identity safeguards remain in place during application rollback.

Expired draft content is removed in bounded worker batches while identity/revision tombstones remain to reject delayed writes. Durable operation/import records are authoritative; browser storage alone never proves completion.

Uncertain invoice creation preserves the original payload and key on-device before dispatch, locks destructive replacement, and replays identical data after refresh. Server idempotency is still authoritative. Import recovery links come from ownership-matched run/chunk records, not caller-controlled keys; Activity routes work across Console, SME and Buyer workspaces.

Import buyer matching is serialized within each firm/supplier scope, with scoped deterministic lookup rather than a global TIN match. Manual and connector party creation do not yet share that import lock protocol; no destructive legacy deduplication or global unique-TIN constraint was introduced.

HTTP database use now fails closed without an explicit context, and cached tenant handles cannot execute after their transaction lifetime ends. The non-HTTP raw fallback for boot, workers and test fixtures is still transitional; this release does not claim a complete least-privilege credential migration.

## Deployment Status

This is the pre-merge implementation handoff, not evidence of production deployment. Replit was inspected read-only: development and production are at migration 49, without backup/restore heartbeat evidence. The production UI reports seven-day PITR with scheduled backups off. Approval to make a private production backup and test an isolated restore is pending. Development data must not overwrite production, and live customer databases must not be used for fault-injection tests.

Additional read-only production checks reported zero duplicate `(invoice_id, line_no)` groups. Both platform manifest requests returned HTTP 200 at `https://meridian-iq.replit.app/mobile/`, with launch assets on that same host and path. The native build/runtime must retain all seven verified asset trees. Official documentation did not establish whether `.git` or ignored files are excluded from the build snapshot; actual snapshot preservation remains a required deployment check, not an asserted platform limitation.

Release requires a green immutable candidate, current target backup/restore evidence, reviewed additive migrations, exact CI artifact promotion and deployed source/asset/security parity. Do not bypass these checks to make publishing proceed.
