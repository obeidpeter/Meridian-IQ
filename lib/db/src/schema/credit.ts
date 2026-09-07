import {
  boolean,
  date,
  index,
  pgTable,
  uuid,
  text,
  timestamp,
  numeric,
  jsonb,
  integer,
  pgEnum,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { invoicesTable } from "./invoices.ts";
import { partiesTable } from "./parties.ts";
import { firmsTable, usersTable } from "./organizations.ts";
import { createdAt, id } from "./columns.ts";

export const creditDecisionEnum = pgEnum("credit_decision", [
  "eligible",
  "ineligible",
  "manual_review",
]);

export interface CreditRuleResult {
  key: string;
  outcome: "pass" | "fail" | "review";
  reason: string;
  observed: string | number | boolean | null;
  threshold: string | number | boolean | null;
  weight: number;
  points: number;
}

// Preserve the pre-R3 dormant table as a read-only compatibility ledger. R3
// writes to a new additive table so deployment never needs to backfill unknown
// historical rows before adding its required replay and tenant fields.
export const legacyEligibilityAssessmentsTable = pgTable(
  "eligibility_assessments",
  {
    id: id(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoicesTable.id),
    eligible: text("eligible"),
    scorecardVersion: text("scorecard_version"),
    features: jsonb("features").$type<Record<string, unknown>>(),
    reasons: jsonb("reasons").$type<string[]>(),
    createdAt: createdAt(),
  },
);

// R3 credit-readiness decision ledger. Every row stores the exact policy and
// source snapshot that produced it, so a result can be replayed after the
// scorecard changes. Assessments are append-only (migration 0049); a unique
// command id and deterministic input hash make retries safe across instances.
// `eligible` is retained as a nullable compatibility projection for consumers
// migrating from the dormant v0 shape.
export const eligibilityAssessmentsTable = pgTable(
  "credit_eligibility_assessments",
  {
    id: id(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoicesTable.id),
    firmId: uuid("firm_id")
      .notNull()
      .references(() => firmsTable.id),
    supplierPartyId: uuid("supplier_party_id")
      .notNull()
      .references(() => partiesTable.id),
    buyerPartyId: uuid("buyer_party_id")
      .notNull()
      .references(() => partiesTable.id),
    decision: creditDecisionEnum("decision").notNull(),
    eligible: text("eligible"),
    score: integer("score").notNull(),
    scorecardVersion: text("scorecard_version").notNull(),
    rulesetVersion: text("ruleset_version").notNull(),
    features: jsonb("features")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    ruleResults: jsonb("rule_results")
      .$type<CreditRuleResult[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    reasons: jsonb("reasons")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    sourceSnapshot: jsonb("source_snapshot")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    policySnapshot: jsonb("policy_snapshot")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    inputHash: text("input_hash").notNull(),
    idempotencyKey: uuid("idempotency_key").notNull(),
    requestedByUserId: text("requested_by_user_id").notNull(),
    evaluatedAt: timestamp("evaluated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("credit_eligibility_assessments_idempotency_uq").on(
      t.idempotencyKey,
    ),
    uniqueIndex("credit_eligibility_assessments_replay_uq").on(
      t.invoiceId,
      t.scorecardVersion,
      t.inputHash,
    ),
    index("credit_eligibility_assessments_firm_evaluated_idx").on(
      t.firmId,
      t.evaluatedAt,
    ),
    index("credit_eligibility_assessments_supplier_idx").on(t.supplierPartyId),
  ],
);

export const creditKybStatusEnum = pgEnum("credit_kyb_status", [
  "verified",
  "review",
  "failed",
  "expired",
]);

export const creditVerificationStateEnum = pgEnum("credit_verification_state", [
  "not_checked",
  "verified",
  "review",
  "failed",
]);

// Financing-grade KYB evidence is append-only and deliberately data-minimal:
// owner names, dates of birth and identity documents remain with the approved
// verification provider. Valo stores outcome, coverage and opaque
// evidence references only; bank responses expose none of those references.
export const creditKybChecksTable = pgTable(
  "credit_kyb_checks",
  {
    id: id(),
    firmId: uuid("firm_id")
      .notNull()
      .references(() => firmsTable.id),
    partyId: uuid("party_id")
      .notNull()
      .references(() => partiesTable.id),
    status: creditKybStatusEnum("status").notNull(),
    beneficialOwnerCount: integer("beneficial_owner_count").notNull(),
    ownershipCoverageBps: integer("ownership_coverage_bps").notNull(),
    beneficialOwnersVerified: boolean("beneficial_owners_verified")
      .notNull()
      .default(false),
    bankAccountOwnership: creditVerificationStateEnum(
      "bank_account_ownership",
    ).notNull(),
    sanctionsScreening: creditVerificationStateEnum(
      "sanctions_screening",
    ).notNull(),
    pepScreening: creditVerificationStateEnum("pep_screening").notNull(),
    adverseMediaScreening: creditVerificationStateEnum(
      "adverse_media_screening",
    ).notNull(),
    provider: text("provider").notNull(),
    providerReference: text("provider_reference"),
    evidenceRefs: jsonb("evidence_refs")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    checkedByUserId: text("checked_by_user_id").notNull(),
    inputHash: text("input_hash").notNull(),
    idempotencyKey: uuid("idempotency_key").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("credit_kyb_checks_idempotency_uq").on(t.idempotencyKey),
    index("credit_kyb_checks_party_checked_idx").on(t.partyId, t.checkedAt),
    index("credit_kyb_checks_firm_checked_idx").on(t.firmId, t.checkedAt),
  ],
);

export const creditBankAccessActionEnum = pgEnum("credit_bank_access_action", [
  "grant",
  "suspend",
  "revoke",
]);

// Bank access is an event ledger, not a mutable boolean. The latest event for
// a user governs access and binds that identity to one bank Party plus a DPA.
export const creditBankAccessEventsTable = pgTable(
  "credit_bank_access_events",
  {
    id: id(),
    bankPartyId: uuid("bank_party_id")
      .notNull()
      .references(() => partiesTable.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id),
    action: creditBankAccessActionEnum("action").notNull(),
    dpaReference: text("dpa_reference"),
    dpaExecutedAt: timestamp("dpa_executed_at", { withTimezone: true }),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    reason: text("reason").notNull(),
    actorId: text("actor_id").notNull(),
    idempotencyKey: uuid("idempotency_key").notNull(),
    inputHash: text("input_hash").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("credit_bank_access_idempotency_uq").on(t.idempotencyKey),
    index("credit_bank_access_user_created_idx").on(t.userId, t.createdAt),
    index("credit_bank_access_bank_created_idx").on(t.bankPartyId, t.createdAt),
  ],
);

// Every bank view is recorded separately from the general audit chain so the
// bank can review its own access history without learning any tenant identity.
export const creditDataRoomAccessEventsTable = pgTable(
  "credit_data_room_access_events",
  {
    id: id(),
    bankPartyId: uuid("bank_party_id")
      .notNull()
      .references(() => partiesTable.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id),
    action: text("action").notNull(),
    queryFingerprint: text("query_fingerprint").notNull(),
    outcome: text("outcome").notNull(),
    resultCount: integer("result_count").notNull().default(0),
    suppressedCount: integer("suppressed_count").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    index("credit_data_room_access_bank_created_idx").on(
      t.bankPartyId,
      t.createdAt,
    ),
    index("credit_data_room_access_user_created_idx").on(t.userId, t.createdAt),
  ],
);

// Structural back-tests replay stored source snapshots through the exact
// versioned rules. They do not claim repayment prediction or loss performance.
export const creditBacktestRunsTable = pgTable(
  "credit_backtest_runs",
  {
    id: id(),
    fromDate: date("from_date", { mode: "string" }).notNull(),
    toDate: date("to_date", { mode: "string" }).notNull(),
    scorecardVersion: text("scorecard_version").notNull(),
    rulesetVersion: text("ruleset_version").notNull(),
    structuralOnly: boolean("structural_only").notNull().default(true),
    sampleSize: integer("sample_size").notNull(),
    passed: boolean("passed").notNull(),
    metrics: jsonb("metrics")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    inputHash: text("input_hash").notNull(),
    idempotencyKey: uuid("idempotency_key").notNull(),
    runByUserId: text("run_by_user_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("credit_backtest_runs_idempotency_uq").on(t.idempotencyKey),
    index("credit_backtest_runs_created_idx").on(t.createdAt),
  ],
);

// R4 financing execution remains dormant. These tables have no active route
// and migration 0049 keeps them bypass-only until a later, explicit release.

export const financingStatusEnum = pgEnum("financing_status", [
  "requested",
  "approved",
  "declined",
  "funded",
  "repaid",
  "exception",
]);

export const financingRequestsTable = pgTable("financing_requests", {
  id: id(),
  invoiceId: uuid("invoice_id")
    .notNull()
    .references(() => invoicesTable.id),
  supplierPartyId: uuid("supplier_party_id")
    .notNull()
    .references(() => partiesTable.id),
  status: financingStatusEnum("status").notNull().default("requested"),
  amount: numeric("amount", { precision: 18, scale: 2 }),
  createdAt: createdAt(),
});

export const facilityPositionsTable = pgTable("facility_positions", {
  id: id(),
  bankPartyId: uuid("bank_party_id")
    .notNull()
    .references(() => partiesTable.id),
  supplierPartyId: uuid("supplier_party_id")
    .notNull()
    .references(() => partiesTable.id),
  exposure: numeric("exposure", { precision: 18, scale: 2 })
    .notNull()
    .default("0"),
  limitAmount: numeric("limit_amount", { precision: 18, scale: 2 }),
  createdAt: createdAt(),
});

export const repaymentEventsTable = pgTable("repayment_events", {
  id: id(),
  financingRequestId: uuid("financing_request_id")
    .notNull()
    .references(() => financingRequestsTable.id),
  amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
  installmentNo: integer("installment_no"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});
