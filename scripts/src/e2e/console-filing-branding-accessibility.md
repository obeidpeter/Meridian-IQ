# Console Filing, Branding and Data Room Accessibility

## Scope and root causes

CI run 33940988030 reported nine failures across 320, 390 and 1360 pixel viewports:

- Filing Desk: the filed matrix cell used emerald-600 on white (3.65:1). The console-local cell now uses emerald-700 (5.36:1 measured by axe); its dark-mode colour is unchanged. Financial queries, sorting, periods, totals and scope are unchanged.
- White-label: white/20 highlights and opacity-70 labels reduced preview contrast to 3.58:1 and 3.46:1. Labels now remain opaque; pure black or white is selected by the better contrast ratio, and highlights increase that contrast. This is preview styling, not a global theme/token change.
- Data Room: the matrix identity was a firm admin without credit.data_room.read. The capability gate correctly denied access before the bank page mounted, but its denial title was a paragraph. It is now an H1 with unchanged styling. No capability, role or API authorization check was relaxed.

Additional requested state coverage found and fixed:

- Filing Desk and white-label loading placeholders lacked page headings; the real headings now remain visible while data loads.
- Bank Data Room's loading div had aria-label without a nameable role; it now has role=status.
- The shared console QueryError message used dark red on a dark canvas (1.82:1). The message now adds dark:text-red-300. Error handling, optional details and retry behavior are unchanged.
- The theme API accepts an open theme object. Balanced stored hsl(...) values remain supported, while preview and explicit save normalize them to bare HSL tuples. Mismatched wrappers and out-of-range channels are rejected; unknown stored theme keys are preserved. No automatic save occurs.

## Changed files

- artifacts/console/src/components/capability-gate.tsx
- artifacts/console/src/components/capability-gate.accessibility.test.tsx
- artifacts/console/src/components/filing-matrix-card.tsx
- artifacts/console/src/components/filing-matrix-card.test.tsx
- artifacts/console/src/components/query-error.tsx
- artifacts/console/src/components/query-error.accessibility.test.tsx
- artifacts/console/src/pages/bank-data-room.tsx
- artifacts/console/src/pages/bank-data-room.accessibility.test.tsx
- artifacts/console/src/pages/filing-desk.tsx
- artifacts/console/src/pages/filing-desk.accessibility.test.tsx
- artifacts/console/src/pages/whitelabel.tsx
- artifacts/console/src/pages/whitelabel.accessibility.test.tsx
- scripts/src/e2e/console-filing-branding-accessibility.test.mjs
- scripts/src/e2e/console-filing-branding-accessibility.md

## Verification

From artifacts/console:

```sh
node node_modules/vitest/vitest.mjs run src/pages/whitelabel.accessibility.test.tsx src/components/capability-gate.accessibility.test.tsx src/components/filing-matrix-card.test.tsx src/pages/filing-desk.test.ts src/pages/filing-desk.accessibility.test.tsx src/pages/bank-data-room.accessibility.test.tsx src/components/query-error.accessibility.test.tsx
node ../../node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node node_modules/vite/bin/vite.js build --config vite.config.ts
```

Results: 51 tests passed across seven files; console typecheck passed; build passed. Build reports existing sourcemap/chunk warnings. The capability test uses object cases, not array-spreading test.each cases; its earlier fixture defect is fixed. Scoped ESLint and git diff --check passed.

From the repository root, after building the console:

```sh
node --test scripts/src/e2e/console-filing-branding-accessibility.test.mjs
```

Result: one test passed, 50 complete page scans, zero accessibility findings, zero unexpected requests, zero page errors, about 81 seconds. Chromium 149.0.7827.55. PLAYWRIGHT_EXECUTABLE_PATH is honored. The test owns and closes its browser and ephemeral loopback static server.

Coverage: light/dark Filing Desk, denied Data Room and both branding preview modes at 320/390/1360; additional 390-pixel light/dark white, black, #777777-equivalent HSL and wrapped-HSL previews; Filing Desk loading/error/empty; branding loading/error/feature-disabled; authorized bank Data Room withheld/loading/error states. Unit tests additionally exercise every preset, yellow, near-black blue, malformed HSL, save normalization, role/capability denial and retry actions.

## Evidence and limitations

Final passing evidence is in scripts/test-results/console-filing-branding/2026-09-05T03-53-07-227Z/: summary.json plus 50 PNG screenshots and 50 complete axe JSON reports. Earlier timestamped directories preserve reproductions and are not the final passing result. These outputs are local/CI artifacts, not source files to stage.

The browser renders the actual built console with synthetic read-only GET API fixtures. External Google font CSS is replaced with empty CSS, using the application's fallback fonts; no external font request is sent. No axe rules, nodes or regions are excluded. The denied Data Room case explicitly asserts that no protected /api/credit/data-room request occurs. Authorized variants use bank_user with the actual capability, not an elevated firm-admin fixture.

No live API, production data, database, global branding setting or permission was changed. These browser checks do not replace real-backend E2E verification. Parent owns CI registration and combined integration checks; the existing scripts/test-results/** failure artifact pattern covers the evidence. No commit, push or staging was performed.
