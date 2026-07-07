import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  pgEnum,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { firmsTable } from "./organizations";
import { partiesTable } from "./parties";

// An Engagement is an advisory unit of work so services data lands in the same
// spine from R0 (ADV-01). Findings are queryable in the spine.
export const engagementTypeEnum = pgEnum("engagement_type", [
  "readiness_assessment",
  "vat_risk_check",
  "integration",
  "retainer",
]);

export const engagementStatusEnum = pgEnum("engagement_status", [
  "open",
  "in_progress",
  "completed",
  "archived",
]);

export const engagementsTable = pgTable("engagements", {
  id: uuid("id").primaryKey().defaultRandom(),
  firmId: uuid("firm_id")
    .notNull()
    .references(() => firmsTable.id),
  clientPartyId: uuid("client_party_id")
    .notNull()
    .references(() => partiesTable.id),
  type: engagementTypeEnum("type").notNull(),
  status: engagementStatusEnum("status").notNull().default("open"),
  title: text("title").notNull(),
  findings: jsonb("findings").$type<Record<string, unknown>>(),
  schemaVersion: integer("schema_version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertEngagementSchema = createInsertSchema(engagementsTable).omit({
  id: true,
  schemaVersion: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertEngagement = z.infer<typeof insertEngagementSchema>;
export type Engagement = typeof engagementsTable.$inferSelect;
