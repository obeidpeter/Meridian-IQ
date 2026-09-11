# Product language

Use plain English across Valo's public pages, workspaces, mobile screens,
notifications and errors. Keep technical identifiers separate from display text.

## Writing rules

- Use sentence case and short sentences. Put the action or result first.
- Name the object: Save changes, Create invoice, Upload statement, Sign in.
- Explain what happened and the next step. Do not blame the user.
- Prefer familiar words: invoices or documents, not paper; business records,
  not book; submission service, not rail; past records, not backfill;
  client group, not cohort; remaining budget, not headroom.
- Use customer for the person or business being invoiced, supplier for the
  business issuing it, and client for a business managed by an accounting firm.
- Keep formal tax terms accurate. Explain an abbreviation on first use where
  space allows, then use its established short form. Do not change tax rates,
  legal conditions or filing requirements as part of a wording change.
- Keep diagnostic names, codes and support references available to operators.
  Explain them in plain language instead of renaming the underlying identifiers.

## Meaning must not change

- A saved draft has not necessarily passed validation or been submitted.
- Submitted or queued does not mean stamped, filed or delivered.
- A recorded payment, uploaded receipt or matched transaction does not by itself
  prove that money was transferred. Preserve the source and verification status.
- A lost connection or timeout can follow a successful write. Say that the
  result is unconfirmed and ask the user to check before retrying.
- Clerk suggestions are not approvals. State what an approval will do, its
  limits, whether it repeats automatically, and how to stop it.
- Do not remove consent conditions, irreversible-action warnings, partial
  success details, retention explanations or estimate disclaimers.

## Implementation and checks

Shared terms live in `lib/format`; shared components live in `lib/web-ui`.
`userErrorMessage` in `lib/api-errors` translates generic display errors while
`serverError` retains the exact server message for error classification.
Do not change routes, database values, feature flags, API fields, test IDs,
storage keys or model instructions when editing display text.

Update text assertions without weakening behavior checks. Check long labels,
mobile layouts, keyboard focus, and accessible names after editing copy.
Operator-authored content and existing user records must not be overwritten
by a wording update. Deployment uses the normal tested-artifact release flow.
