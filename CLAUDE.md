# Valo — engineering guide

Nigeria-first e-invoicing **compliance** platform: accounting firms and their
SME clients prepare, validate, stamp (via FIRS/MBS rails), and reconcile
invoices, with an operator "Compliance Desk" and an AI intake assistant
("Clerk"). This file is the lean index — the deep references are
`docs/clerk-ai.md` (the AI assistant), `docs/platform.md` (tenancy, auth,
background work, rails, exports), `docs/architecture.md` (the C4 context
and container maps plus the decision log — start there for the big picture),
`docs/operations.md` (the release path: Publish, the pilot and governed
profiles, backups, rollback), `docs/development.md` / `docs/environment.md` (local setup and
every env name) and `docs/repository-map.md` / `docs/troubleshooting.md`.

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
  api-errors        Shared error codes + envelopes (server and apps)
  format            Money/date/copy formatting shared by server and apps
  web-ui            Design-system primitives + shell shared by the web apps
  web-config        The one Vite config (PORT/BASE_PATH contract, CSP)
  integrations-openai-ai-server   Model-provider client (imported ONLY by modules/clerk/provider.ts)
scripts/            e2e harness (Playwright), ops (release, backup, promote, postdeploy) + quality gates
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
contract change (it is currently `0.100.0`).

The Valo rebrand is additive at compatibility boundaries. See
[`docs/valo-rebrand.md`](docs/valo-rebrand.md) for retained identifiers, header
and metric aliases, TOTP continuity, PWA cache cleanup, and external rollout
checks. Do not rename persisted identifiers or invent replacement domains
and mailboxes as part of a product-copy change.

## Clerk AI — the principles (details: docs/clerk-ai.md)

Clerk never files anything: extraction proposes, a human disposes, and
approval creates a DRAFT invoice only. Every model call flows through
`modules/clerk/gateway.ts` — kill switch (the `clerk_ai_runtime` flag; `clerk_ai`
is the per-firm entitlement), append-only
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
migration). Every production boot re-applies the guardrail migrations
idempotently under an advisory lock and holds readiness until they verify
(D5) — the post-merge hook runs the versioned migrations too, so a merge
never leaves the RLS window open. `ops:release` is a read-only preflight and
never pushes schema; nothing pushes schema against serving traffic
(`docs/operations.md` § Database Safety). Two gotchas you must not learn the
hard way:

- **SEC-03.** Firm-keyed RLS shares a firm across all its `client_user`s, so
  a client route must ALSO call `assertClientPartyScope` / filter by
  `clientPartyScope` — RLS is not a backstop for sibling-client isolation.
  Copy the pattern in `routes/invoices/` (shared.ts loadForTenant) / `routes/engagements.ts`.
- **Bounded reads.** Every list route applies `pageBounds` from
  `lib/page.ts` (a bare request is the default page, never the whole book;
  bad paging input is a 400) and whole-population questions are SQL
  aggregates, never a list folded in JS. New list route → new bound.
- **The 4xx rollback rule.** `tenantContext` buffers the response and commits
  on `status < 400`, rolls back on `status >= 400`. Anything that must
  persist even when the handler errors (login throttle counters, the
  inference ledger) must write on the **raw `pool`**, not `getDb()`.

`docs/platform.md` also covers auth & sessions (invites, TOTP, rate
limiting), the pipeline worker & sweeps (idempotent, multi-instance-safe,
Lagos day boundaries), messaging & the notification inbox, statements & bank
feeds & scanned intake, payables/bills (evidence-only payStatus, the 409
NOT_SUBMITTABLE orientation guard), billing/PDF/export surfaces, and
observability (`/api/healthz`, `/api/readyz`, `/api/metrics`).

## Verify battery (run before shipping)

A scratch Postgres 16 is required (`DATABASE_URL=postgresql://…/meridian_ci`).

```
pnpm run check                                  # architecture + secret + docs gates, typecheck, lint, DB-free unit suites (incl. api-server test:pure)
pnpm --filter @workspace/api-spec run codegen   # must produce zero drift
pnpm run typecheck                              # libs + all packages
pnpm run lint
pnpm dlx pnpm@11 audit --prod --audit-level=high   # supply-chain gate (pnpm 10's audit endpoint is retired)
pnpm --filter @workspace/db run push            # prepare the scratch DB: tables first...
pnpm --filter @workspace/db run migrate         # ...then guardrail migrations, or the tests hit permission-denied
E2E_DATABASE_DISPOSABLE=1 pnpm --filter @workspace/api-server run test   # DB-backed; the flag acknowledges meridian_ci is disposable
pnpm --filter @workspace/db run test            # migration rollback (real Postgres)
pnpm --filter @workspace/scripts run ops:restore-drill   # backup→restore→assert round-trip (needs DRILL_DATABASE_URL scratch target)
pnpm --filter @workspace/mobile run test
pnpm --filter @workspace/sme-compliance run test
pnpm --filter @workspace/console run test
pnpm --filter @workspace/buyer-portal run test
pnpm --filter @workspace/landing run test
pnpm --filter @workspace/penalty-calculator run test
pnpm --filter @workspace/format --filter @workspace/api-errors --filter @workspace/web-ui run test
pnpm --filter @workspace/scripts run test:reliability     # release/ops, worker, load-tool and journey-helper regressions
pnpm --filter @workspace/scripts run test:accessibility   # axe engine + keyboard assertion regression
# web builds use checked-in defaults; deployment may override BASE_PATH + PORT
pnpm run build
# then the e2e journeys:
pnpm --filter @workspace/scripts run e2e        # 424 checks vs real builds + DB (standard seed run)
```

CI (`.github/workflows/ci.yml`) runs all of the above plus the release
artifact steps: migration-only upgrade parity, a snapshot-consistent backup
retained and restored with a full catalog check, the PDF-worker and mobile
package verifications, the accessibility matrices across public and signed-in
states, lazy-route bundle budgets, and the stamped immutable build manifest
that Publish later consumes.

## Deployment notes

- Deployment is the release path in `docs/operations.md`, not a workflow
  restart. Replit Publish runs `scripts/src/ops/replit-promote.mjs
  build|start api-server` against the exact immutable CI artifact
  (`release/build-manifest.json` + its `.sha256` sidecar + the seven `dist`
  trees); it never rebuilds or installs. Under the default **pilot profile**
  (`RELEASE_PROFILE=pilot`, ADR 0004) the builds perform no database
  mutation: Replit's native Publish flow compares the development and
  production schemas and applies only the confirmed diff, the API starts as
  RUN, and boot re-applies the guardrail migrations (RLS policies, append-only
  triggers) idempotently under an advisory lock before it reports ready;
  `RELEASE_RUNTIME_STATE=HOLD` is a plain maintenance switch. The **governed profile** keeps the
  HOLD-by-default, permit-bound RUN ceremony with `ops:release` as its
  read-only preflight. `ops:postdeploy` is the after-the-fact parity check in
  both.
- A destructive schema change is surfaced by the Publish diff for explicit
  confirmation and still warrants a reviewed versioned migration. The
  boot-time guardrail re-assertion (D5) is what gives a new table its policy,
  so the deployment's startup probe is `/api/readyz` (a failed guardrail
  migration fails the rollout instead of serving 503 behind a green liveness
  check), and the stale-build banner clears once the promoted API reports
  the contract version the web bundles were built with.
- `FRAME_ANCESTORS` env overrides the clickjacking allowlist per deployment
  (defaults to `'self'` + the Replit preview domains).
