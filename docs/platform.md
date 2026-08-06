# Platform guide — data layer, auth, background work, rails & exports

The deep reference for everything below the product features: tenancy, auth,
the pipeline worker, messaging, statements, billing/export surfaces and
observability. Paths are relative to `artifacts/api-server/src` unless noted.
The AI-assistant side lives in `docs/clerk-ai.md`.

## Data layer & multi-tenant isolation (the part to get right)

- **RLS tenancy.** Every request runs inside a per-request transaction that
  `SET LOCAL ROLE meridian_app` (a non-`BYPASSRLS` role) and binds
  `app.firm_id` / `app.bypass` GUCs to the resolved principal
  (`lib/db/src/context.ts`, `app.ts tenantContext`). All `getDb()` call sites
  read this ambient transaction, so firm isolation is enforced at the data
  layer.
- **SEC-03 sub-tenant scoping.** Firm-keyed RLS shares a firm across all its
  `client_user`s, so a client route must ALSO call `assertClientPartyScope` /
  filter by `clientPartyScope` — RLS is not a backstop for sibling-client
  isolation. When adding a client-facing read, copy the pattern in
  `routes/invoices/` (shared.ts `loadForTenant`) / `routes/engagements.ts`.
- **The 4xx rollback rule.** `tenantContext` buffers the response and
  **commits on `status < 400`, rolls back on `status >= 400`** — nothing
  reaches the client until the transaction settles. Consequence: anything
  that must persist even when the handler returns an error (e.g. the login
  throttle counters) must write on the **raw `pool`**, not `getDb()`. See
  `modules/auth/throttle.ts`.
- **Migrations vs push.** Tables come from `drizzle push`; the versioned
  guardrail migrations (`lib/db/src/migrations`, RLS policies, triggers,
  retention) apply on boot outside production and must roll back cleanly
  (the rollback test enforces this). Adding a tenant table? Add a firm-keyed
  RLS policy in a new numbered migration and extend the rollback test — the
  `rls-coverage` test fails CI for any tenant-keyed table without a policy
  (documented allowlist: `audit_events`), and `rls-isolation.test.ts`
  (api-server) exercises the policies behaviorally under the real
  `meridian_app` role. Production does NOT run migrations at boot
  (deliberate; Publish owns prod schema) — after merging a new guardrail
  migration, apply it to production manually
  (`pnpm --filter @workspace/db run migrate` against the prod
  `DATABASE_URL`); the boot-time guardrail verifier logs exactly which
  tables are uncovered until then.

## Auth & sessions

- Production identity is Clerk (the identity provider — unrelated to the AI
  assistant of the same name); a first-party email+password cookie session
  (`modules/auth/session.ts`) serves the web apps and demo. Session tokens
  are stateless HMACs carrying `userId.expiry.epoch`; `users.session_epoch`
  is bumped on password change AND password reset to revoke outstanding
  tokens. Recovery (IDN-02) is operator-assisted: `POST /password-resets`
  (`identity.write`) issues a single-use 24h link (sha256-only stored,
  migration 0012 keeps the table bypass-only) redeemed at the public
  `/auth/reset-password`; the landing page's "Forgot your password?" routes
  there.
- CSRF: a custom-header guard on cookie-authenticated state-changing
  requests (`middleware/principal.ts`); the session cookie is
  `SameSite=None` for the preview iframe, so the frontends set a CSP
  `frame-ancestors` allowlist (vite preview / e2e serve layer) rather than
  `X-Frame-Options`.
- **Self-serve invites (IDN-01).** A firm_admin onboards teammates/clients
  into its own firm without operator provisioning
  (`modules/auth/invitations.ts`, `routes/invitations.ts`). The invite
  carries a single-use secret — 32 random bytes, shown once, only its sha256
  stored — redeemed at the **public** `POST /auth/accept-invite` (on
  `PUBLIC_PATHS`; the token IS the credential, so it runs in the RLS-bypass
  context that migration 0008's firm-keyed policy grants). Accepting creates
  the user + membership and consumes the invite via a compare-and-set on
  status, so a token can't be redeemed twice. firmId is forced to the
  inviter's firm; a `client_user` invite must name a client party the firm
  engages. Operators bootstrap a NEW firm through the same rail: provision
  the firm (`POST /firms`), then send its first `firm_admin` invite naming
  that `firmId` (console → Team invitations shows operators a target-firm
  picker + inline provisioning); the admin self-serves the rest. Platform
  roles (operator, auditor, bank/buyer) deliberately stay on
  `identity.write`, never the invite flow.
- **TOTP two-factor (opt-in).** Hand-rolled RFC 4226/6238 in
  `modules/auth/totp.ts` (base32, HMAC-SHA1, ±1 step, replay blocked via
  `users.totp_last_used_step`). An enrolled login returns `mfaRequired` + a
  5-minute signed mfa token (structurally distinct from session tokens,
  epoch-bound) instead of the cookie; the public `POST /auth/totp/challenge`
  redeems token + code (or a sha256-stored recovery code, burned on use) for
  the ordinary login tail. Setup/activate/disable are self-service on the
  landing portal's security card; activate/disable bump `session_epoch`.
  `TOTP_REQUIRED_ROLES` env (dark by default) hard-gates named roles once a
  deployment has rolled enrolment out. The e2e harness mints real codes
  (`scripts/src/e2e/totp.mjs`).
- **Rate limiting.** `middleware/rate-limit.ts` sits between principal
  resolution and `tenantContext` and counts on the `login_attempts` table
  via the raw pool (a 429 can't erase its own evidence): GENERAL 600/min per
  principal (IP fallback) and MODEL 60/min across every model-calling route;
  `RATE_LIMIT_GENERAL_PER_MIN` / `RATE_LIMIT_MODEL_PER_MIN` tune, 0 disables
  a class; PUBLIC_PATHS exempt (they carry their own gates).

## Background work (the pipeline worker)

`modules/pipeline/pipeline.ts` runs three in-process loops: outbox drain,
reconciliation sweep, and the registered compliance sweeps. Register new
periodic work with `registerSweep(fn)` — wrapped `atMostHourly` when every
worker tick would be too often. The sweep inventory lives in the code, not
here: grep `registerSweep(` for the authoritative list.

Alert fan-out (`modules/messaging/fan-out.ts`) is consent-gated: no layer-1
grant, no alert (CORE-03). Statutory day boundaries — submission windows,
VAT due dates, "overdue today" — use the LAGOS calendar via
`lib/lagos-time.ts` (SQL: `AT TIME ZONE 'Africa/Lagos'`); never derive a
business "today" from `toISOString().slice(0, 10)` or `current_date`.

**Multi-instance safety.** The loops are reentrancy-guarded per process, and
every sweep is **idempotent** by construction (advisory locks, dedup
ledgers, compare-and-set on `nextRunDate`, `FOR UPDATE SKIP LOCKED`), so
running several instances is *correct* though *redundant* — two instances
may both attempt a pass, but the guards make the second a no-op. The one
piece of state that was process-local, the login throttle, is now in
Postgres (`login_attempts`), so its caps hold cluster-wide. On Autoscale
(scales to zero), the in-process timers freeze while idle; an external
scheduler pings `GET /api/internal/sweep` to run one full pass on demand.

## Messaging, inbound rails & the notification inbox

- **Outbound transport.** Sends flow through an injectable
  **MessageTransport** (`modules/messaging/messaging.ts`, push.ts's
  injection pattern) — the simulator is the default;
  `MESSAGING_WEBHOOK_URL`/`_TOKEN` light a generic pointer-only JSON relay,
  and the receiving relay owns ref→address resolution so SEC-12 (no PII in
  platform sends) holds platform-side. Recipient identities are opaque refs
  minted by `modules/messaging/recipient-ref.ts`.
- **Consent.** `fanOutAlert` (`modules/messaging/fan-out.ts`) is the
  party-scoped send path: CORE-03 layer-1 consent is the first-line gate;
  every send lands a pointer-only row in the `messages` ledger.
- **Notification inbox** (`modules/messaging/inbox.ts`,
  `GET /notifications`, any signed-in principal): the messages ledger read
  from the RECIPIENT's side, newest first. `messages` has NO firm key and NO
  RLS policy — it is a platform-wide pointer ledger — so **the
  recipient-identity equality IS the isolation wall**: every send rail stamps
  exactly one of `recipient_party_id` / `recipient_user_id` on the row, and
  the feed reads strictly by those uuid columns (firm-keyed RLS could not be
  a sibling wall here anyway: two client_users of one firm share the firm's
  RLS scope). The opaque `recipient_ref` is a lossy letters-only derivation
  kept for display and provider-side correlation ONLY — never scoping. Rows
  predating the identity columns silently drop out of feeds (pointer-only
  history; accepted). Per-role resolution: `client_user` → its own
  `clientPartyId` (the identity every party-scoped alert rail stamps);
  firm_admin/firm_staff → their own `userId` (the staff-preference rails'
  identity) — staff deliberately do NOT also see their firm's party rows,
  which would leak per-client alert traffic to every teammate (the operator
  message log, `GET /messages`, is the firm-wide monitor, behind its own
  gate); `operator` → its own `userId` (the identity the platform-health
  offer rail stamps on operator nudges — see the health watch under
  Integration layer); `buyer_user` → its own `buyerPartyId`
  (buyer-addressed sends stamp the buyer party; the equality keeps one
  buyer organization out of another's feed exactly as it does for sibling
  clients); auditor/bank_user get an empty feed (no send rail stamps
  identities for them). Rows STAY pointer-only in
  the feed: the only server-side resolution is a human title from the
  template registry's static description (unknown/retired keys are
  humanized, never fail the feed); entity pointers pass through opaque. The
  console and SME apps surface it as a notification bell
  (`components/notification-bell.tsx` in each).
- **Inbound rails** (email + WhatsApp): machine webhooks deliberately OFF
  the OpenAPI contract, FAIL-CLOSED shared secrets (`INBOUND_EMAIL_TOKEN` /
  `INBOUND_WHATSAPP_TOKEN` unset = rail dark, 404), byte-identical responses
  for resolved and unresolved senders, deterministic sender resolution.
  Attachments/messages walk the ordinary Clerk capture path — full detail in
  `docs/clerk-ai.md` § Intake paths; shared daily-cap / semaphore /
  type-mapping machinery in `modules/inbound/shared.ts`.
- **Staff notification preferences** and digest/statement delivery (verified
  email, claim-first CAS, pointer-only refs) are documented with their
  producers in `docs/clerk-ai.md` § Digests, statements & delivery.

## Statements, bank feeds & scanned intake

All reconciliation surfaces are gated by the `reconciliation` feature flag.

- **Ingestion** (`modules/statements/service.ts`, `POST /statements`,
  `statement.write`): CSV parsed deterministically
  (`modules/statements/parsers.ts`, 4MB CSV cap), CORE-03 consent enforced,
  validate-then-commit preview (`commit:false` is the human check), and the
  `statement.reconcile` outbox drives matching. Inserting
  `bank_statement_lines` directly is forbidden by design — every path goes
  through `ingestStatement`.
- **Scanned/PDF statement intake** (`modules/statements/scan-intake.ts`):
  `POST /statements` accepts exactly one of `csv` | `pdfBase64`
  (server-enforced exclusive-or). The PDF branch is ONE model call (purpose
  `extract_statement`, prompt version `extract-statement.v1`) that PROPOSES
  transaction lines: a text-layer statement is fed as text (150k-char cap);
  a textless one is rasterized via the Clerk `rasterizePdfScan` path (max 4
  pages, 5MB decoded cap); output is schema-validated (max 500 lines, fail
  closed). Proposed lines are rendered to the generic CSV shape
  (`SCAN_PROPOSAL_FORMAT_KEY` pins the parser so detection never drifts to
  a bank-specific one) and flow through the ORDINARY `ingestStatement` path
  — consent, parse invariants, preview and the reconcile outbox all apply,
  and **the preview IS the human check**: a proposed line the parser cannot
  normalize surfaces as an ordinary "invalid" preview row — never a silent
  drop, never a value the model smuggles past the parse pipeline. The route
  pre-checks CORE-03 consent (token thrift; ingest remains the enforcing
  gate) and the firm Clerk budget BEFORE the provider. **Commit-from-preview
  (contract 0.40.0)**: a PDF may only PREVIEW — the response carries
  `proposedCsv` (the deterministic rendering of the proposal), and committing
  means POSTing that text back as `csv` with `commit:true`; `pdfBase64` +
  `commit:true` is refused (400 `PDF_COMMIT_FROM_PREVIEW`), so extraction
  never silently re-runs on the commit leg. The route runs OUTSIDE the
  request transaction (app.ts `NO_CONTEXT_ROUTES` — the model call must not
  pin a pooled connection under the 30s cap) and is in the MODEL rate-limit
  class; `ingestStatement` runs in its own short bypass transaction so
  statement + lines + reconcile outbox still commit all-or-nothing.
- **Custom statement formats** (`modules/statements/custom-formats.ts`,
  operator `catalogue.write`, global reference data like the error
  catalogue) store column-name mappings consumed by the same parser seam —
  saving REQUIRES the mapping to parse its own sample, and
  `modules/clerk/draft-format.ts` proposes mappings from a pasted sample
  with header names re-verified against what actually exists.
- **Bank-feed connections** (`modules/statements/feed-{contract,engine}.ts`,
  opt-in `bank_feeds` flag, firm-keyed RLS migration 0020, console portfolio
  card): the ERP-connector pattern pointed at statements — per-client
  connections with cursor-paged `pullLines` connectors, sync runs on the
  outbox (`statement.feed_sync`, pre-created run rows), and pulled lines
  rendered to generic CSV and fed through the ORDINARY `ingestStatement`
  flow — consent, parse invariants and the reconcile outbox all apply.

## Payables (bills)

The invoice spine read in the other direction: a **bill** is a captured
supplier invoice — the firm's client is the BUYER — living in the same
`invoices` table (Clerk approval is how most arrive). What separates a bill
from a receivable is pure **orientation**: whether the supplier party is one
of the firm's engaged clients. That one predicate now runs in both
directions:

- **Evidence-only payStatus.** `GET /bills` (`clientPartyId` required;
  client-facing, so the usual tenant + SEC-03 scoping applies) derives
  `open | scheduled | paid` from settlement evidence ONLY — `payer_flag`
  settlement events written by `POST /bills/{id}/payment-flag` plus debit
  statement matches: paid when a paid/statement event exists, scheduled when
  the latest flag is scheduled, else open (the spec's own comment on
  `BillSummary`). A bill's invoice status NEVER transitions: there is no
  lifecycle to run — stamping a supplier document is the supplier's own job.
- **The orientation guard (409 `NOT_SUBMITTABLE`).** validate / submit /
  credit-note refuse any invoice whose supplier is not an engaged client of
  the firm. This closes a real gap: previously a vendor's captured invoice
  could be submitted for stamping in the client's name if layer-1 consent
  happened to exist.
- **The debit reconciliation lane.** Debit statement lines propose against
  unpaid bills (supplier-name matching); accepting records
  `statement_match` settlement evidence WITHOUT any status transition — the
  accept-without-transition sibling of the credit lane. Credits still match
  receivables only.
- **Bill verifications** (`POST /bills/{id}/verify-stamp`, stored per bill
  in `bill_verifications` — firm+invoice keyed,
  `lib/db/src/schema/bills.ts`): the payer types the supplier's IRN + CSID
  and the ordinary verify path checks the national record; the newest result
  rides the bills list (`lastVerification`) so the input-VAT posture is
  visible per bill. Migration 0023 adds the firm-keyed RLS AND extends
  `meridian_purge_expired` to delete `bill_verifications` and `chase_log`
  child rows before invoices — the chase_log arm fixes a latent FK violation
  (migration 0018 never taught the purge function about its table).
- **Counter hygiene.** Firm-wide counters that mean "invoices we must file"
  — the digest's unsubmitted/overdue facts, the compliance calendar,
  firm-wide Ask aggregates — now use an explicit receivable-orientation
  predicate (supplier IS an engaged client), so draft bills no longer
  pollute compliance counts.
- **Surfaces.** The SME **Bills** page (flag scheduled/paid, verify stamp)
  plus the dashboard **Payables** card (`GET /dashboard/payables` —
  overdue/due-week buckets and top suppliers, deterministic) and `bill_due`
  compliance-calendar deadlines; mobile mirrors the bills screen and a home
  tile. Vendor parties bootstrap through Clerk approval's firm-created
  provenance arm (`docs/clerk-ai.md` § Review & approval). The demo seed
  carries the vendor party "Lagos Packaging Supplies Ltd" and draft bill
  `BILL-2001`, which the e2e payables journey rides.

## Governance (maker-checker)

Firm-level dual control over stamping submissions (contract 0.45.0,
`firm_policies` + `invoice_approvals` — `lib/db/src/schema/governance.ts`,
firm-keyed RLS via migration 0024; `modules/invoice/approvals.ts`,
`routes/firm-policies.ts`).

- **The policy** (`GET`/`PUT /firm/policies`): today one switch,
  `submitApprovalRequired`, **default OFF** — no `firm_policies` row means
  every policy at its default, so existing firms keep single-actor submits
  untouched. Reads are open to every firm principal (`invoice.read` — the
  submit UI must be able to explain WHY a submit will demand a colleague);
  the write is an EXPLICIT `firm_admin` role check (the integrations-route
  precedent), not a capability — no broad capability grant can accidentally
  hand out "govern the firm's controls", and a machine principal's synthetic
  `api_key` role can never switch the policy off around the humans it binds.
  Lazy-upsert on the firm_id unique; audited with pointer-safe booleans
  (before/after policy state only). The console surfaces it as the
  **Governance** card on the portfolio (firm admins only).
- **Approval rows are EVIDENCE**: never deleted, only revoked (`revokedAt`).
  `POST /invoices/{id}/approve` (`invoice.approve` — firm_admin/firm_staff
  only: a client_user must not clear its own firm's guard, and cross-tenant
  operators are not the firm's checker) guards orientation first (a bill
  earns the same 409 `NOT_SUBMITTABLE` a submit would) and then state — only
  pre-submission paper (draft / validated / failed) can collect an approval
  (else 409 `APPROVAL_BAD_STATE`). **Any successful content edit revokes the
  invoice's live approvals** (`updateInvoiceContent` →
  `revokeLiveApprovals`), so an approval can never cover content the
  approver did not see. `GET /invoices/{id}/approvals` lists the full trail,
  revoked rows included (same tenant/SEC-03 gates as the invoice read); the
  SME invoice detail renders it as the Approvals card with an "Approve for
  submission" action.
- **The submit-time guard** (`assertSubmitApproved`, called inside
  `submitInvoice` after orientation and BEFORE consent — an unapproved
  submit must not leak the supplier's consent standing): policy off is a
  no-op; policy on demands a LIVE approval by a principal **OTHER than the
  submitting actor** — dual control means two humans, not one human clicking
  twice — or the submit 409s `APPROVAL_REQUIRED` with a plain-language
  message. When the actor is unknown (system/worker paths carry no
  principal) any live approval counts: the human separation was enforced
  when the approval and the triggering action were recorded. The approver ≠
  submitter check deliberately bites at submit time, not approve time — an
  approval is evidence anyone entitled may record; what matters is that the
  eventual submitter is somebody else.
- **Awaiting-approval visibility** (round 17): `pendingApprovals` /
  `awaitingApproval` (approvals.ts) is the ONE spelling of "waiting" —
  policy ON, pre-submission receivable paper (the recorder's own
  APPROVABLE_STATUSES), no live approval; policy off answers **null**, so
  "0 waiting" and "the firm doesn't use approvals" never read the same.
  Surfaced four ways, all deterministic: a weekly-digest fact (count +
  oldest wait), the client-safe `data.pending_approvals` Ask intent (forced
  own-party pin; links are the caller's own drafts), a platform-wide count
  on the operator daily brief, and the invoice status light's amber
  "waiting for a colleague's approval" reason with its matching
  recommended action (failed paper gets the same warning alongside its
  red fix-first reason). Known actor-agnostic edge: an invoice whose ONLY
  live approval was recorded by the person about to submit reads as "not
  waiting" everywhere, yet THAT person's submit still 409s — the guard's
  approver ≠ submitter rule bites per-actor at submit time.
- **The standing-approval engagement wall** (round 30 — the automation
  sibling of these controls; full detail in `docs/clerk-ai.md` § Standing
  approvals): granting a Clerk standing approval REFUSES
  `409 NO_LIVE_ENGAGEMENT` unless the firm holds a live
  (open/in_progress) engagement with the client — `assertPartyAccess`
  deliberately accepts archived engagements so retention-era reads keep
  working, but an autopilot must not be switched on for a client the firm
  has wound down. The daily sweep re-checks the same wall per run and
  auto-pauses the grant `engagement_closed` when the engagement lapses
  after the grant (the status-only paths a full offboard — which revokes
  grants outright — never touches).

## Collection accounts

Virtual account references per client whose inbound payments auto-observe
settlements — the mandatory-source settlement hierarchy's auto-observed
member (`modules/collections/{service,provider}.ts`,
`routes/collections.ts`, `collection_accounts` + RLS via migration 0024).

- **Unmatched inbound payments** (`modules/collections/unmatched.ts`,
  `GET /collection-accounts/unmatched`, round 17): the webhook's
  pointer-only `collections.unmatched` audit events read back per account
  over a trailing 90-day window (counts, first/last seen, resolved account
  reference and client name — amounts were never recorded, and the note
  says to reconcile against the provider statement). Same
  `statement.write` + firm gate as the accounts list; surfaces as an amber
  advisory under the console collection-accounts card, a weekly-digest
  fact, and a platform-wide 7-day count on the operator daily brief.

- **Provisioning** (`GET`/`POST /collection-accounts`,
  `POST /collection-accounts/{id}/deactivate`): the statement-connections
  gates exactly — `statement.write` + firm scope (firm_admin/firm_staff;
  deliberately NOT client_user (SEC-03) nor the cross-tenant roles) plus
  `assertPartyAccess` on the named client. The **provider seam**
  (`provider.ts`, the payments/messaging transport idiom) is dark by
  default: with no `COLLECTION_PROVIDER_URL` the in-process simulator mints
  a `CA-…` reference and provisions nothing; setting the env lights a
  generic JSON relay (`COLLECTION_PROVIDER_TOKEN` rides as `x-op-token`, 5s
  timeout) that owns the real bank/PSP conversation and answers
  `{accountReference}`. **Fail closed on a broken relay** (502, no row): an
  account that does not exist provider-side must never be stored — no
  payment could reach it, and the dead row would shadow the client's real
  account on retry. Deactivation is an idempotent CAS on `active` — the
  webhook stops resolving the reference, the row stays as provenance. The
  console's client drill-down carries the Collection accounts card.
- **The inbound webhook** (`POST /api/collections/inbound`) is a machine
  rail deliberately OFF the OpenAPI contract — no generated SDK grows a way
  to mark invoices settled. **FAIL-CLOSED** (the inbound-rail stance, the
  opposite of `METRICS_TOKEN`'s open-when-unset default): this endpoint
  settles money state on the word of an unauthenticated caller, so with
  `COLLECTION_WEBHOOK_TOKEN` unset the rail does not exist — every request
  404s exactly like an unknown route. Set, the shared secret IS the
  credential (constant-time compare via `lib/op-token.ts`, `x-op-token` or
  `?token=`). The route answers **202 either way**: an unknown or
  deactivated reference — or an unmatchable invoice number — all look
  identical, so a caller holding the secret still cannot probe which
  references are live (an unmatched payment on a LIVE account additionally
  lands a pointer-only `collections.unmatched` audit for the operator; an
  unknown reference stays silent).
- **Settlement semantics** (`recordInboundCollection`, a `NO_CONTEXT_ROUTES`
  path running its own short bypass transaction — event + CAS + lifecycle +
  audit commit before the 202 goes out): the payment binds by the account's
  own firm + client as SUPPLIER + the quoted invoice number, `kind=invoice`
  only, status ∈ submitted/stamped/confirmed — a stranger's coincidental
  number can never settle cross-tenant, and credit notes are never targets.
  Every delivery appends one `collection_account` settlement event (a
  replayed webhook records again — evidence, never an update; `actorId`
  null marks the machine observer). The status transition is the buyer
  paid-flag branch exactly: **CAS to `settled`** only where the lifecycle
  allows (stamped/confirmed; a `submitted` receivable records the event
  only, and a concurrent cancel/credit wins — the event stands as lineage,
  the transition is skipped). Pointer-only audit; the settlement event
  itself carries the figures for whoever is entitled to read them.

## VAT position & FX

The client's month in one number pair — output VAT from issued documents vs
input VAT from captured supplier bills, with the verified split that makes
the "defensible" net honest (`modules/invoice/vat-position.ts`,
`routes/vat-position.ts`; deterministic SQL, computed on demand, nothing
stored).

- **Surfaces & gates.** `GET /vat-position` + `GET /vat-position/export`
  (CSV): `invoice.read` + `resolveClientAnalyticsScope` (SEC-03 — a
  client_user is pinned to its own party, a firm principal names the
  client); the SME app's **VAT** page renders the payload.
  `GET /console/vat-positions` (firm rollup, one row per open/in-progress
  engaged client + totals summed FROM the rows so the total line can never
  disagree with its column): `console.portfolio.read` + firm scope — a
  client_user must never see sibling clients' figures; console portfolio
  card. **Live-month discipline**: the requestable months are the last 12
  Lagos months INCLUDING the current one (a position is a running
  month-to-date number — unlike the closed-month VAT pack), one option list
  shared with the compliance pack.
- **Output basis mirrors the VAT pack** (`acceptedMonthDocsSql` mirrors
  `computeVatPack`'s predicate for predicate): Lagos issue-month bucketing,
  only documents with an accepted submission attempt, credit notes netted
  as offsets, cancelled documents excluded — the position and the pack can
  never disagree about "accepted in the month".
- **Input side is the captured bills** (`BILL_ORIENTATION`): bills stay
  draft forever and never touch the rails, so no accepted-attempt basis
  EXISTS for them — every non-cancelled bill issued in the month counts,
  paid or not (input VAT hangs on the bill, not on payment evidence). The
  **verified split** takes each bill's NEWEST `bill_verifications` result
  (the same "newest check wins" ordering as the bills ledger), and
  `defensibleNetVat` deducts verified input only — the number a partner can
  stand behind in an inspection.
- **FX capture** (`invoices.fx_rate_to_ngn`, contract 0.45.0):
  `fxRateToNgn` — NGN per one unit of the document currency — is captured
  at create (foreign-currency documents only; a rate on an NGN invoice is
  refused, since converters treat null as "already naira" and a stored rate
  would double-convert; positive, ≤6 decimals, validated before the insert)
  and editable via PATCH while content is still mutable (null clears it —
  e.g. the currency was corrected to NGN; like any content edit, this
  revokes live approvals). The SME invoice form shows the currency picker
  and — for foreign currencies — the exchange-rate field.
- **excludedForFx honesty.** Every position amount is NGN: non-NGN
  documents convert at their captured rate, and a non-NGN document WITHOUT
  a rate is excluded from every total and every count except
  `excludedForFx` — **a rate of 1 is never assumed**. The disclosure note
  stating the whole basis travels with every surface (API, SME page, and as
  a trailing row in the CSV so the caveats can't be separated from the
  file); the CSV's per-document `vatNgn` is the SIGNED contribution (credit
  notes negative, blank when FX-excluded), so each side's column sums to
  its total. The invoices CSV export (`GET /invoices/export`) gained
  APPENDED `fxRateToNgn` / `ngnEquivalent` columns on the same rule — an
  honest blank for unconvertible rows, never an assumed 1.0.

## Filing Desk (the statutory returns register)

The register of the returns themselves (Phase 1, contract 0.67.0): one
`filing_returns` row per client × tax type × period, minted
DETERMINISTICALLY from the statutory calendar and walked `upcoming →
prepared → filed` by the firm. Evidence-only posture throughout — the
platform records that a return was prepared and filed (filed date + the
authority's acknowledgment reference, e.g. a TaxPro-Max receipt number);
it never files anything with an authority itself.

- **The statutory calendar has ONE home**:
  `modules/filings/statutory-calendar.ts` — VAT due the 21st of the month
  after the period (FIRS), PAYE the 10th (introduced here; the date
  existed nowhere in code before this round). A return covers a CLOSED
  Lagos month: in August the register carries July's rows. The VAT 21st
  is still open-coded in three older surfaces (sme.ts deadlines, the
  compliance calendar, the pack's nextVatReturnDue) — folding them onto
  this module is a noted follow-up.
- **Minting is deterministic and idempotent**: the natural unique key
  (firm, client, tax type, period) is the cross-instance gate (the
  recurring materializer's discipline); the hourly sweep enumerates firms
  with live engagements under an advisory lock, and `POST /filings/sync`
  (filing.write) mints on demand — onboarding's "my register is empty"
  answer and the e2e trigger. Rows are never created by hand: the
  register's completeness is its value.
- **Lifecycle is forward-only** (`POST /filings/{id}/status`): backward
  transitions 409; marking `filed` requires the filed date (reference
  optional — authority formats vary); `prepared` rejects evidence fields.
  Pointer-only audit per transition. "Late" is a derived predicate (due
  date passed while unfiled), never a stored status.
- **Authz**: `filing.read` firm-wide for staff, SEC-03-narrowed for a
  client_user (own rows only), read for operators/auditors;
  `filing.write` is firm staff work. The detail loader carries the 404
  non-disclosure dance (the obligations posture).
- **Surfaces**: console client-detail carries the filings card (status
  walk + filed-evidence capture); the SME app's `/filings` page is the
  client's read-only view. `countOpenFilings` is THE single fact function
  (the countOpenObligations pattern) for the digest / month-end /
  compliance-pack integrations planned as Phase 2+.

## Monthly compliance pack

One client's Lagos month as a single branded PDF
(`modules/invoice/compliance-pack.ts` computes the facts,
`pack-pdf.ts` renders, `routes/compliance-pack.ts`): cover note, document
register (every document the client put a number on, drafts and failures
included — 200-row cap with a cap+1 truncation disclosure), receivables,
payables, the VAT position, and deadlines (the next statutory VAT-return
21st plus the client's unsubmitted-receivable backlog). Every section
reuses the module that already owns its numbers (receivables.ts,
payables.ts, vat-position.ts), so the pack can never disagree with the
dashboards it summarizes; month discipline and scope gates are the VAT
position's exactly (`invoice.read` + `resolveClientAnalyticsScope`,
live-month option list). The only model touch is the cover-note phrasing
(`modules/clerk/pack-note.ts`, purpose `draft_pack_note` — digest posture,
template always answers; see `docs/clerk-ai.md` § Reports); whitelabel
theming follows the invoice-PDF fallback rule. `POST
/compliance-pack/notify` (`console.portfolio.read` + firm scope +
`assertPartyAccess` — firm-side only, a client does not notify itself)
answers **202 unconditionally**: consent (CORE-03) is enforced INSIDE
`fanOutAlert` and the message is pointer-only (SEC-12 — a template key and
opaque refs, never a month or an amount), so the endpoint can never be used
as a consent oracle; the ask itself is audited pointer-only
(`pack.notify`). The console's client drill-down carries the pack card
(month picker, PDF download, "Notify client").

## Billing, PDF & exports

- **Branded invoice PDF** (`modules/invoice/pdf.ts`,
  `GET /invoices/{id}/pdf`, `invoice.read` + the invoice read's
  tenant/SEC-03 gates via `loadForTenant`): the client-facing paper for an
  invoice the platform already holds — firm whitelabel branding from
  `firms.theme` (brandName / primary HSL triple / logoInitials, same
  defaults as the console whitelabel page; a malformed theme falls back and
  can never break rendering), supplier/buyer identity, the line table and
  totals, and (when the invoice cleared the rails) the stamp reference with
  a verify QR — the QR encodes the rail-issued `qrPayload` (canonical),
  falling back to an IRN/CSID `/verify-stamp` reference for legacy rows.
  **Byte-deterministic** by construction: pdfkit's only nondeterministic
  input is `info.CreationDate`, pinned to the invoice's own `updatedAt`, so
  the same spine rows always yield byte-identical output (the trailer file
  ID is an md5 of the info dictionary and inherits the pin). Rendering is
  pure — no DB access — so the route owns loading and every tenancy gate.
- **Monthly platform-billing statement**
  (`modules/invoice/billing-statement.ts`, `GET /billing/statement` + CSV at
  `GET /billing/statement/export`, `console.portfolio.read` + firm scope,
  card on the console portfolio page): what MeridianIQ's own bill for a
  closed month is made of, shown to the firm that pays it — the vat-pack
  posture exactly (deterministic, computed on demand, nothing stored, month
  from the closed-Lagos-months option list). Two meters, two calendars —
  and the statement's note says so: invoice volume counts accepted invoices
  by the **Lagos** issue month with an accepted submission attempt
  (vat-pack's predicate, so billing can never disagree with the filing
  surfaces) plus the month's submission-attempt traffic; Clerk tokens are
  metered over the **UTC** month — deliberately NOT Lagos, because it is
  the SAME boundary budget.ts enforces the allowance on, and a different
  window would "prove" the 429 gate wrong at every month edge. The fee is
  tier config applied to the accepted count: base subscription +
  max(0, accepted − included) × overage price, 2dp numeric strings (kobo);
  `clerkMonthlyTokens: null` means the platform default allowance
  (`CLERK_FIRM_MONTHLY_TOKENS`) applies. The CSV carries the
  Lagos-vs-UTC disclosure note WITH the file. Distinct from the
  pre-existing revenue-share statements (`GET /billing/statements`, plural,
  console → Statements page).
- **Full-firm portability export** (`modules/audit/firm-export.ts`,
  `GET /firms/{id}/export`, `audit.export` capability + a hard
  operator/auditor role pin so a future capability grant to a firm role
  cannot silently open a cross-tenant bundle; runs in the RLS-bypass
  context): one deterministic bundle of everything the platform holds FOR a
  firm — the offboarding/regulator/acquirer answer to "give us our data".
  Section discipline: parties are the firm's SPHERE
  (`firmPartySphereCondition`); statements ride as summary rows only (raw
  `bank_statement_lines` deliberately omitted); members carry identity +
  role only — NEVER password hashes, TOTP secrets/recovery codes, or
  session epochs; audit_events are only the rows whose `firm_id` names this
  firm. Every section is capped (`EXPORT_SECTION_ROW_CAP` = 10,000, cap+1
  probe) and reports rows + a truncated flag in `counts`, so a partial
  bundle is always visibly partial. Read-only; the route audits the export
  action itself (pointer-only, row counts never content) AFTER assembling
  the bundle so an export never contains its own event.
- Other export surfaces follow the same CSV-attachment idiom: invoice list
  (`GET /invoices/export`), VAT pack (`GET /vat-pack/export`), receivables
  (`GET /dashboard/receivables/export`), audit trail (`GET /audit/export` +
  `/audit/export/csv`).

## Client lifecycle (NDPA)

The data-subject lifecycle for one client party (`routes/clients.ts`),
designed around one constraint: **parties are the SHARED SPINE** (no tenant
key, no RLS, one party may be engaged by several firms), so lifecycle
actions are firm-scoped relationship changes, never party mutations.

- **Creation** (`POST /clients`, `engagement.write` + `party.write`, the
  console's Add-client dialog): one party (through `createParty` —
  provenance + `party.create` audit) plus the retainer engagement that
  places the client inside the firm's tenant boundary, in a single commit.
  A duplicate guard (normalized TIN, then exact legal name) is scoped to
  THIS firm's engaged clients only — an unscoped lookup over the shared
  spine would be a cross-tenant oracle for harvesting other firms' rosters;
  a TIN that exists elsewhere simply creates a new party here, and the
  operator merge workflow (CORE-08) reconciles duplicates with lineage.
- **Data-subject export** (`modules/audit/client-export.ts`,
  `GET /clients/{id}/export` — the client's own account, its engaging firm,
  or an operator/auditor): the per-client sibling of the firm export — one
  deterministic, read-only bundle of everything the platform holds ABOUT
  one party, sectioned (the party row whole — legal name/TIN/CAC *are* the
  subject's data; consent records; the party's own alert-preferences
  contact row; supplier-side invoices + lines; engagements; statement
  summary rows only — raw bank lines omitted; memberships as identity +
  role only, never hashes/TOTP secrets/session epochs; party-entity audit
  events). A **tenant lens** does the tenancy in app code (the module reads
  on the base client): firm callers get only their own firm's slice of
  every firm-keyed section; the data subject and cross-tenant staff get all
  engaging firms — which is what a data-subject access request means. Every
  section is capped (cap+1 probe) with rows + a `truncated` flag in
  `counts`; the export action itself is audited pointer-only AFTER
  assembly. The SME app's consent page surfaces it as "Download my data".
- **Offboarding** (`modules/party/offboard.ts`,
  `POST /clients/{id}/offboard`, explicit `firm_admin` role — the
  integrations-route precedent — plus a typed-back `confirmLegalName`
  guard): a FIRM-SCOPED teardown, never a deletion. The party's statutory
  identity (legal name, TIN, CAC) is retained under the legal-obligation
  basis (FIRS record-keeping — the same retention wall that makes invoice
  rows immutable); what goes is exactly the firm's relationship surface:
  engagements → `archived` (still present, so retention-era reads keep
  passing `assertPartyAccess`), the firm's client_user memberships →
  deleted, its party-name aliases → deleted, pending invitations → revoked
  (CAS). **Last-engagement rule:** the party-keyed contact PII
  (alert-preferences channels/addresses, push devices) is shared across
  engaging firms, so it is cleared ONLY when no other firm still holds a
  non-archived engagement — that one cross-tenant existence bit is probed
  on the base client (firm-keyed RLS would otherwise always answer "last")
  and returned as `lastEngagement`. Consent records are CLIENT-owned
  (CORE-03) and never touched. The result body reports exactly what
  happened (`engagementsArchived`, `membershipsRemoved`, `aliasesDeleted`,
  `contactCleared`, `lastEngagement`), and the action is audited
  pointer-only.

## Integration layer (payments, API keys, webhooks)

- **Payment collection** (`modules/billing/payments.ts`, `routes/billing-payments.ts`,
  migration 0021, `console.portfolio.read` + firm scope): a firm records a
  payment intent against a CLOSED billing month — the amount is the shared
  billing fee core (so an intent can never disagree with the statement), a
  partial unique index `(firm_id, month_start) WHERE status IN
  ('pending','confirmed')` enforces one live intent per month (409),
  zero-fee months refuse (400). The provider is an injectable
  `PaymentProvider` (the push/messaging transport idiom): the simulator is
  the default, `PAYMENT_PROVIDER_URL`/`_TOKEN` light a JSON relay that may
  return a `checkoutUrl`. Confirmation is a machine rail deliberately OFF
  the contract (`POST /api/billing/payments/confirm`, fail-closed
  `PAYMENT_WEBHOOK_TOKEN`, 404 while unset): a CAS `pending → confirmed |
  failed` transition, idempotent on replay, pointer-only audit. Subscription
  paid-through state stays operator-managed — payments record intent, they
  do not mutate entitlement.
- **Firm API keys** (`modules/integrations/api-keys.ts`, migration 0022,
  `firm_admin` only): `mk_<prefix>_<secret>` minted once, only its sha256
  stored. An `Authorization: Bearer mk_…` header resolves in
  `middleware/principal.ts` BEFORE any cookie/session path (constant-time
  compare, revoked/unknown → 401) to a firm-pinned MACHINE principal whose
  capabilities are EXACTLY the key's — from a vetted allowlist
  (`invoice.read`, `invoice.write`, `statement.write`; never `clerk.*`,
  identity, billing or `invoice.submit`), enforced by an additive
  short-circuit in `can()`. The machine principal is not in `BYPASS_ROLES`
  (tenant RLS applies), is rate-limited under `apikey:<id>`, and cannot mint
  keys (no self-propagation). `lastUsedAt` is a best-effort raw-pool write
  throttled to once/min.
- **Outbound webhooks** (`modules/integrations/webhooks.ts`, same migration,
  `firm_admin`): a closed event catalog (`invoice.stamped`, `invoice.settled`,
  `statement.reconciled`) fanned out set-based from the append-only
  lifecycle/audit ledgers into `firm_webhook_deliveries` (idempotent via a
  `(webhook_id, event_key)` dedup index, events newer than the subscription
  only). A `registerSweep` dispatcher drains pending deliveries with a
  pre-charged claim (`FOR UPDATE SKIP LOCKED`, attempts + backoff advanced
  before network I/O), a 5s `AbortSignal` timeout, `redirect: "manual"` +
  https/public-host SSRF guards, a pointer-only body (SEC-12) and an
  `X-Meridian-Signature` HMAC-SHA256 keyed by the sha256 of the shown-once
  `whsec_` secret; five failures dead-letter the delivery. Per-firm delivery
  logs are the firm's own audit of what left, and a dead delivery can be
  re-queued for a fresh attempt cycle
  (`POST /firm-webhooks/{id}/deliveries/{deliveryId}/retry`, firm_admin): a
  compare-and-set on `status='dead'` resets attempts/backoff so only a
  genuinely given-up delivery ever re-enters the queue (retrying a
  pending/delivered row is a 409, as is a disabled endpoint — the console's
  Deliveries view carries the Retry button).
- **Operator health visibility** (`modules/desk/health-watch.ts`,
  `routes/operator.ts`): the ops sibling of the Clerk watch trio — an
  `atMostHourly` sweep over three degraded conditions the platform already
  records but nobody was paged about: a rail circuit breaker stuck open
  (keyed per outage instance — `rail:openedAt` — so a recover-and-retrip is
  a new alert while a long outage stays one), dead-lettered outbox events,
  and firm webhook deliveries that exhausted their retries (this one stamps
  the owning `firmId` on the alert row). Zero model calls, no automatic
  remediation — replay/close stay operator judgements on the Desk. Alert
  discipline is `alertOnceViaAuditLedger`: the append-only audit ledger's
  `(action, entityId)` pair IS the cross-instance dedup key, so an alert is
  durable, deduplicated and readable back without a second alert table —
  `GET /operator/health-alerts` (operator/auditor) is exactly that
  ledger-backed read, and the Desk's Platform ops page renders it as the
  health-alerts card. NEW alerts are additionally OFFERED to operators over
  the messaging rail (`platform_health` template, recipient identity = the
  operator's own userId, entity pointer names only the alert KIND):
  best-effort and gated on `messaging_notifications` — the audit alert is
  the source of truth, a lost nudge is never a lost alert.
  `GET /operator/rail-config` rounds out the visibility: which env-lit rails
  (inbound email/WhatsApp, the messaging relay, payment provider +
  confirmation webhook, the metrics token) are configured on this
  deployment — presence booleans ONLY, never values, so the Desk's
  rail-configuration card can say "this rail is dark" without becoming a
  secrets oracle.
- **Notification read-state & retention**: the feed carries `read` /
  `unreadCount` computed under the same recipient-identity predicate that is
  the inbox's isolation wall; `POST /notifications/mark-read` is an
  inclusive-boundary update over the caller's own rows. The messages ledger
  now has its first retention sweep (`MESSAGES_RETENTION_DAYS`, default 180,
  bounded 1000-row batches, hourly) — pointer-only rows, so age is the only
  criterion.

## Web & mobile surfaces

- **Console IA** (`console/src/components/layout.tsx`): the sidebar renders
  three capability-gated groups — **Practice** (Portfolio, Onboarding,
  Client import, Advisory, Team invitations, Integrations), **Growth &
  revenue** (Plans & billing, Statements, Unearned income, White-label,
  Certification) and **Platform** (Operator queue, Party integrity, Error
  catalogue, Platform ops, Gate metrics, Feature flags, Audit & evidence,
  Claims register, Clerk). Every link maps to the RBAC capability its API
  surface requires; groups render only when they contain at least one
  visible link, so each role sees only its own workspace. Clerk pages
  render outside this layout in their own full-bleed shell
  (`clerk-shell.tsx`) with four rail tabs: Intake queue / Claims / Ask
  Clerk / Health.
- **Mobile** (`artifacts/mobile`, Expo Router): companion screens include
  Ask Clerk (`app/clerk-ask.tsx`, with the "Speak it" voice card) and the
  updates screen (`app/clerk-updates.tsx` — firm digest + client monthly
  statements); push notifications deep-link via `routeForTemplate`
  (`lib/notifications.ts`), and the SME error-focus mapping is mirrored on
  mobile.

## Observability

- `GET /api/healthz` — liveness (no DB touch) + contract version.
- `GET /api/readyz` — readiness (`SELECT 1`); 503 if the DB is unreachable.
- `GET /api/metrics` — Prometheus text: request-duration histogram
  (method/route/status, id segments collapsed), process health (event-loop
  lag, RSS, heap, uptime), and sweep liveness
  (`meridian_sweep_last_success_*`). Hand-rolled in `lib/metrics.ts` (a
  metrics lib would fork drizzle via `@opentelemetry/api`).
- `/api/metrics` and `/api/internal/sweep` are public by default; setting
  `METRICS_TOKEN` / `SWEEP_TOKEN` closes the endpoint behind that shared
  secret (`x-op-token` header or `?token=`, `lib/op-token.ts`). Opt-in:
  unset env keeps today's open behaviour.

## Backups, restore drills & releases

Three node-builtin-only tools live in `scripts/src/ops/` (they need node plus
the Postgres client binaries — `pg_dump`/`pg_restore`/`psql` — and nothing
else, so they run on a bare cron runner). All three take the target from
`DATABASE_URL`, which must be a role that can bypass RLS
(superuser/`BYPASSRLS`): several tables `FORCE ROW LEVEL SECURITY`, so
`pg_dump` under a lesser role fails closed — better than a silently partial
backup.

- **Backup** — `DATABASE_URL=… pnpm --filter @workspace/scripts run ops:backup`.
  Dumps `--format=custom` to `BACKUP_DIR` (default `./backups`) as
  `meridian-<UTC stamp>.dump`, verifies the archive with `pg_restore --list`
  (an unlistable archive is deleted, not kept), writes a `sha256sum -c`-
  compatible `.sha256`, then prunes to the newest `BACKUP_KEEP` (default 14)
  dumps. Run it OUTSIDE the app's failure domain (cron on the DB host or a
  separate runner) and **copy dumps off-box** — a backup beside its database
  shares its fate.
- **Restore drill** — `DATABASE_URL=<source> DRILL_DATABASE_URL=<scratch>
  pnpm --filter @workspace/scripts run ops:restore-drill`. Dumps the source,
  checks the sha256 round-trip, **drops and recreates** the drill target
  (maintenance connection derived from the drill URL, or `DRILL_ADMIN_URL`),
  restores with `--exit-on-error`, then asserts: `_schema_migrations`
  count/max match the source; row counts of `invoices`, `audit_events`,
  `clerk_action_decisions` match; the restored `invoices` still has RLS
  enabled **and forced** with >0 policies (pg_restore carries policies —
  this proves it every run). Prints PASS/FAIL per assertion plus dump/restore
  timings. CI runs it on every merge against the CI database; run it
  per-release too — an untested backup is a hope, not a backup.
- **Release** — `DATABASE_URL=… pnpm --filter @workspace/scripts run
  ops:release -- --yes` (refuses without both; prints the redacted target
  first). Sequence: optional pre-flight dump (`RELEASE_BACKUP=1`) →
  `db run push` (`RELEASE_PUSH_FORCE=1` swaps in `push-force` for destructive
  diffs, where plain push prompts and hangs) → `db run migrate` → verify that
  `_schema_migrations` count/max equal the registry in
  `lib/db/src/migrations/index.ts` (parsed at runtime, so it can never go
  stale) and print the API contract version to compare against
  `/api/healthz` after the Redeploy. **The hazard this kills:** the guardrail
  RLS policies/triggers are not in the Drizzle schema, so a `push` can drop
  them and only `migrate` re-asserts them — run manually as two steps, the
  window between them (or a forgotten migrate) is a tenant-isolation hole.
  A failed step aborts and lists what did not run; push and migrate are both
  idempotent, so fix the cause and re-run to completion.

**Honest DR statement.** RPO = your backup cadence: the tool does not
schedule itself, so if you dump nightly you can lose a day. RTO = the restore
drill's measured shape (it prints dump/restore timings at the current data
volume; seconds on CI-sized data, scale accordingly). The audit-event hash
chain is contiguous *within* a snapshot: restoring rewinds the world to the
snapshot point, and events after it are **lost, not tampered with** — the
chain verifies clean up to its new tip and simply ends there, so absence
after a restore is expected and honest, not a break.
