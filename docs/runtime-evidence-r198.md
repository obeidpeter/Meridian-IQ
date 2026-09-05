# R198 Runtime Evidence and Release Safety

This checklist records evidence, not a claim that production or WCAG conformance
has been verified. Use synthetic accounts and disposable databases for all
failure injection. Do not run the E2E harness against customer data.

## Release Contract

1. Keep the existing policy-definition pins, migration rollback, audit, financial,
   typecheck and E2E gates green. No skipped test or local success substitutes for CI.
2. Download the successful `meridian-release-<SHA>` artifact from the approved CI
   run. Obtain its manifest SHA-256 from that trusted run, not an untrusted sidecar.
   The manifest is a checksum/provenance record, not a cryptographic signature.
3. Preserve the CI-built API, five web apps and packaged mobile export without
   rebuilding. Retain the
   matching clean source checkout with the same line endings and platform as CI.
   The manifest hashes source bytes, schema/migration sources and every shipped
   non-source-map asset. Source maps are debugging artifacts, not served parity checks.
4. Record rollback compatibility with the expanded schema and choose the full
   rollback SHA. Confirm backup success within 24 hours (with checksum) and a
   successful restore drill within 30 days from target operational heartbeats.
   Independently confirm off-box backup accessibility and restoration timings.
5. Set `DATABASE_URL`, `RELEASE_MANIFEST`, `RELEASE_MANIFEST_SHA256`, and
   `RELEASE_ROLLBACK_REVISION`; run `node scripts/src/ops/release.mjs --yes`.
6. On schema drift, stop. The historical guardrail registry is not a complete
   schema history. New fields/tables belong in reviewed additive versioned SQL;
   migrations 0050-0054 include revisions, operation recovery, drafts, budget
   reservations and import runs. Their registry and security tests must agree.
   This change does not fabricate a generic Drizzle-to-migration conversion.
7. Only for an explicitly planned offline bootstrap: externally stop and drain
   all traffic, workers and scheduled/external writers; record evidence, set
   `RELEASE_TRAFFIC_DRAINED=1`, then use `--offline-bootstrap`. It runs ordinary
   push plus migrations while maintenance remains in place. Forced destructive
   push is refused. Any failure requires repair/restore before reopening traffic.
   A brand-new empty DB without recovery evidence is intentionally not accepted.
   The Replit post-merge hook uses frozen installation then versioned migrations
   only, never inferred schema push. If the historical pre-0050 table baseline is
   absent, the hook must fail. Establish that baseline on a disposable database
   or in separately approved maintenance, with every writer drained, backup and
   restore evidence retained, and semantic RLS/role/trigger verification before
   reopening traffic. Do not add an automatic push fallback to repair that error.
8. Promote the same artifact with `BUILD_REVISION` and `EXPECTED_BUILD_REVISION`
   set to its full SHA. Set `RELEASE_BASE_URL` and run
   `node scripts/src/ops/postdeploy.mjs` against staging, then each approved
   production origin/instance. It checks health, readiness, exact API source and
   contract, public asset bytes, and the database catalog again. A single request
   cannot prove every load-balanced replica; inventory and probe each replica.

Catalog parity covers actual policy USING/WITH CHECK, role privileges and
memberships, RLS ENABLE/FORCE, trigger enabled states and definitions, guardrail
function bodies, constraints, indexes, columns, enums and exact migration rows.
It uses the same PostgreSQL major as CI. Review drift; never overwrite the
reference from production to make a check pass. Existing runtime-role isolation
tests and policy pins remain the behavioral authority. Catalog parity does not
prove absence of all possible security issues or validate provider configuration.
Column positions and generated constraint/index names are ignored; named column
types/defaults, constraint definitions, uniqueness, index order/predicates and
object multiplicity still match. Trigger names remain significant to execution
order. PostgreSQL minor or pgvector upgrades may change deparsed definitions;
strict comparison can safely block these until reviewed and tested with matching
runtime versions. Never erase such drift by restamping against production.

## Automated Evidence

- `node --test scripts/src/ops/*.test.mjs scripts/src/load-smoke.test.mjs scripts/src/e2e/service-worker.test.mjs`
  runs isolated policy/role/trigger drift, refusal, artifact tampering, version
  skew, CSRF, 429 and actual-worker cache tests without PostgreSQL.
- `node --test scripts/src/e2e/accessibility.test.mjs` runs real axe and verifies
  that missing names, low contrast, keyboard-unreachable controls and leaking
  dialogs are detected. An installed Playwright Chromium or explicit
  `PLAYWRIGHT_EXECUTABLE_PATH` is required.
- `E2E_DATABASE_DISPOSABLE=1 DATABASE_URL=... node node_modules/tsx/dist/cli.mjs --test artifacts/api-server/src/release-reliability.integration.test.ts`
  starts the main Express app on loopback with real PostgreSQL and the explicit
  development-auth opt-in. No mock database, router-only replacement or missing-DB
  skip is accepted. It tests CSRF/client scope, concurrent stale writes/approval,
  duplicate/replayed create keys with payload conflict, and three-row/101-row
  imports with a random fixture-only SQL failure trigger after header insertion.
- The normal API-server test glob includes that integration file. CI prepares
  schema and migrations first. Source/generated contract integration must expose
  `contentRevision` and accept `expectedRevision`; missing fields fail the tests.
- Migration tests preserve every historical ladder probe and policy pin. Steps
  0050-0054 snapshot durable rows before/after down, verify owner reads and
  cross-owner denial using the actual runtime role, and test SQL constraints and
  deferred commit guards. Revision-bound approvals and unique line identities
  survive rollback/reapply; genuinely legacy null-revision approvals are revoked
  on upgrade without inventing a revision. Drafts/reservations retain data/RLS;
  operation/import down steps remove their new guards but keep data and policies.
- `node node_modules/tsx/dist/cli.mjs --test scripts/src/ops/migration-upgrade.integration.mjs`
  runs on CI's disposable schema-push-plus-migrate database. Inside a rollback-only
  transaction it removes exactly the R198 additions to reproduce the pre-R198
  table surface, applies only versioned 0050-0054 SQL, and compares both real
  catalogs plus every invoice/line value. This explicit upgrade fixture is not
  a general migration converter and does not change the target after completion.
- Built-app E2E adds independent worker-account, keyboard, customer retry, stale
  write and import rollback journeys. Each has fresh browser storage and random
  invoice identifiers. `E2E_RELIABILITY_ONLY=journeyImportRollback` selects one;
  `E2E_RELIABILITY_REVERSE=1` verifies reverse order. Legacy shared-seed journeys
  retain their original order and coverage; UI creation no longer falls back to API.
- CI preserves failed journey screenshots/traces and logs. Full axe results,
  including incomplete rules needing manual review, are written under
  `test-results/accessibility`. Restrict artifact access and retention: traces may
  contain synthetic session cookies and test-document bodies. Do not publish them.

## State Contracts

Preserve shared components and role accents; do not redesign the application to
make snapshots pass. Test actual task completion and semantic state transitions.

| State | Required behavior | Evidence |
| --- | --- | --- |
| Loading | Stable control dimensions; pending state announced | Slow customer lookup; 320px and desktop screenshot |
| Empty | No invented results; primary action remains reachable | Owned empty fixture, not missing seed fallback |
| Filtered-empty | Keep filter and clear/retry action distinct from no data | Non-matching customer search |
| Offline | No authenticated response replay or implied write authorization | Installed worker, A/B switch, revoked session, CacheStorage inspection |
| Stale | Preserve unsaved content; explicit refresh/compare conflict | Concurrent expected-revision writes and stale approval |
| Partial | Count only committed rows and identify failed rows | SQL fault at small/bulk import thresholds; independent DB query |
| Forbidden | No protected data or unintended side effects | Client A submits client B; zero inserted invoice rows |
| Disabled | Reason is available and action cannot execute | Keyboard pending-submit and permission checks |
| Failed | Live announcement, retained input, reachable retry | Customer 429 then keyboard retry; recovered options |

Add responsive rendered evidence with long legal names/emails, large amounts,
expanded text, light/dark themes and nested form errors during parent integration.
Do not treat this contract table as already-rendered coverage of every state.

## Manual Exit Checklist

- [ ] Backup restored on a disposable target; record elapsed time and recovery point.
- [ ] Runtime role cannot cross tenant/client scope; predicates/triggers survive a
      deliberately interrupted *offline* release on a disposable database.
- [ ] Installed production worker upgraded from v3: A logs out, B signs in,
      revoked/expired A stays denied offline; sibling caches remain intact.
- [ ] Complete keyboard login/MFA, customer selection, edit, import correction,
      conflict recovery, dialog/menu focus trapping and focus restoration.
- [ ] Record 320 CSS-pixel reflow, 200% text resizing and real 400% browser zoom.
      A narrower viewport is not a browser-zoom test.
- [ ] Screen-reader sessions cover live errors, loading and successful recovery;
      examine axe incomplete results and light/dark contrast manually.
- [ ] InvoiceRoom valid/revoked/expired tokens and bank data-room authorized,
      forbidden, disclosure/expiry states have owned fixtures. Current matrix adds
      tokenless/role-denied surfaces only; it does not certify authorized room flows.
- [ ] Confirm each deployed API instance and all app assets match the artifact;
      observe latency, 5xx/429, queue/backlog age, lock waits and provider health.

## Dependency and Measurement Notes

`scripts/package.json` adds `axe-core`. The approved offline frozen install passed
on pnpm 11.19.0, including esbuild 0.25.12 and 0.28.1 lifecycle scripts; no
dependency re-resolution was needed at that point. Subsequent manifest changes
require another frozen-lockfile verification before CI.
The later mobile/SME `decimal.js@10.6.0` additions were installed offline with
zero downloads, followed by a successful frozen-lockfile install. Both package
dependency links resolve 10.6.0. The final lockfile is included in this work's
inventory under the parent's subsequent installation authorization.
pnpm 10.26+ and 11 share `allowBuilds`: only `@swc/core`, `esbuild`, `msw`, and
`unrs-resolver` retain their existing approval. Unknown scripts fail with
`strictDepBuilds: true`; `verifyDepsBeforeRun: error` prevents implicit installs
while collaborators edit manifests. No blanket allow-all or audit reduction.
See [pnpm settings](https://github.com/pnpm/pnpm.io/blob/main/versioned_docs/version-10.x/settings.md)
and [pnpm 11 migration notes](https://github.com/pnpm/pnpm.io/blob/main/blog/releases/11.0.md).

Before edits, maintainability measured 1,234 files / 283,952 lines; 101 files
over 600 lines, 21 over 1,000, and 21 exact duplicate groups. No broad frontend
refactor was attempted. Measure changed modules and task timings again after
integration; shared-worktree totals are not attributable to one agent.
The integration snapshot measured 1,330 files / 300,529 lines, still 101 over
600 lines and 21 over 1,000; 22 exact duplicate groups. These shared totals
include concurrent agents' work and are not a claimed refactor improvement.

## Local Verification Closeout

Recorded on 2026-09-04 against the changing shared worktree, not an immutable
release candidate. All local command sessions started by this work completed.

| Check | Result |
| --- | --- |
| Offline dependency update and subsequent frozen install | Passed; pnpm 11.19.0; no downloads |
| Library declarations and all app typechecks | Passed, including both mobile configs and DB test helpers |
| API plus all five web production builds | Passed; existing source-map/chunk warnings remain |
| Package unit suites | Nine packages passed; SME retains one import-resume failure |
| Expanded API pure suite | 41 passed |
| Release/post-merge/load/worker regressions | 13 passed |
| Real axe/keyboard regression with installed Chrome | Passed |
| Transport, config, registry and additional contract checks | Passed |
| Architecture, secret scan, documentation inventory | Passed; 140 documented environment variables |
| Owned-file whitespace validation | Passed |
| Whole-worktree lint | Failed on state-catalogue browser globals and generated `tmp` output; two draft-hook warnings |
| PostgreSQL/RLS/rollback/upgrade, full app E2E, restore drill | Not run locally; required CI/runtime evidence |

Unowned integration follow-ups: `artifacts/sme-compliance/src/pages/import.test.tsx`
cannot find "Resume this import" in its lost-response case;
`scripts/src/e2e/state-catalogue/run.mjs` needs correctly scoped browser globals.
Generated local `tmp/route-budget-r198` and `tmp/state-catalogue-r198` output was
also picked up by the root lint invocation. No gates were disabled, no other
agent's generated evidence was deleted, and no failed test was skipped.

CI now runs both state-catalogue commands after frontend builds, using the hard
route-budget ceilings (never `--measure-only`). Failure artifacts include the
catalogue screenshots/axe reports and route-budget JSON/build logs/manifests.
The quality job timeout is now 30 minutes (previously 20), and E2E is 35 minutes
(previously 25). These are bounded headroom allowances for expanded tests, not
a claim that the full PostgreSQL CI run has been timed. The catalogue owner's
77-specimen rendering evidence is separate from this agent's main-app/DB results;
its measured report intervals and build timings are recorded below.

Final codegen/drift verification remains parent-owned. Production evidence must
be obtained from the actual target; the parent's read-only devDB observation
(migration 49, no backup/restore heartbeat rows) cannot satisfy release gates.
Do not release until CI, genuine backup/restore evidence and target parity pass.

### Exact Local Command Outcomes

Snapshot date: 2026-09-04. Commands ran in the worktree root unless a package
directory is specified. Node was 24.19.0; pnpm was 11.19.0. Durations below are
the reported test/build durations, not a sum of unique tests or whole-CI timing.
The shared checkout continued changing, so these are timestamped observations,
not final-codegen or immutable-commit certification.

Dependency commands used the installed fallback
`C:/Users/obeid/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/pnpm.cmd`:

| Command | Exit | Observed result |
| --- | --- | --- |
| `pnpm install --offline --frozen-lockfile --reporter=append-only` (initial) | 0 | 5.6s; esbuild 0.25.12 and 0.28.1 lifecycle scripts passed |
| `pnpm install --offline --no-frozen-lockfile --reporter=append-only` (authorized decimal update) | 0 | 9.6s; 1,205 resolved, 1,188 reused, zero downloaded/added |
| `pnpm install --offline --frozen-lockfile --reporter=append-only` (after update) | 0 | 500ms; already up to date |

Both mobile and SME resolve `decimal.js/package.json` to version 10.6.0 using
`createRequire` from their package directories. Existing peer/deprecation warnings
were not suppressed. Parent owns the final generated-client refresh.

Typecheck commands, all exit 0:

```text
node node_modules/typescript/bin/tsc --build
node node_modules/typescript/bin/tsc -p artifacts/api-server/tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p artifacts/landing/tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p artifacts/console/tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p artifacts/sme-compliance/tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p artifacts/buyer-portal/tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p artifacts/penalty-calculator/tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p artifacts/mobile/tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p artifacts/mobile/tsconfig.test.json --noEmit
node node_modules/typescript/bin/tsc -p lib/db/tsconfig.json --noEmit
```

The package typechecks were dispatched with the absolute TypeScript CLI and
package-local `-p tsconfig.json` (or `tsconfig.test.json`); paths above show the
equivalent root invocation. Refreshing library declarations cleared the earlier
stale declaration errors before the successful app pass.

The full package unit pass dispatched the installed CLI with `createRequire`,
without pnpm auto-install. Exact orchestration:

```javascript
node -e "const fs=require('fs'),path=require('path'),{createRequire}=require('module'),{spawnSync}=require('child_process');let failed=0;for(const p of ['lib/api-errors','lib/format','lib/web-config','lib/web-ui','artifacts/mobile','artifacts/landing','artifacts/console','artifacts/sme-compliance','artifacts/buyer-portal','artifacts/penalty-calculator']){console.log('\nVERIFY UNIT '+p);const r=createRequire(process.cwd()+'/'+p+'/package.json');const args=p.endsWith('mobile')?[path.resolve('node_modules/tsx/dist/cli.mjs'),'--test','lib/**/*.test.ts']:p.endsWith('penalty-calculator')?['--test','src/**/*.test.ts']:[path.join(path.dirname(r.resolve('vitest/package.json')),'vitest.mjs'),'run'];const run=spawnSync(process.execPath,args,{cwd:p,encoding:'utf8',maxBuffer:10*1024*1024});const output=run.stdout+run.stderr;console.log(run.status===0?output.split('\n').filter(l=>/Test Files|Tests |tests |pass |fail |skipped |Duration |duration_ms/.test(l)).join('\n'):output);console.log('VERIFY RESULT '+p+' '+run.status);if(run.status!==0)failed++;}process.exitCode=failed?1:0;"
```

| Package | Exit | Files | Passed / failed | Reported duration |
| --- | --- | --- | --- | --- |
| `lib/api-errors` | 0 | 1 | 9 / 0 | 359ms |
| `lib/format` | 0 | 7 | 97 / 0 | 12.21s |
| `lib/web-config` | 0 | 1 | 6 / 0 | 1.51s |
| `lib/web-ui` | 0 | 22 | 103 / 0 | 11.28s |
| `artifacts/mobile` | 0 | Not reported | 121 / 0 | 2,758.7931ms |
| `artifacts/landing` | 0 | 4 | 30 / 0 | 908ms |
| `artifacts/console` | 0 | 38 | 430 / 0 | 15.64s |
| `artifacts/sme-compliance` | 1 | 42 (41 pass, 1 fail) | 387 / 1 | 22.50s |
| `artifacts/buyer-portal` | 0 | 5 | 44 / 0 | 4.89s |
| `artifacts/penalty-calculator` | 0 | Not reported | 12 / 0 | 223.445ms |

The SME count/duration is from the whole-SME run starting at local 22:07:47;
the subsequent multi-package pass repeated the same failure. No test was skipped
to produce these results. The wrapper exits 1 because SME failed.

Exact remaining SME failure, sent to C task
`01a06e18-f55e-7003-9861-3f6a6255eb96` for source/fixture diagnosis:

```text
artifacts/sme-compliance/src/pages/import.test.tsx:172:16
refresh restores the active run and resumes after an already committed lost response
TestingLibraryElementError: Unable to find role="button" and name "Resume this import"
```

```tsx
harness.loseFirst = true;
const firstRender = renderWithClient(<Import />);
await validate(201);
fireEvent.click(screen.getByTestId("button-commit"));
await screen.findByRole("button", { name: "Resume this import" });
expect(harness.commits).toEqual([0]);
```

At failure the rendered page remains on "Add your rows"; "Upload" and "New
import" are disabled. This is not evidence that the resume contract passed.

Additional direct-node checks:

| Command | Exit | Observed result |
| --- | --- | --- |
| API `test:pure` script dispatched through `node node_modules/tsx/dist/cli.mjs --test` | 0 | 41 passed, 0 failed/skipped; 2,279.3813ms |
| `node --test scripts/src/ops/*.test.mjs scripts/src/load-smoke.test.mjs scripts/src/e2e/service-worker.test.mjs` | 0 | 13 passed, 0 failed/skipped; 740.8075ms |
| `node --test scripts/src/e2e/accessibility.test.mjs` | 0 | 1 passed, 0 failed/skipped; 1,832.2625ms |
| `node scripts/src/quality/architecture.mjs` | 0 | 2,354 files; 5,044 relative edges |
| `node scripts/src/quality/docs.mjs` | 0 | 140 documented environment variables; 13 required documents |
| `node scripts/src/quality/secrets.mjs` | 0 | Secret scan passed |
| `node node_modules/eslint/bin/eslint.js .` | 1 | State-catalogue browser-global errors and generated `tmp` output; details below |

The API pure command's exact package-local arguments were:

```text
--test src/middleware/request-policy.test.ts src/middleware/rate-limit-lockstep.test.ts src/architecture-conformance.test.ts src/modules/clerk/eval-scoring.test.ts src/modules/desk/release-readiness-checks.test.ts src/modules/invoice/input-validation.test.ts src/modules/invoice/cursor.test.ts src/modules/invoice-drafts/contract.test.ts src/modules/operations/command.test.ts src/modules/import-runs/manifest.test.ts
```

This additional command passed 28 tests, zero failed/skipped, in 1,767.5278ms
(it overlaps API pure tests; do not sum as unique coverage):

```text
node node_modules/tsx/dist/cli.mjs --test lib/api-client-react/test/custom-fetch.test.ts lib/db/src/connection-config.test.ts lib/db/src/migrations/registry.test.ts artifacts/api-server/src/modules/invoice-drafts/contract.test.ts artifacts/api-server/src/modules/operations/command.test.ts artifacts/api-server/src/modules/import-runs/manifest.test.ts artifacts/api-server/src/modules/invoice/input-validation.test.ts artifacts/api-server/src/modules/invoice/cursor.test.ts
```

Axe used `PLAYWRIGHT_EXECUTABLE_PATH=C:/Program Files/Google/Chrome/Application/chrome.exe`;
Playwright's downloaded Chromium was unavailable locally. Vitest/Vite initially
hit a Windows sandbox ancestor-directory read restriction in esbuild. The same
commands subsequently ran with approved filesystem access; no test or build
logic was weakened to bypass it.

Root lint's source failures were `no-undef` in
`scripts/src/e2e/state-catalogue/run.mjs` at 62:31, 65:21, 65:66, 66:65, 69:24,
70:24, 71:148, 72:150, 82:107 and 84:117 (`document`, `getComputedStyle`,
`innerWidth`). Two additional `react-hooks/exhaustive-deps` warnings were in
SME `use-invoice-drafts`: 40:5 unnecessary `catalogueVersion`, and 160:5 missing
`me`. The later root lint also scanned generated `tmp/route-budget-r198/**` and
`tmp/state-catalogue-r198/**`; output was truncated, so no total diagnostic count
is claimed. Owned-file ESLint passed (exit 0, 4.853s), as did scoped
`git -c core.safecrlf=false diff --check`. Root lint remains a required failed
gate until the catalogue owner/parent fixes it and reruns it.

Production builds all exited 0. The API ran `node build.mjs` in
`artifacts/api-server`. Each web build ran its resolved installed Vite CLI as
`node <absolute-vite-cli> build --config vite.config.ts` in that package.

| Build | Reported duration |
| --- | --- |
| API | 3.696s |
| Landing | 9.57s |
| Console | 8.84s |
| SME | 5.50s |
| Buyer portal | 4.61s |
| Penalty calculator | 4.10s |

These sum to 36.316s of reported build time, excluding orchestration overhead.
The console prebuild `node ../../scripts/render-api-reference.mjs` also passed
from `artifacts/console` (contract 0.99.0; 401 operations, 37 areas at that
snapshot). Existing source-map and chunk-size warnings remain visible.

### Catalogue Owner's Measured Reports

Inspected the existing owner-produced reports; this agent did not rerun or
claim ownership of their 77 specimens. Commands registered unchanged in CI:

```text
node scripts/src/e2e/state-catalogue/run.mjs
node scripts/src/e2e/state-catalogue/route-budget.mjs
```

`tmp/state-catalogue-r198/report.json` contains 77 cases and 21 interaction
records, using installed Chrome 152.0.7977.77. Its `generatedAt` was
2026-09-04T21:10:39.011Z and file write time 21:13:29.993Z: approximately
170.982s from report initialization to completion. Initialization occurs after
the fixture build, so this interval excludes that build and is not full command
wall time. `tmp/route-budget-r198/report.json` spans approximately 33.693s
(21:12:44.979Z to 21:13:18.672Z), including five fresh builds whose logs report
7.20s, 7.07s, 5.38s, 4.87s and 4.76s (29.28s total).

| App | Eager gzip bytes / ceiling | Lazy entries / minimum |
| --- | --- | --- |
| Console | 164,203 / 166,000 | 33 / 33 |
| SME | 158,878 / 160,500 | 26 / 26 |
| Buyer portal | 133,547 / 135,000 | 8 / 8 |
| Landing | 70,751 / 71,500 | 6 / 6 |
| Penalty calculator | 61,221 / 62,000 | 1 / 1 |

All recorded budgets pass their existing hard ceilings. CI's 30/35-minute job
limits provide headroom for this measured local overhead plus browser setup,
actual PostgreSQL suites, the restore drill and slower shared runners. Record
actual complete CI durations after the first run; do not treat these local
intervals as a measured upper bound on CI. Failure artifact paths preserve
catalogue reports/screenshots, route-budget JSON/build logs and Vite manifests.

PostgreSQL-backed integration, migration ladder, migration-only catalog parity,
full app E2E and restore drill were not executed locally: no PostgreSQL service,
psql or Docker is installed. Their results remain pending CI, not passing or
skipped. No production verification or environment mutation was performed.

## Owned Change Inventory

This testing/release-safety work changed the following files. Shared source,
generated API code, schema exports, migration registry and other agents' files
remain parent-integrated. The console build also regenerates
`artifacts/console/public/api-reference.html` from the integrated OpenAPI.

- `.github/workflows/ci.yml`
- `artifacts/api-server/package.json`
- `artifacts/api-server/.replit-artifact/artifact.toml`
- `artifacts/buyer-portal/.replit-artifact/artifact.toml`
- `artifacts/console/.replit-artifact/artifact.toml`
- `artifacts/landing/.replit-artifact/artifact.toml`
- `artifacts/mobile/.replit-artifact/artifact.toml`
- `artifacts/penalty-calculator/.replit-artifact/artifact.toml`
- `artifacts/sme-compliance/.replit-artifact/artifact.toml`
- `artifacts/api-server/src/modules/invoice/approvals.test.ts`
- `artifacts/api-server/src/release-reliability.integration.test.ts`
- `artifacts/api-server/src/test-helpers/route-harness.ts`
- `docs/USER_MANUAL.md`
- `docs/architecture.md`
- `docs/development.md`
- `docs/environment.md`
- `docs/operations.md`
- `docs/platform.md`
- `docs/release-readiness.md`
- `docs/repository-map.md`
- `docs/runtime-evidence-r198.md`
- `lib/db/src/migrations/reliability-policy-reference.ts`
- `lib/db/src/migrations/rls-coverage.test.ts`
- `lib/db/src/migrations/rls-policy-qual.test.ts`
- `lib/db/src/migrations/rollback-reliability.ts`
- `lib/db/src/migrations/rollback.test.ts`
- `package.json`
- `pnpm-lock.yaml`
- `pnpm-workspace.yaml`
- `scripts/package.json`
- `scripts/post-merge.sh`
- `scripts/src/e2e/accessibility.mjs`
- `scripts/src/e2e/accessibility.test.mjs`
- `scripts/src/e2e/journeys/accessibility.mjs`
- `scripts/src/e2e/journeys/controls.mjs`
- `scripts/src/e2e/journeys/index.mjs`
- `scripts/src/e2e/journeys/lifecycle.mjs`
- `scripts/src/e2e/journeys/reliability.mjs`
- `scripts/src/e2e/journeys/shared.mjs`
- `scripts/src/e2e/run.mjs`
- `scripts/src/e2e/service-worker.test.mjs`
- `scripts/src/load-smoke.mjs`
- `scripts/src/load-smoke.test.mjs`
- `scripts/src/ops/build-manifest.mjs`
- `scripts/src/ops/migration-upgrade.integration.mjs`
- `scripts/src/ops/post-merge.test.mjs`
- `scripts/src/ops/postdeploy.mjs`
- `scripts/src/ops/release.mjs`
- `scripts/src/ops/release.test.mjs`
- `scripts/src/ops/replit-promote.mjs`
- `scripts/src/ops/replit-promote.test.mjs`
- `scripts/src/ops/security-catalog.mjs`
- `scripts/src/test-client.mjs`

## Native Replit Promotion Follow-Up

Historical implementation record: the temporary mobile refusal described in
this section was removed by the seven-artifact follow-up below. Use that latest
section and `docs/operations.md` for the current release contract.

F07 integration discovery: the native Publish descriptors rebuilt all six apps
and started the API directly, bypassing the release verifier; its source health
field could therefore report a deployment UUID. Those six production descriptors
now invoke `replit-promote.mjs build <app>`; the API run command uses
`replit-promote.mjs start api-server`. Development descriptors, package build
scripts and normal CI compilation are unchanged. Mobile's production build/run
now explicitly refuse because its Expo outputs and separate serving inputs lack
a tested CI artifact contract. Its local Expo development remains unchanged.

The build adapter requires independently trusted `RELEASE_MANIFEST_SHA256`,
the packaged root-relative manifest, a clean matching Git checkout, identical
source/schema hashes and the complete immutable six-app inventory. The API
build additionally invokes the existing read-only release gate with the actual
target database and rollback revision. It cannot bypass absent backup/restore
heartbeats or semantic catalog drift. The runtime wrapper verifies the same
manifest and all six packaged asset trees without `.git`, sets both build
revision variables from the manifest, then imports the unchanged API bundle.
No compilation, dependency installation, download, schema push or migration is
performed by the adapter. CI retains hidden artifact files in its upload.

Exact local follow-up commands on 2026-09-04:

| Command | Exit | Result |
| --- | --- | --- |
| `node --test scripts/src/ops/replit-promote.test.mjs` | 0 | 10 passed, 0 failed/skipped; 11,580.4041ms |
| `node --test scripts/src/ops/*.test.mjs scripts/src/load-smoke.test.mjs scripts/src/e2e/service-worker.test.mjs` | 0 | 23 passed, 0 failed/skipped; 8,855.4875ms |
| Same combined command after the mobile refusal and untracked-source guards | 0 | 24 passed, 0 failed/skipped; 18,080.1691ms |
| `node node_modules/eslint/bin/eslint.js scripts/src/ops/replit-promote.mjs scripts/src/ops/replit-promote.test.mjs scripts/src/ops/build-manifest.mjs` | 0 | Final focused lint passed; 1.488s command wall time |
| `node scripts/src/quality/docs.mjs` | 0 | 13 required files, 140 environment variables, all workspaces mapped |
| `node scripts/src/quality/architecture.mjs` | 0 | 2,361 source files, 5,061 relative import edges; no violations |
| CI YAML parse/assertions and scoped `git -c core.safecrlf=false diff --check` | 0 | Hidden artifact transport, regression registration, 30/35-minute job limits and whitespace validated |

The final combined pass includes 11 adapter tests. The two preceding rows are
the initial six-artifact implementation snapshot, not the final test count.

Tests create disposable Git repositories and synthetic six-app artifacts, not
commits in the shared checkout. They cover positive promotion; missing manifest,
checksum and CI provenance; tampered manifest/assets (every app and API runtime
data); missing siblings and unexpected assets; wrong app/URL inventory; dirty
and staged/untracked source, hidden dirty bytes, wrong revision/tree/source/schema hashes;
symlinked dist roots; and mandatory recovery/catalog/rollback preflight refusal.
The real child-process startup test removes `.git` and clears `PATH`, verifies
the original API fixture reads the exact full CI SHA rather than old environment
values or a deployment UUID, and confirms the dist bytes were not rewritten.
Descriptor assertions preserve development commands and web public directories.
The added mobile test proves both native build and run refuse even when a valid
six-app manifest exists; it preserves the Expo development route and command.
Target-database reads are mocked only in these adapter unit tests; real database
release/migration/RLS gates remain independently required in CI/staging.

Remaining native deployment evidence, owned by the parent/operator:

- [ ] Securely stage the approved CI artifact without rebuilding, preserving all
      paths and independently configuring the trusted manifest checksum.
- [ ] Confirm ignored `dist` files and the untracked manifest survive Replit's
      build snapshot, and matching Git metadata is available during build.
- [ ] Confirm the API runtime contains all six dist trees, the manifest, adapter
      and its four built-in-only helper modules; checksum reaches build/runtime.
- [ ] Confirm actual native Publish executes the descriptor commands and does
      not independently overwrite production data or infer/push schema.
- [ ] On staging, prove an API preflight or mobile-service failure aborts the
      entire Publish without partially promoting web services. Do not proceed
      if provider behavior permits partial promotion around a failed gate.
- [ ] Capture staging build/start logs and postdeploy parity for every replica.
- [ ] Establish genuine production backup/restore evidence before release.

Mobile inspection found an Expo Go build driven by Metro with domain/Repl
configuration, timestamp/PID-specific native bundles, manifest rewriting and a
separate server/template/app-metadata surface. CI has no tested equivalent
artifact contract. Both native production commands now fail explicitly; local
Expo is unchanged. This is not a claim of mobile promotion or all-platform
asset parity. If Replit always includes mobile, native Publish as a whole must
remain blocked until supported service exclusion or a reviewed mobile artifact
contract is verified. There is no allow-unverified-mobile flag.

Production must already have reviewed migrations 0050-0054 for API build catalog
preflight. Post-merge applies to development and does not establish production
parity. The parent handles production migrations after backup approval. The
parent's new `/release/` and `backups/` ignore entries are included in the source
hash through the tracked `.gitignore`; they do not remove artifact-byte checks.
Verify ignored release files survive the native snapshot just as for `dist`.

Exact files changed by this native Replit follow-up:

- `.github/workflows/ci.yml`
- `artifacts/api-server/.replit-artifact/artifact.toml`
- `artifacts/buyer-portal/.replit-artifact/artifact.toml`
- `artifacts/console/.replit-artifact/artifact.toml`
- `artifacts/landing/.replit-artifact/artifact.toml`
- `artifacts/mobile/.replit-artifact/artifact.toml`
- `artifacts/penalty-calculator/.replit-artifact/artifact.toml`
- `artifacts/sme-compliance/.replit-artifact/artifact.toml`
- `scripts/src/ops/build-manifest.mjs`
- `scripts/src/ops/replit-promote.mjs`
- `scripts/src/ops/replit-promote.test.mjs`
- `docs/environment.md`
- `docs/operations.md`
- `docs/runtime-evidence-r198.md`

Additional files changed by the seven-artifact mobile follow-up:

- `artifacts/mobile/scripts/build.js`
- `artifacts/mobile/eas.json`
- `scripts/src/ops/mobile-artifact.mjs`
- `scripts/src/e2e/serve.mjs`
- `scripts/src/e2e/run.mjs`
- `docs/development.md`

The parent reports production PITR retention of seven days with scheduled
backups Off; the previously inspected source/dev database is at migration 49
with zero backup/restore heartbeat evidence. Neither observation substitutes
for a tested recoverable backup and target production parity. No production
action or Replit snapshot execution was performed here. Packaging constraints
and the precise native promotion sequence are documented in `docs/operations.md`;
missing packaging prerequisites intentionally block Publish, not fall back.

## Seven-Artifact Mobile Contract

The mobile blanket refusal is removed. All seven production descriptors now
verify/promote the same CI artifact, including `artifacts/mobile/dist`.
CI runs `node scripts/src/ops/mobile-artifact.mjs build` and `check` before
stamping. The build uses the existing native Metro exporter and copies its
static-build assets/manifests, unchanged server (with explicit `.cjs` extension),
templates, `app.json`, `eas.json` and `deployment.json` into the immutable dist.
The manifest hashes every mobile serving input and public byte and binds mobile
configuration separately. Promotion also compares it against reviewed source.
API and mobile startup verify the complete seven-app package without Git.

The build selects installed Expo directly instead of invoking pnpm to start
Metro, normalizes the bundle request path for Windows, rejects reuse of an
unverified Metro process in CI, and reports early Metro exits rather than
waiting through the startup timeout. It does not install dependencies. Normal
local Expo development and package builds remain available.

Current explicit production inputs, taken from the existing EAS domain and the
parent-provided Repl ID, are:

```json
{
  "domain": "meridian-iq.replit.app",
  "basePath": "/mobile/",
  "replId": "d096574a-b3d8-4990-8bf5-4be1e6646e06"
}
```

These are public configuration, not new secrets. The parent subsequently
confirmed `/mobile` returns HTTP 200 JSON for both ios/android platform headers,
with launch assets on `meridian-iq.replit.app/mobile`. This is parent-provided
host evidence, not a remote inspection by this agent. Runtime never silently
rewrites stamped URLs; a changed target requires an explicit build-contract
update before publishing.

Bounded local results before freezing for the parent commit:

| Command/check | Result |
| --- | --- |
| Original `node scripts/build.js` in mobile, with production EAS domain and `/mobile/` | Failed before Metro startup: pnpm `ERR_PNPM_VERIFY_DEPS_BEFORE_RUN`, `enableGlobalVirtualStore` setting changed; then `Metro timeout`, exit 1. No install was attempted. |
| `node --test scripts/src/ops/*.test.mjs scripts/src/load-smoke.test.mjs scripts/src/e2e/service-worker.test.mjs` after seven-artifact integration | Exit 0; 26 passed, 0 failed/skipped; 18,687.9029ms |
| Focused ESLint on mobile build/helper, manifest/adapter/tests and E2E router/runner | Exit 0; 1.433s command wall time |
| Same combined test command after E2E mobile-router coverage | Exit 0; 27 passed, 0 failed/skipped; 20,263.4087ms |
| Final focused ESLint | Exit 0; 1.243s command wall time |
| `node scripts/src/quality/architecture.mjs` | Exit 0; 2,368 source files, 5,072 relative import edges |
| `node scripts/src/quality/docs.mjs` | Exit 0; 13 required files, 141 documented environment variables |
| CI YAML ordering/transport assertions and scoped whitespace check | Exit 0; mobile build/check precede stamp; all dist and hidden files preserved |

The final 27-test pass includes mobile startup without Git, target/config mismatch,
tampering of every mobile serving input, native manifest/bundle URL validation,
and a real HTTP probe using the unchanged original mobile server with packaged
fixture manifests/assets. CI now checks the real export with that same server
probe; the E2E router includes the mobile public-byte tree so postdeploy parity
does not accidentally compare it to the landing SPA fallback. No old test is
skipped and no mobile deployment bypass exists.

At this earlier checkpoint the full real Metro export had not been rerun after
the direct-CLI fix. The later Native Mobile Compile Repair section supersedes
that local verification status with an actual successful two-platform build.
Broad final builds/unit suites and actual PostgreSQL/RLS/E2E checks are now
parent-driven. Production migration/recovery, seven-tree snapshot preservation,
cross-service atomic promotion and actual published mobile routing remain
unverified until the parent runs the approved staging/production checks.

## Replit Metadata-Only HEAD Compatibility

The parent observed Replit commit `b36dfc929` ("Published your App") as an empty
commit above GitHub main `8347dd29`, with a clean working tree. This observation
is parent-provided, not a remote inspection by this agent. Native Publish can
therefore change HEAD metadata while retaining identical tested content.

Only `replit-promote.mjs` now permits HEAD revision inequality. Clean tracked
state and index, allowed untracked staging files, exact Git tree identity,
tracked byte hash, schema byte hash, all seven asset inventories and mobile
configuration remain mandatory. The adapter logs the distinct local HEAD and
trusted CI revision and never rewrites the manifest. Runtime `BUILD_REVISION`
and `EXPECTED_BUILD_REVISION` stay bound to `manifest.source.revision`.
`verifyLocalArtifact` and the ordinary release default are unchanged and still
reject revision mismatch. No bypass environment flag or relaxed source hashing
was introduced.

The regression creates an empty commit in a disposable fixture, verifies native
web and API promotion (including the API release preflight), starts the API and
checks it reports the original CI SHA, then commits changed source and requires
refusal. Existing wrong-tree/source-hash/schema-hash and dirty/index tests remain.
The strict ordinary artifact verifier must reject that same empty commit.

Final focused verification before freezing:

| Command | Result |
| --- | --- |
| `node --test scripts/src/ops/*.test.mjs scripts/src/load-smoke.test.mjs scripts/src/e2e/service-worker.test.mjs` | Exit 0; 28 passed, 0 failed/skipped; 30,763.5319ms |
| `node node_modules/eslint/bin/eslint.js scripts/src/ops/replit-promote.mjs scripts/src/ops/replit-promote.test.mjs` | Exit 0; 1.651s command wall time |

At this earlier checkpoint the full native mobile compile remained pending;
the next section records its subsequent successful local execution. Actual
PostgreSQL CI/E2E and approved deployment verification remain parent-driven
requirements. No shared worktree commit, push, migration or deployment was
performed by this work.

Exact files changed for this compatibility follow-up:

- `scripts/src/ops/replit-promote.mjs`
- `scripts/src/ops/replit-promote.test.mjs`
- `docs/operations.md`
- `docs/runtime-evidence-r198.md`

## Native Mobile Compile Repair

The real Windows Node 24.19.0 build initially failed in Metro with HTTP 500.
Bounded response diagnostics exposed the actual cause: `Cannot find module
'babel-preset-expo'` (iOS failed after 1,343ms, 956 modules; command exit 1).
The mobile Babel config already required that preset, but it was only present
transitively. The mobile package now declares `babel-preset-expo: ~54.0.11`,
matching the installed Expo 54.0.35 dependency range. No Babel transform was
disabled. Diagnostics read at most 8,192 bytes for at most two seconds, cancel
the response stream and strip terminal control sequences. Metro cleanup awaits
child closure instead of forcing immediate process exit; neither the diagnostic
failure reproduction nor the subsequent successful build reproduced the earlier
Node 24 `UV_HANDLE_CLOSING` assertion.

The parent explicitly authorized the dependency and lockfile update. pnpm
11.19.0 reused the existing project-local store. The first sandboxed offline
attempt encountered registry metadata permission errors and was stopped; the
subsequent authorized offline attempt failed with `ERR_PNPM_NO_OFFLINE_META`
for `@babel/runtime@7.29.7`. The successful retry used `--prefer-offline`, without
disabling supply-chain checks or changing the reviewed lifecycle allowlist.
It resolved 1,205 packages, reused 1,188, downloaded zero and added one in 16.9s.
Existing peer/deprecation warnings remain visible.

An ordinary pnpm command then exposed `ERR_PNPM_VERIFY_DEPS_BEFORE_RUN` for an
unset versus false `enableGlobalVirtualStore` setting. The workspace now pins
the documented false default explicitly, retaining the local virtual store and
`verifyDepsBeforeRun: error`. This setting is supported since pnpm 10.12.1.
See the [official pnpm setting documentation](https://pnpm.io/settings/node-modules#enableglobalvirtualstore).

Exact successful dependency commands (from the repository root, using the
installed pnpm 11.19.0 fallback executable):

```powershell
pnpm install --prefer-offline --no-frozen-lockfile --reporter=append-only --store-dir C:/Users/obeid/Documents/Codex/2026-07-06/github-plugin-github-openai-curated-remote/.pnpm-store --config.enableGlobalVirtualStore=false
pnpm --filter @workspace/mobile exec node -p "require.resolve('babel-preset-expo')"
pnpm install --offline --frozen-lockfile --reporter=append-only --store-dir C:/Users/obeid/Documents/Codex/2026-07-06/github-plugin-github-openai-curated-remote/.pnpm-store
```

The ordinary resolution command passed without a config override and resolved
the installed preset 54.0.11. The final offline frozen install passed in 436ms,
already up to date. Dependency manifests and lockfile are frozen for the parent
to run full gates and final codegen; no install or generated-code work remains
with this agent.

| Command/check | Actual local outcome |
| --- | --- |
| `node scripts/src/ops/mobile-artifact.mjs build` (authorized unsandboxed build) | Exit 0; iOS 20,107ms / 1,799 modules; Android 13,535ms / 1,797 modules; both manifests fetched; 49 unique assets copied; packaged for `meridian-iq.replit.app/mobile/`. No deployment occurred. |
| `node scripts/src/ops/mobile-artifact.mjs check` | Exit 0; real packaged original server, both native manifests and every referenced asset passed exact-byte HTTP verification; command wall time 392ms. |
| `node --test scripts/src/ops/*.test.mjs scripts/src/load-smoke.test.mjs scripts/src/e2e/service-worker.test.mjs` | Exit 0; 31 passed, 0 failed/skipped; 24,060.6346ms. Includes bounded Metro JSON/byte-limit/timeout diagnostics and all seven-artifact/metadata-only HEAD regressions. |
| `node node_modules/eslint/bin/eslint.js artifacts/mobile/scripts/build.js artifacts/mobile/scripts/metro-response.cjs scripts/src/ops/mobile-build.test.mjs scripts/src/ops/mobile-artifact.mjs scripts/src/ops/replit-promote.mjs scripts/src/ops/replit-promote.test.mjs` | Exit 0; 1.465s command wall time. |
| `node scripts/src/quality/architecture.mjs` | Exit 0; 2,375 source files, 5,082 relative import edges; no cycles or boundary violations. |
| `node scripts/src/quality/docs.mjs` | Exit 0; 13 required files, 141 documented environment variables, every workspace mapped. |
| `git diff --check -- artifacts/mobile/package.json artifacts/mobile/scripts/build.js artifacts/mobile/scripts/metro-response.cjs scripts/src/ops/mobile-build.test.mjs pnpm-workspace.yaml pnpm-lock.yaml docs/runtime-evidence-r198.md` | Exit 0; no whitespace errors; normal Windows LF/CRLF notices only. |

Exact files changed for this bounded compile/dependency repair:

- `artifacts/mobile/package.json` (direct preset declaration only; parent decimal dependency retained)
- `artifacts/mobile/scripts/build.js`
- `artifacts/mobile/scripts/metro-response.cjs` (new)
- `scripts/src/ops/mobile-build.test.mjs` (new)
- `pnpm-workspace.yaml` (explicit false virtual-store setting)
- `pnpm-lock.yaml` (approved package-manager update)
- `docs/runtime-evidence-r198.md`

The parent reports that the earlier agent claims about Replit snapshots
excluding `.git`, respecting `.gitignore`, or omitting ignored assets were
retracted after primary-source scrutiny. They are not established host facts.
No staging architecture or integrity check was changed based on those claims.
Actual native Publish snapshot/promotion verification remains required. The
local build and HTTP byte checks do not establish physical-device behavior,
atomic cross-service deployment or production database/recovery readiness.
Real PostgreSQL CI, target migration 50-54 application, genuine backup/restore
evidence and postdeploy parity remain mandatory; the parent-reported production
database is still migration 49. No quality gate was weakened.

## Retained Snapshot Recovery Evidence (2026-09-05)

The backup producer and restore drill now share a versioned evidence contract.
One held read-only REPEATABLE READ transaction exports the MVCC snapshot used
by `pg_dump --snapshot`, the semantic security catalog, referenced role
attributes and every public-table row count. Schema, ACL and role changes must
remain stopped during capture; normal committed DML may continue. A persistent
`psql` process holds the snapshot until the dump finishes. No npm dependency
was added. Catalog/process capture is bounded at 16 MiB, rather than Node's
default 1 MiB subprocess buffer.

Archives use UUID-suffixed names and exclusive private file descriptors in a
required private directory outside the checkout. Retention rejects symlinked
bundles, leaves incomplete captures/unrelated files untouched and serializes the
entire same-directory operation with a lock acquired before snapshot capture.
An abandoned lock refuses automatically; its removal requires operator
investigation. Cross-directory operations are not globally serialized: the
source heartbeat update instead atomically rejects an older snapshot timestamp.
Verified archives survive publication/retention errors, and rejected publication
does not prune files or emit successful CI outputs.

The drill consumes a specific retained archive and a manifest checksum supplied
independently by its trusted producer. A sidecar cannot establish trust. It
checks manifest freshness (non-future and at most 24 hours), archive size/hash
and role prerequisites before creating a fresh explicitly confirmed scratch
database. It never drops/reuses a database or bootstraps roles/grants. Source
database names are forbidden regardless of hostname aliases; admin host/port
must exactly match the target. A random database marker verifies the target
connection before restore. Full catalog and all table counts are compared with
the backup-time baseline, never the source's later migrated state. The target
remains for separately approved inspection/cleanup.

Final producer interface, confirmed with the parent's release integration:

- `backup.metadata`: `evidenceVersion: 1`, `sha256`, `snapshotSha256`,
  `manifestSha256`, `file`, `manifestFile`, `bytes`, `tocEntries`, `createdAt`.
- `restore_drill.metadata`: `evidenceVersion: 1`, matching `backupSha256`,
  `snapshotSha256`, `backupManifestSha256`, `backupCreatedAt`, `targetDatabase`,
  `durationSeconds`, `securityCatalogVerified: true`, `allTableCountsVerified: true`.
- `snapshotSha256` hashes the exact JSON object `{catalog,rowCounts,roles}`.
  Completion times remain database-recorded `last_succeeded_at` values. Parent
  integration binds restore completion to backup completion and the approved
  plan's exact backup completion time. This work did not edit release gates.

CI now first exercises a real exported snapshot: it commits a fixture insert
after snapshot export but before dump, then changes the source fixture schema
after backup. Restoring must recover the old empty table and old schema. CI
then produces a separate retained backup and passes that producer step's exact
manifest path/hash to the final drill. Backups stay in the private runner
temporary directory, outside source/artifact stamping. These PostgreSQL steps
have not run locally because this machine has no PostgreSQL binaries/service.

| Exact command | Actual local outcome |
| --- | --- |
| `node --test scripts/src/ops/recovery.test.mjs` | Exit 0; 11 passed, 0 failed/skipped; 669.4787ms. Covers trust/hash/freshness, retained baseline, destructive-target guards, roles, catalog/count drift, retention, concurrent filenames and snapshot-process success/failure cleanup. |
| `node --test scripts/src/ops/*.test.mjs scripts/src/load-smoke.test.mjs scripts/src/e2e/service-worker.test.mjs` | Exit 1; 99 tests, 93 passed, 6 failed, 0 skipped; 26,930.8988ms. All 11 recovery tests and 8 release tests passed. Six Replit fixture integration failures are detailed below; no gate or assertion was relaxed. |
| `node node_modules/eslint/bin/eslint.js scripts/src/ops/common.mjs scripts/src/ops/backup.mjs scripts/src/ops/restore-drill.mjs scripts/src/ops/backup-snapshot.mjs scripts/src/ops/recovery-evidence.mjs scripts/src/ops/recovery.test.mjs scripts/src/ops/backup-restore.integration.mjs` | Exit 0; 0.997s command wall time. |
| `node scripts/src/quality/architecture.mjs` | Exit 0; 2,385 source files, 5,111 relative import edges; no cycles or boundary violations. |
| `node scripts/src/quality/docs.mjs` (before this evidence entry) | Exit 0; 13 required files, 137 documented environment variables, every workspace mapped. |

The parent identified a retention race in the initial late publication lock:
an older slow snapshot could publish after a newer one and prune it at
`BACKUP_KEEP=1`. That implementation is superseded by the pre-capture directory
lock and atomic source-heartbeat timestamp guard described above. Same-directory
overlap is refused before capture. Different directories may capture in parallel,
but an older snapshot cannot replace a newer heartbeat; its verified files remain
available after refusal, and no pruning follows. This is not a claim of global
per-source serialization. The real PostgreSQL integration now also attempts an
older heartbeat publication and asserts the entire newer row, including its
completion timestamp, is unchanged.

| Verification after retention-race repair | Actual local outcome |
| --- | --- |
| `node --test scripts/src/ops/recovery.test.mjs` | Exit 0; 13 passed, 0 failed/skipped; 848.8536ms. Adds duplicate-before-capture refusal, cross-directory SQL-guard contract and verified-file preservation after publication/retention failures. The actual SQL guard remains a required CI assertion, not locally demonstrated PostgreSQL behavior. |
| Focused seven-file ESLint command above | Exit 0; 1.863s command wall time. |
| `node scripts/src/quality/docs.mjs` | Exit 0; 13 required files, 137 documented environment variables, every workspace mapped. |
| `git diff --check -- .github/workflows/ci.yml scripts/src/ops/common.mjs scripts/src/ops/backup.mjs scripts/src/ops/restore-drill.mjs scripts/src/ops/backup-snapshot.mjs scripts/src/ops/recovery-evidence.mjs scripts/src/ops/recovery.test.mjs scripts/src/ops/backup-restore.integration.mjs docs/operations.md docs/environment.md docs/runtime-evidence-r198.md` | Exit 0; no whitespace errors, normal Windows line-ending notices only. |

The HOLD/RUN wrapper and permit integration are still being implemented by other
owners. Shared release-sequence documentation is not declared deployment-ready
before those interfaces and tests are finalized. The parent reports the current
CI run passed API tests and reached frontend tests; it does not yet contain this
uncommitted snapshot/retention work, so it cannot validate these new PG steps.

Combined-run failures all occur in `scripts/src/ops/replit-promote.test.mjs`:
the seven-build positive test, the negative recovery/drift test and the empty
metadata-commit test still construct old heartbeat fixtures without
`evidenceVersion` and the new hashes (`backup evidence format is unverified`).
The API startup, runtime refusal and native mobile tests copy a runtime fixture
without the newly imported `recovery-plan.mjs` (`ERR_MODULE_NOT_FOUND`). These
were reported to the parent while their release/Replit integration checks were
active. The production gate is intentionally unchanged by this report.

Exact files changed by this recovery-evidence work:

- `.github/workflows/ci.yml`
- `scripts/src/ops/common.mjs`
- `scripts/src/ops/backup.mjs`
- `scripts/src/ops/restore-drill.mjs`
- `scripts/src/ops/backup-snapshot.mjs` (new)
- `scripts/src/ops/recovery-evidence.mjs` (new)
- `scripts/src/ops/recovery.test.mjs` (new)
- `scripts/src/ops/backup-restore.integration.mjs` (new)
- `docs/operations.md`
- `docs/environment.md`
- `docs/runtime-evidence-r198.md`

Parent-reported read-only host metadata is PostgreSQL 16.15 and vector 0.8.0.
The inspection connection's superuser/BYPASS privileges do not establish the
application runtime credential's role or permission to perform a production
dump. No production data, credentials or exports were read by this work, and
production backup approval remains pending. A migration-49 backup/drill checks
its own migration-49 baseline; candidate-schema validation remains a separate
release check. Maintenance-forward policy preparation is not authorization to
drain writers, publish or migrate. Current CI and deployment remain parent-led;
no commit, push, production operation or CI cancellation was performed here.

### Final Owned Review and Freeze

The final owned review re-read the backup producer, held-snapshot protocol,
retained-archive loader/drill, monotonic heartbeat SQL and real-PG integration
fixture. No further backup/recovery code change was needed after the retention
repair. The implementation and tests are complete locally; actual PostgreSQL
execution is still a required unverified integration case, not a claimed pass.

- `node --test scripts/src/ops/recovery.test.mjs`: exit 0, 13 passed,
  0 failed/skipped, 629.1804ms on the final focused run.
- The exact seven-file ESLint command above: exit 0, 1.857s command wall time.
- `node scripts/src/quality/architecture.mjs`: exit 0, 2,389 source files,
  5,122 relative import edges, no cycles or boundary violations. This observes
  other agents' newly added modules without claiming ownership of them.

Pending PG cases are `node --test scripts/src/ops/backup-restore.integration.mjs`
and the CI retained `ops:backup` -> `ops:restore-drill` sequence. They must prove
real snapshot import across connections despite a concurrent insert, recovery
of the backup-time schema after source DDL, full restored semantic catalog and
all-table counts, and atomic rejection of an older heartbeat without changing
the newer row or its completion time. Negative host/target/role cases already
pass locally with injected command fixtures; real isolated role provisioning
and archive round-trip remain integration prerequisites. Never run the fixture
integration test on production: it deliberately creates/changes a test table.

Residual operational requirements: use one private retention directory per
source; stop concurrent DDL/ACL/role administration during capture; supply an
independently authenticated manifest digest; provision reviewed roles and
compatible PostgreSQL/extension prerequisites separately. This is not cluster
globals/PITR recovery. Directory locks are local to a canonical directory, not
a global lock; cross-directory ordering is enforced only at heartbeat publication.
The 16 MiB capture bound, statement/lock timeouts and fourteen-minute dump/restore
limits fail closed and may need separately reviewed changes for larger sources.
An abandoned lock or retained failed-drill database needs operator inspection,
not automatic removal. No claim of live runtime-credential safety is made.

The latest user message supersedes earlier approval-pending status: the parent
is now authorized to perform the initial production backup, isolated restore
and local download, including the scripts' operational-heartbeat writes. This
agent performs none of those host/credential/data operations. No maintenance
drain has occurred. The initial capability drill does not satisfy a maintenance
plan requiring a new pre-change snapshot taken after drain; that later archive
needs its own matching drill. Backup/recovery code is frozen for parent review;
this is not a whole-deployment readiness declaration.

The final shared-doc update incorporates A/D's completed HOLD/RUN interface:
default HOLD, exact CI origin/Repl and independent digest bindings, explicit
RUN permit/activation UUID, held verification with
`apiReadinessVerified: false`, fixed evidence staging paths, Publish-only TTL
checks, durable same-release cold-start admission, and the current inability to
attest the activation UUID remotely. `docs/operations.md` and
`docs/environment.md` now describe those contracts; no activation code was edited
by this backup/recovery work.

The final combined ops command was attempted again after other agents' changes.
All 13 recovery tests and the previously failing six Replit fixtures reported
passes. The new `default HOLD serves health only without Git, DB clients, API
evaluation or a resume route` test reported a failure while files were still
being integrated, and the process did not exit after further tests. The local
run was interrupted with exit 1; no aggregate count or complete pass is claimed.
No GitHub CI run was interrupted. Fresh isolated reproduction then passed:

| Final follow-up | Actual local outcome |
| --- | --- |
| `node --test --test-reporter=tap --test-name-pattern="default HOLD serves health" scripts/src/ops/replit-promote.test.mjs` | Exit 0; 1 passed, 0 failed/skipped; 795.5312ms. The earlier failure was not reproduced. Parent/A retain responsibility for the final integrated wrapper suite. |
| `node scripts/src/quality/docs.mjs` after HOLD/RUN handoff | Exit 0; 13 required files, 137 environment variables, every workspace mapped. |

The final metadata API is unchanged by the race repair or HOLD/RUN integration.
No source/schema, dependency, generated API, migration or release-gate file was
changed by this final backup/recovery closeout. The exact eleven owned files
listed above constitute the completed implementation, CI registration and docs.

## Version 2 Recovery Closure

This section supersedes the earlier version-1 freeze. No production archive had
been exported when the user requested these additional safeguards. Both
heartbeat types now have `evidenceVersion: 2`; the archive manifest is `format: 2`
and format-1 manifests are refused. Other heartbeat field names are unchanged.
The snapshot digest now hashes this exact property order:

```text
{catalog,rowCounts,roles,roleRoots,memberships,runtimeLogin,extensions,databaseProperties}
```

The producer fsyncs the completed archive descriptor (pg_dump stdout does not
do that), then its manifest and checksum descriptors, then the destination
directory and parent, before heartbeat publication or pruning. The destination
parent must already exist. Every sync failure refuses success. Windows directory
fsync refusal was actually exercised; Windows unit fixtures inject only that
boundary to test subsequent behavior. The CLI has no durability bypass. Real
POSIX flush/PG round-trip remains an integration requirement.

Backup requires explicit `BACKUP_RUNTIME_ROLE`, a non-superuser login capable
of SET ROLE meridian_app. Source snapshot evidence records all needed recursive
incoming/outgoing membership edges, grantors, ADMIN/INHERIT/SET options, role
attributes and database ACL/settings role roots. Restore checks exact target
prerequisites before creation and again after restoring, then performs a
transaction-local session-authorization/SET ROLE probe as the intended login.
Passwords/HBA authentication are not copied or claimed verified.

Installed extension names/versions/schemas are captured in the held snapshot.
Target availability and defaults must match before creation; installed versions
are compared after restore. A vector 0.8.6 default cannot satisfy a 0.8.0 baseline.
The parent-reported isolated image/socket preparation is external evidence, not
execution by this agent. Matching extension versions alone do not establish
database locale/ACL/settings or complete restore parity.

B's `backup-database.mjs` and its tests are integrated without edits by this
agent. `databaseProperties` covers database owner, semantic ACLs, database and
role-in-database settings, encoding, locale provider/collation/ctype, ICU options,
and recorded/actual collation versions. The drill explicitly creates only its
guarded scratch name with TEMPLATE template0, compares creation metadata before
data restore, applies scoped metadata after restore, and compares it all before
the success heartbeat. No pg_restore --create, global setting mutation or
collation-version override exists.

The connection helper removes URL passwords from psql, snapshot-spawn, pg_dump
and pg_restore argv and passes them only through child PGPASSWORD. Password,
passfile and service query overrides refuse. Percent-encoded Unix-socket hosts
and TLS parameters remain intact. Error messages and nested cause context are
redacted; no password file is created. Existing sensitive environment values
remain an operator responsibility. The 16 MiB subprocess capture limit remains.

The real-PG fixture now also revokes the incoming non-superuser runtime edge and
requires refusal before scratch creation despite using a CI superuser. It then
restores that edge, verifies the actual runtime SET ROLE probe, and exercises
revoked PUBLIC CONNECT/TEMP plus non-default database/role-database settings.
The fixture restores the modified source settings/ACL entries afterward and
leaves any referenced scratch role/database for disposable CI service teardown.
It must never run against production. CI explicitly provisions one known
non-superuser fixture login for the subsequent retained-backup/drill step;
the production scripts never bootstrap roles or grants.

| Version-2 verification | Actual outcome |
| --- | --- |
| `node --test scripts/src/ops/recovery.test.mjs scripts/src/ops/postgres-connection.test.mjs scripts/src/ops/backup-database.test.mjs` | Exit 0; 38 passed, 0 failed/skipped; 971.5119ms. Includes 26 owned backup/connection tests and B's 12 database-property tests. An earlier 37/38 run exposed an invalid wrong-owner test fixture; its ACL was corrected to represent a valid different owner, preserving the specific drift assertion. |
| `node --test scripts/src/ops/release.test.mjs` | Exit 0; 8 passed, 0 failed/skipped; 135.8835ms. Parent-owned v2 release code/fixtures were not edited here. |
| `node node_modules/eslint/bin/eslint.js scripts/src/ops/common.mjs scripts/src/ops/backup.mjs scripts/src/ops/backup-snapshot.mjs scripts/src/ops/backup-durability.mjs scripts/src/ops/backup-prerequisites.mjs scripts/src/ops/recovery-evidence.mjs scripts/src/ops/restore-drill.mjs scripts/src/ops/recovery.test.mjs scripts/src/ops/postgres-connection.test.mjs scripts/src/ops/backup-restore.integration.mjs scripts/src/ops/backup-database.mjs scripts/src/ops/backup-database.test.mjs` | Exit 0; 1.175s command wall time. |
| `node scripts/src/quality/architecture.mjs` | Exit 0; 2,394 source files, 5,136 relative import edges; no cycles or boundary violations. |
| `node scripts/src/quality/docs.mjs` | Exit 0; 13 required files, 137 environment variables, every workspace mapped. |

This closure changes the original eleven owned files plus three new owned files:
`scripts/src/ops/backup-durability.mjs`, `scripts/src/ops/backup-prerequisites.mjs`
and `scripts/src/ops/postgres-connection.test.mjs`. B's two new database helper
files must be integrated with them. No dependency install, lockfile edit,
generated API change, migration change, release/adapter edit, commit, push,
production read/export/write or CI cancellation was performed by this closure.
Real PostgreSQL execution of this version-2 bundle is still pending; the previous
pushed CI failed in old common.mjs at its 1 MiB capture limit, before actual
upgrade comparison. No whole-deployment readiness is claimed.
