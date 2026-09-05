# Repository Map

## Runtime Containers

| Workspace                       | Responsibility                                           | May depend on                                                                       |
| ------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `@workspace/api-server`         | Express API, domain services, workers, provider adapters | generated schemas, DB, format, API errors, model integration through Clerk provider |
| `@workspace/landing`            | Public site, login, recovery, public Invoice Room        | API client, format, web UI/config                                                   |
| `@workspace/console`            | Operator, firm, auditor, and bank workspaces             | API client, format, web UI/config                                                   |
| `@workspace/sme-compliance`     | Client compliance workspace                              | API client, format, web UI/config                                                   |
| `@workspace/buyer-portal`       | Buyer confirmation and dispute workflows                 | API client, format, web UI/config                                                   |
| `@workspace/penalty-calculator` | Public statutory calculator                              | API client, format, web UI/config                                                   |
| `@workspace/mobile`             | Expo companion                                           | API client and mobile-safe shared libraries                                         |

## Shared Packages

| Workspace                                  | Owner and change rule                                                  |
| ------------------------------------------ | ---------------------------------------------------------------------- |
| `@workspace/api-spec`                      | OpenAPI source of truth. Run codegen after every edit.                 |
| `@workspace/api-zod`                       | Generated schemas and contract version. Do not edit generated files.   |
| `@workspace/api-client-react`              | Generated fetchers and React Query hooks. Do not edit generated files. |
| `@workspace/db`                            | Drizzle schema, migrations, RLS context, and database lifecycle.       |
| `@workspace/api-errors`                    | Stable error-envelope interpretation shared by clients.                |
| `@workspace/format`                        | Cross-surface display and copy primitives. Must stay runtime-light.    |
| `@workspace/web-ui`                        | Headless shared UI and application-shell behavior.                     |
| `@workspace/web-config`                    | Vite/Vitest defaults and browser security headers.                     |
| `@workspace/integrations-openai-ai-server` | Low-level provider client, imported only by Clerk provider wiring.     |
| `@workspace/scripts`                       | E2E, load, backup/restore, release, and quality tooling.               |

## Server Dependency Direction

```text
app/middleware -> routes -> domain modules -> db/integration abstractions
                         -> generated contract schemas
workers/sweeps -> domain modules -> db/integration abstractions
```

`middleware/request-policy.ts` is the source of truth for routes that own
their transaction scope and routes that consume model capacity. Shared
contracts used by two implementations live in neutral modules such as
`modules/rails/contracts.ts`.

## High-Risk Boundaries

- `middleware/principal.ts`, `middleware/request-policy.ts`, and
  `modules/auth/rbac.ts`: authentication, role, party, and RLS posture.
- `lib/db/src/migrations`: RLS, append-only records, grants, and constraints.
- `modules/clerk/gateway.ts` and `provider.ts`: model kill switch, budgets,
  output validation, ledgers, and provider access.
- `modules/invoice`, `modules/pipeline`, and `modules/rails`: lifecycle,
  idempotency, stamping, retry, and duplicate recovery.
- `modules/desk/release-readiness.ts`: production activation evidence.

Changes across these boundaries require negative-path and concurrency tests,
not only happy-path coverage.

## Reliability Evidence

- `scripts/src/ops/release.mjs`, `build-manifest.mjs`, `security-catalog.mjs`, and
  `postdeploy.mjs`: read-only online release preflight, trusted CI artifact and
  semantic schema parity. No serving-time schema push.
- `scripts/src/e2e/accessibility.mjs` and `journeys/reliability.mjs`: real axe,
  keyboard interaction, isolated accounts, stale writes and SQL import rollback.
- `artifacts/api-server/src/release-reliability.integration.test.ts`: actual
  main-app HTTP middleware and PostgreSQL transaction tests, not router mocks.
- `lib/db/src/migrations/rollback-reliability.ts`: one ladder step for each of
  migrations 0050-0054, preserving rows and enforcing additive rollback contracts.
- `lib/db/src/migrations/reliability-policy-reference.ts`: independent reviewed
  owner-policy definitions; PostgreSQL canonicalizes them for exact policy pins.
- [R198 runtime evidence record](history/2026-09-r198/runtime-evidence-r198.md): test commands,
  artifact promotion prerequisites, manual checks and unverified runtime claims.

## Generated and Runtime Output

Do not review or edit dependencies, `dist`, coverage, Expo static output, or
generated clients as hand-written source. Database dumps and disaster-recovery
archives must live outside the repository and deployment directory.
