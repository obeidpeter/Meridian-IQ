import {
  pgTable,
  uuid,
  text,
  jsonb,
  integer,
  pgEnum,
  index,
} from "drizzle-orm/pg-core";
import { firmsTable } from "./organizations.ts";
import { partiesTable } from "./parties.ts";
import { createdAt, id, updatedAt } from "./columns.ts";

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
  id: id(),
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
  createdAt: createdAt(),
  updatedAt: updatedAt(),
},
// Firm scoping and party-in-firm checks probe these on nearly every request.
(t) => [
  index("engagements_firm_idx").on(t.firmId),
  index("engagements_client_party_idx").on(t.clientPartyId),
]);

export type Engagement = typeof engagementsTable.$inferSelect;
