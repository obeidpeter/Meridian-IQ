import {
  pgTable,
  uuid,
  text,
  timestamp,
  numeric,
  jsonb,
  integer,
  pgEnum,
} from "drizzle-orm/pg-core";
import { invoicesTable } from "./invoices";
import { partiesTable } from "./parties";

// DORMANT until R3/R4. Defined now so the spine is complete and append-only
// financing events have a home, but no code path writes to these before their
// gate passes (Business Plan Section 15). Ships dark (PL-02).

export const eligibilityAssessmentsTable = pgTable("eligibility_assessments", {
  id: uuid("id").primaryKey().defaultRandom(),
  invoiceId: uuid("invoice_id")
    .notNull()
    .references(() => invoicesTable.id),
  eligible: text("eligible"),
  scorecardVersion: text("scorecard_version"),
  features: jsonb("features").$type<Record<string, unknown>>(),
  reasons: jsonb("reasons").$type<string[]>(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const financingStatusEnum = pgEnum("financing_status", [
  "requested",
  "approved",
  "declined",
  "funded",
  "repaid",
  "exception",
]);

export const financingRequestsTable = pgTable("financing_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  invoiceId: uuid("invoice_id")
    .notNull()
    .references(() => invoicesTable.id),
  supplierPartyId: uuid("supplier_party_id")
    .notNull()
    .references(() => partiesTable.id),
  status: financingStatusEnum("status").notNull().default("requested"),
  amount: numeric("amount", { precision: 18, scale: 2 }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const facilityPositionsTable = pgTable("facility_positions", {
  id: uuid("id").primaryKey().defaultRandom(),
  bankPartyId: uuid("bank_party_id")
    .notNull()
    .references(() => partiesTable.id),
  supplierPartyId: uuid("supplier_party_id")
    .notNull()
    .references(() => partiesTable.id),
  exposure: numeric("exposure", { precision: 18, scale: 2 }).notNull().default("0"),
  limitAmount: numeric("limit_amount", { precision: 18, scale: 2 }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const repaymentEventsTable = pgTable("repayment_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  financingRequestId: uuid("financing_request_id")
    .notNull()
    .references(() => financingRequestsTable.id),
  amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
  installmentNo: integer("installment_no"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type EligibilityAssessment =
  typeof eligibilityAssessmentsTable.$inferSelect;
export type FinancingRequest = typeof financingRequestsTable.$inferSelect;
export type FacilityPosition = typeof facilityPositionsTable.$inferSelect;
export type RepaymentEvent = typeof repaymentEventsTable.$inferSelect;
