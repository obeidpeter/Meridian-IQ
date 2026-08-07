import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { firmsTable, usersTable } from "./organizations.ts";
import { partiesTable } from "./parties.ts";
import { createdAt, id, updatedAt } from "./columns.ts";

// Onboard with Clerk (Phase 1): the client onboarding run — an evidence-based
// checklist a firm opens when it takes on a new SME client. Steps are never
// self-attested: a machine detection pass recomputes each step's state from
// SQL facts (invoices on record, statement coverage, consent events, the
// filings register), so the checklist can only claim what the data shows.
// The two jsonb columns split by WRITER so refresh and human decisions never
// contend: `detection` is machine-derived and disposable (every refresh
// rewrites it whole), `skips` is human-only (a firm's deliberate "this client
// has no history" record) and refresh never touches it.
//
// Deliberately NOT the plan-run chassis (clerk_plan_runs): an onboarding run
// waits on humans for days — uploads, consent, merge reviews — so it cannot
// inherit the 72-hour expiry or the drive-to-terminal processor. It shares
// the discipline (natural-key gates, CAS terminal writes, pointer-only
// audits), not the table.
//
// Distinct from onboarding_prospects (billing.ts): that is the firm's
// PRE-SALES lead pipeline; this run starts after the client exists.

export const onboardingRunStatusEnum = pgEnum("onboarding_run_status", [
  "active",
  "completed",
  "abandoned",
]);

export const clientOnboardingRunsTable = pgTable(
  "client_onboarding_runs",
  {
    id: id(),
    firmId: uuid("firm_id")
      .notNull()
      .references(() => firmsTable.id),
    clientPartyId: uuid("client_party_id")
      .notNull()
      .references(() => partiesTable.id),
    status: onboardingRunStatusEnum("status").notNull().default("active"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => usersTable.id),
    // Machine-written ONLY (refresh/sweep): per-step detection state keyed by
    // step key — { done, evidence, gaps, checkedAt }. Recomputed whole from
    // SQL facts on every pass, so concurrent refreshes converge and nothing
    // here is ever the source of truth for a human decision.
    detection: jsonb("detection")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    // Human-written ONLY (the skip route): deliberate gaps the firm recorded
    // — { reason, byUserId, at } per step key. Refresh never writes this
    // column, so a skip can never be lost to a concurrent detection pass.
    skips: jsonb("skips")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // One LIVE run per client per firm — re-onboarding after an abandon is
    // legitimate (a returning client), so the gate is partial on status. The
    // index IS the cross-instance creation gate (the filings natural-key
    // discipline): concurrent creates race to one winner.
    uniqueIndex("client_onboarding_live_uq")
      .on(t.firmId, t.clientPartyId)
      .where(sql`status = 'active'`),
    index("client_onboarding_scope_idx").on(t.firmId, t.clientPartyId),
  ],
);

export type ClientOnboardingRun = typeof clientOnboardingRunsTable.$inferSelect;
