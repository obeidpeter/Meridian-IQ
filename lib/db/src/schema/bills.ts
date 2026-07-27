import { pgTable, uuid, text, boolean, timestamp, index } from "drizzle-orm/pg-core";
import { firmsTable } from "./organizations.ts";
import { invoicesTable } from "./invoices.ts";
import { createdAt, id } from "./columns.ts";

// Per-bill stamp verifications (payables round). A bill is a captured
// supplier invoice — the firm's client is the BUYER — and its IRN/CSID are
// entered by the payer (never extracted), verified against the national
// record via the ordinary verify path, and kept here so the bills ledger can
// show the input-VAT posture per bill. Carries firm_id alongside invoice_id
// (the chase_log shape) so the standard firm-keyed RLS applies and the
// rls-coverage gate sees the table; firm-keyed RLS via migration 0023.
export const billVerificationsTable = pgTable(
  "bill_verifications",
  {
    id: id(),
    firmId: uuid("firm_id")
      .notNull()
      .references(() => firmsTable.id),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoicesTable.id),
    irn: text("irn").notNull(),
    csid: text("csid").notNull(),
    valid: boolean("valid").notNull(),
    // Null when the stamp is unknown to this platform: validity comes from
    // the rail record; eligibility needs the invoice lifecycle behind it.
    eligible: boolean("eligible"),
    checkedByUserId: text("checked_by_user_id").notNull(),
    checkedAt: timestamp("checked_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    // The bills ledger reads the newest verification per bill.
    index("bill_verifications_invoice_idx").on(t.invoiceId, t.checkedAt),
    index("bill_verifications_firm_idx").on(t.firmId),
  ],
);

export type BillVerificationRow = typeof billVerificationsTable.$inferSelect;
