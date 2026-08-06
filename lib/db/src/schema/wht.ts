import {
  date,
  index,
  numeric,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { firmsTable, usersTable } from "./organizations.ts";
import { partiesTable } from "./parties.ts";
import { invoicesTable } from "./invoices.ts";
import { createdAt, id, updatedAt } from "./columns.ts";

// WHT Desk: the withholding-tax credit ledger. One row per invoice on
// which a buyer actually withheld — minted when a deduction is RECORDED
// (a human accepting a short-pay reconciliation match, or recording it by
// hand), never speculatively from the category alone. Evidence-only
// posture, the filing_returns idiom: MeridianIQ records that a credit
// note was received (reference + date), it never claims anything with an
// authority itself.

export const whtCreditStatusEnum = pgEnum("wht_credit_status", [
  "awaiting_note",
  "note_received",
]);

export const whtCreditsTable = pgTable(
  "wht_credits",
  {
    id: id(),
    firmId: uuid("firm_id")
      .notNull()
      .references(() => firmsTable.id),
    // The supplier-side client the credit belongs to (the invoice's
    // supplierPartyId at record time) — SEC-03 scoping key.
    clientPartyId: uuid("client_party_id")
      .notNull()
      .references(() => partiesTable.id),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoicesTable.id),
    // Catalogue KEY as text (the filings taxType rule); the closed set and
    // its basis-point rates have ONE home in modules/wht/rates.ts.
    category: text("category").notNull(),
    // The naira actually withheld. Defaults to the computed expectation
    // (subtotal × rate) but a human may record the buyer's real figure.
    amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
    deductedDate: date("deducted_date", { mode: "string" }).notNull(),
    // How the deduction was recorded: "statement_match" (an accepted
    // short-pay reconciliation proposal) or "manual".
    source: text("source").notNull(),
    status: whtCreditStatusEnum("status").notNull().default("awaiting_note"),
    // Evidence of the credit note, supplied by the human who marks it
    // received. Free text — buyer and TaxPro-Max formats vary.
    noteReference: text("note_reference"),
    noteDate: date("note_date", { mode: "string" }),
    recordedBy: uuid("recorded_by").references(() => usersTable.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // One credit per invoice: the natural key IS the cross-instance gate —
    // an accepted proposal and a manual record of the same deduction
    // insert with onConflictDoNothing and exactly one row survives.
    uniqueIndex("wht_credits_invoice_uq").on(t.invoiceId),
    index("wht_credits_scope_idx").on(t.firmId, t.clientPartyId),
    // The chase surfaces filter on these two.
    index("wht_credits_status_date_idx").on(t.status, t.deductedDate),
  ],
);

export type WhtCredit = typeof whtCreditsTable.$inferSelect;

// Reminder ledger kinds mirror filing_reminder_kind: the chase clock is a
// deadline (deduction date + the chase window), so the shared claim-first
// driver's due_soon/overdue vocabulary applies unchanged.
export const whtReminderKindEnum = pgEnum("wht_reminder_kind", [
  "due_soon",
  "overdue",
]);

// The at-most-once ledger for credit-note chase reminders: one row per
// (credit, kind) claimed BEFORE any send — the unique index IS the
// cross-instance once-only gate (the filing_reminder_sends pattern).
export const whtReminderSendsTable = pgTable(
  "wht_reminder_sends",
  {
    id: id(),
    creditId: uuid("credit_id")
      .notNull()
      .references(() => whtCreditsTable.id),
    clientPartyId: uuid("client_party_id")
      .notNull()
      .references(() => partiesTable.id),
    firmId: uuid("firm_id")
      .notNull()
      .references(() => firmsTable.id),
    kind: whtReminderKindEnum("kind").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("wht_reminder_credit_kind_uq").on(t.creditId, t.kind),
    index("wht_reminder_firm_idx").on(t.firmId),
  ],
);

export type WhtReminderSend = typeof whtReminderSendsTable.$inferSelect;
