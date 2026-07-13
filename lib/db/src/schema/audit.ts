import { pgTable, bigserial, text, jsonb } from "drizzle-orm/pg-core";
import { createdAt } from "./columns.ts";

// Append-only, tamper-evident (hash-chained) audit log (CORE-05, C4).
// Each row's hash = sha256(prevHash + canonical(payload)). Altering any row
// breaks chain verification.
export const auditEventsTable = pgTable("audit_events", {
  seq: bigserial("seq", { mode: "number" }).primaryKey(),
  actorId: text("actor_id"),
  actorRole: text("actor_role"),
  firmId: text("firm_id"),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  before: jsonb("before").$type<Record<string, unknown> | null>(),
  after: jsonb("after").$type<Record<string, unknown> | null>(),
  hash: text("hash").notNull(),
  prevHash: text("prev_hash").notNull(),
  createdAt: createdAt(),
});

export type AuditEvent = typeof auditEventsTable.$inferSelect;
