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
contract change (it is currently `0.16.0`).

## Clerk AI (the part with guardrails)

Clerk never files anything: extraction proposes, a human disposes, approval
creates a DRAFT invoice. Every model call flows through
`modules/clerk/gateway.ts` (kill switch `clerk_ai`, append-only inference
ledger, schema-validated output, fail closed). Client-facing surfaces
(`clerk.capture` on all firm roles, `clerk.ask` on firm_admin/staff) are pinned
to their firm by route filters plus migration 0009's firm-keyed RLS, and are
capped by a per-firm monthly TOKEN budget (`modules/clerk/budget.ts`; tier
override `billing_tiers.clerk_monthly_tokens`, default
`CLERK_FIRM_MONTHLY_TOKENS` env, ledger is the spend counter — routes check
the budget BEFORE touching the provider so 429s are clean, and the gateway
enforces it again as a backstop no call site can forget). The gateway writes
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
to an error. The power pack keeps the same grounding split: **pre-flight**
(`modules/clerk/preflight.ts`) is pure model-free validation stored on the
case at extraction time (empty list = review fast lane); **scanned-PDF
intake** (`rasterizePdfScan` in `modules/clerk/cases.ts`) renders a textless
PDF's pages (max 4) to images and walks the ordinary vision-extraction path —
pages are stored on the case for retry (`source_scan_pages_b64`, purged by the
content-retention sweep, stripped from API responses) and text detection
relies on `pageJoiner: ""` (pdf-parse's page markers otherwise make every scan
look like it "has text"); **batch intake**
(`modules/clerk/batch.ts`) stays text-only and only proposes segment
boundaries — every segment then walks the normal capture path; the **weekly digest**
(`modules/clerk/digest.ts`, opt-in `clerk_digest` flag, sweep-generated,
firm-keyed RLS via migration 0011) computes every fact in SQL and lets the
model phrase them, falling back to deterministic template text; **claims
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
(`modules/clerk/draft-invoice.ts`, `clerk.capture`) turns one sentence into a
prefilled SME draft form — every extracted value re-validated/normalised by
the app, buyer identity a deterministic register suggestion, nothing stored
(the client saves through the ordinary `createDraft` path). **Escalation triage**
(`modules/desk/triage.ts`, opt-in `clerk_triage` flag, sweep-driven so the
client's escalation never waits on a model call) proposes routing — closed
category set, priority, catalogue code re-verified against the codes that
exist — stored on the operator case for the operator to accept or override,
never applied automatically. **Grounded firm-data Q&A**
(`modules/clerk/data-intents.ts`): Ask Clerk carries a second closed catalogue
next to the claims register — data intents ("what's overdue?", "what did we
submit this month?"), offered in the intent enum only to firm-scoped askers.
The model still only classifies; the app runs the matching FIXED,
fully-parameterized query (the only runtime input is the principal-resolved
firmId) inside `inClerkScope(firmId)` plus an explicit firm filter, and
assembles the answer deterministically (`answer.dataIntent` marks these).
Predicates mirror digest/compliance-window (Lagos calendar), so Ask can never
disagree with the dashboards. Clerk health (console) includes a
confidence-calibration table (`computeCalibration` in
`modules/clerk/metrics.ts`): kept-rate vs model confidence per band, from the
corrections exhaust.

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
weekly-digest / escalation-triage sweeps). Register new periodic work with `registerSweep(fn)`.
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
