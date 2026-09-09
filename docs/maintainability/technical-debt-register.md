# Technical Debt Register

This register is ordered by change risk and user impact. Counts should be
refreshed with `pnpm run maintainability:report` and
`pnpm run complexity:report` before each quarterly planning cycle.

| Priority | Debt                                   | Evidence                                                                                            | Recommended action                                                                                    | Exit criterion                                                                    |
| -------- | -------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| P1       | Oversized role pages                   | Met in R120: the Clerk health page (R110), the console portfolio (R117), the SME dashboard, the SME invoice detail and the console Clerk workspace (R120) are split into sibling modules behind unchanged routes and test surfaces; no page file exceeds 1,500 lines (largest now the console claims page at 1,371) | Hold the line: a new page or module that passes 1,500 lines is split in the same change; lazy-load secondary panels; preserve keyboard/focus behavior | No production page over 1,500 lines; affected journeys and screenshots green      |
| P1       | Console/SME bundle size                | Vite reports about 1.17 MB and 0.94 MB minified JS                                                  | Route-level lazy imports, measured vendor chunking, preload only primary path                         | Initial route JS below agreed performance budget with no loading regressions      |
| P1       | Coverage visibility                    | Broad suites exist but no merged per-package coverage threshold (stage one landed in R118: the api-server suite runs under V8 coverage in CI with per-area line and branch floors for auth, tenancy, money, the Clerk gateway and the pipeline in `coverage-floors.json`, ratcheted by `test:coverage:write`; the web packages have none yet) | Add V8 coverage in stages around auth, RLS, money, Clerk gateway, pipeline; then the web packages and a changed-code threshold | Critical packages publish coverage and ratcheted changed-code threshold           |
| P2       | Exact UI/config duplication            | Current report finds 21 exact groups, primarily app-local primitives/config                         | Consolidate only stable cross-app behavior into `web-ui`; leave intentional wrappers local            | Duplicate group count ratchets down without app dependency leakage                |
| P2       | Historical formatting debt             | Prettier baseline reported 1,965 files                                                              | Format isolated directories in mechanical PRs, then add changed-file enforcement                      | Repository format check passes with no mixed behavior churn                       |
| P2       | Dependency migration backlog           | Major updates pending across OpenAI, Pino, Expo (Vite/Vitest are current; Zod moved to 4 in R119 with orval's v4 output, one ecosystem per round) | Upgrade one ecosystem at a time with changelog review and full CI                                     | Supported versions, zero unignored high/critical advisories                       |
| P2       | Source-posture tests parse text        | Security tripwires intentionally inspect route source                                               | Gradually replace with exported policy metadata and HTTP integration assertions                       | Critical posture proved behaviorally; source checks retained only where necessary |
| P3       | Mobile build requires hosting metadata | Expo artifact is environment-bound                                                                  | Add documented local preview and reproducible CI packaging profile                                    | Mobile build can run in a clean release runner with explicit inputs               |
| P3       | Complexity baseline is report-only     | Existing debt prevents an absolute low threshold                                                    | Save machine-readable baseline and fail only on new/increased hotspots                                | CI complexity ratchet active and owned                                            |

## Rules

- Do not reduce a metric by moving generated/build output into source or by
  disabling a check.
- Do not consolidate UI code whose interaction or accessibility semantics
  differ across roles.
- Security, data isolation, idempotency, and append-only evidence outrank line
  count or abstraction purity.
- Every P1 item requires an owner and a rollback plan before implementation.
