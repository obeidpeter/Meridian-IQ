# MeridianIQ

Nigeria-first e-invoicing compliance and verified-receivables platform: one data
spine serving SMEs, accountant firms and anchor buyers (Business Plan v3.2,
Roadmap R0–R2 built; R3+ dormant behind gates).

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run test` — api-server unit suites (node --test, no DB needed)
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
- Frontends (path-routed, one origin): `artifacts/landing` (portal + central login, "/"), `artifacts/sme-compliance` (SME app, "/app/"), `artifacts/console` (accountant console + operator, "/console/"), `artifacts/buyer-portal` (Buyer Rails, "/buyer/"), `artifacts/penalty-calculator` (public static, "/penalty-calculator/")
- `artifacts/api-server/src/bootstrap/seed.ts` — flags (release-tagged), demo tenant, buyer principals, CPD content, demo passwords (`DEMO_PASSWORD = "meridian2027"` for every seeded user)

## Architecture decisions

- **Append-only invoice ledger**: lifecycle immutability begins at submission (CORE-02); state transitions append to `invoice_lifecycle_events`; DB triggers block UPDATE/DELETE on lifecycle tables. Reset demo data with `TRUNCATE ... CASCADE`, never DELETE.
- **State machine is code**: `modules/invoice/lifecycle.ts` TRANSITIONS map is the single source of truth; `settled` is reached only via settlement observation (statement match accept / buyer paid flag), `credited` only via a stamped credit note, and cancelled/credited invoices are never presentable as eligible (CORE-09) — `verify-stamp` reports `eligible` live.
- **Everything async goes through the transactional outbox** (`modules/pipeline`): submission, statement reconcile, ERP sync. Feature modules contribute handlers via `registerHandler` and periodic jobs via `registerSweep` (B2C clocks every minute, buyer exposure daily-window).
- **Tenancy**: firm-keyed RLS via per-request transactions and GUCs; `buyer_user` principals carry no firm and run RLS-bypassed with mandatory route-level `assertBuyerPartyAccess` scoping (same pattern as operator/auditor).
- **Release gating (PL-02)**: every R2 surface checks its flag (`reconciliation`, `b2c_reporting`, `buyer_rails`, `white_label`, `erp_connectors`) and 404s while dark; all five seed dark — flip via `PATCH /feature-flags/{key}` as operator.
- **External systems behind one interface**: APP rails (INT-01), bank-statement formats (INT-05 `StatementParser`), ERP systems (INT-06 `Connector`) — adding a bank/ERP is a new implementation, never a core change.

## Product

- Portal (`/`): the front door. Central email+password sign-in sets an origin-wide session cookie, then role-aware tiles route to each workspace (Compliance App, Console, Buyer Rails) or straight into the public Penalty Calculator. One sign-in unlocks every workspace the account's role allows.
- SME app: guided invoicing, bulk import (5,000-row bulk path), submission + vault, deadline/penalty alerts, reconciliation upload with match proposals, B2C 24-hour report clocks, confirmation timeline.
- Accountant console: portfolio risk, onboarding pipeline, unearned income, billing/revenue share, operator queue; R2 adds white-label branding + subdomain, bulk client import, CPD certification portal.
- Buyer portal (`/buyer/`): confirmation queue and responses (method + no-set-off captured), payment flags, supplier verification with daily input-VAT exposure, exportable compliance scoreboard.
- Credit layer (R3+) remains dormant: schema exists, flags dark, no user-facing surface.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- Run `pnpm --filter @workspace/api-spec run codegen` after ANY change to `openapi.yaml`, then root `pnpm run typecheck`.
- lib/db and api-server modules use explicit `.ts` extensions on relative imports so `node --test` strip-mode works; keep new files consistent.
- The dev DB pool is lazy — the server fail-fasts via `requireDatabaseUrl()` at boot; pure-function tests import schema without a database.
- Identity resolution order (`middleware/principal.ts`): dev `x-mock-*` headers (never honoured in production) → first-party session cookie → Clerk (production). The browser apps send NO mock headers — they authenticate purely via the shared session cookie set by the portal login; automated tests/curl use `x-mock-*`. Clerk middleware mounts only when `CLERK_SECRET_KEY` is set.
- Path-routed origin: the portal owns `/` and its `public/sw.js` is a no-op self-healing worker that evicts the stale root service worker returning browsers cached when the SME app lived at `/`. Adding/moving an app at `/` needs the same self-heal, and any app-scoped service worker must not reach outside its own path prefix.
- `memberships` unique index is NULLS NOT DISTINCT — seed inserts dedupe correctly; extend the index if you add another scoping column.
- express JSON body limit is 8mb (5,000-row imports, statement uploads).
- See `.agents/memory/` for DB guardrails, RBAC, artifact base-path and service-worker invariants.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
- Requirement IDs in code comments (CORE-xx, SME-xx, BR-xx, PL-xx, INT-xx, NFR-xx, SEC-xx) refer to the MeridianIQ Technical Requirements Document v1.1
