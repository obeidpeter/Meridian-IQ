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
import { clerkCasesTable } from "./clerk.ts";
import { createdAt, id, updatedAt } from "./columns.ts";

// Notice Desk (Task #199): a tax-authority notice, once a human confirms it,
// becomes a tracked obligation — the structured record of "this client must
// respond to this authority by this date". Obligations are compliance-spine
// data (like invoices), NOT model output: Clerk's notice extraction only
// proposes candidate values; the row here is created by the approve step or
// entered by firm staff directly, and every date computation downstream
// (reminders, digests, month-end) is SQL on the Lagos calendar.

// Response lifecycle. Slow-moving closed vocabulary, so a real pg enum (the
// engagement_status precedent). "responded" = the reply/filing went to the
// authority but the matter may still be open; "closed" = resolved either way.
export const obligationStatusEnum = pgEnum("obligation_status", [
  "open",
  "responded",
  "closed",
]);

// Reminder ledger kinds mirror deadline_reminder_kind on the invoice side.
export const obligationReminderKindEnum = pgEnum("obligation_reminder_kind", [
  "due_soon",
  "overdue",
]);

// noticeType / authority / taxType are TEXT, not pg enums: they hold keys from
// the closed catalogues in the api-server's notice module (the model may only
// pick from those lists), and text lets old rows survive catalogue growth —
// the clerk_action_policies.kind precedent.
export const obligationsTable = pgTable(
  "obligations",
  {
    id: id(),
    firmId: uuid("firm_id")
      .notNull()
      .references(() => firmsTable.id),
    clientPartyId: uuid("client_party_id")
      .notNull()
      .references(() => partiesTable.id),
    // The notice case this obligation was approved from; null when firm staff
    // recorded a paper notice by hand. One obligation per case, enforced below.
    sourceCaseId: uuid("source_case_id").references(() => clerkCasesTable.id),
    noticeType: text("notice_type").notNull(),
    authority: text("authority").notNull(),
    // The authority's own reference number, verbatim off the letter.
    reference: text("reference"),
    taxType: text("tax_type"),
    // The period as printed ("Jan–Mar 2026", "2025 YOA") — display-only, never
    // parsed; statutory arithmetic uses the explicit dates below.
    period: text("period"),
    amount: numeric("amount", { precision: 18, scale: 2 }),
    currency: text("currency"),
    issueDate: date("issue_date", { mode: "string" }),
    // The clock. Approval/creation requires it — an obligation without a due
    // date cannot drive reminders and is not worth tracking.
    responseDueDate: date("response_due_date", { mode: "string" }).notNull(),
    status: obligationStatusEnum("status").notNull().default("open"),
    // Free-text context from the firm ("objection filed 12 Aug", etc.).
    notes: text("notes"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => usersTable.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("obligations_source_case_uq").on(t.sourceCaseId),
    index("obligations_scope_idx").on(t.firmId, t.clientPartyId),
    // The reminder sweep and every "what is due" surface filter on these two.
    index("obligations_status_due_idx").on(t.status, t.responseDueDate),
  ],
);

export type Obligation = typeof obligationsTable.$inferSelect;

// Sent-ledger for obligation deadline reminders — the deadline_reminder_sends
// sibling (that table's invoice_id is a NOT NULL FK to invoices, so it cannot
// be reused). The unique (obligation, kind) insert IS the cross-instance
// once-only gate: claim first in its own transaction, then send; failures are
// never re-offered (at-most-once by design).
export const obligationReminderSendsTable = pgTable(
  "obligation_reminder_sends",
  {
    id: id(),
    obligationId: uuid("obligation_id")
      .notNull()
      .references(() => obligationsTable.id),
    clientPartyId: uuid("client_party_id")
      .notNull()
      .references(() => partiesTable.id),
    firmId: uuid("firm_id")
      .notNull()
      .references(() => firmsTable.id),
    kind: obligationReminderKindEnum("kind").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("obligation_reminder_obligation_kind_uq").on(
      t.obligationId,
      t.kind,
    ),
    index("obligation_reminder_firm_idx").on(t.firmId),
  ],
);

export type ObligationReminderSend =
  typeof obligationReminderSendsTable.$inferSelect;
