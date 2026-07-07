import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  pgEnum,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { partiesTable } from "./parties";

// Three-layer consent architecture (Plan 7.2, C6):
//   layer 1 = compliance (required)
//   layer 2 = anonymized-aggregate (standard)
//   layer 3 = credit-readiness (opt-in, dormant until R3)
// Each grant/revoke is an append-only event; the permission query reads the
// latest event per (party, layer) (CORE-03).
export const consentActionEnum = pgEnum("consent_action", ["grant", "revoke"]);

export const consentRecordsTable = pgTable("consent_records", {
  id: uuid("id").primaryKey().defaultRandom(),
  partyId: uuid("party_id")
    .notNull()
    .references(() => partiesTable.id),
  layer: integer("layer").notNull(),
  action: consentActionEnum("action").notNull(),
  scope: text("scope").notNull(),
  basis: text("basis").notNull(),
  channel: text("channel").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertConsentRecordSchema = createInsertSchema(
  consentRecordsTable,
).omit({ id: true, createdAt: true });

export type InsertConsentRecord = z.infer<typeof insertConsentRecordSchema>;
export type ConsentRecord = typeof consentRecordsTable.$inferSelect;
export type ConsentAction = (typeof consentActionEnum.enumValues)[number];
