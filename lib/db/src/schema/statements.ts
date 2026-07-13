import {
  pgTable,
  uuid,
  text,
  timestamp,
  date,
  numeric,
  integer,
  jsonb,
  pgEnum,
  unique,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { firmsTable } from "./organizations.ts";
import { partiesTable } from "./parties.ts";
import { invoicesTable } from "./invoices.ts";
import { createdAt, id, updatedAt } from "./columns.ts";

// Bank-statement ingestion (INT-05) and reconciliation v1 (SME-07).
//
// A statement upload is parsed behind the StatementParser abstraction (one
// interface, one implementation per Nigerian bank export format — the seam
// open-banking ingestion later slots behind). Parsed lines are matched against
// stamped invoices; accepted matches become source-tagged SettlementEvents.

export const statementStatusEnum = pgEnum("bank_statement_status", [
  "validated", // parsed only (commit=false), nothing persisted downstream
  "committed", // lines persisted, reconciliation enqueued
  "reconciled", // proposal generation completed
]);

export const bankStatementsTable = pgTable("bank_statements", {
  id: id(),
  firmId: uuid("firm_id")
    .notNull()
    .references(() => firmsTable.id),
  // The client business whose bank account this statement belongs to.
  clientPartyId: uuid("client_party_id")
    .notNull()
    .references(() => partiesTable.id),
  // Parser that recognised the file (e.g. "gtb_csv", "zenith_csv").
  formatKey: text("format_key").notNull(),
  filename: text("filename"),
  accountRef: text("account_ref"),
  uploadedByUserId: text("uploaded_by_user_id"),
  status: statementStatusEnum("status").notNull().default("committed"),
  lineCount: integer("line_count").notNull().default(0),
  parsedCount: integer("parsed_count").notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const statementLineParseStatusEnum = pgEnum(
  "statement_line_parse_status",
  ["parsed", "invalid"],
);

export const statementDirectionEnum = pgEnum("statement_direction", [
  "credit",
  "debit",
]);

export const bankStatementLinesTable = pgTable("bank_statement_lines", {
  id: id(),
  statementId: uuid("statement_id")
    .notNull()
    .references(() => bankStatementsTable.id, { onDelete: "cascade" }),
  lineNo: integer("line_no").notNull(),
  valueDate: date("value_date", { mode: "string" }),
  amount: numeric("amount", { precision: 18, scale: 2 }),
  direction: statementDirectionEnum("direction"),
  narration: text("narration"),
  counterpartyRef: text("counterparty_ref"),
  parseStatus: statementLineParseStatusEnum("parse_status").notNull(),
  parseError: text("parse_error"),
  // The raw source line is retained so a parse failure is always diagnosable.
  rawLine: text("raw_line").notNull(),
  createdAt: createdAt(),
},
// Every reconciliation view loads a statement's lines by this FK.
(t) => [index("bank_statement_lines_statement_idx").on(t.statementId)]);

// Reconciliation proposals (SME-07): the matcher scores candidate invoices per
// credit line; a firm user accepts or rejects. Accepting writes the
// statement_match SettlementEvent and transitions the invoice to `settled`.
export const matchProposalStatusEnum = pgEnum("match_proposal_status", [
  "proposed",
  "accepted",
  "rejected",
  // Auto-closed when the invoice left the eligible set (cancelled/credited) or
  // another proposal for the same line was accepted.
  "superseded",
]);

export const matchProposalsTable = pgTable(
  "match_proposals",
  {
    id: id(),
    firmId: uuid("firm_id")
      .notNull()
      .references(() => firmsTable.id),
    statementLineId: uuid("statement_line_id")
      .notNull()
      .references(() => bankStatementLinesTable.id, { onDelete: "cascade" }),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoicesTable.id),
    confidence: numeric("confidence", { precision: 5, scale: 4 }).notNull(),
    // The scored features behind the confidence, kept for explainability.
    features: jsonb("features").$type<Record<string, unknown>>(),
    status: matchProposalStatusEnum("status").notNull().default("proposed"),
    decidedByUserId: text("decided_by_user_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  // The reconcile job is idempotent: one proposal per (line, invoice) pair.
  (t) => [unique().on(t.statementLineId, t.invoiceId)],
);

// Daily buyer input-VAT exposure snapshots (BR-01). Reads serve the latest
// snapshot; the pipeline worker refreshes at least daily.
export const buyerExposureSnapshotsTable = pgTable("buyer_exposure_snapshots", {
  id: id(),
  buyerPartyId: uuid("buyer_party_id")
    .notNull()
    .references(() => partiesTable.id),
  supplierCount: integer("supplier_count").notNull(),
  invoiceCount: integer("invoice_count").notNull(),
  // Input VAT on invoices that are valid-stamped and still eligible.
  protectedVat: numeric("protected_vat", { precision: 18, scale: 2 }).notNull(),
  // Input VAT at risk: unstamped, failed, cancelled or credited invoices.
  atRiskVat: numeric("at_risk_vat", { precision: 18, scale: 2 }).notNull(),
  // Per-supplier breakdown rows for the buyer dashboard.
  breakdown: jsonb("breakdown").$type<Record<string, unknown>[]>(),
  computedAt: timestamp("computed_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertBankStatementSchema = createInsertSchema(
  bankStatementsTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export const insertBankStatementLineSchema = createInsertSchema(
  bankStatementLinesTable,
).omit({ id: true, createdAt: true });
export const insertMatchProposalSchema = createInsertSchema(
  matchProposalsTable,
).omit({ id: true, createdAt: true, updatedAt: true });

export type BankStatement = typeof bankStatementsTable.$inferSelect;
export type BankStatementLine = typeof bankStatementLinesTable.$inferSelect;
export type MatchProposal = typeof matchProposalsTable.$inferSelect;
export type BuyerExposureSnapshot =
  typeof buyerExposureSnapshotsTable.$inferSelect;
export type InsertBankStatement = z.infer<typeof insertBankStatementSchema>;
export type InsertBankStatementLine = z.infer<
  typeof insertBankStatementLineSchema
>;
export type MatchProposalStatus =
  (typeof matchProposalStatusEnum.enumValues)[number];
export type StatementLineParseStatus =
  (typeof statementLineParseStatusEnum.enumValues)[number];
