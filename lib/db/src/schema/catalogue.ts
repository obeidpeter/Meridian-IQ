import {
  pgTable,
  text,
  boolean,
  timestamp,
  pgEnum,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Persisted, operator-editable validation-error catalogue (ADV-03, INT-02).
// Global reference data (not tenant-scoped): every rail rejection or domain
// failure maps to a stable code with a plain-language cause and fix that
// operators can edit within a working day, and every surface reuses it as
// in-app help. No RLS — it is shared knowledge, readable by all authenticated
// principals; writes are gated in the handler by the catalogue.write capability.
export const catalogueSourceEnum = pgEnum("catalogue_source", [
  "builtin",
  "operator",
]);

export const errorCatalogueTable = pgTable("error_catalogue", {
  code: text("code").primaryKey(),
  category: text("category").notNull().default("general"),
  cause: text("cause").notNull(),
  fix: text("fix").notNull(),
  retriable: boolean("retriable").notNull().default(false),
  source: catalogueSourceEnum("source").notNull().default("operator"),
  updatedBy: text("updated_by"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertErrorCatalogueSchema = createInsertSchema(
  errorCatalogueTable,
).omit({
  createdAt: true,
  updatedAt: true,
});
export type InsertErrorCatalogueEntry = z.infer<
  typeof insertErrorCatalogueSchema
>;
export type ErrorCatalogueEntryRow = typeof errorCatalogueTable.$inferSelect;
