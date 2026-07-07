import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  numeric,
  boolean,
  jsonb,
  pgEnum,
  unique,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { firmsTable, usersTable } from "./organizations.ts";
import { partiesTable } from "./parties.ts";
import { invoicesTable } from "./invoices.ts";

// --- Billing & tiering (PL-01) ----------------------------------------------
// The four commercial tiers. Every commercial parameter (price, included
// invoice volume, overage price, revenue-share rate) is a config row, so a
// price review is a data change with an audit entry — never a code change.
export const tierKeyEnum = pgEnum("tier_key", [
  "essential",
  "compliance_desk",
  "professional",
  "enterprise_lite",
]);

export const billingTiersTable = pgTable("billing_tiers", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: tierKeyEnum("key").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  // Monthly subscription MeridianIQ charges the firm, in naira.
  monthlyPrice: numeric("monthly_price").notNull(),
  // Invoices included per month before overage pricing applies.
  includedInvoices: integer("included_invoices").notNull(),
  // Per-invoice charge once the included volume is exceeded, in naira.
  overagePrice: numeric("overage_price").notNull(),
  // Fraction (0..1) of the firm's billed amount returned to the accountant
  // partner as revenue share.
  revenueSharePct: numeric("revenue_share_pct").notNull(),
  // Managed Compliance Desk tier is operator-serviced (CON-04).
  operatorManaged: boolean("operator_managed").notNull().default(false),
  active: boolean("active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

// A firm's active subscription to a tier. One row per firm.
export const subscriptionStatusEnum = pgEnum("subscription_status", [
  "active",
  "paused",
  "cancelled",
]);

export const firmSubscriptionsTable = pgTable("firm_subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  firmId: uuid("firm_id")
    .notNull()
    .unique()
    .references(() => firmsTable.id),
  tierId: uuid("tier_id")
    .notNull()
    .references(() => billingTiersTable.id),
  status: subscriptionStatusEnum("status").notNull().default("active"),
  startedAt: timestamp("started_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

// History of tier config changes. A semi-annual price review appends one row
// per changed field alongside an audit event, giving a human-readable trail of
// how commercial parameters moved over time (PL-01).
export const priceReviewsTable = pgTable("price_reviews", {
  id: uuid("id").primaryKey().defaultRandom(),
  tierId: uuid("tier_id")
    .notNull()
    .references(() => billingTiersTable.id),
  field: text("field").notNull(),
  oldValue: text("old_value"),
  newValue: text("new_value").notNull(),
  note: text("note"),
  effectiveDate: text("effective_date").notNull(),
  actorId: uuid("actor_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// --- Onboarding pipeline (CON-02) -------------------------------------------
// Prospective and onboarding clients tracked per firm. Once a prospect becomes
// a live client it is linked to its business Party; the same row drives the
// unearned-income view (CON-03) while it is not yet converted.
export const pipelineStageEnum = pgEnum("pipeline_stage", [
  "lead",
  "contacted",
  "proposal",
  "onboarding",
  "active",
  "lost",
]);

export const onboardingProspectsTable = pgTable("onboarding_prospects", {
  id: uuid("id").primaryKey().defaultRandom(),
  firmId: uuid("firm_id")
    .notNull()
    .references(() => firmsTable.id),
  name: text("name").notNull(),
  contactEmail: text("contact_email"),
  stage: pipelineStageEnum("stage").notNull().default("lead"),
  // Expected monthly invoice volume, used to imply revenue share (CON-03).
  estimatedMonthlyInvoices: integer("estimated_monthly_invoices")
    .notNull()
    .default(0),
  // Set once the prospect converts into a live client business.
  clientPartyId: uuid("client_party_id").references(() => partiesTable.id),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

// --- Operator work queue (CON-04) -------------------------------------------
// Cross-tenant cases an operator works to keep managed Desk clients compliant.
// A case carries an error code so the console can surface the catalogue
// playbook (cause/fix) and offer a one-click resolution; handling time is
// tracked from open -> first action -> resolved.
export const caseStatusEnum = pgEnum("operator_case_status", [
  "open",
  "in_progress",
  "resolved",
]);

export const casePriorityEnum = pgEnum("operator_case_priority", [
  "low",
  "medium",
  "high",
]);

export const operatorCasesTable = pgTable("operator_cases", {
  id: uuid("id").primaryKey().defaultRandom(),
  firmId: uuid("firm_id")
    .notNull()
    .references(() => firmsTable.id),
  clientPartyId: uuid("client_party_id").references(() => partiesTable.id),
  invoiceId: uuid("invoice_id").references(() => invoicesTable.id),
  title: text("title").notNull(),
  errorCode: text("error_code"),
  priority: casePriorityEnum("priority").notNull().default("medium"),
  status: caseStatusEnum("status").notNull().default("open"),
  assignedOperatorId: uuid("assigned_operator_id").references(
    () => usersTable.id,
  ),
  resolutionCode: text("resolution_code"),
  resolutionNote: text("resolution_note"),
  openedAt: timestamp("opened_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  firstActionAt: timestamp("first_action_at", { withTimezone: true }),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  // Total operator handling time in seconds, stamped on resolution.
  handleSeconds: integer("handle_seconds"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

// --- Revenue-share statements (CON-06) --------------------------------------
// Monthly per-firm statement, reconciled to billing from tier config + the
// firm's billed invoice volume for the period. Regeneratable: one row per
// (firm, period), upserted so a re-run reconciles rather than duplicates.
export const revenueShareStatementsTable = pgTable(
  "revenue_share_statements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    firmId: uuid("firm_id")
      .notNull()
      .references(() => firmsTable.id),
    // Billing period as YYYY-MM.
    period: text("period").notNull(),
    tierKey: tierKeyEnum("tier_key").notNull(),
    billedInvoices: integer("billed_invoices").notNull(),
    includedInvoices: integer("included_invoices").notNull(),
    overageInvoices: integer("overage_invoices").notNull(),
    subscriptionAmount: numeric("subscription_amount").notNull(),
    overageAmount: numeric("overage_amount").notNull(),
    billingAmount: numeric("billing_amount").notNull(),
    revenueSharePct: numeric("revenue_share_pct").notNull(),
    revenueShareAmount: numeric("revenue_share_amount").notNull(),
    breakdown: jsonb("breakdown").$type<Record<string, unknown>>(),
    generatedAt: timestamp("generated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [unique().on(t.firmId, t.period)],
);

export const insertBillingTierSchema = createInsertSchema(billingTiersTable).omit(
  { id: true, createdAt: true, updatedAt: true },
);
export const insertFirmSubscriptionSchema = createInsertSchema(
  firmSubscriptionsTable,
).omit({ id: true, startedAt: true, updatedAt: true });
export const insertOnboardingProspectSchema = createInsertSchema(
  onboardingProspectsTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export const insertOperatorCaseSchema = createInsertSchema(
  operatorCasesTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export const insertRevenueShareStatementSchema = createInsertSchema(
  revenueShareStatementsTable,
).omit({ id: true, generatedAt: true });

export type BillingTier = typeof billingTiersTable.$inferSelect;
export type InsertBillingTier = z.infer<typeof insertBillingTierSchema>;
export type FirmSubscription = typeof firmSubscriptionsTable.$inferSelect;
export type PriceReview = typeof priceReviewsTable.$inferSelect;
export type OnboardingProspect = typeof onboardingProspectsTable.$inferSelect;
export type OperatorCase = typeof operatorCasesTable.$inferSelect;
export type RevenueShareStatement =
  typeof revenueShareStatementsTable.$inferSelect;
export type TierKey = (typeof tierKeyEnum.enumValues)[number];
export type PipelineStage = (typeof pipelineStageEnum.enumValues)[number];
export type OperatorCaseStatus = (typeof caseStatusEnum.enumValues)[number];
export type OperatorCasePriority = (typeof casePriorityEnum.enumValues)[number];
