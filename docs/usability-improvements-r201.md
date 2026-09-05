# Usability improvements: R201 review

Date: 2026-09-05. Branch: `agent/usability-r201`.
Base: `ea275be456a2c19babd06139de10cdbe322bc049` (main, PR 200).
Status: implemented and locally verified. See Git history and the pull request
for publication status; deployment is a separate release step.

## Implemented

| Recommendation | Change |
| --- | --- |
| Explain draft storage truthfully | Help and manual describe account autosave, seven-day expiry, device-only recovery, unsaved work and the distinction from created invoices. |
| Prevent misleading completion | Invoice creation, correction and the readiness checklist share line validation. Missing prices remain incomplete; zero-priced items remain valid. |
| Use understandable recovery actions | Plain-language field errors and retry copy; operation history offers View invoice, View import or Return to task. Technical response data remains optional. |
| Expose individual setup status | Today shows Completed or Not completed for every step, including its accessible name. |
| Clarify buyer queries | Query copy distinguishes the permanent response from a supplier's new request. Buyers can check for a new request both immediately after querying and on a later visit. New requests reset the response form without creating another response. |
| Prioritize daily work | Shared, keyboard-operated navigation disclosures keep daily work visible and secondary tools available. Active destinations reveal their section. Existing role, capability and feature filtering is retained. |
| Clarify first-visit access | The landing hero prioritizes Request access and retains an explicit Already invited? Sign in link. Compliance Workspace naming is consistent in the edited portal destinations. |
| Make drafts recognizable | Draft choices show number or description, amount and save time where available. Selected details show customer, total, account save time and expiry in Lagos time. |
| Validate with real users | A separate [pilot protocol](usability-pilot.md) is ready and linked from release readiness. Participant sessions are still pending. |

Browser checks also identified and corrected unnamed toast-dismiss buttons,
missing navigation-dialog description references, and tablet header overflow
in the SME, Console and buyer shells. Desktop navigation now begins at 1024px.

## Verification

- Unit tests: 1,283 passed across shared web UI, SME, Console, buyer and landing.
- Browser tests: 23 passed, covering public landing/login, authenticated synthetic
  journeys, draft metadata, query recovery and accessibility-harness safeguards.
- Authenticated screen widths: 320, 768, 1024 and 1440 CSS pixels. Public screens:
  320, 390 and 1360 CSS pixels.
- Operation-history partial-result and dialog catalogue: 16 passing specimens
  across light/dark themes and narrow/tablet/desktop widths, including 200% text.
  No reported axe violations, clipping, outside-viewport content or unreadable
  actions in these specimens.
- Shared-library build typecheck and all four edited application typechecks pass.
  All four frontend builds pass.
- Architecture, tracked-secret scan and documentation checks pass. Lint reports
  no errors and two existing hook dependency warnings in `use-invoice-drafts.ts`.
- Build warnings remain for existing source-map reporting, help-module chunking,
  and SME/Console entry bundles above 500 kB. They are not build failures.

Reproducible browser entry points:

```sh
node --test --test-concurrency=1 scripts/src/e2e/usability-improvements.test.mjs scripts/src/e2e/customer-recovery.test.mjs
node --test --test-concurrency=1 scripts/src/e2e/accessibility.test.mjs artifacts/landing/e2e/accessibility.test.mjs
node scripts/src/e2e/state-catalogue/run.mjs --states=partial,dialog
```

Build the four web applications first. Configure `PLAYWRIGHT_EXECUTABLE_PATH`
when using a locally installed browser. Evidence is generated under ignored
`tmp` directories; no production data or credentials are included.

## Limits

All browser API data was synthetic and local. This is not a production smoke
test, a full backend/RBAC integration run, a complete WCAG conformance claim,
or evidence of participant usability sessions. No production data, release
configuration, backups or usability-validation timestamps were changed.

Before release, review the changes, run the normal integration/release gates,
and conduct the participant tasks in the pilot protocol. Do not mark human
usability validation complete from automated results alone.
