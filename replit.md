# MeridianIQ

Nigeria-first e-invoicing compliance and verified-receivables platform: one data
spine serving SMEs, accountant firms and anchor buyers (Business Plan v3.2,
Roadmap R0–R2 built; R3+ dormant behind gates).

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (`PORT` is required and has no default — the server refuses to boot without it; the Replit artifact runner supplies it, localPort 8080 per `artifacts/api-server/.replit-artifact/artifact.toml`)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run test` — api-server suites (tsx --test; DB-backed — needs `DATABASE_URL` with the schema pushed and guardrail migrations applied)
- `pnpm --filter @workspace/db run test` — migration rollback test (needs DATABASE_URL)
- `pnpm --filter @workspace/api-server run benchmark [N]` — NFR-03 pipeline throughput evidence (needs DATABASE_URL)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `lib/api-spec/openapi.yaml` — the API contract, source of truth; codegen fills `lib/api-zod` (route validation) and `lib/api-client-react` (frontend hooks)
- `lib/db/src/schema/*.ts` — one Drizzle file per domain, barrel-exported; `lib/db/src/migrations/` — versioned SQL guardrails (triggers, RLS) with reversible down + rollback test
- `artifacts/api-server/src/modules/<domain>/` — domain logic; `src/routes/<tag>.ts` — HTTP surface registered in `routes/index.ts`
- Key R2 modules: `modules/statements` (INT-05 parser abstraction + ingestion), `modules/reconciliation` (SME-07 matcher), `modules/buyer` (BR-01/05 exposure + scoreboard), `modules/b2c` (SME-08 clocks), `modules/connectors` (PL-03 contract + SagePro/QuickLite)
- Auth: `modules/auth/session.ts` (scrypt passwords + HMAC cookie session), `routes/auth.ts` (login/logout), `middleware/principal.ts` (resolves dev headers → session cookie → Clerk)
- Frontends (path-routed, one origin): `artifacts/landing` (public site at "/" + central login at "/login"), `artifacts/sme-compliance` (SME app, "/app/"), `artifacts/console` (accountant console + operator, "/console/"), `artifacts/buyer-portal` (Buyer Rails, "/buyer/"), `artifacts/penalty-calculator` (public static, "/penalty-calculator/")
- `artifacts/api-server/src/bootstrap/seed.ts` — flags (release-tagged), demo tenant, buyer principals, CPD content, demo passwords (`DEMO_PASSWORD = "meridian2027"` for every seeded user)

## Architecture decisions

- **Append-only invoice ledger**: lifecycle immutability begins at submission (CORE-02); state transitions append to `invoice_lifecycle_events`; DB triggers block UPDATE/DELETE on lifecycle tables. Reset demo data with `TRUNCATE ... CASCADE`, never DELETE.
- **State machine is code**: `modules/invoice/lifecycle.ts` TRANSITIONS map is the single source of truth; `settled` is reached only via settlement observation (statement match accept / buyer paid flag), `credited` only via a stamped credit note, and cancelled/credited invoices are never presentable as eligible (CORE-09) — `verify-stamp` reports `eligible` live.
- **Everything async goes through the transactional outbox** (`modules/pipeline`): submission, statement reconcile, ERP sync. Feature modules contribute handlers via `registerHandler` and periodic jobs via `registerSweep` (B2C clocks every minute, buyer exposure daily-window).
- **Tenancy**: firm-keyed RLS via per-request transactions and GUCs; `buyer_user` principals carry no firm and run RLS-bypassed with mandatory route-level `assertBuyerPartyAccess` scoping (same pattern as operator/auditor).
- **Release gating (PL-02)**: every R2 surface checks its flag (`reconciliation`, `b2c_reporting`, `buyer_rails`, `white_label`, `erp_connectors`) and 404s while dark; all five seed dark — flip via `PATCH /feature-flags/{key}` as operator.
- **External systems behind one interface**: APP rails (INT-01), bank-statement formats (INT-05 `StatementParser`), ERP systems (INT-06 `Connector`) — adding a bank/ERP is a new implementation, never a core change.

## Product

- Landing + portal: `/` is the public MeridianIQ site and links to the central portal at `/login`. Email+password sign-in sets an origin-wide session cookie; after sign-in the account is redirected to its role's default workspace (operator → console operator queue, firm roles → console/app, buyer → Buyer Rails) and the role-aware tiles cover the rest. Demo accounts sign in with one click; login errors surface the server message. Every app's sidebar shows the signed-in identity (from `/me`, which returns email/fullName) with "All apps" + "Sign out".
- SME app: guided invoicing, bulk import (5,000-row bulk path), submission + vault, deadline/penalty alerts, reconciliation upload with match proposals, B2C 24-hour report clocks, confirmation timeline.
- Accountant console: role-aware nav filtered by the principal's capabilities. Firm roles get portfolio risk, onboarding pipeline, unearned income, billing/revenue share, the Advisory toolkit (readiness assessments + VAT-risk checks, ADV-01/02) and ERP Integrations (behind the `erp_connectors` flag); R2 adds white-label branding + subdomain, bulk client import, CPD certification portal. The operator gets the queue (server stats incl. clients served, client-escalation context on cards), the Error catalogue editor with unmapped-code surfacing (ADV-03/INT-02), Platform ops (rail health, dead-letter replay, pipeline reconcile), Gate metrics (live R1/R2 gate measurements from the spine) and Feature flags; console `/` redirects operators to the queue. The auditor role gets read-only console access (Audit & evidence: chain verify + verifiable bundle export). Direct URL hits on pages a role lacks show a capability card, not raw 403s.
- Compliance Desk intake (SME-06/CON-04): client escalations and pipeline dead letters auto-open operator cases via `modules/desk/cases.ts` — one live case per invoice, repeat signals raise priority. CORE-09 is complete: `POST /invoices/{id}/credit-note` drafts+validates+submits a `credit_note` invoice; the pipeline credits the original when the note stamps, and verify-stamp reports it `eligible: false`.
- Party integrity (CORE-08) has an operator workbench (`/console/parties`): duplicate candidates by TIN/name, merge with lineage, split-back-out. Consent flows v1 (CORE-03) surface in the SME app (`/app/consent`): layer 1–2 grant/revoke as ledger events, layer 3 dormant; `firm_staff` holds `consent.read` only — writes stay with `client_user`/`firm_admin`. `GET /messages` (operator, behind `messaging_notifications`) feeds the delivery log on Platform ops.
- CI (`.github/workflows/ci.yml`): every PR runs typecheck, unit tests, a codegen-drift check, the migration rollback test against a service Postgres 16, all five frontend builds (incl. the penalty calculator), and the E2E job — `pnpm --filter @workspace/scripts run e2e` boots the built api-server + built frontends behind a path-router (`scripts/src/e2e/`) and drives 38 headless user-journey checks against a freshly seeded database. Locally it needs `DATABASE_URL` pointing at a scratch DB and the builds listed at the top of `run.mjs`.
- Auth hardening: `/auth/login` rate-limits per email+IP (5 failures / 15 min → 429) plus a looser per-account cap (50 / 60 min), persisted in the Postgres `login_attempts` table on the raw pool (`modules/auth/throttle.ts`) so the caps hold cluster-wide and survive the 4xx transaction rollback; stale rows are pruned by a registered sweep. `POST /auth/change-password` (current password required) with a form in the portal's signed-in panel; lost passwords are recovered via operator-issued one-time reset links (`POST /password-resets`, redeemed at the public `/auth/reset-password`). The INT-02 sweep (`modules/desk/sweeps.ts`, registered via routes/index.ts) opens one operator case per unmapped failure code, deduped by open case title.
- Buyer portal (`/buyer/`): confirmation queue and responses (method + no-set-off captured), payment flags, supplier verification with daily input-VAT exposure, exportable compliance scoreboard.
- Credit layer (R3+) remains dormant: schema exists, flags dark, no user-facing surface.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- Run `pnpm --filter @workspace/api-spec run codegen` after ANY change to `openapi.yaml`, then root `pnpm run typecheck`.
- lib/db and api-server modules use explicit `.ts` extensions on relative imports so `node --test` strip-mode works; keep new files consistent.
- The dev DB pool is lazy — the server fail-fasts via `requireDatabaseUrl()` at boot; pure-function tests import schema without a database. The pool sets `connectionTimeoutMillis` (10s) so an unreachable DB fails fast+logged instead of hanging startup forever.
- **Startup order (`api-server/src/index.ts`)**: `app.listen()` opens the port FIRST, before any DB work — the liveness probe `/api/healthz` never touches the DB, so the artifact promotes even while the DB warms up. Gating `listen()` behind DB writes is what previously failed prod Publish ("required port was never opened"). Migrations (`applyMigrations`) and `seedPlatform` run ONLY when `NODE_ENV !== "production"`; in production they are skipped (schema/data are owned by Publish, not the app).
- **Production DB provisioning**: prod schema is applied by Replit's Publish schema-diff, but the guardrails in `lib/db/src/migrations/` (RLS policies, append-only triggers, `NULLS NOT DISTINCT` index) are NOT in the Drizzle schema, so the diff won't create them on a fresh empty prod DB. Provision prod via Publish's "overwrite data" (dev→prod copy), which carries policies/triggers/functions wholesale. On boot, prod runs a read-only check that logs loudly (error level) if `meridian_tenant_isolation` / `meridian_append_only` are missing — watch the deploy logs for it.
- **`DEMO_PASSWORD` in prod**: `seedDemoPasswords` (dev-only now) sets the shared `"meridian2027"` on every user with a null hash. A prod DB copied from dev already carries the demo users with that known password — disable/rotate those accounts before real use.
- Identity resolution order (`middleware/principal.ts`): dev `x-mock-*` headers (never honoured in production) → first-party session cookie → Clerk (production). The browser apps send NO mock headers — they authenticate purely via the shared session cookie set by the portal login; automated tests/curl use `x-mock-*`. Clerk middleware mounts only when `CLERK_SECRET_KEY` is set.
- Path-routed origin: the landing artifact owns `/` and `/login`; its `public/sw.js` is a no-op self-healing worker that evicts the stale root service worker returning browsers cached when the SME app lived at `/`. Adding/moving an app at `/` needs the same self-heal, and any app-scoped service worker must not reach outside its own path prefix.
- `memberships` unique index is NULLS NOT DISTINCT — seed inserts dedupe correctly; extend the index if you add another scoping column.
- Login 401s with "Account has no active membership" for any user without a memberships row — every seeded demo user needs one (cross-tenant staff like the operator carry `firmId: null`; the demo auditor is bound to the demo firm so firm-scoped reads resolve).
- Demo accounts: staff/admin/ops/buyer plus `audit@meridianiq.example` (read-only auditor). Credit notes only submit for clients with complete party data + layer-1 consent — in the seed that's Adaeze Foods; other demo clients lack a street and fail UBL validation with a named field.
- express JSON body limit is 8mb (5,000-row imports, statement uploads).
- **Overnight alerts on Autoscale**: the published API runs on Autoscale, which scales to zero when idle — freezing the in-process timers (outbox drain, reconcile, 1-minute B2C sweep that fires SME-08 pre-breach alerts). `GET /api/internal/sweep` is a public, idempotent wake-up trigger that runs one full timer pass synchronously (see `routes/sweep.ts`). It must be pinged every ~5 minutes by an external scheduler: create a **Replit Scheduled Deployment** (separate lightweight Replit app; one repl = one deployment, so it can't live in this repl) with schedule "every 5 minutes" and command `curl -fsS --max-time 120 --retry 3 --retry-delay 5 --retry-all-errors https://meridian-iq.replit.app/api/internal/sweep` (or run `scripts/sweep-ping.sh`). Without it, pre-breach alerts do not fire while nobody is using the app. The trigger (and `/api/metrics`) can optionally be closed behind a shared secret by setting `SWEEP_TOKEN` / `METRICS_TOKEN` (callers then pass `x-op-token` or `?token=`; see `lib/op-token.ts`) — unset, both stay public, so the current deployment and scheduler need no change.
- See `.agents/memory/` for DB guardrails, RBAC, artifact base-path and service-worker invariants.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
- Requirement IDs in code comments (CORE-xx, SME-xx, BR-xx, PL-xx, INT-xx, NFR-xx, SEC-xx) refer to the MeridianIQ Technical Requirements Document v1.1
- `docs/USER_MANUAL.md` — the end-user manual: every workspace, role, flow, flag, lifecycle state, plus admin/runbook, troubleshooting and glossary
