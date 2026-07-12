import {
  pgTable,
  uuid,
  text,
  timestamp,
  date,
  numeric,
  integer,
  jsonb,
  boolean,
  pgEnum,
  unique,
} from "drizzle-orm/pg-core";
import { firmsTable } from "./organizations.ts";
import { partiesTable } from "./parties.ts";
import { invoicesTable } from "./invoices.ts";

// Clerk — the controlled AI compliance operator (Clerk Supplemental TRD v1.0).
//
// C0/C1 data spine: the claims register that makes binding compliance facts
// deterministic (CLK-KB-01..08), the tenant-scoped case workflow that turns
// inbound material into reviewable field candidates (CLK-CAP-*), full
// inference/review provenance (CLK-OBS-02), and per-capability kill switches
// (CLK-AI-11). The control promise everything here serves: Clerk never states
// a binding compliance fact unless application code assembles that fact from
// an active, applicable, counsel-approved ClaimRecord.

// ---------------------------------------------------------------------------
// Claims register (CLK-KB-01..04) — platform-wide governance records, like the
// error catalogue: counsel-approved compliance propositions, not tenant data.
// ---------------------------------------------------------------------------

export const claimRecordStatusEnum = pgEnum("claim_record_status", [
  "draft", // maker is still writing
  "review", // submitted for independent approval
  "active", // approved and answerable at runtime
  "suspended", // emergency withdrawal (CLK-KB-06); blocked at runtime
  "superseded", // replaced by a newer version
  "expired", // effective-to passed
  "rejected", // checker declined this version
]);

export const claimRecordsTable = pgTable(
  "claim_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Stable logical key shared by all versions of one proposition, e.g.
    // "b2c.late_report.penalty". Runtime retrieval resolves key -> the single
    // active version.
    claimKey: text("claim_key").notNull(),
    version: integer("version").notNull().default(1),
    status: claimRecordStatusEnum("status").notNull().default("draft"),
    jurisdiction: text("jurisdiction").notNull().default("NG"),
    // Applicability filters (empty array = applies to all).
    taxpayerClasses: jsonb("taxpayer_classes")
      .$type<string[]>()
      .notNull()
      .default([]),
    transactionClasses: jsonb("transaction_classes")
      .$type<string[]>()
      .notNull()
      .default([]),
    // Approved plain-language proposition. Protected facts are referenced as
    // {placeholders}; application code substitutes them at render time — the
    // model never generates or mutates them (CLK-AI-03, CLK-KB-04).
    proposition: text("proposition").notNull(),
    legalInstrument: text("legal_instrument").notNull(),
    legalSection: text("legal_section").notNull(),
    // Protected values, stored separately from explanatory language:
    // [{ key, kind: "amount"|"rate"|"date"|"threshold"|"citation"|"text",
    //    value, unit? }]
    protectedFacts: jsonb("protected_facts")
      .$type<
        {
          key: string;
          kind: "amount" | "rate" | "date" | "threshold" | "citation" | "text";
          value: string;
          unit?: string;
        }[]
      >()
      .notNull()
      .default([]),
    sourceEvidenceRef: text("source_evidence_ref"),
    effectiveFrom: date("effective_from", { mode: "string" }).notNull(),
    effectiveTo: date("effective_to", { mode: "string" }),
    reviewDueAt: date("review_due_at", { mode: "string" }).notNull(),
    // Whether Clerk may quote this record to users at all (register column
    // from the AI brief §6); operators always see active records.
    clerkQuotable: boolean("clerk_quotable").notNull().default(false),
    // Maker-checker (CLK-KB-03): the author can never approve their own
    // version — enforced in the service and asserted by tests.
    authorId: text("author_id").notNull(),
    approverId: text("approver_id"),
    approvalEvidence: text("approval_evidence"),
    supersedesId: uuid("supersedes_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [unique("claim_records_key_version_unique").on(t.claimKey, t.version)],
);

// ---------------------------------------------------------------------------
// Clerk cases (Appendix A1 state machine) — tenant-scoped workflow state.
// ---------------------------------------------------------------------------

export const clerkCaseStateEnum = pgEnum("clerk_case_state", [
  "received",
  "consent_checked",
  "quarantined",
  "pre_processed",
  "draft_mapped",
  "clarification_required",
  "ready_for_review",
  "approved",
  "validated",
  "awaiting_submission_approval",
  "queued",
  "closed",
  "rejected",
  "refused",
  "escalated",
]);

export const clerkCaseChannelEnum = pgEnum("clerk_case_channel", [
  "console",
  "pwa",
  "whatsapp", // schema-ready; gated dark until OPEN-6/OPEN-13 close
]);

export const clerkCasePriorityEnum = pgEnum("clerk_case_priority", [
  "low",
  "medium",
  "high",
]);

export const clerkCasesTable = pgTable("clerk_cases", {
  id: uuid("id").primaryKey().defaultRandom(),
  firmId: uuid("firm_id")
    .notNull()
    .references(() => firmsTable.id),
  clientPartyId: uuid("client_party_id")
    .notNull()
    .references(() => partiesTable.id),
  channel: clerkCaseChannelEnum("channel").notNull().default("console"),
  state: clerkCaseStateEnum("state").notNull().default("received"),
  priority: clerkCasePriorityEnum("priority").notNull().default("medium"),
  language: text("language").notNull().default("en"),
  // Classified intent (e.g. "invoice.capture"); null until classification.
  intent: text("intent"),
  // The draft invoice created from confirmed candidates on approval. Clerk
  // loses write authority once the normal lifecycle takes over (A1: Queued).
  invoiceId: uuid("invoice_id").references(() => invoicesTable.id),
  createdByUserId: text("created_by_user_id").notNull(),
  assignedToUserId: text("assigned_to_user_id"),
  refusalReason: text("refusal_reason"),
  escalationReason: text("escalation_reason"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

// ---------------------------------------------------------------------------
// Source artifacts (CLK-CAP-01/08) — inbound material with provenance.
// ---------------------------------------------------------------------------

export const clerkSourceKindEnum = pgEnum("clerk_source_kind", [
  "text",
  "image",
  "pdf",
  "voice",
]);

export const clerkSourceArtifactsTable = pgTable("clerk_source_artifacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  caseId: uuid("case_id")
    .notNull()
    .references(() => clerkCasesTable.id, { onDelete: "cascade" }),
  kind: clerkSourceKindEnum("kind").notNull(),
  filename: text("filename"),
  mime: text("mime"),
  // C3 content. v1 accepts text sources only (media intake stays dark until
  // OPEN-6/OPEN-8/OPEN-13 close); binary media would live in a restricted
  // vault and be referenced here by hash only (§5.2 minimisation).
  contentText: text("content_text"),
  contentHash: text("content_hash").notNull(),
  senderRef: text("sender_ref"),
  consentRef: text("consent_ref"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------
// Field candidates (CLK-CAP-04/06/08) — extracted values pending human review.
// ---------------------------------------------------------------------------

export const clerkFieldReviewStateEnum = pgEnum("clerk_field_review_state", [
  "proposed",
  "confirmed",
  "edited",
  "rejected",
]);

export const clerkFieldCandidatesTable = pgTable("clerk_field_candidates", {
  id: uuid("id").primaryKey().defaultRandom(),
  caseId: uuid("case_id")
    .notNull()
    .references(() => clerkCasesTable.id, { onDelete: "cascade" }),
  // Canonical data-dictionary key (CORE-01), e.g. "invoiceNumber", "buyerTin".
  fieldKey: text("field_key").notNull(),
  value: text("value").notNull(),
  confidence: numeric("confidence", { precision: 4, scale: 3 }).notNull(),
  // Critical fields (party identity, TIN, invoice number/date, currency,
  // totals, tax, payment) never bypass human confirmation (CLK-CAP-06).
  critical: boolean("critical").notNull().default(false),
  sourceArtifactId: uuid("source_artifact_id").references(
    () => clerkSourceArtifactsTable.id,
  ),
  // Source-to-field lineage (CLK-CAP-08): line/character interval in the
  // source text (or, later, page region / audio interval).
  sourceRegion: jsonb("source_region").$type<{
    line?: number;
    start?: number;
    end?: number;
  } | null>(),
  extractorVersion: text("extractor_version").notNull(),
  reviewState: clerkFieldReviewStateEnum("review_state")
    .notNull()
    .default("proposed"),
  editedValue: text("edited_value"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

// ---------------------------------------------------------------------------
// Inference runs (CLK-OBS-02, CLK-AI-07) — full provenance for every gateway
// call: model, prompt/policy versions, typed output, outcome and latency.
// ---------------------------------------------------------------------------

export const clerkInferencePurposeEnum = pgEnum("clerk_inference_purpose", [
  "extraction",
  "intent",
  "answer",
  "explanation",
]);

export const clerkInferenceOutcomeEnum = pgEnum("clerk_inference_outcome", [
  "allowed", // typed output accepted
  "refused", // REFUSE_AND_ESCALATE (CLK-AI-04)
  "blocked", // kill switch / flag / policy stopped the call
  "error", // provider or schema failure (discarded, never shown)
]);

export const clerkInferenceRunsTable = pgTable("clerk_inference_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Nullable: operator-context runs (claims answers by platform staff) are
  // platform-scoped; firm principals only ever see their own firm's rows
  // through RLS, and null-firm rows only surface in bypass context.
  firmId: uuid("firm_id").references(() => firmsTable.id),
  caseId: uuid("case_id").references(() => clerkCasesTable.id, {
    onDelete: "set null",
  }),
  purpose: clerkInferencePurposeEnum("purpose").notNull(),
  model: text("model").notNull(),
  promptVersion: text("prompt_version").notNull(),
  policyVersion: text("policy_version").notNull(),
  inputHash: text("input_hash").notNull(),
  // Typed, schema-validated output (CLK-AI-02). Restricted content stays out
  // of general logs (§5.2) — this row IS the restricted record; the audit
  // chain stores the reference.
  typedOutput: jsonb("typed_output").$type<Record<string, unknown> | null>(),
  outcome: clerkInferenceOutcomeEnum("outcome").notNull(),
  confidence: numeric("confidence", { precision: 4, scale: 3 }),
  latencyMs: integer("latency_ms").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------
// Review decisions (CLK-OPS-02) — named human, decision, reason, diff.
// ---------------------------------------------------------------------------

export const clerkReviewDecisionEnum = pgEnum("clerk_review_decision", [
  "approve",
  "edit",
  "reject",
  "escalate",
]);

export const clerkReviewDecisionsTable = pgTable("clerk_review_decisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  caseId: uuid("case_id")
    .notNull()
    .references(() => clerkCasesTable.id, { onDelete: "cascade" }),
  actorUserId: text("actor_user_id").notNull(),
  actorRole: text("actor_role").notNull(),
  decision: clerkReviewDecisionEnum("decision").notNull(),
  reasonCode: text("reason_code").notNull(),
  // Before/after diff of edited fields (CLK-OPS-02); append-only evidence.
  diff: jsonb("diff").$type<Record<
    string,
    { before: string | null; after: string | null }
  > | null>(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------
// Kill switches (CLK-AI-11) — global and per-capability, independent of
// deployment. Platform-wide rows; flipping one blocks the gateway immediately.
// ---------------------------------------------------------------------------

export const clerkKillSwitchesTable = pgTable("clerk_kill_switches", {
  // "global" | "extraction" | "answers" | "explanation"
  capability: text("capability").primaryKey(),
  disabled: boolean("disabled").notNull().default(false),
  reason: text("reason"),
  changedBy: text("changed_by"),
  changedAt: timestamp("changed_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type ClaimRecordRow = typeof claimRecordsTable.$inferSelect;
export type ClerkCaseRow = typeof clerkCasesTable.$inferSelect;
export type ClerkSourceArtifactRow =
  typeof clerkSourceArtifactsTable.$inferSelect;
export type ClerkFieldCandidateRow =
  typeof clerkFieldCandidatesTable.$inferSelect;
export type ClerkInferenceRunRow = typeof clerkInferenceRunsTable.$inferSelect;
export type ClerkReviewDecisionRow =
  typeof clerkReviewDecisionsTable.$inferSelect;
export type ClerkKillSwitchRow = typeof clerkKillSwitchesTable.$inferSelect;
