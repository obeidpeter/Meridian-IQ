# Recovery State Catalogue

Development-only, synthetic data. No production app imports this directory;
the route-budget check enforces that boundary. The runner builds an isolated
fixture into ignored `tmp/state-catalogue-r198/site`, serves it only on loopback,
and shuts down the browser and server after verification. It never signs into
an account, installs dependencies, calls a backend, or modifies production pages.

## Run

From the repository root, with the parent's dependencies already installed:

```sh
node scripts/src/e2e/state-catalogue/run.mjs
node scripts/src/e2e/state-catalogue/route-budget.mjs
```

`--states=partial,dialog` runs a focused matrix into the separate `followup`
subdirectory, preserving the full-run evidence.

Use `PLAYWRIGHT_EXECUTABLE_PATH` to select an installed Chromium executable.
Otherwise the runner uses Playwright's installed browser, with installed Chrome
as a Windows fallback. It never downloads a browser. Windows sandbox users may
need permission for Vite/esbuild dependency resolution and browser launch.

## Coverage

The 88 specimens exercise the **actual production** `RouteLoading`, `lazyRoute`,
`ActivityCenter`, `OperationStatusPanel`, `NetworkStatus`, and
`SessionOperationRecovery` components with the SME stylesheet and shared tokens.
No replacement rendering or CSS overrides of those components exist here.

- Loading, empty, offline, stale/unverified, partial, forbidden, disabled, failed,
  route-load failure, recovery dialog and running states.
- 320, 768 and 1440 CSS pixels, each in light and dark themes, with reduced motion.
- Additional 320px specimens in both themes at 200% root text size. This is text enlargement,
  **not** a claim of real browser zoom coverage.
- Long legal names, long unbroken email addresses, a large NGN amount, retained
  partial/failed counts, a maximum-length request reference and expanded JSON.
- Real offline browser context, pending disabled controls, keyboard chunk retry,
  dialog focus trapping/restoration, visible keyboard focus and scrolling into
  view, keyboard-reachable saved results, and no data in the forbidden fixture.

Screenshots, full axe results (including incomplete/manual checks), geometry
findings, word/label measurements, browser version and interaction outcomes are written to
`tmp/state-catalogue-r198/report.json` and sibling files. A nonzero axe violation,
horizontal overflow, clipped text, control below 24px, unreadable action label,
or running animation under reduced motion fails the run. DOM ranges detect words
split across lines; usable label width must fit its widest intact word. Browser
self-tests reject letter-by-letter wrapping even without horizontal overflow,
reject insufficient width, and accept ordinary wrapping between words.
Screen-reader-only text is excluded from visual
clipping checks, not from axe.

These fixtures prove component rendering and interaction, not backend permissions,
mobile-native behavior, all authenticated pages, or complete WCAG conformance.
Server concurrency/RLS tests and full application journeys remain separate gates.

## Route Budget

The budget runner rebuilds all five apps into ignored `tmp/route-budget-r198`,
retaining full logs and Vite manifests. It measures gzip bytes for each entry and
its transitive **static** JavaScript imports, counting each downloaded file once.
Lazy chunks are reported separately. CSS and assets are not part of this JS budget.

`route-budgets.json` is a fixed reviewed ceiling, roughly 1% above the first R198
measurement, plus a floor on retained lazy entry counts. The normal run never
rewrites this baseline. `--measure-only` records diagnostics without enforcing
the ceilings. Updating budgets requires review, not an automatic baseline refresh.

The source ratchet also forbids eager page imports in App/main entry files, raw
operation-journal keys anywhere in production web source, and production imports
of this catalogue. Existing shell imports such as help topic metadata remain;
this does not claim every dependency of every lazy page is absent from the shell.
Keep `node scripts/src/quality/architecture.mjs` as the broader cycle/boundary gate.
Verification owns integration/CI wiring for these two commands. The catalogue
does not modify the existing verification agent's scripts.

## Workspace Switching

Deferred: there is no authenticated current-user membership-list endpoint.
`GET /me` describes only the selected membership; `POST /memberships` creates one.
The capability-scoped firm list is not an authorized list of the user's memberships.
An `x-firm-id` selector cannot distinguish multiple roles in one firm or firm-less
memberships, so an inferred dropdown would be unsafe.

Required server contract before implementing the optional switcher: an
authenticated endpoint returning only the caller's memberships, including stable
membership ID, firm ID/name, role and applicable client/buyer scope; an explicit
membership-ID selector validated against the authenticated user on every request.
No old user-only operation records are restored into the new firm/user/client
journal scope.
