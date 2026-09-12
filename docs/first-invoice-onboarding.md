# First-Invoice Onboarding

## Today Journey

The shared `TodayWorkspace` shows one recommended next action, completed steps
and outstanding prerequisites alongside the priority queue. Its progress comes
from persisted records returned by `/api/workspace/today`, not browser checkboxes,
navigation events, analytics or local storage. Returning to Today resumes from
the latest supplied record proofs; opening a step never completes it.

Invoice steps are ordered as access, business details, customer, draft,
validation, submission consent, internal approval, live service configuration,
submission, live acceptance and recorded evidence. Only steps
returned by the server appear. Role, capability, feature and client-scope gates
remain authoritative on the server. Buyer and operator setup retain their own
actions; roles with no applicable setup do not receive invented invoice steps.

The recommendation skips steps with outstanding returned prerequisites or a
server-supplied `blockedReason`. Waiting steps remain openable unless explicitly
blocked, so an existing form can resolve their requirements. Access
recommendations, consent decisions, ERP connections, bank statements and work
items are not hard prerequisites to preparing or validating an invoice.

The priority queue states `Showing X of Y priorities`: X is the bounded returned
slice and Y is the full-population count. An empty slice with a nonzero total
does not claim that the workspace is clear.

## Record Proofs

Client proofs are scoped by both firm and the client's supplier party. Firm
proofs use one deterministically selected engaged supplier and its oldest
non-cancelled ordinary receivable invoice. Related proof steps do not combine
unrelated businesses, payables or invoices to manufacture completion. Existence
reads are bounded and child records are tied to the scoped invoice.

| Step             | Completion proof                                                                                                                                                                                                                                                                          |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Access           | `two_factor` uses the current user's persisted two-factor activation. `consent` proves recorded choices, including a refusal; a recorded choice is not necessarily a grant of submission consent.                                                                                         |
| Client           | `first_client` proves a firm engagement for the selected supplier.                                                                                                                                                                                                                        |
| Business details | `business_identity` checks the selected business's recorded legal name, TIN, street, city and country. It does not claim live registry verification.                                                                                                                                      |
| Customer         | `first_customer` uses the non-merged buyer of the selected invoice, or an eligible pre-invoice captured buyer within `partySphereCondition`. Capture provenance respects firm and user scope.                                                                                             |
| Draft            | `first_invoice` proves a persisted receivable invoice. It does not prove validation, submission or a fiscal stamp.                                                                                                                                                                        |
| Validation       | `invoice_validation` accepts current validated, submitted, stamped, confirmed, settled or credited states. Draft and failed remain incomplete. Failed content can be edited without changing its failed status, so a historical validation event is not sufficient current-content proof. |
| Evidence         | `invoice_evidence` proves actual lifecycle history for the same firm and invoice. It does not prove that someone viewed or downloaded it, and recorded draft history is not fiscal evidence.                                                                                              |

Business identity and customer recommendations wait for `first_client` when
that step is present. Draft waits for returned client/customer steps. Validation
waits for returned business, customer and draft prerequisites. Evidence waits
only for a persisted invoice, not validation or provider submission.

Submission guidance reads current invoice-specific consent, the submitter's
capability, the firm's invoice feature flag and its existing independent-approval
policy. A self-approval, revoked approval or approval of older invoice content
does not satisfy a required second review. A declined consent choice still
completes access setup, but does not grant submission consent.

Service configuration is explicitly not proof of connectivity or successful
submission. It is complete only for a configured, non-simulator transport whose
canonical environment is `live`. A recorded submitted state means processing,
not tax-authority acceptance. Acceptance requires this scoped invoice to be in
an accepted state with its own `live` stamp, non-simulator provider and nonempty
IRN, CSID and signed-artifact reference. Sandbox, missing and incomplete records
never complete acceptance, even after the configured service changes.

These are advisory reads, not authorization tokens. Opening Today never calls a
provider or submits an invoice. The existing locked submission command rechecks
permission, consent, approval and current state. No live provider or ERP
connection is required to prepare drafts, validate them or retain their history.

## Business Details

The business step opens `/clients/:id/business` in Console and `/business` in
the SME app. A firm without a supplier first adds a client. Existing invoice
records open the Console client invoice drawer or SME invoice detail, rather
than creating another invoice. `/clients/import` imports clients, not invoices.

Both editors use the existing generated `useGetParty` and `useUpdateParty`
APIs. Console requires a firm admin/staff account with `party.read` and
`party.write`. SME uses the client self-service permission: the party ID comes
only from `me.clientPartyId`, never the URL or a form field, and it does not
require `party.write`. The API still enforces authorization and party scope on
every request. Merged records cannot be edited through these pages.

The shared `BusinessDetailsForm` makes no API or session calls; it registers its
save/discard handlers with the shared unsaved-work provider when available.
It edits only legal name, TIN, CAC number, street, city and country code.
PATCH requests contain only normalized, locally changed fields; clearing an
optional value sends null. TIN/CAC checks mirror the server's structural format
rules without claiming registry verification. IDs, party type, tenant fields,
verification flags and versions are never echoed into the update request.

Dirty values survive background refetches and save errors. When saved data has
changed, an expandable comparison shows the latest saved values beside local
values. Discard is explicit. Pristine forms adopt refetched data; successful
saves adopt the API response and refresh relevant Today, directory and portfolio
caches. A synchronous in-flight lock prevents overlapping submissions and edits
during a save. Initial load failures offer retry without a fabricated empty form;
cached refetch errors preserve the editor's unsaved input.

The PATCH API carries an optimistic-concurrency guard (R113): the editor sends
the `updatedAt` of the record it edited as `expectedUpdatedAt`, a record that
changed since answers 409 with nothing written, and the page refetches so the
newer saved values appear beside the unsaved ones for the user to reconcile.
Sending changed fields still keeps unrelated values untouched. The guard is a
refusal, not a merge: the user decides what to keep after a conflict.

Console and SME wrap their Wouter routers with `UnsavedWorkProvider` and its
supported location/search hooks. Leaving an edited business form through an
in-app link or owned Back/Forward entry opens **Save / Discard / Stay**. Save
continues only after a successful response; validation, network errors and
conflicts retain the draft. Discard is explicit; Stay keeps the current page.
An in-flight save cannot be duplicated. Scope changes and unmounts invalidate
pending navigation. URL-backed tabs and filters use the same accepted snapshot.

The router indexes owned history entries without patching global history
methods. History contains only navigation metadata, never form values. A
document exit or an entry from before the router was mounted uses the browser's
native unload warning, not the custom dialog. A warning does not recover a
closed or crashed tab, and browsers may suppress it without prior interaction.
For an unknown same-document history entry, dismissing the native warning keeps
the form mounted but may leave the older URL visible until Forward restores the
owned entry. Other forms are not implicitly protected: they must deliberately
register compatible save/discard handlers.
No business-PII draft is persisted or sent to telemetry. Standalone form users
without the provider retain the native unload warning.

## Accessibility and Verification

The journey uses native buttons, uniquely labelled sections, a named progressbar
with completed/total counts, `aria-current="step"` and polite progress updates.
It neither moves focus nor intercepts keyboard navigation. Empty setup is not
100% complete. Setup-loading/error states suppress unconfirmed recommendations;
completion refers only to available setup steps, never fiscal compliance.

The editor associates labels and validation errors with each input, focuses the
first invalid field on submit and clears the summary when all errors are fixed.
Save errors and outcomes are announced. Existing shared classes and app design
tokens provide styling. The leave-page prompt uses the existing accessible alert
dialog with focus restoration, error announcements and explicit decision buttons.

Focused Vitest coverage:

- `lib/web-ui/src/today.test.tsx` and `first-invoice-journey.test.ts`: role-specific
  steps, omissions, prerequisites, resume, completed/empty/error states, accessible
  names and bounded queue counts.
- `lib/web-ui/src/business-details.test.tsx`: changed-only updates, normalization,
  dirty refetch, comparison, discard, save-error retention, duplicate-submit lock,
  validation correction and record switching.
- Each app's `src/pages/business-details.test.tsx`: permitted scope, API arguments,
  retries, cache refresh, merged/mismatched records and unload-listener cleanup.
- Shared unsaved-work controller and protected-navigation tests cover duplicate
  requests, failed saves, stale decisions, query synchronization and cleanup.

`node --test lib/web-ui/src/first-invoice.browser.test.mjs` exercises the shared
Today component without an API or database. It checks native keyboard activation,
axe, focus and reflow at 320/768/1360px in light/dark modes, including complete,
empty and retry states. Set `PLAYWRIGHT_EXECUTABLE_PATH` when using an installed
Chromium browser. Screenshots go under ignored `tmp/first-invoice/<timestamp>/`;
the fixture shuts down its browser and loopback server.

`node --test lib/web-ui/src/business-details.browser.test.mjs` exercises the
built Console and SME routes at 320/1440px in light/dark modes. It checks native
keyboard use, validation correction, save-error retention, duplicate-submit
protection, changed-fields-only PATCH requests, load retry, axe and reflow.
It also covers Save / Discard / Stay, real router links, Back/Forward, failed
navigation saves and optimistic-concurrency conflicts.
API responses are mocked, external requests are blocked, and SME scope is
checked against a conflicting URL parameter. Build both apps before running it.
Screenshots go under ignored `tmp/business-details/<timestamp>/`; its browser
and loopback server are closed after the test. These browser checks do not
replace server authorization or database-backed proof tests.

Run the shared UI and both app unit suites, TypeScript, lint and the architecture
gate after changes. `TodaySetupStepView` lives in neutral `today-types.ts` and is
re-exported from `today.tsx` to preserve existing imports without a type-import
cycle. API route tests separately cover persisted-proof and tenant-scope rules.
The API's `submission-journey.test.ts` and database-backed
`today.integration.test.ts` cover live/sandbox provenance, current consent and
approval, and isolation between clients and firms. See
[Invoice and Clerk workspaces](invoice-review-workflows.md) for the related UI.
