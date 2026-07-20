# MeridianIQ — engineering guide

Nigeria-first e-invoicing **compliance** platform: accounting firms and their
SME clients prepare, validate, stamp (via FIRS/MBS rails), and reconcile
invoices, with an operator "Compliance Desk" and an AI intake assistant
("Clerk"). This file is the lean index — the deep references are
`docs/clerk-ai.md` (the AI assistant) and `docs/platform.md` (tenancy, auth,
background work, rails, exports).

## Monorepo layout (pnpm workspaces)

```
artifacts/
  api-server        Express 5 + Drizzle + Postgres 16 — the data spine & rails
  console           Firm/operator/auditor web app (React + Vite + wouter)
  sme-compliance    SME client web app  ("/app")
  buyer-portal      Buyer Rails web app  ("/buyer")
  landing           Marketing site + login portal ("/")
  mobile            Expo / React Native companion
  penalty-calculator    (standalone public tool)
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
contract change (it is currently `0.41.0`).

## Clerk AI — the principles (details: docs/clerk-ai.md)

Clerk never files anything: extraction proposes, a human disposes, and
approval creates a DRAFT invoice only. Every model call flows through
`modules/clerk/gateway.ts` — kill switch (`clerk_ai` flag), append-only
inference ledger written on the RAW pool (spend accounting survives any
rollback), schema-validated output, fail closed — and is capped by a per-firm
monthly token budget checked BEFORE the provider is touched and again in the
gateway. The grounding split is constant across every feature: facts are
computed in SQL (Lagos calendar for statutory clocks), the model only
classifies or phrases, closed catalogues/option lists bound every choice, and
a deterministic template fallback always answers. Anything the platform sends
is consent-gated (CORE-03) and pointer-only (SEC-12); machine webhooks (the
inbound email/WhatsApp rails) are fail-closed — token unset means the rail is
dark. Model-calling routes run outside the per-request transaction
(`NO_CONTEXT_ROUTES`); client-facing surfaces are firm-pinned and
SEC-03-scoped. `docs/clerk-ai.md` covers the gateway/tiers, intake paths,
review queue, Ask, digests & delivery, reports, memories, watches, evals &
canaries, and budgets & economics.

## Data layer & tenancy (details: docs/platform.md)

Every request runs in a per-request transaction as the non-BYPASSRLS
`meridian_app` role with `app.firm_id`/`app.bypass` GUCs bound to the
principal — firm isolation is enforced by RLS at the data layer. Tables come
from `drizzle push`; RLS policies/triggers come from the numbered guardrail
migrations in `lib/db/src/migrations` (a new tenant table needs a policy
migration; production applies migrations manually, not at boot). Two gotchas
you must not learn the hard way:

- **SEC-03.** Firm-keyed RLS shares a firm across all its `client_user`s, so
  a client route must ALSO call `assertClientPartyScope` / filter by
  `clientPartyScope` — RLS is not a backstop for sibling-client isolation.
  Copy the pattern in `routes/invoices.ts` / `routes/engagements.ts`.
- **The 4xx rollback rule.** `tenantContext` buffers the response and commits
  on `status < 400`, rolls back on `status >= 400`. Anything that must
  persist even when the handler errors (login throttle counters, the
  inference ledger) must write on the **raw `pool`**, not `getDb()`.

`docs/platform.md` also covers auth & sessions (invites, TOTP, rate
limiting), the pipeline worker & sweeps (idempotent, multi-instance-safe,
Lagos day boundaries), messaging & the notification inbox, statements & bank
feeds & scanned intake, billing/PDF/export surfaces, and observability
(`/api/healthz`, `/api/readyz`, `/api/metrics`).

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
pnpm --filter @workspace/landing run test
pnpm --filter @workspace/format --filter @workspace/api-errors --filter @workspace/web-ui run test
# web builds (each needs BASE_PATH + PORT), then the e2e journeys:
pnpm --filter @workspace/scripts run e2e        # 47 checks vs real builds + DB
```

CI (`.github/workflows/ci.yml`) runs all of the above.

## Deployment notes

- After a merge, **restart the Replit api-server workflow** — otherwise the
  deployed `dist` is stale and the version-skew banner fires. Schema `push` and
  the guardrail migrations run on boot, so new columns/policies land with that
  restart.
- `FRAME_ANCESTORS` env overrides the clickjacking allowlist per deployment
  (defaults to `'self'` + the Replit preview domains).
