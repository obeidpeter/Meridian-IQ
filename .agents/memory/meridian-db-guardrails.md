---
name: MeridianIQ DB guardrails & seed idempotency
description: Immutability triggers, append-only tables, TRUNCATE reset, and tenant-isolation rules for the MeridianIQ tax-compliance backend.
---

# MeridianIQ DB guardrails & seed idempotency

## Immutable / append-only tables
`invoices`, `invoice_lines`, `submission_attempts`, `stamp_records` carry PL/pgSQL
row triggers (e.g. `meridian_enforce_invoice_immutability`,
`meridian_enforce_line_immutability`, `meridian_block_mutations`). They block
`UPDATE`/`DELETE` — even for a freshly-created draft, which immediately falls under
retention/legal hold. You cannot dedupe or clean rows after the fact.

**Trigger mutability must stay in lockstep with the app lifecycle.** The invoice
content/line triggers allow edits only while status is in draft/validated/failed —
the same set as the lifecycle's `assertMutableContent`. If you widen or narrow
mutability in one place, change the other via a new boot migration (CREATE OR
REPLACE the trigger functions), or app-level 200s turn into DB 500s.
**Why:** the original guardrail was draft-only while the app considered
validated/failed mutable; the fix-and-retry flow hit the mismatch as a 500 on
line replacement.

**How to apply:** To reset demo data, use `TRUNCATE <table> CASCADE` — TRUNCATE
bypasses row-level triggers (unlike DELETE). `TRUNCATE invoices CASCADE` clears all
lifecycle children (lines, stamps, attempts, escalations, etc.). Then restart the
api-server to re-seed.

## Seed idempotency (the seed re-runs on every api-server restart)
- `invoice_lines` has no natural unique key, so `onConflictDoNothing()` with no
  target does NOT dedupe — every restart appended duplicate lines.
  **Fix pattern:** insert the parent with `.onConflictDoNothing({target: id}).returning()`
  and only insert children when the returned array is non-empty (parent newly created).
- `submission_attempts` also has no usable unique target (`id` is random,
  `idempotency_key` is not unique). Guard seed inserts with an existence check on
  `idempotency_key` before inserting.
- **Why:** these tables are immutable, so a duplicate written by a re-seed can never
  be removed — idempotency must be enforced at insert time, not cleaned up later.

## Tenant isolation
SME route queries must scope by tenant firm, not just client party. Use
`tenantFirmId(req.principal)` and push `eq(<table>.firmId, tenant)` when non-null
(operators get no firm filter — same pattern as `loadClientInvoices`). Escalations
are NOT covered by DB RLS, so the app-layer firmId filter is the only guard against
cross-firm leakage in the dashboard summary.
