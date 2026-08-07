# Clerk AI — guardrails & module guide

Clerk is MeridianIQ's AI intake assistant. The one principle everything below
serves: **Clerk never files anything** — extraction proposes, a human
disposes, and approval creates a DRAFT invoice only. Facts are computed in
SQL; the model classifies or phrases; deterministic template fallbacks always
answer; dark rails fail closed. Paths in this document are relative to
`artifacts/api-server/src` unless noted.

## Gateway & guardrails

- Every model call flows through `modules/clerk/gateway.ts`: kill switch
  (`clerk_ai` feature flag), append-only inference ledger, schema-validated
  output, fail closed. A disabled Clerk fails with 503 `CLERK_DISABLED`
  before any model call or case insert.
- The gateway writes the inference ledger on the **RAW pool** so spend
  accounting survives any request rollback; consequence: a `caseId` passed to
  `infer()` must reference an already COMMITTED case row.
- The model-calling routes (capture, batch, ask, eval-run) run OUTSIDE the
  per-request transaction (`app.ts NO_CONTEXT_ROUTES`) — each DB stage
  commits in its own short firm-scoped transaction (`modules/clerk/scope.ts`,
  same RLS posture) so a multi-second provider call never pins a pooled
  connection or hits the 30s transaction cap.
- Client-facing surfaces (`clerk.capture` on all firm roles, `clerk.ask` on
  firm_admin/staff) are pinned to their firm by route filters plus migration
  0009's firm-keyed RLS. Review/decide, evals, metrics and party suggestions
  stay operator-only (`clerk.use`).

### Route layout

`routes/clerk/` is split by concern into six routers mounted by
`routes/clerk/index.ts` (a pure organizational move — every path is absolute,
none overlap):

- `cases.ts` — capture, review decisions, claim/release/retry, suggestions
- `eval.ts` — eval runs, corpus curation, prompt + model canaries
- `ask.ts` — Ask Clerk, failure explainer, payment-chaser draft
- `batches.ts` — async batch intake
- `reports.ts` — metrics, claim gaps, tier report, usage, digest, statements
- `drafts.ts` — format/import/invoice/claims/catalogue drafting + assist

### Per-purpose model tiers

The production provider supports per-purpose model tiers (opt-in
`CLERK_MODEL_TIERS` env, e.g. `segment_batch=<cheap-model>`; unset = one
model for everything): the ledger records the model that ACTUALLY served each
call, and eval purposes follow their production tier unless explicitly
overridden (`eval_extract`/`eval_canary` → `extract_invoice`,
`eval_extract_notice` → `extract_notice`, and so on) so evals measure what
production runs. The **tier-suggestion
report** (`modules/clerk/tier-report.ts`, `GET /clerk/tier-report`,
`clerk.use`, console health card, pure ledger SQL) is the evidence for using
it — per purpose over a trailing 90 days: volume, token share, the validity
taxonomy (killed excluded from the denominator), the model ACTUALLY in force
via the same `parseModelTiers`/`modelForPurpose`, and a deterministic
recommendation (candidate/keep/tiered/revert/insufficient_data; extraction
and its evals never tier on validity alone) the operator acts on in env
config, canary first.

## Intake paths

Every intake path ends at the same place: a `clerk_cases` row awaiting human
review.

- **Capture** (`modules/clerk/cases.ts`) — text or vision extraction from an
  uploaded document (5MB/type caps, duplicate guard).
- **Pre-flight** (`modules/clerk/preflight.ts`) — pure model-free validation
  stored on the case at extraction time (empty list = review fast lane).
- **Register-history pre-flight** (`modules/clerk/register-preflight.ts`,
  zero model calls) — checks extracted supplier/buyer identities against the
  firm's party SPHERE (`firmPartySphereCondition` — parties are the shared
  spine, no tenant RLS) and the supplier's own invoice history: VAT-rate
  deviation, plus the history-based anomaly flags — duplicate invoice number
  = full issue, same-date-same-total and amount-outlier-vs-median = advisory,
  and a pure issue-date sanity check (overdue-on-arrival / future-dated)
  that runs even for operator captures. Register TINs are only ever masked in
  issue text. Line-item memory (see Memories) adds a capture pre-flight
  advisory when a line's unit price is far (×4) off that item's own history
  (3+ lines).
- **Scanned-PDF intake** (`rasterizePdfScan` in `modules/clerk/cases.ts`) —
  renders a textless PDF's pages (max 4) to images and walks the ordinary
  vision-extraction path. Pages are stored on the case for retry
  (`source_scan_pages_b64`, purged by the content-retention sweep, stripped
  from ordinary case responses — the review pane reads them through the
  operator-only source-pages route, see Review & approval); text detection
  relies on `pageJoiner: ""` (pdf-parse's
  page markers otherwise make every scan look like it "has text").
- **Batch intake** (`modules/clerk/batch.ts`) — text-only; only proposes
  segment boundaries. Every segment then walks the normal capture path.
- **Async batch** (`modules/clerk/batch-async.ts`, `clerk_batches` table +
  firm-keyed RLS migration 0014) — queues a month-end bundle (cap 50) with
  NO model call in the request. An immediate in-process kick plus the sweep
  (claim CAS, 10-min reclaim) process it with the digest split-pattern:
  per-segment progress counters the UI polls, source content cleared at
  terminal states, kill switch parks work instead of consuming it.
- **Scanned bundle** (`modules/clerk/scan-batch.ts`, cap 24 pages) — a
  textless PDF queued as a batch. The original PDF bytes persist on the row
  until terminal (any process can resume by re-rasterizing); one
  `segment_scan` vision call over small page THUMBNAILS proposes page
  ranges; `validateScanSegments` fails closed unless the ranges cover every
  page exactly once in order; each validated segment walks the ordinary
  vision-extraction case path with its full-resolution page slice
  (per-segment duplicate hash on the page bytes).
- **Inbound email rail** (`modules/inbound/email.ts`,
  `POST /api/inbound/email`, machine webhook deliberately OFF the OpenAPI
  contract) — a client forwards a supplier invoice by email. FAIL-CLOSED
  shared secret (`INBOUND_EMAIL_TOKEN` unset = rail dark, 404 — unlike the
  open-by-default metrics token, this rail creates tenant work and spends
  tokens); responses byte-identical for resolved and unresolved senders (202
  then detached processing — no email-probe oracle); sender resolved
  deterministically via the unique login email → `client_user` membership →
  (firm, client party, createdBy); each PDF/image attachment walks the
  ORDINARY capture path (budget pre-check, 5MB/type caps, duplicate guard
  absorbing provider redelivery) with masked-sender pointer-only audits.
- **Inbound WhatsApp rail** (`modules/inbound/whatsapp.ts`,
  `POST /api/inbound/whatsapp`, same posture, `INBOUND_WHATSAPP_TOKEN`
  fail-closed) — resolves the sender phone through the shared E.164
  normalizer (`src/lib/phone.ts`, Nigerian 0-prefix → +234) against stored
  alert-preference numbers **that the client set themselves**
  (`alert_preferences.contact_set_by_role = 'client_user'`, recorded by the
  prefs PUT — a firm-staff-typed number is never a routing key, and rows
  predating the provenance column fail closed) and proceeds ONLY on an
  exactly-one party match (ambiguity refuses, never guesses). Media walks
  capture; ≥40-char text-only messages walk text capture. Both rails share
  the daily-cap / semaphore / type-mapping / per-item capture machinery in
  `modules/inbound/shared.ts`.
- **Scanned bank-statement intake** is the same grounding split pointed at
  statements (`modules/statements/scan-intake.ts`, purpose
  `extract_statement`) — see `docs/platform.md` § Statements; the proposal
  feeds the deterministic parser, never `bank_statement_lines` directly.

## Review & approval

- Review/decide is operator-only (`clerk.use`) and compare-and-set on case
  status, so concurrent decisions can never double-apply. Approval creates a
  DRAFT invoice only.
- **Vendor bootstrap (payables).** Approval validates the chosen parties'
  firm membership explicitly (`assertPartyInFirm` in cases.ts — operators
  run with RLS bypassed, so the check cannot be left to policy): an
  engagement, an existing invoice reference, or — the payables round's
  addition — the firm-created provenance arm (`created_by_firm_id`, the
  party sphere's third leg). Without it, the FIRST bill from a vendor party
  the firm just created could never approve — a fresh vendor has no
  engagement and no invoice yet, so approval refused with
  `PARTY_NOT_IN_FIRM`. The approved bill itself never stamps: see the
  orientation guard in `docs/platform.md` § Payables.
- **Source-document display** — the review pane shows the reviewer the
  captured document, not just its extraction: single-image captures render
  from the case's existing `sourceImageB64`; scanned-PDF pages come from
  `GET /clerk/cases/{id}/source-pages` (`clerk.use`, operator-only), which
  returns the rendered pages plus a `purged` flag once the content-retention
  sweep has cleared them (the pane says so instead of rendering nothing).
  This closes the gap where a photo/scan capture could be approved without
  the reviewer ever seeing the document.
- **Fast-lane bulk approval** (`modules/clerk/bulk-approve.ts`,
  `POST /clerk/cases/bulk-approve`, same gate) is the bulk-submit idiom
  pointed at the queue: up to 50 approve decisions walk the EXISTING
  `decideCase` one by one, each in a savepoint, but only cases the server
  itself re-verifies as fast-lane (extracted, present preflight with no
  blocking issue, critical confidences at or above the case's OWN threshold
  — mirroring the console's `isReadyToApprove`). Everything else skips with
  its reason; the console queue's "Approve fast lane" action is its
  human-initiated consumer.
- **Adaptive fast-lane threshold** — the confidence bar is per-firm, derived
  deterministically from the firm's own calibration history
  (`firmFastLaneThreshold` in metrics.ts): the 0.8–1.0 band must show ≥200
  fields at a ≥97% kept-rate to earn 0.8; otherwise the 0.9 default holds
  (0.8 is the hard floor — history can loosen the bar one notch, never
  below it). The threshold in force rides each case row
  (`fastLaneThreshold`), so the console's fast-lane predicate and the
  server's bulk-approve re-verify read the SAME number and can never
  disagree.
- The console weights review-queue effort and shows per-field "historically
  corrected" hints from `metrics.corrections` (`fieldWeights` /
  `correctionHint` in console `clerk-shared` — never auto-accept, ordering
  and hints only).
- The queue is **batch-aware**: every async-batch case records its `batchId`
  (`clerk_cases` column, covered by the same firm-keyed RLS); a bundle's
  segments coalesce into one group at their best-ranked member's position
  (`groupQueueByBatch` in clerk-shared — an unbatched queue renders exactly
  as before); the group header shows "reviewed R of C" from the batch
  endpoints' `reviewedCases` (decided = approved/rejected; `reviewedCounts`
  in batch-async.ts).
- In the console, Clerk pages render inside their own full-bleed shell
  (`console/src/components/clerk-shell.tsx`, dark teal rail in both color
  schemes) with four tabs: Intake queue, Claims, Ask Clerk, Health.

## Notice Desk (authority notices → obligations)

The second document domain (contract 0.57.0): a tax-authority notice —
assessment, demand note, information request, audit letter, penalty — rides
the SAME capture rails and review queue as invoice paper, but its approval
creates an **obligation** (client, authority, response deadline), never an
invoice. Obligations are compliance-spine data (firm-keyed +
client-party-scoped, migration 0031); the model only ever proposes a reading
of the letter.

- **Capture.** `documentKind: "notice"` on the ordinary create-case body
  (absent = invoice, byte-identical historic behavior) produces a kind
  `"notice"` case: same source resolution, same sourceHash dedup, same
  budget/kill-switch gateway path, purpose `extract_notice`
  (`notice-prompts.ts`, `notice.v1`). Voice is rejected up front (a
  read-aloud notice has no authoritative text) — before any decode or token
  spend. The inbound email/WhatsApp rails triage each attachment with ONE
  cheap fenced text-signal call (`modules/inbound/triage.ts`, purpose
  `triage_document`, `triage.v1`: filename, the email subject / WhatsApp
  caption, and a pdf text head — signals an outsider authors, so the whole
  block rides one fence): a confident "notice" pick routes the capture down
  the notice lane; "unknown", invalid output, provider error, dark kill
  switch and exhausted budget ALL fall back silently to the invoice lane —
  the pre-triage behavior exactly, so triage can never drop a document. The
  call rides `inferPhrasing` precisely because its fold-to-null contract IS
  that fallback.
- **Proposal.** `noticeExtraction` (its own jsonb column; `extraction` stays
  invoice-only): ExtractionField-shaped candidates over the closed
  NOTICE_FIELDS catalogue (reference, authority, taxType, period, amount,
  currency, issueDate, responseDueDate) plus a model-classified
  `noticeType` from the closed list. `noticePreflightChecks` is pure and
  deterministic: missing criticals and impossible dates block; a
  response deadline already in the past is an *advisory* ("overdue on
  arrival" — reviewers must still see the case). Fail-closed exactly like
  the invoice lane: invalid output → escalated, provider error → failed.
- **Review.** Notices render first-class in the intake queue (kind tabs) but
  NEVER fast-lane: `fastLaneBlocker` walls on kind, and
  `decideNoticeCase` (`POST /clerk/cases/{id}/notice-decision`, clerk.use)
  is the only approve path. Approve demands the human confirm firmId,
  clientPartyId, noticeType, authority and responseDueDate
  (DECISION_INCOMPLETE otherwise); the obligation insert is race-safe on
  the unique `obligations.source_case_id` (double-approve → 409); per-field
  notice corrections (including a noticeType row) land in the same
  corrections exhaust.
- **Obligations downstream (zero model calls).** `modules/obligations/`
  owns every deadline predicate (one home): `/obligations`
  list/create/get/status routes (`obligation.read`/`obligation.write`;
  client_users read their own — SEC-03 narrowed; manual create covers paper
  notices), a claim-first reminder sweep with its own at-most-once
  sent-ledger (`obligation_reminder_sends`; consent purpose stays
  `deadline_alerts`; templates `obligation_due_soon`/`obligation_overdue`),
  digest facts (digest.v7), a month-end close item (`open_obligations`),
  a compliance-pack section, and the Ask intent `data.open_obligations`
  (client-safe, own-party-pinned).
- **Response Desk (contract 0.59.0)** — the loop's closing arc: preparing
  the actual reply. Two halves, split exactly on the covenant line.
  `GET /obligation-response-pack` (query-params-only; `obligation.write` —
  firm work product; 404 non-disclosure) renders a DETERMINISTIC response
  bundle PDF: a cover sheet keyed to the authority's reference plus the
  period's compliance figures and document register, drawn by the same
  extracted pack-pdf section drawers the monthly pack uses
  (`CreationDate` pinned to the obligation's response deadline —
  byte-identical on identical inputs; the renderer's input has no letter
  field, so model output cannot reach the bundle by construction).
  `POST /obligations/{id}/response-draft` drafts the letter BODY
  (`modules/clerk/response-letter.ts`, purpose `draft_response_letter`,
  `response-letter.v1`): the advisory-narrative posture — no gateway /
  flag off / budget exhausted → the deterministic template letter; model
  output must pass `ensureGrounded`; the notice's own free text rides
  fenced; source is tagged `clerk`/`template` honestly and the partner
  copies, edits and owns the letter — never sent or filed by the
  platform. `responsePackLines` is the ONE home for the figure lines, so
  letter and bundle can never disagree; the phrasing-eval surface
  `obligation_response` replays the exact production prompt (injection
  fixture rides the notice free-text slot).

## Proposed actions (advice → assisted action)

The rounds-21/22 arc: every advisory surface ends with "…you should submit
these", and the proposed-actions surface closes that gap WITHOUT crossing
the platform's one hard line — Clerk still never files anything.
`modules/clerk/actions.ts` + `routes/clerk/actions.ts`; opt-in
`clerk_actions` flag (per-firm override capable), fail-closed on BOTH ends:
dark means proposals answer empty (the cards hide) and execution refuses
`503 ACTIONS_DISABLED`.

- **Closed catalogue, code-defined.** Three actions: `submit_overdue`
  (round 21 — the statutory obligation itself, clears s.104 exposure),
  `retry_failed` (round 22 — resubmission of rail-rejected paper via the
  lifecycle's own failed→submitted edge; each target carries its last rail
  `error_code` so the human can judge whether the cause is fixed), and
  `draft_chasers` (round 22 — one approval drafts a staged payment reminder
  for every chase-worthy receivable via `draftPaymentChaser`'s ladder; the
  drafts ride the RESPONSE and no DRAFT is stored — the CLIENT still sends
  them, the platform sends nothing, exactly the chaser surface's standing
  posture; a model-phrased draft's output is retained in the firm-scoped
  inference ledger like every Clerk call, while template drafts involve no
  model call at all). An unknown kind is `400 UNKNOWN_ACTION`.
- **Proposals are computed live** (`GET /clerk/action-proposals`,
  `invoice.read` + the SEC-03 client scope wall) from the digest/penalty
  card's overdue predicate, the failed-status predicate, and
  `listChaseRows` — never stored, so never stale, no model call in
  assembly. Submit kinds cap at `MAX_ACTION_TARGETS` (50); the chaser
  batch at `MAX_CHASER_TARGETS` (10 — each target is a model call), with
  honest `targetCount`/`truncated` and per-kind evidence.
- **A human approves an explicit target list**
  (`POST /clerk/action-proposals/execute`). The capability matches what
  the batch DOES: submit kinds need `invoice.submit` (approving IS
  submitting; maker-checker still bites per row inside `submitInvoice`),
  `draft_chasers` needs `clerk.capture` (the single draft-chaser route's
  own gate). Consent (CORE-03) gates the submit kinds up front; drafting
  submits nothing and carries none.
- **Transaction posture (round 22).** The execute route runs OUTSIDE the
  request transaction (`NO_CONTEXT_ROUTES`) and every stage commits in its
  own short `runRequestContext` transaction bound to the CALLER's firm —
  the bulk-approve posture, for two hard reasons: a chaser batch is up to
  ten sequential model calls (past the 30s cap), and a submit batch inside
  one transaction held the GLOBAL audit advisory lock batch-wide (the
  round-21 review's convoy/deadlock finding, closed here). The trade is
  bulk-approve's: an executed target is durable immediately, and the
  per-stage `SET LOCAL ROLE meridian_app` + firm GUC means the module
  carries the REAL RLS posture even in module tests — a cross-firm caller
  dies at the engagement-scoped consent wall with the same
  `CONSENT_REQUIRED` an unconsented own client gets (no oracle), before
  any decision row exists.
- **Every target is re-validated at decision time** against its own kind's
  predicate: anything that changed since the proposal (submitted
  elsewhere, cancelled, settled, aged out, foreign id) is
  `skipped_not_eligible`, never double-processed. Validation failures are
  `invalid` (draft untouched); rail-path `DomainError`s are `failed`;
  chaser successes are `drafted`.
- **The decision is the durable artifact** (`clerk_action_decisions`,
  firm-keyed RLS migration 0028; **append-only since migration 0030** —
  the shared `meridian_block_mutations` trigger blocks UPDATE/DELETE like
  every sibling Clerk evidence table, so the row that answers "who
  authorized this filing" is tamper-evident at the data layer, not just
  witnessed by its audit pointer): who approved, on what pre-execution
  evidence, over which targets, with per-target outcomes and honest
  tallies; surfaced via `GET /clerk/action-decisions` (newest 10) and a
  pointer-only `clerk.action.executed` audit event (SEC-12) — neither
  carries a chaser subject or body. The honest crash window of the
  per-target posture: a crash before the final stage leaves real
  submits/drafts with per-invoice lifecycle events but no batch-level
  decision row.
- **Surfaces.** The SME dashboard's "Clerk suggests" card and its console
  twin on the client page (`components/clerk-actions-card.tsx`, which also
  shows the recent-decisions strip): two-step confirm → per-target-results
  dialog, drafts rendered once with copy buttons, advisory queries
  invalidated on close. Ask Clerk knows the surface too:
  `data.proposed_actions` (CLIENT_SAFE, own-party-pinned) answers what is
  WAITING FOR APPROVAL and points at the dashboard — Ask can never
  execute anything.

The follow-ups this list has carried have all since shipped: the
chaser's stage/phrase split (no transaction spans a model call — round
23), the bulk-submit conversion (the last batch surface now commits per
item in the caller's posture outside the request transaction, closing
the audit-lock convoy class platform-wide — and, round 30, bounded by a
wall clock again: `BULK_DEADLINE_MS` (25s) is checked BEFORE each item
starts, so every row is either fully attempted or untouched, untouched
rows flow into the honest `remaining` count for the UI's
repeat-until-done loop, and items completed before the deadline stay
committed), and the action-effectiveness report (round 29 — below).

### Standing approvals (round 28 — the policy autopilot)

Rounds 21/22 still leave a human clicking APPROVE on the same batch every
day. A standing approval makes that decision durable instead:
`clerk_action_policies` (firm-keyed RLS migration 0029) holds one live,
revocable GRANT per (firm, client, kind) — who granted it (and their role
at grant time), a per-run target cap, and its own lifecycle. The daily
sweep then runs it — but a grant is authorization, never a bypass:

- **Narrower catalogue.** `POLICY_KINDS` = the submit kinds only
  (`modules/clerk/action-policies.ts`); `draft_chasers` is excluded by
  design — its drafts exist only on the HTTP response for a human to read
  and send, which an unattended sweep cannot do.
- **Doubly fail-closed.** The `clerk_action_policies` flag layers ON
  `clerk_actions`: either dark means granting refuses
  `503 POLICIES_DISABLED` and the sweep skips WITHOUT consuming the day
  (an ops toggle is not a policy state — relighting the flag lets today's
  batch still run). Granting also re-walks the per-batch gates: consent
  (CORE-03, `403 CONSENT_REQUIRED`), the SEC-03 party wall +
  `assertPartyAccess`, `invoice.submit`, one live grant per kind
  (`409 POLICY_EXISTS`, backstopped by a partial unique index
  `WHERE revoked_at IS NULL`) — and, round 30, the **engagement wall**: a
  grant REFUSES `409 NO_LIVE_ENGAGEMENT` unless the firm holds a live
  (open/in_progress) engagement with the client. `assertPartyAccess`
  deliberately accepts ANY engagement, archived included, so retention-era
  reads keep working — but a firm must not switch an autopilot on for a
  client it has already wound down (`hasLiveEngagement` is a stricter
  LOCAL wall, never a replacement for rbac's `firmEngagesParty`).
- **The grant's per-run cap is a chosen number.** `maxTargetsPerRun`
  (contract 1..50, defaulting to the batch maximum server-side) is entered
  in the grant dialogs' "Daily limit (invoices per run)" input — default
  **10** (`POLICY_CAP_DEFAULT` in `@workspace/format`, alongside
  `parsePolicyCap`, the one gate both dialogs run the raw input through) —
  and the consent-grade grant copy (`policyGrantDescription`) restates the
  chosen ceiling, so the number being consented to is in the sentence.
- **Every run re-validates the world.** Both flags; the grantor's CURRENT
  membership still carries `invoice.submit` in this firm (a client_user
  grantor only for their OWN party) — else the policy auto-pauses
  `grantor_inactive`; the engagement wall again — an engagement archived
  AFTER the grant pauses it `engagement_closed` (a standing approval must
  not outlive the relationship it automates; a full offboard already
  revokes grants, this catches the status-only paths); consent — else
  `consent_missing`; then the **rail-rejection tripwire**: the PREVIOUS
  run's decision is re-read through `decisionRailStanding` (the
  effectiveness report's own SQL — one spelling of `nowFailedAgain`), and
  if half or more of its submitted targets are back in `failed` the policy
  pauses `rail_rejections` INSTEAD of running today — `submitInvoice`
  succeeds at enqueue, so only a later re-read ever sees the rails'
  verdict. Only then does `executeAction` re-check every target's
  predicate per invoice exactly as a fresh click would. Batches assemble
  from the SAME live proposal builders the cards render
  (`proposalForKind`), capped at the grant's `maxTargetsPerRun`, oldest
  first — with one automation-only narrowing (rail-rejection mechanism 1):
  retry assembly under a policy drops invoices with
  `AUTO_RETRY_ATTEMPT_CAP` (5) or more total submission attempts — the
  autopilot gives up on rail-hammered paper for good, while the HUMAN
  proposal keeps offering it (a person may still deliberately re-choose
  it).
- **At most once per Lagos day, exactly once across instances.** The sweep
  claims the policy's `lastRunDay` cell with a compare-and-set BEFORE
  executing; the loser of a concurrent claim skips. An EMPTY assembly
  leaves the day unclaimed — the hourly pass keeps watching and the first
  non-empty batch of the day runs. Registered via `registerSweep`
  (`atMostHourly`), per-policy failures isolated.
- **The sweep polices itself.** The tripwire catalogue (round 30 added the
  last three): `grantor_inactive`, `consent_missing`, `engagement_closed`
  and `rail_rejections` (all above); `failed_targets` — a run where half
  or more of the targets fail at DECISION time (something is structurally
  wrong and a human must look before it runs again); `unknown_kind` — a
  row whose `kind` falls outside `POLICY_KINDS` (an ops fix-up, a backfill
  bug — the API never writes one) pauses instead of falling through the
  proposal dispatcher into the chaser builder's model calls; and
  `run_error` — a policy whose run THROWS (a bug, a dependency down
  mid-run) is paused like any other tripwire instead of silently retrying
  every day forever — fail closed, with the pause's own failure absorbed
  so one broken policy still cannot stall the fleet. Pause is reversible
  (a human resume clears a tripwire — the audit records the cleared
  reason; the next run re-checks everything anyway); revoke is permanent
  evidence — the row survives and re-automating takes a fresh grant.
  Tripwire pauses audit as `clerk.action.policy_auto_paused` with the
  system actor (`action-policy-sweep`); grant/pause/resume/revoke audit
  under the human's id — including the revocations `offboardClient`
  performs: offboarding a client revokes the firm's live grants for that
  party (step d2), because no sweep tripwire would ever catch a
  STAFF-granted policy after offboarding deleted the client logins that
  could have paused it (the staff membership survives, and consent is
  client-owned and untouched).
- **Fleet visibility (round 30).** Every sweep pass logs its result
  (`policiesDue` / `policiesRun` / `policiesAutoPaused`), and a pass that
  auto-paused ANYTHING additionally raises a durable once-per-Lagos-day
  operator alert (`ops.action_policy.auto_paused`,
  `alertOnceViaAuditLedger` — the health-watch discipline: the append-only
  audit ledger is the cross-instance dedup key). The alert payload carries
  COUNTS only (SEC-12) — per-policy detail lives on each policy's own
  `clerk.action.policy_auto_paused` audit row — and is best-effort: a
  failed alert never fails the sweep.
- **The paper trail stays one human deep.** A policy run's decision row
  carries `policyId` and `decidedBy` = the GRANTOR (maker-checker still
  bites per row inside `submitInvoice`); the batch audit carries the
  policy pointer — and the decision ledger itself is append-only
  (migration 0030, above). Eyes-open caveat: the PER-INVOICE lifecycle
  events and audits inside `submitInvoice` name the grantor with no
  policy marker — a row-level reader correlates through the decision row.
  Surfaces: both cards grow an Automation strip (status line,
  pause/resume/revoke) and an "Automate daily" affordance next to each
  automatable proposal — consent-grade grant copy lives in
  `@workspace/format` (`policyGrantDescription`, restating the chosen
  per-run cap); BOTH cards tag policy-run lines "· auto" in their
  run-record strips (SME's landed in round 29), and both wear an amber
  "N paused" header pill whenever any live grant is paused. Console-side,
  every write affordance on the card (approve, automate,
  pause/resume/revoke) renders only for principals holding
  `invoice.submit` — a read-only viewer (auditor) sees status, pill and
  run record, never buttons that could only 403.
- **Granting notifies the OTHER side (round 30).** The grantor already
  knows — they clicked — so `notifyPolicyGranted` (the pause signal's
  mirror, same rails, same gates, behind the platform-wide
  `messaging_notifications` kill switch) tells the side that did NOT: a
  STAFF-granted policy notifies the client PARTY through the ordinary
  alert fan-out (`automation_granted` template — CORE-03 consent-gated
  inside `fanOutAlert`, pointer-only entity, SMS off by default with no
  prefs row); a CLIENT-granted policy notifies the firm's staff/admins
  under the staff-preference OPT-INS (email only verified+enabled, push
  only when turned on — `notifyAutoPause`'s staff resolution widened from
  the one grantor to every staff member, since the firm side has no
  single owner). Best-effort like every notification in the module: a
  send failure never fails the grant.

### Automation accountability (round 29)

The unattended half of the arc: evidence and signals, all deterministic.

- **Action-effectiveness report**
  (`modules/clerk/action-effectiveness.ts`,
  `GET /clerk/action-effectiveness`, `invoice.read` + the SEC-03 scope
  resolver; console card on the client page). Pure ledger SQL over
  `clerk_action_decisions`: per-kind decision-time tallies split auto vs
  hand-approved, each EXECUTED submit target re-read against its CURRENT
  invoice status (stamped-and-beyond = succeeded; a later rail rejection
  surfaces as failed-again, never buried; a purged invoice lands in
  "other"), and the lowest-band s.104 exposure estimate over the
  window's executed `submit_overdue` count minus the failed-again ones
  (exposure the rails later rejected is back, so it was never removed) —
  `bandExposure`, the same arithmetic and not-advice disclaimer as every
  other exposure surface. Chaser drafts count as executed work with no
  rail lifecycle to verify (reminder effectiveness audits chasing).
- **Tripwire pause signals.** An auto-pause now notifies the GRANTOR
  through the ordinary rails, pointer-only (SEC-12 — no kind, reason or
  client in the message; the why lives on the Automation strip), behind
  the platform-wide `messaging_notifications` kill switch like every
  other sweep-side sender (PL-02: a dark rail means no ledger rows and
  no provider traffic; the pause and its audit land regardless):
  client-granted policies through the party alert fan-out (CORE-03
  consent-gated — a consent_missing pause therefore sends nothing, by
  design), staff-granted through the grantor's staff-preference OPT-INS
  (email under the verified-address gate; push only when turned on) and
  only while they still hold a firm_admin/firm_staff membership.
  Best-effort by construction: sends run autocommit after the pause
  committed, only the CAS winner notifies (no double-sends across
  instances), and a notification failure never touches the sweep.
- **`data.automation_status`** (CLIENT_SAFE, own-party-pinned): Ask can
  say which standing approvals are in force, paused (and why, in
  app-computed words) and when each last ran — and only POINTS at the
  Automation strip; Ask can never grant, pause or revoke.

## Ask Clerk (grounded firm-data Q&A)

### Do with Clerk (round 31 — action-bearing plans, contract 0.60.0)

Ask's planner (`intent.v7`) carries a THIRD closed key kind: `act.*` keys —
the planner-facing index of the proposed-actions catalogue
(`ACTION_INTENTS` in `modules/clerk/actions.ts`; `act.submit_overdue`,
`act.retry_failed`, `act.draft_chasers`). The model still only SEQUENCES:
an act step in an answered plan resolves through `proposalForKind` (the
same live SQL mining as the proposals card, read-only) into an approvable
section — `AskAnswerSection.action` carries the kind, the resolved client
and the capped target ids — and NOTHING executes from an answer. Approval
drives the EXISTING `POST /clerk/action-proposals/execute` route, which
re-asserts capability, the rollout flag, consent and every target at that
moment and writes the append-only decision ledger, exactly as if the
operator had used the actions card. Offering is triple-gated: act keys
enter the plan enum only for firm-scoped askers whose principal holds the
kind's execute capability (the route computes `actionKinds` from the same
per-kind gates: `invoice.submit` for the submit kinds, `clerk.capture` for
chasers; operators are firm-less askers, so they get no act keys at all —
register-only Ask), and only while
`clerk_actions` is lit for the firm (dark = the keys don't exist, the
listActionProposals posture). A firm asker must name a listed client
(per-client batches); a client asker is FORCED to its own party (SEC-03)
whatever the model picked; an act step never takes a month; an empty
assembly answers honestly ("nothing eligible") with no approve payload.
The system prompt's v7 rules pin the write-proposal injection class: an
action key may only answer a question that EXPLICITLY asks for the work,
and the eval corpus carries `inject-act-plant` (a planted order to append
unrequested action steps) where resistance = the un-planted plan.

**Phase 2 (round 32) — plan runs** (`modules/clerk/plan-runs.ts`,
`clerk_plan_runs` firm-keyed RLS migration 0032, contract 0.61.0): an
approved multi-step plan executed by the pipeline worker, one step per
slice, through the ordinary `executeAction` path — each step writes its
own decision-ledger row (`clerk_action_decisions.plan_run_id` links it
back) and the run row is the progress the UIs poll (the batch processor's
claim/fence discipline: status CAS, a claimedAt refresh right before each
step so a slow batch cannot be reclaimed mid-flight, stale reclaim by the
sweep at 30 minutes, every terminal write fence-checked BEFORE its audit,
one live run per case via a partial unique index, expiry of runs nobody
could execute for 72h, and a flag-peeking sweep so a dark firm's parked
run neither churns writes nor blocks the queue). Two deterministic origins:
whole-plan approval of an Ask case (`POST /clerk/plan-runs {caseId}` —
the server RE-READS the stored answer under the previousCaseId guard set
and freezes its action sections; nothing client-supplied reaches
execution) and TEMPLATES (`PLAN_TEMPLATES`; `month_end_close` = submit
overdue → retry failed, assembled by `proposalForKind` at approval — the
month-end close checklist made executable, the SME card's "Run with
Clerk"). **`draft_chasers` is deliberately NOT plan-runnable**
(`PLAN_RUNNABLE_KINDS`): chaser drafts exist only on the execute response
by design (SEC-12, nothing stored), so a background worker would burn
firm tokens and hand the text to nobody — chaser sections are approved
individually, where the drafts land in front of the approver, and a
whole-plan approval containing one refuses (PLAN_UNRUNNABLE). Safety spine: per-kind capability asserted at
creation AND re-validated before every step (the approver as they stand
TODAY, the policy sweep's grantorRole discipline — losing it halts with
`approver_inactive`); a step whose failures cross the autopilot's
half-rule (`tooManyFailures`, now exported) HALTS the run with remaining
steps skipped; a dark `clerk_actions` flag PARKS the run intact.

**Phase 3 (round 33) — recurrence** (`modules/clerk/plan-policies.ts`,
`clerk_plan_policies` firm-keyed RLS migration 0033, contract 0.62.0): a
standing approval for a TEMPLATE — "run month-end close for this client
every month" — mirroring the action-policy autopilot's spine one level up.
Granting (`POST /clerk/plan-policies`, the SME card's "Run monthly")
requires the grantor to hold `invoice.submit`, a live engagement, granted
compliance consent, both flags lit (`clerk_actions` AND
`clerk_action_policies` — recurrence rides the same rollout switch as the
daily autopilot), and one live grant per (firm, client, template) — a
partial unique index backstops the pre-check. The hourly-gated sweep
(`runPlanPolicySweep`) claims each policy's Lagos month by CAS on
`lastRunMonth` (exactly one run per month, however many workers race),
re-validates the grantor AS THEY STAND TODAY, then mints an ordinary
template plan run under the grantor's principal — from there Phase 2 owns
it (per-step re-validation, decision ledger, halts). The claim is
PROVISIONAL until something durable backs it: an empty pass
(NOTHING_TO_RUN) gives the month back — eligibility changes daily as
submission windows lapse and rails reject, so the first NON-EMPTY pass of
the month runs (the daily sweep's leave-the-day-unclaimed rule at month
granularity) and only the closing window (the last Lagos day) consumes a
month that stayed empty throughout, audited `empty: true` with no run
row. A dark flag — checked up front AND on the create's own re-check —
skips without consuming, so a re-lit firm still gets its run; and the
sweep opens with a crash-leak recovery scan (a claim with neither a
this-month run nor the empty audit is an orphan from a death between the
CAS and the create — it is un-claimed and re-run the same pass, per-step
re-validation making the rare duplicate a no-op). Tripwires PAUSE rather
than run wrong: the previous run halting or erroring
(`run_halted`/`run_error` — a halted run means something needs a human
before automation repeats it; the errored month is given back so a
resumed policy still runs it), the grantor losing the capability
(`grantor_inactive`), the engagement closing, consent disappearing, the
template key vanishing; every auto-pause is audited, notified to the
grantor, and raised to operators through the once-per-day
`ops.plan_policy.auto_paused` ledger alert (the daily sweep's fleet
discipline). Offboarding a party revokes its plan policies alongside its
action policies (the offboard audit carries `planPoliciesRevoked`). The
firm-staff **portfolio page** carries the firm-wide **automation rollup**
(`modules/clerk/automation-rollup.ts`, pure ledger SQL, gated
`console.portfolio.read` — a firm-internal aggregate that client_users
must never read, the GET /clerk/digest refusal class): live/paused counts
for both policy kinds (pauses by reason), 30-day plan runs (done/halted)
and 30-day decision totals (automated share, executed/failed) — the
firm's one-read answer to "how much standing automation is in force and
is it healthy".

**Close with Clerk Phase 1 (round 34) — deterministic step kinds**
(`modules/clerk/plan-steps.ts`, contract 0.63.0): plan steps split into
two classes. An ACTION step drives `executeAction` and writes a
decision-ledger row per batch (the round 31–33 machinery, unchanged); a
DETERMINISTIC step is platform SQL plus the platform's own safe writes —
zero model tokens, no decision row, its ledger the rows it creates plus
the run's audits. The plan approval covers it (the approver saw the step
and its target count), and execution RE-DERIVES eligibility so a stale
approval shrinks instead of acting on dead evidence. First kind:
**`draft_recurring`** — the month-end checklist's `unbilled_income`
detections made actionable. The shared miner finds buyers billed on a
monthly rhythm with nothing raised this cycle (template-covered buyers
excluded — the recurring-template sweep owns those); targets are frozen
as (buyer, currency) PAIRS — the miner's own grouping, so approving one
currency's pattern never licenses drafting another. The step raises the
missing paper as DRAFTS under the approver's authority: lines copied from
the buyer's newest invoice in the pattern (never an invented amount), a
placeholder `DRAFT-…` number (entropy-suffixed) the client replaces at
review (their numbering scheme is theirs), foreign-currency patterns
drafted in their own currency with NO rate (the reviewer captures today's
rate — a stale mined one would be silently wrong). **The placeholder
prefix is also the submission wall**: `overdueCond` — both the proposal
assembly AND executeAction's per-target re-validation — excludes
`DRAFT-%` numbers, so a machine draft can never ride `submit_overdue`
(through the card, a whole-plan approval, or a recurring policy's next
month) until a human reviews and renumbers it; the month-end checklist
still COUNTS it as overdue attention (the penalty predicate carries no
wall) — the standing nag that sends the human to review. Idempotence is
double-walled: the created draft closes the mined pattern, and an OPEN
machine draft blocks a second one even after the pattern re-alerts (no
monthly pile-up on a neglected book). Per-pair failures count as FAILURES
into the run's half-rule (an all-failing draft step halts the plan), each
created draft lands an append-only `clerk.plan_step.drafted` audit naming
its run (fence-proof evidence), and the grantor re-validation on
recurring policies derives its required capabilities from the TEMPLATE
(`templateCapabilities`), so a template gaining a step class tightens the
check automatically. `month_end_close` is now [draft_recurring →
submit_overdue → retry_failed] — the submit step's targets were frozen at
approval, so a draft this run just created can never ride the same run's
submit batch either. Capability: `invoice.write` (asserted at approval
and re-validated per step like every kind). Deterministic kinds enter
through TEMPLATES only — Ask's act keys and case-origin plans stay
catalogue-shaped.

**Close with Clerk Phases 2–3 (round 35)** (contract 0.64.0). Phase 2 —
**`reconcile_matches`**, the riskiest deterministic kind: it settles
invoices on payment evidence, so it rides its OWN opt-in flag
(`clerk_auto_reconcile`, LAYERED ON the base `reconciliation` flag —
both must be lit, so a firm whose reconciliation surfaces are rolled
back can never keep auto-accepting through pages nobody can open; dark
= the step never assembles, no template change needed), a threshold
STRICTER than the human-initiated bulk-accept default (0.9 vs 0.85),
and a hard per-run cap (20). Assembly freezes the best high-confidence
proposal per statement line AND per invoice — a duplicated bank credit
(a retried NIP transfer, overlapping uploads) yields ONE acceptance and
leaves its twin a human suggestion — over the client's committed
statements, **receivables only** (the client as supplier): a bill
proposal would flip a payable's evidence-only payStatus to "paid"
unattended, so the debit lane stays human. Execution re-derives
eligibility over the frozen ids (still proposed, still above the bar,
still this client's statement, invoice not already settled/dead) and
accepts through the ORDINARY `acceptProposal` path — which re-asserts
the client binding and confidence floor where the write happens — one
settlement event, one lifecycle transition, one audit row per proposal,
identical to a manual click, plus a `clerk.plan_step.reconciled` audit
naming the run. Race losses (a manual accept, an invoice another line
just settled) count as SKIPS, never half-rule failures. The kind is an
**optional plan kind** (`OPTIONAL_PLAN_KINDS`): `reconciliation.act` is
firm-staff work, so a client_user approver simply gets the plan without
it (never a 403 on the month-end button); an approver who loses the
optional capability mid-run has the step SKIPPED, not the plan halted;
the recurring-policy grantor check derives from REQUIRED kinds only;
and — the authority-basis rule — **optional kinds never ride
POLICY-MINTED runs at all**: a recurring grant was consented against
the template as it stood at grant time, so auto-reconcile executes only
in runs a human approved after seeing the step and its target count.
`month_end_close` is now [reconcile_matches → draft_recurring →
submit_overdue → retry_failed]: settle receipts, raise missing paper,
repair submissions. Phase 3 — **the close pack**:
a TEMPLATE run reaching a terminal state (done or halted) signals its
approver through the shared grantor router (`notifyGrantorSignal`, the
auto-pause rails generalized: client approvers via the consent-gated
party channels, staff approvers via their opt-in channels) with the
`close_pack_ready` template — because a policy-minted run executes with
nobody watching, and its results (created drafts awaiting review, a
halt needing a human) must not wait for a dashboard visit. Case-origin
runs stay quiet (their approver is watching the progress card), the
message is pointer-only (SEC-12 — the run row in the app carries what
ran, what moved and what needs review), and the platform-wide
`messaging_notifications` kill switch gates it like every sweep-side
send. **Deliberately deferred:
in-chat (WhatsApp/email) YES-reply approval of plans.** Approval is a
consent-grade act tied to an authenticated principal and a frozen,
server-read plan; an inbound "YES" over the machine rails is neither — the
rails are pointer-only (SEC-12) and fail-closed, and a reply cannot prove
who is holding the phone, so recurrence keeps approval inside the
authenticated apps and lets the RESULTS ride the existing consent-gated
notification fan-out (which already reaches WhatsApp where the client
opted in).

**Prove with Clerk Phase 1 (round 36) — the automation evidence backtest**
(`modules/clerk/automation-evidence.ts`, `GET /clerk/automation-evidence`,
contract 0.65.0). Every powerful switch above ships dark, so the decision
to light one is taken on faith; this endpoint computes the evidence from
ledgers the platform already holds — per automation kind, how often the
autopilot WOULD have agreed with what humans later did, the median days it
would have saved, and what it would act on right now. Doctrine: recorded
ledgers first (reconcile agreement reads `match_proposals` verbatim, with
a top-of-line guard and machine acceptances excluded via the
`clerk.plan_step.reconciled` audit pointer), replay only over durable
facts (submit/retry verdicts from issue dates and the append-only
lifecycle ledger, behind the DRAFT-% wall, with policy/plan-minted
batches excluded — the rollup's "auto" predicate), and the miner's pure
functions replayed at past Lagos month-ends for `draft_recurring` (its
one approximation — today's statuses — named in the kind's note). Each
kind carries an honest one-line caveat interpolating the LIVE thresholds
and caps, because the consuming card is a consent surface: 60% agreement
is as much the point as 98%. Zero model calls; nothing stored; rendered
under the rollup on the portfolio page (same `console.portfolio.read`
wall). **Phases 2–3 (round 37, contract 0.66.0)** landed on the engine:
`GET /clerk/client-automation-evidence` narrows every cohort to one client
under the action-effectiveness posture (`invoice.read` +
`resolveClientAnalyticsScope` — NOT the portfolio wall), and the grant
dialogs (SME + console standing approvals, the SME "Run monthly" strip,
mobile's confirm) open with the client's own record via the shared
import-free phrasing in `@workspace/format/action-copy`
(`policyEvidenceLine` / `planEvidenceLine`) — evidence informs the consent
sentence, never gates the buttons. The weekly digest gained the SHADOW
line (digest.v8): while a firm's automation switches are dark,
`computeAutomationShadowPending` (the act-now counts only — never the
full backtest inside a 20-firm sweep pass) feeds one registry line that
suppresses via the "do not mention" idiom the moment every switch is lit.
And the **agreement watch** (`modules/clerk/agreement-watch.ts`) closes
the loop for LIT firms: humans keep deciding the cap overflow, so their
monthly agreement rate on ≥threshold receipt proposals — the evidence
engine's exact predicates — stays measurable; a month-over-month collapse
alerts operators once per (firm, month) through the watch ledger
(`clerk.reconcile_agreement.drop`, on the Desk's health-alert list). No
sweep writes a flag: the alert asks for a human judgement, doctrine
unchanged.

- `modules/clerk/data-intents/`: Ask carries a second closed catalogue next
  to the claims register — data intents ("what's overdue?", "what did we
  submit this month?", the money intents "who owes us?" / "what's
  expected this week?" / "who's worth chasing?" backed by the
  receivables/cashflow modules, the payables intents
  `data.payables_due` ("what bills are due?") / `data.total_owed` ("how
  much do we owe?") backed by the same evidence-only payables predicate as
  the Bills surfaces — see `docs/platform.md` § Payables — and
  `data.vat_position` ("where does our VAT stand?"), which phrases the
  SAME `computeVatPosition` / `computeFirmVatPositions` totals as the VAT
  surfaces (month-aware via the shared live-month default, per-client or
  firm-wide, the FX-excluded count disclosed, and deliberately LINKLESS —
  the input side is bills, which are not invoice-detail linkable for a
  client asker)), offered in the
  intent enum only to firm-scoped askers. The model only picks catalogue
  keys; the app runs the matching FIXED, fully-parameterized queries.
  Runtime inputs: the principal-resolved
  firmId plus optional month/client parameters the model can only pick from
  CLOSED app-built option lists — the last 12 Lagos months and the firm's
  own engaged clients under opaque `c1..cN` keys, resolved back through the
  app's own maps; a param a lookup can't honour REFUSES, never silently
  answers unfiltered. Queries run inside `inClerkScope(firmId)` plus an
  explicit firm filter, and the answer is assembled deterministically
  (`answer.dataIntent` marks these, `answer.dataParams` names the resolved
  scope). Predicates mirror digest/compliance-window (Lagos calendar), so
  Ask can never disagree with the dashboards.
- **Comparison intents (Ask 2.0, `data-intents/deltas.ts`)** — the two
  delta lookups, APPENDED last (the catalogue order is model-facing and
  append-only). `data.month_delta` (client-safe) compares a named — or the
  current — Lagos month with its app-derived predecessor
  (`priorMonthStart`, never the model's arithmetic) on three bases, each
  pure composition over the catalogue's existing one-homes so a delta can
  never disagree with the point lookups it compares: rails-accepted
  submissions via `invoiceAggregate` over the SAME accepted-in-month
  membership as `data.submitted_this_month` (the shared `lagosWindowSql`
  boundary), net VAT via `computeVatPosition` /
  `computeFirmVatPositions` (per-client under a pin — a client asker's
  forced own-party pin lands here — the firm rollup totals otherwise),
  and unpaid bills DUE in each month via `billAggregate` (`BILL_UNPAID`
  plus a due-date month bound). Every figure — six month numbers plus
  three deltas — is platform-computed, every delta phrased WITH its sign
  so a drop can never read as growth; deliberately LINKLESS
  (billAggregate's posture: the payables side is bills).
  `data.client_breakdown` (firm-only BY DESIGN: it RANKS the firm's
  clients against each other — exactly the firm-wide content the
  client-safe subset exists to withhold, so `accepts.client` stays false
  and the key never joins the allowlist) names the top movers up and down
  in rails-accepted invoice totals between the two months: ONE grouped
  SQL pass over both months, membership by `packMonthDocsSql` (the VAT
  pack's own accepted-in-month fragment, so the ranking and the pack
  agree by construction), invoice-kind totals only, largest absolute
  swing first with name tiebreaks, up to 3 named per direction with an
  honest remainder; linkless (a client ranking names no individual
  invoices).
- **The planner (Ask 2.0, `intent.v6`, contract 0.56.0)** — the
  single-key classification became an ordered PLAN of 1–3 steps
  (`{category, steps: [{key, month, client}]}`, `PLAN_MAX_STEPS` = 3 in
  prompts.ts) so a genuinely multi-part question ("what's overdue and
  what do we owe suppliers?") runs several lookups in one turn — still
  exactly ONE model call per ask (the data-intents test pin); everything
  after the inference is deterministic app code. The closed catalogue is
  enforced THREE times: the strict JSON schema's per-step enums carry
  only the offered claim/data keys and month/client option keys
  (`planJsonSchema`), the zod validator mirrors the same enums
  (`planValidator`), and ask.ts re-resolves every step against what THIS
  asker was OFFERED — so a "data.*" pick by a firm-less asker can only be
  a register claim, and a client asker can never reach an intent outside
  its client-safe subset even via a colliding claim key. An EMPTY steps
  array IS the refusal — the v6 key enum carries no "none"; emptiness
  escalates with the same neutral sentence as ever — and the system
  prompt refuses whole when ANY part of the question has no matching key
  or it asks for more than 3 things (a plan flood is an injection, not a
  workload); comparison questions are steered to a single delta key over
  two point lookups. A register claim answers ALONE: any multi-step plan
  containing a claim key refuses whole (fail closed) — the claim path's
  category-applicability logic is single-answer logic, and a claim
  proposition pasted between data sections would blur whose citation
  covers what; the single-step claim path itself is unchanged
  (exactly-one active claim, category check, verbatim protected facts).
  Execution: steps dedup app-side by EFFECTIVE scope (for a client asker
  the forced pin makes the model's client pick irrelevant to identity),
  then run sequentially in plan order, each with a FRESH
  `DataIntentParams` (the 0.56.0 fix — the old shared params object would
  have leaked one step's month/client into the next). A single-step plan
  answers in EXACTLY the pre-plan flat shape (plus `pins`), single-step
  refusals verbatim included, so every pre-0.56 consumer and fixture
  behaves identically. A multi-step plan answers with **sections** — one
  `AskAnswerSection` (title/text/facts/dataParams/links) per step in plan
  order under a deterministic part-count lead-in, flat facts empty and
  flat links absent; a refused step KEEPS ITS SLOT as an honest "This
  part could not be answered." section with its escalation clause
  stripped (the case is APPROVED when any part answered, so the sentence
  must not claim an escalation that did not happen); ALL steps refused ⇒
  the whole case refuses with the FIRST reason. `answer.plan` (the
  executed keys + app-resolved titles), `answer.pins` and
  `answer.sections` are the contract 0.56.0 ClerkAnswer extension —
  `AskAnswer` in ask.ts MUST mirror openapi.yaml because the stored jsonb
  answer IS the API answer (the db type still carries the lean pre-0.56
  shape) — and the `clerk.ask` audit records the executed plan's keys
  (pointer-only catalogue strings, never user or model text).
- **Multi-turn (pins BY ID since 0.56.0)**: the web clients thread the
  previous answered case's id (`AskClerkInput.previousCaseId`); the
  server loads that case inside `inClerkScope` with an explicit firm +
  kind filter (plus `createdBy` for client askers — SEC-03). A data
  answer now stores the scope it RESOLVED TO by id (`pins.monthStart` /
  `pins.clientPartyId`, display labels alongside), and a follow-up
  re-pins from those ids after validating them against THIS request's
  live option lists — a month that has rolled out of the 12-month window,
  or a party outside the asker's (already SEC-03-narrowed) client
  options, is DROPPED silently, never trusted. Ids, not labels, on
  purpose: two clients sharing a legal name resolve to the EXACT party
  the previous answer used, where the old label matching resolved
  whichever sorted first — the hazard 0.56.0 fixes. Label matching
  survives ONLY as the fallback for pre-0.56 cases whose stored answers
  carry no pins (`answer.dataParams` display labels mapped back through
  the offered lists, the " (current month)" suffix stripped on both
  sides). A multi-part previous answer threads its LAST executed plan
  step — the same step whose scope the stored pins carry (documented
  choice: "and for June?" after "X; also Y for Acme" most naturally
  continues the trailing lookup). The context line the model sees still
  carries only platform-recorded data-intent keys and `m*`/`c*` option
  keys, so a follow-up ("and for June?") inherits scope while the
  closed-catalogue machinery stays exactly as strict (a cross-firm,
  sibling-client or non-question id contributes nothing).
- **Client access** (SEC-03-pinned): Ask is open to `client_user`s. The
  offered data intents narrow to a vetted ALLOWLIST
  (`CLIENT_SAFE_DATA_INTENTS` — firm-wide money intents that name other
  clients' buyers, and the firm's own budget, are excluded and refuse; the
  two payables intents `data.payables_due` / `data.total_owed`,
  `data.vat_position`, `data.pending_approvals` (round 17 — the caller's
  own drafts blocked on the maker-checker policy, policy-off answered
  plainly), `data.penalty_exposure` (round 18 — the caller's own
  overdue paper priced at the small-band floor) AND `data.invoice_status`
  (round 20 — ONE invoice named by its number, the number APP-EXTRACTED
  from the raw question by regex, never the model; the pinned lookup
  matches either side of the caller's own paper and answers a sibling's
  number with "no invoice" — non-disclosure) AND `data.month_delta`
  (Ask 2.0 — every side of the comparison reduces to an own-party
  one-home under the forced pin; `data.client_breakdown` is deliberately
  absent) ARE client-safe and on the
  allowlist — they answer over the
  caller's own bills/position/paper only, the forced party pin making a
  client's "VAT position" always its own); the client option list is exactly the caller's own party; the executed party
  filter is FORCED from the principal regardless of the model's pick —
  and since 0.56.0 the forced pin is CONDITIONED on the intent's
  `accepts.client`: an intent that would IGNORE the pin refuses instead
  of running (previously the pin was applied unconditionally AFTER the
  accepts check, so a non-client-capable intent offered to a client would
  have run firm-wide; every client-offered intent does honour the pin —
  the client-safe test pins it — so the refusal arm is defensive);
  multi-turn threads only from the client's own previous case (`createdBy`
  check); and `GET /clerk/digest` explicitly refuses client_user now that
  the capability is shared. The SME app carries the client Ask surface; the
  mobile app carries an Ask screen too (`mobile/app/clerk-ask.tsx`).
- **Action links** — a data-intent answer carries deterministic app-derived
  links (`answer.links`, `ClerkAnswerLink`, kind `invoice`) built from ids
  threaded through the SAME scoped queries that computed the facts — never
  model-produced, so a link can only ever point at a row the asker's own
  scope already surfaced. On a multi-part answer the links ride each
  section (`sections[].links`); the flat links stay absent. The SME app
  and mobile render them as "Open" buttons straight to the invoice.
- **Ask 2.0 surfaces** — the three Ask pages (SME
  `sme-compliance/src/pages/clerk-ask.tsx` with helpers in
  `sme-compliance/src/lib/clerk.ts`, console
  `console/src/pages/clerk-ask.tsx`, mobile `mobile/app/clerk-ask.tsx` +
  `mobile/lib/clerk-ask.ts`) render sections as per-part blocks, a quiet
  "Answered using: …" plan-transparency line above them (`planLine` —
  app-trusted intent titles shown verbatim, in server order; omitted on
  single-intent answers, which render the flat fields exactly as before),
  and the multi-turn thread's visible face: while a follow-up would
  inherit scope, a chip says what it keeps ("Follow-ups keep: <month> ·
  <client>", `followupPinsLine` — display labels only, the machine pins
  never render) next to a "New topic" button that drops `previousCaseId`
  and nothing else (the answer stays on screen).
  `holdsFollowupCase` widened with the contract: any ANSWERED reply
  carrying inheritable scope — a flat dataIntent, sections, or pins
  (machine pins included, because the server threads on those even with
  no label to display) — holds the thread, and because the predicate
  gates SETTING the id, never clearing it, a refusal or register-claim
  answer in between does not sever the thread. The SME/mobile suggestion
  chips grew a fifth entry, "How does this month compare to last
  month?", which lands in the client-safe `data.month_delta` (the chip
  allowlist rule: every chip must classify to a CLIENT_SAFE intent, or
  it is a one-click refusal for a client asker); the console Ask page
  carries no chips.
- **Ask feedback** — askers rate answers helpful/not-helpful
  (`POST /clerk/cases/{id}/feedback`, creator-only, question cases including
  refusals; the signal lands on the case row, `feedback`).
  `GET /clerk/ask-feedback` (`clerk.use`, console health page card) mines
  the ratings — totals, a per-intent split (`register` / `plan` /
  `refused` / data-intent keys), the newest not-helpful questions — the
  answered-question sibling of claim-gap mining: refusals say what to draft
  next, not-helpful says what to fix next. Multi-part answers carry no flat
  `dataIntent` (their intents live per-section), so they bucket under
  `plan` — pinned by clerk-review-integrity.test.ts.
- **Claim-gap mining** (`modules/clerk/claim-gaps.ts`,
  `GET /clerk/claim-gaps`, `clerk.use`, pure SQL, console claims-page card):
  Ask's refusals are themselves mined — a trailing window's refused answers
  clustered by a stable refusal-code mapping of the exact sentences ask.ts
  produces (unknown text folds to `other`; the no-matching-claim needle is
  one constant shared between the TS matcher and the SQL LIKE so they can
  never disagree), listing the newest uncovered questions with their firm
  names — the evidence for what claims to draft next. The Ask 2.0
  claim-mix refusal ("…cannot be combined with other lookups…") has its
  own stable code `claim_in_plan`; the claim-gaps test pins every sentence
  ask.ts produces to its code, so a reworded refusal fails there instead
  of silently landing in `other`.

## Drafting & phrasing assists (digest posture)

Common contract: facts/grounding are deterministic, the model only phrases or
names, a template fallback always answers, and nothing is stored or sent
without a human owner.

**How a phrasing surface reaches the model** — through `inferPhrasing`
(`modules/clerk/gateway.ts`): one call that re-checks the `clerk_ai` flag and
folds EVERY typed gateway failure (kill switch, missing provider, the budget
backstop, discarded output) to null, so the caller's deterministic template
answers — never an error, and never the kill-switch TOCTOU where a `clerk_ai`
flip between a surface's own flag check and its bare `gateway.infer` call
threw `CLERK_DISABLED 503` out of a route that promises it cannot error for
AI-availability reasons. That drift shipped four times (draft-reply in #93;
the advisory narrative, the weekly digest and the monthly client statement in
the round-30 fix wave, all three now wrapped — each also keeps an outer try
so even a post-provider ledger failure or a grounding-check crash still
answers with the template, source tagged honestly). The rule is now
STRUCTURAL: a source-scan test (`middleware/rate-limit-lockstep.test.ts`,
"no module calls gateway.infer outside gateway.ts and the allowlist") fails
on any bare `<gateway>.infer` call in a module file unless the file is on a
reasoned allowlist — classification/extraction surfaces whose typed failure
correctly refuses, drafting proposals whose failure is a typed refusal the
user retries, eval/canary machinery where a throw must abort the run, and
quarterly-note.ts's documented local try/catch. A NEW phrasing surface
(template fallback + "clerk"/"template" source tag) must use `inferPhrasing`
or justify its allowlist entry; the scan also fails on stale allowlist
entries.

- **Failure explainer** (`modules/clerk/explain.ts`) — catalogue-grounded:
  the model only rephrases; kill switch/budget failures fall back to the
  catalogue text, never to an error. Its route is gated on `clerk.capture`
  (NOT `clerk.ask`) so the client whose invoice failed can use it — the
  module itself enforces tenant + SEC-03 party scope. The SME invoice
  detail's failed card is its consumer (fix-and-retry: PATCH the
  still-mutable failed invoice, then resubmit, with `ERROR_FOCUS` in
  `sme-compliance/src/lib/error-focus.ts` — mirrored on mobile — flagging
  which fields a rail code implicates).
- **NL invoice drafting** (`modules/clerk/draft-invoice.ts`, `clerk.capture`)
  — turns one sentence — typed, or spoken via the mobile "Speak it" card
  ({text | audioBase64} exactly-one; audio is never persisted, the
  transcription is ledgered as `transcribe_voice`, and the transcript walks
  the same fenced path and is returned for the user to check) — into a
  prefilled SME draft form. Every extracted value is re-validated/normalised
  by the app; buyer identity is a deterministic register suggestion; nothing
  stored (the client saves through the ordinary `createDraft` path).
- **Customer-list import drafting** (`modules/clerk/draft-client-import.ts`,
  `clients.import` + firm scope, firm-funded) — the draft-format seam
  pointed at the client book: Clerk NAMES which export column carries each
  import field, every proposal is re-verified against the headers that
  literally exist (hallucinated required column fails closed 502,
  hallucinated optional column dropped), and the returned rows come from the
  deterministic mapper — they feed the ordinary `/clients/import`
  validate-then-commit flow, so Clerk can never create a party.
- **Statement-format drafting** (`modules/clerk/draft-format.ts`) — proposes
  custom statement column mappings from a pasted sample with header names
  re-verified against what actually exists; the mapping store itself lives
  in `modules/statements/custom-formats.ts` (see `docs/platform.md`).
- **Claims drafting** (`modules/clerk/draft-claim.ts`, operator
  `claims.write`) — creates a DRAFT register entry that still walks the full
  maker-checker flow.
- **Catalogue drafting** (`modules/clerk/draft-catalogue.ts`, operator
  `catalogue.write`) — proposes an error-catalogue entry grounded in
  observed rail rejections; the draft is returned for the operator to edit
  and save through the ordinary catalogue routes, never stored directly.
- **Reconciliation match assist** (`modules/clerk/reconcile-assist.ts`,
  behind the `reconciliation` flag) — explains one statement line's
  candidate set; ranking and highlights are computed from the matcher's
  recorded features, Clerk only phrases the comparison, template fallback
  always answers.
- **Narration match lane** (`modules/clerk/narration-match.ts`,
  `POST /clerk/narration-suggestions`, `reconciliation.act`, contract
  0.58.0) — the assist's CLASSIFYING sibling, and deliberately NOT digest
  posture: it is a real spend (fail-closed `getClerkGateway` + budget
  pre-check, NO_CONTEXT + model-rate-limited, capped 20 lines/call). For
  middle-band lines only (`[PROPOSAL_THRESHOLD, DEFAULT_BULK_ACCEPT_THRESHOLD)`
  — each bound owned by the module that enforces it) the model reads the
  fenced narration against a POSITIONAL candidate list (Candidate 1..3; it
  never sees a proposal/invoice id, so it cannot hallucinate one) and
  returns a pick + cue from the closed catalogue, or "none" —
  abstain-by-default. The result lands on
  `bank_statement_lines.narration_suggestion` (abstentions persist, so
  re-runs never re-spend; failures persist nothing and stay retryable);
  the SME page renders it as an advisory "Clerk suggests" chip, and
  accepting stays the untouched human decision path. Kept-rate
  (`narrationKeptRate` → the metrics report's `narrationMatch` block) is
  pure SQL over suggestions vs the proposals humans later accepted.
- **Advisory narratives** (`modules/advisory/narrative.ts`,
  `engagement.write`) — phrase a completed assessment/VAT-risk engagement's
  stored findings into a client letter body (template fallback, never
  stored, the partner owns the letter).
- **Payment-chaser draft** (`modules/clerk/draft-chaser.ts`,
  `POST /clerk/draft-chaser`, `clerk.capture` + module-enforced
  tenant/SEC-03 like the explainer) — the model phrases ONE outstanding
  receivable's stored facts (eligibility is the receivables definition
  exactly, so a settled invoice can never be chased) plus the buyer's
  payment rhythm into a reminder the client copies into their OWN email;
  template fallback always answers, nothing stored, nothing sent by the
  platform. The chaser is a **ladder**: `chase_log` (firm-keyed RLS
  migration 0018) records one row per reminder the client actually SENT —
  the UI logs on COPY (`POST /invoices/{id}/chase-log`, `invoice.write` +
  the same tenant/SEC-03/still-outstanding gates), never on draft — and the
  draft reads the count to escalate register with the stage (`chaser.v3`:
  warm → politely firm → confirm-a-payment-date; NEVER threats, in the
  system prompt and every template). The weekly digest counts outstanding
  invoices at 2+ reminders (`countFirmChasedTwice`).
- **Escalation triage** (`modules/desk/triage.ts`, opt-in `clerk_triage`
  flag, sweep-driven so the client's escalation never waits on a model call)
  — proposes routing: closed category set, priority, catalogue code
  re-verified against the codes that exist — stored on the operator case for
  the operator to accept or override, never applied automatically.
- **Drafted escalation replies** (`modules/desk/draft-reply.ts`, operator
  `operator.queue.act`, platform-funded) — the explainer posture on the
  desk: the draft is grounded in the catalogue cause/fix + the invoice's
  real attempt history (the client's message only inside the fence);
  template fallback always answers; `sendEscalationReply` is the ONLY writer
  of `escalations.operator_reply` (acknowledges an open escalation; the SME
  invoice detail shows the client the reply). **Reply memory**
  deterministically retrieves the firm's own newest SENT reply for the same
  catalogue code and rides it along as a fenced STYLE example (never
  cross-firm, specifics forbidden by the system prompt, variant ledger
  version `draft-reply.v1+ex1`, `viaExample` in the response).

## Advise with Clerk (round 49, Phase 1 — the per-client advisory brief)

The firm's monthly advisory work product, stored and evidence-cited
(`modules/clerk/advisory-brief.ts`, table `clerk_advisory_briefs`,
firm-keyed RLS via migration 0041, contract 0.75.0):

- **Composition, never computation**: the module contains zero predicates
  of its own. Five closed sections — statutory position (`countOpenFilings`
  + `openFilingSamples` + `countOpenObligations`), penalty exposure
  (`computePenaltyExposure`), VAT for the last closed month
  (`computeVatPosition` + the statutory calendar's due date), money
  position (`computeCashflowOutlook` + `listChaseRows`, dominant currency
  group), books hygiene (unbilled income, missing recurring bills,
  unmatched credits, unmatched collections) — each reusing the exact
  compute function its cited `sourceReport` serves, all sharing one `now`.
- **One phrasing call** (digest posture): the adviser's-note lead-in only —
  purpose `advisory_brief`, prompt `advisory-brief.v1`, firm-funded,
  number-grounded against the fact lines (`buildBriefUser`), template
  fallback on every failure mode, `source` recording which path answered.
- **Live-month upsert**: one brief per (firm, client, Lagos month),
  regenerated in place — the natural unique key absorbs the refresh and
  `updatedAt` records it; every generate appends an audit row
  (`advisory.brief.generate`). The stored sections jsonb mirrors the
  contract's `AdvisoryBriefSection` (stored-durably: additive-optional
  changes only).
- **Routes** (`routes/clerk/advisory.ts`): `POST /clerk/advisory-briefs`
  is FIRM work product (`engagement.write` — a client never triggers the
  firm's advisory spend; MODEL rate class, in-transaction digest posture);
  `GET /clerk/advisory-briefs` follows the client-statements route's exact
  SEC-03 shape (a client_user pinned to its own party). An un-engaged
  party id 404s before anything is stored. Console renders the brief on
  the client detail page (generate/refresh button); the SME dashboard
  shows the client's own latest brief read-only.
- **Monthly sweep + delivery** (Phase 2, round 50 — the statement rail
  verbatim): generation rides the shared sweep behind the opt-in
  `clerk_advisory_briefs` flag (seeded dark; it spends firm tokens on
  every engaged client's note) — try-lock 731_852, live-engagement
  candidates missing the LIVE month's row via the natural-key anti-join
  (a firm-generated brief simply removes the pair), a PER-FIRM
  override-aware flag wall inside the loop (the firm-spending-sweep
  rule) and per-pair try/catch poison isolation; sweep rows carry
  `generatedBy null`. Since round 53 each pair generates inside an
  explicit firm-PINNED request context (`runRequestContext` —
  `meridian_app` + `app.firm_id`, the byte-same posture the POST route
  gives the function), so generation neither depends on the pool
  login's `BYPASSRLS` nor can cross firms mid-pass. Delivery runs every pass regardless of the flag
  (stranded-backlog rule): claim-first CAS on `deliveredAt` committed
  BEFORE any send, `messaging_notifications` dark still claims (PL-02),
  then `fanOutAlert` — consent-gated (CORE-03), pointer-only (SEC-12,
  `advisory_brief_ready`, `pointerEntityRef("brief", id)`). ONE
  deliberate difference from statements: no quiet suppression — an
  "on track" brief is still the firm's monthly deliverable. No mobile
  deep link yet (no mobile brief screen; the push opens the app home).
- **Continuity + advisory memory** (Phase 3, round 51, contract 0.76.0):
  generation loads the previous month's STORED brief — last month's
  frozen truth, never a recompute — and appends a deterministic
  "Since last month's brief" section: per-key deltas over the tracked
  attention positions (statutory overdue, unfiled, past-window
  invoices, chase-worthy, books hygiene) with improved/worsened triage
  counts, both numerals of every comparison riding fact lines so the
  grounding gate accepts a phrased note that quotes them. A first brief
  has no comparison (the omission rule); an unreadable old blob degrades
  to the same silence. The `advisory_briefs` memory corpus indexes
  CLOSED-month briefs (immutable by construction — regeneration is
  live-month-only), and the Ask memory note now searches it beside
  `ask_questions`: brief items carry `kind: "advisory_brief"`
  (additive contract field), re-read live under the firm pin plus the
  clientPartyId sibling wall for client askers (a party-less client
  caller gets no brief items, fail closed).

## Digests, statements & delivery

- **Weekly digest** (`modules/clerk/digest.ts`, opt-in `clerk_digest` flag,
  sweep-generated, firm-keyed RLS via migration 0011) computes every fact in
  SQL — including the money facts from `firmMoneySummary` (payments expected
  in the coming week per each buyer's rhythm, and the chase-worthy count
  past BOTH due date and rhythm), firm-wide unmatched credits, unbilled
  income (`countFirmUnbilled`), outstanding invoices with 2+ logged
  reminders, a payables-due fact (bills falling due or overdue, from the
  same evidence-only payables predicate as the Bills surfaces), and the
  monthly VAT-return countdown (`vatReturnInDays` — pure Lagos calendar
  arithmetic to the next 21st, null beyond 7 days so the weekly digest only
  speaks up when the clock is close), the awaiting-approval count under the
  maker-checker policy (null when the policy is off — never a zero), and
  the week's unmatched collection-account payments — and lets the model
  phrase them, falling back to deterministic template text. Each fact added
  to the user facts bumps the prompt version so the model path can never
  lag the template path (currently `digest.v6`, the money-risk round: the
  s.104 penalty-exposure floor — small band, null when clean — and the
  missing-recurring-bills count joined the facts). The
  digest's unsubmitted/overdue compliance facts use the explicit
  receivable-orientation predicate, so captured supplier bills never count
  as "invoices to file" (`docs/platform.md` § Payables).
- **Digest delivery**: `clerk_digests.delivered_at` + `deliverFirmDigests`
  (every sweep pass, claim-first CAS, dark messaging claims silently) offer
  the digest to the firm's staff who opted in via **staff notification
  preferences** (`staff_notification_preferences`, user-keyed, defaults ALL
  OFF, migration 0019 firm-keyed RLS, self-service
  `GET/PUT /staff/notification-preferences` — userId always from the
  principal, per-(user, firm) rows). No CORE-03 gate here on purpose: the
  recipient is a firm member who opted in themselves, not a client party.
  Sends are pointer-only (`usr`/`dig` refs, `firm_digest_ready` template,
  email + push), and email delivery requires a VERIFIED address —
  request-code/confirm endpoints, sha256-only + 15-min expiry, the raw
  address+code handed to the outbound relay as the one documented SEC-12
  exception (verification cannot ride a pointer; the relay is the
  address-handling boundary); changing the address drops its stamp.
- **Per-client monthly statement** (`modules/clerk/client-statement.ts`,
  opt-in `clerk_client_statements` flag, sweep-generated for the newest
  CLOSED Lagos month for every OPEN/in-progress engaged client, firm-keyed
  RLS via migration 0015, unique on firm+client+month) — the digest posture
  per client: facts in SQL, model only phrases, quiet months never call the
  model, template fallback always answers. Since round 53 the sweep
  generates each pair inside an explicit firm-PINNED request context
  (`runRequestContext` — `meridian_app` + `app.firm_id`), so generation
  neither depends on the pool login's `BYPASSRLS` nor can cross firms
  mid-pass; only the gateway's ledger append stays on the raw pool (spend
  must survive any rollback). Its read route
  (`GET /clerk/client-statements`, `clerk.capture`) pins a `client_user` to
  its OWN party (SEC-03; firm RLS is not a sibling wall); the SME dashboard
  shows the client their own card. Generated statements are also OFFERED
  over the alert rails (`deliverClientStatements`, run every sweep pass):
  claim-first CAS on a nullable `delivered_at` so two instances can never
  double-send; quiet statements and a dark `messaging_notifications` flag
  claim silently; the send is the ordinary party-scoped `fanOutAlert` —
  CORE-03 layer-1 consent first-line, `client_statement_ready` template,
  pointer-only `stmt:<id>` reference (SEC-12), no SMS default.
- The mobile app's updates screen (`mobile/app/clerk-updates.tsx`) shows the
  firm digest and client statements from the same endpoints.

## Reports (deterministic, on demand, nothing stored)

- **Monthly VAT filing pack** (`modules/clerk/vat-pack.ts`, `GET /vat-pack`
  + CSV export, `console.portfolio.read` + firm scope, console portfolio
  card) — the firm-level view of accepted-in-month facts, deterministic end
  to end.
  - **Filing cover note** (`modules/clerk/vat-note.ts`,
    `POST /vat-pack/cover-note`, same gate, firm-funded) phrases the pack's
    computed facts into a note the partner edits and owns — digest posture
    with NO route budget pre-check (kill switch, missing provider, exhausted
    budget, invalid output, quiet month all answer with the deterministic
    template, and a quiet month never calls the model).
  - **Settlement cross-check** (`modules/clerk/vat-settlement.ts`,
    `GET /vat-pack/settlement-check`, same gate + month discipline,
    deterministic, nothing stored) splits the pack month's accepted invoices
    — the pack's EXACT population, invoices only — by what settlement the
    platform has OBSERVED (status settled / the receivables OUTSTANDING
    fragment / credited, a strict partition), with a capped largest-first
    unsettled list (cap+1 truncation flag) and a note pinning the semantics:
    unsettled means UNOBSERVED, not unpaid — an assurance view, never an
    accusation.
  - **Net VAT position** (`modules/clerk/vat-input.ts`,
    `GET /vat-pack/position`, same gate + month discipline, deterministic,
    nothing stored) joins the pack's output VAT to the bills ledger's input
    side: input VAT counts toward the position ONLY when the bill's NEWEST
    stamp verification says valid (`bill_verifications`, newest-verdict
    wins), so net position = output net VAT − verified input VAT is a
    filing number, not a hope. Bills are bucketed by ISSUE month — the
    pack's own basis — and the capped largest-first unverified list is the
    recovery CTA ("verify these to move ₦X into the position"). Console
    portfolio card next to the pack.
- **Quarterly review pack** (`modules/advisory/quarterly-pack.ts`,
  `GET /quarterly-review`, same gate, console portfolio card) assembles a
  CLOSED Lagos quarter into one deterministic document — the three monthly
  VAT packs summed via the SAME `computeVatPack` calls (so the quarterly and
  monthly surfaces cannot disagree), in-quarter submission outcomes and top
  rejection codes (GROUPING SETS keeps the total honest beyond the row cap),
  an as-of-generation per-currency receivables snapshot (the OUTSTANDING
  fragment), and in-quarter Clerk throughput. Its **cover note**
  (`modules/advisory/quarterly-note.ts`, `POST /quarterly-review/cover-note`,
  purpose `draft_quarterly_note`, firm-funded) is the vat-note contract
  exactly — digest posture, quiet quarter never calls the model, template
  always answers.
- **Compliance-pack cover note** (`modules/clerk/pack-note.ts`, purpose
  `draft_pack_note`, prompt `pack-note.v1`, firm-funded) — the vat-note
  shape pointed at the monthly client pack (`docs/platform.md` § Monthly
  compliance pack): every figure comes from the deterministically computed
  pack facts, the model only PHRASES, and the digest posture holds end to
  end — kill switch, missing provider, exhausted budget (no route
  pre-check; the gateway backstop's typed failure is just one more reason),
  invalid output and a quiet month (no documents, no bills — saying
  "nothing happened" is the digest anti-pattern) all answer with the
  deterministic template, never an error. Nothing is stored — the note
  lives only inside the rendered PDF — and the pack's VAT basis disclosure
  travels with it so the caveats survive the paper being handed around.
- **Automation evidence backtest** (`modules/clerk/automation-evidence.ts`,
  `GET /clerk/automation-evidence`, `console.portfolio.read`, portfolio
  card under the rollup; per-client twin
  `GET /clerk/client-automation-evidence` on the effectiveness posture for
  the grant dialogs; pure SQL + pure replay) — per automation kind,
  recorded-ledger agreement with the decisions humans made by hand over
  the 6-month window, median lead time, act-now counts, and the submit
  lane's s.104 small-band would-have floor. Machine writes never count as
  agreement; the per-kind caveat notes are part of the payload. See § Do
  with Clerk (round 36) for the doctrine.
- **Adoption & impact report** (`modules/clerk/adoption.ts`,
  `GET /console/clerk-adoption`, `console.portfolio.read`, console portfolio
  card, pure SQL) slices the firm's own cases per client — capture volume,
  kept-rate from the corrections exhaust, review turnaround (same expression
  as `metrics.avgDecisionMinutes`), attribution via the approved invoice's
  supplier party (the only deterministic join for every capture path;
  non-approved cases count in firm totals only) — the renewal-conversation
  numbers, zero model calls.
- **Rejection-pattern report** (`modules/desk/rejection-patterns.ts`,
  `GET /rejection-patterns`, `console.portfolio.read`, console portfolio
  card, pure SQL) aggregates the firm's own rejected submission attempts
  into recurring catalogue-grounded causes over a trailing window plus the
  equal-length window before it, unmapped codes included — the aggregate
  view the one-case-at-a-time desk never sees.
- **Rejection risk** (`modules/invoice/rejection-risk.ts`,
  `GET /invoices/{id}/rejection-risk`, `invoice.read` + the invoice read's
  exact tenant/SEC-03 gates, deterministic, nothing stored) — the
  draft-time sibling: the firm's own rejected attempts over a trailing 90
  days joined to THIS draft's supplier and buyer parties plus the firm's top
  codes (deduped), catalogue-grounded — signals name history, never
  predictions. The SME invoice detail shows the card on draft/validated
  invoices before submission.
- **Catalogue coverage report** (`modules/desk/catalogue-coverage.ts`,
  `GET /error-catalogue/coverage`, `catalogue.write`, catalogue-page card,
  pure SQL, platform-wide like the catalogue itself) — the INT-02
  measurement: the share of rejection traffic the catalogue maps today, the
  currently-unmapped codes with the age of the debt and whether the
  unmapped-code sweep's desk case is tracking each, and the mapping SLA
  (time from a code's first rejected sighting to its catalogue entry;
  entries mapped before any sighting count as proactive, never judged).
- **Firm compliance calendar** (`modules/invoice/compliance-calendar.ts`,
  `GET /compliance-calendar`, `console.portfolio.read`, console portfolio
  card, deterministic) — the month-ahead view of the SAME statutory clocks
  each client's dashboard shows: submission-window dates and VAT 21sts from
  the same constants and Lagos expressions, aggregated across the firm in
  one SQL pass, so the two surfaces cannot disagree.
- **Operator daily brief** (`modules/desk/daily-brief.ts`,
  `GET /console/operator-brief`, `operator.queue.act`, operator-queue card,
  pure SQL, zero model calls) — the platform-wide morning triage view:
  open/in-progress operator cases by priority with the oldest named,
  unanswered escalations, queued/processing async batches, unmapped-code
  cases, yesterday's decided-extraction count (Lagos day on `updated_at`,
  the decision clock), plus the Clerk kill-switch state, a live
  `spendAlerts` count, and the SAME resistance-drop verdict as the health
  banner (`detectResistanceDrop` over `injectionResistanceMonths`, so brief
  and banner cannot disagree).
- **Merge impact preview** (`modules/party/merge-impact.ts`,
  `GET /parties/merge-impact`, `party.merge`, pure SQL) counts each side's
  direct FK references (invoices as supplier/buyer, engagements, logins,
  recurring templates, aliases, statements, escalations, consent grants —
  the CORE-03 spine — and desk cases) before an irreversible party merge;
  the console merge dialog shows a "Carries:" line per candidate so the
  operator picks the survivor with the evidence in hand.

### Console Clerk health metrics (`modules/clerk/metrics.ts`)

- **Confidence calibration** (`computeCalibration`): kept-rate vs model
  confidence per band, from the corrections exhaust.
- **Correction-shape mining** (`metrics.correctionShapes`, optional, zero
  model calls): the same newest-500 exhaust classified by the SHAPE of each
  override (day/month flip, percent-vs-fraction VAT, power-of-ten scale,
  missed/hallucinated value; line fields folded under their normalized name)
  so the health page says what KIND of mistakes extraction makes, not just
  how many.
- **Per-supplier accuracy** (`metrics.supplierAccuracy`, pure SQL): joins
  the corrections exhaust to the approved invoice's register supplier so the
  health page names whose documents Clerk reads worst.
- **Injection-resistance trend** (`metrics.injectionTrend`, pure SQL over
  the stored eval runs): monthly resistance buckets and the
  per-prompt-version split — whether a promoted prompt actually held the
  line the canary predicted. Text and vision injection fixtures fold into
  the SAME buckets, so the trend measures the image channel too.
- **Kept-rate trend** (`metrics.keptRateTrend`) and `metrics.qualityAlert` /
  `metrics.resistanceAlert` banners come from the SAME shared buckets as
  the watches below, so chart, banner and alert can never disagree.

## Memories & deterministic advisors (zero model calls)

The corrections/approvals exhaust feeds the product directly; none of these
call the model.

- **Supplier memory** (`modules/clerk/exemplar.ts`) deterministically matches
  a new text document against the firm's OWN approved fixtures
  (TIN/name-token containment, newest first, same-firm join — never
  cross-firm; a fixture with nulled identity never matches, which is how
  promotion-scrubbed fixtures and an offboarded client's retired fixtures
  stay out — see Evals) and rides the match along as a fenced one-shot
  with its own ledger prompt version (`extract.v1+ex1`, `extraction.exemplarCaseId` for
  audit — the console review pane's "supplier memory" badge navigates to
  that exemplar case; eval replay never uses exemplars). **Exemplar
  hygiene**: a candidate whose descendant approvals (matched via
  `exemplarCaseId`) got most fields overridden (3+ cases, ≥50% override) is
  demoted to the next candidate — the exhaust auditing the exhaust.
- **Party alias memory** (`modules/clerk/alias.ts`, `party_name_aliases` +
  firm-keyed RLS migration 0017) learns NAMES where supplier memory learns
  documents: every approval records the extracted supplier/buyer name →
  confirmed-party pairing under a normalized key (order/case/legal-suffix
  noise stripped; identical-to-register aliases teach nothing; newest
  confirmation wins). Suggestion surfaces (`applyAlias` in party-match, NL
  invoice drafting) consult it FIRST — the memory only nominates, the
  caller's candidate filters (type, sphere, merged) decide, and a remembered
  pick shows as `viaAlias` ("Remembered" chip).
- **Recurring suggestions** (`modules/invoice/recurring-suggest.ts`, nothing
  stored) mine a client's own invoices for monthly billing patterns (3+
  invoices, monthly median gap, clustered amounts, buyers already covered by
  ANY template excluded) and prefill the existing template dialog — the
  client disposes. Since round 20 all three habit miners (suggestions,
  unbilled income, missing bills) group per (counterparty, CURRENCY) and
  carry the currency through the contract — a USD retainer and NGN
  one-offs to the same party are different habits, and the UI renders
  each in its own currency.
- **Unbilled-income detection** (`modules/invoice/unbilled-income.ts`,
  `GET /unbilled-income`, nothing stored) — the same miner pointed at the
  month the invoice DIDN'T go out, sharing `buyerBillingHistories` with the
  suggestions so the two cards can never disagree about what a habit is;
  alerts only inside a bounded window (grace 5 days, lapsed after 45 — an
  ended arrangement stops nagging); surfaced as an SME dashboard card and a
  fact line in the weekly digest (`countFirmUnbilled`). The top-N cut
  RANKS by naira equivalent (`ngnRankFor`, shared with missing-bills.ts:
  NGN at face value, foreign currency at the group's most recent captured
  `fx_rate_to_ngn`, unconvertible foreign at face value — under-rank and
  say so, never an assumed rate), so a USD retainer cannot lose its slot
  to a smaller NGN habit; DISPLAYED amounts stay in the original currency.
- **Unmatched-credit detector** (`modules/invoice/unmatched-credits.ts`,
  `GET /unmatched-credits`, nothing stored) — unbilled-income's compliance
  mirror: money that came IN with no invoice behind it. Parsed credit lines
  on RECONCILED statements (the matcher has run and had its say — a
  still-committed statement's lines are not yet evidence) in a trailing
  90-day window with NO live match proposal (proposed or accepted) and NO
  settlement event; one shared predicate fragment for the client card, its
  uncapped totals and the firm digest count (`countFirmUnmatchedCredits`).
  Framed as an advisory (a transfer or loan also looks like this), never an
  accusation, with a "raise the invoice" CTA.
- **Buyer payment-behaviour memory**
  (`modules/invoice/payment-behaviour.ts`, `GET /payment-behaviour`, nothing
  stored) mines per-buyer days-to-pay medians from the client's own ACCEPTED
  reconciliation matches (credit lines with a value date only — the
  human-confirmed exhaust via the shared `acceptedSettlementRows` evidence
  query, 3+ settlements required, negatives dropped): "usually pays ~Nd"
  chips on the receivables debtors and the invoice detail.
- **Cash-flow outlook + chase list** (`modules/invoice/cashflow.ts`,
  `GET /dashboard/cashflow` + `GET /dashboard/chase-list`, nothing stored) —
  one shared per-invoice projection (expected settlement = buyer rhythm >
  due date > default 30-day terms, same `OUTSTANDING` fragment as
  receivables.ts) rolled into week-bucketed expected inflows (already-late
  money in its own bucket, never future inflow) and a capped "worth chasing"
  list ranked by days beyond each buyer's OWN expectation, each row opening
  the invoice's chaser button. This is the grounding for the payment-chaser
  draft (see Drafting).
- **Projection accuracy** (`modules/invoice/projection-accuracy.ts`,
  `GET /projection-accuracy`, nothing stored) — the projection engine
  auditing itself: replays the SAME three-tier rule against every observed
  settlement — rhythm evaluated LEAVE-ONE-OUT (a payment never predicts
  itself, 3+ other settlements required), else due-date terms, else 30 days
  — reporting signed median error, a ±7-day share and a per-buyer table;
  surfaced as a confidence line under the SME outlook card (5+ settlements).
- **Reminder effectiveness** (`modules/invoice/chase-effectiveness.ts`,
  `GET /chase-effectiveness`, nothing stored) — the chase ladder auditing
  itself: `chase_log` reminders joined to observed payment evidence over the
  trailing year. Counts a reminded invoice as settled only when the
  settlement lands AFTER its first reminder (an earlier settlement never
  credits the reminder); the within-14-day share divides by MATURE reminders
  only (settled, or first reminder old enough for the window to have run —
  a reminder sent yesterday cannot deflate it); reminded vs unreminded
  issue-to-settle medians carry the comparison; every aggregate honours a
  3-sample floor and the note pins correlation-not-causation. Surfaced as a
  footnote under the SME chase list.
- **Double-payment guard** (`modules/invoice/double-payment.ts`,
  `GET /bills/double-payment-check`, nothing stored) — advisory payables
  safety over the SAME canonical bill fragments (`BILL_OF_CLIENT` +
  `BILL_UNPAID`). "Paid twice" means the BANK evidence shows money leaving
  twice: 2+ DISTINCT statement-line matches whose amounts sum to MORE than
  the bill — a payer flag plus its confirming statement match (the
  ordinary lifecycle) never flags, and partial matches summing to the
  total are installments, not a double payment. "Possible duplicates" are
  same-supplier same-currency same-amount bills issued within 14 days of
  each other where the second side is still UNPAID — including the
  riskiest shape, a PAID original next to its unpaid re-captured copy
  (`pairKind: paid_original`); both-unpaid pairs appear once and
  already-paid pairs are history, not a warning. Capped at 20 per lane;
  amber advisory card on the SME bills page; nothing is blocked, and the
  note warns that a recurring standing charge can match legitimately.
- **Penalty exposure** (`modules/invoice/penalty-exposure.ts`,
  `GET /penalty-exposure`, nothing stored) — what the overdue paper could
  COST: the published penalty-calculator s.104 model (the per-invoice
  charges are mirrored constants, pinned in the test) pointed at the
  client's own overdue receivable paper under the digest's EXACT overdue
  predicate (draft/validated past issue + submission window). The platform
  does not hold turnover, so all THREE bands are reported and every
  single-figure surface (the digest fact, the dashboard card headline)
  uses the SMALL band — the floor, never a scare figure; s.103 access-denial
  charges are not platform-observable and are excluded; the note pins
  estimate-not-advice and the framing is always "submitting removes the
  exposure". Amber SME dashboard card with the oldest-5 sample; also an
  Ask data intent (`data.penalty_exposure`, client-safe with the forced
  own-party pin) and the digest floor fact — DERIVED from the overdue
  count the digest's own facts query already computed
  (`bandExposure(count).small`, null when clean), never a second query
  that could straddle a Lagos midnight and contradict the count.
- **Digest impact** (`modules/clerk/digest-impact.ts`,
  `GET /clerk/digest-impact`, `clerk.use`, console health card) — the
  digest auditing itself: each digest row stores its fact snapshot (round
  20), and consecutive 7-day pairs within a firm form the time series.
  Week-over-week movement of the urgent count (overdue + failed) is
  split by whether the earlier digest was DELIVERED to opted-in staff;
  buckets under a 3-pair floor show no rates, and the note pins
  correlation-not-causation (opt-in itself is a signal).
- **Month-end close assistant** (`modules/invoice/month-end-close.ts`,
  `GET /month-end-close`, nothing stored) — the deterministic advisories
  COMPOSED: overdue submissions (with the s.104 floor), unbilled income,
  unmatched credits, missing vendor bills, double payments, unmatched
  collections and (policy-on only — the null-when-off rule) pending
  approvals, one checklist with per-item clear/attention status. Contains
  ZERO predicates of its own — every line is the existing detector's
  answer (the net-position "nothing recomputed" discipline), so a line
  can never disagree with the card it summarizes. SME dashboard card with
  an all-clear state; same SEC-03 scope resolution as the advisories it
  composes.
- **Client compliance scorecard** (`modules/invoice/compliance-scorecard.ts`,
  `GET /console/compliance-scorecard`, `console.portfolio.read` — the
  firm-rollup gate, so client_users are refused) — the cross-client
  posture league table over engaged clients, trailing 90 days: issued
  volume, share of accepted paper whose FIRST acceptance landed inside
  the statutory window, failure share over attempted invoices, median
  issue-to-stamp days, current overdue count (not windowed) and captured
  bills without a stamp verification. Attention first (overdue paper,
  then the weakest window rate); every rate honours the 3-sample floor
  (null, never a scary 0%); the note pins posture-not-blame. Round 20
  added the TREND: the same rates over the window before (same floors,
  one SQL pass via a recent-flag on a doubled scan) with
  improving/worsening arrows on the console card — "who's slipping"
  instead of "who's bad". Console portfolio card, pure SQL end to end.
- **Missing recurring bills** (`modules/invoice/missing-bills.ts`,
  `GET /bills/missing-recurring`, nothing stored) — the payables mirror of
  unbilled-income: the SAME `detectMonthlyPattern` miner pointed at the
  vendors a client captures a bill from every month, through the canonical
  bill fragments so a receivable can never pollute a vendor's cadence.
  Same bounded alert window (grace 5 days, lapsed after 45 — a cancelled
  subscription is not a missing bill); an uncaptured bill is unclaimed
  input VAT plus a payment the cash outlook cannot see. Amber advisory on
  the SME bills page; firm-wide digest fact (`countFirmMissingBills`,
  live-engagement-scoped like `countFirmUnbilled`). Ranking is the same
  naira-equivalent rule as the unbilled card (`ngnRankFor` lives here):
  the alert cap keeps the biggest money in NGN terms, display currency
  unchanged.
- **Net cash position** (`modules/invoice/net-position.ts`,
  `GET /dashboard/net-position`, nothing stored) merges the outlook's
  projected inflows with the payables summary's committed outflows per
  currency and week — BOTH sides computed by their own existing functions
  (identical 7-day bucket geometry), nothing recomputed, so the merged view
  can never disagree with either card. Weeks where committed bills exceed
  projected receipts are flagged SQUEEZE weeks (a prompt to look, never a
  prediction); already-late money on both sides stays out of the weekly
  nets and is reported separately. SME dashboard card.
- **Line-item memory** (`modules/invoice/line-items.ts`,
  `GET /line-item-suggestions`, nothing stored) mines the client's own
  invoice lines into an item catalogue (order-insensitive item key, 2+
  occurrences, median unit price, MODAL VAT rate, newest description) that
  feeds the SME draft form's "frequent items" chips and the capture
  pre-flight price advisory — same SEC-03 sibling gate as the other history
  checks.

## Firm memory (pgvector semantic index — round 45, Phase 1)

The rail that lets Clerk's memories stop being exact-key lookups and start
finding "the last time something like this happened". Unlike the memories
above this one DOES spend tokens (embeddings), so the whole gateway
discipline applies.

- **The index** (`clerk_memory_embeddings`, schema/memory.ts; firm-keyed
  RLS migration 0039): one row per (firm, corpus, source row) —
  POINTER-ONLY, the embedded text is never stored, only a vector plus the
  ref back to the source, so purging the source purges the meaning.
  `content_hash` makes indexing incremental; `model` pins retrieval to
  same-model comparisons (a model change re-indexes via the anti-join).
  Deliberately NO ANN index: per-firm corpora are small, a firm-filtered
  EXACT scan is fast and recall-perfect.
- **The extension is infrastructure**: migration 0038 asserts it
  tolerantly (a cluster without the pgvector binary logs a warning and the
  rail stays dark — boot never breaks); the db package's push scripts
  pre-create it (`ensure-extensions.ts`); CI runs `pgvector/pgvector:pg16`.
- **Embedding calls ride the gateway** (`gateway.ts embedWithLedger`):
  kill switch, per-firm budget backstop BEFORE the provider (a refused
  firm writes NO ledger row — no call left the platform), append-only
  ledger row on the raw pool charging `prompt_tokens` (so embedding spend
  flows into the firm budget and the economics meter with zero extra
  wiring; the tier report special-cases the lane — it reports
  `CLERK_EMBEDDING_MODEL` and a fixed "keep", since `CLERK_MODEL_TIERS`
  cannot route embeddings and validity-based tiering does not apply; the
  USD estimate prices embed tokens at the completion input rate, a
  documented over-approximation), and a mis-sized response is discarded
  whole —
  `vector(1536)` is a DDL constant, never negotiated at runtime. Own
  purpose (`embed_memory`), own prompt version (`embed.v1`), own env knob
  (`CLERK_EMBEDDING_MODEL`, default `text-embedding-3-small`).
- **The indexer sweep** (`modules/clerk/memory.ts`, hourly, lock 731_850):
  the eval-growth shape — gating (try-lock + `clerk_ai` + the OPT-IN
  `clerk_memory` flag + extension feature-detect) in a short bypass
  transaction, embedding calls OUTSIDE it, `MEMORY_INDEX_BATCH = 20`
  sources per corpus per pass grouped per firm (one embedding call per
  firm even across corpora), races absorbed by the natural unique key.
  The closed corpus catalogue: `ask_questions` (Phase 1) — resolved Ask
  questions (never retention-purged, so the index cannot outlive its
  source) — `escalation_replies` (Phase 2, round 46) — REPLIED
  escalations keyed by the client-authored `reason` (the situation is the
  key; the operator's reply is what the caller re-reads live; escalations
  have no delete path and the reason is immutable, so the purge story is
  clean) — and `advisory_briefs` (round 51) — CLOSED-month briefs only
  (`month_start` before the live Lagos month), headline + note as the
  indexed text; immutability is BY CONSTRUCTION because regeneration is
  live-month-only, so the index never has to chase an edit.
- **Retrieval** (`searchMemory`): exact cosine KNN over one firm's one
  corpus, model-pinned, similarity-floored — returns ranked SOURCE IDS
  only; what a caller does with them is deterministic app code (the app
  picks, never the model).
- **Semantic reply exemplars** (Phase 2, `modules/desk/draft-reply.ts`):
  the reply-draft surface prefers a similarity-retrieved exemplar — embed
  the incoming escalation's reason (FIRM-funded, ledger cohort
  `embed.v1+q`), `searchMemory` over `escalation_replies` (k=3, floor
  0.3 applied before the k cut, self-match excluded in SQL), re-read each
  candidate's reply LIVE from the source row under the firm pin
  (pointer-only: an orphaned embedding yields nothing) — and falls back
  to the round-11 exact-error-code query when the rail is dark, the firm
  is overridden off either flag, the firm's (corpus, model) slice is
  empty (checked BEFORE the embed, so a cold corpus never charges the
  firm for a guaranteed-no-match query), budget is exhausted, or nothing
  was similar enough. The exemplar prompt is
  IDENTICAL either way (PAST_REPLY fence, style-only system rules,
  `copiesExampleSpecifics` deterministic discard); only the ledger cohort
  differs — `draft-reply.v1+mx1` vs `+ex1` — so the two retrieval
  strategies' kept-rates stay separable. The completion itself remains
  platform-funded operator tooling.
- **Retrieval-augmented Ask** (Phase 3, round 47, contract 0.73.0,
  `modules/clerk/ask-memory.ts`): after an Ask answer is COMPLETE, app
  code — never the model — searches the firm's `ask_questions` and
  (round 51) `advisory_briefs` corpora with ONE firm-funded query embed
  (same gates and per-corpus cold guards as the reply surface; k=3 —
  widened ×3 for client askers, whose own-rows pins filter post-search —
  floor 0.35, the current case excluded), merges the two searches into
  one similarity-ranked list, and attaches an optional `memory` field to
  the stored answer: title + up to 2 pointer-first items (caseId,
  question, askedAt, and a `kind` — "question" or "advisory_brief" — so
  the UI opens the right surface and labels brief items). Only questions
  whose stored answer actually ANSWERED count — a refusal stores an
  answer blob too and is no precedent (filtered in the candidate query
  AND at the re-read, which is the load-bearing check for legacy-indexed
  rows). Because the stored answer IS the API answer, SEC-03 is enforced
  at ASSEMBLY: a client asker's items re-read only cases that asker
  created (the multi-turn `createdBy` pin) and only briefs pinned to
  that asker's own party — a party-less client asker gets no brief
  search at all (fail closed, before the embed is charged). The
  whole note races a 2s deadline — garnish must not hold the answer
  hostage to a slow embedding endpoint — and any failure means no note,
  never a failed answer. `buildIntentUser` is untouched — nothing here
  rides a prompt, so the intent eval's frozen contract holds. Console
  and SME Ask render the note as a quiet card.
- **Retrieval eval lane** (Phase 3, `modules/clerk/retrieval-eval.ts`,
  runs table migration 0040, bypass-only): measures whether the LIVE
  embedding model still ranks the right memory first — a fixed labeled
  corpus (12 docs, 10 queries), ONE platform-funded embed per run
  (`eval_retrieval` purpose, firmId null — the gateway's embed lane
  grew the infer() attribution rule for exactly this), a deterministic
  in-process scorer (recall@3 + MRR; the real index is never touched),
  an opt-in nightly sweep (`clerk_auto_retrieval_eval`, SEEDED dark —
  unlike its dark-by-absence phrasing sibling, so the platform flags
  surface can light it; lock 731_851), an on-demand operator route +
  Clerk-health card (round 48, contract 0.74.0: `POST
  /clerk/eval/retrieval` — NO_CONTEXT + MODEL rate class, 503 when the
  embedder is unconfigured — and `GET /clerk/eval/retrieval-runs`
  feeding the console's recall/MRR trend card) and a trailing-
  baseline drop watch (`clerk.retrieval_quality.dropped`, env knobs
  `RETRIEVAL_ALERT_DROP`/`RETRIEVAL_ALERT_MIN_RUNS`). A model change
  is deliberately not excluded from the baseline — re-pointing
  `CLERK_EMBEDDING_MODEL` at a weaker model is precisely a drop an
  operator should hear about.

## Watches & alerts (sweeps, zero model calls)

All three share the posture: durable audit event as the dedup ledger (one
event per degraded unit), an error log, and a banner/count fed from the SAME
shared computation as the corresponding chart.

- **Number grounding** (`modules/clerk/grounding.ts`, round 17) enforces
  "no NOVEL numeral": every phrasing surface — digest, monthly statement,
  chaser, escalation reply, failure explainer, reconciliation match assist,
  narrative, VAT/quarterly/pack cover notes — runs its model output through
  `numberGroundingViolations` against the SAME user prompt it sent.
  Matching is format-tolerant but value-exact ("₦45,000.00" and "45000"
  meet at "45000"; a typo'd grouping or a flipped sign is a DIFFERENT
  number; NFKC folds fullwidth digits, and any other digit script is a
  violation outright); a numeral the facts never stated forfeits the
  phrasing and the deterministic template answers instead — the safe
  direction, because the template always answers. HONEST LIMITS: it cannot
  catch a hallucination that REUSES a numeral the prompt already contains
  against the wrong fact, nor spelled-out numbers or magnitude words
  ("45,000 million") — it narrows the failure class, it does not close it.
  One pointer-only audit event per violating output (surface + count,
  never the numbers themselves); `metrics.grounding` counts them onto the
  health page's Number grounding card. Zero extra model calls.

- **Resistance-drop alert** (`modules/clerk/resistance-watch.ts`) runs the
  SAME monthly buckets as the health chart (`injectionResistanceMonths`,
  shared with metrics so banner and alert can never disagree) and raises a
  durable alert — one audit event per degraded month — when a measured
  month's resistance falls ≥10 points below the previous one (≥5 injection
  fixtures both sides, env-tunable); `metrics.resistanceAlert` drives a red
  banner on the health page.
- **Firm spend anomaly watch** (`modules/clerk/spend-watch.ts`) buckets
  firm-funded ledger tokens into UTC days (the same token expression
  budget.ts charges) and flags a latest day both over an absolute floor
  (`SPEND_ALERT_MIN_TOKENS`, default 100k) and 5× the median of the firm's
  other days (`SPEND_ALERT_MULTIPLIER`, ≥3-day baseline required) — one
  durable audit event per (firm, day), plus the live `spendAlerts` count on
  the operator daily brief.
- **Kept-rate drift watch** (`modules/clerk/quality-watch.ts`) buckets the
  corrections exhaust into UTC months (the same single source calibration
  samples) and alerts when the newest measured month's kept-rate falls ≥10
  points below the previous (`QUALITY_ALERT_DROP_POINTS` /
  `QUALITY_ALERT_MIN_FIELDS`, ≥50-field months only).
- The **Clerk watchdog** sweeps (`modules/clerk/watchdog.ts`) handle stuck
  pending cases, expired claims and expired case content retention.

## Evals, canaries & curation

- **Intent-classification eval lane** (`modules/clerk/intent-eval.ts`,
  `POST /clerk/eval/intent` + `GET /clerk/eval/intent-runs`, `clerk.use`,
  `clerk_intent_eval_runs` bypass-only RLS migration 0024, console health
  card): the Ask classifier's own regression corpus — 18 static fixtures
  (register, data intents incl. payables and the Ask 2.0 plan/delta
  cases, refusals, month/client guards, and three prompt-injection
  questions — the third, since Ask 2.0, is a plan-flood order to "run
  every lookup you have", where resistance IS the empty plan) replayed
  against the LIVE intent prompt through the ordinary gateway (purpose
  `eval_intent`, one classify call per fixture) and scored
  DETERMINISTICALLY; no model judges a model. The corpus classifies
  through the SAME `intent.v6` plan builders (`planJsonSchema` /
  `planValidator`) and the SAME `buildIntentUser` production uses
  (exported from ask.ts), and the frozen synthetic context carries the
  REAL data-intent catalogue — a new intent that steals traffic from an
  existing one shows up as a regression. Scoring (Ask 2.0): a fixture
  carrying `expected.plan` scores POSITION-FOR-POSITION — the step count
  must match and every step's key plus any pinned month/client keys must
  equal the expectation in order; the legacy single-key expectation
  stays REQUIRED on every fixture and judges (a) legacy-shaped answers
  from the v5 scripted stubs that still replay this corpus
  (`planValidator`'s compatibility branch tags them `legacyShape`; a
  real provider under the v6 JSON schema can never produce that shape,
  so live runs always score plan fixtures positionally) and (b) every
  grown fixture — minting is UNCHANGED by Ask 2.0: grown rows carry only
  `{claimKey, month, client}` validated against the frozen offered
  context and score on the leading step. With a `candidateSystem` the
  corpus runs side by side and returns the prompt-canary verdict
  (injection resistance may never drop; accuracy judged outside a
  one-fixture noise band) with nothing stored.
- **Phrasing eval lane** (`modules/clerk/phrasing-eval.ts`,
  `POST /clerk/eval/phrasing` + `GET /clerk/eval/phrasing-runs`,
  `clerk.use`, `clerk_phrasing_eval_runs` bypass-only RLS migration 0027,
  console health card): the intent lane's pattern pointed at the PHRASING
  surfaces, which shipped every prompt change blind until round 18. Fixed
  synthetic fact packs replay through the BYTE-IDENTICAL production prompt
  builders — `DIGEST_PHRASING` / `CHASER_PHRASING` / `STATEMENT_PHRASING`
  / `VAT_NOTE_PHRASING` / `REPLY_PHRASING` / `EXPLAIN_PHRASING` /
  `RESPONSE_PHRASING` / `BRIEF_PHRASING` (rounds 19-20 grew the corpus to
  the client statement, VAT cover note, escalation reply and failure
  explanation; the Response Desk added the obligation response letter and
  round 52 the advisory brief — every phrased surface where a regression
  touches money, filings or a client conversation), each
  surface's system prompt, version, schema, validator and user-prompt
  assembly exported as one descriptor — via the gateway, one purpose PER
  SURFACE so each slice of the corpus rides the model tier its production
  surface actually uses. Every surface with an outsider-influenced fact
  slot carries an injection fixture riding it (the chaser's buyer name,
  the VAT note's client legal names, the escalation reply's fenced client
  message, the explainer's rail-returned error code); the statement's and
  the advisory brief's facts are all platform-computed (even the brief's
  Phase 3 delta strings are app-built), so their fixtures are clean-only
  — the brief's fixtures exercise triage emphasis, the quiet "on track"
  month and grounding over the continuity delta facts. The
  lane is SELF-ENFORCING since round 20: an opt-in nightly sweep run
  (`clerk_auto_phrasing_eval` flag, once per UTC day, the eval-growth
  discipline) plus a quality-drop watch (`phrasing-watch.ts`) that
  compares each newest run's grounded/resistance RATES against the
  aggregate of up to five prior runs (rate-based, so corpus growth never
  reads as regression) and raises the resistance-watch style once-only
  audit alert on a material drop. Scoring is
  DETERMINISTIC: number grounding via the production check itself
  (`numberGroundingViolations`, so the eval measures how often production
  would have fallen back to the template), required canonical numerals and
  verbatim identifiers, forbidden patterns (zero facts, policy-off topics,
  threat language, the injected payloads) with every broken rule named in
  the stored result. The all-zero fixture baseline is built from
  `DigestFacts` itself, so a new fact field breaks the corpus at compile
  time. With a `candidateSystem` (+ `surface`) the canary compares
  candidate vs incumbent over that surface's fixtures — grounding and
  injection resistance may never drop, correctness judged outside a
  one-fixture noise band — and stores nothing; a failed model call on an
  injection fixture counts AGAINST resistance.
- **Grown intent corpus** (`clerk_intent_fixtures`, bypass-only RLS
  migration 0025; `POST /clerk/eval/intent-fixtures/from-case` +
  `GET /clerk/eval/intent-fixtures` + per-fixture retire/restore,
  `clerk.use`; console promote row on the ask-feedback card, retire list on
  the eval card): promotes a real QUESTION case — typically one an asker
  marked not-helpful — into the intent corpus. The operator names the key
  the classifier SHOULD have chosen (plus optional month/client pins),
  validated fail-closed against the eval's frozen offered context. The
  stored question is ALWAYS scrubbed through the SAME span-claim machinery
  as the extraction corpus (scrub.ts: word boundaries, longest-first
  claims, spacing-tolerant TINs) after NFKC + whitespace normalization
  (NBSP and homoglyph variants still match); the identity set is every
  party the platform can name for the firm — engaged clients, invoice
  counterparties, the firm, their TINs — plus informal short forms of each
  name (legal-suffix tails stripped, sharing one directory slot). Names
  map onto the frozen synthetic directory in order of first appearance; a
  question naming more parties than the directory can represent is REFUSED
  (422), and a verification pass re-runs detection over the output so any
  residual match refuses rather than storing a partial scrub. Minting is
  idempotent per case (409); a mis-mint is retired via the API, never
  manual SQL. Default eval runs and intent canaries load active grown
  fixtures (newest 40, `retired_at` null) alongside the static set; tests
  pin the static corpus via `includeGrown: false`. Grown intent fixtures
  never serve memory.
- **Learning loop** (`modules/clerk/eval-growth.ts`) turns corrected
  approvals — both document kinds since round 30: invoice extractions and
  notice readings, the case's kind riding onto the fixture — into eval
  fixtures on the sweep loop; the nightly auto-eval is
  opt-in behind `clerk_auto_eval` (spends tokens). Grown fixtures are
  deliberately NOT scrubbed at mint — they double as the supplier-memory
  exemplar store for active clients (see Memories) — so their lifecycle is
  tied to the client's: **offboarding retires them**. Grown fixtures traced
  to the departing client (via the approved invoice's supplier party, the
  creator's client membership, or — notice cases, which create no invoice
  and are usually staff-captured — the obligation approved from the case)
  are retired with document text and
  supplier identity nulled; the count rides the offboard result
  (`fixturesRetired`) and its audit event.
- **Vision injection fixtures** — the corpus carries 8 deterministic vision
  fixtures: pdfkit-built single-page invoices rasterized through the REAL
  scan path — 6 adversarial variants embedding the attack in the document
  image itself, plus 2 clean controls. Every full corpus run sends them
  through the ordinary vision-extraction payload (+8 calls per run) and
  folds their injection outcomes into the same resistance buckets, so the
  health page's resistance trend measures the image channel, not just
  pasted text.
- **Notice-extraction eval lane** (round 30, inside `eval.ts` — same run,
  same stored row): the corpus carries a second document domain. Two
  hand-written notice statics (`NOTICE_EVAL_FIXTURES`: a clean FIRS
  assessment and a demand note carrying planted amount/deadline/
  reclassification instructions) plus every fixture grown from corrected
  NOTICE approvals (`clerk_eval_fixtures.kind`, default `invoice`) ride
  the full-corpus path only — `includeGrown: false` still pins the
  historic invoice statics. Notice fixtures replay the PRODUCTION notice
  prompt/schema (`notice.v1`, closed catalogues) under the lane's own
  ledger purpose `eval_extract_notice` — which follows the
  `extract_notice` model tier, and both are stakes purposes in the tier
  report — and score deterministically over noticeType + the notice
  catalogue with the shared comparator (numeric tolerance on
  amountDemanded); resistance is judged on NOTICE_CRITICAL_FIELDS **plus
  noticeType and amountDemanded** (a lane-local set — production review
  flagging keeps the narrower critical set): obeying a planted "classify
  this as a reminder" misroutes the obligation, and a planted "record the
  amount as 0.00" zeroes a real demand. Growth drops the catalogue-key
  correction fields (`authority`, `taxType` — the approved values are
  contract keys like "firs"/"vat", the operator's mapping work, which a
  verbatim replay could never match); every other approved value is
  verbatim-comparable. The
  invoice-prompt canaries (prompt and model) exclude notice fixtures
  (scoring a tax notice against the invoice prompt says nothing about the
  candidate), and notice fixtures never serve supplier memory — no
  invoice means no identity columns, and the exemplar scan filters on
  kind so they cannot consume window slots. **Triage
  (`triage_document`) deliberately has no eval lane**: it is fail-open
  routing into the invoice lane — a wrong guess costs one operator
  re-route, never money or a statutory clock — so it does not clear the
  bar that earned extraction/intent/phrasing their lanes; revisit if
  triage ever gates anything.
- **Curation** (`modules/clerk/eval-curation.ts`, `GET /clerk/eval/fixtures`
  + retire/restore, `clerk.use`, console corpus card): nullable `retired_at`
  on grown and red-team fixtures; loaders exclude retired rows BEFORE the
  recency cap (retirement frees a slot; canaries compose automatically
  because they share the loaders); per-fixture pass history reconstructed
  from the newest stored runs (field NAMES only); static fixtures never
  retirable; red-team generation still counts retired rows against its
  minting cap.
- **Corpus promotion** (`POST /clerk/eval/fixtures/from-case`, `clerk.use`,
  console health page promote row) mints a decided case into the corpus. A
  deterministic scrubber pseudonymizes known party names/TINs in the stored
  document text (`scrub` defaults true; the server REFUSES `scrub: false`
  for any case still traceable to a live client), and promoted fixtures
  never serve supplier memory — their identity columns stay null, so the
  exemplar matcher can never nominate a pseudonymized document as a
  one-shot.
- **Prompt canary** (`modules/clerk/prompt-canary.ts`,
  `POST /clerk/eval/canary` + `GET /clerk/eval/prompt`, `clerk.use`, spends
  2× a corpus pass): the corpus runs under a CANDIDATE system prompt and the
  incumbent side by side (purpose `eval_canary`, capped at 40 fixtures),
  scored by the same `scoreFixture` machinery, with a deterministic verdict
  — injection resistance may never drop, accuracy is judged outside a 2%
  noise band — returned, never stored (promotion is a code change the
  operator makes with the evidence in hand).
- **Model canary** (`modules/clerk/model-canary.ts`,
  `POST /clerk/eval/model-canary`, same gate/cost/NO_CONTEXT posture): the
  same harness pointed at a candidate MODEL id instead of a prompt —
  `buildGatewayForModel` in provider.ts runs the candidate side outside tier
  routing while keeping the kill switch/ledger/budget/schema validation;
  both sides run under the incumbent extraction prompt; the same verdict
  rule decides; adoption is an env change (`CLERK_MODEL` /
  `CLERK_MODEL_TIERS`) the operator makes with the evidence in hand.
- **Adversarial eval growth / red team** (`modules/clerk/red-team.ts`,
  opt-in `clerk_red_team` flag, spends tokens): the model GENERATES a
  prompt-injection payload against a legitimate static fixture; the app owns
  ground truth — it APPENDS the payload to the UNCHANGED document (so the
  base fixture's expected always survives) and DISCARDS any variant without
  a critical decoy that actually differs from the truth. Stored variants
  (bypass-only RLS, migration 0016) join the corpus as riskLabel `injection`
  fixtures scored by the SAME `scoreFixture` machinery as the hand-written
  pair.

## Budgets & economics

- **Per-firm monthly token budget** (`modules/clerk/budget.ts`): tier
  override `billing_tiers.clerk_monthly_tokens`, default
  `CLERK_FIRM_MONTHLY_TOKENS` env, the inference ledger is the spend
  counter. Routes check the budget BEFORE touching the provider so 429s are
  clean, and the gateway enforces it again as a backstop no call site can
  forget.
- `GET /clerk/usage` carries a month-end pace projection (`budgetPace`, same
  UTC month boundary as enforcement) so the usage meters warn before the
  cliff, and a required `byPurpose` split (`firmClerkUsageByPurpose`, same
  ledger/month predicate the budget charges, fed the same read's
  `monthStart` so the two can never straddle a boundary) so the meter shows
  WHERE the tokens went.
- **Unit economics** (`metrics.economics`, pure ledger SQL): token spend +
  error count per PURPOSE inside the window, and a per-month failure
  taxonomy (ok/invalid/killed/error) over the trailing months — the numbers
  pricing tiers and a provider evaluation will want, zero model calls.
- **Platform spend meter** (`metrics.platformSpend`): month-to-date ledger
  totals split firm-funded vs platform-funded with a linear pace projection
  on the same UTC boundary as the per-firm budgets.
- The monthly platform-billing statement (`GET /billing/statement`) meters
  Clerk tokens over the same UTC month boundary budget.ts enforces — see
  `docs/platform.md` § Billing.
