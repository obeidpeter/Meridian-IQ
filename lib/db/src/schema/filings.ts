import {
  date,
  index,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { firmsTable, usersTable } from "./organizations.ts";
import { partiesTable } from "./parties.ts";
import { createdAt, id, updatedAt } from "./columns.ts";

// Filing Desk (Phase 1): the statutory returns register — one row per
// client × tax type × period, minted DETERMINISTICALLY from the statutory
// calendar (never by hand and never by a model), then walked through its
// lifecycle by the firm. Evidence-only posture throughout: MeridianIQ
// records that a return was prepared and filed (date + acknowledgment
// reference), it never files anything with an authority itself.
//
// Status is a real pg enum (slow-moving closed vocabulary); "late" is
// deliberately NOT a status — it is a derived predicate (due date passed
// while unfiled) with one home in modules/filings/filings.ts, so a row's
// history never rewrites itself at midnight.

export const filingStatusEnum = pgEnum("filing_status", [
  "upcoming",
  "prepared",
  "filed",
]);

export const filingReturnsTable = pgTable(
  "filing_returns",
  {
    id: id(),
    firmId: uuid("firm_id")
      .notNull()
      .references(() => firmsTable.id),
    clientPartyId: uuid("client_party_id")
      .notNull()
      .references(() => partiesTable.id),
    // Catalogue KEY as text (the obligations rule): rows outlive catalogue
    // growth; the minting sweep and the write inputs pin the closed set
    // ("vat", "paye" in Phase 1).
    taxType: text("tax_type").notNull(),
    // The Lagos calendar month the return COVERS, "YYYY-MM" — a completed
    // period (in August a firm files July's returns).
    period: text("period").notNull(),
    // The statutory filing date (VAT: the 21st of the following month;
    // PAYE: the 10th) — computed once at mint time by the shared statutory
    // calendar, stored so the register is readable without re-deriving.
    dueDate: date("due_date", { mode: "string" }).notNull(),
    status: filingStatusEnum("status").notNull().default("upcoming"),
    // Evidence of the filing act, supplied by the human who marks the row
    // filed: the date it was filed and the authority's acknowledgment
    // reference (e.g. TaxPro-Max receipt number). Free text — authority
    // formats vary.
    filedDate: date("filed_date", { mode: "string" }),
    filedReference: text("filed_reference"),
    notes: text("notes"),
    preparedBy: uuid("prepared_by").references(() => usersTable.id),
    filedBy: uuid("filed_by").references(() => usersTable.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // The natural key IS the cross-instance minting gate: a concurrent
    // sweep pass or a sync-now click inserts with onConflictDoNothing and
    // exactly one row per client × tax × period survives (the recurring
    // materializer's discipline).
    uniqueIndex("filing_returns_natural_uq").on(
      t.firmId,
      t.clientPartyId,
      t.taxType,
      t.period,
    ),
    index("filing_returns_scope_idx").on(t.firmId, t.clientPartyId),
    // Every "what is due / late" surface filters on these two.
    index("filing_returns_status_due_idx").on(t.status, t.dueDate),
  ],
);

export type FilingReturn = typeof filingReturnsTable.$inferSelect;

// Reminder ledger kinds mirror obligation_reminder_kind on the notices side.
export const filingReminderKindEnum = pgEnum("filing_reminder_kind", [
  "due_soon",
  "overdue",
]);

// The at-most-once ledger for filing deadline reminders (Phase 2): one row
// per (filing, kind) claimed BEFORE any send — the unique index IS the
// cross-instance once-only gate (the obligation_reminder_sends pattern).
export const filingReminderSendsTable = pgTable(
  "filing_reminder_sends",
  {
    id: id(),
    filingId: uuid("filing_id")
      .notNull()
      .references(() => filingReturnsTable.id),
    clientPartyId: uuid("client_party_id")
      .notNull()
      .references(() => partiesTable.id),
    firmId: uuid("firm_id")
      .notNull()
      .references(() => firmsTable.id),
    kind: filingReminderKindEnum("kind").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("filing_reminder_filing_kind_uq").on(t.filingId, t.kind),
    index("filing_reminder_firm_idx").on(t.firmId),
  ],
);

export type FilingReminderSend = typeof filingReminderSendsTable.$inferSelect;
