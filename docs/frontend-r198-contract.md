# Frontend F10 / F17-F19 Integration Contract

## Registration Before Codegen

- Register default router from `artifacts/api-server/src/routes/invoice-drafts.ts`.
- Export `invoiceDraftsTable` from `lib/db/src/schema/invoice-drafts.ts` through the existing DB schema index.
- Register `migration0052` from `lib/db/src/migrations/0052_invoice_drafts.ts`.
- Import `artifacts/api-server/src/modules/invoice-drafts/register.ts` once in the server's existing sweep-registration path. It registers `invoice_drafts.retention`, a bounded 1000-row purge of expired/discarded content per sweep; row identity/revision tombstones remain. The parent owns this integration import.
- Install the SME app's newly declared direct dependency `decimal.js` at exactly `10.6.0`; parent owns install and lockfile updates. No shared format module was added.
- Adapters now use the parent-generated draft/import-run API functions directly; no `customFetch` export is needed. No generated code is changed by this agent.

## Draft API

All endpoints require `invoice.write`, a firm-scoped principal, client access and a firm engagement. Records are additionally scoped to the authenticated user. Caller cannot submit a firm/user identity. All GET responses are no-store.

- `GET /invoice-drafts?clientPartyId=UUID&offset=0` returns `{ items: ServerInvoiceDraft[], nextOffset: number|null }`, 50 entries per page.
- `GET /invoice-drafts/:id?clientPartyId=UUID` returns `ServerInvoiceDraft`, or 404 when absent/expired/discarded.
- `PUT /invoice-drafts/:id` body `{ clientPartyId: UUID, expectedRevision: integer>=0, writeId: UUID, draft: DraftContent }` returns `ServerInvoiceDraft`. Revision 0 means insert only. A retry of the same writeId and payload returns its original latest record. Changed payload or stale revision returns 409 `DRAFT_CONFLICT`.
- `DELETE /invoice-drafts/:id` body `{ clientPartyId: UUID, expectedRevision: integer>=0 }` returns 204; stale active revision returns 409. A tombstone prevents resurrection by old writes.

`ServerInvoiceDraft = { id: UUID, revision: integer, writeId: UUID, draft: DraftContent, updatedAt: ISO timestamp, expiresAt: ISO timestamp }`.

`DraftContent = { invoiceNumber: string, buyerPartyId: UUID|"", issueDate: string, dueDate: string, currency: string, fxRateToNgn: string, whtCategory: string, lines: { description: string, quantity: string, unitPrice: string, vatRate: string }[] }`.

Exact validation source: `artifacts/api-server/src/modules/invoice-drafts/contract.ts`. It accepts unfinished form fields, limits lengths and caps lines at 500. Restore window is 7 days after the latest save. Expired or discarded content is physically cleared on the registered retention sweep (bounded batches, so a backlog may delay clearing); tombstones persist against late writes. Service adds no lifecycle invoice until create is explicitly requested. Bypass roles return 403. Migration 0052 grants SELECT/INSERT/UPDATE and explicitly revokes DELETE after the boot-wide grants, forces RLS and preserves everything on rollback. The Drizzle schema declares matching enableRLS/policy USING/WITH CHECK and the named positive-revision CHECK.

## Invoice Paging

Use parent's `GET /invoices/page`, response `{ items: Invoice[], nextCursor: string|null, total: number }`. Cursor is opaque and belongs to its entire query identity. The frontend does not use offsets or infer totals from loaded rows.

The generated ListInvoicesPagedQuery includes `statusGroup=all|draft|pending|stamped|settled|failed|closed`, `fromDate`, `toDate`, `minAmount`, `maxAmount`. The UI sends all filters to the server, whose cursor/count bind the entire filter context. Group membership follows `statusTone`: draft+validated; submitted; stamped+confirmed; settled; failed; credited+cancelled. Tab counts use each group's bounded request total, without adding another response field.

There is no buyer-name list projection. The UI hydrates individual party IDs through GET, whose read scope now matches the directory's visibility. PATCH permissions remain unchanged.

## Idempotency

Create uses `X-Idempotency-Key: invoice-create:<draft UUID>`. A changed payload under the same draft intent conflicts server-side rather than creating a duplicate after an uncertain outcome. Import uses a persisted random run UUID and per-chunk key `<run UUID>:<zero-based chunk index>`. `New import` deliberately resets intent even for identical files. Both journals include command (`invoice.create` or `invoice.import`) and the exact request key. Both call exported `operationSessionKey(me)`, matching the shell's firm/user/client identity, including null handling.

Import uses the operations agent's migration0054 manifest endpoints through generated functions. It persists the source rows/run ID locally before dispatch, POSTs the immutable manifest, GETs the authoritative checkpoint, sends only missing 100-row chunks, GETs updated checkpoints and finalizes the stored aggregate. Every chunk uses the original global row numbers and lowercase SHA-256 of the same sorted-key canonical JSON used by the server. No local completion flag is trusted. The URL carries the run ID; without device rows, the original file can be re-uploaded and is checked against the server manifest before resume. No promise of server-stored source-file bytes is made.

## Verification And Handoff

- Focused SME regression command after install: `node node_modules/vitest/vitest.mjs run src/lib/invoice-lines.test.ts src/lib/invoice-import-run.test.ts src/lib/idempotent-command.test.ts src/pages/invoice-new.test.tsx src/pages/import.test.tsx src/components/customer-directory-picker.test.tsx src/lib/invoice-draft-session.test.ts src/lib/invoice-draft.test.ts src/lib/invoice-pages.test.tsx src/pages/invoices.test.ts src/pages/import-parse.test.ts` from the SME app. Result: 11 files, 103 tests passed using a process-only Vite alias to the backend's already-installed decimal.js 10.6.0. The normal command passed 50 tests but four suites could not resolve decimal.js before the SME dependency was linked. No alias was saved to source/test configuration.
- `invoice-lines.ts` preserves exact decimal payload strings and uses precision-48 half-up arithmetic, matching the backend: compute VAT on the raw extension, round each line extension/VAT to cents, then sum rounded values in decimal arithmetic. Only display outputs convert to numbers. Tests cover large cents/fractional quantities, half-up ties, aggregate rounding and invalid decimal input.
- Server command: `node --import tsx --test artifacts/api-server/src/modules/invoice-drafts/contract.test.ts artifacts/api-server/src/modules/invoice-drafts/service.test.ts`. Six non-database tests passed. PostgreSQL suite is present but skipped here because DATABASE_URL is absent. Parent must run it against a disposable migrated database to verify actual row locks, owner RLS, rollback, replay, tombstones, content purge and DELETE denial.
- Source-based server TypeScript check reports zero diagnostics in this agent's files. The sole remaining SME owned-file diagnostic is the unlinked decimal.js dependency; final parent project-reference build/typecheck remains required. Scoped `git diff --check` passes.
- Existing sandboxed pnpm test entrypoint failed dependency verification. Direct installed runtimes worked outside the Windows sandbox. No dependencies were installed by this agent.
- Parent has registered draft table/router/migration and generated API contracts. Apply 0052 and operations 0051/0054 before enabling account draft recovery and resumable imports. Preserve grants, RLS and tombstones on rollback.
- No commit, push, merge, deployment, generated-code edit, lockfile edit, schema-index edit, migration-index edit, App/layout edit or invoice-detail edit was performed by this agent.

## Exact Owned Files

```text
artifacts/api-server/src/routes/invoice-drafts.ts
artifacts/api-server/src/modules/invoice-drafts/contract.ts
artifacts/api-server/src/modules/invoice-drafts/contract.test.ts
artifacts/api-server/src/modules/invoice-drafts/service.ts
artifacts/api-server/src/modules/invoice-drafts/service.test.ts
artifacts/api-server/src/modules/invoice-drafts/retention.ts
artifacts/api-server/src/modules/invoice-drafts/register.ts
lib/db/src/schema/invoice-drafts.ts
lib/db/src/migrations/0052_invoice_drafts.ts
artifacts/sme-compliance/package.json
artifacts/sme-compliance/src/pages/invoice-new.tsx
artifacts/sme-compliance/src/pages/invoice-new.test.tsx
artifacts/sme-compliance/src/pages/invoices.tsx
artifacts/sme-compliance/src/pages/recurring.tsx
artifacts/sme-compliance/src/pages/import.tsx
artifacts/sme-compliance/src/pages/import.test.tsx
artifacts/sme-compliance/src/components/customer-directory-picker.tsx
artifacts/sme-compliance/src/components/customer-directory-picker.test.tsx
artifacts/sme-compliance/src/components/invoice-draft-controls.tsx
artifacts/sme-compliance/src/lib/invoice-draft.ts
artifacts/sme-compliance/src/lib/invoice-draft.test.ts
artifacts/sme-compliance/src/lib/invoice-lines.ts
artifacts/sme-compliance/src/lib/invoice-lines.test.ts
artifacts/sme-compliance/src/lib/invoice-draft-api.ts
artifacts/sme-compliance/src/lib/invoice-draft-session.ts
artifacts/sme-compliance/src/lib/invoice-draft-session.test.ts
artifacts/sme-compliance/src/lib/use-invoice-drafts.ts
artifacts/sme-compliance/src/lib/idempotent-command.ts
artifacts/sme-compliance/src/lib/idempotent-command.test.ts
artifacts/sme-compliance/src/lib/invoice-pages.ts
artifacts/sme-compliance/src/lib/invoice-pages.test.tsx
artifacts/sme-compliance/src/lib/invoice-import-run.ts
artifacts/sme-compliance/src/lib/invoice-import-run-api.ts
artifacts/sme-compliance/src/lib/invoice-import-run.test.ts
docs/frontend-r198-contract.md
docs/drafts-r198-openapi.yaml
```
