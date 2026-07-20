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
  `routes/invoices.ts` / `routes/engagements.ts`.
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
periodic work with `registerSweep(fn)`. The current sweep inventory (grep
`registerSweep(` for the authoritative list): deadline reminders, recurring
invoices, B2C pre-breach alerts, buyer exposure refresh, push receipts,
login-attempt / password-reset cleanup, outbox + stamp-verification
retention, unmapped-code desk cases, escalation triage, and the Clerk
sweeps — watchdog (stuck pending cases, expired claims, expired case
content), eval growth, red-team growth, async batches, weekly digest
(generation + delivery), per-client statements (generation + delivery),
resistance watch, spend watch and quality watch (the last three wrapped
`atMostHourly`).

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
  gate); operator/auditor/bank/buyer roles get an empty feed (no send rail
  stamps identities for them). Rows STAY pointer-only in
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
  logs are the firm's own audit of what left.
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
