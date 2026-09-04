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
| Build, integrated tests, PR and deployment | All | Local gates and final catalogue/budgets pass; PR198 pushed; first PostgreSQL API CI run failed (19 tests), corrections and full green CI pending; recovery qualification and deployment pending |

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

This is the pre-merge implementation handoff, not evidence of production deployment. PR198 was pushed at `6163fe541a2a056861c8ae6ad7258d03a48c970e`. CI run `33925161819` checked out PR merge revision `d0142902b96f37c42a9702db95da32b0cbfeef16` and failed API tests: 1,512 passed, 19 failed. The migration rollback/upgrade, restore drill and E2E stages were not reached; no release artifact was produced by that run. Corrections are in progress and a complete green run is still required. Candidate identity must come from the successful checksum-verified CI manifest, not an assumed branch SHA.

The follow-up corrects raw PostgreSQL timestamp normalization in import/operation recovery, preserving microsecond cursor keys. It repairs delivery consent fixtures to include their required engagement, verifies foreign consent remains hidden, checks wrapped PostgreSQL DELETE denial by SQLSTATE, and strengthens draft tombstone and party read/write scope regressions. The parent rerun passed 10 focused tests; the PostgreSQL draft suite was not runnable locally. API typecheck passed and full lint completed with zero errors and two existing draft-hook warnings. The real database and end-to-end gates must be rerun before merge.

The latest reported read-only Replit inspection found development and production at migration 49, without backup/restore heartbeat evidence. The production UI reports seven-day PITR with scheduled backups off. Approval to make a private production backup and test an isolated restore is pending. Genuine target recovery evidence, production migration application and deployment have not been completed. Development data must not overwrite production, and live customer databases must not be used for fault-injection tests.

Additional read-only production checks reported zero duplicate `(invoice_id, line_no)` groups. Both platform manifest requests returned HTTP 200 at `https://meridian-iq.replit.app/mobile/`, with launch assets on that same host and path. The native build/runtime must retain all seven verified asset trees. Official documentation did not establish whether `.git` or ignored files are excluded from the build snapshot; actual snapshot preservation remains a required deployment check, not an asserted platform limitation.

Baseline `8347dd29f3d947634a62739088e67548a8d0a946` implements contract 0.98 and is not write-compatible with the new 0.99 revision/idempotency guarantees. It must not be labelled a safe application fallback merely because migrations 0050-0054 are additive. No qualified 0.99-compatible immutable fallback has yet been established. `RELEASE_ROLLBACK_REVISION` validates SHA syntax, not compatibility; do not invent a value, use the unqualified candidate, or substitute the old baseline to pass it.

Ordinary application recovery must keep migrations 0050-0054 applied, including revision evidence, unique line identity, RLS, grants and operation/import triggers. Do not execute their downs: preservation tests do not prove old-application compatibility, and the 0051/0054 downs remove safeguards. The permitted planning alternatives are a qualified 0.99 fallback or a separately reviewed, externally enforced maintenance and forward-recovery policy. The current gate does not accept the latter; no policy approval or gate change is implied by this document. See [Operations and Rollback](operations.md#rollback).

Release remains blocked pending a green immutable candidate, qualified recovery policy, current target backup/restore evidence, reviewed additive migrations, verified native snapshot/promotion behavior and deployed source/asset/security parity. Do not bypass these checks to make publishing proceed.
