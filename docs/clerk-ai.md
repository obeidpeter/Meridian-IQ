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
call, and eval purposes follow the `extract_invoice` tier unless explicitly
overridden so evals measure what production runs. The **tier-suggestion
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
  from API responses); text detection relies on `pageJoiner: ""` (pdf-parse's
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
- **Fast-lane bulk approval** (`modules/clerk/bulk-approve.ts`,
  `POST /clerk/cases/bulk-approve`, same gate) is the bulk-submit idiom
  pointed at the queue: up to 50 approve decisions walk the EXISTING
  `decideCase` one by one, each in a savepoint, but only cases the server
  itself re-verifies as fast-lane (extracted, present preflight with no
  blocking issue, critical confidences ≥0.9 — mirroring the console's
  `isReadyToApprove`). Everything else skips with its reason; the console
  queue's "Approve fast lane" action is its human-initiated consumer.
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

## Ask Clerk (grounded firm-data Q&A)

- `modules/clerk/data-intents.ts`: Ask carries a second closed catalogue next
  to the claims register — data intents ("what's overdue?", "what did we
  submit this month?", and the money intents "who owes us?" / "what's
  expected this week?" / "who's worth chasing?" backed by the
  receivables/cashflow modules), offered in the intent enum only to
  firm-scoped askers. The model only CLASSIFIES; the app runs the matching
  FIXED, fully-parameterized query. Runtime inputs: the principal-resolved
  firmId plus optional month/client parameters the model can only pick from
  CLOSED app-built option lists — the last 12 Lagos months and the firm's
  own engaged clients under opaque `c1..cN` keys, resolved back through the
  app's own maps; a param a lookup can't honour REFUSES, never silently
  answers unfiltered. Queries run inside `inClerkScope(firmId)` plus an
  explicit firm filter, and the answer is assembled deterministically
  (`answer.dataIntent` marks these, `answer.dataParams` names the resolved
  scope). Predicates mirror digest/compliance-window (Lagos calendar), so
  Ask can never disagree with the dashboards.
- **Multi-turn**: the web clients thread the previous answered case's id
  (`AskClerkInput.previousCaseId`); the server loads that case inside
  `inClerkScope` with an explicit firm + kind filter, and only if it was a
  data answer maps its stored display labels (`answer.dataParams` holds the
  month LABEL and client NAME, never ids) back to THIS request's option
  keys. The context line the model sees carries data-intent keys and
  `m*`/`c*` option keys only, so a follow-up ("and for June?") can inherit
  scope while the closed-catalogue machinery stays exactly as strict
  (`intent.v5`; a label no longer offered contributes nothing; a cross-firm
  or non-question id is silently ignored).
- **Client access** (SEC-03-pinned): Ask is open to `client_user`s. The
  offered data intents narrow to a vetted ALLOWLIST
  (`CLIENT_SAFE_DATA_INTENTS` — firm-wide money intents that name other
  clients' buyers, and the firm's own budget, are excluded and refuse); the
  client option list is exactly the caller's own party; the executed party
  filter is FORCED from the principal regardless of the model's pick;
  multi-turn threads only from the client's own previous case (`createdBy`
  check); and `GET /clerk/digest` explicitly refuses client_user now that
  the capability is shared. The SME app carries the client Ask surface; the
  mobile app carries an Ask screen too (`mobile/app/clerk-ask.tsx`).
- **Claim-gap mining** (`modules/clerk/claim-gaps.ts`,
  `GET /clerk/claim-gaps`, `clerk.use`, pure SQL, console claims-page card):
  Ask's refusals are themselves mined — a trailing window's refused answers
  clustered by a stable refusal-code mapping of the exact sentences ask.ts
  produces (unknown text folds to `other`; the no-matching-claim needle is
  one constant shared between the TS matcher and the SQL LIKE so they can
  never disagree), listing the newest uncovered questions with their firm
  names — the evidence for what claims to draft next.

## Drafting & phrasing assists (digest posture)

Common contract: facts/grounding are deterministic, the model only phrases or
names, a template fallback always answers, and nothing is stored or sent
without a human owner.

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
  draft reads the count to escalate register with the stage (`chaser.v2`:
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

## Digests, statements & delivery

- **Weekly digest** (`modules/clerk/digest.ts`, opt-in `clerk_digest` flag,
  sweep-generated, firm-keyed RLS via migration 0011) computes every fact in
  SQL — including the money facts from `firmMoneySummary` (payments expected
  in the coming week per each buyer's rhythm, and the chase-worthy count
  past BOTH due date and rhythm), firm-wide unmatched credits, unbilled
  income (`countFirmUnbilled`), and outstanding invoices with 2+ logged
  reminders — and lets the model phrase them, falling back to deterministic
  template text.
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
  model, template fallback always answers. Its read route
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
  line the canary predicted.
- **Kept-rate trend** (`metrics.keptRateTrend`) and `metrics.qualityAlert` /
  `metrics.resistanceAlert` banners come from the SAME shared buckets as
  the watches below, so chart, banner and alert can never disagree.

## Memories & deterministic advisors (zero model calls)

The corrections/approvals exhaust feeds the product directly; none of these
call the model.

- **Supplier memory** (`modules/clerk/exemplar.ts`) deterministically matches
  a new text document against the firm's OWN approved fixtures
  (TIN/name-token containment, newest first, same-firm join — never
  cross-firm) and rides the match along as a fenced one-shot with its own
  ledger prompt version (`extract.v1+ex1`, `extraction.exemplarCaseId` for
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
  client disposes.
- **Unbilled-income detection** (`modules/invoice/unbilled-income.ts`,
  `GET /unbilled-income`, nothing stored) — the same miner pointed at the
  month the invoice DIDN'T go out, sharing `buyerBillingHistories` with the
  suggestions so the two cards can never disagree about what a habit is;
  alerts only inside a bounded window (grace 5 days, lapsed after 45 — an
  ended arrangement stops nagging); surfaced as an SME dashboard card and a
  fact line in the weekly digest (`countFirmUnbilled`).
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
- **Line-item memory** (`modules/invoice/line-items.ts`,
  `GET /line-item-suggestions`, nothing stored) mines the client's own
  invoice lines into an item catalogue (order-insensitive item key, 2+
  occurrences, median unit price, MODAL VAT rate, newest description) that
  feeds the SME draft form's "frequent items" chips and the capture
  pre-flight price advisory — same SEC-03 sibling gate as the other history
  checks.

## Watches & alerts (sweeps, zero model calls)

All three share the posture: durable audit event as the dedup ledger (one
event per degraded unit), an error log, and a banner/count fed from the SAME
shared computation as the corresponding chart.

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

- **Learning loop** (`modules/clerk/eval-growth.ts`) turns corrected
  approvals into eval fixtures on the sweep loop; the nightly auto-eval is
  opt-in behind `clerk_auto_eval` (spends tokens).
- **Curation** (`modules/clerk/eval-curation.ts`, `GET /clerk/eval/fixtures`
  + retire/restore, `clerk.use`, console corpus card): nullable `retired_at`
  on grown and red-team fixtures; loaders exclude retired rows BEFORE the
  recency cap (retirement frees a slot; canaries compose automatically
  because they share the loaders); per-fixture pass history reconstructed
  from the newest stored runs (field NAMES only); static fixtures never
  retirable; red-team generation still counts retired rows against its
  minting cap.
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
