import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { firmsTable } from "./organizations.ts";
import { invoicesTable } from "./invoices.ts";
import { createdAt, id, updatedAt } from "./columns.ts";

// Firm governance policies (compliance round). One row per firm, created
// lazily on first write — readers must treat "no row" as every policy at its
// default. Kept as a table (not columns on firms) so future policies land as
// columns here without touching the org spine. Firm-keyed RLS via migration
// 0024.
export const firmPoliciesTable = pgTable("firm_policies", {
  id: id(),
  firmId: uuid("firm_id")
    .notNull()
    .references(() => firmsTable.id),
  // Maker-checker: when true, submitInvoice refuses unless a live approval
  // by a principal OTHER than the submitter exists (409 APPROVAL_REQUIRED).
  // Defaults false so existing firms and every existing test/journey keep
  // their single-actor submit flow until a firm opts in.
  submitApprovalRequired: boolean("submit_approval_required")
    .notNull()
    .default(false),
  updatedByUserId: text("updated_by_user_id"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [unique().on(t.firmId)]);

// Submission approvals (maker-checker). Approval rows are evidence: they are
// never deleted, only revoked — updateInvoiceContent stamps revokedAt on live
// approvals so an approval can never cover content the approver did not see.
// Carries firm_id (chase_log shape) so the standard firm-keyed RLS applies;
// policy via migration 0024, which also adds the table to the purge function
// (invoice_id FK would otherwise break retention purges).
export const invoiceApprovalsTable = pgTable(
  "invoice_approvals",
  {
    id: id(),
    firmId: uuid("firm_id")
      .notNull()
      .references(() => firmsTable.id),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoicesTable.id),
    // Free text, no FK — mirrors invoice_lifecycle_events.actor_id so the
    // dev shim and out-of-band actors record the same way the audit trail
    // does.
    approvedByUserId: text("approved_by_user_id").notNull(),
    note: text("note"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    // The submit guard asks "any live approval by someone else" per submit;
    // the approvals list reads newest-first per invoice.
    index("invoice_approvals_invoice_idx").on(t.invoiceId, t.createdAt),
    index("invoice_approvals_firm_idx").on(t.firmId),
  ],
);

export type FirmPoliciesRow = typeof firmPoliciesTable.$inferSelect;
export type InvoiceApprovalRow = typeof invoiceApprovalsTable.$inferSelect;
