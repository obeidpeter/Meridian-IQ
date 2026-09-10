# Maintainability Programme Report

## Executive Summary

This change improves the platform without altering its OpenAPI contract,
database schema, feature activation, or role entitlements. It removes all six
known relative-import cycles, centralizes request transaction/model-capacity
policy, makes clean web/API builds deterministic, decomposes release-readiness
decisions into tested pure functions, and adds repository documentation and
executable architecture, secret, and documentation gates.

The existing R0-R2 behavior is preserved. R3 credit readiness and bank Data
Room remain behind their existing gates. No R4 financing behavior is enabled.

## Before and After

| Measure                                    |                  Before |                                                            Candidate |
| ------------------------------------------ | ----------------------: | -------------------------------------------------------------------: |
| Relative-import cycles                     |                       6 |                                                                    0 |
| Root web/API build without deployment env  |                  Failed |                                                               Passed |
| Security request-policy sources            | 2 coupled lists/modules |                                                   1 policy catalogue |
| Release-readiness orchestration complexity |                      78 |                            23; extracted decision helpers peak at 18 |
| Focused tests added                        |                       0 |                 18 (policy, build profile, readiness, Clerk scoring) |
| Architecture/secret/docs gates             |                  Ad hoc |                                                 Executable and in CI |
| Root onboarding references                 |                 Missing | README, contribution, environment, operations, troubleshooting, ADRs |

Repository-wide size and complexity remain high because large product surfaces
were not rewritten in one risky change. The debt register identifies those
follow-on slices. Current metrics are available from the report commands and
are expected to grow slightly from the new tests, documentation tooling, and
explicit contract modules.

The candidate report counts 1,235 hand-written source/test/tool files, 283,974
lines, 101 files above 600 lines, 21 above 1,000 lines, and 21 exact duplicate
groups. These counts include the new quality tooling and tests and should be
used as the ratchet baseline; they are not directly comparable to older counts
that excluded different operational and test paths. R126 moved the shadcn
primitives the shell apps shared byte-for-byte into `lib/web-ui/src/ui` (each
app file is now a re-export shim), so the exact-duplicate count is 2: the
buyer/console `main.tsx` entry pair and the api-errors/format `vitest.config.ts`
pair, both kept local by design.

## Implemented Changes

### Architecture and Design

- Moved shared format primitives below the index/notification modules.
- Moved invoice orientation policy below service and approval consumers.
- Introduced neutral rail transport/result contracts.
- Separated Clerk scoring and scheduled evaluation registration from corpus
  loading, eliminating eval/growth/red-team cycles.
- Centralized tenant-context exemptions, bypass roles, and model rate classes
  in `middleware/request-policy.ts` with exact method/path tests.
- Extracted release-readiness decisions from infrastructure orchestration.

### Build and Developer Experience

- Added validated per-app path/port defaults with deployment overrides.
- Split Expo packaging from the normal web/API build.
- Fixed the API development command so it is shell-portable.
- Added supported Node/pnpm engine ranges and root `check`/report commands.
- Added root onboarding, package ownership, environment, operation, rollback,
  troubleshooting, ADR, and contribution documentation.

### Quality and Security Gates

- Zero-cycle import graph and high-risk dependency-direction enforcement.
- Browser/mobile prohibition on DB/server package imports.
- Domain-module prohibition on production route imports.
- Provider SDK ownership restricted to Clerk provider wiring.
- High-confidence tracked credential/private-key scan.
- Documentation inventory checks every workspace and literal environment
  variable.
- CI runs the new gates and validates web-config resolution.

## Verification Evidence

Completed before pull request:

- clean API and five-web-app production build;
- `pnpm run check`, including monorepo typecheck, lint, static gates, and 1,153
  deterministic package tests;
- 44 focused API tests for request posture, release-readiness decisions, Clerk
  scoring, and existing security lockstep assertions;
- 18 new regressions across request policy, fixed-clock readiness decisions,
  web build-profile resolution, and Clerk scoring;
- architecture check with zero cycles/boundary violations;
- tracked-secret scan;
- deterministic database-free application/library suites.

GitHub CI remains the authority for DB-backed API tests, RLS/migration
behavior, rollback, restore drill, and Playwright journeys. The candidate must
not merge until those checks pass.

## Tradeoffs

- No bulk dependency upgrade was attempted. Combining major framework and
  structural migrations would make failures hard to attribute.
- Historical formatting debt was documented instead of generating a
  repository-wide diff.
- The current architecture parser is intentionally conservative and based on
  static import syntax. Runtime module loading still requires review.
- Complexity is reported, not yet blocked, because an absolute threshold would
  fail existing product code rather than prevent regression.

## Remaining Risks

See the [technical debt register](technical-debt-register.md). The immediate
risks are large UI/server modules, initial bundle size, missing unified
coverage thresholds, major dependency migrations, and environment-bound mobile
packaging. Existing release readiness also depends on real staging evidence:
backups, restore drill, advisory inbox, usability validation, credentials,
heartbeats, rails, and feature prerequisites cannot be proven from source.

## Production Promotion Checklist

- [ ] Pull request CI is green, including database, rollback, restore, and E2E.
- [ ] Candidate SHA is immutable and `EXPECTED_BUILD_REVISION` matches.
- [ ] Pre-deploy backup is stored outside the runtime and restore-tested.
- [ ] Staging uses isolated database, credentials, providers, and origins.
- [ ] `/api/healthz`, `/api/readyz`, and release readiness are acceptable.
- [ ] Login, each role home, invoice create/validate/submit, buyer confirmation,
      Invoice Room, Clerk review, and operator Desk journeys pass in staging.
- [ ] Logs contain no secrets/content and show no new 5xx, timeout, or pool
      pressure trend during the observation window.
- [ ] Dark feature flags remain dark unless separately approved with evidence.
- [ ] Rollback revision, migration response, owner, and trigger are recorded.
- [ ] Production promotion receives explicit approval after staging sign-off.

## Recommended Next Steps

1. Add coverage publishing and changed-code ratchets for security-critical
   packages.
2. Split the top five UI hotspots behind route-level lazy boundaries.
3. Extract Invoice Room and pipeline subdomains with concurrency tests.
4. Run isolated patch/minor dependency updates, then planned major migrations.
5. Burn down formatting debt in mechanical directory-sized pull requests.
