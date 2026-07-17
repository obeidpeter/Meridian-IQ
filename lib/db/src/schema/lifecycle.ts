import {
  pgTable,
  uuid,
  text,
  timestamp,
  numeric,
  integer,
  boolean,
  index,
  jsonb,
  pgEnum,
  unique,
} from "drizzle-orm/pg-core";
import { invoicesTable, invoiceStatusEnum } from "./invoices.ts";
import { partiesTable } from "./parties.ts";
import { usersTable, firmsTable } from "./organizations.ts";
import { createdAt, id } from "./columns.ts";

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
  id: id(),
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
  createdAt: createdAt(),
// Read by invoice on every detail/status view; append-only, so it only grows.
// The firm-keyed RLS policy probes invoices per candidate row (EXISTS), which
// makes an unindexed scan pay twice — same reasoning for the two sibling
// child tables below.
}, (t) => [
  index("submission_attempts_invoice_idx").on(t.invoiceId),
  // The catalogue coverage report (desk/catalogue-coverage.ts) walks this
  // table by code (per-code first sighting, per-catalogue-entry SLA lateral)
  // and by rejection window — both would otherwise be sequential scans of a
  // table that only grows (round-13 review M1).
  index("submission_attempts_error_code_idx").on(
    t.errorCode,
    t.status,
    t.createdAt,
  ),
  index("submission_attempts_status_created_idx").on(t.status, t.createdAt),
]);

// A validated invoice carries an IRN, CSID and QR code (C1). Append-only.
export const stampRecordsTable = pgTable("stamp_records", {
  id: id(),
  invoiceId: uuid("invoice_id")
    .notNull()
    .references(() => invoicesTable.id),
  irn: text("irn").notNull(),
  csid: text("csid").notNull(),
  qrPayload: text("qr_payload").notNull(),
  signedArtifactRef: text("signed_artifact_ref").notNull(),
  rail: railEnum("rail").notNull(),
  createdAt: createdAt(),
  // One canonical stamp per invoice: enforces idempotency so a crash/retry
  // between the stamp insert and the outbox row being marked done cannot write
  // a second stamp (INT-09), without ever deleting an append-only record.
  // The (irn, csid) index serves the public /verify-stamp lookup, which is
  // unauthenticated and must not seq-scan an ever-growing table.
}, (t) => [
  unique().on(t.invoiceId),
  index("stamp_records_irn_csid_idx").on(t.irn, t.csid),
]);

export const confirmationStateEnum = pgEnum("confirmation_state", [
  "requested",
  "confirmed",
  "queried",
  "rejected",
]);

// Buyer confirmation serves both VAT protection and financeability (BR-02).
// Append-only: lineage is successive rows (requested -> confirmed/queried/
// rejected), never an update. The confirming user and method are captured on
// every buyer-side response.
export const confirmationsTable = pgTable("confirmations", {
  id: id(),
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
  // Reason accompanying a queried/rejected response, returned to the supplier.
  note: text("note"),
  createdAt: createdAt(),
}, (t) => [index("confirmations_invoice_idx").on(t.invoiceId)]);

// Mandatory-source hierarchy (CR-01). Uploaded evidence alone never qualifies.
export const settlementSourceEnum = pgEnum("settlement_source", [
  "statement_match",
  "buyer_flag",
  "collection_account",
  "uploaded_evidence",
]);

// Buyer payment-status flags (BR-04). `scheduled` is an intent signal only;
// only `paid` counts toward settlement observation (Plan 7.4).
export const settlementPaymentStatusEnum = pgEnum("settlement_payment_status", [
  "scheduled",
  "paid",
]);

export const settlementEventsTable = pgTable("settlement_events", {
  id: id(),
  invoiceId: uuid("invoice_id")
    .notNull()
    .references(() => invoicesTable.id),
  source: settlementSourceEnum("source").notNull(),
  amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
  confidence: numeric("confidence", { precision: 5, scale: 4 }),
  // For source=buyer_flag: scheduled vs paid. Append-only lineage means a
  // scheduled-then-paid sequence is two rows, never an update (BR-04).
  paymentStatus: settlementPaymentStatusEnum("payment_status"),
  // For source=statement_match: the bank-statement line this event was matched
  // from (SME-07). Bare uuid (no FK) to avoid a schema-module cycle with
  // statements.ts; referential integrity is enforced at the write path.
  statementLineId: uuid("statement_line_id"),
  // Actor identity mirrors invoice_lifecycle_events.actor_id: free text,
  // nullable, so system/worker writes record the same way the audit trail does.
  actorId: text("actor_id"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
}, (t) => [
  index("settlement_events_invoice_idx").on(t.invoiceId),
  // The unmatched-credit detector anti-joins by statement line on every
  // card load and digest sweep — same only-grows reasoning as the
  // submission_attempts indexes above (round-14 review L3).
  index("settlement_events_statement_line_idx").on(t.statementLineId),
]);

// Append-only projection of every invoice status transition (CORE-02). Replaying
// these rows reconstructs an invoice's status at any timestamp; combined with the
// DB-level append-only triggers, post-submission lifecycle history is immutable.
export const invoiceLifecycleEventsTable = pgTable("invoice_lifecycle_events", {
  id: id(),
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
  createdAt: createdAt(),
}, (t) => [index("invoice_lifecycle_events_invoice_idx").on(t.invoiceId)]);

export type SubmissionAttempt = typeof submissionAttemptsTable.$inferSelect;
export type StampRecord = typeof stampRecordsTable.$inferSelect;
export type Confirmation = typeof confirmationsTable.$inferSelect;
export type Rail = (typeof railEnum.enumValues)[number];
