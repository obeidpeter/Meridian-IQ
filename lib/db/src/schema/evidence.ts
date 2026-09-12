import {
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, id, updatedAt } from "./columns.ts";
import { firmsTable, usersTable } from "./organizations.ts";
import { partiesTable } from "./parties.ts";
import { invoicesTable } from "./invoices.ts";
import { filingReturnsTable } from "./filings.ts";

export const evidenceStatusEnum = pgEnum("evidence_status", [
  "requested",
  "uploaded",
  "needs_changes",
  "accepted",
  "cancelled",
]);
export const evidenceDocumentTypeEnum = pgEnum("evidence_document_type", [
  "purchase_order",
  "delivery_note",
  "payment_receipt",
  "tax_acknowledgement",
  "contract",
  "other",
]);
export const evidenceScanStatusEnum = pgEnum("evidence_scan_status", [
  "quarantined",
  "clean",
  "rejected",
]);

export const evidenceRequestsTable = pgTable(
  "evidence_requests",
  {
    id: id(),
    firmId: uuid("firm_id")
      .notNull()
      .references(() => firmsTable.id),
    clientPartyId: uuid("client_party_id")
      .notNull()
      .references(() => partiesTable.id),
    invoiceId: uuid("invoice_id").references(() => invoicesTable.id),
    filingId: uuid("filing_id").references(() => filingReturnsTable.id),
    period: text("period"),
    title: text("title").notNull(),
    description: text("description"),
    documentType: evidenceDocumentTypeEnum("document_type").notNull(),
    status: evidenceStatusEnum("status").notNull().default("requested"),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => usersTable.id),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => usersTable.id),
    dueAt: timestamp("due_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
    // Deferred composite FKs in migration 0057 bind pointers to this request.
    latestFileId: uuid("latest_file_id"),
    acceptedFileId: uuid("accepted_file_id"),
    clientRequestId: uuid("client_request_id").notNull(),
    requestHash: text("request_hash").notNull(),
    lastReminderAt: timestamp("last_reminder_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("evidence_requests_firm_command_uq").on(
      t.firmId,
      t.clientRequestId,
    ),
    index("evidence_requests_client_status_idx").on(
      t.firmId,
      t.clientPartyId,
      t.status,
    ),
    index("evidence_requests_due_idx").on(t.status, t.dueAt),
    index("evidence_requests_invoice_idx").on(t.invoiceId),
    index("evidence_requests_filing_idx").on(t.filingId),
  ],
);

export const evidenceFilesTable = pgTable(
  "evidence_files",
  {
    id: id(),
    firmId: uuid("firm_id")
      .notNull()
      .references(() => firmsTable.id),
    requestId: uuid("request_id")
      .notNull()
      .references(() => evidenceRequestsTable.id),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    sha256: text("sha256").notNull(),
    encryptedContent: text("encrypted_content").notNull(),
    scanStatus: evidenceScanStatusEnum("scan_status")
      .notNull()
      .default("quarantined"),
    scanError: text("scan_error"),
    scanAttempts: integer("scan_attempts").notNull().default(0),
    nextScanAt: timestamp("next_scan_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    scanToken: uuid("scan_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    uploadedBy: uuid("uploaded_by")
      .notNull()
      .references(() => usersTable.id),
    clientRequestId: uuid("client_request_id").notNull(),
    requestHash: text("request_hash").notNull(),
    createdAt: createdAt(),
    scannedAt: timestamp("scanned_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("evidence_files_request_command_uq").on(
      t.requestId,
      t.clientRequestId,
    ),
    index("evidence_files_firm_idx").on(t.firmId),
    index("evidence_files_scan_queue_idx").on(t.scanStatus, t.nextScanAt),
  ],
);

export const evidenceEventsTable = pgTable(
  "evidence_events",
  {
    id: id(),
    firmId: uuid("firm_id")
      .notNull()
      .references(() => firmsTable.id),
    requestId: uuid("request_id")
      .notNull()
      .references(() => evidenceRequestsTable.id),
    actorId: uuid("actor_id").references(() => usersTable.id),
    action: text("action").notNull(),
    comment: text("comment"),
    fileId: uuid("file_id").references(() => evidenceFilesTable.id),
    clientRequestId: uuid("client_request_id"),
    requestHash: text("request_hash"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("evidence_events_request_command_uq").on(
      t.requestId,
      t.clientRequestId,
    ),
    index("evidence_events_request_created_idx").on(t.requestId, t.createdAt),
    index("evidence_events_firm_idx").on(t.firmId),
  ],
);

export type EvidenceRequest = typeof evidenceRequestsTable.$inferSelect;
export type EvidenceFile = typeof evidenceFilesTable.$inferSelect;
export type EvidenceEvent = typeof evidenceEventsTable.$inferSelect;
