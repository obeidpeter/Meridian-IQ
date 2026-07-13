import {
  pgTable,
  pgEnum,
  uuid,
  text,
  boolean,
  date,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { firmsTable } from "./organizations.ts";
import { partiesTable } from "./parties.ts";
import { invoicesTable } from "./invoices.ts";
import { createdAt, id, updatedAt } from "./columns.ts";

export const recurringCadenceEnum = pgEnum("recurring_cadence", [
  "weekly",
  "monthly",
]);

// A standing instruction to draft the same invoice on a schedule (retainers,
// subscriptions). The sweep materializes ordinary drafts through the normal
// createDraft path — validation, totals math and audit identical to manual
// entry — then advances nextRunDate; the draft rides the standard
// review/submit workflow. Nothing auto-submits.
export const recurringInvoiceTemplatesTable = pgTable(
  "recurring_invoice_templates",
  {
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
    name: text("name").notNull(),
    cadence: recurringCadenceEnum("cadence").notNull(),
    // The next issue date to materialize; the sweep advances it by one cadence
    // step per generated draft (looping to catch up after downtime).
    nextRunDate: date("next_run_date", { mode: "string" }).notNull(),
    active: boolean("active").notNull().default(true),
    currency: text("currency"),
    notes: text("notes"),
    lines: jsonb("lines")
      .$type<
        {
          description: string;
          quantity: string;
          unitPrice: string;
          vatRate: string; // fraction, e.g. "0.075" — same contract as invoices
        }[]
      >()
      .notNull(),
    lastInvoiceId: uuid("last_invoice_id").references(() => invoicesTable.id),
    createdByUserId: text("created_by_user_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("recurring_templates_firm_idx").on(t.firmId),
    // The sweep's scan: active templates whose next run is due.
    index("recurring_templates_due_idx").on(t.active, t.nextRunDate),
  ],
);

export type RecurringInvoiceTemplate =
  typeof recurringInvoiceTemplatesTable.$inferSelect;
