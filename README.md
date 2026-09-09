# Valo

Valo is a Nigeria-first e-invoicing compliance platform. Accounting
firms and their clients prepare, validate, stamp, reconcile, and evidence
invoices through a shared API, role-specific web applications, and the Clerk
AI assistant.

The repository is a pnpm monorepo built as a modular monolith. The OpenAPI
contract, tenant isolation, append-only audit records, consent controls, and
human approval boundaries are first-class system constraints.

## Start Here

Prerequisites:

- Node.js 22 or 24
- pnpm 10 or 11
- PostgreSQL 16 with pgvector for server and integration tests

```bash
pnpm install --frozen-lockfile
cp .env.example .env
pnpm run check
pnpm run build
```

`pnpm run build` produces the API server and all five web bundles without
requiring deployment-only environment variables. The Expo build is separate:

```bash
pnpm run build:mobile
```

For database-backed validation, create disposable `meridian_ci` and
`meridian_drill` databases, then follow [Development](docs/development.md).

## Applications

| Surface                 | Workspace                       | Default path           |
| ----------------------- | ------------------------------- | ---------------------- |
| Landing and login       | `@workspace/landing`            | `/`                    |
| Firm/operator console   | `@workspace/console`            | `/console/`            |
| SME compliance          | `@workspace/sme-compliance`     | `/app/`                |
| Buyer portal            | `@workspace/buyer-portal`       | `/buyer/`              |
| Penalty calculator      | `@workspace/penalty-calculator` | `/penalty-calculator/` |
| API and background work | `@workspace/api-server`         | `/api`                 |
| Mobile companion        | `@workspace/mobile`             | Expo application       |

See the [repository map](docs/repository-map.md) for package ownership and
dependency direction.

## Daily Commands

```bash
pnpm run check                  # architecture, secrets, types, lint, unit tests
pnpm run build                  # API plus all web production bundles
pnpm run architecture:check     # cycles and forbidden dependency boundaries
pnpm run security:secrets       # high-confidence tracked-secret scan
pnpm run maintainability:report # size and duplication indicators
```

The full release battery, including database, migration rollback, restore,
and browser journeys, runs in CI. Local commands are documented in
[Development](docs/development.md).

## Contract Changes

`lib/api-spec/openapi.yaml` is the source of truth. After changing it:

```bash
pnpm --filter @workspace/api-spec run codegen
git diff -- lib/api-zod lib/api-client-react
```

Commit the generated clients with the contract change. Never edit generated
files by hand.

## Engineering References

- [Architecture](docs/architecture.md)
- [Development](docs/development.md)
- [Environment reference](docs/environment.md)
- [Operations and rollback](docs/operations.md)
- [Clerk AI boundaries](docs/clerk-ai.md)
- [Release readiness](docs/release-readiness.md)
- [Immutable release preparation](docs/release-preparation.md)
- [Operational verification and ownership](docs/operational-verification.md)
- [First-invoice onboarding](docs/first-invoice-onboarding.md)
- [Usability validation](docs/usability-validation.md)
- [Workflow improvement review](docs/workflow-improvements.md)
- [Valo rebrand and compatibility](docs/valo-rebrand.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Architecture decisions](docs/adr/README.md)
- [Maintainability report](docs/maintainability/final-report.md)

## Security Baseline

- Firm data is isolated with PostgreSQL RLS and server-side role/party checks.
- Public and machine routes fail closed when their credentials are absent.
- Model calls go through the Clerk gateway, with budgets, ledgers, schemas,
  safety scans, evaluations, and human approval before business writes.
- Secrets belong in deployment secret stores or local untracked `.env` files.
  `.env.example` contains names and safe placeholders only.

Report suspected security issues privately to the repository owner. Do not
open a public issue containing credentials, personal data, or exploit details.
