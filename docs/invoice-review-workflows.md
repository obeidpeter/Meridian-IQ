# Invoice and Clerk Workspaces

The subsequent [Client Evidence Hub](client-evidence-hub.md) extends the Documents
tab with private requests, scanned uploads, human review and evidence packs.

This change extends the existing workflows; it does not enable live submission,
change approval policy, migrate business data or deploy a release.

## Invoice Workspace

The SME invoice detail groups existing actions and records into Overview,
Documents, Approvals, Payments and History. The selected tab is URL-backed.
A next-action section explains the current invoice state and routes users to
the existing guarded action or relevant records. Failed section reads remain
visible through a workspace warning and retry affordances, rather than silently
looking like empty records when another tab is selected.

The invoice list retains navigation context for returning from a detail view.
Its recovery data is navigation metadata, not invoice/customer records. Console
onboarding links include the exact scoped invoice ID; opening an invoice is not
permission to fetch or show an invoice from another firm or client.

Internal approval, buyer acknowledgement, submission, a stamp and payment are
separate events. A PDF download does not submit anything. Sandbox or missing
stamp provenance must not be presented as confirmed live acceptance.

## Clerk Review

On larger screens the original source remains beside the review fields; narrow
screens stack the two regions. Image and PDF review provide bounded zoom,
rotation, reset and page navigation. The source remains read-only. Text and voice
transcripts retain their original wording, including long lines and line breaks.

The next-field control moves focus to fields that need checking and makes the
associated evidence available. It assists review; it does not auto-approve a
field or make a provider submission. The approval summary uses the edited form
values, not the initial extraction, and explains the precise resulting action.
Invoice approval creates a draft. Notice approval records a response obligation;
it does not send a response or file anything.

Existing claim ownership, permission, validation, pending-mutation and human
decision controls remain in force. The new viewer does not upload new copies,
persist source documents locally or introduce review telemetry. Existing queue
turnaround metrics must not be described as active time spent reviewing.

## Verification and Limits

Use the repository's `check`, build and workspace-usability commands. Browser
fixtures are synthetic and block external requests; they do not validate a live
provider or replace server-side tenant and permission tests. First-invoice
guidance and unsaved-work details are documented in
[First-invoice onboarding](first-invoice-onboarding.md).

The work requires the regenerated API contract `0.103.0`. A later deployment
must use a fresh, matching CI artifact through the existing immutable release
process. Do not mix these sources with an older staged artifact.

### Local Verification, 12 September 2026

- Full repository `check` passed: architecture, secrets, documentation, brand,
  complexity, formatting, workspace typechecks, lint and 2,029 unit/pure tests.
  Two existing hook-dependency warnings remain in SME `use-invoice-drafts.ts`;
  no lint errors or relaxed baselines were introduced.
- Database-backed Today tests passed against a disposable local PostgreSQL
  database. Focused invoice approval, consent, lifecycle and tenant/security
  regressions also passed. No production database or provider was used.
- First-invoice browser checks passed at 320/768/1360px in light and dark modes.
  Business-detail navigation checks passed across both built apps at 320/1440px,
  including native unload, Back/Forward, in-app links, conflicts and failed saves.
- Invoice browser checks cover all five tabs at 320/768/1440px, hidden-section
  failures, keyboard operation and second-page list/scroll recovery. Clerk browser
  checks cover source controls, editable review, mobile reflow and guarded decisions.
- The existing workspace usability, shared style-hook, team-work and newly-created
  task browser regressions passed. An initial business-detail fixture omitted the
  existing telemetry endpoint; that fixture was corrected and all nine tests passed
  on rerun. Two unit timeouts during overlapping builds passed on the final full run.

Browser evidence is under ignored `tmp/first-invoice`, `tmp/business-details`,
`tmp/invoice-workspace-browser` and `tmp/clerk-review`. These are development
verification results, not a release artifact or a live-provider acceptance test.
