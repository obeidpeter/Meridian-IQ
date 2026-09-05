# Customer Recovery Selector Regression

## Command

Build `artifacts/landing` and `artifacts/sme-compliance` with their normal Vite
build commands, then run from the repository root:

```sh
node --test scripts/src/e2e/customer-recovery.test.mjs
```

The regression invokes `journeyKeyboardRecovery` and
`journeyCustomerFailureRecovery` themselves. Built UI, keyboard navigation,
customer search, dialog behavior, and axe checks are real. Only HTTP data comes
from a disposable in-memory API fixture on a loopback ephemeral port. External
browser requests are blocked; no PostgreSQL, production service, or credentials
are used. This does not replace the real API/DB journeys in CI.

## Reproduction

Contract 0.99 adds the native `#invoice-draft-slot` selector before the customer
picker. A page-wide `getByRole("option").first()` resolves its hidden
`Untitled invoice (current)` option. During a customer-search 429, the page still
has five unrelated native options while the `Customers` listbox has zero.

On Chromium 149.0.7827.55, the unmodified journeys failed both regression cases:

- `journeyKeyboardRecovery`: timeout waiting for the hidden native draft option.
- `journeyCustomerFailureRecovery`: failed "customer failure cannot select a
  stale option", because the page-wide count was not zero.

The three customer-option selectors now use the exact named `Customers`
listbox. The zero-customer-option assertion, Tab/ArrowDown/Enter interactions,
retry, focus, dialog and axe checks remain intact. The lifecycle journey uses
the same named-listbox scoping.

## Evidence And Current Result

Each run retains screenshots, Playwright traces, and JSON assertion/axe reports in
`tmp/reliability-customer-selectors/<timestamp>/`. Browser and loopback servers
are closed through teardown even if an assertion or evidence capture fails.

The original two failing traces are retained directly in
`tmp/reliability-customer-selectors/journeyKeyboardRecovery.zip` and
`tmp/reliability-customer-selectors/journeyCustomerFailureRecovery.zip`, with
matching `.png` and `.json` files.

The scoped selectors pass the customer selection and failure/retry checks.
The historical run at `2026-09-05T02-44-11-584Z` then exposed the independently
fixed bulk-dialog Escape focus-restoration issue; that assertion is retained.

The run at `2026-09-05T02-57-23-820Z` passed focus restoration but exposed a
`link-in-text-block` violation on the empty invoice list's `bulk import` link.
The retained axe report identifies `<a href="/app/import" class="text-primary
hover:underline">`: only 1.26:1 contrast against surrounding text and no
non-color affordance until hover. The app link now has a persistent underline
and explicit keyboard-focus ring. Additional browser assertions verify both
at 1360px and 320px, while the existing full axe assertion remains unchanged.

Final run `2026-09-05T02-58-47-117Z`: **2 passed, 0 failed/skipped**, 8.47 seconds
on Chromium 149.0.7827.55. The keyboard journey recorded 17 assertions including
the two new link-affordance checks; customer failure/retry recorded four. No
accessibility rules, keyboard interactions, or recovery assertions were removed.
