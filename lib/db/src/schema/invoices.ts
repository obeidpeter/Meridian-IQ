import {
  pgTable,
  uuid,
  text,
  timestamp,
  date,
  numeric,
  integer,
  boolean,
  pgEnum,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { firmsTable } from "./organizations";
import { partiesTable } from "./parties";

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
  id: uuid("id").primaryKey().defaultRandom(),
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
  // For credit notes / corrections, the stamped invoice being adjusted.
  relatedInvoiceId: uuid("related_invoice_id"),
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
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const invoiceLinesTable = pgTable("invoice_lines", {
  id: uuid("id").primaryKey().defaultRandom(),
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
});

export const insertInvoiceSchema = createInsertSchema(invoicesTable).omit({
  id: true,
  status: true,
  schemaVersion: true,
  retentionUntil: true,
  legalHold: true,
  createdAt: true,
  updatedAt: true,
});
export const insertInvoiceLineSchema = createInsertSchema(invoiceLinesTable).omit(
  { id: true },
);

export type InsertInvoice = z.infer<typeof insertInvoiceSchema>;
export type Invoice = typeof invoicesTable.$inferSelect;
export type InsertInvoiceLine = z.infer<typeof insertInvoiceLineSchema>;
export type InvoiceLine = typeof invoiceLinesTable.$inferSelect;
export type InvoiceStatus = (typeof invoiceStatusEnum.enumValues)[number];
export type InvoiceKind = (typeof invoiceKindEnum.enumValues)[number];
export type InvoiceCategory = (typeof invoiceCategoryEnum.enumValues)[number];
