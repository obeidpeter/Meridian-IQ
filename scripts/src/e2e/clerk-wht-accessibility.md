# Clerk and WHT Accessibility Regression

CI run `33940988030` exposed 13 failures across six routes: the SME Ask Clerk
inline capture link depended on hover to distinguish it from text; the WHT
ledger could not be keyboard-scrolled; and the ordinary Console Clerk mobile
brand/back link sat outside a landmark. Control Centre Clerk is a separate
surface and is not changed by this fix.

Build `artifacts/console` and `artifacts/sme-compliance` with their existing Vite
build commands, then run from the repository root:

```sh
node --test scripts/src/e2e/clerk-wht-accessibility.test.mjs
```

The test uses production frontend bundles, Chromium and the shared unmodified
axe runner. Its inert API fixtures are fulfilled only at the loopback origin;
unexpected API requests fail with 501, non-local requests are blocked, and no
database, external service or authenticated production session is used.
Browser contexts and the local server are closed even when setup or assertions
fail. It does not replace the database-backed role/journey matrix.

All six routes are checked at 320, 390 and 1360 pixels. Assertions cover the
full axe result without exclusions, main/h1 landmarks, the visible Clerk
header, current navigation and keyboard focus, the persistent Ask link
underline, and the named WHT group/table. Actual Tab and arrow keys move focus
and scroll the overflowing ledger in both directions; no row actions are
introduced. The WHT group takes its name from the table caption without adding
another region landmark.

Local verification on 2026-09-05: Chromium `149.0.7827.55`, 18/18 scenarios
(19/19 Node tests including the parent), zero skips/failures, 33.57 seconds.
All scans reported zero axe violations and no page errors or unknown API calls.
The focused component tests passed 153/153; six new assertions were first run
against unfixed source and failed for the expected missing affordances.

Focused unit commands (run in the indicated app directory):

```sh
# artifacts/sme-compliance: 25 tests
node node_modules/vitest/vitest.mjs run src/pages/clerk-ask.test.tsx src/pages/wht.test.tsx
# artifacts/console: 128 tests
node node_modules/vitest/vitest.mjs run src/components/clerk-shell.test.tsx src/pages/clerk-ask.test.ts src/pages/clerk-claims.test.ts src/pages/clerk-health.test.ts src/pages/clerk-shared.test.ts
```

Evidence is retained below `tmp/clerk-wht-accessibility/` with a screenshot,
full axe JSON, and Playwright trace per route/width:

- `2026-09-05T03-41-59-493Z`: SME pre-rebuild reproduction. Console bundles had
  already incorporated the shared-worktree header change, so this is not a
  Console before-fix artifact; the retained CI reports and red unit regressions
  establish that baseline.
- `2026-09-05T03-44-10-234Z`: rebuilt apps, all 18 scenarios passing.

CI registration and failure-artifact upload are owned by the parent agent.
