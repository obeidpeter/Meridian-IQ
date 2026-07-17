# MeridianIQ — engineering guide

Nigeria-first e-invoicing **compliance** platform: accounting firms and their
SME clients prepare, validate, stamp (via FIRS/MBS rails), and reconcile
invoices, with an operator "Compliance Desk" and an AI intake assistant
("Clerk"). This file orients a new engineer (or agent session) to how the code
is put together and how to change it safely.

## Monorepo layout (pnpm workspaces)

```
artifacts/
  api-server        Express 5 + Drizzle + Postgres 16 — the data spine & rails
  console           Firm/operator/auditor web app (React + Vite + wouter)
  sme-compliance    SME client web app  ("/app")
  buyer-portal      Buyer Rails web app  ("/buyer")
  landing           Marketing site + login portal ("/")
  mobile            Expo / React Native companion
  penalty-calculator, mockup-sandbox   (standalone tools)
lib/
  db                Drizzle schema, migrations, RLS context helpers
  api-spec          openapi.yaml — the CONTRACT — + codegen (orval)
  api-zod           GENERATED request/response zod (do not edit)
  api-client-react  GENERATED react-query hooks (do not edit)
scripts/            e2e harness (Playwright) + dev tooling
```

## Contract-first: the one workflow to internalize

`lib/api-spec/openapi.yaml` is the source of truth. After editing it:

```
pnpm --filter @workspace/api-spec run codegen
```

This regenerates `lib/api-zod` (the server parses every route body/query/params
with these) and `lib/api-client-react` (the apps call these hooks), runs
`emit-version.mjs`, and typechecks the libs. **CI fails on any drift** — the
generated clients must match the spec exactly. Never hand-edit the generated
packages.

`info.version` in the spec is the **build handshake**: it is baked into both the
server and the web bundles; `/api/healthz` returns the server's copy; the apps
show a dismissible "stale server build" banner on mismatch. Bump it on every
contract change (it is currently `0.30.0`).

## Clerk AI (the part with guardrails)

Clerk never files anything: extraction proposes, a human disposes, approval
creates a DRAFT invoice. Every model call flows through
`modules/clerk/gateway.ts` (kill switch `clerk_ai`, append-only inference
ledger, schema-validated output, fail closed). The production provider
supports **per-purpose model tiers** (opt-in `CLERK_MODEL_TIERS` env, e.g.
`segment_batch=<cheap-model>`; unset = one model for everything): the
ledger records the model that ACTUALLY served each call, and eval purposes
follow the `extract_invoice` tier unless explicitly overridden so evals
measure what production runs; the **tier-suggestion report**
(`modules/clerk/tier-report.ts`, `GET /clerk/tier-report`, `clerk.use`,
console health card, pure ledger SQL) is the evidence for using it — per
purpose over a trailing 90 days: volume, token share, the validity taxonomy
(killed excluded from the denominator), the model ACTUALLY in force via the
same `parseModelTiers`/`modelForPurpose`, and a deterministic recommendation
(candidate/keep/tiered/revert/insufficient_data; extraction and its evals
never tier on validity alone) the operator acts on in env config, canary
first. Client-facing surfaces
(`clerk.capture` on all firm roles, `clerk.ask` on firm_admin/staff) are pinned
to their firm by route filters plus migration 0009's firm-keyed RLS, and are
capped by a per-firm monthly TOKEN budget (`modules/clerk/budget.ts`; tier
override `billing_tiers.clerk_monthly_tokens`, default
`CLERK_FIRM_MONTHLY_TOKENS` env, ledger is the spend counter — routes check
the budget BEFORE touching the provider so 429s are clean, and the gateway
enforces it again as a backstop no call site can forget; `GET /clerk/usage`
also carries a month-end pace projection — `budgetPace`, same UTC month
boundary as enforcement — so the usage meters warn before the cliff). The gateway writes
the inference ledger on the RAW pool so spend accounting survives any request
rollback; consequence: a caseId passed to `infer()` must reference an already
COMMITTED case row. The model-calling routes (capture, batch, ask, eval-run)
run OUTSIDE the per-request transaction (`app.ts NO_CONTEXT_ROUTES`) — each DB
stage commits in its own short firm-scoped transaction
(`modules/clerk/scope.ts`, same RLS posture) so a multi-second provider call
never pins a pooled connection or hits the 30s transaction cap. Review/decide
stays operator-only (`clerk.use`) and is compare-and-set on case status, so
concurrent decisions can never double-apply. The learning loop (`modules/clerk/eval-growth.ts`)
turns corrected approvals into eval fixtures on the sweep loop; the nightly
auto-eval is opt-in behind `clerk_auto_eval` (spends tokens). The failure
explainer (`modules/clerk/explain.ts`) is catalogue-grounded — the model only
rephrases; kill switch/budget failures fall back to the catalogue text, never
to an error. Its route is gated on `clerk.capture` (NOT `clerk.ask`) so the
client whose invoice failed can use it — the module itself enforces tenant +
SEC-03 party scope; the SME invoice detail's failed card is its consumer
(fix-and-retry: PATCH the still-mutable failed invoice, then resubmit, with
`ERROR_FOCUS` in `sme-compliance/src/lib/error-focus.ts` — mirrored on mobile
— flagging which fields a rail code implicates). The power pack keeps the same grounding split: **pre-flight**
(`modules/clerk/preflight.ts`) is pure model-free validation stored on the
case at extraction time (empty list = review fast lane); **scanned-PDF
intake** (`rasterizePdfScan` in `modules/clerk/cases.ts`) renders a textless
PDF's pages (max 4) to images and walks the ordinary vision-extraction path —
pages are stored on the case for retry (`source_scan_pages_b64`, purged by the
content-retention sweep, stripped from API responses) and text detection
relies on `pageJoiner: ""` (pdf-parse's page markers otherwise make every scan
look like it "has text"); **batch intake**
(`modules/clerk/batch.ts`) stays text-only and only proposes segment
boundaries — every segment then walks the normal capture path; **async batch**
(`modules/clerk/batch-async.ts`, `clerk_batches` + firm-keyed RLS migration
0014) queues a month-end bundle (cap 50) with NO model call in the request —
an immediate in-process kick plus the sweep (claim CAS, 10-min reclaim)
process it with the digest split-pattern, per-segment progress counters the
UI polls, source content cleared at terminal states, kill switch parks work
instead of consuming it; a textless PDF queued as a batch is a **scanned
bundle** (`modules/clerk/scan-batch.ts`, cap 24 pages): the original PDF
bytes persist on the row until terminal (any process can resume by
re-rasterizing), one `segment_scan` vision call over small page THUMBNAILS
proposes page ranges, `validateScanSegments` fails closed unless the ranges
cover every page exactly once in order, and each validated segment walks the
ordinary vision-extraction case path with its full-resolution page slice
(per-segment duplicate hash on the page bytes); **custom statement formats**
(`modules/statements/custom-formats.ts`, operator `catalogue.write`, global
reference data like the error catalogue) store column-name mappings consumed
by the same parser seam — saving REQUIRES the mapping to parse its own
sample, and `modules/clerk/draft-format.ts` proposes mappings from a pasted
sample with header names re-verified against what actually exists;
**advisory narratives** (`modules/advisory/narrative.ts`,
`engagement.write`) phrase a completed assessment/VAT-risk engagement's
stored findings into a client letter body — digest posture (template
fallback, never stored, the partner owns the letter); the **weekly digest**
(`modules/clerk/digest.ts`, opt-in `clerk_digest` flag, sweep-generated,
firm-keyed RLS via migration 0011) computes every fact in SQL and lets the
model phrase them, falling back to deterministic template text; the
**per-client monthly statement** (`modules/clerk/client-statement.ts`, opt-in
`clerk_client_statements` flag, sweep-generated for the newest CLOSED Lagos
month for every OPEN/in-progress engaged client, firm-keyed RLS via migration
0015, unique on firm+client+month) is the same digest posture per client —
facts in SQL, model only phrases, quiet months never call the model, template
fallback always answers; its read route (`GET /clerk/client-statements`,
`clerk.capture`) pins a `client_user` to its OWN party (SEC-03; firm RLS is
not a sibling wall) and the SME dashboard shows the client their own card;
the **monthly VAT filing pack** (`modules/clerk/vat-pack.ts`, `GET /vat-pack`
+ CSV export, `console.portfolio.read` + firm scope, console portfolio card)
is the firm-level view of the same accepted-in-month facts — deterministic
end to end, computed on demand, nothing stored; its **filing cover note**
(`modules/clerk/vat-note.ts`, `POST /vat-pack/cover-note`, same gate,
firm-funded) phrases the pack's computed facts into a note the partner edits
and owns — digest posture with NO route budget pre-check (kill switch,
missing provider, exhausted budget, invalid output, quiet month all answer
with the deterministic template, and a quiet month never calls the model);
the **adoption & impact report** (`modules/clerk/adoption.ts`,
`GET /console/clerk-adoption`, `console.portfolio.read`, console portfolio
card, pure SQL) slices the firm's own cases per client — capture volume,
kept-rate from the corrections exhaust, review turnaround (same expression
as `metrics.avgDecisionMinutes`), attribution via the approved invoice's
supplier party (the only deterministic join for every capture path;
non-approved cases count in firm totals only) — the renewal-conversation
numbers, zero model calls;
the **rejection-pattern report** (`modules/desk/rejection-patterns.ts`,
`GET /rejection-patterns`, `console.portfolio.read`, console portfolio card,
pure SQL) aggregates the firm's own rejected submission attempts into
recurring catalogue-grounded causes over a trailing window plus the
equal-length window before it, unmapped codes included — the aggregate view
the one-case-at-a-time desk never sees; the **firm compliance calendar**
(`modules/invoice/compliance-calendar.ts`, `GET /compliance-calendar`, same
gate, console portfolio card, deterministic) is the month-ahead view of the
SAME statutory clocks each client's dashboard shows — submission-window
dates and VAT 21sts from the same constants and Lagos expressions,
aggregated across the firm in one SQL pass, so the two surfaces cannot
disagree;
**claims
drafting** (`modules/clerk/draft-claim.ts`, operator `claims.write`) creates a
DRAFT register entry that still walks the full maker-checker flow; **catalogue
drafting** (`modules/clerk/draft-catalogue.ts`, operator `catalogue.write`)
proposes an error-catalogue entry grounded in observed rail rejections — the
draft is returned for the operator to edit and save through the ordinary
catalogue routes, never stored directly; **reconciliation match assist**
(`modules/clerk/reconcile-assist.ts`, behind the `reconciliation` flag)
explains one statement line's candidate set — ranking and highlights are
computed from the matcher's recorded features, Clerk only phrases the
comparison, template fallback always answers; **NL invoice drafting**
(`modules/clerk/draft-invoice.ts`, `clerk.capture`) turns one sentence — typed,
or spoken via the mobile "Speak it" card ({text | audioBase64} exactly-one;
audio is never persisted, the transcription is ledgered as `transcribe_voice`,
and the transcript walks the same fenced path and is returned for the user to
check) — into a prefilled SME draft form — every extracted value
re-validated/normalised by the app, buyer identity a deterministic register
suggestion, nothing stored (the client saves through the ordinary
`createDraft` path); **customer-list import drafting**
(`modules/clerk/draft-client-import.ts`, `clients.import` + firm scope,
firm-funded) is the draft-format seam pointed at the client book: Clerk NAMES
which export column carries each import field, every proposal is re-verified
against the headers that literally exist (hallucinated required column fails
closed 502, hallucinated optional column dropped), and the returned rows come
from the deterministic mapper — they feed the ordinary `/clients/import`
validate-then-commit flow, so Clerk can never create a party. **Escalation triage**
(`modules/desk/triage.ts`, opt-in `clerk_triage` flag, sweep-driven so the
client's escalation never waits on a model call) proposes routing — closed
category set, priority, catalogue code re-verified against the codes that
exist — stored on the operator case for the operator to accept or override,
never applied automatically; **drafted escalation replies**
(`modules/desk/draft-reply.ts`, operator `operator.queue.act`,
platform-funded) apply the explainer posture to the desk: the draft is
grounded in the catalogue cause/fix + the invoice's real attempt history (the
client's message only inside the fence), template fallback always answers,
and `sendEscalationReply` is the ONLY writer of `escalations.operator_reply`
(acknowledges an open escalation; the SME invoice detail shows the client the
reply). **Grounded firm-data Q&A**
(`modules/clerk/data-intents.ts`): Ask Clerk carries a second closed catalogue
next to the claims register — data intents ("what's overdue?", "what did we
submit this month?"), offered in the intent enum only to firm-scoped askers.
The model still only classifies; the app runs the matching FIXED,
fully-parameterized query (runtime inputs: the principal-resolved firmId plus
optional month/client parameters the model can only pick from CLOSED app-built
option lists — the last 12 Lagos months and the firm's own engaged clients
under opaque `c1..cN` keys, resolved back through the app's own maps; a param
a lookup can't honour REFUSES, never silently answers unfiltered) inside
`inClerkScope(firmId)` plus an explicit firm filter, and assembles the answer
deterministically (`answer.dataIntent` marks these, `answer.dataParams` names
the resolved scope). Predicates mirror digest/compliance-window (Lagos
calendar), so Ask can never disagree with the dashboards. Clerk health (console) includes a
confidence-calibration table (`computeCalibration` in
`modules/clerk/metrics.ts`): kept-rate vs model confidence per band, from the
corrections exhaust, plus **unit economics** (`metrics.economics`, pure ledger
SQL): token spend + error count per PURPOSE inside the window, and a per-month
failure taxonomy (ok/invalid/killed/error) over the trailing months — the
numbers pricing tiers and a provider evaluation will want, zero model calls —
and a per-supplier accuracy table (`metrics.supplierAccuracy`, below), plus
an **injection-resistance trend** (`metrics.injectionTrend`, pure SQL over
the stored eval runs): monthly resistance buckets and the per-prompt-version
split — whether a promoted prompt actually held the line the canary
predicted — and a **platform spend meter** (`metrics.platformSpend`):
month-to-date ledger totals split firm-funded vs platform-funded with a
linear pace projection on the same UTC boundary as the per-firm budgets.
The trend also has teeth: the **resistance-drop alert**
(`modules/clerk/resistance-watch.ts`, sweep, zero model calls) runs the SAME
monthly buckets as the chart (`injectionResistanceMonths`, shared with
metrics so banner and alert can never disagree) and raises a durable alert —
one audit event per degraded month (the append-only ledger is the dedup key)
plus an error log — when a measured month's resistance falls ≥10 points below
the previous one (≥5 injection fixtures both sides, env-tunable);
`metrics.resistanceAlert` drives a red banner on the health page.
The eval harness also carries a **prompt canary**
(`modules/clerk/prompt-canary.ts`, `POST /clerk/eval/canary` + `GET
/clerk/eval/prompt`, `clerk.use`, spends 2× a corpus pass): the corpus runs
under a CANDIDATE system prompt and the incumbent side by side (purpose
`eval_canary`, capped at 40 fixtures), scored by the same `scoreFixture`
machinery, with a deterministic verdict — injection resistance may never
drop, accuracy is judged outside a 2% noise band — returned, never stored
(promotion is a code change the operator makes with the evidence in hand).
The eval harness also grows an active red team: **adversarial eval growth**
(`modules/clerk/red-team.ts`, opt-in `clerk_red_team` flag, spends tokens) has
the model GENERATE a prompt-injection payload against a legitimate static
fixture; the app owns ground truth — it APPENDS the payload to the UNCHANGED
document (so the base fixture's expected always survives) and DISCARDS any
variant without a critical decoy that actually differs from the truth. Stored
variants (bypass-only RLS, migration 0016) join the corpus as riskLabel
`injection` fixtures scored by the SAME `scoreFixture` machinery as the
hand-written pair. The exhaust also feeds the product directly:
**supplier memory** (`modules/clerk/exemplar.ts`) deterministically matches a
new text document against the firm's OWN approved fixtures (TIN/name-token
containment, newest first, same-firm join — never cross-firm) and rides the
match along as a fenced one-shot with its own ledger prompt version
(`extract.v1+ex1`, `extraction.exemplarCaseId` for audit; eval replay never
uses exemplars), with **exemplar hygiene**: a candidate whose descendant
approvals (matched via `exemplarCaseId`) got most fields overridden (3+
cases, ≥50% override) is demoted to the next candidate — the exhaust
auditing the exhaust, zero model calls; **party alias memory** (`modules/clerk/alias.ts`,
`party_name_aliases` + firm-keyed RLS migration 0017, zero model calls) learns
NAMES where supplier memory learns documents: every approval records the
extracted supplier/buyer name → confirmed-party pairing under a normalized
key (order/case/legal-suffix noise stripped; identical-to-register aliases
teach nothing; newest confirmation wins), and suggestion surfaces
(`applyAlias` in party-match, NL invoice drafting) consult it FIRST — the
memory only nominates, the caller's candidate filters (type, sphere, merged)
decide, and a remembered pick shows as `viaAlias` ("Remembered" chip);
**register-history pre-flight**
(`modules/clerk/register-preflight.ts`, zero model calls) checks extracted
supplier/buyer identities against the firm's party SPHERE
(`firmPartySphereCondition` — parties are the shared spine, no tenant RLS)
and the supplier's own invoice history (VAT-rate deviation, plus the
history-based anomaly flags: duplicate invoice number = full issue,
same-date-same-total and amount-outlier-vs-median = advisory, and a pure
issue-date sanity check — overdue-on-arrival / future-dated — that runs even
for operator captures), with register TINs only ever masked in issue text;
**recurring suggestions** (`modules/invoice/recurring-suggest.ts`, zero model
calls, nothing stored) mine a client's own invoices for monthly billing
patterns (3+ invoices, monthly median gap, clustered amounts, buyers already
covered by ANY template excluded) and prefill the existing template dialog —
the client disposes; **unbilled-income detection**
(`modules/invoice/unbilled-income.ts`, `GET /unbilled-income`, zero model
calls, nothing stored) is the same miner pointed at the month the invoice
DIDN'T go out — sharing `buyerBillingHistories` with the suggestions so the
two cards can never disagree about what a habit is, alerting only inside a
bounded window (grace 5 days, lapsed after 45 — an ended arrangement stops
nagging), surfaced as an SME dashboard card and a fact line in the weekly
digest (`countFirmUnbilled`); **buyer payment-behaviour memory**
(`modules/invoice/payment-behaviour.ts`, `GET /payment-behaviour`, zero model
calls, nothing stored) mines per-buyer days-to-pay medians from the client's
own ACCEPTED reconciliation matches (credit lines with a value date only —
the human-confirmed exhaust, 3+ settlements required, negatives dropped):
"usually pays ~Nd" chips on the receivables debtors and the invoice detail,
the projection engine for the **cash-flow outlook + chase list**
(`modules/invoice/cashflow.ts`, `GET /dashboard/cashflow` +
`GET /dashboard/chase-list`, zero model calls, nothing stored) — one shared
per-invoice projection (expected settlement = buyer rhythm > due date >
default 30-day terms, same `OUTSTANDING` fragment as receivables.ts) rolled
into week-bucketed expected inflows (already-late money in its own bucket,
never future inflow) and a capped "worth chasing" list ranked by days beyond
each buyer's OWN expectation, each row opening the invoice's chaser button —
and the grounding for the **payment-chaser draft**
(`modules/clerk/draft-chaser.ts`, `POST /clerk/draft-chaser`, `clerk.capture`
+ module-enforced tenant/SEC-03 like the explainer) — digest posture: the
model phrases ONE outstanding receivable's stored facts (eligibility is the
receivables definition exactly, so a settled invoice can never be chased)
plus the buyer's payment rhythm into a reminder the client copies into their
OWN email; template fallback always answers, nothing stored, nothing sent by
the platform; **line-item memory** (`modules/invoice/line-items.ts`,
`GET /line-item-suggestions`, zero model calls, nothing stored) mines the
client's own invoice lines into an item catalogue (order-insensitive item
key, 2+ occurrences, median unit price, MODAL VAT rate, newest description)
that feeds the SME draft form's "frequent items" chips and a capture
pre-flight advisory when a line's unit price is far (×4) off that item's own
history (3+ lines) — same SEC-03 sibling gate as the other history checks; **per-supplier accuracy** (`metrics.supplierAccuracy`,
pure SQL) joins the corrections exhaust to the approved invoice's register
supplier so the health page names whose documents Clerk reads worst; and the
console weights review-queue effort and shows per-field "historically
corrected" hints from `metrics.corrections` (`fieldWeights`/`correctionHint`
in clerk-shared — never auto-accept, ordering and hints only). The queue is
also **batch-aware**: every async-batch case records its `batchId`
(clerk_cases column, covered by the same firm-keyed RLS), a bundle's segments
coalesce into one group at their best-ranked member's position
(`groupQueueByBatch` in clerk-shared — an unbatched queue renders exactly as
before), and the group header shows "reviewed R of C" from the batch
endpoints' `reviewedCases` (decided = approved/rejected; `reviewedCounts` in
batch-async.ts).

## Data layer & multi-tenant isolation (the part to get right)

- **RLS tenancy.** Every request runs inside a per-request transaction that
  `SET LOCAL ROLE meridian_app` (a non-`BYPASSRLS` role) and binds `app.firm_id`
  / `app.bypass` GUCs to the resolved principal (`lib/db/src/context.ts`,
  `app.ts tenantContext`). All `getDb()` call sites read this ambient
  transaction, so firm isolation is enforced at the data layer.
- **SEC-03 sub-tenant scoping.** Firm-keyed RLS shares a firm across all its
  `client_user`s, so a client route must ALSO call `assertClientPartyScope` /
  filter by `clientPartyScope` — RLS is not a backstop for sibling-client
  isolation. When adding a client-facing read, copy the pattern in
  `routes/invoices.ts` / `routes/engagements.ts`.
- **The 4xx rollback rule.** `tenantContext` buffers the response and
  **commits on `status < 400`, rolls back on `status >= 400`** — nothing
  reaches the client until the transaction settles. Consequence: anything that
  must persist even when the handler returns an error (e.g. the login throttle
  counters) must write on the **raw `pool`**, not `getDb()`. See
  `modules/auth/throttle.ts`.
- **Migrations vs push.** Tables come from `drizzle push`; the versioned
  guardrail migrations (`lib/db/src/migrations`, RLS policies, triggers,
  retention) apply on boot outside production and must roll back cleanly (the
  rollback test enforces this). Adding a tenant table? Add a firm-keyed RLS
  policy in a new numbered migration and extend the rollback test — the
  `rls-coverage` test fails CI for any tenant-keyed table without a policy
  (documented allowlist: `audit_events`), and `rls-isolation.test.ts`
  (api-server) exercises the policies behaviorally under the real
  `meridian_app` role. Production does NOT run migrations at boot (deliberate;
  Publish owns prod schema) — after merging a new guardrail migration, apply
  it to production manually (`pnpm --filter @workspace/db run migrate` against
  the prod `DATABASE_URL`); the boot-time guardrail verifier logs exactly
  which tables are uncovered until then.

## Auth & sessions

- Production identity is Clerk; a first-party email+password cookie session
  (`modules/auth/session.ts`) serves the web apps and demo. Session tokens are
  stateless HMACs carrying `userId.expiry.epoch`; `users.session_epoch` is
  bumped on password change AND password reset to revoke outstanding tokens.
  Recovery (IDN-02) is operator-assisted: `POST /password-resets`
  (`identity.write`) issues a single-use 24h link (sha256-only stored,
  migration 0012 keeps the table bypass-only) redeemed at the public
  `/auth/reset-password`; the landing page's "Forgot your password?" routes
  there.
- CSRF: a custom-header guard on cookie-authenticated state-changing requests
  (`middleware/principal.ts`); the session cookie is `SameSite=None` for the
  preview iframe, so the frontends set a CSP `frame-ancestors` allowlist
  (vite preview / e2e serve layer) rather than `X-Frame-Options`.
- **Self-serve invites (IDN-01).** A firm_admin onboards teammates/clients into
  its own firm without operator provisioning (`modules/auth/invitations.ts`,
  `routes/invitations.ts`). The invite carries a single-use secret — 32 random
  bytes, shown once, only its sha256 stored — redeemed at the **public**
  `POST /auth/accept-invite` (on `PUBLIC_PATHS`; the token IS the credential, so
  it runs in the RLS-bypass context that migration 0008's firm-keyed policy
  grants). Accepting creates the user + membership and consumes the invite via a
  compare-and-set on status, so a token can't be redeemed twice. firmId is forced
  to the inviter's firm; a `client_user` invite must name a client party the firm
  engages. Operators bootstrap a NEW firm through the same rail: provision the
  firm (`POST /firms`), then send its first `firm_admin` invite naming that
  `firmId` (console → Team invitations shows operators a target-firm picker +
  inline provisioning); the admin self-serves the rest. Platform roles
  (operator, auditor, bank/buyer) deliberately stay on `identity.write`, never
  the invite flow.

## Background work (the pipeline worker)

`modules/pipeline/pipeline.ts` runs three in-process loops: outbox drain,
reconciliation sweep, and the registered compliance sweeps (deadline
reminders, recurring invoices, B2C pre-breach alerts, buyer exposure
refresh, push receipts, login-attempt / password-reset cleanup, outbox +
stamp-verification retention, unmapped-code cases, and the
Clerk watchdog / expired-claims / expired-case-content / eval-growth /
weekly-digest / per-client-statement / red-team-growth / escalation-triage /
async-batch / resistance-watch sweeps). Register new periodic work with `registerSweep(fn)`.
Alert fan-out (`modules/messaging/fan-out.ts`) is consent-gated: no layer-1
grant, no alert (CORE-03). Statutory day boundaries — submission windows, VAT
due dates, "overdue today" — use the LAGOS calendar via
`lib/lagos-time.ts` (SQL: `AT TIME ZONE 'Africa/Lagos'`); never derive a
business "today" from `toISOString().slice(0, 10)` or `current_date`.

**Multi-instance safety.** The loops are reentrancy-guarded per process, and
every sweep is **idempotent** by construction (advisory locks, dedup ledgers,
compare-and-set on `nextRunDate`, `FOR UPDATE SKIP LOCKED`), so running several
instances is *correct* though *redundant* — two instances may both attempt a
pass, but the guards make the second a no-op. The one piece of state that was
process-local, the login throttle, is now in Postgres (`login_attempts`), so
its caps hold cluster-wide. On Autoscale (scales to zero), the in-process timers
freeze while idle; an external scheduler pings `GET /api/internal/sweep` to run
one full pass on demand.

## Observability

- `GET /api/healthz` — liveness (no DB touch) + contract version.
- `GET /api/readyz` — readiness (`SELECT 1`); 503 if the DB is unreachable.
- `GET /api/metrics` — Prometheus text: request-duration histogram
  (method/route/status, id segments collapsed), process health (event-loop lag,
  RSS, heap, uptime), and sweep liveness (`meridian_sweep_last_success_*`).
  Hand-rolled in `lib/metrics.ts` (a metrics lib would fork drizzle via
  `@opentelemetry/api`).
- `/api/metrics` and `/api/internal/sweep` are public by default; setting
  `METRICS_TOKEN` / `SWEEP_TOKEN` closes the endpoint behind that shared
  secret (`x-op-token` header or `?token=`, `lib/op-token.ts`). Opt-in:
  unset env keeps today's open behaviour.

## Verify battery (run before shipping)

A scratch Postgres 16 is required (`DATABASE_URL=postgresql://…/meridian_ci`).

```
pnpm --filter @workspace/api-spec run codegen   # must produce zero drift
pnpm run typecheck                              # libs + all packages
pnpm run lint
pnpm dlx pnpm@11 audit --prod --audit-level=high   # supply-chain gate (pnpm 10's audit endpoint is retired)
pnpm --filter @workspace/db run push            # prepare the scratch DB: tables first...
pnpm --filter @workspace/db run migrate         # ...then guardrail migrations, or the tests hit permission-denied
pnpm --filter @workspace/api-server run test    # DB-backed; run against meridian_ci
pnpm --filter @workspace/db run test            # migration rollback (real Postgres)
pnpm --filter @workspace/mobile run test
pnpm --filter @workspace/sme-compliance run test
pnpm --filter @workspace/console run test
pnpm --filter @workspace/buyer-portal run test
pnpm --filter @workspace/format --filter @workspace/api-errors --filter @workspace/web-ui run test
# web builds (each needs BASE_PATH + PORT), then the e2e journeys:
pnpm --filter @workspace/scripts run e2e        # 38 checks vs real builds + DB
```

CI (`.github/workflows/ci.yml`) runs all of the above.

## Deployment notes

- After a merge, **restart the Replit api-server workflow** — otherwise the
  deployed `dist` is stale and the version-skew banner fires. Schema `push` and
  the guardrail migrations run on boot, so new columns/policies land with that
  restart.
- `FRAME_ANCESTORS` env overrides the clickjacking allowlist per deployment
  (defaults to `'self'` + the Replit preview domains).
