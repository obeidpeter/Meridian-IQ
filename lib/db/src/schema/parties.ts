import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  integer,
  pgEnum,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// A Party is any legal person in the spine: client business, buyer, firm or bank.
// Keyed by TIN where one exists (CORE-08).
export const partyTypeEnum = pgEnum("party_type", [
  "client_business",
  "buyer",
  "firm",
  "bank",
]);

export const partiesTable = pgTable("parties", {
  id: uuid("id").primaryKey().defaultRandom(),
  type: partyTypeEnum("type").notNull(),
  legalName: text("legal_name").notNull(),
  // Nigerian Tax Identification Number. Nullable until captured.
  tin: text("tin"),
  tinValidated: boolean("tin_validated").notNull().default(false),
  // Corporate Affairs Commission company number.
  cacNumber: text("cac_number"),
  // Postal address (required for UBL mandatory-field completeness).
  street: text("street"),
  city: text("city"),
  countryCode: text("country_code").notNull().default("NG"),
  // When two duplicate parties are merged, the loser points at the survivor.
  // History is preserved: rows are never deleted (CORE-08).
  mergedIntoId: uuid("merged_into_id"),
  schemaVersion: integer("schema_version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertPartySchema = createInsertSchema(partiesTable).omit({
  id: true,
  mergedIntoId: true,
  schemaVersion: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertParty = z.infer<typeof insertPartySchema>;
export type Party = typeof partiesTable.$inferSelect;
export type PartyType = (typeof partyTypeEnum.enumValues)[number];
