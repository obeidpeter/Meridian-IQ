# Workflow Improvement Review

Prepared against PR #218's main revision
`d2e4c35486188efd6ac1b9dcebef9f5fa81da394`. API contract: `0.101.0`.
This implementation does not publish a release or activate external services.

## Implemented Scope

1. **Correct workspace totals and accessible task pages.** Today aggregates the
   full authorized population before limiting its ranked display. Buyer setup
   proof is independent of the visible queue. Team work uses the new bounded
   `/work-items/page` API with scoped keyset cursors, stable tie-breaking and
   active/completed/all views. The legacy list remains compatible.
2. **Recoverable failures and drafts.** Today retains cached priorities after a
   failed refresh. Task and discussion failures are distinct from empty states.
   Comment drafts are account/client/task-scoped, survive local tab refreshes
   where session storage is available, and reuse their idempotency key after a
   lost response. In-flight locks prevent overlapping submissions.
3. **Immutable release preparation.** The manual sidecar selects an exact
   successful GitHub CI run and attempt, validates producer/archive provenance,
   stages all seven artifacts outside development, runs existing integrity
   gates and produces a protected review handoff. It does not rebuild bundles,
   publish, mutate databases or bypass native schema/release checks.
4. **First-invoice onboarding.** Today recommends the next available step from
   persisted, scoped records. It does not treat opening a page as completion or
   infer fiscal success from a draft. Shared business-details editors provide
   the missing Console and SME destinations with changed-fields-only updates,
   validation, retry, dirty-state protection and current-permission checks.
5. **Operational evidence.** Readiness distinguishes configured, attested,
   missing, stale, failed and structurally verified recorded evidence. Backup
   and restore failures preserve prior success provenance while recording a
   sanitized failure. A bounded, opt-in external verifier checks health,
   readiness, revision identity and signed metrics authorization.
6. **Consistent, tested interfaces.** Shared tokens cover Today, Team work and
   reliability views. Built-page browser tests cover responsive layouts,
   light/dark themes, keyboard use, automated accessibility, large task lists,
   stale data and request failures. CI runs the workspace usability suites.
   Help-topic data is separate from Help page components so navigation no
   longer defeats those pages' lazy loading in Console and SME.

## Verification

- API code generation was repeated and every generated-file hash was unchanged.
- The complete local quality command passes architecture, tracked-secret,
  documentation, branding, type, lint and unit/pure checks. Two existing SME
  invoice-draft hook warnings remain; there are no lint errors.
- API and all five web production builds pass. Native mobile type and unit
  checks pass; a native mobile release export was not performed locally.
- The integrated workspace browser suite passes 65 tests, including responsive
  and theme coverage, keyboard interaction, automated accessibility, task 125,
  comment retry identity and dirty-form recovery. These use synthetic fixtures.
- After the final rebuild, business-editor checks pass 9/9 again. Four Help
  route checks verify real lazy chunk loads, keyboard search, no-results recovery
  and reflow at 320/1440px. Eight local preview checks also confirm Today, Team
  work and business routes render without browser exceptions or horizontal overflow.
- All 222 release/operations regression tests pass, including all-seven-app
  artifact checks and failed backup/restore evidence. No production data is used.
- All five frontend startup budgets pass without increasing their ceilings.
  Measured eager gzip bytes: Console 163,918; SME 158,831; Buyer 133,932;
  Landing 70,764; Penalty calculator 61,196. Console has 35 lazy route entries
  and SME has 28.

The initial full API run recorded 1,600 passes and 17 failures on Windows Node 24. Follow-up isolated the public/login failures to shared loopback throttle
counters. Test clients now use distinct real TCP loopback source addresses;
public and Valo authentication suites pass 13/13 twice on the same scratch
database without relaxing the server caps. An added test still reaches the
public cap on request six.

The fake provider's oversized-body path also reset its socket before delivering 413. It now preserves the request stream while returning the rejection, discards
unread bytes without buffering, and enforces a fixed cleanup deadline. Fake rail,
HTTP transport and helper tests pass 74/74, including twenty repeated rejections,
subsequent requests, port reuse, stalled upload closure and malformed-body 500.
The behavior follows Node's documented
[async iterator stream-lifetime rules](https://nodejs.org/docs/latest-v22.x/api/stream.html#readablesymbolasynciterator).

The scheduled-work suite passes 4/4 unchanged on an isolated rerun; the owner of
the original transient lock contention was not established. Five other files
hit Windows native process-shutdown assertions after their test assertions
passed. Those runner failures remain unresolved; no Node 22/Linux comparison or
complete full-API rerun was performed. A clean canonical Linux CI run remains a
release prerequisite. The synthetic PostgreSQL instance was stopped afterward.

## Important Boundaries

- Pagination reflects live records, not a multi-request database snapshot.
  Refresh from the first page after external changes to ordering or membership.
- Business-details PATCH has no server revision guard. Changed-only updates
  reduce unrelated overwrites but cannot prevent same-field concurrent writes.
  Unsaved business details warn on browser unload; they are not persisted or
  protected from in-app navigation. Comment drafts have separate recovery.
- Recovery heartbeats are producer records, not proof of private off-box
  retention. Failure reporting is best effort when the source database is down
  or a process is killed. External job status and retained private logs matter.
- No production backup, restore, provider transaction, external monitor schedule,
  notification or moderated usability session was performed by this change.
  Real evidence must not be replaced with synthetic test reports or invented dates.
- The new release workflow requires an appropriately protected GitHub review
  environment. Its approval receipt is not production deployment authorization.
  Confirm the live HTTPS `PUBLIC_APP_URL`, keep development-data copying OFF,
  and use the exact new merged-commit CI artifact when subsequently publishing.

## Supporting Guides

- [First-invoice onboarding and editor behavior](first-invoice-onboarding.md)
- [Release preparation and approval boundary](release-preparation.md)
- [Operational verification and activation checklist](operational-verification.md)
- [Automated checks and moderated usability study protocol](usability-validation.md)

Automated accessibility checks are not WCAG certification or evidence that
representative people have completed the proposed study.
