import {
  pgTable,
  uuid,
  text,
  timestamp,
  numeric,
  integer,
  boolean,
  jsonb,
  pgEnum,
  unique,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { invoicesTable, invoiceStatusEnum } from "./invoices";
import { partiesTable } from "./parties";
import { usersTable, firmsTable } from "./organizations";

// Two accredited APP rails behind one adapter (INT-01, C3).
export const railEnum = pgEnum("rail", ["rail_primary", "rail_secondary"]);

export const submissionStatusEnum = pgEnum("submission_status", [
  "pending",
  "accepted",
  "rejected",
  "error",
]);

// Append-only: one row per rail per try; request/response retained (CORE-02).
export const submissionAttemptsTable = pgTable("submission_attempts", {
  id: uuid("id").primaryKey().defaultRandom(),
  invoiceId: uuid("invoice_id")
    .notNull()
    .references(() => invoicesTable.id),
  rail: railEnum("rail").notNull(),
  attemptNo: integer("attempt_no").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  status: submissionStatusEnum("status").notNull(),
  requestPayload: jsonb("request_payload").$type<Record<string, unknown>>(),
  responsePayload: jsonb("response_payload").$type<Record<string, unknown>>(),
  errorCode: text("error_code"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// A validated invoice carries an IRN, CSID and QR code (C1). Append-only.
export const stampRecordsTable = pgTable("stamp_records", {
  id: uuid("id").primaryKey().defaultRandom(),
  invoiceId: uuid("invoice_id")
    .notNull()
    .references(() => invoicesTable.id),
  irn: text("irn").notNull(),
  csid: text("csid").notNull(),
  qrPayload: text("qr_payload").notNull(),
  signedArtifactRef: text("signed_artifact_ref").notNull(),
  rail: railEnum("rail").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  // One canonical stamp per invoice: enforces idempotency so a crash/retry
  // between the stamp insert and the outbox row being marked done cannot write
  // a second stamp (INT-09), without ever deleting an append-only record.
}, (t) => [unique().on(t.invoiceId)]);

export const confirmationStateEnum = pgEnum("confirmation_state", [
  "requested",
  "confirmed",
  "queried",
  "rejected",
]);

// Buyer confirmation serves both VAT protection and financeability (BR-02).
export const confirmationsTable = pgTable("confirmations", {
  id: uuid("id").primaryKey().defaultRandom(),
  invoiceId: uuid("invoice_id")
    .notNull()
    .references(() => invoicesTable.id),
  buyerPartyId: uuid("buyer_party_id")
    .notNull()
    .references(() => partiesTable.id),
  state: confirmationStateEnum("state").notNull(),
  method: text("method"),
  noSetOff: boolean("no_set_off").notNull().default(false),
  confirmingUserId: uuid("confirming_user_id").references(() => usersTable.id),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Mandatory-source hierarchy (CR-01). Uploaded evidence alone never qualifies.
export const settlementSourceEnum = pgEnum("settlement_source", [
  "statement_match",
  "buyer_flag",
  "collection_account",
  "uploaded_evidence",
]);

export const settlementEventsTable = pgTable("settlement_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  invoiceId: uuid("invoice_id")
    .notNull()
    .references(() => invoicesTable.id),
  source: settlementSourceEnum("source").notNull(),
  amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
  confidence: numeric("confidence", { precision: 5, scale: 4 }),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Append-only projection of every invoice status transition (CORE-02). Replaying
// these rows reconstructs an invoice's status at any timestamp; combined with the
// DB-level append-only triggers, post-submission lifecycle history is immutable.
export const invoiceLifecycleEventsTable = pgTable("invoice_lifecycle_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  invoiceId: uuid("invoice_id")
    .notNull()
    .references(() => invoicesTable.id),
  firmId: uuid("firm_id")
    .notNull()
    .references(() => firmsTable.id),
  fromStatus: invoiceStatusEnum("from_status"),
  toStatus: invoiceStatusEnum("to_status").notNull(),
  // Actor identity mirrors the authoritative audit log (audit_log.actor_id):
  // free text, nullable, no FK. This lets the projection record system/worker
  // actors (actorRole "system") and out-of-band actors the way the audit trail
  // already does, instead of being stricter than the record it projects from.
  actorId: text("actor_id"),
  actorRole: text("actor_role"),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertSubmissionAttemptSchema = createInsertSchema(
  submissionAttemptsTable,
).omit({ id: true, createdAt: true });
export const insertStampRecordSchema = createInsertSchema(stampRecordsTable).omit(
  { id: true, createdAt: true },
);
export const insertConfirmationSchema = createInsertSchema(
  confirmationsTable,
).omit({ id: true, createdAt: true });
export const insertSettlementEventSchema = createInsertSchema(
  settlementEventsTable,
).omit({ id: true, createdAt: true });

export const insertInvoiceLifecycleEventSchema = createInsertSchema(
  invoiceLifecycleEventsTable,
).omit({ id: true, createdAt: true });

export type SubmissionAttempt = typeof submissionAttemptsTable.$inferSelect;
export type InvoiceLifecycleEvent =
  typeof invoiceLifecycleEventsTable.$inferSelect;
export type StampRecord = typeof stampRecordsTable.$inferSelect;
export type Confirmation = typeof confirmationsTable.$inferSelect;
export type SettlementEvent = typeof settlementEventsTable.$inferSelect;
export type Rail = (typeof railEnum.enumValues)[number];
export type SettlementSource = (typeof settlementSourceEnum.enumValues)[number];
export type ConfirmationState =
  (typeof confirmationStateEnum.enumValues)[number];
