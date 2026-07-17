import { pgTable, uuid, integer, text, index } from "drizzle-orm/pg-core";
import { firmsTable } from "./organizations.ts";
import { invoicesTable } from "./invoices.ts";
import { createdAt, id } from "./columns.ts";

// Chase ladder memory (round-14 idea #3). One row per payment reminder the
// client actually SENT (logged when they copy the drafted chaser — drafting
// alone records nothing, an abandoned draft is not a reminder). The stage is
// the 1-based reminder number at logging time; the chaser draft reads the
// count to phrase a stage-appropriate follow-up (gentle → firmer → final),
// and the weekly digest counts invoices with 2+ reminders still unpaid.
// Append-only by usage; firm-keyed RLS via migration 0018.
export const chaseLogTable = pgTable(
  "chase_log",
  {
    id: id(),
    firmId: uuid("firm_id")
      .notNull()
      .references(() => firmsTable.id),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoicesTable.id),
    stage: integer("stage").notNull(),
    loggedByUserId: text("logged_by_user_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    // The chaser draft and the digest both count per invoice.
    index("chase_log_invoice_idx").on(t.invoiceId),
    index("chase_log_firm_idx").on(t.firmId),
  ],
);

export type ChaseLogRow = typeof chaseLogTable.$inferSelect;
