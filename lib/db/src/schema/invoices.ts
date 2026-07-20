import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  date,
  numeric,
  integer,
  boolean,
  pgEnum,
  index,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { firmsTable } from "./organizations.ts";
import { partiesTable } from "./parties.ts";
import { createdAt, id, updatedAt } from "./columns.ts";

// Invoice lifecycle states (Appendix B). Drafts are mutable working state;
// everything from `submitted` onward is append-only (CORE-02).
export const invoiceStatusEnum = pgEnum("invoice_status", [
  "draft",
  "validated",
  "submitted",
  "stamped",
  "confirmed",
  "settled",
  "failed",
  "cancelled",
  "credited",
]);

// Corrections, cancellations and credit notes are first-class (CORE-09).
export const invoiceKindEnum = pgEnum("invoice_kind", [
  "invoice",
  "credit_note",
  "correction",
]);

export const invoiceCategoryEnum = pgEnum("invoice_category", [
  "b2b",
  "b2g",
  "b2c",
]);

export const invoicesTable = pgTable("invoices", {
  id: id(),
  firmId: uuid("firm_id")
    .notNull()
    .references(() => firmsTable.id),
  supplierPartyId: uuid("supplier_party_id")
    .notNull()
    .references(() => partiesTable.id),
  buyerPartyId: uuid("buyer_party_id")
    .notNull()
    .references(() => partiesTable.id),
  kind: invoiceKindEnum("kind").notNull().default("invoice"),
  category: invoiceCategoryEnum("category").notNull().default("b2b"),
  // For credit notes / corrections, the stamped invoice being adjusted
  // (CORE-09). FK-constrained so an adjustment can never point at a
  // non-existent original; same-tenant + stampedness are enforced in service.
  relatedInvoiceId: uuid("related_invoice_id").references(
    (): AnyPgColumn => invoicesTable.id,
  ),
  invoiceNumber: text("invoice_number").notNull(),
  currency: text("currency").notNull().default("NGN"),
  issueDate: date("issue_date", { mode: "string" }).notNull(),
  dueDate: date("due_date", { mode: "string" }),
  status: invoiceStatusEnum("status").notNull().default("draft"),
  subtotal: numeric("subtotal", { precision: 18, scale: 2 })
    .notNull()
    .default("0"),
  vatTotal: numeric("vat_total", { precision: 18, scale: 2 })
    .notNull()
    .default("0"),
  grandTotal: numeric("grand_total", { precision: 18, scale: 2 })
    .notNull()
    .default("0"),
  notes: text("notes"),
  // Retention & legal hold (CORE-07).
  legalHold: boolean("legal_hold").notNull().default(false),
  retentionUntil: date("retention_until", { mode: "string" }),
  schemaVersion: integer("schema_version").notNull().default(1),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
},
// Hot-path indexes: every tenant query filters firm_id (+status), list pages
// order by created_at, client scoping filters supplier_party_id, receivables
// group by buyer_party_id. RLS policy checks run per candidate row, so
// shrinking the candidate set matters twice here.
(t) => [
  index("invoices_firm_status_idx").on(t.firmId, t.status),
  index("invoices_firm_created_idx").on(t.firmId, t.createdAt),
  index("invoices_supplier_idx").on(t.supplierPartyId),
  index("invoices_buyer_idx").on(t.buyerPartyId),
  // The adjustment guard scans for live credit notes pointing at an original;
  // partial because the column is null on every ordinary invoice.
  index("invoices_related_invoice_idx")
    .on(t.relatedInvoiceId)
    .where(sql`related_invoice_id IS NOT NULL`),
  // The pipeline's stuck-submission reconcile scans ALL invoices in
  // 'submitted' on a fast cadence; partial so the scan reads a sliver of the
  // table instead of walking every terminal-state row.
  index("invoices_submitted_reconcile_idx")
    .on(t.id)
    .where(sql`status = 'submitted'`),
]);

export const invoiceLinesTable = pgTable("invoice_lines", {
  id: id(),
  invoiceId: uuid("invoice_id")
    .notNull()
    .references(() => invoicesTable.id, { onDelete: "cascade" }),
  lineNo: integer("line_no").notNull(),
  description: text("description").notNull(),
  quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull(),
  unitPrice: numeric("unit_price", { precision: 18, scale: 2 }).notNull(),
  vatRate: numeric("vat_rate", { precision: 6, scale: 4 }).notNull().default("0"),
  lineExtension: numeric("line_extension", { precision: 18, scale: 2 }).notNull(),
  vatAmount: numeric("vat_amount", { precision: 18, scale: 2 })
    .notNull()
    .default("0"),
},
// Every invoice detail load and cascade delete walks this FK.
(t) => [index("invoice_lines_invoice_idx").on(t.invoiceId)]);

export type Invoice = typeof invoicesTable.$inferSelect;
export type InvoiceLine = typeof invoiceLinesTable.$inferSelect;
export type InvoiceStatus = (typeof invoiceStatusEnum.enumValues)[number];
