import {
  pgTable,
  text,
  boolean,
  pgEnum,
} from "drizzle-orm/pg-core";
import { createdAt, updatedAt } from "./columns.ts";

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
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

