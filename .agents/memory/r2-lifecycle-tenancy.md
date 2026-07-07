---
name: R2 lifecycle transitions & buyer tenancy
description: Compare-and-set status transitions, buyer-visibility floor, and R2 flag/sweep invariants.
---
# R2 invariants (Stage R2 build)

- **Status transitions are compare-and-set.** Never `UPDATE invoices SET status=X WHERE id=?`
  after a separate eligibility read — that is a TOCTOU that can resurrect a cancelled/credited
  invoice. Use `applyTransition(invoiceId, from, to)` (modules/invoice/lifecycle.ts) or put
  `AND status = <expected>` in the UPDATE's WHERE and skip the `recordTransition` when zero
  rows moved. Applied in: reconciliation accept, cancel route, confirmation transition, buyer
  paid-flag, worker creditOriginal.

- **Buyers never see pre-submission state.** `loadBuyerBook` (modules/buyer/service.ts) applies
  BUYER_VISIBLE_STATUSES (submitted onward). Drafts/validated are the supplier firm's private
  mutable working state; any new buyer-facing query must apply the same floor.

- **Party lookups exposed to firms must be engagement-scoped.** Parties are shared reference
  data with NO RLS; an unscoped TIN/name lookup is a cross-tenant oracle (see clients/import).
  Join through engagements(firmId) for any firm-facing existence check.

- **New invoice-referencing tables must extend `meridian_purge_expired`** (currently owned by
  migration 0002) or the CORE-07 retention purge fails on FK violations. The self-FK
  `invoices.related_invoice_id` is detached (set NULL) for surviving adjustments before delete.

- **R2 flags gate sweeps too.** `sweepB2c` and `refreshBuyerExposures` no-op while their flag
  is dark; worker jobs register via `registerSweep`/`registerHandler` (modules/pipeline) —
  never import feature modules from the worker core.

- **B2C clocks:** breaches are marked BEFORE collection each sweep, and an expired open batch
  never collects new sales (each sale gets its own 24h window). `submitBatch` judges compliance
  by `now <= deadlineAt`, not by whether the sweep already flipped the batch.

- **One live adjustment per original** (credit_note/correction): enforced in `createDraft`;
  cancelled/failed adjustments free the slot.
