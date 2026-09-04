# Contributing

## Working Agreement

Keep changes scoped, preserve existing security boundaries, and make behavior
observable through tests. Do not activate dark roadmap features as part of a
refactor. Never weaken RLS, consent, audit, idempotency, Clerk approval, or
production readiness checks to make a test pass.

## Branch and Review Flow

1. Branch from current `main`.
2. Make one coherent change with focused tests.
3. Run `pnpm run check` and `pnpm run build`.
4. Run database and E2E checks when the change crosses those boundaries.
5. Open a pull request with risks, migration impact, and rollback steps.
6. Merge only after required CI checks pass.

Use conventional, imperative commit subjects. Avoid mixing generated output,
format-only churn, dependency upgrades, and behavior changes in one commit.

## Architecture Rules

- Web and mobile code call the API client; they do not import the database or
  server implementation.
- HTTP routes authenticate, authorize, parse generated schemas, and delegate.
- Domain modules must not import route modules.
- All model SDK access goes through `modules/clerk/provider.ts`, then through
  the Clerk gateway for inference policy and ledgers.
- Shared interfaces belong below both consumers, not in one implementation.
- Add a migration and RLS policy for every tenant-owned table.

`pnpm run architecture:check` enforces import cycles and the highest-risk
dependency boundaries.

## API Workflow

Edit `lib/api-spec/openapi.yaml`, bump the contract version, run codegen, and
commit both generated packages. Parse request parameters, queries, and bodies
with generated schemas at the route boundary. Keep domain errors stable.

## Database Workflow

Schema declarations create tables. Numbered guardrail migrations own RLS,
triggers, grants, retention rules, and other production constraints. A schema
change is incomplete until forward migration, rollback, tenant-isolation, and
restore behavior are tested against PostgreSQL 16.

Do not rewrite an applied migration. Add the next numbered migration.

## Clerk AI Workflow

Clerk proposes; a human disposes. New model behavior requires:

- a registered gateway purpose and model tier;
- a closed, schema-validated output contract;
- grounding from authorized server-side facts;
- prompt-injection and malformed-output fixtures;
- spend attribution and budget enforcement;
- an explicit approval boundary before consequential writes;
- canary/evaluation evidence before promotion.

See `docs/clerk-ai.md` before changing prompts, providers, or evaluation code.

## Tests by Change Type

| Change                     | Minimum validation                                               |
| -------------------------- | ---------------------------------------------------------------- |
| Pure helper/UI behavior    | focused unit test, typecheck, lint                               |
| Route/auth/scope           | route test plus negative role and cross-tenant cases             |
| Async/idempotent operation | duplicate, retry, conflict, and partial-failure cases            |
| Schema/migration           | DB suite and rollback test                                       |
| Contract                   | codegen drift, server tests, affected app tests                  |
| Clerk                      | malformed output, injection, budget, ledger, and eval regression |
| User journey               | affected Playwright journey and responsive/accessibility checks  |

## Formatting and Generated Files

Follow the surrounding style and let ESLint/typecheck provide the merge gate.
The repository has historical formatting debt; do not reformat unrelated
files. Never hand-edit `lib/api-zod/src/generated` or
`lib/api-client-react/src/generated`.

## Secrets and Data

Run `pnpm run security:secrets` before pushing. Use synthetic fixtures. Never
commit customer documents, database dumps, access tokens, private keys, or
production logs. Redact IDs and personal data from bug reports.
